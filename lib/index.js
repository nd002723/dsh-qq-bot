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
import { fetchUrlViaProxy } from './http.js';
import { runWebSearch } from './websearch.js';
import { runImageSearch, uploadToHost, imgSearchSoutubotFile, imgSearchTraceMoeFile, meIsAllowedImageFile } from './imgsearch.js';
import { meFindMoli, meMoliFetchText } from './moli.js';
import { Config, DEFAULTS, plainConfig, mergeConfig, describeError } from './config.js';
import { createAdmin } from './admin.js';
import { createSession } from './session.js';
import { createTools } from './tools.js';

export { Config };

export const name = 'dsh-qq-bot';
// attachments / llm：图片视觉用（把 QQ 图片注册成 DSH image 块并探测模型能力）。
// 两者都由 dsh-base 恒常挂载（attachment-local 与 dsh-llm），声明为硬依赖。
export const inject = ['subprocess', 'sessionController', 'timer', 'attachments', 'llm', 'tools'];

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
    console.log(TAG + ' 未能声明设置页归属（不影响运行）：' + describeError(error));
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

  /** 查询被引用（回复）消息的发送者是否 bot 自己；查不到按非 bot 处理。 */
  async function isReplyToSelf(frame) {
    if (frame.reply_to === null || frame.reply_to === undefined) return false;
    const selfId = frame.self_id === null || frame.self_id === undefined ? null : String(frame.self_id);
    if (selfId === null) return false;
    try {
      const result = await callAdapterAction('get_msg', { message_id: Number(frame.reply_to) }, 8000);
      if (result.ok === true && result.data !== null && result.data !== undefined
        && result.data.sender !== null && result.data.sender !== undefined
        && String(result.data.sender.user_id) === selfId) return true;
    } catch { /* 查不到按非 bot 处理 */ }
    return false;
  }

  /** 拉取被回复（引用）的那条消息，把其中的图片收集到 frame.replyImageUrls，
   * 供 describeImages 一并识别（回复引用流程保留）。不构建文本上下文——
   * 需要群内近期消息/图片时，由 AI 主动调 qq_history 工具自取。
   */
  async function acceptMessage(frame) {
    const isGroup = frame.message_type === 'group';
    const policy = isGroup ? CONFIG.group : CONFIG.private;
    const chatId = isGroup ? frame.group_id : frame.user_id;

    if (policy.enabled !== true) { state.stats.skipped += 1; return; }
    const selfId = frame.self_id === null || frame.self_id === undefined ? null : String(frame.self_id);
    if (selfId !== null && String(frame.user_id) === selfId) { state.stats.skipped += 1; return; }

    // 群管理指令优先：不要求 @ 机器人，也不会送给模型。
    if (isGroup) {
      const handled = await adminApi.handleAdminCommand(frame, typeof frame.text === 'string' ? frame.text : '');
      if (handled === true) return;
    }
    if (!allowlistOk(policy.allow, chatId)) { state.stats.skipped += 1; return; }

    let text = typeof frame.text === 'string' ? frame.text : '';

    // 命令前缀（如 /ai）：命中视同点名（bot 被调用），豁免 requireAt；
    // 与群管理指令同理，也走「QQ 回复消息流程」引用回复。
    let prefixHit = false;
    if (CONFIG.commandPrefix !== '') {
      if (!text.startsWith(CONFIG.commandPrefix)) { state.stats.skipped += 1; return; }
      text = text.slice(CONFIG.commandPrefix.length).trim();
      prefixHit = true;
    }

    // 被回复（引用）了 bot 消息：视同 @ 处理（群聊 + 开关开启时）。
    // 查询被引用消息的发送者是否 bot 自己；查不到按非 bot 处理。
    // 前缀指令已豁免 @，无需再查。
    let repliedToBot = false;
    // 只要开关开启且消息带了被引用消息，就查发送者是否 bot 自己；
    // 不依赖 requireAt——requireAt 关闭（群=全部）时回复了 bot 同样要识别并引用回复。
    if (!prefixHit && isGroup && CONFIG.reply.botReply === true
      && frame.reply_to !== null && frame.reply_to !== undefined) {
      repliedToBot = await isReplyToSelf(frame);
    }

    // bot 是否被点名（@ 了 bot / 回复了 bot / 前缀指令）：被点名才用「QQ 回复消息流程」引用回复。
    let botMentioned = repliedToBot || prefixHit;
    let mentionHit = false;
    if (isGroup && policy.requireAt === true && !prefixHit) {
      const mention = selfId === null ? null : '@' + selfId;
      if (mention !== null) {
        if (text.includes(mention)) {
          text = text.split(mention).join(' ').trim();
          botMentioned = true;
          mentionHit = true;
        } else if (!repliedToBot) { state.stats.skipped += 1; return; }
      } else if (!text.includes('@') && !repliedToBot) { state.stats.skipped += 1; return; }
    }

    // 例外：回复了 bot 但正文 @ 的是别人（剥离 @bot 后仍有 @）——
    // 这条可能不是对 bot 说的，不强制引用回复，交给 bot 自行判断是否继续回复。
    if (repliedToBot && !mentionHit && /@/.test(text)) botMentioned = false;

    // 不再主动拉取聊天上下文塞进会话（fetchReplyContext/replyTargetQQs 已移除）：
    // 需要群内近期消息/图片时，由 AI 主动调 qq_history 工具自取。
    // 只保留「被回复消息的图片」收集，供 describeImages 一并识别（回复引用流程不受影响）。
    if (frame.reply_to !== null && frame.reply_to !== undefined
      && (repliedToBot || mentionHit)) {
      try { await sessionApi.collectReplyImageUrls(frame); }
      catch (error) { console.log(TAG + ' 收集被回复图片失败（忽略）：' + describeError(error)); }
    }

    // 无正文：bot 被点名（@ / 回复 bot / 命令前缀）时也给一个占位正文让它回应（如纯回复/纯 @）；
    // 否则（普通空消息）照旧跳过。
    if (text === '' && !(typeof frame.images === 'number' && frame.images > 0)) {
      if (!botMentioned) { state.stats.skipped += 1; return; }
      text = '（本条消息无正文，仅点名了 bot）';
    }
    state.stats.accepted += 1;

    // 入口路由：按「拥有者 / 非拥有者」决定走哪条会话与 preset；
    // 两个 preset 都不配就共用一条会话（行为与以前一致）。
    const route = sessionApi.sessionRoute(frame);
    const entryKey = CONFIG.perChatSession ? route.entryKey : 'shared';
    const sessionId = CONFIG.perChatSession ? route.sessionId : 'qqbot-shared';
    const preset = CONFIG.perChatSession ? route.preset : CONFIG.agentPreset;

    const fixedTitle = (CONFIG.session !== null && CONFIG.session !== undefined && CONFIG.session.fixedName === true)
      ? (frame.message_type === 'group' ? '群聊_' : '私聊_') + String(frame.message_type === 'group' ? frame.group_id : frame.user_id)
      : null;
    let entry;
    try { entry = await sessionApi.getEntry(entryKey, sessionId, preset, fixedTitle); }
    catch (error) {
      state.stats.errors += 1;
      console.error(TAG + ' 为 ' + entryKey + ' 建会话失败：' + describeError(error));
      sendReply(frame, '（内部错误：无法创建对话会话）');
      return;
    }

    // 记录本条消息的说话人与身份：qqgroup 工具的鉴权依据（三路并行）。
    const speakerAuthority = await adminApi.resolveAuthority(frame.user_id, isGroup ? chatId : null);
    entry.groupId = isGroup ? String(chatId) : null;
    // 记录本条触发消息，qq_history 工具以此锚定图片识别窗口（最新提及）。
    entry.currentFrame = frame;
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
      .then(() => runTurn(entry, frame, text, generation, allowDsh, botMentioned))
      .catch((error) => {
        state.stats.errors += 1;
        console.error(TAG + ' ' + entryKey + ' 回合失败：' + describeError(error));
      });
  }

  /** 每个 QQ 会话只建一次 Agent；fixedTitle 非空时把新建会话名钉死（可选） */
  /**
   * 识别 QQ 消息里的图片：下载图片，用 DSH 已配置的视觉模型（从自定义 providers
   * 里选，协议/baseURL/apiKey 全部沿用 DSH 原本填写的）做图片理解，返回识别文本。
   * 返回 { error, text }：error 非空 = 不应继续（可读报错提示）；text 非空 = 识别结果。
   */
  async function describeImages(frame, entry) {
    const vision = CONFIG.vision || {};
    if (vision.enabled !== true) return { error: '', text: '' };
    const urls = [
      ...(Array.isArray(frame.image_urls) ? frame.image_urls : []),
      ...(Array.isArray(frame.replyImageUrls) ? frame.replyImageUrls : []),
    ];
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
      console.log(TAG + ' 视觉请求失败（' + provider + '/' + model + ' 第' + index + '张）：' + describeError(error));
      return '';
    }
    if (out.trim() === '') {
      console.log(TAG + ' 视觉请求空返回（' + provider + '/' + model + ' 第' + index + '张图，流式结束无文本）');
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
      const tier = adminApi.TIER_LABEL[entry.speaker.tier] === undefined ? entry.speaker.tier : adminApi.TIER_LABEL[entry.speaker.tier];
      const src = Array.isArray(entry.speaker.sources) && entry.speaker.sources.length > 0 ? '｜' + entry.speaker.sources.join('+') : '';
      tag = ' · 身份:' + tier + src;
    }
    let head = '[' + where + ' · ' + who + '(' + String(frame.user_id) + ')' + tag + ']';
    return head + ' ' + body;
  }

  async function runTurn(entry, frame, text, generation, allowDsh, quoteReply) {
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
        + '\n\n（本条消息含图片。请结合用户发言作答；自行提炼关键词调用qq_websearch qq_imgsearch进行查找（漫画用 kind=comic），尽量勿凭空猜测。）' };
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

    const reply = extractReply(entry.agent, message.id);
    if (reply === '') {
      // 失败提示总是作为正式回复发出（即使 ack 已发过「正在处理」也不吞掉结论）
      sendReply(frame, '（本轮没有产生文字回复：' + lastTurnReason(entry.agent) + '）');
      return;
    }
    sendReply(frame, reply, quoteReply === true);
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

  /** 只取 afterId（本条用户消息 id）之后新增的 assistant 文本；本轮无回复返回 ''，绝不回退重发上一轮内容 */
  function extractReply(agent, afterId) {
    const session = (agent === null || agent === undefined) ? null : agent.session;
    if (session === null || session === undefined || typeof session.deriveMessages !== 'function') return '';
    const messages = session.deriveMessages();
    if (!Array.isArray(messages)) return '';
    let start = 0;
    if (afterId !== undefined && afterId !== null) {
      const at = messages.findIndex((m) => m !== null && typeof m === 'object' && m.id === afterId);
      if (at < 0) return '';      // 锚点不在日志里：宁可不回，也不回退到上一轮内容
      start = at + 1;
    }
    for (let index = messages.length - 1; index >= start; index -= 1) {
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
  /** 把 turn/end reason 清洗成一句话：只保留失败号（400/503/429…），隐藏 request id 等敏感内容 */
  function summarizeTurnReason(reason) {
    let code = '';
    try {
      if (reason !== null && typeof reason === 'object') {
        const err = reason.error;
        const msg = (err !== null && typeof err === 'object' && typeof err.message === 'string') ? err.message
          : (typeof err === 'string' ? err : '');
        const m = /^(\d{3})\s*:/.exec(msg);
        if (m !== null) code = m[1];
      } else if (typeof reason === 'string') {
        const m = /^(\d{3})\s*:/.exec(reason);
        if (m !== null) code = m[1];
      }
      return code !== '' ? code : '未知原因';
    } catch {
      return '未知原因';
    }
  }

  function lastTurnReason(agent) {
    try {
      const session = agent.session;
      const events = session.snapshotEvents(0, session.seq);
      for (let index = events.length - 1; index >= 0; index -= 1) {
        if (events[index].type === 'turn/end') return summarizeTurnReason(events[index].data.reason);
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

  /**
   * 发回复。withQuote=true 且是群聊时，用「QQ 回复消息流程」（引用触发消息）。
   * 注意：引用回复只在 bot 被点名（@ 了 bot 或回复了 bot）的响应上用；
   * 若对每条群消息都引用，requireAt 关闭时就会每条消息都引用回复。
   */
  function sendReply(frame, text, withQuote) {
    const target = frame.message_type === 'group' ? frame.group_id : frame.user_id;
    if (target === null || target === undefined) return;
    const replyTo = (withQuote === true && frame.message_type === 'group'
      && frame.message_id !== null && frame.message_id !== undefined)
      ? Number(frame.message_id) : undefined;
    for (const chunk of chunkText(String(text), CONFIG.reply.maxChars)) {
      writeToAdapter({
        type: 'send',
        message_type: frame.message_type === 'group' ? 'group' : 'private',
        target_id: String(target),
        text: chunk,
        ...(replyTo !== undefined ? { reply_to: replyTo } : {}),
      });
    }
  }

  // 业务模块装配：权限/指令（admin）、会话（session）、动态工具（tools）都从独立模块工厂取。
  // 依赖经工厂注入（CONFIG 走 getConfig() 每次现取，支持热更新；state/ctx 传引用）。
  const adminApi = createAdmin({ getConfig: () => CONFIG, callAdapterAction, sendReply, state });
  const sessionApi = createSession({ getConfig: () => CONFIG, ctx, state, ensureQqMsgWorkspace, sessionWorkdir, callAdapterAction, describeError, isOwner: adminApi.isOwner });
  const toolsApi = createTools({ getConfig: () => CONFIG, state, ctx, callAdapterAction, describeError, toId: adminApi.toId, entryForAgent: sessionApi.entryForAgent, resolveAuthority: adminApi.resolveAuthority, hasPerm: adminApi.hasPerm, describeAuthority: adminApi.describeAuthority, groupInScope: adminApi.groupInScope, permissionList: adminApi.PERMISSION_LIST, runWebSearch, fetchUrlViaProxy, meFindMoli, meMoliFetchText, runImageSearch, uploadToHost, imgSearchSoutubotFile, imgSearchTraceMoeFile, meIsAllowedImageFile, downloadImage, askVision, qqMsgRootSync, currentAdapterPath });

  // -------------------------------------------------------------- 动态工具
  // 用动态 import 拿 defineTool：即使这个包不在，桥接本身照样工作，只是少一个工具。
  try {
    await toolsApi.registerTools();
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
    console.log(TAG + ' 未能监听配置热更新（不影响运行）：' + describeError(error));
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
