#!/usr/bin/env node
/**
 * OneBot 12 协议适配器（候选版标准，零 npm 依赖）。
 *
 * 传输：
 *   正向 WS（--ws）：我们连实现端的 ws://host:port/（实现端是 server）
 *   反向 WS（--listen）：实现端连我们；我们校验 Authorization: Bearer（--token / ?access_token=）。
 *     注意：**不校验也不回显 Sec-WebSocket-Protocol**，101 响应是固定串——所以要求服务端
 *     选中子协议的严格客户端会在握手阶段失败（OneBot 12 实现普遍不要求，故未实现）。
 *   HTTP（--http）：POST / 发动作（body {action, params, echo}），实现端一律 200，看 retcode
 *
 * 与 OneBot 11 的主要差异（本文件已处理）：
 *   - 事件是 {id, time, type, detail_type, sub_type, self} 结构，不是 post_type
 *   - 消息段里 @ 叫 mention（字段 user_id），回复叫 reply（字段 message_id），图片只有 file_id
 *   - 动作名叫 send_message（detail_type=private|group），响应是 {status, retcode, data, message, echo}
 *   - 所有 ID 都是字符串
 */
import process from 'node:process';
import { createEmitter, createSendQueue, installStdin, installCrashHandlers, postJson } from '../bridge/stdio.mjs';
import { createLinkSet, connectForward, startReverseServer, bearerOrQueryToken } from '../bridge/ws.mjs';
import { summarizeSegments } from '../../message/segments.mjs';

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
const WS_URL = argv.ws ?? process.env.ONEBOT12_WS_URL ?? '';
const LISTEN = argv.listen ?? process.env.ONEBOT12_LISTEN ?? '';
const HTTP_URL = String(argv.http ?? process.env.ONEBOT12_HTTP_URL ?? '').replace(/\/+$/, '');
const ACCESS_TOKEN = argv.token ?? process.env.ONEBOT12_ACCESS_TOKEN ?? '';
const HEARTBEAT_MS = Number(argv['heartbeat-ms'] ?? 30000);
const SEND_GAP_MS = Number(argv['send-gap-ms'] ?? 350);
const PLATFORM = String(argv.platform ?? 'qq');

const { emit, log, fail } = createEmitter();
const pendingActions = new Map();
let heartbeatTimer = null;
let shuttingDown = false;
let lastReason = '';
let selfId = '';

const links = createLinkSet({
  onStatus: (info) => {
    if (info.event === 'add') { log('链路已连接：' + info.label + '（当前 ' + info.size + ' 条）'); startHeartbeat(); }
    else log('链路断开：' + info.label + '（剩余 ' + info.size + ' 条）', 'warn');
    setStatus();
  },
});

function setStatus(reason) {
  const connected = links.active() !== null;
  if (connected) lastReason = '';
  else if (reason !== undefined) lastReason = reason;
  emit({ type: 'status', connected, reason: lastReason || null, links: links.size(), mode: LISTEN !== '' ? 'reverse' : 'forward' });
}

const queue = createSendQueue({ gapMs: SEND_GAP_MS, send: (action, params) => callApi(action, params), emit });

// ------------------------------------------------------------------ 传输

if (WS_URL !== '') {
  connectForward({
    url: WS_URL,
    token: ACCESS_TOKEN,
    linkSet: links,
    onText: (link, text) => onTextFrame(link, text),
    onOpen: () => { log('正向 WS 已连接 ' + WS_URL); setStatus(''); },
    onClose: (info) => setStatus('closed(' + String(info.code ?? '?') + ')'),
    onError: (info) => {
      if (info.phase === 'retry') log('正向 WS ' + info.delayMs + 'ms 后重连', 'warn');
      else if (info.phase === 'create') fail('正向 WS 建立失败：' + String(info.error && info.error.message ? info.error.message : info.error));
    },
  });
}

if (LISTEN !== '') {
  startReverseServer({
    listen: LISTEN,
    // 没配 token 时由 ws.mjs 强制收回到回环（身份完全来自帧）。
    allowPublic: ACCESS_TOKEN !== '',
    // 走 ws.mjs 的 bearerOrQueryToken：它用 timingSafeEqual 比较，自己写的 `===` 是时序侧信道，
    // 且与 onebot11 保持同一套语义（空 token 时信任本机回环，这一点由 resolveListenAddress 兜住）。
    authorize: bearerOrQueryToken(ACCESS_TOKEN),
    onText: (link, text) => onTextFrame(link, text),
    onClose: (link) => { link.ready = false; links.remove(link); },
    onReady: (link) => { links.add(link); },
    onListening: (info) => { log('反向 WS 监听 ' + info.host + ':' + info.port); emit({ type: 'listening', host: info.host, port: info.port }); },
    onError: (text) => fail(text),
  });
}

function startHeartbeat() {
  stopHeartbeat();
  if (HEARTBEAT_MS <= 0) return;
  heartbeatTimer = setInterval(() => {
    const link = links.active();
    if (link !== null) link.send(JSON.stringify({ action: 'get_status', params: {}, echo: 'hb-' + Date.now() }));
  }, HEARTBEAT_MS);
  if (heartbeatTimer.unref) heartbeatTimer.unref();
}

function stopHeartbeat() {
  if (heartbeatTimer !== null) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

// ------------------------------------------------------------------ 事件归一

/** OneBot 12 段 -> 内部统一段（OneBot 11 风格，插件只认这套） */
function toCanonicalSegments(segments) {
  if (!Array.isArray(segments)) return [];
  const out = [];
  for (const segment of segments) {
    if (segment === null || typeof segment !== 'object') continue;
    const type = String(segment.type ?? '').toLowerCase();
    const data = segment.data ?? {};
    switch (type) {
      case 'text': out.push({ type: 'text', data: { text: String(data.text ?? '') } }); break;
      case 'mention': out.push({ type: 'at', data: { qq: String(data.user_id ?? '') } }); break;
      case 'mention_all': out.push({ type: 'at', data: { qq: 'all' } }); break;
      case 'reply': out.push({ type: 'reply', data: { id: data.message_id ?? data.id ?? null } }); break;
      case 'image': {
        // 12 只有 file_id；能拿到 url 的实现（扩展）就用，拿不到就留 file_id 供上层兜底。
        const url = typeof data.url === 'string' ? data.url : '';
        out.push({ type: 'image', data: url !== '' ? { url, file: data.file_id ?? '' } : { file: data.file_id ?? '' } });
        break;
      }
      case 'voice': case 'audio': out.push({ type: 'record', data: { file: data.file_id ?? '' } }); break;
      case 'video': out.push({ type: 'video', data: { file: data.file_id ?? '' } }); break;
      case 'file': out.push({ type: 'file', data: { file: data.file_id ?? '' } }); break;
      default: {
        // 未知段降级为文本占位，绝不抛错
        out.push({ type: 'text', data: { text: '[未识别的消息段]' } });
      }
    }
  }
  return out;
}

function onTextFrame(_link, raw) {
  let payload;
  try { payload = JSON.parse(raw); } catch { return; }
  if (payload === null || typeof payload !== 'object') return;

  // 动作响应（带 status/retcode/echo、没有 type）
  if (payload.status !== undefined && payload.type === undefined) {
    const pending = pendingActions.get(String(payload.echo));
    if (pending !== undefined) {
      pendingActions.delete(String(payload.echo));
      const ok = payload.status === 'ok' && (payload.retcode === 0 || payload.retcode === undefined);
      pending.resolve({
        ok,
        retcode: typeof payload.retcode === 'number' ? payload.retcode : null,
        messageId: payload.data && payload.data.message_id !== undefined ? payload.data.message_id : null,
        data: payload.data !== undefined ? payload.data : null,
        error: ok ? null : String(payload.message ?? 'retcode ' + String(payload.retcode)),
      });
    }
    return;
  }

  const type = String(payload.type ?? '');
  const detail = String(payload.detail_type ?? '');
  if (type === 'meta') {
    if (detail === 'connect') {
      if (payload.self && payload.self.user_id !== undefined) selfId = String(payload.self.user_id);
      log('OneBot 12 已连接（' + String(payload.version && payload.version.onebot_version ? payload.version.onebot_version : '12') + '）');
      setStatus('');
    } else if (detail === 'heartbeat') {
      emit({ type: 'heartbeat', status: null });
    }
    return;
  }
  if (type === 'message') {
    dispatchMessage(payload, detail);
    return;
  }
  if (type === 'notice') {
    const noticeGroup = payload.group_id !== undefined ? String(payload.group_id) : null;
    emit({
      type: 'notice',
      notice_type: detail === '' ? null : detail,
      sub_type: payload.sub_type ?? null,
      user_id: payload.user_id === undefined ? null : String(payload.user_id),
      group_id: noticeGroup,
      operator_id: payload.operator_id === undefined ? null : String(payload.operator_id),
      target_id: payload.target_id === undefined ? null : String(payload.target_id),
      duration: payload.duration ?? null,
      card: payload.card ?? null,
      file: payload.file ?? null,
      message_id: payload.message_id ?? null,
      raw: payload,
    });
    return;
  }
  if (type === 'request') {
    emit({ type: 'request', request_type: detail || null, sub_type: payload.sub_type ?? null,
      user_id: payload.user_id ?? null, group_id: payload.group_id ?? null,
      comment: payload.comment ?? null, flag: payload.flag ?? null, raw: payload });
  }
}

function dispatchMessage(payload, detail) {
  const isGroup = detail === 'group' || detail === 'channel';
  const segments = toCanonicalSegments(payload.message);
  const norm = summarizeSegments(segments);
  const self = payload.self && payload.self.user_id !== undefined ? String(payload.self.user_id) : (selfId || null);
  emit({
    type: 'message',
    message_type: isGroup ? 'group' : 'private',
    sub_type: payload.sub_type === '' ? null : (payload.sub_type ?? null),
    message_id: payload.message_id ?? payload.id ?? null,
    group_id: isGroup ? String(payload.group_id ?? payload.channel_id ?? '') : null,
    user_id: payload.user_id === undefined ? null : String(payload.user_id),
    self_id: self,
    time: typeof payload.time === 'number' ? Math.floor(payload.time) : Math.floor(Date.now() / 1000),
    text: norm.text,
    images: norm.images,
    image_urls: norm.imageUrls,
    image_meta: norm.imageMeta ?? [],
    mentions: norm.mentions,
    reply_to: norm.replyTo,
    raw_message: typeof payload.alt_message === 'string' ? payload.alt_message : norm.text,
    sender: {
      user_id: payload.user_id === undefined ? null : String(payload.user_id),
      nickname: payload.sender && payload.sender.nickname ? String(payload.sender.nickname) : null,
      card: payload.sender && payload.sender.card ? String(payload.sender.card) : null,
      role: payload.sender && payload.sender.role ? String(payload.sender.role) : null,
    },
    message: segments,
  });
}

// ------------------------------------------------------------------ 动作调用

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
    response = await postJson(HTTP_URL + '/', authHeaders(), { action, params: params ?? {}, echo: mkEcho() });
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
  const data = response.data;
  if (data === null) return { ok: false, error: '实现端返回空响应（HTTP ' + response.status + '）' };
  return normalizeResponse(data);
}

function normalizeResponse(data) {
  const ok = data.status === 'ok' && (data.retcode === 0 || data.retcode === undefined);
  return {
    ok,
    retcode: typeof data.retcode === 'number' ? data.retcode : null,
    messageId: data.data && data.data.message_id !== undefined ? data.data.message_id : null,
    data: data.data !== undefined ? data.data : null,
    error: ok ? null : String(data.message ?? data.wording ?? 'retcode ' + String(data.retcode)),
  };
}

const mkEcho = () => 'ob12-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);

function callWsApi(action, params) {
  return new Promise((resolve) => {
    const link = links.active();
    if (link === null) { resolve({ ok: false, error: '没有可用的 WS 链路，且未配置 HTTP' }); return; }
    const echo = mkEcho();
    const timer = setTimeout(() => {
      if (pendingActions.delete(echo)) resolve({ ok: false, error: 'WS 动作超时' });
    }, 15000);
    if (timer.unref) timer.unref();
    pendingActions.set(echo, { resolve: (value) => { clearTimeout(timer); resolve(value); } });
    if (!link.send(JSON.stringify({ action, params: params ?? {}, echo }))) {
      pendingActions.delete(echo); clearTimeout(timer);
      resolve({ ok: false, error: 'WS 链路发送失败' });
    }
  });
}

// ------------------------------------------------------------------ 段映射（发）

/** 内部统一段 -> OneBot 12 段 */
function toProtocolSegments(segments) {
  const out = [];
  for (const segment of segments) {
    if (segment === null || typeof segment !== 'object') continue;
    const type = String(segment.type ?? '').toLowerCase();
    const data = segment.data ?? {};
    switch (type) {
      case 'text': out.push({ type: 'text', data: { text: String(data.text ?? '') } }); break;
      case 'at': {
        if (String(data.qq ?? '') === 'all') out.push({ type: 'mention_all', data: {} });
        else out.push({ type: 'mention', data: { user_id: String(data.qq ?? '') } });
        break;
      }
      case 'reply': out.push({ type: 'reply', data: { message_id: String(data.id ?? '') } }); break;
      case 'image': {
        // 12 发图用 file_id：实现端普遍扩展支持 http(s) URL / 本地路径，这里优先 url。
        const fileId = typeof data.url === 'string' && data.url !== '' ? data.url
          : (typeof data.file === 'string' ? data.file : '');
        out.push({ type: 'image', data: { file_id: fileId } });
        break;
      }
      default: out.push({ type: 'text', data: { text: '[暂不支持的消息段]' } });
    }
  }
  return out;
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
    case 'send': {
      const messageType = command.message_type === 'group' ? 'group' : 'private';
      const targetId = command.target_id === undefined || command.target_id === null ? '' : String(command.target_id);
      if (targetId === '') {
        emit({ type: 'send_result', ok: false, echo: command.echo ?? null, error: '缺少 target_id', message_id: null });
        return;
      }
      let segments = Array.isArray(command.message) && command.message.length > 0
        ? toProtocolSegments(command.message)
        : [{ type: 'text', data: { text: String(command.text ?? '') } }];
      if (command.reply_to !== undefined && command.reply_to !== null && String(command.reply_to) !== '') {
        segments = [{ type: 'reply', data: { message_id: String(command.reply_to) } }, ...segments];
      }
      const params = messageType === 'group'
        ? { detail_type: 'group', group_id: targetId, message: segments }
        : { detail_type: 'private', user_id: targetId, message: segments };
      queue.enqueue({ action: 'send_message', params, echo: command.echo ?? null });
      break;
    }
    default: emit({ type: 'error', text: '未知命令：' + String(command.type) }); break;
  }
}

/** OneBot 11 风格动作 -> OneBot 12 动作名（qqgroup 工具走这条） */
const ACTION_MAP = {
  set_group_kick: 'set_group_kick', set_group_ban: 'set_group_ban', set_group_card: 'set_group_card',
  set_group_whole_ban: 'set_group_whole_ban', set_group_admin: 'set_group_admin', set_group_name: 'set_group_name',
  delete_msg: 'delete_message', recall: 'delete_message',
  get_group_info: 'get_group_info', get_group_list: 'get_group_list',
  get_group_member_list: 'get_group_member_list', get_group_member_info: 'get_group_member_info',
  get_login_info: 'get_self_info', get_self_info: 'get_self_info',
};

async function runAction(action, params, echo) {
  const mapped = ACTION_MAP[action] ?? action;
  let result;
  try {
    result = await callApi(mapped, params);
  } catch (error) {
    result = { ok: false, error: String(error && error.message ? error.message : error) };
  }
  if (result.ok !== true && result.retcode === 10002) {
    result.error = 'OneBot 12 实现端不支持该动作：' + mapped;
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
  type: 'hello', adapter: 'onebot12', mode: LISTEN !== '' ? 'reverse' : 'forward',
  wsUrl: WS_URL, listen: LISTEN, httpUrl: HTTP_URL, hasToken: ACCESS_TOKEN !== '', platform: PLATFORM, pid: process.pid,
});

if (LISTEN === '' && WS_URL === '' && HTTP_URL === '') fail('既没有 --ws 也没有 --listen，无法接收事件');
setStatus('starting');
