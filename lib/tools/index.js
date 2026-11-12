// 业务模块：9 个动态工具注册（qqbot/qqgroup/qq_websearch/qq_webfetch/qq_imgsearch/qq_history/qq_draw/qqconfig/qqauth）。
// 从 lib/index.js 拆出；依赖经 createTools(deps) 注入。registerTools() 动态 import defineTool 后逐工具注册。

import { generateImage, generationsUrl, saveImage, referenceToDataUrl } from './imagegen.js';
// 表情包图库：目标会话判定与系列名解析是纯函数，放在 sticker.js 里单测（见 test-sticker.mjs）。
import { resolveStickerTarget, seriesOfRel } from './sticker.js';
import { pickStickerSendStyle } from '../session/proactive.js';
import { currentConversationOf, resolveHistoryTarget, judgeHistoryAccess, buildHistoryRequest, normalizeHistory } from '../valve/security/history-auth.js';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve as pathResolve, sep as pathSep } from 'node:path';
import { checkCaller } from '../valve/security/owner-settings.js';
import { flowReasonZh } from '../gateway/commands.js';
// classifyMoliFailure 是模块级函数，拿不到 apply(deps) 里解构出来的 describeError——
// 以前这里漏了 import，于是「moli 渲染失败」的每条路径都会抛 ReferenceError，
// 用户看到的是一句莫名其妙的报错，而不是本该给出的诊断。类型检查把这条照出来了。
import { describeError } from '../config.js';
import { resolveTargetAuthority } from '../api/group-admin.js';
import { GROUP_ACTIONS, GROUP_ACTION_NAMES } from '../api/group-actions.js';
import { publicFetch } from '../shared/http.js';
import { createGuardProxy } from '../valve/network/guard-proxy.js';

/**
 * 本回合固化的发言人。entry.speaker 是「最近一条被接受的消息」，排队期间会被后到的消息覆盖；
 * 工具执行时读它，等于让晚到的访客改判已有回合的权限（0.12 之前就有的老问题）。
 * 有 turnSpeaker 就用它，没有再退回 speaker（控制台/边界场景）。
 */
function currentSpeaker(entry) {
  if (entry === null || entry === undefined) return null;
  const snap = entry.turnSpeaker;
  if (snap !== undefined && snap !== null) return snap;
  return entry.speaker === undefined ? null : entry.speaker;
}

/**
 * DSH 0.2 起 Cordis 的 Guard 规定：读写 ctx.tools 必须先声明 inject: ['tools']，
 * 直接 ctx.tools 会抛 "cannot get property 'tools' without inject"。
 * 本插件的 inject 里已声明 'tools'（见 gateway/plugin.js），所以它是**硬依赖**：拿不到就不会挂载。
 * 下面先 get('tools') 再退回 ctx.inject / 属性形态，只是兼容不同的挂载时序，不是「tools 可选」。
 */
/** 递归去掉 undefined：工具返回值要过宿主的 lossless JSON 检查，带 undefined 字段会被判 invalid。 */
export function sanitizeToolValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeToolValue).filter((v) => v !== undefined);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue;
      out[key] = sanitizeToolValue(child);
    }
    return out;
  }
  return value;
}

/** 注册前包一层：无论哪个 tool 漏了 undefined，都不会把 invalid output 交给宿主。 */
function withSanitizedOutput(def) {
  if (def === null || def === undefined || typeof def !== 'object' || typeof def.execute !== 'function') return def;
  const run = def.execute;
  const execute = async function (...args) { return sanitizeToolValue(await run.apply(this, args)); };
  try { def.execute = execute; return def; } catch { return { ...def, execute }; }
}

function registerTool(ctx, make) {
  const ready = (typeof ctx.get === 'function') ? ctx.get('tools') : undefined;
  if (ready !== undefined && ready !== null && typeof ready.register === 'function') {
    ctx.effect(() => ready.register(withSanitizedOutput(make())));
    return true;
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], (child) => {
      child.effect(() => child.get('tools').register(withSanitizedOutput(make())));
    });
    return false;
  }
  ctx.effect(() => ctx.tools.register(withSanitizedOutput(make())));
  return true;
}

/**
 * Moli 渲染的两道闸（只在 moli 分支生效，普通抓取不受影响）：
 *   1. 本地校验代理：moli 的全部流量先过内网 IP 黑名单，重定向 / 子资源 / 页面 JS 都算；
 *   2. 频率闸：每个会话每分钟最多渲染几次。
 */
let guardProxyInstance = null;
let guardProxyUpstream = null;
let guardProxyPending = null;

async function ensureGuardProxy(upstreamProxy, log) {
  const wanted = String(upstreamProxy === undefined || upstreamProxy === null ? '' : upstreamProxy);
  if (guardProxyInstance !== null && guardProxyUpstream === wanted) return guardProxyInstance.port();
  // 同一上游已经有实例在启动中：共享那一个 Promise。
  // 不共享的话，两个会话同时首渲染都会看到 guardProxyInstance === null，
  // 各起一个 server，后落定的覆盖模块变量，前一个连同监听端口一起泄漏（P1-3）。
  const pending = guardProxyPending;
  if (pending !== null && pending.upstream === wanted) return pending.promise;
  const task = (async () => {
    if (guardProxyInstance !== null) {
      try { await guardProxyInstance.stop(); } catch { /* 关不掉就算了 */ }
      guardProxyInstance = null;
    }
    const instance = createGuardProxy({ upstreamProxy: wanted, log });
    await instance.start();
    guardProxyInstance = instance;
    guardProxyUpstream = wanted;
    return instance.port();
  })();
  guardProxyPending = { upstream: wanted, promise: task };
  try {
    return await task;
  } finally {
    if (guardProxyPending !== null && guardProxyPending.promise === task) guardProxyPending = null;
  }
}

const RENDER_WINDOW_MS = 60 * 1000;
const renderHits = new Map();

// 全局并发闸（跨会话）：每会话的频率闸挡不住"10 个群各来一次"，
// 而一次渲染就是几十 MB 的无头浏览器进程（实测峰值约 47 MB）。
let renderActive = 0;

/**
 * 取一个渲染名额：成功返回 release 函数，满了返回 null。
 * limit 非正数/非数字 = 不限（与「0 = 不限」的配置语义一致）。
 */
function renderSlot(max) {
  const limit = Number(max);
  const cap = (Number.isFinite(limit) === true && limit > 0) ? Math.trunc(limit) : 0;
  if (cap === 0) return function () {};
  if (renderActive >= cap) return null;
  renderActive += 1;
  let released = false;
  return function () {
    if (released === true) return;
    released = true;
    renderActive -= 1;
  };
}

function renderQuota(entryKey, perMinute) {
  const limit = Number(perMinute);
  if (Number.isFinite(limit) !== true || limit <= 0) return { ok: true };
  const key = String(entryKey);
  const now = Date.now();
  const hits = (renderHits.get(key) || []).filter((t) => now - t < RENDER_WINDOW_MS);
  if (hits.length >= limit) {
    const waitSec = Math.max(1, Math.ceil((RENDER_WINDOW_MS - (now - hits[0])) / 1000));
    renderHits.set(key, hits);
    return { ok: false, waitSec };
  }
  hits.push(now);
  renderHits.set(key, hits);
  return { ok: true };
}

/**
 * moli 失败归一：把四种完全不同的失败分开，别让"守卫代理拦下"冒充页面正文。
 *
 * moli 带 --fail-with-body 跑：最终主文档状态码 >= 400 时退出码 22，响应体留在 stdout。
 * 守卫代理已经把语义拆开了（403 = 策略拒绝，502 = 上游/目标连不上），所以这里按状态码分流。
 * **为什么还要看 stderr**：https 走 CONNECT，隧道被拒时拿不到响应体（实测 stdout 为空），
 * 只有 moli 的 stderr 里那行 "returned HTTP status 502" 能说明是谁的问题。
 */
function classifyMoliFailure(url, error) {
  const exitCode = (error !== null && error !== undefined && typeof error.exitCode === 'number') ? error.exitCode : null;
  const stdout = (error !== null && error !== undefined && typeof error.stdout === 'string') ? error.stdout : '';
  const detail = describeError(error);
  const statusMatch = /HTTP status (\d{3})/.exec(detail);
  const status = statusMatch === null ? null : Number(statusMatch[1]);
  if (exitCode === 22) {
    if (status === 502 || /upstream unreachable/i.test(stdout) === true || /upstream unreachable/i.test(detail) === true) {
      return { ok: false, url, upstreamDown: true, via: 'moli 渲染', error: 'moli 渲染失败：上游代理不可达（守卫代理回 502）。到设置页卡片「高级设置」检查代理地址，或先关掉内网防护改用普通抓取（原因：' + detail + '）' };
    }
    if (status === 403 || /guard-proxy:\s*403/i.test(stdout) === true) {
      return { ok: false, url, blocked: true, via: 'moli 渲染', error: 'moli 渲染被内网防护拦下：目标不是公网地址（守卫代理 403）。要抓公网页面请换个地址；确实需要抓这台机器上的服务，只能在设置页卡片里关掉内网防护，但那会把访客渲染一并关掉' };
    }
    return { ok: false, url, httpError: true, via: 'moli 渲染', error: 'moli 渲染失败：目标返回 ' + String(status === null ? '4xx/5xx' : 'HTTP ' + String(status)) + '（' + detail + '）。要错误页正文的话，用普通抓取再看' };
  }
  if (stdout.trim() === '' && /timeout|timed out/i.test(detail) === false) {
    return { ok: false, url, emptyRender: true, via: 'moli 渲染', error: 'moli 渲染没有拿到任何内容：可能是上游代理不可达、页面要登录、或页面本身为空。可先试普通抓取，或到卡片里检查代理设置（原因：' + detail + '）' };
  }
  return { ok: false, url, via: 'moli 渲染', error: 'moli 渲染抓取失败：' + detail };
}

/** 抓取结果的统一截断：moli 渲染与普通抓取两条路径用同一份尾巴，别各写一遍。 */
function clipFetchedText(text, cap) {
  if (text.length <= cap) return text;
  return text.slice(0, cap) + '\n…（内容过长已截断）';
}

/**
 * qqbot send 的本地图片白名单：返回**可安全读取的真实路径**，不在白名单内返回 ''。
 *
 * 必须先 realpath 再比前缀——纯字符串比较挡不住符号链接：`qq-images/x.png -> /etc/passwd`
 * 的路径字符串完全在白名单里，readFileSync 却会读到目标，再把内容 base64 发进 QQ 会话。
 * 与 qq_imgsearch 的 meIsAllowedImageFile 同一口径（2026-10-29 注释审查补漏）。
 * 单独导出是为了能脱离工具上下文单测（见 test-imagegen.mjs 的符号链接段落）。
 */
export function resolveSendImagePath(imageArg, rootDir) {
  const realOf = (value) => { try { return realpathSync(value); } catch { return ''; } };
  const realRoot = (rootDir === '' || rootDir === undefined || rootDir === null) ? '' : realOf(String(rootDir));
  if (realRoot === '') return '';
  let absImg = '';
  try { absImg = pathResolve(String(imageArg)); } catch { return ''; }
  const realImg = realOf(absImg);
  if (realImg === '') return '';
  return (realImg === realRoot || realImg.startsWith(realRoot + pathSep)) ? realImg : '';
}

export function createTools(deps) {
  const { getConfig, state, ctx, callAdapterAction, describeError, toId, entryForAgent, net, resolveAuthority, hasPerm, describeAuthority, groupInScope, permissionList, runWebSearch, meFindMoli, meMoliFetchText, runImageSearch, uploadToHost, imgSearchSoutubotFile, imgSearchTraceMoeFile, meIsAllowedImageFile, downloadImage, askVision, qqMsgRootSync, currentAdapterPath, writeToAdapter, writeToAdapterAsync, ownerSettings, flowAuthApi, sticker, stickerGate, runProactiveTickFor } = deps;
  const TAG = '[dsh-qq-bot]';
  const cfg = () => getConfig();
  /** 拥有者 + 私聊：qqauth 工具与 moli 渲染抓取共用这一条判据。
   *  `/auth` 不走这里——它在 gateway/plugin.js 由 flowInterceptKind 判定。 */
  function ownerPrivateGate(entry) {
    if (entry === null || entry === undefined) return '只能在 QQ 会话里做授权';
    const who = currentSpeaker(entry);
    const speaker = (who !== null && who !== undefined) ? String(who.userId) : '';
    if (speaker === '') return '拿不到当前消息的发言人';
    const cfg = getConfig();
    const owners = Array.isArray(cfg.auth.owners) ? cfg.auth.owners.map((id) => String(id)) : [];
    if (owners.indexOf(speaker) < 0) return '只有拥有者能授权';
    // 用回合快照判私聊：entry.groupId 会被后到消息改写（perChatSession=false 时能借群回合冒充私聊）。
    if (who !== null && who !== undefined && who.groupId !== null && who.groupId !== undefined) return '授权只能在和拥有者的私聊里做';
    return '';
  }



  /** unix 秒 → 'HH:MM'（尽力而为，失败返回空串）。 */
  function fmtTime(unix) {
    if (typeof unix !== 'number' || !Number.isFinite(unix)) return '';
    try { return new Date(unix * 1000).toTimeString().slice(0, 5); } catch { return ''; }
  }

  /** 一条历史消息转文本（文本/图片/表情/语音/@ 摘要）。 */
  function summarizeHistoryMessage(m) {
    const segs = Array.isArray(m.message) ? m.message : null;
    if (segs !== null) {
      let text = '';
      for (const seg of segs) {
        if (seg === null || typeof seg !== 'object') continue;
        const type = String(seg.type ?? '').toLowerCase();
        const data = seg.data ?? {};
        if (type === 'text') text += String(data.text ?? '');
        else if (type === 'image') text += '[图片]';
        else if (type === 'at') text += '@' + String(data.qq ?? '') + ' ';
        else if (type === 'face') text += '[表情]';
        else if (type === 'record') text += '[语音]';
        else if (type === 'reply') text += '[回复]';
      }
      return text;
    }
    return typeof m.raw_message === 'string' ? m.raw_message : '';
  }

  async function registerTools() {
    const { defineTool } = await import('@deepseek-ai/dsh-tools');

    const tool = defineTool({
      name: 'qqbot',
      // 隐式引导（与 qq_sticker 同一套）：工具描述每轮请求都会下发，把「什么时候该主动用」
      // 写在这里等于零额外上下文地教会模型自己想起来，不用往会话提示词里塞东西。
      description: '查看或操作本地 QQ Bot 桥接（协议由插件设置里的 protocol 决定：OneBot 11/12、Satori、Milky、QQ 官方）。'
        + '有人问「bot 连上了吗」「现在有几个会话」「那条怎么没回」时，先 action="status" 查一眼再答，别凭猜。'
        + 'action="status" 查看连接状态与所有 QQ 会话；action="send" 主动发一条 QQ 消息（可选带一张本地图片）；'
        + 'action="interrupt" 中断某个（或全部）会话正在跑的回合；'
        + 'action="proactive" 立刻对某个群触发一次主动发言判定（调试用，必须给 target_id = 群号）。'
        + 'send / interrupt 只给拥有者（非 QQ 会话要开 admin.allowConsole）。',
      parameters: {
        action: { type: 'string', description: 'status | send | interrupt | proactive' },
        message_type: { type: 'string', description: 'send 用：group 或 private' },
        target_id: { type: 'string', description: 'send 用：QQ 群号或用户号；proactive 用：要触发的群号（必填）' },
        text: { type: 'string', description: 'send 用：消息正文（带 image 时可留空）' },
        image: { type: 'string', description: 'send 用：可选，本地图片绝对路径（只允许 QQ_msg/qq-images 目录内）' },
        conversation: { type: 'string', description: 'interrupt 用：会话键（group-123 / private-456）或 all' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        const action = (args !== null && args !== undefined && typeof args.action === 'string') ? args.action : '';
        // 这个工具能往任意 QQ 发消息、也能掐断任意会话的回合：只给拥有者。
        // 以前它同时被放进了访客白名单，等于群成员一句提示注入就能让 bot 变成任意发言机。
        const callerEntry = entryForAgent(exec !== null && exec !== undefined ? exec.agent : null);
        const owners = Array.isArray(cfg().auth.owners) ? cfg().auth.owners.map((id) => String(id)) : [];
        // proactive 也会真的往群里发消息，和外发动作同等对待（只给拥有者）。
        const outwardAction = action === 'send' || action === 'interrupt' || action === 'proactive';
        if (callerEntry === null || callerEntry === undefined) {
          // 非 QQ 会话（Web UI / 任务板 / 子代理）以前整段跳过拥有者判断，等于谁都能用它
          // 往任意群发消息、掐断任意会话的回合。status 是只读的照旧给看，外发动作与 qqgroup
          // 用同一条判据：默认不许，开了 admin.allowConsole 才许。
          if (outwardAction === true && cfg().admin.allowConsole !== true) {
            return { ok: false, error: 'qqbot 的 send / interrupt 只能在 QQ 会话里用（Web UI 会话要开 admin.allowConsole）' };
          }
        } else {
          const who = currentSpeaker(callerEntry);
          const callerId = (who !== null && who !== undefined && who.userId !== null && who.userId !== undefined) ? String(who.userId) : '';
          if (owners.indexOf(callerId) < 0) return { ok: false, error: 'qqbot 只给拥有者用（非拥有者请直接说话，或用 qq_history 看记录）' };
        }

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
            mode: cfg().mode,
            onebot: { wsUrl: cfg().onebot.wsUrl, listen: cfg().onebot.listen, httpUrl: cfg().onebot.httpUrl },
            adapter: { path: currentAdapterPath(), pid: state.adapterPid, listenPort: state.listenPort, restarts: state.restarts },
            runtime: {
              dsh: state.dsh && state.dsh.version ? state.dsh.version : null,
              supportingRange: state.dsh ? state.dsh.floor + ' <= v < ' + state.dsh.ceiling : null,
              compatible: state.dsh ? state.dsh.supported : null,
              note: state.dsh && state.dsh.reason ? state.dsh.reason : null,
            },
            workspace: qqMsgRootSync(),
            policy: {
              groups: { enabled: cfg().group.enabled, requireAt: cfg().group.requireAt, allow: cfg().group.allow },
              private: { enabled: cfg().private.enabled, allow: cfg().private.allow },
              perChatSession: cfg().perChatSession,
            },
            stats: {
              inbound: state.stats.inbound, accepted: state.stats.accepted, skipped: state.stats.skipped,
              replies: state.stats.replies, chunksSent: state.stats.chunks, errors: state.stats.errors, guestBlocked: state.stats.guestBlocked,
              // 这四项以前只增不读：排障最想看的「群管理执行了几次」「被流程授权拦了几次」恰好看不到。
              admin: state.stats.admin, actions: state.stats.actions, notices: state.stats.notices, flowBlocked: state.stats.flowBlocked,
            },
            conversations,
          };
        }

        if (action === 'proactive') {
          // 调试钩子：手动对指定群触发一次主动发言判定，走同一套 proactiveConsiderGroup。
          if (typeof runProactiveTickFor !== 'function') return { ok: false, error: '主动发言模块未提供调试入口' };
          const gid = String(args.target_id === undefined || args.target_id === null ? '' : args.target_id).trim();
          if (gid === '') return { ok: false, error: 'proactive 需要 target_id（群号）' };
          const result = await runProactiveTickFor(gid);
          return Object.assign({ action: 'proactive' }, result);
        }
        if (action === 'send') {
          const messageType = args.message_type === 'group' ? 'group' : 'private';
          const targetId = (args.target_id === null || args.target_id === undefined) ? '' : String(args.target_id);
          const text = typeof args.text === 'string' ? args.text : '';
          const imageArg = (typeof args.image === 'string' && args.image.trim() !== '') ? args.image.trim() : '';
          if (targetId === '') return { ok: false, error: 'send 需要 target_id' };
          if (text === '' && imageArg === '') return { ok: false, error: 'send 需要 text 或 image' };
          if (imageArg !== '') {
            // 本地图片：只允许 QQ_msg/qq-images 目录内。**比 qq_imgsearch 松**：那边还会 realpath
            // 解符号链接、并限定当前会话子目录；这里只做前缀比较（见下方 realpath 补强）。
            // 读盘转 base64 交给适配器；适配器本来就支持 message 段数组（qq_draw 同样走这条路）。
            let imgRootDir = '';
            try { imgRootDir = pathResolve(qqMsgRootSync(), 'qq-images'); } catch (error) { imgRootDir = ''; }
            // 判定与读取用同一个路径：resolveSendImagePath 返回的是 realpath 之后的结果，
            // 校验的和读到的必然是同一个文件（不会出现「校验时还没换链接」的窗口）。
            const imgPath = resolveSendImagePath(imageArg, imgRootDir);
            if (imgPath === '') {
              return { ok: false, error: 'image 只允许 QQ_msg/qq-images 目录下的图片（拒绝：' + imageArg + '）' };
            }
            let dataUrl = '';
            try {
              // 适配器只认 base64:// 前缀，不带 mime：读出来的字节直接拼上即可。
              const buf = readFileSync(imgPath);
              dataUrl = 'base64://' + buf.toString('base64');
            } catch (error) {
              return { ok: false, error: '读图失败：' + describeError(error) };
            }
            const segments = [];
            if (text !== '') segments.push({ type: 'text', data: { text } });
            segments.push({ type: 'image', data: { file: dataUrl } });
            const written = await writeToAdapterAsync({ type: 'send', message_type: messageType, target_id: targetId, text, message: segments }, 15000);
            return {
              ok: written, message_type: messageType, target_id: targetId, image: imgPath, connected: state.connected,
            };
          }
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
    const qqbotImmediate = registerTool(ctx, () => tool);
    console.log(TAG + ' 已注册 qqbot 工具' + (qqbotImmediate ? '' : '（等待 tools 服务就绪后挂载）'));

    const configTool = defineTool({
      name: 'qqconfig',
      description: '【仅拥有者私聊可用】修改本插件的运行时设置。'
        + '主人问「现在某个设置是多少 / 开没开」时先 action="show" 看当前值再答，别猜。'
        + 'action="show" 列出可改项和当前值；action="propose" 预约一次改动（path + value，只校验不写盘，返回一次性 token 和改动预览）；'
        + 'action="apply" 凭 token 真正落盘（走 DSH 设置服务，自动热重载）；action="cancel" 撤销预约。'
        + '安全策略：只有拥有者本人在私聊里能调用；密钥、NapCat 连接、拥有者名单等敏感项一律拒绝；'
        + 'propose 的 token 5 分钟内一次性有效，期间设置被别处改过就作废。',
      parameters: {
        action: { type: 'string', description: 'show | propose | apply | cancel' },
        path: { type: 'string', description: 'propose 用：设置路径，如 group.allow、proactive.enabled、proactive.groups' },
        value: { type: 'string', description: 'propose 用：新值。布尔写 true/false；整数直接写数字；QQ 号列表写 ["123456789","987654321"] 或逗号分隔；时段写 ["23:00-08:00"]；文本直接写' },
        token: { type: 'string', description: 'apply / cancel 用：propose 返回的确认码' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        const action = (args !== null && args !== undefined && typeof args.action === 'string') ? args.action : '';
        const entry = entryForAgent(exec !== null && exec !== undefined ? exec.agent : null);
        const gate = checkCaller(getConfig(), entry);
        if (gate.ok !== true) return { ok: false, code: gate.code, error: gate.error };
        if (ownerSettings === undefined || ownerSettings === null) {
          return { ok: false, error: '设置通道未初始化' };
        }
        if (action === 'show') return await ownerSettings.show(gate.ownerId);
        if (action === 'cancel') return ownerSettings.cancel(gate.ownerId, args.token);
        if (action === 'apply') return await ownerSettings.apply(gate.ownerId, args.token);
        if (action === 'propose') {
          const rawValue = args.value;
          let value = rawValue;
          if (typeof rawValue === 'string') {
            const trimmed = rawValue.trim();
            if (trimmed.startsWith('[') || trimmed.startsWith('{') || trimmed.startsWith('"')) {
              try { value = JSON.parse(trimmed); } catch (error) { value = rawValue; }
            }
          }
          return await ownerSettings.propose(gate.ownerId, args.path, value);
        }
        return { ok: false, error: '未知 action ' + JSON.stringify(action) };
      },
    });
    registerTool(ctx, () => configTool);
    console.log(TAG + ' 已注册 qqconfig 工具（仅拥有者私聊）');

    // 方案 A：让 Agent 自己调群管理。授权看「本会话最近一条消息是否来自白名单」，
    // 而不是让模型自己判断，避免群里的普通成员用一句话就驱动踢人。
    const groupTool = defineTool({
      name: 'qqgroup',
      description: 'QQ 群管理／查询（动作按 OneBot 风格下发，由当前协议适配器翻译；QQ 官方 API 不支持群管理）。action 取值：' + GROUP_ACTION_NAMES.join(' | ') + '。'
        + '被问「这个群多少人」「他是不是管理员」「群名片是什么」这类事时直接查（group-info / member-list / member-info），不用等用户喊指令。'
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
        const admin = cfg().admin;
        if (admin.enabled !== true) return { ok: false, error: '管理功能未启用（admin.enabled=false）' };
        // 与 QQ 侧指令走同一套三路鉴权：静态名单 / 动态授权 / 本群身份。
        // 「说话人」来自本会话最近一条消息，所以群里普通成员无法靠一句话驱动管理动作。
        const entry = entryForAgent(exec.agent);
        const speaker = currentSpeaker(entry);
        if (speaker === null || speaker === undefined) {
          if (admin.allowConsole !== true) {
            return { ok: false, error: '未授权：无法确定调用者身份（非 QQ 会话）；确需从控制台调用请打开 admin.allowConsole' };
          }
        }
        const authority = (speaker === null || speaker === undefined)
          ? { tier: 'owner', owner: true, userId: 'console', groupId: null, perms: new Set(permissionList), sources: ['控制台(allowConsole)'] }
          : await resolveAuthority(speaker.userId, speaker.groupId);

        const action = typeof args.action === 'string' ? args.action : '';
        const groupId = (args.group_id === undefined || args.group_id === null || String(args.group_id) === '')
          ? (entry !== null && entry.groupId !== null ? entry.groupId : null)
          : String(args.group_id);
        const uid = (args.user_id === undefined || args.user_id === null || String(args.user_id) === '') ? null : String(args.user_id);
        const dur = Math.min(Math.max(0, Math.round(Number(args.duration === undefined ? 600 : args.duration))), 43200);
        const want = args.enable !== false;

        // 跨群防护：动作目标是群 B、说话人在群 A 时，权限必须按**目标群**重算。
        // 默认 manageGroups / group.allow 为空让 groupInScope 对所有群为真，
        // 少了这一步就是「A 群管理员一句话把 B 群全员禁言」。
        const targetAuthority = await resolveTargetAuthority(authority, speaker, groupId, resolveAuthority);

        const def = GROUP_ACTIONS[action];
        if (def === undefined) {
          return { ok: false, error: '未知 action：' + JSON.stringify(action), available: GROUP_ACTION_NAMES.slice() };
        }
        const needed = def.permission;
        if (hasPerm(targetAuthority, needed) !== true) {
          return { ok: false, error: '缺少权限：' + needed + '｜' + describeAuthority(targetAuthority) };
        }

        const plan = def.build({
          groupId,
          uid,
          durationSec: dur,
          text: args.text,
          enable: want,
          messageId: args.message_id,
        });
        if (plan === null) return { ok: false, error: '缺少必要参数（group_id / user_id / text / message_id）' };
        if (groupId !== null && !groupInScope(groupId)) return { ok: false, error: '群 ' + groupId + ' 不在可管理范围内' };
        // 撤回要绑定群：delete_msg 只认 message_id，不按群隔离，能删到别的群的消息。
        if (action === 'recall') {
          const looked = await callAdapterAction('get_msg', { message_id: Number(plan.params.message_id) }, 8000);
          const msgGroup = (looked !== null && looked !== undefined && looked.ok === true && looked.data
            && looked.data.group_id !== undefined && looked.data.group_id !== null) ? String(looked.data.group_id) : '';
          if (msgGroup === '' || msgGroup !== String(groupId)) {
            return { ok: false, error: '只能撤回本群消息（目标消息不在群 ' + String(groupId) + '）' };
          }
        }
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
    const groupImmediate = registerTool(ctx, () => groupTool);
    console.log(TAG + ' 已注册 qqgroup 工具' + (groupImmediate ? '' : '（等待 tools 服务就绪后挂载）'));

    // 联网搜索包装：插件进程内直接调 DeepSeek web search（不依赖 agent 侧 run_code）。
    // 访客白名单默认含 qq_websearch，所以访客也能联网查证，而 DSH 底层工具仍被闸隔离。
    const wsTool = defineTool({
      name: 'qq_websearch',
      description: '联网搜索（DeepSeek web search）：按关键词搜索网页，返回带摘录的来源列表（url/title/snippet）。'
        + '拿不准的事实就先搜再答，别凭记忆编：人物/物品身份、时事、版本号、价格、评分、番剧/作品信息、专有名词都算；'
        + '用户问「真的吗」「查一下」「现在呢」时更该搜。调用前把问题提炼成简洁关键词，结果不够就换词多搜几次。'
        + '抓取指定网页请用 qq_webfetch（本工具只负责搜索）。',
      parameters: {
        query: { type: 'string', description: '搜索关键词（提炼后的短语）' },
        max_uses: { type: 'number', description: '最多搜索轮数（1-10，默认 5）' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        const query = (args !== null && args !== undefined && typeof args.query === 'string') ? args.query.trim() : '';
        if (query === '') return { ok: false, error: 'qq_websearch 需要 query 关键词' };
        const maxUses = Number(args !== null && args !== undefined ? args.max_uses : NaN);
        // 偶发的传输/解码失败重试一次，仍失败再返回错误给模型。
        let lastError = '';
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const sources = await runWebSearch(query, cfg().webSearch ?? {}, Number.isFinite(maxUses) ? maxUses : undefined, ctx);
            if (sources.length === 0) return { ok: true, count: 0, sources: [], text: '（搜索无结果）' };
            const text = sources.map((s, i) => (i + 1) + '. ' + (s.title ? s.title : s.url)
              + '\n   ' + s.url + (s.snippet ? '\n   ' + s.snippet : '')).join('\n');
            return { ok: true, count: sources.length, sources, text };
          } catch (error) {
            lastError = describeError(error);
            if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }
        return { ok: false, error: lastError };
      },
    });
    registerTool(ctx, () => wsTool);
    console.log(TAG + ' 已注册 qq_websearch 工具');

    // 网页抓取（qq_webfetch）：从 qq_websearch 拆出的 url 抓取，独立工具。
    // 出网策略（用不用代理、用哪个）由网络阀门决定，本工具只声明「这次要出网」；
    // moli.enabled 时改用 Moli 无头浏览器渲染抓取（moli 自己的代理配置不归阀门管，见下方分支）。
    const webFetchTool = defineTool({
      name: 'qq_webfetch',
      description: '抓取指定网页的原文/渲染文本（http/https，仅公网；出网代理由插件统一策略决定）。'
        + '聊天里有人丢链接（尤其只发一条 URL）、或搜索摘要不够回答时，主动抓正文读完再回，别只复述标题。'
        + '配置 moli.enabled 时改用 Moli 无头浏览器渲染抓取（可抓 SPA/JS 渲染页，需已安装并启用 dsh-moli 插件）。',
      parameters: {
        url: { type: 'string', description: '要抓取的网页地址（http/https，仅公网）' },
        max_chars: { type: 'number', description: '最多返回字符数（默认 40000）' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        const url = (args !== null && args !== undefined && typeof args.url === 'string') ? args.url.trim() : '';
        if (url === '') return { ok: false, error: 'qq_webfetch 需要 url（要抓取的网页地址）' };
        const wsCfg = (cfg().webSearch !== null && cfg().webSearch !== undefined) ? cfg().webSearch : {};
        const moliCfg = (cfg().moli !== null && cfg().moli !== undefined) ? cfg().moli : {};
        let cap = 40000;
        if (args !== null && args !== undefined) {
          const n = Math.floor(Number(args.max_chars));
          if (Number.isFinite(n) && n > 0) cap = n;
        }
        // Moli 是无头浏览器：它会跟随 3xx、加载子资源、跑页面里的 JS fetch。
        // 放行判据分两档：
        //   1. 拥有者私聊：一直可用（主人自己的机器，不需要额外条件）；
        //   2. QQ 会话里的访客（群聊 / 别人的私聊）：可用，但**必须挂着内网校验代理**——
        //      没有 guardProxy 就没有第二道闸，那种情况下继续只给拥有者。
        // 非 QQ 会话（Web UI / 任务板 / 子代理）仍然不放行：渲染是几十 MB 一次的重操作，
        // 模型循环里反复调用比群成员手动触发的风险大得多。
        const moliEntry = entryForAgent(exec !== null && exec !== undefined ? exec.agent : null);
        const moliOwnerPrivate = ownerPrivateGate(moliEntry) === '';
        // 访客要同时满足两个独立开关：允许访客渲染（allowGuest）+ 内网防护开着（guardProxy）。
        // 前者是"给不给用"，后者是"用的时候有没有第二道闸"，两者互不替代。
        const moliGuestOk = moliEntry !== null && moliEntry !== undefined
          && moliCfg.allowGuest !== false && moliCfg.guardProxy !== false;
        const moliAllowed = moliCfg.enabled === true && (moliOwnerPrivate === true || moliGuestOk === true);
        if (moliCfg.enabled === true && moliAllowed !== true) {
          let why = '非 QQ 会话';
          if (moliEntry !== null && moliEntry !== undefined) {
            why = moliCfg.allowGuest === false ? '「允许访客渲染」已关' : '访客渲染但内网防护已关';
          }
          console.log(TAG + ' moli 渲染本次未放行（' + why + '），退回普通抓取');
        }
        if (moliAllowed === true) {
          // 参数面复刻 dsh-moli 1.1.20：exePath / proxy / defaultTimeoutMs / maxChars / insecureTls，
          // 没配的项按它自己的默认值走（代理留空则透传 webSearch.proxy）。
          const quota = renderQuota(moliEntry === null || moliEntry === undefined ? 'console' : moliEntry.key, moliCfg.rateLimitPerMin);
          if (quota.ok !== true) {
            const limit = Number(moliCfg.rateLimitPerMin);
            return { ok: false, url, rateLimited: true, error: 'moli 渲染太频繁：本会话每分钟最多 ' + String(limit) + ' 次，请 ' + String(quota.waitSec) + ' 秒后再试（普通抓取不受限）' };
          }
          const moliExePath = (typeof moliCfg.exePath === 'string') ? moliCfg.exePath.trim() : '';
          if (meFindMoli(moliExePath) === undefined) {
            return { ok: false, url, moliUnavailable: true, error: 'Moli 引擎未找到（标准位置与 PATH 里都没有 moli 可执行文件）：先用 dsh-moli 装好引擎，再点设置页卡片的「检测」；引擎装在别处的话，在卡片「高级设置」里填引擎路径' };
          }
          const moliProxy = (typeof moliCfg.proxy === 'string') ? moliCfg.proxy.trim() : '';
          // moli 的「上游代理」是覆盖/透传语义（用户显式配置，不归网络阀门管）：
          // 自己的 moli.proxy 优先，留空则透传 webSearch.proxy。普通抓取路径完全不碰这个值。
          const moliUpstream = moliProxy !== '' ? moliProxy : ((typeof wsCfg.proxy === 'string') ? wsCfg.proxy.trim() : '');
          // 全局并发闸：跨会话的上限。超了直接回忙，不排队——
          // 排队会把等待时间算进 moli 自己的 -t 里，反而更容易超时。
          const releaseRender = renderSlot(moliCfg.maxConcurrentRenders);
          if (releaseRender === null) {
            const capRun = Number(moliCfg.maxConcurrentRenders);
            return { ok: false, url, busy: true, error: 'moli 渲染正忙：全局同时最多 ' + String(capRun) + ' 个在跑（可在卡片「高级设置」里调这个上限），请过几秒再试；普通抓取不受这条限制' };
          }
          try {
            // 内网防护：默认把 moli 的全部流量收进本地校验代理（用户配的代理作为它的上游）。
            let guardPort = 0;
            if (moliCfg.guardProxy !== false) {
              try {
                guardPort = await ensureGuardProxy(moliUpstream, (line) => console.log(TAG + line));
              } catch (error) {
                return { ok: false, url, error: '内网防护代理启动失败：' + describeError(error) + '（可在设置页卡片「高级设置」里关掉内网防护）' };
              }
            }
            try {
              const got = await meMoliFetchText(url, {
                proxy: moliUpstream,
                guardPort: guardPort,
                timeoutMs: moliCfg.defaultTimeoutMs,
                maxChars: moliCfg.maxChars,
                exePath: moliExePath,
                insecureTls: moliCfg.insecureTls === true,
              });
              const text = clipFetchedText(String(got ?? ''), cap);
              // 空输出不再当成功：moli 拿到 200 却渲染不出内容时，多半是页面要登录/纯壳，
              // 也可能上游代理已经断了——两种情况都不该让模型以为"页面就是空的"。
              if (text === '') return classifyMoliFailure(url, { exitCode: null, stdout: '', stderr: '渲染结果为空' });
              return { ok: true, url, via: 'moli 渲染', text };
            } catch (error) {
              return classifyMoliFailure(url, error);
            }
          } finally {
            releaseRender();
          }
        }
        try {
          // 意图：走代理（阀门决定用哪个；没配代理时阀门自己直连）。
          // 只认阀门的「接口一：网络流量管控」——工具不持有代理串，只说意图。
          const egress = (net !== null && net !== undefined && net.traffic !== null && net.traffic !== undefined)
            ? net.traffic : null;
          if (egress === null || typeof egress.fetchText !== 'function') {
            return { ok: false, url, error: '网络阀门未装配：qq_webfetch 需要 valves.network 注入才能抓取' };
          }
          const got = await egress.fetchText(url, { useProxy: true, timeoutMs: 15000 });
          const text = clipFetchedText(typeof got.text === 'string' ? got.text : '', cap);
          return { ok: got.status >= 200 && got.status < 300, url, status: got.status, via: 'http', text: text === '' ? '（抓取到空响应体）' : text };
        } catch (error) {
          return { ok: false, url, error: '抓取失败：' + describeError(error) };
        }
      },
    });
    registerTool(ctx, () => webFetchTool);
    console.log(TAG + ' 已注册 qq_webfetch 工具');

    // 图片反搜：全部请求走 multiEngineRequest → 与 qq_websearch 同一套出网策略（网络阀门）。
    const imgTool = defineTool({
      name: 'qq_imgsearch',
      description: '图片反搜（Reverse Image Search）：给定公网图片 URL 或本地图片文件，返回来源列表（url/title/snippet）。'
        + '有人发图并问「这是谁」「出自哪」「什么梗」，或图里的内容认不出来时，主动反搜再答；聊天里贴的公网图片 URL 直接传 url。'
        + '本地文件会先上传图床（zixiaoyun/scdn/uguu 加权随机）拿公网 URL 再反搜；上传失败回退文件直传 TraceMoe。'
        + '引擎：TraceMoe/IQDB（直连）+ Yandex/Tineye/Copyseeker/SauceNAO（代理）。'
        + 'kind=comic 时优先 Soutubot（搜图Bot酱，本子/漫画局部）+ SauceNAO，通用引擎兜底。'
        + '全部请求走出网统一策略（代理由插件决定，留空直连、非空走 http 代理）。',
      parameters: {
        url: { type: 'string', description: '公网图片 URL（http/https，仅公网地址；与 file 二选一）' },
        file: { type: 'string', description: '本地图片文件路径（限 qq-images 目录内；与 url 二选一）' },
        max_results: { type: 'number', description: '最多返回结果数（1-10，默认 5）' },
        kind: { type: 'string', description: '搜索模式：auto（默认，通用引擎排序）/ comic（漫画/本子截图，优先 Soutubot+SauceNAO）' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        const imageUrl = (args !== null && args !== undefined && typeof args.url === 'string') ? args.url.trim() : '';
        const filePath = (args !== null && args !== undefined && typeof args.file === 'string') ? args.file.trim() : '';
        // 本地文件只允许「当前会话自己落盘的图」+ 共用的生成图目录（见 meIsAllowedImageFile）。
        const callerEntry = entryForAgent(exec !== null && exec !== undefined ? exec.agent : null);
        const callerSessionId = (callerEntry !== null && callerEntry !== undefined && callerEntry.sessionId) ? callerEntry.sessionId : '';
        if (imageUrl === '' && filePath === '') return { ok: false, error: 'qq_imgsearch 需要 url（公网图片地址）或 file（本地图片路径）' };
        const imgCfg = (cfg().imgSearch !== null && cfg().imgSearch !== undefined) ? cfg().imgSearch : {};
        if (imgCfg.enabled === false) return { ok: false, error: 'imgSearch 已关闭（设置页可开启）' };
        // 设置页那个「每次最多几条」以前是装饰：这里写死从 5 起算。
        let cap = Number.isFinite(Number(imgCfg.maxResults)) ? Math.max(1, Math.min(10, Math.floor(Number(imgCfg.maxResults)))) : 5;
        if (args !== null && args !== undefined) {
          const n = Math.floor(Number(args.max_results));
          if (Number.isFinite(n)) cap = Math.max(1, Math.min(10, n));
        }
        try {
          const opts = {
            saucenaoKey: cfg().imgSearch && typeof cfg().imgSearch.saucenaoKey === 'string' ? cfg().imgSearch.saucenaoKey.trim() : '',
            weightedShuffle: cfg().imgSearch && cfg().imgSearch.weightedShuffle === true,
            kind: typeof args.kind === 'string' ? args.kind.trim() : '',
            net,   // 引擎可用性要问阀门（有没有配代理），不给工具自己判断
          };
          let sources;
          let via = '';
          if (opts.kind === 'comic' && imageUrl === '' && filePath !== '') {
            // 漫画模式 + 本地文件：soutubot 直接传文件（不上图床），失败/无结果回退 TraceMoe 文件直传。
            if (!meIsAllowedImageFile(filePath, callerSessionId)) return { ok: false, error: 'file 仅允许本会话在 qq-images 下的图片（或共用的 gen 目录），拒绝：' + filePath };
            try {
              sources = await imgSearchSoutubotFile(filePath, cap);
              via = 'soutubot 直传文件';
            } catch (error) {
              via = 'soutubot 直传失败（' + (error instanceof Error ? error.message : String(error)) + '），回退 TraceMoe 文件直传';
            }
            if (!Array.isArray(sources) || sources.length === 0) sources = await imgSearchTraceMoeFile(filePath, cap);
          } else if (imageUrl !== '') {
            sources = await runImageSearch(imageUrl, cap, opts);
          } else {
            if (!meIsAllowedImageFile(filePath, callerSessionId)) return { ok: false, error: 'file 仅允许本会话在 qq-images 下的图片（或共用的 gen 目录），拒绝：' + filePath };
            let uploaded = null;
            let uploadError = '';
            try { uploaded = await uploadToHost(filePath); } catch (error) { uploadError = error instanceof Error ? error.message : String(error); }
            if (uploaded !== null) {
              via = '图床(' + uploaded.host + ') ' + uploaded.url;
              sources = await runImageSearch(uploaded.url, cap, opts);
            } else {
              via = '图床上传失败，回退文件直传 TraceMoe（' + uploadError + '）';
              sources = await imgSearchTraceMoeFile(filePath, cap);
            }
          }
          if (sources.length === 0) return { ok: true, count: 0, sources: [], via, text: '（未找到匹配来源）' };
          const text = sources.map((s, i) => (i + 1) + '. ' + (s.title ? s.title : s.url)
            + '\n   ' + s.url + (s.snippet ? '\n   ' + s.snippet : '')).join('\n');
          return { ok: true, count: sources.length, sources, via, text };
        } catch (error) {
          return { ok: false, error: describeError(error) };
        }
      },
    });
    registerTool(ctx, () => imgTool);
    console.log(TAG + ' 已注册 qq_imgsearch 工具');
    // 聊天记录工具（qq_history）：AI 主动拉取群聊历史与图片（替代自动硬塞上下文）。
    // 图片识别窗口锚定「最新提及」那条消息（触发本条回复的 @bot/回复bot/命令前缀），
    // 往前 scopeMessages 条内的图片才识别，最多 imageLimit 张（最近的优先）；
    // 更早的 @ 不锚定、其附近图片不因「也是被提及」而识别，避免重复拉取/重复识图。
    const historyTool = defineTool({
      name: 'qq_history',
      description: '读取 QQ 聊天记录（只读）：返回结构化消息列表（时间 / 说话人 / 文本 / 图片 URL），默认当前会话。'
        + '上下文接不上时自己翻：出现「刚才」「上面那条」「之前那张图」这类指代、或有人问以前聊过什么，'
        + '就直接拉最近记录补齐（图片一并识别），不用等用户开口要求。'
        + '主动调用时按权限取：当前群或当前私聊可直接读；跨群需要「拥有者、高级管理员」，或「你本身就是该群管理员且该群在可管理范围」；'
        + '别人的私聊只有拥有者/高级管理员能读。分页用 before_seq（上一页最旧的 message_id），返回的 next_before 就是下一页游标。'
        + '图片识别只锚定「触发本条回复的那条消息」往前最多 scopeMessages 条、最多 imageLimit 张（最近优先）。',
      parameters: {
        group_id: { type: 'string', description: '群号（默认当前群；跨群需相应权限）' },
        peer_id: { type: 'string', description: '私聊对象 QQ 号（默认当前私聊；别人的私聊仅拥有者/高级管理员，且需 before_seq）' },
        user_id: { type: 'string', description: '只拉某个用户的发言（仅群聊，可选）' },
        count: { type: 'number', description: '拉取消息条数（默认 20，上限 50）' },
        before_seq: { type: 'number', description: '分页游标：上一页最旧消息的 message_id（留空 = 最新一页）' },
        with_images: { type: 'boolean', description: '是否识别锚点窗口内图片（默认 true）' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        // 会话/锚点来自执行上下文（entryForAgent 从 state.convos 反查），而不是闭包自由变量。
        const entry = entryForAgent(exec !== null && exec !== undefined ? exec.agent : null);
        if (entry === null || entry === undefined) return { ok: false, error: '无法确定当前 QQ 会话（qq_history 仅在 QQ 会话内可用）' };
        const frame = entry.currentFrame !== null && entry.currentFrame !== undefined ? entry.currentFrame : null;
        // 身份必须取本回合固化的发言人：entry.currentFrame 会被后到的消息覆盖，
        // 竞态下访客就能借主人身份读跨群历史（判定结果直接变成「拥有者」）。
        const who = currentSpeaker(entry) || frame;
        const requester = (who !== null && who !== undefined && who.userId !== null && who.userId !== undefined)
          ? String(who.userId)
          : (entry.userId !== null && entry.userId !== undefined ? String(entry.userId) : '');
        // 「当前会话」同样必须取本回合快照：perChatSession=false 时所有聊天共用一个 entry，
        // entry.currentFrame 会被后到的消息覆盖 —— 晚到的 A 群消息就能把 B 群访客的回合认成
        // 「正在 A 群」，从而跳过下面那道跨会话鉴权，直接读到 A 群历史。
        const snapGroupId = (who !== null && who !== undefined && who.groupId !== null && who.groupId !== undefined) ? String(who.groupId) : '';
        const snapUserId = (who !== null && who !== undefined && who.userId !== null && who.userId !== undefined) ? String(who.userId) : '';
        const current = snapGroupId !== ''
          ? { kind: 'group', id: snapGroupId }
          : (snapUserId !== '' ? { kind: 'private', id: snapUserId } : currentConversationOf(entry, frame));
        if (current === null) return { ok: false, error: '无法确定当前会话类型（群聊/私聊）' };
        const argGroup = (args !== null && args !== undefined && typeof args.group_id === 'string') ? args.group_id : '';
        const argPeer = (args !== null && args !== undefined && typeof args.peer_id === 'string') ? args.peer_id : '';
        const targetResult = resolveHistoryTarget({ argGroup, argPeer, current });
        if (targetResult.error !== undefined) return { ok: false, error: targetResult.error };
        const target = targetResult.target;
        // 鉴权：当前会话直接读；跨会话要拥有者/高级管理员，或「目标群管理员 + 目标群在可管理范围」。
        let access = { allowed: true, scope: 'current', reason: '当前会话' };
        if (!(target.kind === current.kind && target.id === current.id)) {
          const authority = await resolveAuthority(requester, current.kind === 'group' ? current.id : null);
          let targetAuthority = null;
          let withinScope = true;
          if (target.kind === 'group') {
            withinScope = groupInScope(target.id);
            targetAuthority = await resolveAuthority(requester, target.id);
          }
          access = judgeHistoryAccess({ target, current, authority, targetAuthority, withinScope });
          if (access.allowed !== true) {
            return { ok: false, error: '没有权限读取该范围的历史消息', reason: access.reason, requester, target };
          }
        }
        const filterUid = (args !== null && args !== undefined && typeof args.user_id === 'string') ? args.user_id.trim() : '';
        let count = 20;
        if (args !== null && args !== undefined) {
          const n = Math.floor(Number(args.count));
          if (Number.isFinite(n)) count = Math.max(1, Math.min(50, n));
        }
        const withImages = !(args !== null && args !== undefined && args.with_images === false);
        const histCfg = (cfg().history !== null && cfg().history !== undefined) ? cfg().history : {};
        const scopeMessages = Math.max(1, Math.floor(Number.isFinite(histCfg.scopeMessages) ? histCfg.scopeMessages : 5));
        const imageLimit = Math.max(1, Math.floor(Number.isFinite(histCfg.imageLimit) ? histCfg.imageLimit : 3));
        let beforeSeq = NaN;
        if (args !== null && args !== undefined && args.before_seq !== undefined && args.before_seq !== null && args.before_seq !== '') {
          const seq = Math.floor(Number(args.before_seq));
          if (Number.isFinite(seq)) beforeSeq = seq;
        }
        const frameMessageId = (frame !== null && frame.message_id !== null && frame.message_id !== undefined) ? Math.floor(Number(frame.message_id)) : NaN;
        if (target.kind === 'private' && (current.kind !== 'private' || String(target.id) !== String(current.id)) && !Number.isFinite(beforeSeq)) {
          return { ok: false, error: '读取其他私聊历史需要 before_seq（该会话里的一条消息 id）', target, requester };
        }
        const request = buildHistoryRequest({ target, count, beforeSeq, anchorId: frameMessageId });
        if (request.error !== undefined) return { ok: false, error: request.error, target };
        // 1) 拉历史（统一归一化成新→旧）
        let rawMessages = [];
        const failPrefix = target.kind === 'group' ? '拉取群历史失败：' : '拉取私聊历史失败：';
        try {
          const result = await callAdapterAction(request.action, request.params, 8000);
          if (result.ok === true && result.data !== null && result.data !== undefined && Array.isArray(result.data.messages)) {
            rawMessages = normalizeHistory(result.data.messages, request.paged === true);
          } else if (result.ok !== true) {
            // 动作失败必须如实报出来：以前这里什么都不做，最后变成「ok:true, count:0」，
            // 看起来像「这个群没有历史」，把超时 / 适配器错误全吞掉了。
            return { ok: false, target, error: failPrefix + String(result.error === undefined || result.error === null || result.error === '' ? '适配器未返回结果' : result.error) };
          } else if (result.data === null || result.data === undefined || !Array.isArray(result.data.messages)) {
            return { ok: false, target, error: failPrefix + '适配器返回的格式不对（没有 messages 数组）' };
          }
        } catch (error) {
          return { ok: false, target, error: failPrefix + describeError(error) };
        }
        if (rawMessages.length === 0) return { ok: true, target, access, count: 0, messages: [], scope: { scopeMessages, imageLimit } };
        // 2) 锚点：触发本条回复的那条消息（entry.currentFrame，acceptMessage 记录）
        const anchorFrame = (entry !== null && entry !== undefined && entry.currentFrame) || null;
        const anchorId = anchorFrame && anchorFrame.message_id !== null && anchorFrame.message_id !== undefined ? Number(anchorFrame.message_id) : null;
        const anchorTime = anchorFrame && typeof anchorFrame.time === 'number' ? anchorFrame.time : null;
        let anchorIndex = 0;
        if (anchorId !== null) {
          const found = rawMessages.findIndex((m) => m !== null && typeof m === 'object' && Number(m.message_id) === anchorId);
          if (found >= 0) anchorIndex = found;
        }
        if (anchorId === null || !rawMessages.some((m) => m !== null && typeof m === 'object' && Number(m.message_id) === anchorId)) {
          // 触发消息不在历史里（如超窗/被清）：退化为按时间找最接近的一条。
          if (anchorTime !== null) {
            let best = -1, bestDiff = Infinity;
            for (let i = 0; i < rawMessages.length; i += 1) {
              const m = rawMessages[i];
              if (m === null || typeof m !== 'object') continue;
              const t = typeof m.time === 'number' ? m.time : null;
              if (t === null) continue;
              const diff = Math.abs(t - anchorTime);
              if (diff < bestDiff) { bestDiff = diff; best = i; }
            }
            if (best >= 0) anchorIndex = best;
          }
        }
        const anchorMsg = rawMessages[anchorIndex];
        // 3) 窗口：[anchorIndex, anchorIndex + scopeMessages - 1]（新→旧，往旧方向；固定锚点，更早的 @ 不会扩窗）
        const windowStart = anchorIndex;
        const windowEnd = Math.min(rawMessages.length - 1, anchorIndex + scopeMessages - 1);
        // 4) 组装 messages + 收集窗口内图片（最近的优先；对象引用共享，识别后 description 自动回填）
        const messages = [];
        const windowImages = [];
        for (let i = 0; i < rawMessages.length; i += 1) {
          const m = rawMessages[i];
          if (m === null || typeof m !== 'object') continue;
          const senderId = (m.user_id !== undefined && m.user_id !== null) ? String(m.user_id)
            : (m.sender !== null && m.sender !== undefined && m.sender.user_id !== null && m.sender.user_id !== undefined ? String(m.sender.user_id) : '');
          if (filterUid !== '' && senderId !== filterUid) continue;
          const inWindow = i >= windowStart && i <= windowEnd;
          const images = [];
          if (withImages && inWindow && Array.isArray(m.message)) {
            for (const seg of m.message) {
              if (seg === null || typeof seg !== 'object') continue;
              if (String(seg.type ?? '').toLowerCase() !== 'image') continue;
              const url = (seg.data && typeof seg.data.url === 'string') ? seg.data.url : '';
              if (url === '' || !/^https?:\/\//.test(url)) continue;
              const img = { url };
              images.push(img);
              if (windowImages.length < imageLimit) windowImages.push(img);
            }
          }
          messages.push({
            time: fmtTime(m.time),
            user_id: senderId,
            nickname: (m.sender !== null && m.sender !== undefined && typeof m.sender === 'object' && typeof m.sender.nickname === 'string') ? m.sender.nickname : '',
            text: summarizeHistoryMessage(m),
            images,
          });
        }
        // 5) 窗口内图片识别（最近的优先，最多 imageLimit 张；失败只给 URL 不阻塞）
        const vision = (cfg().vision !== null && cfg().vision !== undefined) ? cfg().vision : {};
        if (vision.enabled === true && windowImages.length > 0) {
          const provider = (typeof vision.provider === 'string' && vision.provider !== '') ? vision.provider
            : (entry && entry.agent && entry.agent.options && typeof entry.agent.options.provider === 'string' ? entry.agent.options.provider : '');
          const model = (typeof vision.model === 'string' && vision.model !== '') ? vision.model
            : (entry && entry.agent && entry.agent.options && typeof entry.agent.options.model === 'string' ? entry.agent.options.model : '');
          const attachments = ctx.attachments;
          const timeoutMs = vision.downloadTimeoutMs ?? 10000;
          if (provider !== '' && model !== '' && attachments !== undefined && attachments !== null && typeof attachments.saveImage === 'function') {
            for (let k = 0; k < windowImages.length; k += 1) {
              const img = windowImages[k];
              try {
                const downloaded = await downloadImage(img.url, timeoutMs);
                if (downloaded === null) { img.description = '（图片下载失败）'; continue; }
                const ref = await attachments.saveImage({ data: downloaded.data, mediaType: downloaded.mediaType });
                const text = await askVision(provider, model, ref, { index: k + 1, isOwn: false, where: '聊天记录里' });
                img.description = text !== '' ? text : '（图片识别无返回）';
              } catch (error) {
                console.log(TAG + ' qq_history 图片识别失败（给 URL 不阻塞）：' + describeError(error));
                img.description = '（图片识别失败）';
              }
            }
          } else if (provider === '' || model === '') {
            for (const img of windowImages) img.description = '（图片视觉未配置 provider/model，仅给 URL）';
          } else {
            for (const img of windowImages) img.description = '（图片视觉附件服务不可用，仅给 URL）';
          }
        }
        const oldest = rawMessages.length > 0 ? rawMessages[rawMessages.length - 1] : null;
        return {
          ok: true,
          target,
          access,
          count: messages.length,
          next_before: oldest !== null && oldest !== undefined && oldest.message_id !== undefined && oldest.message_id !== null ? oldest.message_id : null,
          anchor: { message_id: anchorMsg && typeof anchorMsg.message_id !== 'undefined' ? anchorMsg.message_id : null, time: anchorMsg ? fmtTime(anchorMsg.time) : '' },
          scope: { scopeMessages, imageLimit },
          messages,
        };
      },
    });
    registerTool(ctx, () => historyTool);
    console.log(TAG + ' 已注册 qq_history 工具');

    // ---- 生图（qq_draw）：用户自填接口，失败重试 + 异步任务轮询 ----
    const drawTool = defineTool({
      name: 'qq_draw',
      description: '按文字描述画一张图（调用设置里填写的生图 API），可直接发到当前 QQ 会话。'
        + '用户说「画一个」「来张图」「生成一张」或聊到某个画面很适合出图时，直接画好发过去，别反问「要不要画」；一次一张，别刷屏。'
        + '画之前先把画面想清楚：主体、动作、场景、风格、光线。'
        + '接口地址 / key / 模型 / 重试次数在「插件 → 已安装 → QQ 机器人 → 能力 → 识图与绘图」里配，配置缺失时本工具会明确报错。',
      parameters: {
        prompt: { type: 'string', required: true, description: '画面描述（越具体越好）' },
        model: { type: 'string', description: '模型 id（留空 = 设置里的默认模型）' },
        size: { type: 'string', description: '尺寸，如 1024x1024 / 1024x1536（留空 = 设置里的默认值）' },
        reference: { type: 'string', description: '参考图：公网 URL，或 qq-images 目录下的本地图片（保持同一人物形象用）' },
        caption: { type: 'string', description: '发图时一起说的那句话（留空 = 只发图）' },
        send: { type: 'boolean', description: '是否直接发到当前 QQ 会话（默认 true）' },
        message_type: { type: 'string', description: 'group 或 private（默认当前会话）' },
        target_id: { type: 'string', description: '群号或 QQ 号（默认当前会话）' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        // 这个工具会把图发到参数指定的任意群/人，和 qqbot 同级；非 QQ 会话默认不许，
        // 只在开启了 admin.allowConsole 时才放行（否则 Web UI 会话/子代理都能拿它当外发通道）。
        const drawCaller = entryForAgent(exec !== null && exec !== undefined ? exec.agent : null);
        if ((drawCaller === null || drawCaller === undefined) && cfg().admin.allowConsole !== true) {
          return { ok: false, error: 'qq_draw 只能在 QQ 会话里用（Web UI 会话要开 admin.allowConsole）' };
        }
        // 除了「在 QQ 会话里」，还必须是拥有者本人：它会烧生图额度、并以 bot 身份把图发出去。
        // 只靠访客白名单兜不住——主人一旦把它加进 auth.guestToolAllow，任何群成员都能用。
        const drawWho = (drawCaller === null || drawCaller === undefined) ? null : currentSpeaker(drawCaller);
        if (drawWho !== null && drawWho !== undefined) {
          const drawOwners = Array.isArray(cfg().auth.owners) ? cfg().auth.owners.map((id) => String(id)) : [];
          if (drawOwners.indexOf(String(drawWho.userId)) < 0) {
            return { ok: false, error: 'qq_draw 只给拥有者用（生图额度与 bot 身份外发都算主人的）' };
          }
        }
        const conf = (cfg().imageGen !== null && cfg().imageGen !== undefined) ? cfg().imageGen : {};
        if (conf.enabled !== true) return { ok: false, error: '生图未启用：到「插件 → 已安装 → QQ 机器人 → 能力 → 识图与绘图」打开开关' };
        const prompt = (typeof args.prompt === 'string') ? args.prompt.trim() : '';
        if (prompt === '') return { ok: false, error: 'prompt 不能为空' };
        if (generationsUrl(conf.baseUrl) === '') {
          return { ok: false, error: '未填写生图 API 地址（插件 → 已安装 → QQ 机器人 → 能力 → 识图与绘图 → 生图 API 地址）' };
        }
        let apiKey = (typeof conf.apiKey === 'string') ? conf.apiKey : '';
        if (apiKey === '') {
          const envName = (typeof conf.apiKeyEnv === 'string' && conf.apiKeyEnv !== '') ? conf.apiKeyEnv : 'IMAGE_API_KEY';
          const fromEnv = process.env[envName];
          apiKey = (typeof fromEnv === 'string') ? fromEnv : '';
        }
        let reference = null;
        if (typeof args.reference === 'string' && args.reference.trim() !== '') {
          try { reference = await referenceToDataUrl(args.reference, qqMsgRootSync() + '/qq-images'); }
          catch (error) { return { ok: false, error: describeError(error) }; }
        }
        const result = await generateImage({
          baseUrl: conf.baseUrl,
          apiKey: apiKey,
          model: (typeof args.model === 'string' && args.model !== '') ? args.model : (conf.model || ''),
          size: (typeof args.size === 'string' && args.size !== '') ? args.size : (conf.size || ''),
          prompt: prompt,
          reference: reference === null ? null : [reference],
          timeoutMs: conf.timeoutMs,
          maxAttempts: conf.maxAttempts,
          retryIntervalMs: conf.retryIntervalMs,
          poll: conf.poll !== false,
          pollIntervalMs: conf.pollIntervalMs,
          maxPolls: conf.maxPolls,
          // 会话回合被取消/中断时立刻停掉请求，不再等满「超时 × 重试次数 + 轮询」。
          signal: (exec !== null && exec !== undefined && exec.signal !== undefined) ? exec.signal : undefined,
          onLog: (line) => console.log(TAG + '[qq_draw] ' + line),
        });
        if (result.ok !== true) return { ok: false, error: result.error, attempts: result.attempts };

        let bytes = null;
        try {
          if (typeof result.b64 === 'string' && result.b64 !== '') {
            bytes = Buffer.from(result.b64, 'base64');
          } else if (typeof result.url === 'string' && result.url !== '') {
            // 生图接口返回的 url 同样是外部输入：走 publicFetch（公网校验 + 上限），不直连。
            const res = await publicFetch(result.url, { binary: true, timeoutMs: 30000, maxBytes: 8 * 1024 * 1024 });
            if (res.status < 200 || res.status >= 300) return { ok: false, error: '图片下载失败 HTTP ' + res.status };
            bytes = Buffer.from(res.body);
          }
        } catch (error) {
          return { ok: false, error: '获取图片失败：' + describeError(error) };
        }
        if (bytes === null || bytes.length === 0) return { ok: false, error: '接口没有返回图片数据' };

        let saved = '';
        try { saved = await saveImage(qqMsgRootSync() + '/qq-images/gen', bytes); }
        catch (error) { return { ok: false, error: '存图失败：' + describeError(error) }; }

        if (args.send === false) {
          return { ok: true, saved_path: saved, bytes: bytes.length, attempts: result.attempts, sent: false };
        }
        const entry = entryForAgent(exec !== null && exec !== undefined ? exec.agent : null);
        const isGroup = (args.message_type === 'group')
          || (args.message_type !== 'private' && entry !== null && entry !== undefined && entry.groupId !== null && entry.groupId !== undefined);
        const messageType = isGroup ? 'group' : 'private';
        let targetId = (typeof args.target_id === 'string') ? args.target_id : '';
        if (targetId === '' && entry !== null && entry !== undefined) {
          if (messageType === 'group') targetId = String(entry.groupId === null || entry.groupId === undefined ? '' : entry.groupId);
          else { const who = currentSpeaker(entry); targetId = String(who !== null && who !== undefined ? who.userId : ''); }
        }
        if (targetId === '') {
          return { ok: true, saved_path: saved, bytes: bytes.length, attempts: result.attempts, sent: false,
            warning: '不知道要发到哪个会话，图已存到本地' };
        }
        const message = [];
        const caption = (typeof args.caption === 'string') ? args.caption.trim() : '';
        if (caption !== '') message.push({ type: 'text', data: { text: caption } });
        message.push({ type: 'image', data: { file: 'base64://' + bytes.toString('base64') } });
        const written = await writeToAdapterAsync({ type: 'send', message_type: messageType, target_id: targetId, message: message }, 15000);
        return {
          ok: true, saved_path: saved, bytes: bytes.length, attempts: result.attempts,
          sent: written === true, message_type: messageType, target_id: targetId,
        };
      },
    });
    registerTool(ctx, () => drawTool);
    console.log(TAG + ' 已注册 qq_draw 工具');

    // 表情包图库：目录即库（子目录 = 系列），索引写在目录根部的 index.json。
    // 「首次使用 / 文件内容有变动」时的哈希比对与自动打标全在 lib/tools/sticker.js 里，
    // 这里只负责挑图、发图、重建三件事；重建会吃视觉模型的 token，所以只给拥有者。
    if (sticker !== undefined && sticker !== null) {
      const stickerTool = defineTool({
        name: 'qq_sticker',
        description: '本机表情包图库（目录 + 索引 + AI 自动打标）。'
          // 隐式引导：不往会话提示词里加任何东西，靠工具描述告诉模型「什么时候该自己想起来用它」。
          // 「每轮都调一次」是本插件的核心约定：发不发交给闸门（概率 / 每小时上限 / 同图去重），
          // 判断权不留在模型手里——实测它会把整轮判成「正经场合」连着跳过，等于没有概率闸可言。
          + '**每次回复前都先调一次 action="send"** 把话说给闸门听，不用等用户开口要；'
          + '发不发由闸门（概率 / 每小时上限 / 同图去重）决定，被挡掉就当没配图，正文照常说，'
          + '不要因为被挡就去改关键词重试。一次最多一张，别刷屏。'
          + 'action="list" 看有哪些系列、各多少张、多少张还没打标；'
          + 'action="search" 按关键词/系列找图（返回 id、标签、描述）；'
          + 'action="send" 把选中的一张表情包发进当前 QQ 会话（id 与 query 二选一，一次一张；'
          + '用户明确要求时传 force=true，会被概率/去重闸门挡住时也能发）；'
          + 'action="rebuild" 重新扫描目录：按文件内容哈希比对，只重建有变动的图并给新图打标（仅拥有者）。'
          + '第一次用会自动建索引，不会重复吃模型的 token。',
        parameters: {
          action: { type: 'string', description: 'list | search | send | rebuild' },
          query: { type: 'string', description: 'search/send 用：关键词（标签/描述/文件名，空格分隔多个词）' },
          series: { type: 'string', description: 'search/send 用：限定某个系列（子目录名）' },
          limit: { type: 'number', description: 'search 用：最多返回几张（默认 8，上限 20）' },
          id: { type: 'string', description: 'send 用：表情包 id（就是索引里的相对路径，如 猫猫/无语.jpg）' },
          text: { type: 'string', description: 'send 用：可选，跟图一起发的一句文字' },
          force: { type: 'boolean', description: 'send 用：用户明确要求发表情包时传 true，跳过概率与去重闸门（每小时上限仍生效）' },
          tag: { type: 'boolean', description: 'rebuild 用：是否顺带自动打标（默认 true）' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        async execute(args, exec) {
          const conf = cfg().sticker === undefined || cfg().sticker === null ? {} : cfg().sticker;
          if (conf.enabled !== true) {
            return { ok: false, error: '表情包功能未开启：到「插件 → 已安装 → QQ 机器人 → 能力 → 表情包」打开开关' };
          }
          const action = (args !== null && args !== undefined && typeof args.action === 'string') ? args.action : '';
          const entry = entryForAgent(exec !== null && exec !== undefined ? exec.agent : null);

          if (action === 'rebuild') {
            // 重建 = 扫盘 + 可能打标（花 token），只给拥有者；Web UI 会话要开 admin.allowConsole。
            if (entry === null || entry === undefined) {
              if (cfg().admin.allowConsole !== true) return { ok: false, error: '重建表情包索引只能在 QQ 拥有者会话里做（Web UI 要开 admin.allowConsole）' };
            } else {
              const who = currentSpeaker(entry);
              const callerId = (who !== null && who !== undefined && who.userId !== null && who.userId !== undefined) ? String(who.userId) : '';
              const owners = Array.isArray(cfg().auth.owners) ? cfg().auth.owners.map((id) => String(id)) : [];
              if (owners.indexOf(callerId) < 0) return { ok: false, error: '重建表情包索引只给拥有者用（其他人可以直接让 bot 发表情）' };
            }
            const result = sticker.startRebuild({ tag: args !== undefined && args !== null && args.tag === false ? false : true });
            return { ok: true, action: 'rebuild', started: result.started, job: result.job, dir: sticker.resolveDir() };
          }

          // list / search / send：先过一遍「首次使用或有变动就重建索引」的轻量流程
          //（只算哈希，打标丢后台；拿不到模型也不会卡住这次调用）。
          const fresh = await sticker.ensureFresh();
          if (fresh.ok !== true) return fresh;

          if (action === 'list' || action === 'status') {
            const st = await sticker.status();
            return Object.assign({ ok: true, action: 'list' }, st, {
              pendingNote: st.untagged > 0 && st.job !== null && st.job.running === true ? '正在后台自动打标' : '',
            });
          }

          if (action === 'search') {
            const items = sticker.search({
              q: typeof args.query === 'string' ? args.query : '',
              series: typeof args.series === 'string' ? args.series : '',
              limit: Number(args.limit),
            });
            const st = await sticker.status();
            return { ok: true, action: 'search', count: items.length, items, untagged: st.untagged, dir: st.dir };
          }

          if (action === 'send') {
            const id = typeof args.id === 'string' ? args.id.trim() : '';
            const query = typeof args.query === 'string' ? args.query.trim() : '';
            if (id === '' && query === '') return { ok: false, error: 'send 需要 id 或 query：先用 search 挑一张' };
            const picked = sticker.pick({ id, q: query, series: typeof args.series === 'string' ? args.series : '' });
            if (picked === null) {
              return { ok: false, error: '没有找到这张表情包（id 不存在，或关键词没有命中）。先用 action="search" 看看索引里有什么' };
            }
            const target = resolveStickerTarget(entry);
            if (target === null) return { ok: false, error: '不知道要发到哪个会话（qq_sticker 只能在 QQ 会话里用）' };
            // 闸门：概率（force 可跳过）+ 每群每小时上限 + 同图去重。
            // 「每轮对话都配上」会变成刷图，所以默认 chance=0.3；用户明确要求时传 force=true。
            const gate = (stickerGate !== undefined && stickerGate !== null && typeof stickerGate.decide === 'function')
              ? stickerGate.decide({ groupId: target.targetId, id: picked.item.file, force: args.force === true })
              : { allowed: true, reason: '' };
            // 被闸门挡掉不是「调用失败」：ok:true + sent:false，模型看到就知道这轮不配图、
            // 正文照常说即可。用 ok:false 会让它误判成出错，去改关键词重试（既费 token 又刷屏）。
            if (gate.allowed !== true) return { ok: true, action: 'send', sent: false, skipped: true, reason: gate.reason };
            let dataUrl = '';
            try {
              const buf = readFileSync(picked.path);
              dataUrl = 'base64://' + buf.toString('base64');
            } catch (error) {
              return { ok: false, error: '读图失败：' + describeError(error) };
            }
            const caption = typeof args.text === 'string' ? args.text : '';
            const image = { type: 'image', data: { file: dataUrl } };
            // 发送方式随机：图文合并一条 / 先图后字两条（与主动发言同一套观感）
            const style = caption !== '' ? pickStickerSendStyle() : 'together';
            let written;
            if (style === 'separate') {
              const imageOk = writeToAdapter({ type: 'send', message_type: target.messageType, target_id: target.targetId, message: [image] });
              written = imageOk === true
                ? writeToAdapter({ type: 'send', message_type: target.messageType, target_id: target.targetId, text: caption })
                : false;
            } else {
              written = writeToAdapter({ type: 'send', message_type: target.messageType, target_id: target.targetId, text: caption, message: [image] });
            }
            if (written === true && typeof stickerGate === 'object' && stickerGate !== null && typeof stickerGate.record === 'function') {
              stickerGate.record({ groupId: target.targetId, id: picked.item.file });
            }
            return {
              ok: written === true,
              action: 'send',
              style,
              sent: { id: picked.item.file, series: seriesOfRel(picked.item.file), tags: picked.item.tags, desc: picked.item.desc },
              message_type: target.messageType,
              target_id: target.targetId,
              error: written === true ? undefined : '适配器未连接，图没有发出去',
            };
          }

          return { ok: false, error: '未知 action ' + JSON.stringify(action) + '（可选 list / search / send / rebuild）' };
        },
      });
      registerTool(ctx, () => stickerTool);
      console.log(TAG + ' 已注册 qq_sticker 工具');
    }

    // 流程授权：被 subagent / spawn_teammate / workflow 的闸门拦下时，由模型主动申请。
    // 只认拥有者本人 + 私聊（群里叫不动），和 /auth 拦截是同一条链路的两个入口。
    const authTool = defineTool({
      name: 'qqauth',
      description: '流程授权（私聊 6 位动态码）管理。action="request"：请主人私聊回一次动态码（子代理 / 队友 / 工作流被拦下时调它）；'
        + 'action="status"：看开关、待授权数量与活动流程；action="enroll"：只回一条「去服务器跑 CLI」的指引，'
        + '密钥本身不经 QQ（防止聊天记录泄露就等于拿到授权）。只有拥有者本人在私聊里能调用。',
      parameters: {
        action: { type: 'string', description: 'request | status | enroll' },
        purpose: { type: 'string', description: 'request 用：一句话说明要跑什么（会出现在私聊提示里）' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        const action = (args !== null && args !== undefined && typeof args.action === 'string') ? args.action : '';
        const entry = entryForAgent(exec !== null && exec !== undefined ? exec.agent : null);
        const blocked = ownerPrivateGate(entry);
        if (blocked !== '') return { ok: false, error: blocked };
        if (flowAuthApi === undefined || flowAuthApi === null) return { ok: false, error: '流程授权未初始化' };
        if (action === 'status') {
          return {
            ok: true,
            enabled: flowAuthApi.enabled() === true,
            active: flowAuthApi.active(),
            counters: flowAuthApi.status(),
          };
        }
        if (action === 'request') {
          if (flowAuthApi.enabled() !== true) return { ok: false, error: '流程授权没有开启（设置页 → 高级 → 流程授权）' };
          const purpose = (args !== null && args !== undefined && typeof args.purpose === 'string') ? args.purpose : '';
          const result = await flowAuthApi.request(purpose, entry, entry === null ? null : entry.currentFrame);
          if (result.ok !== true) return { ok: false, reason: result.reason, error: '申请被拒：' + flowReasonZh(result.reason) };
          return { ok: true, hint: '已在主人私聊里发起授权请求；主人回 /auth 动态码后，重试刚才被拦下的工具即可（一次一用）。' };
        }
        if (action === 'enroll') {
          // 密钥绝不从聊天通道出去：动态码是「持有即可放行」，密钥一旦过 QQ 就等于泄露，撤回也追不回。
          return {
            ok: false,
            error: '密钥不经 QQ 导入：在服务器上跑 node lib/valve/security/totp-cli.mjs enroll，它会直接打印二维码，用认证器 App 扫码离线绑定（或把 secret 粘进设置页）',
          };
        }
        return { ok: false, error: '未知 action ' + JSON.stringify(action) };
      },
    });
    registerTool(ctx, () => authTool);
    console.log(TAG + ' 已注册 qqauth 工具（仅拥有者私聊）');
  }

  return { registerTools };
}
