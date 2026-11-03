/**
 * 拥有者专用设置通道（qqconfig 工具的后端）。
 *
 * 目标：让「拥有者本人在 QQ 私聊里」能直接改本插件的一部分运行时设置，
 * 不用去翻 profile 的 cordis.patch.yml。这是一条危险通道，所以防护是多层的：
 *
 *   1. 身份只取自当前会话（entry.speaker），绝不接受工具参数里的 QQ 号；
 *   2. 只允许在「与拥有者的私聊」里改（群里一律拒绝，避免旁人起哄/诱导）；
 *   3. 只认白名单字段（SPECS）；密钥、onebot 连接、auth.owners 等硬拒绝（DENY）；
 *   4. 值一律按类型/范围校验并归一化（兼容 "1" / 1 这类写法，但拒绝歧义输入）；
 *   5. 两步走：propose 只生成确认码（TTL 300s、一次性、绑定 owner+path+value+revision），
 *      apply 才真正落盘；期间配置被别人改过（revision 变化）就作废；
 *   6. 落盘只走 DSH settings 服务（schema 校验 + 原子写 + 热重载），本模块不写任何 YAML；
 *   7. 限流（每小时 / 每天）+ 追加式审计日志（谁、何时、改了什么、旧值新值）。
 */

import { randomBytes } from 'node:crypto';

export const TOKEN_TTL_MS = 5 * 60 * 1000;
const MAX_PER_HOUR = 6;
const MAX_PER_DAY = 30;

/** 白名单字段。kind: bool | int | ids | clocks | text */
export const SPECS = [
  { path: 'group.enabled', label: '启用群聊', kind: 'bool' },
  { path: 'group.requireAt', label: '群里必须 @ 才回复', kind: 'bool' },
  { path: 'group.allow', label: '群聊白名单（空 = 所有群）', kind: 'ids' },
  { path: 'private.enabled', label: '启用私聊', kind: 'bool' },
  { path: 'private.allow', label: '私聊白名单（空 = 所有人）', kind: 'ids' },
  { path: 'commandPrefix', label: '命令前缀', kind: 'text', maxLen: 8 },
  { path: 'reply.maxChars', label: '单条消息最大字数', kind: 'int', min: 100, max: 5000 },
  { path: 'admin.enabled', label: '启用群管理', kind: 'bool' },
  { path: 'proactive.enabled', label: '启用主动发言', kind: 'bool' },
  { path: 'proactive.groups', label: '主动发言的群', kind: 'ids' },
  { path: 'proactive.intervalMinutes', label: '主动发言检查间隔（分钟）', kind: 'int', min: 5, max: 1440 },
  { path: 'proactive.windowMessages', label: '每次回看的消息条数', kind: 'int', min: 5, max: 200 },
  { path: 'proactive.minNewMessages', label: '至少要有的新消息数', kind: 'int', min: 0, max: 500 },
  { path: 'proactive.quietHours', label: '免打扰时段（HH:MM-HH:MM）', kind: 'clocks' },
  { path: 'proactive.maxPerHour', label: '每小时最多发言', kind: 'int', min: 0, max: 20 },
  { path: 'proactive.maxPerDay', label: '每天最多发言', kind: 'int', min: 0, max: 200 },
  { path: 'proactive.minGapMinutes', label: '两次发言最小间隔（分钟）', kind: 'int', min: 0, max: 1440 },
  { path: 'proactive.maxChars', label: '主动发言最大字数', kind: 'int', min: 20, max: 2000 },
  { path: 'proactive.persona', label: '主动发言人设补充', kind: 'text', maxLen: 500 },
  { path: 'proactive.interests', label: '主动发言话题偏好', kind: 'text', maxLen: 500 },
  { path: 'proactive.dryRun', label: '主动发言只演练不发送', kind: 'bool' },
  { path: 'proactive.requireCjk', label: '发送前兜底：整句英文（超过 12 字）丢掉', kind: 'bool' },
  { path: 'proactive.verbose', label: '主动发言打印判断细节', kind: 'bool' },
  { path: 'vision.enabled', label: '启用图片识别', kind: 'bool' },
  { path: 'vision.maxImages', label: '单轮最多识别几张图', kind: 'int', min: 0, max: 10 },
  // 表情包图库只放行两个开关：目录 / 打标模型属于「能决定读哪些文件、走哪个模型」的敏感项，
  // 和 imageGen.* 一样只在设置页改（见下面的 DENY_PREFIXES）。
  { path: 'sticker.enabled', label: '启用表情包图库', kind: 'bool' },
  { path: 'sticker.autoTag', label: '表情包 AI 自动标记', kind: 'bool' },
  { path: 'sticker.gifCompat', label: '表情包 GIF 兼容模式', kind: 'bool' },
  { path: 'persona.enabled', label: '启用身份设定', kind: 'bool' },
  { path: 'persona.name', label: '身份名字', kind: 'text', maxLen: 20 },
  { path: 'persona.text', label: '身份设定正文', kind: 'text', maxLen: 2000 },
];

/** 永远不允许由工具修改的前缀 / 字段（即使将来有人误加进 SPECS 也会被这里挡下）。 */
const DENY_PREFIXES = [
  'auth.',        // 拥有者名单、访客工具闸：改了就能提权
  'onebot.',      // 连接地址与 access_token
  'imageGen.',    // 生图 baseUrl / apiKey / 模型
  'webSearch.',   // 代理与密钥
  'proactive.model',
  'proactive.speakProvider', // 两段式的发言渠道与模型：等于换掉「说话的人」，不允许工具改
  'proactive.speakModel',
  'vision.provider', 'vision.model',
  // 表情包：只放行开关，目录（能决定读哪些文件）与打标模型跟 imageGen.* 一样只给设置页
  'sticker.dir', 'sticker.provider', 'sticker.model',
  'admin.manageGroups', 'admin.allowConsole', 'admin.dryRun',
  'mode', 'adapterPath', 'nodePath', 'agentPreset', 'agentPresetCustom',
];

export function specFor(path) {
  const key = String(path === undefined || path === null ? '' : path).trim();
  if (key === '') return null;
  for (const spec of SPECS) if (spec.path === key) return spec;
  return null;
}

export function isDenied(path) {
  const key = String(path === undefined || path === null ? '' : path).trim();
  if (key === '') return true;
  for (const prefix of DENY_PREFIXES) {
    if (key === prefix || key.startsWith(prefix)) return true;
  }
  // 未在白名单里的一律视为禁止（白名单是放行的唯一来源；DENY_PREFIXES 是另加的硬拒绝，
  // 用来兜住「将来有人把敏感前缀误加进 SPECS」——它不依赖白名单，删掉它就少了这一层）。
  return specFor(key) === null;
}

const ID_RE = /^\d{5,12}$/;

function toBoolean(value) {
  if (typeof value === 'boolean') return { ok: true, value };
  if (value === 'true' || value === '1') return { ok: true, value: true };
  if (value === 'false' || value === '0') return { ok: true, value: false };
  return { ok: false, error: '需要 true / false' };
}

function toInt(value, min, max) {
  const num = (typeof value === 'number') ? value : Number(String(value).trim());
  if (!Number.isInteger(num)) return { ok: false, error: '需要整数' };
  if (num < min || num > max) return { ok: false, error: '超出范围 ' + min + ' ~ ' + max };
  return { ok: true, value: num };
}

function toIds(value) {
  let list = value;
  if (typeof list === 'string') list = list.split(/[\s,，]+/);
  if (!Array.isArray(list)) return { ok: false, error: '需要 QQ 号数组，例如 ["123456789"]' };
  if (list.length > 200) return { ok: false, error: '最多 200 项' };
  const out = [];
  for (const item of list) {
    const id = String(item).trim();
    if (id === '') continue;
    if (!ID_RE.test(id)) return { ok: false, error: '不是合法 QQ 号：' + id };
    if (!out.includes(id)) out.push(id);
  }
  return { ok: true, value: out };
}

const CLOCK_RE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

function toClocks(value) {
  let list = value;
  if (typeof list === 'string') list = list.split(/[\s,，]+/);
  if (!Array.isArray(list)) return { ok: false, error: '需要时段数组，例如 ["23:00-08:00"]' };
  if (list.length > 10) return { ok: false, error: '最多 10 个时段' };
  const out = [];
  for (const item of list) {
    const text = String(item).trim();
    if (text === '') continue;
    if (!CLOCK_RE.test(text)) return { ok: false, error: '时段格式应为 HH:MM-HH:MM：' + text };
    out.push(text);
  }
  return { ok: true, value: out };
}

/** 按 spec 校验并归一化；返回 { ok, value } 或 { ok:false, error }。 */
export function validateValue(spec, value) {
  if (spec === null || spec === undefined) return { ok: false, error: '未知设置项' };
  switch (spec.kind) {
    case 'bool': return toBoolean(value);
    case 'int': return toInt(value, spec.min, spec.max);
    case 'ids': return toIds(value);
    case 'clocks': return toClocks(value);
    case 'text': {
      if (typeof value !== 'string') return { ok: false, error: '需要字符串' };
      const text = value.trim();
      if (text.length > spec.maxLen) return { ok: false, error: '最多 ' + spec.maxLen + ' 个字符' };
      return { ok: true, value: text };
    }
    default: return { ok: false, error: '不支持的类型' };
  }
}

/** 把 'a.b' + value 变成 {'a': {'b': value}}，供 settings.update 深合并。 */
export function nestedPatch(path, value) {
  const parts = String(path).split('.').filter((part) => part !== '');
  const root = {};
  let node = root;
  for (let index = 0; index < parts.length; index += 1) {
    const key = parts[index];
    if (index === parts.length - 1) node[key] = value;
    else { node[key] = {}; node = node[key]; }
  }
  return root;
}

/** 从 settings.describe() 的结果里认出本插件那个命名空间。 */
export function matchNamespace(descriptors) {
  if (!Array.isArray(descriptors)) return { ok: false, error: '设置服务没有返回描述' };
  const candidates = descriptors.filter((row) => row !== null && typeof row === 'object'
    && typeof row.ns === 'string' && /(^|[-_])qq-bot$/.test(row.ns));
  if (candidates.length === 0) return { ok: false, error: '找不到本插件的设置命名空间' };
  if (candidates.length > 1) return { ok: false, error: '设置命名空间不唯一，拒绝写入' };
  return { ok: true, descriptor: candidates[0] };
}

/**
 * 调用方闸门：只看当前会话的真实发言人。
 * @param {Record<string, any>} cfg 插件配置
 * @param {{ turnSpeaker?: { userId: string, groupId?: string|null }|null, speaker?: { userId: string, groupId?: string|null }|null }|null} entry 当前会话（sessionApi.entryForAgent 的结果）
 */
export function checkCaller(cfg, entry) {
  const auth = (cfg !== null && cfg !== undefined && cfg.auth !== null && cfg.auth !== undefined) ? cfg.auth : {};
  if (auth.ownerSettings === false) {
    return { ok: false, code: 'disabled', error: '拥有者设置通道已关闭（设置里的「允许拥有者通过 QQ 改设置」）' };
  }
  if (entry === null || entry === undefined) {
    return { ok: false, code: 'no-conversation', error: '只能在 QQ 会话里改设置' };
  }
  // 读本回合固化的发言人：entry.speaker 是「最近一条被接受的消息」，排队期间会被后到的消息覆盖。
  const who = (entry.turnSpeaker !== undefined && entry.turnSpeaker !== null) ? entry.turnSpeaker : entry.speaker;
  const speaker = (who !== null && who !== undefined) ? who.userId : undefined;
  if (speaker === undefined || speaker === null || String(speaker) === '') {
    return { ok: false, code: 'no-speaker', error: '拿不到当前消息的发言人' };
  }
  const owners = Array.isArray(auth.owners) ? auth.owners.map((id) => String(id)) : [];
  if (!owners.includes(String(speaker))) {
    return { ok: false, code: 'not-owner', error: '只有拥有者能改设置' };
  }
  // 私聊判定读回合快照：entry.groupId 会被后到的消息覆盖（perChatSession=false 时能借此把群回合判成私聊）。
  if (who !== null && who !== undefined && who.groupId !== null && who.groupId !== undefined) {
    return { ok: false, code: 'not-private', error: '改设置只能在和拥有者的私聊里做，群里一律拒绝' };
  }
  return { ok: true, ownerId: String(speaker) };
}

function pick(value, path) {
  const parts = String(path).split('.');
  let node = value;
  for (const key of parts) {
    if (node === null || node === undefined || typeof node !== 'object') return undefined;
    node = node[key];
  }
  return node;
}


/**
 * 确认码：5 字节 = 40 bit，一次性、5 分钟有效。
 *
 * 熵源必须是 CSPRNG。以前默认用 Math.random()，V8 的 xorshift128+ 在拿到少量输出后
 * 状态可被还原——确认码能落盘改配置，40 位「伪随机」等于把这一步的强度打回猜数字。
 * deps.random 保留给测试注入，生产走 crypto.randomBytes。
 */
function defaultRandom() {
  return randomBytes(4).readUInt32BE(0) / 0x100000000;
}

function randomToken(random) {
  const bytes = [];
  for (let index = 0; index < 5; index += 1) bytes.push(Math.floor(random() * 256));
  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/**
 * @param {object} deps
 * @param {() => ({ describe: () => Promise<any[]>, update: (ns: string, patch: Record<string, any>, revision?: any) => Promise<any> }|null|undefined)} deps.getSettings 取 DSH settings 服务
 * @param {() => Record<string, any>} deps.getConfig 取当前插件配置
 * @param {(line: Record<string, any>) => Promise<void>|void} deps.audit 追加一条审计
 * @param {() => number} [deps.now]
 * @param {() => number} [deps.random]
 * @param {(text: string) => void} [deps.log]
 */
export function createOwnerSettings(deps) {
  const getSettings = deps.getSettings;
  const getConfig = deps.getConfig;
  const audit = (typeof deps.audit === 'function') ? deps.audit : async () => {};
  const now = (typeof deps.now === 'function') ? deps.now : () => Date.now();
  const random = (typeof deps.random === 'function') ? deps.random : defaultRandom;
  const log = (typeof deps.log === 'function') ? deps.log : () => {};

  /** token -> { ownerId, path, value, revision, ns, expiresAt } */
  const pending = new Map();
  /** ownerId -> [appliedAt] */
  const applied = new Map();

  const settingsService = () => {
    const service = getSettings();
    if (service === undefined || service === null || typeof service.describe !== 'function' || typeof service.update !== 'function') {
      return null;
    }
    return service;
  };

  const descriptorFor = async () => {
    const service = settingsService();
    if (service === null) return { ok: false, error: 'DSH 设置服务不可用，拒绝写入（不会手改配置文件）' };
    let descriptors;
    try { descriptors = await service.describe(); } catch (error) {
      return { ok: false, error: '读取设置失败：' + String(error && error.message ? error.message : error) };
    }
    const matched = matchNamespace(descriptors);
    if (matched.ok !== true) return matched;
    return { ok: true, service, descriptor: matched.descriptor };
  };

  function pruneExpired(at) {
    for (const [token, item] of pending) if (item.expiresAt <= at) pending.delete(token);
  }

  function rateLimited(ownerId, at) {
    const cfg = getConfig() || {};
    const auth = cfg.auth || {};
    const perHour = Number.isInteger(auth.ownerSettingsMaxPerHour) ? auth.ownerSettingsMaxPerHour : MAX_PER_HOUR;
    const perDay = Number.isInteger(auth.ownerSettingsMaxPerDay) ? auth.ownerSettingsMaxPerDay : MAX_PER_DAY;
    const list = (applied.get(ownerId) || []).filter((time) => at - time < 24 * 60 * 60 * 1000);
    applied.set(ownerId, list);
    const lastHour = list.filter((time) => at - time < 60 * 60 * 1000).length;
    if (lastHour >= perHour) return { ok: false, error: '改设置太频繁了：每小时最多 ' + perHour + ' 次' };
    if (list.length >= perDay) return { ok: false, error: '改设置太频繁了：每天最多 ' + perDay + ' 次' };
    return { ok: true };
  }

  async function show(ownerId) {
    const found = await descriptorFor();
    if (found.ok !== true) return { ok: false, error: found.error };
    const value = found.descriptor.value || {};
    const rows = SPECS.map((spec) => ({ path: spec.path, label: spec.label, value: pick(value, spec.path) }));
    return { ok: true, ns: found.descriptor.ns, revision: found.descriptor.revision, settings: rows };
  }

  async function propose(ownerId, path, value) {
    // 两种来源（不在白名单 / 命中 DENY_PREFIXES）对用户是同一件事：这个设置项不许改，
    // 所以这里只给一种文案，不透露是哪一层拦下的。
    if (isDenied(path)) {
      return { ok: false, code: 'denied', error: '这个设置项不允许通过 QQ 改：' + String(path) };
    }
    const spec = specFor(path);
    const checked = validateValue(spec, value);
    if (checked.ok !== true) return { ok: false, code: 'invalid', error: checked.error };
    const found = await descriptorFor();
    if (found.ok !== true) return { ok: false, error: found.error };
    const at = now();
    pruneExpired(at);
    const token = randomToken(random);
    const current = pick(found.descriptor.value || {}, path);
    pending.set(token, {
      ownerId,
      path: spec.path,
      value: checked.value,
      revision: found.descriptor.revision,
      ns: found.descriptor.ns,
      expiresAt: at + TOKEN_TTL_MS,
      current,
    });
    return {
      ok: true,
      token,
      path: spec.path,
      label: spec.label,
      current,
      next: checked.value,
      revision: found.descriptor.revision,
      expiresInSeconds: Math.floor(TOKEN_TTL_MS / 1000),
      hint: '确认无误后调用 action=apply 并带上 token；' + Math.floor(TOKEN_TTL_MS / 60000) + ' 分钟内有效，只能用一次。',
    };
  }

  async function apply(ownerId, token) {
    const key = String(token === undefined || token === null ? '' : token).trim().toUpperCase();
    if (key === '') return { ok: false, code: 'no-token', error: '缺少 token' };
    const at = now();
    pruneExpired(at);
    const item = pending.get(key);
    if (item === undefined) return { ok: false, code: 'no-pending', error: '没有这个待确认的改动（可能已过期或已用掉），重新 propose 一次' };
    if (item.ownerId !== ownerId) {
      // 别人的确认码直接拒绝，但不销毁：避免靠猜 token 把拥有者的待确认改动弄没。
      return { ok: false, code: 'not-owner', error: '这个确认码不是你的' };
    }
    const limited = rateLimited(ownerId, at);
    if (limited.ok !== true) {
      await audit({ time: new Date(at).toISOString(), owner: ownerId, path: item.path, from: item.current, to: item.value, result: 'rate-limited' });
      return { ok: false, code: 'rate-limited', error: limited.error };
    }
    const found = await descriptorFor();
    if (found.ok !== true) {
      pending.delete(key);
      return { ok: false, error: found.error };
    }
    if (found.descriptor.revision !== item.revision) {
      pending.delete(key);
      return { ok: false, code: 'stale', error: '这期间设置被别的来源改过，确认码作废；重新 propose 一次' };
    }
    const patch = nestedPatch(item.path, item.value);
    try {
      await found.service.update(found.descriptor.ns, patch, item.revision);
    } catch (error) {
      pending.delete(key);
      const message = String(error && error.message ? error.message : error);
      await audit({ time: new Date(at).toISOString(), owner: ownerId, path: item.path, from: item.current, to: item.value, result: 'error', error: message });
      return { ok: false, code: 'write-failed', error: '写入失败：' + message };
    }
    pending.delete(key);
    const list = applied.get(ownerId) || [];
    list.push(at);
    applied.set(ownerId, list);
    await audit({ time: new Date(at).toISOString(), owner: ownerId, path: item.path, from: item.current, to: item.value, result: 'ok' });
    log('拥有者 ' + ownerId + ' 改了设置 ' + item.path + '：' + JSON.stringify(item.current) + ' → ' + JSON.stringify(item.value));
    return { ok: true, path: item.path, previous: item.current, value: item.value, ns: found.descriptor.ns, note: '已保存，DSH 会热重载配置。' };
  }

  function cancel(ownerId, token) {
    const key = String(token === undefined || token === null ? '' : token).trim().toUpperCase();
    const item = pending.get(key);
    if (item === undefined) return { ok: false, error: '没有这个待确认的改动' };
    if (item.ownerId !== ownerId) return { ok: false, error: '这个确认码不是你的' };
    pending.delete(key);
    return { ok: true, cancelled: true };
  }

  return { show, propose, apply, cancel };
}
