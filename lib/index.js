/**
 * dsh-qq-bot —— 把 QQ 接到 DSH Agent 的 Cordis 插件（Host 侧）
 *
 *   QQ -> NapCat（OneBot 11）-> 本插件自带的 onebot-adapter -> DSH Agent -> 回复回 QQ
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
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { promises as fsPromises, mkdirSync } from 'node:fs';
import Schema from '@deepseek-ai/schemastery';

export const name = 'dsh-qq-bot';
// attachments / llm：图片视觉用（把 QQ 图片注册成 DSH image 块并探测模型能力）。
// 两者都由 dsh-base 恒常挂载（attachment-local 与 dsh-llm），声明为硬依赖。
export const inject = ['subprocess', 'sessionController', 'timer', 'attachments', 'llm'];

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLED_ADAPTER = join(HERE, 'onebot-adapter.mjs');

// —— 工作区根（QQ_msg）：读取 DSH 官方默认 Workspace 位置（<系统 Documents>/deepseek-harness），
// 在它的同级目录建 QQ_msg 作为本插件的全局工作区根；每个 QQ 会话一个子目录。
// Documents 解析复刻 @deepseek-ai/dsh-api-workspace-controller 的平台命令；Linux 上
// xdg-user-dir 在无独立 Documents 目录时回退到主目录，这里同样按返回值采用（即
// 建在 <主目录>/deepseek-harness/QQ_msg，仍与官方 default-workspace 严格同级）。
let qqMsgRootValue = null;
// 已解析/注册的 QQ_msg 工作区（DSH workspace 分组）；id 为 null 表示该 DSH 无 workspace 服务，回退 cwd。
let qqWorkspaceValue = null;
function qqMsgRootSync() {
  if (qqMsgRootValue !== null) return qqMsgRootValue;
  const root = join(resolveDocumentsDir(), 'deepseek-harness', 'QQ_msg');
  try { mkdirSync(root, { recursive: true }); } catch { /* 目录不可建时不阻塞插件 */ }
  qqMsgRootValue = root;
  return root;
}
function sessionWorkdir(sessionId) {
  return join(qqMsgRootSync(), String(sessionId));
}
function resolveDocumentsDir() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments, [Environment+SpecialFolderOption]::DoNotVerify)"],
        { encoding: 'utf8', timeout: 15000, windowsHide: true });
      const dir = out.replace(/[\r\n]+$/, '').trim();
      if (dir !== '') return dir;
    } else if (process.platform === 'darwin') {
      const out = execFileSync('osascript', ['-e', 'POSIX path of (path to documents folder from user domain without folder creation)'],
        { encoding: 'utf8', timeout: 15000 });
      const dir = out.replace(/[\r\n]+$/, '').trim();
      if (dir !== '') return dir;
    } else {
      const out = execFileSync('xdg-user-dir', ['DOCUMENTS'], { encoding: 'utf8', timeout: 10000 });
      const dir = out.replace(/[\r\n]+$/, '').trim();
      if (dir !== '') return dir;
    }
  } catch (error) { /* 平台命令不可用则走回退 */ }
  return join(homedir(), 'Documents');
}

const DEFAULTS = {
  // 留空 = 用包内自带的 lib/onebot-adapter.mjs
  adapterPath: '',
  // 留空 = 启动时用 subprocess.resolveExecutable('node') 解析
  nodePath: '',

  // 'forward'：我们连 NapCat（同机/同容器最简单）
  // 'reverse'：NapCat 连我们（跨容器/跨网络更好用）
  mode: 'forward',
  onebot: {
    wsUrl: 'ws://127.0.0.1:3001',      // mode=forward
    listen: '0.0.0.0:6199',            // mode=reverse
    httpUrl: 'http://127.0.0.1:3000',  // 留空则改用 WS action 发消息
    accessToken: '',
  },

  // 群聊：默认只在被 @ 时响应；allow 为空数组 = 所有群
  group: { enabled: true, allow: [], requireAt: true },
  // 私聊：allow 为空数组 = 所有人
  private: { enabled: true, allow: [] },

  // 例如 '/ai'；空字符串 = 不限制
  commandPrefix: '',

  reply: {
    maxChars: 1200,
    ackAfterMs: 8000,
    ackText: '正在处理，请稍候…',
    firstTurnHint: '（提示：这是一次 QQ 聊天。请用简体中文、简洁自然的口语作答；'
      + '不要输出 Markdown 表格，代码块保持简短。）',
    contextHeader: true,
  },

  // 群管理。方案 A = Agent 工具（qqgroup），方案 B = QQ 侧管理员指令。
  // 安全默认：operators 为空 => 谁都不能做管理操作，必须显式授权。
  // 权限：三路并行取并集（静态名单 / 动态授权 / 本群身份），另加拥有者的路由特权。
  auth: {
    owners: [],               // 拥有者 QQ 号：全部权限 + 永久授权 + 可走独立的拥有者会话
    superAdmins: [],          // 后台设定的高级管理员：群管理权限（不可永久授权）
    ownerPreset: '',          // 拥有者会话用的 agent preset（留空则不分流）
    guestPreset: '',          // 非拥有者会话用的 agent preset（留空则与拥有者共用）
    grantTtlMinutes: 60,      // 群管理员动态授权的默认时长（分钟）
    grantMaxTtlMinutes: 1440, // 群管理员单次可授的最长时长（分钟）
    // 非拥有者的工具闸：默认禁止访客使用 DSH 内部工具（bash/读写/子代理/…）。
    // 用白名单而不是黑名单——例如 run_code（PTC 保留传输）不在名单里就自动被挡。
    guestToolAllow: ['qqbot', 'qqgroup'],  // 访客仍可用的工具（这两个自带鉴权）
    guestDshTools: false,     // 若确实想让访客也能用 DSH 工具，改成 true
  },
  admin: {
    enabled: true,
    manageGroups: [],        // 可管理的群号；空 = 回退用 group.allow（再空 = 不限制到群）
    requireGroupAdmin: true, // 是否承认「本群管理员」这一路权限
    prefix: '/',            // QQ 侧指令前缀（必须位于消息首位）
    dryRun: false,           // true = 只回复「将执行什么」，不真执行
    allowConsole: false,     // 是否允许非 QQ 来源（如 Web UI 会话）调用管理工具
  },

  perChatSession: true,
  agentPreset: '',
  restart: { baseMs: 1000, maxMs: 30000 },
  logAdapterFrames: false,

  // 图片视觉：QQ 收到图片时，下载图片并用 DSH 已配置的视觉模型做图片理解，
  // 把识别结果并入 Agent 的输入。不新增 baseURL/apiKeyEnv——模型、协议、
  // baseURL、API key 全部沿用 DSH 里原本填写的自定义 providers（如你的自定义 provider）。
  // provider/model 都留空 = 用会话当前模型；模型不支持图片时给出可读报错，
  // 引导用户到插件设置里切换支持视觉的模型（如 deepseek-v4-flash-vision-exp）。
  // 注意：deepseek-v4-flash-0731 实测不真正支持图片（返回空/假装看图），
  // 请在 DSH 的 llm-pi-ai providers 里把视觉模型声明为 input: [text, image]。
  vision: {
    enabled: true,            // 关闭则图片保持 [图片] 占位符
    provider: '',             // 视觉 provider 路由（留空 = 会话模型）
    model: '',                // 视觉模型 id（留空 = 会话模型）
    maxImages: 3,             // 单条消息最多送入的图片数
    downloadTimeoutMs: 10000, // 图片下载超时（毫秒）
  },
};

// -------------------------------------------------------------- 配置契约
// 只有 volatile 字段能被「设置」页改（settings 服务会校验 isVolatilePath），
// 所以凡是出现在设置界面里的字段都必须标 .volatile()。adapterPath / nodePath /
// restart / reply.firstTurnHint 不在界面上，故意保持普通字段：改它们会走
// 「整体重挂插件」这条更稳的路径。
export const Config = Schema.object({
  adapterPath: Schema.string().default('').description('OneBot 适配器脚本路径（留空 = 用包内自带）'),
  nodePath: Schema.string().default('').description('node 可执行文件（留空 = 自动解析）'),

  mode: Schema.union([Schema.const('forward'), Schema.const('reverse')]).default('forward').volatile()
    .description('连接方式：forward = DSH 连 NapCat；reverse = NapCat 连 DSH'),
  onebot: Schema.object({
    wsUrl: Schema.string().default('ws://127.0.0.1:3001').volatile().description('正向 WebSocket 地址'),
    listen: Schema.string().default('0.0.0.0:6199').volatile().description('反向 WebSocket 监听地址'),
    httpUrl: Schema.string().default('http://127.0.0.1:3000').volatile().description('HTTP API 地址（留空 = 改用 WS action 发送）'),
    accessToken: Schema.string().default('').role('secret').volatile().description('NapCat 的 access_token（只写字段）'),
  }),

  group: Schema.object({
    enabled: Schema.boolean().default(true).volatile().description('启用群聊'),
    allow: Schema.array(Schema.string()).default([]).volatile().description('群号白名单（空 = 所有群）'),
    requireAt: Schema.boolean().default(true).volatile().description('群里必须 @ 机器人才回复'),
  }),
  private: Schema.object({
    enabled: Schema.boolean().default(true).volatile().description('启用私聊'),
    allow: Schema.array(Schema.string()).default([]).volatile().description('私聊白名单（空 = 所有人）'),
  }),

  commandPrefix: Schema.string().default('').volatile().description('命令前缀（空 = 不限制）'),

  reply: Schema.object({
    maxChars: Schema.number().default(1200).volatile().description('单条消息最大字数'),
    ackAfterMs: Schema.number().default(8000).volatile().description('慢回复提示阈值（毫秒，0 = 关闭）'),
    ackText: Schema.string().default('正在处理，请稍候…').volatile().description('慢回复提示文案'),
    firstTurnHint: Schema.string().default(DEFAULTS.reply.firstTurnHint).description('首轮提示词'),
    contextHeader: Schema.boolean().default(true).volatile().description('消息附带来源前缀'),
  }),

  auth: Schema.object({
    owners: Schema.array(Schema.string()).default([]).volatile().description('拥有者 QQ 号'),
    superAdmins: Schema.array(Schema.string()).default([]).volatile().description('高级管理员 QQ 号'),
    ownerPreset: Schema.string().default('').volatile().description('拥有者会话的 agent preset（空 = 不分流）'),
    guestPreset: Schema.string().default('').volatile().description('非拥有者会话的 agent preset（空 = 与拥有者共用）'),
    grantTtlMinutes: Schema.number().default(60).volatile().description('动态授权默认时长（分钟）'),
    grantMaxTtlMinutes: Schema.number().default(1440).volatile().description('群管理员单次可授最长时长（分钟）'),
    guestToolAllow: Schema.array(Schema.string()).default(['qqbot', 'qqgroup']).volatile().description('访客仍可用的工具白名单'),
    guestDshTools: Schema.boolean().default(false).volatile().description('允许非拥有者使用 DSH 内部工具'),
  }),

  admin: Schema.object({
    enabled: Schema.boolean().default(true).volatile().description('启用群管理（指令 + qqgroup 工具）'),
    manageGroups: Schema.array(Schema.string()).default([]).volatile().description('可管理的群号（空 = 回退群号白名单）'),
    requireGroupAdmin: Schema.boolean().default(true).volatile().description('承认「本群管理员」这一路权限'),
    prefix: Schema.string().default('/').volatile().description('指令前缀（必须在消息首位）'),
    dryRun: Schema.boolean().default(false).volatile().description('演练模式：只回复将执行什么'),
    allowConsole: Schema.boolean().default(false).volatile().description('允许非 QQ 来源调用管理工具'),
  }),

  perChatSession: Schema.boolean().default(true).volatile().description('每个 QQ 会话一个独立 DSH 会话'),
  agentPreset: Schema.string().default('').volatile().description('Agent preset（空 = 部署默认）'),
  logAdapterFrames: Schema.boolean().default(false).volatile().description('日志打印适配器每一帧（排错）'),

  vision: Schema.object({
    enabled: Schema.boolean().default(true).volatile().description('图片视觉：QQ 收到图片时用视觉模型识别并并入回复'),
    provider: Schema.string().default('').volatile().description('视觉 provider 路由（留空 = 会话模型；复用 DSH 自定义 providers）'),
    model: Schema.string().default('').volatile().description('视觉模型 id（留空 = 会话模型；如 deepseek-v4-flash-vision-exp）'),
    maxImages: Schema.number().default(3).volatile().description('单条消息最多送入的图片数'),
    downloadTimeoutMs: Schema.number().default(10000).volatile().description('图片下载超时（毫秒）'),
  }),

  restart: Schema.object({
    baseMs: Schema.number().default(1000),
    maxMs: Schema.number().default(30000),
  }),
}).description('把 QQ 接到 DSH Agent（NapCat / OneBot 11）');

// cordis 的配置引用标记（cosmokit 的共享 symbol），用于把 volatile 字段还原成普通值。
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');
const isVolatileRef = (value) => typeof value === 'object' && value !== null && VOLATILE_WRITE in value;

/** 把（可能含 volatile 引用的）已解析配置还原成普通对象。 */
function plainConfig(value) {
  if (isVolatileRef(value)) return plainConfig(value.get());
  if (Array.isArray(value)) return value.map(plainConfig);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = plainConfig(value[key]);
    return out;
  }
  return value;
}

/** 只递归合并普通对象；数组/标量直接覆盖 */
function mergeConfig(base, override) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  if (override === null || typeof override !== 'object' || Array.isArray(override)) return override === undefined ? out : override;
  for (const key of Object.keys(override)) {
    const value = override[key];
    if (value === undefined) continue;
    const current = out[key];
    if (current !== null && typeof current === 'object' && !Array.isArray(current)
      && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = mergeConfig(current, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

const describeError = (error) => (error === null || error === undefined) ? String(error)
  : (typeof error === 'string' ? error : (typeof error.message === 'string' ? error.message : String(error)));
const describeErrorStatic = describeError;

export async function apply(ctx, rawConfig) {
  const TAG = '[dsh-qq-bot]';
  const subprocess = ctx.subprocess;
  const sessionController = ctx.sessionController;

  // DSH 交给插件的已经是「按 Config schema 求值过」的配置：composition 行配置、
  // profile 的 cordis.patch.yml、schema 默认值三层已经合并完。volatile 字段是引用
  // （要 .get()），这里还原成普通对象；CONFIG 是个 let，热更新时整体刷新。
  const resolveConfig = () => mergeConfig(DEFAULTS, plainConfig(rawConfig ?? {}));
  let CONFIG = resolveConfig();

  // 本插件自带「设置 → QQ 机器人」选项卡，所以不要 DSH 再按 schema 自动生成一个。
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
    console.log(TAG + ' 未能声明设置页归属（不影响运行）：' + describeErrorStatic(error));
  }

  // 只关心影响「连接方式」的那几项：变了才重启适配器。
  const transportKey = (cfg) => JSON.stringify([cfg.mode, cfg.onebot.wsUrl, cfg.onebot.listen, cfg.onebot.httpUrl, cfg.onebot.accessToken]);

  // 工作区根（QQ_msg）不依赖 CONFIG：模块级 qqMsgRootSync() 解析一次即缓存。
  // 适配器路径依赖 CONFIG（会被热更新整体替换），所以用取值函数而不是快照常量。
  const currentAdapterPath = () => (CONFIG.adapterPath !== '' ? CONFIG.adapterPath : BUNDLED_ADAPTER);

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
    adapterPid: null, listenPort: null,
    convos: new Map(),
      stats: { inbound: 0, accepted: 0, skipped: 0, replies: 0, chunks: 0, errors: 0, admin: 0, actions: 0, notices: 0, guestBlocked: 0 },
      // 动作请求/响应关联：{ echo -> resolve }
      pending: new Map(),
      actionSeq: 0,
  };

  let nodePath = CONFIG.nodePath;
  if (nodePath === '') {
    nodePath = process.execPath;
    try { nodePath = await subprocess.resolveExecutable('node'); }
    catch (error) { console.log(TAG + ' 未能解析 node，改用 ' + nodePath); }
  }

  // -------------------------------------------------------------- 适配器监管
  let handle = null;
  let stdoutBuffer = '';
  const stdoutDecoder = new TextDecoder();
  const stderrDecoder = new TextDecoder();

  function adapterArgv() {
    const args = [nodePath, currentAdapterPath()];
    if (CONFIG.mode === 'reverse') args.push('--listen', String(CONFIG.onebot.listen));
    else args.push('--ws', String(CONFIG.onebot.wsUrl));
    if (CONFIG.onebot.httpUrl !== '') args.push('--http', String(CONFIG.onebot.httpUrl));
    if (CONFIG.onebot.accessToken !== '') args.push('--token', String(CONFIG.onebot.accessToken));
    return args;
  }

  function writeToAdapter(frame) {
    if (handle === null) return false;
    const sink = handle.stdin;
    if (sink === null || sink === undefined || typeof sink.write !== 'function') return false;
    try { sink.write(JSON.stringify(frame) + '\n'); return true; }
    catch (error) {
      state.stats.errors += 1;
      console.error(TAG + ' 写适配器 stdin 失败：' + describeError(error));
      return false;
    }
  }

    /**
     * 通过适配器执行任意 OneBot 11 动作，并等待带 echo 的 action_result。
     * 群管理、查询都走这里；超时会给出明确错误而不是挂死。
     */
    function callAdapterAction(action, params, timeoutMs) {
      return new Promise((resolve) => {
        if (handle === null) { resolve({ ok: false, error: '适配器未运行' }); return; }
        const echo = 'act-' + (++state.actionSeq) + '-' + Date.now();
        const cancel = ctx.timeout(() => {
          if (state.pending.delete(echo)) resolve({ ok: false, error: '动作超时：' + action });
        }, (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : 12000);
        state.pending.set(echo, (result) => {
          if (typeof cancel === 'function') cancel();
          resolve(result);
        });
        const written = writeToAdapter({ type: 'action', action, params, echo });
        if (written !== true) {
          state.pending.delete(echo);
          if (typeof cancel === 'function') cancel();
          resolve({ ok: false, error: '无法把动作写到适配器' });
        }
      });
    }

  function scheduleRestart() {
    if (state.stopping) return;
    state.restarts += 1;
    const delay = Math.min(CONFIG.restart.baseMs * Math.pow(2, Math.min(state.restarts, 5)), CONFIG.restart.maxMs);
    console.error(TAG + ' 适配器将在 ' + delay + 'ms 后重启');
    try { ctx.timeout(() => { spawnAdapter(); }, delay); }
    catch (error) { console.error(TAG + ' 无法安排重启：' + describeError(error)); }
  }

  function spawnAdapter() {
    if (state.stopping) return;
    let proc;
    try {
      proc = subprocess.spawn({
        argv: adapterArgv(),
        cwd: qqMsgRootSync(),
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 3000,
      });
    } catch (error) {
      state.stats.errors += 1;
      console.error(TAG + ' 启动适配器失败：' + describeError(error));
      scheduleRestart();
      return;
    }
    handle = proc;
    stdoutBuffer = '';
    console.log(TAG + ' 适配器已启动（' + CONFIG.mode + ' 模式）');

    if (proc.stdout !== null && proc.stdout !== undefined) {
      proc.stdout.on('data', (chunk) => {
        stdoutBuffer += stdoutDecoder.decode(chunk, { stream: true });
        let index;
        while ((index = stdoutBuffer.indexOf('\n')) >= 0) {
          const line = stdoutBuffer.slice(0, index).trim();
          stdoutBuffer = stdoutBuffer.slice(index + 1);
          if (line === '') continue;
          let frame;
          try { frame = JSON.parse(line); }
          catch { console.error(TAG + ' 适配器输出了非 JSON：' + line.slice(0, 240)); continue; }
          try { onAdapterFrame(frame); }
          catch (error) { state.stats.errors += 1; console.error(TAG + ' 帧处理失败：' + describeError(error)); }
        }
      });
    } else {
      console.error(TAG + ' 适配器 stdout 不可用，收不到 QQ 消息');
    }

    if (proc.stderr !== null && proc.stderr !== undefined) {
      proc.stderr.on('data', (chunk) => {
        const text = stderrDecoder.decode(chunk, { stream: true }).trim();
        if (text !== '') console.error(TAG + '/adapter ' + text);
      });
    }

    const onSettled = (label) => {
      if (handle === proc) handle = null;
      state.connected = false;
      state.statusReason = label;
      console.error(TAG + ' 适配器已退出（' + label + '）');
      scheduleRestart();
    };
    proc.done.then(
      (outcome) => onSettled('退出码 ' + String(outcome === null || outcome === undefined ? '?' : outcome.exitCode)),
      (error) => onSettled('失败：' + describeError(error)),
    );
  }

  function stopAdapter() {
    if (handle === null) return;
    const proc = handle;
    try { writeToAdapter({ type: 'shutdown' }); } catch { /* 正在退出 */ }
    handle = null;
    state.connected = false;
    try { proc.terminate(); }
    catch (error) { console.error(TAG + ' 终止适配器失败：' + describeError(error)); }
  }

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
      state.statusReason = typeof frame.reason === 'string' ? frame.reason : '';
      console.log(TAG + ' OneBot ' + (state.connected ? '已连接' : '未连接')
        + (state.statusReason === '' ? '' : '（' + state.statusReason + '）'));
    } else if (frame.type === 'message') {
      state.stats.inbound += 1;
      void acceptMessage(frame);
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

  const toId = (value) => (/^\d+$/.test(String(value)) ? Number(value) : String(value));

  const PERMISSION_LIST = ['query', 'mute', 'kick', 'recall', 'settings', 'grant'];
  const PERMISSION_LABEL = {
    query: '查询群/成员',
    mute: '禁言/解禁',
    kick: '移出成员',
    recall: '撤回消息',
    settings: '群名/名片/管理员/全员禁言',
    grant: '给本群成员临时授权',
    permanent: '永久授权',
  };

  const sameId = (list, value) => Array.isArray(list) && list.some((item) => String(item) === String(value));
  const isOwner = (userId) => sameId(CONFIG.auth.owners, userId);
  const isSuperAdmin = (userId) => sameId(CONFIG.auth.superAdmins, userId);

  // 动态授权表：key = "群号|QQ" -> { groupId, userId, perms:Set, expiresAt, by, permanent }
  const grants = new Map();
  const grantKey = (groupId, userId) => String(groupId) + '|' + String(userId);

  function activeGrant(groupId, userId) {
    if (groupId === null || groupId === undefined) return null;
    const key = grantKey(groupId, userId);
    const record = grants.get(key);
    if (record === undefined) return null;
    if (record.expiresAt !== null && record.expiresAt <= Date.now()) { grants.delete(key); return null; }
    return record;
  }

  function grantRows() {
    const rows = [];
    for (const key of [...grants.keys()]) {
      const record = grants.get(key);
      if (record.expiresAt !== null && record.expiresAt <= Date.now()) { grants.delete(key); continue; }
      rows.push(record);
    }
    return rows;
  }

  function formatGrant(record) {
    const left = record.expiresAt === null ? '永久' : ('至 ' + new Date(record.expiresAt).toLocaleString('zh-CN', { hour12: false }));
    return String(record.userId) + '：' + [...record.perms].join('/') + '（' + left + '，by ' + String(record.by) + '）';
  }

  function manageableGroups() {
    const admin = CONFIG.admin;
    if (Array.isArray(admin.manageGroups) && admin.manageGroups.length > 0) return admin.manageGroups;
    if (Array.isArray(CONFIG.group.allow) && CONFIG.group.allow.length > 0) return CONFIG.group.allow;
    return null;
  }

  function groupInScope(groupId) {
    const scope = manageableGroups();
    if (scope === null) return true;
    return scope.some((id) => String(id) === String(groupId));
  }

  function entryForAgent(agent) {
    if (agent === null || agent === undefined) return null;
    for (const pair of state.convos) if (pair[1].agent === agent) return pair[1];
    return null;
  }

  /** 查某人在群里的角色（admin / owner / member）；失败返回 null。 */
  async function memberRole(groupId, userId) {
    const result = await callAdapterAction('get_group_member_info', {
      group_id: toId(groupId), user_id: toId(userId), no_cache: true,
    });
    if (result === null || result.ok !== true) return null;
    const data = result.data;
    if (data === null || typeof data !== 'object') return null;
    return typeof data.role === 'string' ? data.role : null;
  }

  /**
   * 三路并行求并集。群管理员与动态授权都是群维度的：换个群就不生效。
   * @returns {{tier:string, owner:boolean, userId:string, groupId:string|null, perms:Set<string>, sources:string[]}}
   */
  async function resolveAuthority(userId, groupId) {
    const authority = {
      tier: 'guest', owner: false,
      userId: String(userId),
      groupId: (groupId === null || groupId === undefined) ? null : String(groupId),
      perms: new Set(),
      sources: [],
    };

    // 路由 1：静态名单
    if (isOwner(authority.userId)) {
      authority.owner = true;
      authority.tier = 'owner';
      for (const perm of PERMISSION_LIST) authority.perms.add(perm);
      authority.perms.add('permanent');
      authority.sources.push('拥有者');
    } else if (isSuperAdmin(authority.userId)) {
      authority.tier = 'super';
      for (const perm of PERMISSION_LIST) authority.perms.add(perm);
      authority.sources.push('后台高级管理员');
    }

    // 路由 2：动态授权（只认本群）
    const grant = activeGrant(authority.groupId, authority.userId);
    if (grant !== null) {
      for (const perm of grant.perms) authority.perms.add(perm);
      authority.sources.push('动态授权[' + [...grant.perms].join('/') + ' '
        + (grant.expiresAt === null ? '永久' : ('至 ' + new Date(grant.expiresAt).toLocaleString('zh-CN', { hour12: false }))) + ']');
      if (authority.tier === 'guest') authority.tier = 'granted';
    }

    // 路由 3：本群身份
    if (authority.groupId !== null && CONFIG.admin.requireGroupAdmin === true) {
      const role = await memberRole(authority.groupId, authority.userId);
      if (role === 'admin' || role === 'owner') {
        for (const perm of PERMISSION_LIST) authority.perms.add(perm);
        authority.sources.push(role === 'owner' ? '本群群主' : '本群管理员');
        if (authority.tier === 'guest') authority.tier = 'group-admin';
      }
    }

    // 群范围闸：不在可管理范围就整体清空
    if (authority.groupId !== null && !groupInScope(authority.groupId)) {
      authority.perms.clear();
      authority.sources.push('（该群不在可管理范围）');
    }
    return authority;
  }

  const TIER_LABEL = { owner: '拥有者', super: '高级管理员', 'group-admin': '本群管理员', granted: '已授权', guest: '访客' };
  const hasPerm = (authority, perm) => authority !== null && authority !== undefined
    && (authority.owner === true || authority.perms.has(perm));

  function describeAuthority(authority) {
    const perms = [...authority.perms];
    return '身份：' + (TIER_LABEL[authority.tier] === undefined ? authority.tier : TIER_LABEL[authority.tier])
      + (authority.sources.length === 0 ? '' : '（' + authority.sources.join(' + ') + '）')
      + '\n权限：' + (perms.length === 0 ? '无' : perms.map((p) => (PERMISSION_LABEL[p] === undefined ? p : PERMISSION_LABEL[p])).join('、'));
  }

  // ---- 会话路由：拥有者 / 非拥有者分开（只有配了 preset 才真的分）----
  function sessionRoute(frame) {
    const isGroup = frame.message_type === 'group';
    const chatId = isGroup ? frame.group_id : frame.user_id;
    const scope = (isGroup ? 'group-' : 'private-') + String(chatId);
    const owner = isOwner(frame.user_id);
    const split = CONFIG.auth.ownerPreset !== '' || CONFIG.auth.guestPreset !== '';
    if (!split) {
      return { entryKey: scope, sessionId: 'qqbot-' + scope, preset: CONFIG.agentPreset, tier: owner ? 'owner' : 'guest' };
    }
    const tier = owner ? 'owner' : 'guest';
    return {
      entryKey: scope + '@' + tier,
      sessionId: 'qqbot-' + scope + (owner ? '' : '-guest'),
      preset: owner ? CONFIG.auth.ownerPreset : CONFIG.auth.guestPreset,
      tier,
    };
  }

  // ---- 指令表与严格参数 ----
  // 每个指令声明 [最少 token, 最多 token]：多余内容一律判为用法错误、不执行，
  // 避免「聊天里夹带指令样内容」被误执行。
  const COMMAND_ARITY = {
    help: [1, 1], whoami: [1, 1], perms: [1, 2],
    mute: [2, 3], unmute: [2, 2], kick: [2, 2], banall: [2, 2],
    card: [3, Infinity], admin: [3, 3], recall: [1, 2], rename: [2, Infinity],
    members: [1, 1], info: [1, 1], grants: [1, 1],
    grant: [3, 4], revoke: [2, 3],
  };
  const ADMIN_USAGE = {
    help: '/help                     列出全部指令',
    whoami: '/whoami                  看我在此群的权限',
    perms: '/perms [@某人]            看某人在此群的权限（三路来源）',
    mute: '/mute @某人 [分钟=10]      禁言（0 = 解禁）',
    unmute: '/unmute @某人            解除禁言',
    kick: '/kick @某人               移出本群',
    banall: '/banall on|off           全员禁言开关',
    card: '/card @某人 新名片        改群名片',
    admin: '/admin @某人 on|off      设/撤管理员',
    recall: '/recall [消息id]         撤回（回复某条消息时可直接省略 id）',
    rename: '/rename 新群名           改群名',
    members: '/members                成员列表',
    info: '/info                   群信息',
    grant: '/grant @某人 权限[,权限] [分钟|forever]   临时授权（仅本群）',
    revoke: '/revoke @某人 [权限]     撤销授权',
    grants: '/grants                 列出本群的动态授权',
  };
  const ADMIN_VERBS = Object.keys(ADMIN_USAGE);

  /** 从 @123 或纯数字里取 QQ 号。 */
  function pickTarget(parts, index) {
    const token = parts[index];
    if (token === undefined) return null;
    const at = /@(\d+)/.exec(token);
    if (at !== null) return at[1];
    if (/^\d+$/.test(token)) return token;
    return null;
  }

  /**
   * 把一条指令解析成动作。返回：
   *   { action, params, describe, format? }  要执行的 OneBot 动作
   *   { local: true, reply }                本地处理（授权表增删改、查看）
   *   { error }                             参数有误
   *   null                                  用法错误
   */
  function planAdminCommand(verb, parts, frame, authority) {
    const groupId = frame.message_type === 'group' ? String(frame.group_id) : null;

    if (verb === 'help') {
      return { local: true, reply: '可用指令：\n' + ADMIN_VERBS.map((v) => ADMIN_USAGE[v]).join('\n') };
    }
    if (verb === 'whoami') {
      return { local: true, reply: describeAuthority(authority) };
    }
    if (verb === 'perms') {
      const target = parts[1] === undefined ? authority.userId : pickTarget(parts, 1);
      if (target === null) return { error: '用法：' + ADMIN_USAGE.perms };
      return { local: true, pendingAuthorityFor: target, reply: '' };
    }
    if (verb === 'grants') {
      const rows = grantRows().filter((r) => r.groupId === groupId);
      return { local: true, reply: rows.length === 0 ? '本群暂无动态授权。' : ('本群动态授权：\n' + rows.map(formatGrant).join('\n')) };
    }
    if (verb === 'grant') {
      const target = pickTarget(parts, 1);
      if (target === null) return { error: '用法：' + ADMIN_USAGE.grant };
      const perms = String(parts[2] ?? '').toLowerCase().split(/[,，/]+/).filter((p) => p !== '');
      if (perms.length === 0) return { error: '用法：' + ADMIN_USAGE.grant };
      const unknown = perms.filter((p) => PERMISSION_LIST.indexOf(p) < 0);
      if (unknown.length > 0) return { error: '权限名无效：' + unknown.join('、') + '；可用：' + PERMISSION_LIST.join('/') };
      const ttlText = String(parts[3] ?? '').toLowerCase();
      let permanent = false;
      let minutes = CONFIG.auth.grantTtlMinutes;
      if (ttlText === 'forever' || ttlText === '永久' || ttlText === '0') {
        if (authority.owner !== true) return { error: '只有拥有者可以永久授权' };
        permanent = true;
      } else if (ttlText !== '') {
        const parsed = Number(ttlText);
        if (!Number.isFinite(parsed) || parsed <= 0) return { error: '时限必须是分钟数或 forever' };
        minutes = parsed;
      }
      if (permanent !== true) {
        const cap = authority.owner === true ? 525600 : CONFIG.auth.grantMaxTtlMinutes;
        minutes = Math.min(Math.max(1, Math.round(minutes)), cap);
      }
      return {
        local: true,
        grantAction: { groupId, target, perms, permanent, minutes, by: authority.userId },
        reply: '',
      };
    }
    if (verb === 'revoke') {
      const target = pickTarget(parts, 1);
      if (target === null) return { error: '用法：' + ADMIN_USAGE.revoke };
      const perms = parts[2] === undefined ? null : String(parts[2]).toLowerCase().split(/[,，/]+/).filter((p) => p !== '');
      return { local: true, revokeAction: { groupId, target, perms }, reply: '' };
    }

    // ---- 下面是需要调 OneBot 动作的指令 ----
    if (verb === 'mute' || verb === 'unmute') {
      const target = pickTarget(parts, 1);
      if (target === null) return { error: '用法：' + ADMIN_USAGE.mute };
      const minutes = verb === 'unmute' ? 0 : (parts[2] === undefined ? 10 : Number(parts[2]));
      if (!Number.isFinite(minutes) || minutes < 0) return { error: '分钟数无效' };
      const seconds = Math.min(Math.round(minutes * 60), 43200);
      return {
        action: 'set_group_ban', params: { group_id: toId(groupId), user_id: toId(target), duration: seconds },
        describe: (seconds === 0 ? '解除 ' : '禁言 ') + target + (seconds === 0 ? '' : ' ' + String(minutes) + ' 分钟'),
      };
    }
    if (verb === 'kick') {
      const target = pickTarget(parts, 1);
      if (target === null) return { error: '用法：' + ADMIN_USAGE.kick };
      return { action: 'set_group_kick', params: { group_id: toId(groupId), user_id: toId(target), reject_add_request: false }, describe: '把 ' + target + ' 移出本群' };
    }
    if (verb === 'banall') {
      const flag = String(parts[1]).toLowerCase();
      if (flag !== 'on' && flag !== 'off') return { error: '用法：' + ADMIN_USAGE.banall };
      return { action: 'set_group_whole_ban', params: { group_id: toId(groupId), enable: flag === 'on' }, describe: flag === 'on' ? '开启全员禁言' : '关闭全员禁言' };
    }
    if (verb === 'card') {
      const target = pickTarget(parts, 1);
      const card = parts.slice(2).join(' ').trim();
      if (target === null || card === '') return { error: '用法：' + ADMIN_USAGE.card };
      return { action: 'set_group_card', params: { group_id: toId(groupId), user_id: toId(target), card }, describe: '把 ' + target + ' 的群名片改成「' + card + '」' };
    }
    if (verb === 'admin') {
      const target = pickTarget(parts, 1);
      const flag = String(parts[2]).toLowerCase();
      if (target === null || (flag !== 'on' && flag !== 'off')) return { error: '用法：' + ADMIN_USAGE.admin };
      return {
        action: 'set_group_admin', params: { group_id: toId(groupId), user_id: toId(target), enable: flag === 'on' },
        describe: (flag === 'on' ? '把 ' + target + ' 设为管理员' : '撤销 ' + target + ' 的管理员'),
      };
    }
    if (verb === 'recall') {
      let messageId = null;
      if (parts[1] !== undefined) {
        if (!/^\d+$/.test(parts[1])) return { error: '用法：' + ADMIN_USAGE.recall };
        messageId = Number(parts[1]);
      } else if (frame.reply_to !== null && frame.reply_to !== undefined) {
        messageId = Number(frame.reply_to);
      }
      if (messageId === null || !Number.isFinite(messageId)) return { error: '请给消息 id，或回复要撤回的那条消息再发 /recall' };
      return { action: 'delete_msg', params: { message_id: messageId }, describe: '撤回消息 ' + String(messageId) };
    }
    if (verb === 'rename') {
      const name = parts.slice(1).join(' ').trim();
      if (name === '') return { error: '用法：' + ADMIN_USAGE.rename };
      return { action: 'set_group_name', params: { group_id: toId(groupId), group_name: name }, describe: '把群名改成「' + name + '」' };
    }
    if (verb === 'members') {
      return {
        action: 'get_group_member_list', params: { group_id: toId(groupId) },
        describe: '读取成员列表',
        format: (data) => {
          const rows = Array.isArray(data) ? data : [];
          const lines = rows.slice(0, 30).map((m) => (m.card || m.nickname || '') + '(' + String(m.user_id) + ') [' + String(m.role) + ']');
          return '成员 ' + String(rows.length) + ' 人：\n' + lines.join('\n') + (rows.length > 30 ? '\n…（只列前 30）' : '');
        },
      };
    }
    if (verb === 'info') {
      return {
        action: 'get_group_info', params: { group_id: toId(groupId) },
        describe: '读取群信息',
        format: (data) => (data !== null && typeof data === 'object')
          ? '群名：' + String(data.group_name ?? '') + '｜群号：' + String(data.group_id ?? '')
            + '｜成员：' + String(data.member_count ?? '?') + '/' + String(data.max_member_count ?? '?')
          : '（无数据）',
      };
    }
    return null;
  }

  /** 每个指令需要哪一项权限。 */
  const COMMAND_PERMISSION = {
    mute: 'mute', unmute: 'mute', kick: 'kick', recall: 'recall',
    banall: 'settings', card: 'settings', admin: 'settings', rename: 'settings',
    members: 'query', info: 'query', perms: 'query',
    grant: 'grant', revoke: 'grant', grants: 'grant',
    help: null, whoami: null,
  };

  /** 执行一个 OneBot 群管理动作并回执（支持 dry-run）。 */
  async function runGroupAction(frame, plan) {
    if (CONFIG.admin.dryRun === true) {
      sendReply(frame, '【演练，未执行】将执行 ' + String(plan.action) + '：' + plan.describe);
      return { ok: true, dryRun: true };
    }
    const result = await callAdapterAction(plan.action, plan.params);
    if (result.ok === true) {
      let extra = '';
      if (typeof plan.format === 'function') {
        try { extra = '\n' + plan.format(result.data); } catch (error) { extra = ''; }
      }
      sendReply(frame, '【已执行】' + plan.describe + extra);
      state.stats.admin += 1;
      return { ok: true, data: result.data };
    }
    sendReply(frame, '【失败】' + plan.describe + '：' + String(result.error === undefined ? '未知错误' : result.error));
    return { ok: false, error: result.error };
  }

  /**
   * QQ 侧指令（方案 B）。命中返回 true = 已处理，不再送给模型。
   *
   * 严格性（防「聊天内容夹带指令样内容」被误执行）：
   *   1. 前缀必须位于消息首位（前面只允许空白）；
   *   2. 动词必须完全匹配已知指令，未知动词照常交给模型；
   *   3. token 数量必须落在该指令的 [min,max] 内，多余内容判为用法错误、不执行；
   *   4. 权限不足直接拒绝，不做任何动作。
   * 刻意放在 requireAt 之前：发指令不该还需要 @ 机器人。
   */
  async function handleAdminCommand(frame, text) {
    const admin = CONFIG.admin;
    if (admin.enabled !== true) return false;
    const prefix = (typeof admin.prefix === 'string' && admin.prefix !== '') ? admin.prefix : '/';
    const trimmed = text.replace(/^[\s\u3000]+/, '');
    if (!trimmed.startsWith(prefix)) return false;
    const body = trimmed.slice(prefix.length).trim();
    if (body === '') return false;
    const parts = body.split(/\s+/);
    const verb = parts[0].toLowerCase();
    if (ADMIN_VERBS.indexOf(verb) < 0) return false;
    if (frame.message_type !== 'group') { sendReply(frame, '群指令只能在群里使用'); return true; }

    // 严格参数：多余内容判为用法错误
    const arity = COMMAND_ARITY[verb];
    if (parts.length < arity[0] || parts.length > arity[1]) {
      sendReply(frame, '用法：' + String(ADMIN_USAGE[verb]) + '\n（指令必须整条匹配，后面不能有其它内容）');
      return true;
    }

    const authority = await resolveAuthority(frame.user_id, frame.group_id);
    const needed = COMMAND_PERMISSION[verb];
    if (needed !== null && needed !== undefined && hasPerm(authority, needed) !== true) {
      console.log(TAG + ' 指令被拒（' + verb + ' by ' + String(frame.user_id) + '）：缺 ' + needed);
      sendReply(frame, '【拒绝】' + describeAuthority(authority) + '\n缺少权限：'
        + (PERMISSION_LABEL[needed] === undefined ? needed : PERMISSION_LABEL[needed]));
      return true;
    }

    const plan = planAdminCommand(verb, parts, frame, authority);
    if (plan === null) { sendReply(frame, '用法：' + String(ADMIN_USAGE[verb])); return true; }
    if (plan.error !== undefined) { sendReply(frame, plan.error); return true; }

    // 本地指令：授权表增删改与查看
    if (plan.local === true) {
      if (plan.pendingAuthorityFor !== undefined) {
        const targetAuthority = await resolveAuthority(plan.pendingAuthorityFor, frame.group_id);
        sendReply(frame, '@' + plan.pendingAuthorityFor + '\n' + describeAuthority(targetAuthority));
        return true;
      }
      if (plan.grantAction !== undefined) {
        const g = plan.grantAction;
        const existing = grants.get(grantKey(g.groupId, g.target));
        const merged = new Set(existing === undefined ? [] : existing.perms);
        for (const perm of g.perms) merged.add(perm);
        const record = {
          groupId: g.groupId, userId: String(g.target), perms: merged,
          expiresAt: g.permanent === true ? null : Date.now() + g.minutes * 60000,
          by: g.by, permanent: g.permanent === true,
        };
        grants.set(grantKey(g.groupId, g.target), record);
        sendReply(frame, '【已授权】' + formatGrant(record)
          + (g.permanent === true ? '' : '\n（仅在本群有效，' + String(g.minutes) + ' 分钟后自动失效）'));
        state.stats.admin += 1;
        return true;
      }
      if (plan.revokeAction !== undefined) {
        const r = plan.revokeAction;
        const key = grantKey(r.groupId, r.target);
        const existing = grants.get(key);
        if (existing === undefined) { sendReply(frame, '该成员在本群没有动态授权。'); return true; }
        if (r.perms === null) {
          grants.delete(key);
          sendReply(frame, '【已撤销】' + String(r.target) + ' 在本群的全部动态授权。');
        } else {
          for (const perm of r.perms) existing.perms.delete(perm);
          if (existing.perms.size === 0) grants.delete(key);
          sendReply(frame, '【已撤销】' + String(r.target) + ' 的 ' + r.perms.join('/') + ' 授权。');
        }
        state.stats.admin += 1;
        return true;
      }
      sendReply(frame, plan.reply);
      return true;
    }

    console.log(TAG + ' 指令 ' + verb + ' by ' + String(frame.user_id) + ' in ' + String(frame.group_id) + ' -> ' + String(plan.action));
    await runGroupAction(frame, plan);
    return true;
  }

  async function acceptMessage(frame) {
    const isGroup = frame.message_type === 'group';
    const policy = isGroup ? CONFIG.group : CONFIG.private;
    const chatId = isGroup ? frame.group_id : frame.user_id;

    if (policy.enabled !== true) { state.stats.skipped += 1; return; }
    const selfId = frame.self_id === null || frame.self_id === undefined ? null : String(frame.self_id);
    if (selfId !== null && String(frame.user_id) === selfId) { state.stats.skipped += 1; return; }

    // 群管理指令优先：不要求 @ 机器人，也不会送给模型。
    if (isGroup) {
      const handled = await handleAdminCommand(frame, typeof frame.text === 'string' ? frame.text : '');
      if (handled === true) return;
    }
    if (!allowlistOk(policy.allow, chatId)) { state.stats.skipped += 1; return; }

    let text = typeof frame.text === 'string' ? frame.text : '';

    if (isGroup && policy.requireAt === true) {
      const mention = selfId === null ? null : '@' + selfId;
      if (mention !== null) {
        if (!text.includes(mention)) { state.stats.skipped += 1; return; }
        text = text.split(mention).join(' ').trim();
      } else if (!text.includes('@')) { state.stats.skipped += 1; return; }
    }

    if (CONFIG.commandPrefix !== '') {
      if (!text.startsWith(CONFIG.commandPrefix)) { state.stats.skipped += 1; return; }
      text = text.slice(CONFIG.commandPrefix.length).trim();
    }

    if (text === '' && !(typeof frame.images === 'number' && frame.images > 0)) { state.stats.skipped += 1; return; }
    state.stats.accepted += 1;

    // 入口路由：按「拥有者 / 非拥有者」决定走哪条会话与 preset；
    // 两个 preset 都不配就共用一条会话（行为与以前一致）。
    const route = sessionRoute(frame);
    const entryKey = CONFIG.perChatSession ? route.entryKey : 'shared';
    const sessionId = CONFIG.perChatSession ? route.sessionId : 'qqbot-shared';
    const preset = CONFIG.perChatSession ? route.preset : CONFIG.agentPreset;

    let entry;
    try { entry = await getEntry(entryKey, sessionId, preset); }
    catch (error) {
      state.stats.errors += 1;
      console.error(TAG + ' 为 ' + entryKey + ' 建会话失败：' + describeError(error));
      sendReply(frame, '（内部错误：无法创建对话会话）');
      return;
    }

    // 记录本条消息的说话人与身份：qqgroup 工具的鉴权依据（三路并行）。
    const speakerAuthority = await resolveAuthority(frame.user_id, isGroup ? chatId : null);
    entry.groupId = isGroup ? String(chatId) : null;
    entry.speaker = {
      userId: String(frame.user_id),
      groupId: entry.groupId,
      tier: speakerAuthority.tier,
      owner: speakerAuthority.owner === true,
      sources: speakerAuthority.sources,
    };

    // 本回合是否允许使用 DSH 内部工具：只有拥有者（或显式放开 guestDshTools）才行。
    const allowDsh = speakerAuthority.owner === true || CONFIG.auth.guestDshTools === true;

    const generation = entry.generation;
    entry.queue = entry.queue
      .then(() => runTurn(entry, frame, text, generation, allowDsh))
      .catch((error) => {
        state.stats.errors += 1;
        console.error(TAG + ' ' + entryKey + ' 回合失败：' + describeError(error));
      });
  }

  /** 每个 QQ 会话只建一次 Agent */
  function getEntry(entryKey, sessionId, preset) {
    const existing = state.convos.get(entryKey);
    if (existing !== undefined) return existing.ready;
    const entry = {
      key: entryKey, sessionId, agent: null, turns: 0, generation: 0,
      queue: Promise.resolve(), ready: null,
      // 本会话最近一条消息的说话人与身份（qqgroup 工具的鉴权依据）
      speaker: null, groupId: null,
      // 访客工具闸：注册一次，判据是这个可变标志位
      dshAllowed: false, liftGuard: null, guardUnavailable: false,
    };
    entry.ready = (async () => {
      // 官方组装路径：create 会幂等地创建/接管会话，resolveAgent 装上默认模型路由
      // 并挂载 Agent preset（人格 + 工具）。直接 agentLoop.create 不装模型路由，
      // 第一次模型请求必然失败。
      const ws = await ensureQqMsgWorkspace();
      let request;
      if (ws.id !== null) {
        // 有 workspace 服务：传 workspaceId，DSH 自动把会话挂到 QQ_msg 分组。
        request = { sessionId, workspaceId: ws.id };
      } else {
        // 回退：无 workspace 服务时用会话子目录当工作目录。
        const workdir = sessionWorkdir(sessionId);
        await fsPromises.mkdir(workdir, { recursive: true });
        request = { sessionId, cwd: workdir };
      }
      const effectivePreset = preset === undefined ? CONFIG.agentPreset : preset;
      if (effectivePreset !== '' && effectivePreset !== undefined && effectivePreset !== null) request.agentPreset = effectivePreset;
      await sessionController.create(request);
      const resolved = await sessionController.resolveAgent(sessionId);
      if (resolved === null || resolved === undefined || resolved.error !== undefined) {
        const detail = (resolved !== null && resolved !== undefined && resolved.error)
          ? (resolved.error.message ? resolved.error.message : String(resolved.error.code))
          : 'resolveAgent 没有返回 agent';
        throw new Error(detail);
      }
      entry.agent = resolved.agent;

      // 访客工具闸：只在建 agent 时注册一次。guard 是一个每次执行才求值的函数，
      // 判据放进闭包里的可变标志位 entry.dshAllowed，所以拥有者/访客交替说话时
      // 既不用增删限制，也不会造成工具面抖动（那会多记 request/header、白费 token）。
      const guestAllow = new Set(Array.isArray(CONFIG.auth.guestToolAllow) ? CONFIG.auth.guestToolAllow : []);
      try {
        entry.liftGuard = entry.agent.ctx.tools.guard((exec) => {
          if (entry.dshAllowed === true) return undefined;
          const toolName = (exec !== null && exec !== undefined && typeof exec.name === 'string') ? exec.name : '';
          if (guestAllow.has(toolName)) return undefined;
          state.stats.guestBlocked += 1;
          console.log(TAG + ' 访客工具闸拦截：' + toolName);
          return '访客模式：不允许使用 DSH 内部工具 ' + toolName;
        });
      } catch (error) {
        entry.guardUnavailable = true;
        console.error(TAG + ' 无法安装访客工具闸，将拒绝驱动非拥有者：' + describeError(error));
      }

      console.log(TAG + ' 会话 ' + sessionId + ' 已就绪（' + entryKey + '）');
      return entry;
    })().catch((error) => { state.convos.delete(entryKey); throw error; });
    state.convos.set(entryKey, entry);
    return entry.ready;
  }

  /**
   * 识别 QQ 消息里的图片：下载图片，用 DSH 已配置的视觉模型（从自定义 providers
   * 里选，协议/baseURL/apiKey 全部沿用 DSH 原本填写的）做图片理解，返回识别文本。
   * 返回 { error, text }：error 非空 = 不应继续（可读报错提示）；text 非空 = 识别结果。
   */
  async function describeImages(frame, entry) {
    const vision = CONFIG.vision || {};
    if (vision.enabled !== true) return { error: '', text: '' };
    const urls = Array.isArray(frame.image_urls) ? frame.image_urls : [];
    if (urls.length === 0) return { error: '', text: '' };
    const attachments = ctx.attachments;
    if (attachments === undefined || attachments === null || typeof attachments.saveImage !== 'function') {
      return { error: '（图片视觉已开启，但附件服务不可用，请检查 DSH 的 attachments 插件是否启用）', text: '' };
    }
    // 解析视觉模型：显式配置优先（用户从 DSH 自定义 providers 里选），否则用会话当前模型
    const provider = (typeof vision.provider === 'string' && vision.provider !== '') ? vision.provider
      : (entry && entry.agent && entry.agent.options && typeof entry.agent.options.provider === 'string'
        ? entry.agent.options.provider : '');
    const model = (typeof vision.model === 'string' && vision.model !== '') ? vision.model
      : (entry && entry.agent && entry.agent.options && typeof entry.agent.options.model === 'string'
        ? entry.agent.options.model : '');
    if (provider === '' || model === '') {
      return { error: '（图片视觉：未能确定视觉模型。请到「设置 → QQ 机器人 → 图片视觉」里填写 provider 与 model，例如你的自定义 provider / deepseek-v4-flash-vision-exp）', text: '' };
    }
    // 模型不支持图片时给可读报错（仅当能力明确可知；未知则放行交给请求本身判断）
    if (typeof ctx.llm === 'object' && ctx.llm !== null && typeof ctx.llm.resolveModelInfo === 'function') {
      try {
        const info = await ctx.llm.resolveModelInfo(provider, model);
        const modalities = (info && Array.isArray(info.inputModalities)) ? info.inputModalities : null;
        if (modalities !== null && !modalities.includes('image')) {
          return { error: '（当前视觉模型 ' + provider + '/' + model + ' 不支持图片识别。'
            + '请到「设置 → QQ 机器人 → 图片视觉」切换支持图片的模型，例如 deepseek-v4-flash-vision-exp 或 deepseek-v4.1-flash-request）', text: '' };
        }
      } catch (error) {
        console.log(TAG + ' 视觉能力探测失败（放行，交给请求本身）：' + describeError(error));
      }
    }
    const max = Math.max(1, Math.min(vision.maxImages ?? 3, urls.length));
    const timeoutMs = vision.downloadTimeoutMs ?? 10000;
    const descriptions = [];
    const savedPaths = [];
    // 缓存图片导出：把原图写入 <QQ_msg>/qq-images/<会话id>/（留档用，识图由视觉模型完成）；
    // 会话结算（本轮回复完成后）会整体删除该缓存目录，见 runTurn 收尾。
    const imgRoot = join(qqMsgRootSync(), 'qq-images', String(entry ? entry.sessionId : 'default'));
    for (let i = 0; i < max; i += 1) {
      const url = urls[i];
      if (typeof url !== 'string' || !/^https?:\/\//.test(url)) continue;
      try {
        const downloaded = await downloadImage(url, timeoutMs);
        if (downloaded === null) continue;
        const ref = await attachments.saveImage({ data: downloaded.data, mediaType: downloaded.mediaType });
        const text = await askVision(provider, model, ref, i + 1);
        if (text !== '') descriptions.push(text);
        // 导出原图到工作目录（会话 id 区分），随消息附上路径
        try {
          const ext = downloaded.mediaType === 'image/png' ? 'png'
            : downloaded.mediaType === 'image/webp' ? 'webp'
              : downloaded.mediaType === 'image/gif' ? 'gif' : 'jpg';
          const abs = join(imgRoot, 'qq-' + Date.now() + '-' + i + '.' + ext);
          await fsPromises.mkdir(imgRoot, { recursive: true });
          await fsPromises.writeFile(abs, downloaded.data);
          savedPaths.push(abs);
        } catch (saveErr) {
          console.log(TAG + ' 图片导出失败（不影响识别）：' + describeError(saveErr));
        }
      } catch (error) {
        console.log(TAG + ' 图片识别失败（跳过）：' + describeError(error));
      }
    }
    if (descriptions.length === 0) {
      return { error: '（图片视觉：图片下载或识别失败，请稍后重试）', text: '' };
    }
    return { error: '', text: descriptions.join('\n'), paths: savedPaths };
  }

  /** 下载一张 http(s) 图片，返回 { data: Uint8Array, mediaType } 或 null。 */
  async function downloadImage(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { signal: controller.signal, redirect: 'follow' });
      if (!resp.ok) return null;
      const ct = String(resp.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      let mediaType = null;
      if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(ct)) mediaType = ct;
      else if (ct === '') {
        mediaType = /\.png$/i.test(url) ? 'image/png'
          : /\.webp$/i.test(url) ? 'image/webp'
            : /\.gif$/i.test(url) ? 'image/gif' : 'image/jpeg';
      } else {
        return null;
      }
      const bytes = new Uint8Array(await resp.arrayBuffer());
      if (bytes.length === 0) return null;
      return { data: bytes, mediaType };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 用 DSH 的 llm 服务（走已注册的 provider 适配器）对一张图片做识别，返回识别文本。 */
  async function askVision(provider, model, ref, index) {
    const llm = ctx.llm;
    if (llm === undefined || llm === null || typeof llm.stream !== 'function') return '';
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: '这是用户发来的第 ' + index + ' 张图片。请用简体中文描述这张图片的内容，要具体、可读，不要猜测没有出现的信息。' },
        { type: 'image', attachment: ref },
      ],
    }];
    let out = '';
    try {
      for await (const chunk of llm.stream({ provider, model, messages, maxTokens: 512 })) {
        if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text;
      }
    } catch (error) {
      console.log(TAG + ' 视觉请求失败：' + describeError(error));
      return '';
    }
    return out.trim();
  }

  function buildPrompt(frame, text, entry) {
    const sender = frame.sender;
    const who = (sender !== null && sender !== undefined)
      ? (sender.card ? String(sender.card) : (sender.nickname ? String(sender.nickname) : '未知用户'))
      : '未知用户';
    const body = text === '' ? '（发来了一张图片）' : text;
    if (CONFIG.reply.contextHeader !== true) return body;
    const where = frame.message_type === 'group' ? 'QQ群 ' + String(frame.group_id) : 'QQ私聊';
    // 把说话人身份带给 Agent：非拥有者的请求是否该执行，由 Agent 结合权限判断。
    let tag = '';
    if (entry !== null && entry !== undefined && entry.speaker !== null && entry.speaker !== undefined) {
      const tier = TIER_LABEL[entry.speaker.tier] === undefined ? entry.speaker.tier : TIER_LABEL[entry.speaker.tier];
      const src = Array.isArray(entry.speaker.sources) && entry.speaker.sources.length > 0 ? '｜' + entry.speaker.sources.join('+') : '';
      tag = ' · 身份:' + tier + src;
    }
    return '[' + where + ' · ' + who + '(' + String(frame.user_id) + ')' + tag + '] ' + body;
  }

  async function runTurn(entry, frame, text, generation, allowDsh) {
    if (entry.generation !== generation) return;   // 已被 interrupt 作废

    // 必须在串行回合内部设置：如果在接收入口设，排队的两条消息（先拥有者后访客）
    // 会互相覆盖，导致后一个回合用错权限。
    entry.dshAllowed = allowDsh === true;
    if (entry.guardUnavailable === true && allowDsh !== true) {
      sendReply(frame, '（本会话无法安装工具隔离，已拒绝这次驱动）');
      return;
    }

    entry.turns += 1;

    const body = buildPrompt(frame, text, entry);
    const userText = entry.turns === 1 && CONFIG.reply.firstTurnHint !== ''
      ? body + '\n\n' + CONFIG.reply.firstTurnHint
      : body;

    const content = [{ type: 'text', text: userText }];
    const vision = await describeImages(frame, entry);
    if (vision.error !== '') {
      // 模型不支持图片 / 图片下载失败：给用户可读报错，引导去插件设置切换模型
      sendReply(frame, vision.error);
      return;
    }
    if (vision.text !== '') {
      // 把视觉识别结果并入用户消息，让 Agent 依据图片内容作答
      // 本条消息带图片：随附导出的原图路径（留档），并提示 Agent 结合用户发言作答、
      // 需确认身份时联网查证。图片仅用于本次会话，结算后自动删除。
      const imgPaths = Array.isArray(vision.paths) && vision.paths.length > 0
        ? '\n\n[图片文件] ' + vision.paths.join('\n')
        : '';
      content[0] = { type: 'text', text: userText + '\n\n[图片识别] ' + vision.text + imgPaths
        + '\n\n（本条消息含图片。请结合用户发言作答；需确认图中人物/物品身份时，'
        + '提炼关键词用 run_code 调 web_search 联网查证，勿凭空猜测。）' };
    }
    const message = {
      id: uid('qqmsg'),
      role: 'user',
      content,
      source: { kind: 'user' },
    };

    let acked = false;
    let cancelAck = null;
    if (CONFIG.reply.ackAfterMs > 0 && CONFIG.reply.ackText !== '') {
      try {
        cancelAck = ctx.timeout(() => { acked = true; sendReply(frame, CONFIG.reply.ackText); }, CONFIG.reply.ackAfterMs);
      } catch { /* 定时器不可用就跳过 */ }
    }

    try {
      entry.agent.followup(message);
      await entry.agent.whenIdle();
    } finally {
      if (typeof cancelAck === 'function') cancelAck();
    }

    const reply = extractReply(entry.agent);
    if (reply === '') {
      if (!acked) sendReply(frame, '（本轮没有产生文字回复：' + lastTurnReason(entry.agent) + '）');
      return;
    }
    sendReply(frame, reply);
    state.stats.replies += 1;

    // 会话结算：删除本会话缓存的图片目录（<QQ_msg>/qq-images/<会话id>/），
    // 图片仅用于本轮识图与联网查证，结算后不留残留；会话与工作区保留。
    if (Array.isArray(vision.paths) && vision.paths.length > 0) {
      const imgRoot = join(qqMsgRootSync(), 'qq-images', String(entry ? entry.sessionId : 'default'));
      try {
        await fsPromises.rm(imgRoot, { recursive: true, force: true });
      } catch (cleanErr) {
        console.log(TAG + ' 图片缓存清理失败：' + describeError(cleanErr));
      }
    }
  }

  /** 会话日志里最新一条有文本的 assistant 消息 */
  function extractReply(agent) {
    const session = (agent === null || agent === undefined) ? null : agent.session;
    if (session === null || session === undefined || typeof session.deriveMessages !== 'function') return '';
    const messages = session.deriveMessages();
    if (!Array.isArray(messages)) return '';
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message === null || typeof message !== 'object' || message.role !== 'assistant') continue;
      if (!Array.isArray(message.content)) continue;
      let text = '';
      for (const block of message.content) {
        if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') text += block.text;
      }
      if (text.trim() !== '') return text.trim();
    }
    return '';
  }

  /** 诊断：本轮为什么结束（从会话日志读 turn/end 原因） */
  function lastTurnReason(agent) {
    try {
      const session = agent.session;
      const events = session.snapshotEvents(0, session.seq);
      for (let index = events.length - 1; index >= 0; index -= 1) {
        if (events[index].type === 'turn/end') return JSON.stringify(events[index].data.reason);
      }
      return '本回合未结束（' + String(events.length) + ' 个事件）';
    } catch (error) {
      return '读取日志失败：' + describeError(error);
    }
  }

  function chunkText(text, limit) {
    const max = (typeof limit === 'number' && limit > 0) ? limit : 1200;
    if (text.length <= max) return [text];
    const chunks = [];
    let rest = text;
    while (rest.length > max) {
      let cut = rest.lastIndexOf('\n', max);
      if (cut <= 0) cut = max;
      chunks.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).replace(/^\n+/, '');
    }
    if (rest.trim() !== '') chunks.push(rest.trim());
    return chunks;
  }

  function sendReply(frame, text) {
    const target = frame.message_type === 'group' ? frame.group_id : frame.user_id;
    if (target === null || target === undefined) return;
    for (const chunk of chunkText(String(text), CONFIG.reply.maxChars)) {
      writeToAdapter({
        type: 'send',
        message_type: frame.message_type === 'group' ? 'group' : 'private',
        target_id: String(target),
        text: chunk,
      });
    }
  }

  // -------------------------------------------------------------- 动态工具
  // 用动态 import 拿 defineTool：即使这个包不在，桥接本身照样工作，只是少一个工具。
  try {
    const { defineTool } = await import('@deepseek-ai/dsh-tools');
    const tool = defineTool({
      name: 'qqbot',
      description: '查看或操作本地 QQ Bot 桥接（OneBot 11 → NapCat）。'
        + 'action="status" 查看连接状态与所有 QQ 会话；action="send" 主动发一条 QQ 消息；'
        + 'action="interrupt" 中断某个（或全部）会话正在跑的回合。',
      parameters: {
        action: { type: 'string', description: 'status | send | interrupt' },
        message_type: { type: 'string', description: 'send 用：group 或 private' },
        target_id: { type: 'string', description: 'send 用：QQ 群号或用户号' },
        text: { type: 'string', description: 'send 用：消息正文' },
        conversation: { type: 'string', description: 'interrupt 用：会话键（group-123 / private-456）或 all' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        const action = (args !== null && args !== undefined && typeof args.action === 'string') ? args.action : '';

        if (action === 'status') {
          const conversations = [];
          for (const pair of state.convos) {
            const entry = pair[1];
            conversations.push({
              conversation: entry.key,
              sessionId: entry.sessionId,
              turns: entry.turns,
              agentStatus: entry.agent === null ? 'creating' : String(entry.agent.status),
            });
          }
          return {
            ok: true,
            connected: state.connected,
            reason: state.statusReason,
            mode: CONFIG.mode,
            onebot: { wsUrl: CONFIG.onebot.wsUrl, listen: CONFIG.onebot.listen, httpUrl: CONFIG.onebot.httpUrl },
            adapter: { path: currentAdapterPath(), pid: state.adapterPid, listenPort: state.listenPort, restarts: state.restarts },
            workspace: qqMsgRootSync(),
            policy: {
              groups: { enabled: CONFIG.group.enabled, requireAt: CONFIG.group.requireAt, allow: CONFIG.group.allow },
              private: { enabled: CONFIG.private.enabled, allow: CONFIG.private.allow },
              perChatSession: CONFIG.perChatSession,
            },
            stats: {
              inbound: state.stats.inbound, accepted: state.stats.accepted, skipped: state.stats.skipped,
              replies: state.stats.replies, chunksSent: state.stats.chunks, errors: state.stats.errors, guestBlocked: state.stats.guestBlocked,
            },
            conversations,
          };
        }

        if (action === 'send') {
          const messageType = args.message_type === 'group' ? 'group' : 'private';
          const targetId = (args.target_id === null || args.target_id === undefined) ? '' : String(args.target_id);
          const text = typeof args.text === 'string' ? args.text : '';
          if (targetId === '' || text === '') return { ok: false, error: 'send 需要 target_id 和 text' };
          return {
            ok: writeToAdapter({ type: 'send', message_type: messageType, target_id: targetId, text }),
            message_type: messageType, target_id: targetId, connected: state.connected,
          };
        }

        if (action === 'interrupt') {
          const wanted = (typeof args.conversation === 'string' && args.conversation !== '') ? args.conversation : 'all';
          const interrupted = [];
          for (const pair of state.convos) {
            const entry = pair[1];
            if (wanted !== 'all' && entry.key !== wanted) continue;
            entry.generation += 1;
            if (entry.agent !== null && typeof entry.agent.cancel === 'function') {
              try { entry.agent.cancel({ kind: 'user' }); }
              catch (error) { console.error(TAG + ' 中断 ' + entry.key + ' 失败：' + describeError(error)); }
            }
            interrupted.push(entry.key);
          }
          return { ok: true, interrupted };
        }

        return { ok: false, error: '未知 action ' + JSON.stringify(action) };
      },
    });
    ctx.effect(() => ctx.tools.register(tool));
    console.log(TAG + ' 已注册 qqbot 工具');

    // 方案 A：让 Agent 自己调群管理。授权看「本会话最近一条消息是否来自白名单」，
    // 而不是让模型自己判断，避免群里的普通成员用一句话就驱动踢人。
    const groupTool = defineTool({
      name: 'qqgroup',
      description: 'QQ 群管理／查询（OneBot 11）。action 取值：group-list | group-info | member-list | member-info | '
        + 'mute | unmute | kick | whole-ban | set-card | set-admin | rename | recall | poke。'
        + '破坏性操作要求当前会话最近一条消息来自管理员白名单（或已打开 admin.allowConsole）。',
      parameters: {
        action: { type: 'string', description: '要执行的动作，见工具描述' },
        group_id: { type: 'string', description: '群号；留空则用当前会话所在的群' },
        user_id: { type: 'string', description: '目标成员 QQ 号' },
        duration: { type: 'number', description: '禁言秒数（mute；0 = 解禁，上限 43200）' },
        text: { type: 'string', description: 'set-card 的新名片 / rename 的新群名' },
        message_id: { type: 'number', description: 'recall 的消息 id' },
        enable: { type: 'boolean', description: 'whole-ban / set-admin 的开关' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        const admin = CONFIG.admin;
        if (admin.enabled !== true) return { ok: false, error: '管理功能未启用（admin.enabled=false）' };
        // 与 QQ 侧指令走同一套三路鉴权：静态名单 / 动态授权 / 本群身份。
        // 「说话人」来自本会话最近一条消息，所以群里普通成员无法靠一句话驱动管理动作。
        const entry = entryForAgent(exec.agent);
        const speaker = (entry === null || entry === undefined) ? null : entry.speaker;
        if (speaker === null || speaker === undefined) {
          if (admin.allowConsole !== true) {
            return { ok: false, error: '未授权：无法确定调用者身份（非 QQ 会话）；确需从控制台调用请打开 admin.allowConsole' };
          }
        }
        const authority = (speaker === null || speaker === undefined)
          ? { tier: 'owner', owner: true, userId: 'console', groupId: null, perms: new Set(PERMISSION_LIST), sources: ['控制台(allowConsole)'] }
          : await resolveAuthority(speaker.userId, speaker.groupId);

        const action = typeof args.action === 'string' ? args.action : '';
        const groupId = (args.group_id === undefined || args.group_id === null || String(args.group_id) === '')
          ? (entry !== null && entry.groupId !== null ? entry.groupId : null)
          : String(args.group_id);
        const uid = (args.user_id === undefined || args.user_id === null || String(args.user_id) === '') ? null : String(args.user_id);
        const dur = Math.min(Math.max(0, Math.round(Number(args.duration === undefined ? 600 : args.duration))), 43200);
        const want = args.enable !== false;

        const TOOL_PERMISSION = {
          'group-list': 'query', 'group-info': 'query', 'member-list': 'query', 'member-info': 'query',
          mute: 'mute', unmute: 'mute', kick: 'kick', recall: 'recall',
          'whole-ban': 'settings', 'set-card': 'settings', 'set-admin': 'settings', rename: 'settings',
          poke: 'query',
        };
        const needed = TOOL_PERMISSION[action];
        if (needed !== undefined && hasPerm(authority, needed) !== true) {
          return { ok: false, error: '缺少权限：' + needed + '｜' + describeAuthority(authority) };
        }

        const plans = {
          'group-list': () => ({ action: 'get_group_list', params: {} }),
          'group-info': () => (groupId === null ? null : { action: 'get_group_info', params: { group_id: toId(groupId) } }),
          'member-list': () => (groupId === null ? null : { action: 'get_group_member_list', params: { group_id: toId(groupId) } }),
          'member-info': () => ((groupId === null || uid === null) ? null : { action: 'get_group_member_info', params: { group_id: toId(groupId), user_id: toId(uid), no_cache: true } }),
          mute: () => ((groupId === null || uid === null) ? null : { action: 'set_group_ban', params: { group_id: toId(groupId), user_id: toId(uid), duration: dur } }),
          unmute: () => ((groupId === null || uid === null) ? null : { action: 'set_group_ban', params: { group_id: toId(groupId), user_id: toId(uid), duration: 0 } }),
          kick: () => ((groupId === null || uid === null) ? null : { action: 'set_group_kick', params: { group_id: toId(groupId), user_id: toId(uid), reject_add_request: false } }),
          'whole-ban': () => (groupId === null ? null : { action: 'set_group_whole_ban', params: { group_id: toId(groupId), enable: want } }),
          'set-card': () => ((groupId === null || uid === null || typeof args.text !== 'string' || args.text === '') ? null : { action: 'set_group_card', params: { group_id: toId(groupId), user_id: toId(uid), card: args.text } }),
          'set-admin': () => ((groupId === null || uid === null) ? null : { action: 'set_group_admin', params: { group_id: toId(groupId), user_id: toId(uid), enable: want } }),
          rename: () => ((groupId === null || typeof args.text !== 'string' || args.text === '') ? null : { action: 'set_group_name', params: { group_id: toId(groupId), group_name: args.text } }),
          recall: () => ((args.message_id === undefined || args.message_id === null) ? null : { action: 'delete_msg', params: { message_id: Number(args.message_id) } }),
          poke: () => ((groupId === null || uid === null) ? null : { action: 'send_group_poke', params: { group_id: toId(groupId), user_id: toId(uid) } }),
        };
        if (!Object.prototype.hasOwnProperty.call(plans, action)) {
          return { ok: false, error: '未知 action：' + JSON.stringify(action), available: Object.keys(plans) };
        }
        const plan = plans[action]();
        if (plan === null) return { ok: false, error: '缺少必要参数（group_id / user_id / text / message_id）' };
        if (groupId !== null && !groupInScope(groupId)) return { ok: false, error: '群 ' + groupId + ' 不在可管理范围内' };
        if (admin.dryRun === true) return { ok: true, dryRun: true, wouldRun: plan };

        state.stats.admin += 1;
        const result = await callAdapterAction(plan.action, plan.params);
        return {
          ok: result.ok === true,
          action: plan.action,
          error: result.ok === true ? null : String(result.error === undefined ? '未知错误' : result.error),
          data: result.data === undefined ? null : result.data,
        };
      },
    });
    ctx.effect(() => ctx.tools.register(groupTool));
    console.log(TAG + ' 已注册 qqgroup 工具');
  } catch (error) {
    console.log(TAG + ' 跳过 qqbot 工具注册：' + describeError(error));
  }

  // 配置热更新：cordis-plugin-loader 在 volatile 字段变化时不会重挂插件，只就地更新
  // 引用并发 'loader/volatile-update'（只有普通字段变化才会重挂，而本插件的可编辑字段
  // 全是 volatile）。所以这里自己刷新 CONFIG。
  // 只有「连接方式」那几项需要重启适配器；其它改动下一轮消息自然生效。
  let lastTransport = transportKey(CONFIG);
  const onVolatileUpdate = () => {
    try {
      CONFIG = resolveConfig();
      const next = transportKey(CONFIG);
      if (next === lastTransport) return;
      lastTransport = next;
      console.log(TAG + ' 连接配置已更新，重启适配器');
      stopAdapter();
      state.restarts = 0;
      ctx.timeout(() => { spawnAdapter(); }, 250);
    } catch (error) {
      console.error(TAG + ' 应用设置变更失败：' + describeError(error));
    }
  };
  try {
    ctx.on('loader/volatile-update', onVolatileUpdate);
  } catch (error) {
    console.log(TAG + ' 未能监听配置热更新（不影响运行）：' + describeErrorStatic(error));
  }

  // -------------------------------------------------------------- 生命周期
  ctx.effect(() => () => {
    state.stopping = true;
    stopAdapter();
    for (const pair of state.convos) {
      const entry = pair[1];
      if (entry.agent !== null && typeof entry.agent.cancel === 'function') {
        try { entry.agent.cancel({ kind: 'disposed' }); } catch { /* 交给卸载流程 */ }
      }
    }
    console.log(TAG + ' 已停止');
  });

  const wsInfo = await ensureQqMsgWorkspace();
  console.log(TAG + ' 启动中：' + CONFIG.mode + ' 模式'
    + (CONFIG.mode === 'reverse' ? ' listen=' + CONFIG.onebot.listen : ' ws=' + CONFIG.onebot.wsUrl)
    + ' | 群=' + (CONFIG.group.enabled ? (CONFIG.group.requireAt ? '仅@' : '全部') : '关')
    + ' | 私聊=' + (CONFIG.private.enabled ? '开' : '关')
    + ' | 工作区=' + qqMsgRootSync()
    + (wsInfo.id !== null ? ' | 分组=QQ_msg（已注册）' : ' | 分组=不可用（会话回退 cwd）'));
  spawnAdapter();
}
