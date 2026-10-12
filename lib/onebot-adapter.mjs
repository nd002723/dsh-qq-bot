#!/usr/bin/env node
/**
 * OneBot 11 传输适配器（DSH QQ Bot 插件自带，零 npm 依赖）
 *
 * 支持的连接方式（可同时开）：
 *   正向 WS：  --ws ws://127.0.0.1:3001      我们主动连 NapCat（同机/同容器最简单）
 *   反向 WS：  --listen 0.0.0.0:6199         NapCat 连进来（跨容器/跨网络更好用）
 *   HTTP API： --http http://127.0.0.1:3000  用它发消息；不填则退回 WS action
 *
 * 与插件之间用「换行分隔 JSON」在 stdio 上通信：
 *   出（stdout）：hello / status / message / send_result / log / error / pong
 *   入（stdin） ：{type:'send',...} / {type:'ping'} / {type:'shutdown'}
 *
 * 鉴权遵循 OneBot 11 规范：HTTP 用 `Authorization: Bearer <token>`；
 * 正向 WS 握手用 `?access_token=`（WHATWG WebSocket 客户端无法自定义请求头）；
 * 反向 WS 同时接受请求头 Authorization 与 ?access_token= 两种。
 */

import process from 'node:process';
import http from 'node:http';
import { createHash } from 'node:crypto';

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

// ------------------------------------------------------------------ 输出

function emit(frame) {
  try { process.stdout.write(JSON.stringify(frame) + '\n'); } catch { /* 父进程没了 */ }
}
const log = (text, level = 'info') => emit({ type: 'log', level, text });
const fail = (text) => emit({ type: 'error', text: String(text) });

// -------------------------------------------------- RFC 6455 帧编解码（反向 WS 用）

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(key) {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}

/** 服务端 -> 客户端的未掩码文本帧 / pong 帧 */
function encodeFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}
const encodeTextFrame = (text) => encodeFrame(0x1, Buffer.from(text, 'utf8'));

/** 解析缓冲区里所有完整帧（客户端帧必须掩码） */
function decodeFrames(buffer) {
  const messages = [];
  let offset = 0;
  let fragments = null;
  let fragmentOpcode = 0;
  for (;;) {
    if (buffer.length - offset < 2) break;
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (buffer.length - cursor < 2) break;
      length = buffer.readUInt16BE(cursor); cursor += 2;
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break;
      length = Number(buffer.readBigUInt64BE(cursor)); cursor += 8;
    }
    let maskKey = null;
    if (masked) {
      if (buffer.length - cursor < 4) break;
      maskKey = buffer.subarray(cursor, cursor + 4); cursor += 4;
    }
    if (buffer.length - cursor < length) break;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (maskKey !== null) for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
    cursor += length;
    offset = cursor;
    if (opcode === 0x8) { messages.push({ type: 'close' }); continue; }
    if (opcode === 0x9) { messages.push({ type: 'ping', payload }); continue; }
    if (opcode === 0xa) continue;
    if (opcode === 0x0) {
      if (fragments !== null) fragments.push(payload);
      if (fin && fragments !== null) {
        messages.push({ type: fragmentOpcode === 0x1 ? 'text' : 'binary', payload: Buffer.concat(fragments) });
        fragments = null;
      }
      continue;
    }
    if (fin) messages.push({ type: opcode === 0x1 ? 'text' : 'binary', payload });
    else { fragments = [payload]; fragmentOpcode = opcode; }
  }
  return { messages, rest: buffer.subarray(offset) };
}

// ------------------------------------------------------------ OneBot 文本归一化

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

/** 把 OneBot 的 message（CQ 字符串 或 消息段数组）归一成 { text, images, imageUrls } */
function normalizeMessage(message) {
  let text = '';
  let images = 0;
  const imageUrls = [];
  // 被引用（回复）的消息 id；/recall 靠它实现「回复某条消息即可撤回」
  let replyTo = null;
  if (Array.isArray(message)) {
    for (const seg of message) {
      if (seg === null || typeof seg !== 'object') continue;
      const type = String(seg.type ?? '').toLowerCase();
      const data = seg.data ?? {};
      switch (type) {
        case 'text': text += String(data.text ?? ''); break;
        case 'at': { const qq = String(data.qq ?? ''); text += qq === 'all' ? '@全体成员 ' : qq ? '@' + qq + ' ' : ''; break; }
        case 'image': {
          images += 1;
          text += '[图片]';
          // 保留可访问的图片地址供视觉识别：优先 data.url，其次 data.file（可能是本地路径名/文件名）。
          // NapCat 的 array 消息段里 url 通常是 http(s) 直链；file 可能是文件名或路径。
          const u = typeof data.url === 'string' && data.url !== '' ? data.url
            : (typeof data.file === 'string' && data.file !== '' ? data.file : '');
          if (u !== '') imageUrls.push(u);
          break;
        }
        case 'face': text += '[表情]'; break;
        case 'record': text += '[语音]'; break;
        case 'video': text += '[视频]'; break;
        case 'file': text += '[文件:' + String(data.name ?? data.file ?? '') + ']'; break;
        case 'reply': {
          // 只取被引用消息 id，不往正文里塞占位符：
          // 否则「回复某条消息 + /recall」的正文会以 [回复] 开头，斜杠就不在首位了。
          const rid = Number(data.id);
          if (Number.isFinite(rid)) replyTo = rid;
          break;
        }
        case 'json': case 'xml': text += '[卡片消息]'; break;
        case 'forward': text += '[合并转发]'; break;
        case 'poke': text += '[戳一戳]'; break;
        default: if (typeof data.text === 'string') text += data.text; break;
      }
    }
    return { text, images, imageUrls, replyTo };
  }
  if (typeof message === 'string') {
    images = (message.match(/\[CQ:image/gi) ?? []).length;
    // CQ 字符串里的图片：提取 url=... / file=...，供视觉识别
    for (const m of message.matchAll(/\[CQ:image[^\]]*\]/gi)) {
      const seg = m[0];
      const urlMatch = /url=([^,\]]+)/.exec(seg);
      const fileMatch = /file=([^,\]]+)/.exec(seg);
      const u = (urlMatch !== null ? urlMatch[1] : '') || (fileMatch !== null ? fileMatch[1] : '');
      if (u !== '') imageUrls.push(u);
    }
    const replyMatch = /\[CQ:reply,[^\]]*id=(\d+)/.exec(message);
    if (replyMatch !== null) replyTo = Number(replyMatch[1]);
    return { text: cqToText(message), images, imageUrls, replyTo };
  }
  return { text: '', images: 0, imageUrls: [], replyTo: null };
}

// ------------------------------------------------------------------ 链路抽象
// link = { label, ready, send(text) -> bool, close() }
// 正向 WS 与反向 WS 都归一成 link，上层逻辑只认 link。

const links = new Set();
let forwardLink = null;
let forwardRetry = 1000;
let shuttingDown = false;
let heartbeatTimer = null;
let lastReason = '';

function setStatus(reason) {
  const connected = activeLink() !== null;
  if (connected) lastReason = '';
  else if (reason !== undefined) lastReason = reason;
  emit({ type: 'status', connected, reason: lastReason || null, links: links.size, mode: LISTEN !== '' ? 'reverse' : 'forward' });
}

function activeLink() {
  for (const link of links) if (link.ready) return link;
  return null;
}

function addLink(link, reason) {
  links.add(link);
  log('链路已连接：' + link.label + '（当前 ' + links.size + ' 条）');
  setStatus(reason);
}

function removeLink(link, reason) {
  if (!links.delete(link)) return;
  log('链路断开：' + link.label + '（剩余 ' + links.size + ' 条）', 'warn');
  setStatus(reason);
}

const sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); if (t.unref) t.unref(); });

// ------------------------------------------------------------------ 正向 WS

function wsUrlWithToken(url) {
  if (ACCESS_TOKEN === '') return url;
  return url + (url.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(ACCESS_TOKEN);
}

function connectForward() {
  if (shuttingDown || WS_URL === '') return;
  let ws;
  try {
    ws = new WebSocket(wsUrlWithToken(WS_URL));
  } catch (error) {
    fail('正向 WS 建立失败：' + String(error && error.message ? error.message : error));
    scheduleForwardRetry();
    return;
  }
  const link = {
    label: 'forward ' + WS_URL,
    ready: false,
    send(text) { if (ws.readyState !== 1) return false; try { ws.send(text); return true; } catch { return false; } },
    close() { try { ws.close(); } catch { /* ignore */ } },
  };
  forwardLink = link;
  addLink(link, 'connecting');

  ws.addEventListener('open', () => {
    link.ready = true;
    forwardRetry = 1000;
    log('正向 WS 已连接 ' + WS_URL);
    setStatus('');
    startHeartbeat();
  });
  ws.addEventListener('message', (event) => {
    onLinkMessage(link, typeof event.data === 'string' ? event.data : String(event.data));
  });
  ws.addEventListener('error', () => { /* close 里统一处理 */ });
  ws.addEventListener('close', (event) => {
    link.ready = false;
    if (forwardLink === link) forwardLink = null;
    removeLink(link, 'closed(' + String(event && event.code !== undefined ? event.code : '?') + ')');
    scheduleForwardRetry();
  });
}

function scheduleForwardRetry() {
  if (shuttingDown || WS_URL === '') return;
  const delay = forwardRetry;
  forwardRetry = Math.min(forwardRetry * 2, 30000);
  log('正向 WS ' + delay + 'ms 后重连', 'warn');
  const timer = setTimeout(() => { if (timer.unref) timer.unref(); connectForward(); }, delay);
  if (timer.unref) timer.unref();
}

// ------------------------------------------------------------------ 反向 WS

function tokenOk(req, url) {
  if (ACCESS_TOKEN === '') return true;
  const header = String(req.headers.authorization ?? '');
  if (header === 'Bearer ' + ACCESS_TOKEN) return true;
  return url.searchParams.get('access_token') === ACCESS_TOKEN;
}

function startReverseServer() {
  const [host, portText] = LISTEN.includes(':') ? LISTEN.split(':') : ['0.0.0.0', LISTEN];
  const port = Number(portText);
  if (!Number.isFinite(port)) { fail('--listen 端口无效：' + LISTEN); return; }

  const server = http.createServer((_req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('需要 WebSocket 升级（OneBot 11 反向 WS）');
  });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') { socket.destroy(); return; }
    const url = new URL(req.url ?? '/', 'http://' + (host === '0.0.0.0' ? '127.0.0.1' : host));
    if (!tokenOk(req, url)) {
      log('反向 WS 鉴权失败，已拒绝来自 ' + String(req.socket.remoteAddress), 'warn');
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
      + 'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n',
    );
    socket.setNoDelay(true);

    const link = {
      label: 'reverse ' + String(req.socket.remoteAddress) + ':' + String(req.socket.remotePort),
      ready: true,
      send(text) { try { socket.write(encodeTextFrame(text)); return true; } catch { return false; } },
      close() { try { socket.destroy(); } catch { /* ignore */ } },
    };
    addLink(link, '');

    // 发一条 lifecycle，和真实 OneBot 实现的行为一致
    link.send(JSON.stringify({
      post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect',
      time: Math.floor(Date.now() / 1000),
    }));

    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const decoded = decodeFrames(buffer);
      buffer = decoded.rest;
      for (const message of decoded.messages) {
        if (message.type === 'close') { socket.end(); continue; }
        if (message.type === 'ping') { try { socket.write(encodeFrame(0xa, message.payload)); } catch { /* ignore */ } continue; }
        if (message.type === 'text') onLinkMessage(link, message.payload.toString('utf8'));
      }
    });
    const done = () => removeLink(link, '反向连接关闭');
    socket.on('close', done);
    socket.on('error', done);
  });

  server.on('error', (error) => fail('反向 WS 服务启动失败：' + String(error && error.message ? error.message : error)));
  server.listen(port, host, () => {
    const bound = server.address();
    const actualPort = bound !== null && typeof bound === 'object' ? bound.port : port;
    log('反向 WS 监听 ' + host + ':' + actualPort + '（在 NapCat 里填 ws://<本机IP>:' + actualPort + '/）');
    emit({ type: 'listening', host, port: actualPort });
  });
  return server;
}

// ------------------------------------------------------------------ 事件处理

function startHeartbeat() {
  stopHeartbeat();
  if (HEARTBEAT_MS <= 0) return;
  heartbeatTimer = setInterval(() => {
    const link = activeLink();
    if (link !== null) link.send(JSON.stringify({ action: 'get_status', echo: 'hb-' + Date.now() }));
  }, HEARTBEAT_MS);
  if (heartbeatTimer.unref) heartbeatTimer.unref();
}

function stopHeartbeat() {
  if (heartbeatTimer !== null) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

function onLinkMessage(link, raw) {
  let payload;
  try { payload = JSON.parse(raw); } catch { return; }
  if (payload === null || typeof payload !== 'object') return;

  // WS action 的响应（我们通过 WS 发消息时的回执）
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
    // 群管理真正需要的是 operator_id（谁操作的）、duration（禁言时长）、target_id 等，
    // 所以这里既给扁平字段，也把原始 payload 整包带上。
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
    reply_to: norm.replyTo,
    // 会话/被引用消息的 id，供 /recall 使用
    raw_message: typeof payload.raw_message === 'string' ? payload.raw_message : null,
    sender: payload.sender && typeof payload.sender === 'object'
      ? { user_id: payload.sender.user_id ?? null, nickname: payload.sender.nickname ?? null, card: payload.sender.card ?? null, role: payload.sender.role ?? null }
      : null,
    message: Array.isArray(payload.message) ? payload.message : null,
  });
}

// ------------------------------------------------------------------ 发消息

const sendQueue = [];
let sendPumpRunning = false;
let lastSendAt = 0;
const pendingActions = new Map();

function enqueueSend(job) {
  sendQueue.push(job);
  if (!sendPumpRunning) void pumpSends();
}

async function pumpSends() {
  sendPumpRunning = true;
  try {
    while (sendQueue.length > 0) {
      const job = sendQueue.shift();
      const wait = SEND_GAP_MS - (Date.now() - lastSendAt);
      if (wait > 0) await sleep(wait);
      let result;
      try {
        result = HTTP_URL !== '' ? await callHttpApi(job.action, job.params) : await callWsApi(job.action, job.params);
      } catch (error) {
        result = { ok: false, error: String(error && error.message ? error.message : error) };
      }
      lastSendAt = Date.now();
      emit({
        type: 'send_result', ok: result.ok, echo: job.echo ?? null,
        message_id: result.messageId ?? null, error: result.ok ? null : (result.error ?? '未知错误'),
        retcode: result.retcode ?? null,
      });
    }
  } finally {
    sendPumpRunning = false;
  }
}

function authHeaders() {
  const headers = { 'content-type': 'application/json' };
  if (ACCESS_TOKEN !== '') headers.authorization = 'Bearer ' + ACCESS_TOKEN;
  return headers;
}

async function callHttpApi(action, params) {
  const body = Object.assign({}, params);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  if (timer.unref) timer.unref();
  let response;
  try {
    response = await fetch(HTTP_URL + '/' + action, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify(body), signal: controller.signal,
    });
  } finally { clearTimeout(timer); }

  let data = null;
  const text = await response.text();
  if (text.length > 0) { try { data = JSON.parse(text); } catch { data = null; } }
  if (!response.ok && data === null) return { ok: false, error: ('HTTP ' + response.status + ' ' + response.statusText).trim() };
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
    const link = activeLink();
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

// ------------------------------------------------------------------ stdin 命令

function handleCommand(command) {
  if (command === null || typeof command !== 'object') return;
  switch (command.type) {
    case 'ping': emit({ type: 'pong', at: Date.now() }); break;
    case 'action': {
      // 通用通道：插件把任意 OneBot 11 动作（群管理、查询等）透传下来。
      const actionName = typeof command.action === 'string' ? command.action : '';
      if (actionName === '') {
        emit({ type: 'action_result', action: null, echo: command.echo ?? null, ok: false, error: '缺少 action', data: null, retcode: null });
        return;
      }
      void runAction(actionName, command.params !== null && typeof command.params === 'object' ? command.params : {}, command.echo ?? null);
      break;
    }
    case 'shutdown': log('收到 shutdown'); shutdown(0); break;
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
      // 引用回复：插件带 reply_to（被引用消息 id）时，在消息数组开头插入 reply 段
      // （NapCat 支持，实现「QQ 回复消息流程」）。
      if (command.reply_to !== undefined && command.reply_to !== null
        && String(command.reply_to) !== '') {
        const rid = /^\d+$/.test(String(command.reply_to)) ? Number(command.reply_to) : String(command.reply_to);
        message = [{ type: 'reply', data: { id: rid } }, ...message];
      }
      const numericId = /^\d+$/.test(String(targetId)) ? Number(targetId) : String(targetId);
      const action = messageType === 'group' ? 'send_group_msg' : 'send_private_msg';
      const params = messageType === 'group' ? { group_id: numericId, message } : { user_id: numericId, message };
      enqueueSend({ action, params, echo: command.echo ?? null });
      break;
    }
    default: emit({ type: 'error', text: '未知命令：' + String(command.type) }); break;
  }
}

/** 执行一个任意 OneBot 动作并把结果（含 data）回报给插件。 */
async function runAction(action, params, echo) {
  let result;
  try {
    result = HTTP_URL !== '' ? await callHttpApi(action, params) : await callWsApi(action, params);
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

let stdinBuffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk;
  let index;
  while ((index = stdinBuffer.indexOf('\n')) >= 0) {
    const line = stdinBuffer.slice(0, index).trim();
    stdinBuffer = stdinBuffer.slice(index + 1);
    if (line === '') continue;
    let command;
    try { command = JSON.parse(line); }
    catch { emit({ type: 'error', text: 'JSON 解析失败：' + line.slice(0, 200) }); continue; }
    try { handleCommand(command); }
    catch (error) { emit({ type: 'error', text: String(error && error.stack ? error.stack : error) }); }
  }
});
process.stdin.on('end', () => shutdown(0));

// ------------------------------------------------------------------ 生命周期

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopHeartbeat();
  for (const link of links) link.close();
  links.clear();
  const timer = setTimeout(() => process.exit(code), 50);
  if (timer.unref) timer.unref();
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
process.on('uncaughtException', (error) => fail('未捕获异常：' + (error && error.stack ? error.stack : error)));
process.on('unhandledRejection', (reason) => fail('未处理的 rejection：' + (reason && reason.stack ? reason.stack : reason)));

emit({
  type: 'hello', adapter: 'onebot11', mode: LISTEN !== '' ? 'reverse' : 'forward',
  wsUrl: WS_URL, listen: LISTEN, httpUrl: HTTP_URL, hasToken: ACCESS_TOKEN !== '', pid: process.pid,
});

if (LISTEN !== '') startReverseServer();
if (WS_URL !== '') connectForward();
if (LISTEN === '' && WS_URL === '') fail('既没有 --ws 也没有 --listen，无法接收 QQ 事件');
