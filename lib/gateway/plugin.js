/**
 * dsh-qq-bot —— 把 QQ 接到 DSH Agent 的 Cordis 插件（Host 侧）
 *
 *   QQ/其它平台 -> 协议适配器（lib/adapters）-> 统一中间表示 -> DSH Agent -> 回复回原平台
 *
 * 依赖的宿主服务（peerDependency，由 DSH 运行时提供）：
 *   subprocess         拉起并监管适配器子进程
 *   sessionController  用官方组装路径创建/取出每个 QQ 会话的 Agent
 *   timer              慢回合提示 + 适配器重启退避
 *   settings（可选）    声明设置页由本插件自带的「QQ 机器人」选项卡负责
 *
 * 配置契约（DSH ≥ 0.1.7）：本模块导出 schemastery 的 `Config`。DSH 直接把它当作
 * 设置表单的来源，并把界面上的修改写回 profile 的 cordis.patch.yml。标了 `.volatile()`
 * 的字段可以热改：cordis-plugin-loader 会就地更新运行中 fiber 的配置引用并发
 * 'loader/volatile-update'，不重新挂载插件。
 * 0.1.6 时代的 `ctx.settings.register(ns, schema, {base})` 在 0.1.7 中已被移除
 * （settings-file 包整体删除），所以这里不再自行注册命名空间。
 *
 * 工作区：读取 DSH 官方默认 Workspace 位置（<系统 Documents>/deepseek-harness），在其同级目录
 * 自动创建 QQ_msg 作为本插件的全局工作区根，每个 QQ 会话一个子目录；无需任何路径配置。
 */

import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { promises as fsPromises, readFileSync, writeFileSync } from 'node:fs';
import { publicFetch } from '../shared/http.js';
import { runWebSearch } from '../tools/websearch.js';
import { runImageSearch, uploadToHost, imgSearchSoutubotFile, imgSearchTraceMoeFile, meIsAllowedImageFile } from '../tools/imgsearch.js';
import { meFindMoli, meMoliFetchText } from '../tools/moli.js';
import { Config, DEFAULTS, plainConfig, mergeConfig, staleConfigPaths, describeError } from '../config.js';
import { createAdmin } from '../api/group-admin.js';
import { createSession } from '../session/manager.js';
import { createSessionArchive } from '../session/session-archive.js';
import { createTools } from '../tools/index.js';
import { qqMsgRootSync, sessionWorkdir, imageCacheDir, isInside } from '../session/workspace.js';
import { createOwnerSettings, matchNamespace } from '../valve/security/owner-settings.js';
import { decideGateEdit, securitySnapshot } from '../valve/tool/gate-guard.js';
import { assembleValves, describeAssembly } from '../assemble.js';
import { resolveAdapterPath } from '../transport/index.js';
import { chunkMarkdown } from '../message/chunk.js';
import { splitBubbles } from '../message/bubbles.js';
import { createMsgIdCache } from '../message/msgid-cache.js';
import { buildPersonaHint, dropConfigPaths, sanitizeDisplayName, summarizeTurnReason, idValue } from './turn-text.js';
import { createModelPicker } from './model-pick.js';
import { createProactiveSurface } from './proactive-surface.js';
import { createAdapterSupervision } from './adapter-supervision.js';
import { createRouteGlue } from './routes-glue.js';
import { createFlowDelivery } from './flow-delivery.js';
import { createInboundLimits } from './inbound-limits.js';
import { createAuthFlow } from './auth-flow.js';
import { createArtifactCollect } from './artifact-collect.js';
import { createVision } from './vision.js';
import { createHostPersonaReader } from './host-persona.js';
import { pickStickerSendStyle } from '../session/proactive.js';
import { createStickerGate } from '../tools/sticker-gate.js';
// 表情包图库：目录扫描 + 哈希索引 + AI 自动打标（工具与设置页路由共用同一个实例）。
import { createStickerLibrary } from '../tools/sticker.js';
import { createTurnRuntime } from './turn-runtime.js';
import { createStreamBridge, shouldStream } from '../message/stream.js';
import { createQqBind, loadOfficialConnect } from '../api/qq-bind.js';
import { mountRoutesWhenReady } from './index.js';
import { createRouteGuard } from './route-auth.js';
import { parseModelCommand } from '../session/model-router.js';
import { flowInterceptKind, artifactInputLines, stripInvisible } from './commands.js';
import { pickInterim } from '../message/interim.js';

import { compatibilityInfo, describeCompatibility } from '../shared/compat.js';
import { createUpdateChecker, fetchJsonDefault, readPackageVersion } from '../api/update-check.js';

export { Config };

export const name = 'dsh-qq-bot';
// attachments / llm：图片视觉用（把 QQ 图片注册成 DSH image 块并探测模型能力）。
// 两者都由 dsh-base 恒常挂载（attachment-local 与 dsh-llm），声明为硬依赖。
export const inject = ['subprocess', 'sessionController', 'timer', 'attachments', 'llm', 'tools'];

/**
 * 免 inject 读取宿主服务：`ctx.get` 拿不到时退回 `ctx.reflect.get`（官方的免注入入口）。
 * 与 cleanupStaleConfig 内部同一套写法；拿不到一律 undefined，调用方自己降级。
 * @param {any} ctx 插件上下文
 * @param {string} name 服务名
 */
function readHostService(ctx, name) {
  try {
    if (typeof ctx.get === 'function') {
      const found = ctx.get(name);
      if (found !== undefined && found !== null) return found;
    }
  } catch { /* 服务未就绪 */ }
  try {
    if (ctx.reflect !== undefined && ctx.reflect !== null && typeof ctx.reflect.get === 'function') return ctx.reflect.get(name);
  } catch { /* ignore */ }
  return undefined;
}

// 本插件的「自报身份」：npm 包名（带作用域，0.12 起）+ 条目 id（一直是 dsh-qq-bot）。
// 配置残留清理按这两个名字**精确**认自己的条目，不做后缀正则（会误伤 my-qq-bot）。
const SELF_IDS = new Set(['dsh-qq-bot', '@sputnikzaychik/dsh-qq-bot']);

// 适配器路径由传输层统一解析（协议 -> 脚本），这里不再自己拼目录：
// 0.10 起适配器统一放 lib/transport/，OneBot 11 保留旧入口文件名做向前兼容。


// —— 工作区根（QQ_msg）：读取 DSH 官方默认 Workspace 位置（<系统 Documents>/deepseek-harness），
// 在它的同级目录建 QQ_msg 作为本插件的全局工作区根；每个 QQ 会话一个子目录。
// Documents 解析复刻 @deepseek-ai/dsh-api-workspace-controller 的平台命令；Linux 上
// xdg-user-dir 在无独立 Documents 目录时回退到主目录，这里同样按返回值采用（即
// 建在 <主目录>/deepseek-harness/QQ_msg，仍与官方 default-workspace 严格同级）。
// 已解析/注册的 QQ_msg 工作区（DSH workspace 分组）；id 为 null 表示该 DSH 无 workspace 服务，回退 cwd。
let qqWorkspaceValue = null;



/** 把设置里的「人格」渲染成一段身份设定；未启用或没填内容时返回空串。 */
/** 深拷贝一份配置，并把指定路径（键名数组）整段摘掉（不改入参）。 */
/**
 * 把本插件配置里 schema 不认识的键从 patch 里清掉。
 *
 * 为什么需要：DSH 的设置写入是「合并」语义（settings.write 里 mergeLayers(strip(raw), next)），
 * 只有 schema 认识的字段才会被替换；版本升级删掉的旧字段没人管，会一直躺在 cordis.patch.yml 里。
 * Schemastery 校验也不报错（未知键原样保留），所以它们既不生效、也不会自己消失。
 *
 * 这里走 configEditor.edit：返回什么就落盘什么，是唯一能真正删掉键的入口
 * （settings.update / settings.mutate 都是合并语义，删不掉键）。
 *
 * 两条安全边界：
 *  1. 只认本插件自己那一行 entry，id / name 精确匹配——不做前后缀模糊匹配，
 *     否则 "my-qq-bot" 这种别人的插件会被误删配置；
 *  2. 以 profile 层（configuration().override）为基座，而不是 edit 回调给的 current。
 *     current 是「各层同 id 后行整段替换」之后的最终配置，拿它当基座会把上层
 *     patch（~/.dsh/cordis.patch.yml、--patch overlay）的内容整段抄进 profile 行。
 *
 * 删掉的键和旧值都会打进日志，升级/降级来回折腾时能照着加回去。
 *
 * @param {Record<string, any>} ctx 插件上下文
 * @param {{tag?: string, log?: (line: string) => void}} [options]
 * @returns {Promise<string[]>} 实际清掉的路径（点号连接，仅供日志与测试使用）
 */
export async function cleanupStaleConfig(ctx, options) {
  const opts = options === undefined || options === null ? {} : options;
  const tag = typeof opts.tag === 'string' && opts.tag !== '' ? opts.tag : '[dsh-qq-bot]';
  const log = typeof opts.log === 'function' ? opts.log : (line) => { console.log(line); };
  const read = (name) => {
    try { if (typeof ctx.get === 'function') { const found = ctx.get(name); if (found !== undefined && found !== null) return found; } } catch { /* 服务未就绪 */ }
    try { if (ctx.reflect !== undefined && ctx.reflect !== null && typeof ctx.reflect.get === 'function') return ctx.reflect.get(name); } catch { /* ignore */ }
    return undefined;
  };
  const editor = read('configEditor');
  if (editor === undefined || editor === null || typeof editor.configuration !== 'function' || typeof editor.edit !== 'function') return [];
  let rows;
  try { rows = editor.configuration(); } catch (error) {
    log(tag + ' 读取配置清单失败，本次跳过废弃字段清理：' + describeError(error));
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const mine = rows.find((row) => {
    const entryOptions = row === null || row === undefined || row.entry === null || row.entry === undefined ? undefined : row.entry.options;
    if (entryOptions === undefined || entryOptions === null) return false;
    const name = entryOptions.name === undefined || entryOptions.name === null ? '' : String(entryOptions.name);
    const id = entryOptions.id === undefined || entryOptions.id === null ? '' : String(entryOptions.id);
    // 自报名字：0.12 起包名带作用域，而条目 id 仍是 dsh-qq-bot，两个都要认。
    // 这里**只做精确匹配**——用 /(^|[-_] )qq-bot$/ 之类的正则会误伤 my-qq-bot 这类别的插件。
    return SELF_IDS.has(name) || SELF_IDS.has(id);
  });
  if (mine === undefined) return [];
  const override = mine.override === undefined || mine.override === null ? {} : mine.override;
  const stale = staleConfigPaths(override);
  if (stale.length === 0) return [];
  const labels = stale.map((path) => path.join('.'));
  const describeValue = (value) => {
    if (value === undefined) return 'undefined';
    try {
      const text = JSON.stringify(value);
      return text !== undefined && text.length > 120 ? text.slice(0, 117) + '…' : String(text);
    } catch { return String(value); }
  };
  const readValue = (path) => {
    let node = override;
    for (const part of path) {
      if (node === null || typeof node !== 'object') return undefined;
      node = node[part];
    }
    return node;
  };
  const removed = stale.map((path, index) => labels[index] + '=' + describeValue(readValue(path))).join('、');
  try {
    // 基座是 profile 层的 override：current 含上层 patch 的合并结果，拿它写回会把别人的层抄进来。
    await editor.edit(mine.entry, () => dropConfigPaths(override, stale));
  } catch (error) {
    log(tag + ' 清理废弃配置失败（不影响运行）：' + describeError(error));
    return [];
  }
  log(tag + ' 清理了 ' + stale.length + ' 个本版本已不存在的配置字段：' + removed);
  return labels;
}

export async function apply(ctx, rawConfig) {
  const TAG = '[dsh-qq-bot]';
  const subprocess = ctx.subprocess;
  const sessionController = ctx.sessionController;

  // DSH 交给插件的已经是「按 Config schema 求值过」的配置：composition 行配置、
  // profile 的 cordis.patch.yml、schema 默认值三层已经合并完。volatile 字段是引用
  // （要 .get()），这里还原成普通对象；CONFIG 是个 let，热更新时整体刷新。
  const resolveConfig = () => {
    const merged = mergeConfig(DEFAULTS, plainConfig(rawConfig ?? {}));
    // 设置页的 preset 下拉只列内置四个；自定义档位（如 qq）用 agentPresetCustom 填，非空时优先。
    const customPreset = (merged.agentPresetCustom === undefined || merged.agentPresetCustom === null)
      ? '' : String(merged.agentPresetCustom).trim();
    if (customPreset !== '') merged.agentPreset = customPreset;
    return merged;
  };
  let CONFIG = resolveConfig();
  // 表情包闸门：概率 + 每群每小时上限 + 同图去重。
  // 状态只在内存里——这是观感节流，不是账本。
  const stickerGate = createStickerGate({
    getConfig: () => (CONFIG.sticker === undefined || CONFIG.sticker === null ? {} : CONFIG.sticker),
    log: (line) => console.log(TAG + ' ' + line),
  });

  // 本插件自带设置面板（入口：首页侧边栏「插件 → 已安装 → @sputnikzaychik/dsh-qq-bot」），
  let settingsConfigured = false;
  try {
    ctx.inject(['settings'], (child) => {
      child.effect(() => {
        if (settingsConfigured) return () => {};
        settingsConfigured = true;
        const dispose = child.settings.configure({ auto: false }, ctx.fiber);
        return () => { settingsConfigured = false; if (typeof dispose === 'function') dispose(); };
      });
    });
  } catch (error) {
    console.log(TAG + ' 未能声明设置页归属（不影响运行）：' + describeError(error));
  }

  // 废弃字段清理：启动时跑一次，之后每次保存设置（volatile 更新）再跑一次。
  // 只有真的存在废弃键时才写盘；写盘对 loader 来说是非 volatile 变更（schema 外的键
  // 在 equal() 里严格比较），所以清理成功会重挂一次插件、适配器断连重连——一次性，不会自激。
  let staleCleanupPending = null;
  const scheduleStaleCleanup = (delay) => {
    if (staleCleanupPending !== null) return;
    try {
      staleCleanupPending = ctx.timeout(() => {
        staleCleanupPending = null;
        // void 只吞 lint，不吞 rejection；这里漏了就会变成 unhandled rejection（Node 默认退出）。
        void cleanupStaleConfig(ctx, { tag: TAG }).catch((error) => {
          console.error(TAG + ' 清理废弃配置失败：' + describeError(error));
        });
      }, delay);
    } catch (error) {
      staleCleanupPending = null;
    }
  };
  scheduleStaleCleanup(1200);

  // 只关心影响「连接方式」的那几项：变了才重启适配器。
  const transportKey = (cfg) => JSON.stringify([
    cfg.protocol, cfg.mode,
    cfg.onebot.wsUrl, cfg.onebot.listen, cfg.onebot.httpUrl, cfg.onebot.accessToken,
    cfg.protocols.onebot12, cfg.protocols.satori, cfg.protocols.milky, cfg.protocols.qqOfficial,
  ]);

  // 工作区根（QQ_msg）不依赖 CONFIG：模块级 qqMsgRootSync() 解析一次即缓存。
  // 适配器路径依赖 CONFIG（会被热更新整体替换），所以用取值函数而不是快照常量。
  const currentAdapterPath = () => {
    if (CONFIG.adapterPath !== '') return CONFIG.adapterPath;
    return resolveAdapterPath(CONFIG.protocol);
  };

  /** 流程授权开启时给每个会话一个独立工作区（QQ_msg/<sessionId>）：产物要按会话归属，共用根分不出是谁写的。 */
  async function ensureSessionWorkspace(sessionId) {
    const dir = sessionWorkdir(sessionId);
    try { await fsPromises.mkdir(dir, { recursive: true }); }
    catch (error) { console.error(TAG + ' 会话目录建不出来（产物投递会拿不到文件）：' + describeError(error)); }
    let id = null;
    try {
      const reg = (typeof ctx.reflect?.get === 'function') ? ctx.reflect.get('workspaceRegistry') : undefined;
      if (reg && typeof reg.resolveByPath === 'function' && typeof reg.create === 'function') {
        let ws = await reg.resolveByPath(dir);
        if (ws === undefined || ws === null) ws = await reg.create(dir, 'QQ 会话 ' + sessionId);
        id = (ws && typeof ws.id === 'string' && ws.id !== '') ? ws.id : null;
      }
    } catch (error) { console.error(TAG + ' 会话工作区分组不可用（回退 cwd 方式）：' + describeError(error)); }
    return { id, path: dir };
  }

  // 确保 QQ_msg 已注册为 DSH workspace（Web UI 侧栏的「分组」）。Cordis 的
  // ctx.<服务> 需要 inject 声明才能访问；ctx.reflect.get(name) 是官方的免注入
  // 读服务方法，服务缺失时返回 undefined —— 自动回退 cwd 方式（不分组，不影响收发）。
  async function ensureQqMsgWorkspace() {
    if (qqWorkspaceValue !== null) return qqWorkspaceValue;
    const root = qqMsgRootSync();
    let id = null;
    try {
      const reg = (typeof ctx.reflect?.get === 'function') ? ctx.reflect.get('workspaceRegistry') : undefined;
      if (reg && typeof reg.resolveByPath === 'function' && typeof reg.create === 'function') {
        let ws = await reg.resolveByPath(root);
        if (ws === undefined || ws === null) ws = await reg.create(root, 'QQ 消息');
        id = (ws && typeof ws.id === 'string' && ws.id !== '') ? ws.id : null;
      }
    } catch (error) {
      console.error(TAG + ' 工作区分组不可用（回退 cwd 方式）：' + describeError(error));
    }
    qqWorkspaceValue = { id, path: root };
    return qqWorkspaceValue;
  }

  let uidCounter = 0;
  const uid = (prefix) => prefix + '-' + Date.now().toString(36) + '-'
    + (uidCounter++).toString(36) + '-' + Math.random().toString(36).slice(2, 8);

  const state = {
    connected: false, statusReason: '', restarts: 0, stopping: false,
    // 已排上但还没执行的重启：用来去重（避免两个定时器各起一个适配器）并支持取消。
    restartPending: false, restartCancel: null,
    adapterPid: null, listenPort: null,
    convos: new Map(),
      stats: { inbound: 0, accepted: 0, skipped: 0, duplicates: 0, replies: 0, chunks: 0, errors: 0, admin: 0, actions: 0, notices: 0, guestBlocked: 0, flowBlocked: 0 },
    // 入站去重（消息幂等）：重连/重投的同一条消息只起一个回合。
    msgIds: createMsgIdCache({ max: 512, ttlMs: 10 * 60 * 1000 }),
      // 动作请求/响应关联：{ echo -> resolve }
      pending: new Map(),
      actionSeq: 0,
  };

  // 兼容自检：读当前实际加载的 DSH 版本，启动日志与 qqbot status 都给出结论；
  // 不逐版本硬编码，支持范围只维护 lib/shared/compat.js 里的两个常量。
  state.dsh = compatibilityInfo();
  console.log(TAG + ' ' + describeCompatibility(state.dsh));
  state.proactive = { timer: null, groups: new Map(), selfId: null, warned: '', banner: '' };
  // ---------------------------------------------------- 流程授权状态（不跨会话共享）
  // promptIds: qq -> 机器人发出去那条授权提示的 message_id（通过后撤回它）
  // resume: 授权通过后要续跑的回合 { entry, frame }；active: 活动流程名（/flow use 切换）
  state.flow = { promptIds: new Map(), resume: null, active: '', recoveryUsed: new Set() };
  const flowAuditFile = join(qqMsgRootSync(), 'qqbot-flow-audit.jsonl');
  // 阀门按优先级成型：network(10) → security(20) → tool(30)。
  // 出网策略先就位，安全阀拿到配置与审计通道，工具阀再消费安全阀发出的授权；
  // 顺序由 assemble.js + valve/index.js 的 STAGE 表决定，这里不再自己排。
  const valves = assembleValves({
    config: () => CONFIG,
    audit: (line) => {
      console.log(TAG + ' 流程授权审计 ' + JSON.stringify(line));
      try {
        fsPromises.appendFile(flowAuditFile, JSON.stringify(line) + '\n', 'utf8').catch(() => {});
      } catch (error) { /* 审计写不进去不阻塞授权 */ }
    },
    flowRoot: join(qqMsgRootSync(), 'flows'),
    flowEnabled: () => flowEnabled(),
    gatedTools: () => ((CONFIG.flowAuth === undefined || CONFIG.flowAuth === null
      || !Array.isArray(CONFIG.flowAuth.gatedTools)) ? [] : CONFIG.flowAuth.gatedTools),
    proxy: () => ((CONFIG.webSearch === undefined || CONFIG.webSearch === null) ? '' : String(CONFIG.webSearch.proxy || '')),
    log: (line) => console.log(TAG + line),
  });
  console.log(TAG + ' ' + describeAssembly());
  const flowAuth = valves.security.flowAuth;
  const flowGate = /** @type {Record<string, any>} */ (valves.tool).gate;
  const flowStore = valves.security.flowStore;
  const flowAuthApi = {
    enabled: () => flowEnabled(),
    request: (purpose, entry, frame) => requestFlowAuth(purpose, entry, frame),
    status: () => flowAuth.status(),
    active: () => state.flow.active,
  };


  let nodePath = CONFIG.nodePath;
  if (nodePath === '') {
    nodePath = process.execPath;
    try { nodePath = await subprocess.resolveExecutable('node'); }
    catch (error) { console.log(TAG + ' 未能解析 node，改用 ' + nodePath); }
  }

  // 主动发言：实现搬到 gateway/proactive-surface.js（P3 2.4 第二阶段，只搬不改）。
  // 主动发言的人格：宿主求值后的 soul 人格段（dsh-soul-md 注册的 soul:persona），拿不到就空串，
  // 由 proactive 侧按「手填 > 宿主 > 插件自身 persona」决定用哪个。
  const readHostPersona = createHostPersonaReader({
    getSystemPrompt: () => readHostService(ctx, 'systemPrompt'),
    log: (line) => console.log(TAG + ' ' + line),
  });
  /** 主动发言能不能配表情包：图库开关打开、索引可用即算可用。 */
  function stickerAvailableForProactive() {
    if (stickerApi === undefined || stickerApi === null) return false;
    const conf = CONFIG.sticker;
    return conf !== undefined && conf !== null && conf.enabled === true;
  }

  /**
   * 主动发言的「文字 + 表情包」：按模型给的关键词挑一张，随机决定合并成一条还是先图后字。
   * 挑不到图 / 读文件失败 / 适配器写失败 → 返回 false，调用方退回纯文字，不让发言失败。
   */
  async function sendStickerWithTextForProactive(options) {
    const opts = options === undefined || options === null ? {} : options;
    const groupId = String(opts.groupId === undefined || opts.groupId === null ? '' : opts.groupId);
    const text = typeof opts.text === 'string' ? opts.text : '';
    const query = typeof opts.query === 'string' ? opts.query : '';
    if (groupId === '' || stickerAvailableForProactive() !== true) return false;
    let picked;
    try {
      picked = stickerApi.pick({ q: query });
    } catch (error) {
      console.log(TAG + ' 主动发言：挑表情包失败（' + describeError(error) + '）');
      return false;
    }
    if (picked === null || picked === undefined || typeof picked.path !== 'string') return false;
    // 主动配图也过闸门（force=false）：概率/上限/去重都管，被拒就退回纯文字
    const gate = stickerGate.decide({ groupId, id: picked.item.file, force: false });
    if (gate.allowed !== true) {
      console.log(TAG + ' 主动发言：表情包闸门未通过（' + gate.reason + '），只发文字');
      return false;
    }
    let dataUrl;
    try {
      dataUrl = 'base64://' + readFileSync(picked.path).toString('base64');
    } catch (error) {
      console.log(TAG + ' 主动发言：读表情包失败（' + describeError(error) + '）');
      return false;
    }
    const image = { type: 'image', data: { file: dataUrl } };
    let sent = false;
    if (pickStickerSendStyle() === 'separate') {
      // 先图后字：更像真人在群里连发两条
      if (writeToAdapter({ type: 'send', message_type: 'group', target_id: groupId, message: [image] }) === true) {
        sent = writeToAdapter({ type: 'send', message_type: 'group', target_id: groupId, text }) === true;
      }
    } else {
      sent = writeToAdapter({ type: 'send', message_type: 'group', target_id: groupId, text, message: [image] }) === true;
    }
    if (sent === true) stickerGate.record({ groupId, id: picked.item.file });
    return sent;
  }

  const proactive = createProactiveSurface({
    TAG,
    getConfig: () => CONFIG,
    getState: () => state,
    ctx,
    describeError,
    callAdapterAction: (action, params, timeoutMs) => callAdapterAction(action, params, timeoutMs),
    getHostPersona: (agent) => readHostPersona(agent),
    sendStickerWithText: (options) => sendStickerWithTextForProactive(options),
    stickerAvailable: () => stickerAvailableForProactive(),
    // 名字必须和 proactive-surface.js 解构的一致（getSessionApi）：以前这里写成 sessionApi，
    // 工厂拿到 undefined，每次主动发言都报「getSessionApi is not a function」并降级。
    getSessionApi: () => sessionApi,
    writeToAdapter: (frame) => writeToAdapter(frame),
  });
  const { scheduleProactive, stopProactive } = proactive;

  // 适配器监管：实现搬到 gateway/adapter-supervision.js（P3 2.4 第二阶段，只搬不改）。
  const adapterSupervision = createAdapterSupervision({
    TAG,
    getConfig: () => CONFIG,
    getState: () => state,
    ctx,
    describeError,
    nodePath,
    getAdapterPath: currentAdapterPath,
    // 必须 bind：DSH 的 subprocess.spawn 是服务对象上的方法，内部要读 this（选容器模式）。
    // 裸传裸函数会让 this 变成 undefined，一调用就
    // "Cannot read properties of undefined (reading 'selectContainmentMode')"，
    // 表现为适配器永远起不来、每 30 秒重试一次，QQ 侧全程无响应。
    spawn: subprocess.spawn.bind(subprocess),
    qqMsgRoot: qqMsgRootSync,
    onFrame: (frame) => onAdapterFrame(frame),
  });
  const { writeToAdapter, writeToAdapterAsync, callAdapterAction, spawnAdapter, stopAdapter, scheduleRestart, cancelRestart } = adapterSupervision;

  // -------------------------------------------------------------- 入站帧
  function onAdapterFrame(frame) {
    if (frame === null || typeof frame !== 'object') return;
    if (CONFIG.logAdapterFrames) console.log(TAG + ' <- ' + JSON.stringify(frame));

    if (frame.type === 'hello') {
      state.adapterPid = frame.pid ?? null;
      console.log(TAG + ' 适配器就绪（pid ' + String(frame.pid) + '，' + String(frame.mode) + ' 模式）');
    } else if (frame.type === 'listening') {
      state.listenPort = frame.port ?? null;
      console.log(TAG + ' 反向 WS 监听中：' + String(frame.host) + ':' + String(frame.port));
    } else if (frame.type === 'status') {
      state.connected = frame.connected === true;
      if (state.connected === true) state.restarts = 0; // 连上了就把退避清零，下次抖动重新从 baseMs 起
      state.statusReason = typeof frame.reason === 'string' ? frame.reason : '';
      console.log(TAG + ' OneBot ' + (state.connected ? '已连接' : '未连接')
        + (state.statusReason === '' ? '' : '（' + state.statusReason + '）'));
    } else if (frame.type === 'message') {
      state.stats.inbound += 1;
      // 入口必须自己兜底：acceptMessage 里的 await（建会话、查群成员、下鉴权）
      // 只要抛一次就会变成 unhandled rejection，Node 24 会直接退进程（B1 同款坑）。
      void acceptMessage(frame).catch((error) => {
        state.stats.errors += 1;
        console.error(TAG + ' 处理消息失败：' + describeError(error));
      });
    } else if (frame.type === 'action_result') {
      state.stats.actions += 1;
      const waiter = state.pending.get(frame.echo);
      if (waiter !== undefined) { state.pending.delete(frame.echo); waiter(frame); }
    } else if (frame.type === 'notice') {
      state.stats.notices += 1;
    } else if (frame.type === 'send_result') {
      if (frame.ok === true) state.stats.chunks += 1;
      else { state.stats.errors += 1; console.error(TAG + ' 发送失败：' + String(frame.error)); }
    } else if (frame.type === 'log') {
      console.log(TAG + '/adapter ' + String(frame.text));
    } else if (frame.type === 'error') {
      console.error(TAG + '/adapter ' + String(frame.text));
    }
  }

  const allowlistOk = (allow, id) => {
    if (!Array.isArray(allow) || allow.length === 0) return true;
    for (const entry of allow) if (String(entry) === String(id)) return true;
    return false;
  };

  // ==================================================== 权限：三路并行 + 动态授权
  // 三路并行取并集（不是先命中先返回）：
  //   1. 静态名单：拥有者（全部权限 + 永久授权）、后台设定的高级管理员（群管理权限）
  //   2. 动态授权：**群维度**、可带时限，由拥有者或本群管理员授予，不可跨群生效
  //   3. 本群身份：get_group_member_info 查到 admin / owner
  // 拥有者另有一条「路由」特权：拥有者与非拥有者可以走不同的会话与 agent preset
  // （见 sessionRoute；不配 preset 就共用一条会话，行为与以前一致）。

  /** 查询被引用（回复）消息的发送者是否 bot 自己；查不到按非 bot 处理。 */
  async function isReplyToSelf(frame) {
    if (frame.reply_to === null || frame.reply_to === undefined) return false;
    const selfId = frame.self_id === null || frame.self_id === undefined ? null : String(frame.self_id);
    if (selfId === null) return false;
    try {
      const result = await callAdapterAction('get_msg', { message_id: idValue(frame.reply_to) }, 8000);
      if (result.ok === true && result.data !== null && result.data !== undefined
        && result.data.sender !== null && result.data.sender !== undefined
        && String(result.data.sender.user_id) === selfId) return true;
    } catch { /* 查不到按非 bot 处理 */ }
    return false;
  }

  // ============================================== 流程授权（私聊动态码）与会话续跑
  // 产品约定（按用户原话落地）：
  //   1. 授权只在私聊里、由主人本人发起和完成；群里叫不动它；
  //   2. 动态码是标准 TOTP（RFC 6238），插件不认万能码，也没有测试后门；
  //   3. 令牌消息在 acceptMessage 里前置拦截：不进模型、不落会话；验证通过后机器人
  //      撤回自己那条请求，并提醒主人撤回他发的码（QQ 只允许撤回自己的消息）；
  //   4. 授权一次一用，用完即弃；用完那一刻把被拦下的回合接着跑完。
  function flowEnabled() {
    return CONFIG.flowAuth !== undefined && CONFIG.flowAuth !== null && CONFIG.flowAuth.enabled === true;
  }

  // 没配拥有者只提示一次：默认装配下每条消息都会走到这里，逐条 warn 会把日志刷满。
  let ownerMissingWarned = false;
  function warnOwnerMissingOnce() {
    if (ownerMissingWarned === true) return;
    ownerMissingWarned = true;
    console.log(TAG + ' 警告：auth.owners 为空，插件不驱动任何会话（fail-closed）。请先在「插件 → 已安装 → @sputnikzaychik/dsh-qq-bot → 基本 → 拥有者 QQ 号」填上自己的 QQ 号。');
  }

  // 入站限制：实现搬到 gateway/inbound-limits.js（P3 2.4 第三阶段，只搬不改）。
  const inboundLimits = createInboundLimits({
    getConfig: () => CONFIG,
    sendReply: (frame, text) => sendReply(frame, text),
  });
  const { inboundPerMinute, inboundQueueMax, inboundMaxChars, takeTurnSlot, notifyThrottled } = inboundLimits;

  // 授权/流程：实现搬到 gateway/auth-flow.js（P3 2.4 第三阶段，只搬不改）。
  const authFlow = createAuthFlow({
    TAG,
    getConfig: () => CONFIG,
    getState: () => state,
    ctx,
    describeError,
    sendReply: (frame, text, quote) => sendReply(frame, text, quote),
    callAdapterAction: (action, params, timeoutMs) => callAdapterAction(action, params, timeoutMs),
    flowGate,
    writeToAdapter: (frame) => writeToAdapter(frame),
    flowEnabled,
    flowAuth,
    getDeliverFlowArtifacts: () => deliverFlowArtifacts,
    getRunTurn: () => turnRuntime.runTurn,
    flowStore,
  });
  const { ownerQq, sendPrivateText, recallMessage, requestFlowAuth, resumeAfterAuth, handleAuthMessage, handleFlowCommand, writeFlowAuthPatch } = authFlow;

  // 产物收集：实现搬到 gateway/artifact-collect.js（P3 2.4 第三阶段，只搬不改）。
  const artifactCollect = createArtifactCollect({ TAG });
  const { listFreshFiles, packFlowFiles, artifactDirs } = artifactCollect;

  /** 被授权的工具跑完这一轮后，把新产物打包送出；没有产物就什么都不做。 */
  // 产物投递：实现搬到 gateway/flow-delivery.js（P3 2.4 第二阶段，只搬不改）。
  const flowDelivery = createFlowDelivery({
    TAG,
    getConfig: () => CONFIG,
    callAdapterAction: (action, params, timeoutMs) => callAdapterAction(action, params, timeoutMs),
    describeError,
    sendReply: (frame, text) => sendReply(frame, text),
    ownerQq: () => ownerQq(),
    artifactDirs,
    listFreshFiles,
    packFlowFiles,
  });
  const { deliverFlowArtifacts } = flowDelivery;


  // 同会话处理顺序锁：到达时同步占位，处理完（消息已挂上会话队列）再释放。
  // 不这样做的话，getEntry / 查群成员鉴权这些 await 谁先完成谁先入队，连发两条会反着执行。
  const orderChains = new Map();
  /** 顺序锁的兜底持有上限：调用方漏 release（异常路径）时也不能让这个会话永久哑掉。 */
  const ORDER_HOLD_TIMEOUT_MS = 120000;

  function acquireOrder(key) {
    const prev = orderChains.get(key);
    /** @type {(value?: any) => void} */
    let resolveGate = () => {};
    let released = false;
    const mine = new Promise((resolve) => { resolveGate = resolve; });
    const chained = (prev === undefined ? Promise.resolve() : prev).then(() => mine);
    orderChains.set(key, chained);
    // release 幂等 + 超时兜底：显式出口有好几处，但从这里到 acceptMessage 拿到锁之间还有
    // 未包的 await（resolveAuthority 会往适配器发动作），任何一处抛出都会漏掉释放，之后该会话
    // 的每条消息都卡在 prev 上永不入队（表现是「一个人突然不说话了」）。
    const timer = setTimeout(() => {
      console.error(TAG + ' 顺序锁超过 ' + ORDER_HOLD_TIMEOUT_MS + 'ms 未释放，强制放行（' + key + '）');
      release();
    }, ORDER_HOLD_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    function release() {
      if (released === true) return;
      released = true;
      clearTimeout(timer);
      resolveGate();
      if (orderChains.get(key) === chained) orderChains.delete(key);
    }
    return release;
  }

  // 识图：实现搬到 gateway/vision.js（P3 2.4 第三阶段，只搬不改）。
  const vision = createVision({
    TAG,
    getConfig: () => CONFIG,
    ctx,
    describeError,
  });
  const { describeImages, downloadImage, askVision } = vision;
  // 表情包图库：目录默认 QQ_msg/sticker，索引写目录根部的 index.json。
  // 每次现取 CONFIG（热更新即时生效），打标复用 DSH 已注册的视觉模型。
  const stickerApi = createStickerLibrary({
    getConfig: () => CONFIG,
    getRoot: qqMsgRootSync,
    ctx,
    describeError,
    log: (line) => console.log(TAG + ' ' + line),
  });
  /**
   * 发回复。withQuote=true 且是群聊时，用「QQ 回复消息流程」（引用触发消息）。
   * 注意：引用回复只在 bot 被点名（@ 了 bot 或回复了 bot）的响应上用；
   * 若对每条群消息都引用，requireAt 关闭时就会每条消息都引用回复。
   *
   * 气泡拆分：模型爱写「一句\n\n一句」，以前整条发出去就是一个气泡两行。
   * 这里按空行拆成 2–3 条短消息、间隔 800ms 发出去（只有第一条带引用）；
   * 长回答 / 代码块 / 表格 / 列表不拆，仍走原来的分条逻辑。
   */
  const BUBBLE_GAP_MS = 800;
  function sendReply(frame, text, withQuote) {
    const target = frame.message_type === 'group' ? frame.group_id : frame.user_id;
    if (target === null || target === undefined) return;
    const replyTo = (withQuote === true && frame.message_type === 'group'
      && frame.message_id !== null && frame.message_id !== undefined)
      ? idValue(frame.message_id) : undefined;
    const sendOne = (segment, quote) => {
      for (const chunk of chunkMarkdown(segment, CONFIG.reply.maxChars)) {
        writeToAdapter({
          type: 'send',
          message_type: frame.message_type === 'group' ? 'group' : 'private',
          target_id: String(target),
          text: chunk,
          ...(quote !== undefined ? { reply_to: quote } : {}),
        });
      }
    };
    const segments = splitBubbles(String(text), { maxPartChars: 80, maxParts: 3 });
    if (segments.length <= 1) { sendOne(String(text), replyTo); return; }
    segments.forEach((segment, index) => {
      if (index === 0) { sendOne(segment, replyTo); return; }
      const timer = setTimeout(() => { sendOne(segment, undefined); }, BUBBLE_GAP_MS * index);
      if (typeof timer.unref === 'function') timer.unref();
    });
  }
  // 业务模块装配：权限/指令（admin）、会话（session）、动态工具（tools）都从独立模块工厂取。
  // 依赖经工厂注入（CONFIG 走 getConfig() 每次现取，支持热更新；state/ctx 传引用）。
  const adminApi = createAdmin({ getConfig: () => CONFIG, callAdapterAction, sendReply, state });
  // 归档召回：DSH 的「归档会话」会让预置闸门 reject 每一步模型请求（详见 session/session-archive.js），
  // 所以 QQ 消息触发会话时先把它从归档集合里摘掉。ctx 交给它自己取 workspaceRegistry（免 inject）。
  const sessionArchive = createSessionArchive({ ctx, log: (message) => console.log(TAG + ' ' + message) });
  const sessionApi = createSession({ getConfig: () => CONFIG, ctx, state, ensureQqMsgWorkspace, ensureSessionWorkspace, sessionWorkdir, callAdapterAction, describeError, isOwner: adminApi.isOwner, flowGate, archiveApi: sessionArchive });
  // 拥有者专用设置通道：落盘只走 DSH settings 服务（schema 校验 + 原子写 + 热重载），
  // 不直接改 profile 的 cordis.patch.yml；每次写入都追加一条审计日志到 QQ_msg 根目录。
  const ownerSettings = createOwnerSettings({
    getSettings: () => { try { return ctx.get('settings'); } catch (error) { return undefined; } },
    getConfig: () => CONFIG,
    audit: async (line) => {
      try {
        await fsPromises.appendFile(join(qqMsgRootSync(), 'qqbot-config-audit.jsonl'), JSON.stringify(line) + '\n', 'utf8');
      } catch (error) {
        console.log(TAG + ' 设置审计写入失败：' + describeError(error));
      }
    },
    log: (message) => console.log(TAG + ' ' + message),
  });

  const toolsApi = createTools({ getConfig: () => CONFIG, state, ctx, net: valves.network, writeToAdapter, writeToAdapterAsync, callAdapterAction, describeError, toId: adminApi.toId, entryForAgent: sessionApi.entryForAgent, resolveAuthority: adminApi.resolveAuthority, hasPerm: adminApi.hasPerm, describeAuthority: adminApi.describeAuthority, groupInScope: adminApi.groupInScope, permissionList: adminApi.PERMISSION_LIST, runWebSearch, meFindMoli, meMoliFetchText, runImageSearch, uploadToHost, imgSearchSoutubotFile, imgSearchTraceMoeFile, meIsAllowedImageFile, downloadImage, askVision, qqMsgRootSync, currentAdapterPath, ownerSettings, flowAuthApi, sticker: stickerApi, stickerGate });

  // -------------------------------------------------------------- 动态工具
  // 用动态 import 拿 defineTool：即使这个包不在，桥接本身照样工作，只是少一个工具。
  try {
    await toolsApi.registerTools();
  } catch (error) {
    console.log(TAG + ' 跳过 qqbot 工具注册：' + describeError(error));
  }

  // -------------------------------------------------------------- 闸门区
  // 「哪些工具需要动态码」这份名单本身也要受码保护：GUI 里填码解锁、改完点保存 = 消费一次码；
  // 不保存就什么都不写。服务端只认结果：名单变了但码不对，回滚名单并清空码字段，
  // 绝不静默接受（设置页刷一下就能看到名单弹回去）。
  let lastGatedTools = Array.isArray(CONFIG.flowAuth.gatedTools) ? CONFIG.flowAuth.gatedTools.map((item) => String(item)) : [];
  let lastFlowEnabled = CONFIG.flowAuth.enabled === true;
  // 保护闸门本身的字段（密钥/恢复码/试错上限/授权时长）同样要有内存基线：
  // 以前只比 enabled + gatedTools，于是「换掉 totpSecret」这一步连码都不会被问，
  // 换完之后所有「改名单要码」都变成「用攻击者的码验攻击者的锁」（2026-10-28 审计 A1）。
  let lastFlowSecurity = securitySnapshot(CONFIG.flowAuth);
  // 闸门码的重放与失败锁定状态：flow-auth 那条路早就有，这条以前是纯无状态校验。
  const gateState = { lastCounter: undefined, fails: 0, lockedUntil: 0 };
  const writeSettingsPatch = async (patch) => {
    try {
      const settings = ctx.get('settings');
      if (settings === undefined || settings === null || typeof settings.describe !== 'function' || typeof settings.update !== 'function') {
        return { ok: false, error: '设置服务不可用' };
      }
      const descriptors = await settings.describe();
      const matched = matchNamespace(descriptors);
      if (matched.ok !== true) return { ok: false, error: matched.error };
      await settings.update(matched.descriptor.ns, patch, matched.descriptor.revision);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  };
  // 模型选择：路由与 /model 指令实现搬到 gateway/model-pick.js（P3 2.4 第一阶段，只搬不改）。
  const modelPicker = createModelPicker({
    getService: (id) => { try { return ctx.get(id); } catch (error) { return undefined; } },
    prefsFile: join(qqMsgRootSync(), 'model-prefs.json'),
    getPrefix: () => CONFIG.admin.prefix,
    log: (line) => console.log(TAG + ' ' + line),
  });
  const { modelRouter, handleModelCommand } = modelPicker;
  // 流式桥：只有官方 v2 私聊会用；send 交给适配器的 stream 命令（fire-and-forget，失败在适配器侧记日志）。
  const streamBridge = createStreamBridge({
    send: async (payload) => {
      writeToAdapter({
        type: 'stream',
        message_type: payload.messageType,
        target_id: payload.targetId,
        msg_id: payload.msgId,
        text: payload.text,
        done: payload.done,
      });
      return { ok: true };
    },
    log: (line) => console.log(TAG + ' ' + line),
  });

  // 回合运行时：实现搬到 gateway/turn-runtime.js（P3 2.4 第三阶段，只搬不改）。
  const turnRuntime = createTurnRuntime({
    TAG,
    getConfig: () => CONFIG,
    getState: () => state,
    ctx,
    describeError,
    sendReply,
    writeToAdapter: (frame) => writeToAdapter(frame),
    callAdapterAction: (action, params, timeoutMs) => callAdapterAction(action, params, timeoutMs),
    adminApi,
    sessionApi,
    toolsApi,
    flowGate,
    valves,
    acquireOrder,
    takeTurnSlot,
    notifyThrottled,
    inboundMaxChars,
    inboundQueueMax,
    handleAuthMessage,
    handleFlowCommand,
    requestFlowAuth,
    ownerQq,
    describeImages,
    deliverFlowArtifacts,
    handleModelCommand,
    parseModelCommand,
    flowInterceptKind,
    stripInvisible,
    buildPersonaHint,
    sanitizeDisplayName,
    summarizeTurnReason,
    idValue,
    streamBridge,
    allowlistOk,
    qqMsgRootSync,
    uid,
    warnOwnerMissingOnce,
    isReplyToSelf,
  });
  const { acceptMessage, scheduleImageSweep } = turnRuntime;


  // 扫码 / 版本探测 / 路由挂载：实现搬到 gateway/routes-glue.js（P3 2.4 第二阶段，只搬不改）。
  const routeGlue = createRouteGlue({
    ctx,
    TAG,
    getConfig: () => CONFIG,
    getState: () => state,
    setConfig: (next) => { CONFIG = next; },
    writeSettingsPatch: (...args) => writeSettingsPatch(...args),
    packageUrl: import.meta.url,
    resolveConfig: () => resolveConfig(),
    // 设置页「表情包」卡片的状态与重建走 HTTP 路由（见 gateway/routes-sticker.js）。
    sticker: stickerApi,
    // 卡片上要显示图库根目录：由这里带下去，免得路由层自己 import session/。
    qqMsgRootSync,
  });
  const { qqBind } = routeGlue;

  const enforceGateEdit = async () => {
    const conf = (CONFIG.flowAuth !== undefined && CONFIG.flowAuth !== null) ? CONFIG.flowAuth : {};
    const next = Array.isArray(conf.gatedTools) ? conf.gatedTools.map((item) => String(item)) : [];
    const nextEnabled = conf.enabled === true;
    const decision = decideGateEdit({
      previousEnabled: lastFlowEnabled,
      nextEnabled,
      previous: lastGatedTools,
      next,
      previousSecurity: lastFlowSecurity,
      nextSecurity: securitySnapshot(conf),
      code: conf.gateEditCode,
      gateState,
      nowMs: Date.now(),
    });
    if (decision.accept !== true) {
      // 关掉闸门与改名单一样要码：连开关一起回滚，否则「先关、改名单、再开」就绕过去了。
      // 回滚必须连保护面一起：只回名单不回 totpSecret，攻击者换掉的那把锁就留在配置里了。
      const reverted = await writeSettingsPatch({
        flowAuth: Object.assign({}, lastFlowSecurity, {
          enabled: lastFlowEnabled,
          gatedTools: lastGatedTools,
          gateEditCode: '',
        }),
      });
      CONFIG = resolveConfig();
      console.log(TAG + ' 闸门名单改动被拒（' + decision.reason + '）：需要一次有效的 6 位动态码'
        + (reverted.ok === true ? '；已回滚' : '；回滚失败：' + reverted.error));
      return;
    }
    lastGatedTools = next;
    lastFlowEnabled = nextEnabled;
    lastFlowSecurity = securitySnapshot(conf);
    if (decision.clearCode !== true) return;
    // 码是改名单用的一次性凭据，不得留在配置里。
    const cleared = await writeSettingsPatch({ flowAuth: { gateEditCode: '' } });
    if (cleared.ok === true) CONFIG = resolveConfig();
    else console.log(TAG + ' 清空闸门动态码失败：' + cleared.error);
  };

  // 配置热更新：cordis-plugin-loader 在 volatile 字段变化时不会重挂插件，只就地更新
  // 引用并发 'loader/volatile-update'（只有普通字段变化才会重挂，而本插件的可编辑字段
  // 全是 volatile）。所以这里自己刷新 CONFIG。
  // 只有「连接方式」那几项需要重启适配器；其它改动下一轮消息自然生效。
  let lastTransport = transportKey(CONFIG);
  const onVolatileUpdate = () => {
    try {
      CONFIG = resolveConfig();
      void enforceGateEdit();
      scheduleProactive();
      scheduleStaleCleanup(300);
      const next = transportKey(CONFIG);
      if (next === lastTransport) return;
      lastTransport = next;
      console.log(TAG + ' 连接配置已更新，重启适配器');
      // 等旧适配器真的退出再起新的：只隔 250ms 会让旧进程还在 graceMs 里，
      // 两个适配器同连一个端（重复回合），反向模式的新进程还会 EADDRINUSE 卡死。
      void stopAdapter().then(() => {
        state.restarts = 0;
        try { ctx.timeout(() => { spawnAdapter(); }, 250); } catch { /* 已卸载 */ }
      });
    } catch (error) {
      console.error(TAG + ' 应用设置变更失败：' + describeError(error));
    }
  };
  try {
    ctx.on('loader/volatile-update', onVolatileUpdate);
  } catch (error) {
    console.log(TAG + ' 未能监听配置热更新（不影响运行）：' + describeError(error));
  }

  // -------------------------------------------------------------- 生命周期
  ctx.effect(() => () => {
    state.stopping = true;
    stopProactive();
    stopAdapter();
    for (const pair of state.convos) {
      const entry = pair[1];
      if (entry.agent !== null && typeof entry.agent.cancel === 'function') {
        try { entry.agent.cancel({ kind: 'disposed' }); } catch { /* 交给卸载流程 */ }
      }
    }
    console.log(TAG + ' 已停止');
  });

  // 启动时把模型接口探出来：用户一眼看到 /model 走的是哪条路（native / 只读 / 无）。
  try {
    const modelKind = modelRouter.detect().kind;
    console.log(TAG + ' 模型接口：' + (modelKind === 'agent-default-model' ? 'DSH 原生 agentDefaultModel（可切换）'
      : modelKind === 'llm-readonly' ? 'DSH llm（只读列举）' : '未检测到（/model 只能记录偏好）'));
  } catch (error) { console.log(TAG + ' 模型接口探测失败（忽略）：' + describeError(error)); }

  // 启动时把授权闸门状态写进日志：开了但没配密钥属于「开了却不生效」，必须一眼看见。
  if (flowEnabled()) {
    const secretReady = String((CONFIG.flowAuth && CONFIG.flowAuth.totpSecret) || '').trim() !== '';
    console.log(TAG + ' 流程授权已开启：' + (secretReady ? '密钥已配置' : '⚠️ 还没配 TOTP 密钥（node lib/valve/security/totp-cli.mjs enroll）')
      + ' | 需要授权的工具=' + ((Array.isArray(CONFIG.flowAuth.gatedTools) ? CONFIG.flowAuth.gatedTools.join(',') : '') || '（空）')
      + ' | 产物投递=' + String((CONFIG.flow && CONFIG.flow.deliver) || 'private'));
  }
  const wsInfo = await ensureQqMsgWorkspace();
  console.log(TAG + ' 启动中：' + (CONFIG.protocol !== 'onebot11' ? CONFIG.protocol + ' / ' : '') + CONFIG.mode + ' 模式'
    + (CONFIG.mode === 'reverse' ? ' listen=' + CONFIG.onebot.listen : ' ws=' + CONFIG.onebot.wsUrl)
    + ' | 群=' + (CONFIG.group.enabled ? (CONFIG.group.requireAt ? '仅@' : '全部') : '关')
    + ' | 私聊=' + (CONFIG.private.enabled ? '开' : '关')
    + ' | 工作区=' + qqMsgRootSync()
    + (wsInfo.id !== null ? ' | 分组=QQ_msg（已注册）' : ' | 分组=不可用（会话回退 cwd）'));
  spawnAdapter();
  scheduleProactive();
  scheduleImageSweep();
}
