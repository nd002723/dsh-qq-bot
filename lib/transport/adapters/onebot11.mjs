#!/usr/bin/env node
/**
 * OneBot 11 协议适配器（插件自带，零 npm 依赖）。
 *
 * 传输（可同时开）：
 *   正向 WS：  --ws ws://127.0.0.1:3001      我们主动连 NapCat（同机/同容器最简单）
 *   反向 WS：  --listen 0.0.0.0:6199         NapCat 连进来（跨容器/跨网络更好用）
 *   HTTP API： --http http://127.0.0.1:3000  用它发消息；不填则退回 WS action
 *
 * 与插件之间的 stdio 契约见 lib/transport/bridge/CONTRACT.md。
 * 本文件只负责 OneBot 11 的语义：CQ 码/段数组归一、send_group_msg 等动作、群管理透传。
 */
import process from 'node:process';
import { createEmitter, createSendQueue, installStdin, installCrashHandlers, postJson } from '../bridge/stdio.mjs';
import { createLinkSet, connectForward, startReverseServer, bearerOrQueryToken } from '../bridge/ws.mjs';
import { summarizeSegments } from '../../message/segments.mjs';

// ------------------------------------------------------------------ 参数

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = 'true';
    else { out[key] = next; i += 1; }
  }
  return out;
}

const argv = parseArgs(process.argv.slice(2));
const WS_URL = argv.ws ?? process.env.ONEBOT_WS_URL ?? '';
const LISTEN = argv.listen ?? process.env.ONEBOT_LISTEN ?? '';
const HTTP_URL = String(argv.http ?? process.env.ONEBOT_HTTP_URL ?? '').replace(/\/+$/, '');
const ACCESS_TOKEN = argv.token ?? process.env.ONEBOT_ACCESS_TOKEN ?? '';
const HEARTBEAT_MS = Number(argv['heartbeat-ms'] ?? 30000);
const SEND_GAP_MS = Number(argv['send-gap-ms'] ?? 350);

// ------------------------------------------------------------------ 输出与链路

const { emit, log, fail } = createEmitter();
const pendingActions = new Map();
/** link -> 最后一次收到任何帧的时间戳（半开检测用）。 */
const lastInboundAt = new WeakMap();
let heartbeatTimer = null;
let shuttingDown = false;
let lastReason = '';

let forward = null;

const links = createLinkSet({
  onStatus: (info) => {
    if (info.event === 'add') log('链路已连接：' + info.label + '（当前 ' + info.size + ' 条）');
    else log('链路断开：' + info.label + '（剩余 ' + info.size + ' 条）', 'warn');
    setStatus();
    if (info.event === 'add') startHeartbeat();
  },
});

function setStatus(reason) {
  const connected = links.active() !== null;
  if (connected) lastReason = '';
  else if (reason !== undefined) lastReason = reason;
  emit({ type: 'status', connected, reason: lastReason || null, links: links.size(), mode: LISTEN !== '' ? 'reverse' : 'forward' });
}

const queue = createSendQueue({ gapMs: SEND_GAP_MS, send: (action, params) => callApi(action, params), emit });

// ------------------------------------------------------------------ 正向 / 反向

if (WS_URL !== '') {
  forward = connectForward({
    url: WS_URL,
    token: ACCESS_TOKEN,
    linkSet: links,
    onText: (link, text) => onLinkMessage(link, text),
    onOpen: (info) => {
      if (info !== null && info !== undefined && info.link !== undefined && info.link !== null) lastInboundAt.set(info.link, Date.now());
      log('正向 WS 已连接 ' + WS_URL);
      setStatus('');
    },
    onClose: (info) => setStatus('closed(' + String(info.code ?? '?') + ')'),
    onError: (info) => {
      if (info.phase === 'retry') log('正向 WS ' + info.delayMs + 'ms 后重连' + (info.reason ? '（' + info.reason + '）' : ''), 'warn');
      else if (info.phase === 'create') fail('正向 WS 建立失败：' + String(info.error && info.error.message ? info.error.message : info.error));
      else if (info.phase === 'socket') log('正向 WS 连接出错（' + String(info.reason || 'socket') + '），等待重连', 'warn');
    },
  });
}

if (LISTEN !== '') {
  startReverseServer({
    listen: LISTEN,
    // 没配 token 时由 ws.mjs 强制收回到回环：反向端口上的帧能直接冒充任意 QQ 号。
    allowPublic: ACCESS_TOKEN !== '',
    authorize: bearerOrQueryToken(ACCESS_TOKEN),
    onText: (link, text) => onLinkMessage(link, text),
    onClose: (link) => { link.ready = false; links.remove(link); },
    onReady: (link) => {
      links.add(link);
      // 和真实 OneBot 实现一致：连上先发一条 lifecycle
      link.send(JSON.stringify({
        post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect',
        time: Math.floor(Date.now() / 1000),
      }));
    },
    onListening: (info) => {
      log('反向 WS 监听 ' + info.host + ':' + info.port + '（在 NapCat 里填 ws://<本机IP>:' + info.port + '/）');
      emit({ type: 'listening', host: info.host, port: info.port });
    },
    onError: (text) => fail(text),
  });
}

// ------------------------------------------------------------------ 心跳

function startHeartbeat() {
  stopHeartbeat();
  if (HEARTBEAT_MS <= 0) return;
  heartbeatTimer = setInterval(() => {
    const link = links.active();
    // 每拍给父进程一帧存活信号：父进程据此判断适配器是否还活着（不靠杀进程）。
    emit({ type: 'tick', at: Date.now(), connected: link !== null, links: links.size() });
    if (link === null) return;
    // 半开连接的判据：TCP 不报错、close 不触发，只有「发了 N 个心跳一个回执都没收到」能看出来。
    // 以前这里只发 get_status、从不看结果，对端静默掉线后适配器会一直自报 connected。
    const seen = lastInboundAt.get(link) ?? 0;
    if (seen > 0 && Date.now() - seen > HEARTBEAT_MS * 3) {
      log('链路超过 ' + String(Math.round((Date.now() - seen) / 1000)) + ' 秒没有任何入站数据，主动断开等待重连');
      lastInboundAt.delete(link);
      try { link.close(); } catch { /* 已经关了 */ }
      return;
    }
    link.send(JSON.stringify({ action: 'get_status', echo: 'hb-' + Date.now() }));
  }, HEARTBEAT_MS);
  if (heartbeatTimer.unref) heartbeatTimer.unref();
}

function stopHeartbeat() {
  if (heartbeatTimer !== null) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

// ------------------------------------------------------------------ 事件归一

function cqToText(raw) {
  return raw.replace(/\[CQ:([a-zA-Z0-9_]+)((?:,[^\]]*)?)\]/g, (_m, rawType, params) => {
    const type = String(rawType).toLowerCase();
    const val = (n) => { const f = new RegExp(',' + n + '=([^,]*)').exec(params ?? ''); return f ? f[1] : ''; };
    switch (type) {
      case 'at': { const qq = val('qq'); return qq === 'all' ? '@全体成员 ' : qq ? '@' + qq + ' ' : ''; }
      case 'image': return '[图片]';
      case 'face': return '[表情]';
      case 'record': return '[语音]';
      case 'video': return '[视频]';
      case 'file': return '[文件]';
      case 'reply': return '';
      case 'json': case 'xml': return '[卡片消息]';
      case 'forward': return '[合并转发]';
      case 'mface': return '[表情]';
      case 'poke': return '[戳一戳]';
      default: return '';
    }
  });
}

/**
 * message（CQ 字符串或段数组）-> { text, images, imageUrls, replyTo, mentions }
 *
 * mentions 两条路径都必须给：准入判定（requireAt）只认它，不看正文。CQ 字符串这条要是漏了，
 * 插件会退回「正文里出现 @机器人QQ 就算点名」的正则兜底——用户手打一串 @ 就能过 requireAt，
 * 正是 2026-10-28 审计 A1 要堵的那个洞（2026-10-29 注释审查补漏）。
 */
function normalizeMessage(message) {
  if (Array.isArray(message)) return summarizeSegments(message);
  if (typeof message === 'string') {
    // [CQ:at,qq=10001] / [CQ:at,qq=all]：与段数组路径的 atQqsOf 保持同一口径（all 原样保留）。
    const mentions = [];
    for (const m of message.matchAll(/\[CQ:at,qq=([^,\]]+)/gi)) mentions.push(m[1]);
    const imageUrls = [];
    for (const m of message.matchAll(/\[CQ:image[^\]]*\]/gi)) {
      const seg = m[0];
      const urlMatch = /url=([^,\]]+)/.exec(seg);
      const fileMatch = /file=([^,\]]+)/.exec(seg);
      const u = (urlMatch !== null ? urlMatch[1] : '') || (fileMatch !== null ? fileMatch[1] : '');
      if (u !== '') imageUrls.push(u);
    }
    const replyMatch = /\[CQ:reply,[^\]]*id=(\d+)/.exec(message);
    return {
      text: cqToText(message),
      images: (message.match(/\[CQ:image/gi) ?? []).length,
      imageUrls,
      replyTo: replyMatch !== null ? Number(replyMatch[1]) : null,
      mentions,
    };
  }
  return { text: '', images: 0, imageUrls: [], replyTo: null, mentions: [] };
}

function onLinkMessage(_link, raw) {
  // 半开检测的唯一依据：只要对端还在说话（任何帧），这条链路就是活的。
  if (_link !== null && _link !== undefined) lastInboundAt.set(_link, Date.now());
  let payload;
  try { payload = JSON.parse(raw); } catch { return; }
  if (payload === null || typeof payload !== 'object') return;

  if (payload.echo !== undefined && payload.post_type === undefined) {
    const pending = pendingActions.get(String(payload.echo));
    if (pending !== undefined) {
      pendingActions.delete(String(payload.echo));
      const retcode = typeof payload.retcode === 'number' ? payload.retcode : null;
      const ok = payload.status === 'ok' || retcode === 0;
      pending.resolve({
        ok, retcode,
        messageId: payload.data && payload.data.message_id !== undefined ? payload.data.message_id : null,
        data: payload.data !== undefined ? payload.data : null,
        error: ok ? null : String(payload.message ?? payload.wording ?? 'retcode ' + String(retcode)),
      });
    }
    return;
  }

  const postType = payload.post_type;
  if (postType === 'meta_event') {
    if (payload.meta_event_type === 'heartbeat') emit({ type: 'heartbeat', status: payload.status ?? null });
    else if (payload.meta_event_type === 'lifecycle') log('lifecycle: ' + String(payload.sub_type ?? ''));
    return;
  }
  if (postType === 'message') { dispatchMessage(payload); return; }
  if (postType === 'notice') {
    emit({ type: 'notice',
      notice_type: payload.notice_type ?? null,
      sub_type: payload.sub_type ?? null,
      user_id: payload.user_id ?? null,
      group_id: payload.group_id ?? null,
      operator_id: payload.operator_id ?? null,
      target_id: payload.target_id ?? null,
      duration: payload.duration ?? null,
      card: payload.card ?? null,
      file: payload.file ?? null,
      message_id: payload.message_id ?? null,
      raw: payload,
    });
    return;
  }
  if (postType === 'request') {
    emit({ type: 'request', request_type: payload.request_type ?? null, sub_type: payload.sub_type ?? null,
      user_id: payload.user_id ?? null, group_id: payload.group_id ?? null,
      comment: payload.comment ?? null, flag: payload.flag ?? null, raw: payload });
  }
}

function dispatchMessage(payload) {
  const messageType = payload.message_type === 'group' ? 'group' : 'private';
  const norm = normalizeMessage(payload.message ?? payload.raw_message ?? '');
  emit({
    type: 'message',
    message_type: messageType,
    sub_type: payload.sub_type ?? null,
    message_id: payload.message_id ?? null,
    group_id: payload.group_id ?? null,
    user_id: payload.user_id ?? null,
    self_id: payload.self_id ?? null,
    time: payload.time ?? Math.floor(Date.now() / 1000),
    text: norm.text,
    images: norm.images,
    image_urls: norm.imageUrls,
    mentions: norm.mentions,
    reply_to: norm.replyTo,
    raw_message: typeof payload.raw_message === 'string' ? payload.raw_message : null,
    sender: payload.sender && typeof payload.sender === 'object'
      ? { user_id: payload.sender.user_id ?? null, nickname: payload.sender.nickname ?? null, card: payload.sender.card ?? null, role: payload.sender.role ?? null }
      : null,
    message: Array.isArray(payload.message) ? payload.message : null,
  });
}

// ------------------------------------------------------------------ API 调用

function authHeaders() {
  const headers = {};
  if (ACCESS_TOKEN !== '') headers.authorization = 'Bearer ' + ACCESS_TOKEN;
  return headers;
}

async function callApi(action, params) {
  return HTTP_URL !== '' ? await callHttpApi(action, params) : await callWsApi(action, params);
}

async function callHttpApi(action, params) {
  let response;
  try {
    response = await postJson(HTTP_URL + '/' + action, authHeaders(), params);
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
  if (!response.ok && response.data === null) {
    return { ok: false, error: ('HTTP ' + response.status).trim() };
  }
  const data = response.data;
  if (data === null) return { ok: false, error: 'OneBot 返回空响应' };
  const retcode = typeof data.retcode === 'number' ? data.retcode : null;
  const ok = data.status === 'ok' || retcode === 0;
  const rawId = data.data ? (data.data.message_id !== undefined ? data.data.message_id : data.data.messageId) : undefined;
  return {
    ok, retcode,
    messageId: rawId !== undefined ? rawId : null,
    data: data.data !== undefined ? data.data : null,
    error: ok ? null : String(data.message ?? data.wording ?? 'retcode ' + String(retcode)),
  };
}

function callWsApi(action, params) {
  return new Promise((resolve) => {
    const link = links.active();
    if (link === null) { resolve({ ok: false, error: '没有可用的 WS 链路，且未配置 HTTP API' }); return; }
    const echo = 'api-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
    const timer = setTimeout(() => {
      if (pendingActions.delete(echo)) resolve({ ok: false, error: 'WS action 超时' });
    }, 15000);
    if (timer.unref) timer.unref();
    pendingActions.set(echo, { resolve: (value) => { clearTimeout(timer); resolve(value); } });
    if (!link.send(JSON.stringify({ action, params, echo }))) {
      pendingActions.delete(echo); clearTimeout(timer);
      resolve({ ok: false, error: 'WS 链路发送失败' });
    }
  });
}

// ------------------------------------------------------------------ 命令

function handleCommand(command) {
  if (command === null || typeof command !== 'object') return;
  switch (command.type) {
    case 'action': {
      const actionName = typeof command.action === 'string' ? command.action : '';
      if (actionName === '') {
        emit({ type: 'action_result', action: null, echo: command.echo ?? null, ok: false, error: '缺少 action', data: null, retcode: null });
        return;
      }
      void runAction(actionName, command.params !== null && typeof command.params === 'object' ? command.params : {}, command.echo ?? null);
      break;
    }
    case 'reconnect': {
      // 父进程主动探测发现无响应时发来的指令：只重连链路，不重启进程。
      log('收到 reconnect 指令，主动断开当前链路等待重连', 'warn');
      if (forward !== null) forward.reconnect();
      else links.closeAll();
      break;
    }
    case 'send': {
      const messageType = command.message_type === 'group' ? 'group' : 'private';
      const targetId = command.target_id;
      if (targetId === undefined || targetId === null || String(targetId) === '') {
        emit({ type: 'send_result', ok: false, echo: command.echo ?? null, error: '缺少 target_id', message_id: null });
        return;
      }
      let message = Array.isArray(command.message) && command.message.length > 0
        ? command.message
        : [{ type: 'text', data: { text: String(command.text ?? '') } }];
      if (command.reply_to !== undefined && command.reply_to !== null && String(command.reply_to) !== '') {
        const rid = /^\d+$/.test(String(command.reply_to)) ? Number(command.reply_to) : String(command.reply_to);
        message = [{ type: 'reply', data: { id: rid } }, ...message];
      }
      const numericId = /^\d+$/.test(String(targetId)) ? Number(targetId) : String(targetId);
      const action = messageType === 'group' ? 'send_group_msg' : 'send_private_msg';
      const params = messageType === 'group' ? { group_id: numericId, message } : { user_id: numericId, message };
      queue.enqueue({ action, params, echo: command.echo ?? null });
      break;
    }
    default: emit({ type: 'error', text: '未知命令：' + String(command.type) }); break;
  }
}

async function runAction(action, params, echo) {
  let result;
  try {
    result = await callApi(action, params);
  } catch (error) {
    result = { ok: false, error: String(error && error.message ? error.message : error) };
  }
  emit({
    type: 'action_result',
    action,
    echo,
    ok: result.ok === true,
    retcode: result.retcode === undefined ? null : result.retcode,
    data: result.data === undefined ? null : result.data,
    error: result.ok === true ? null : (result.error === undefined ? '未知错误' : result.error),
  });
}

// ------------------------------------------------------------------ 生命周期

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopHeartbeat();
  links.closeAll();
  const timer = setTimeout(() => process.exit(code), 50);
  if (timer.unref) timer.unref();
}

installStdin({
  onCommand: handleCommand,
  onShutdown: shutdown,
  onError: (text) => emit({ type: 'error', text }),
  onPing: () => emit({ type: 'pong', at: Date.now() }),
});
installCrashHandlers({ onShutdown: shutdown, onError: fail });

emit({
  type: 'hello', adapter: 'onebot11', mode: LISTEN !== '' ? 'reverse' : 'forward',
  wsUrl: WS_URL, listen: LISTEN, httpUrl: HTTP_URL, hasToken: ACCESS_TOKEN !== '', pid: process.pid,
});

if (LISTEN === '' && WS_URL === '') fail('既没有 --ws 也没有 --listen，无法接收 QQ 事件');
setStatus('starting');
