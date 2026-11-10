#!/usr/bin/env node
/**
 * Milky 协议适配器（milkyVersion 1.3，零 npm 依赖，Node >= 22）。
 *
 * 传输（规范：协议端开一个 HTTP 服务器，两个端点共用端口）：
 *   事件： --ws  ws://127.0.0.1:9000/event   我们主动连（Upgrade: websocket；SSE 由协议端按同路径分流）
 *   发送： --http http://127.0.0.1:9000      POST /api/:api 调 API；不填则从 --ws 推导（同端口）
 *   回调： --listen 0.0.0.0:6199             WebHook 模式：协议端把事件 POST 到我们
 *   鉴权： --token <access_token>            Authorization: Bearer（发送）/ ?access_token=（WS）
 *
 * 与 OneBot 11 的关键差异（本文件据此实现，勿照搬 OneBot 语义）：
 *   - 事件信封是 { time, self_id, event_type, data }，没有 post_type / meta_event / heartbeat；
 *     消息事件的 data **直接**就是 IncomingMessage（message_scene 判别 friend/group/temp）。
 *   - 消息 id 只有 message_seq(int64)；消息段是 { type, data:{...} }，只能数组，没有 CQ 码。
 *   - @ 拆成 mention / mention_all；未知段类型必须降级为 text（规范强制，不能抛）。
 *   - 响应没有 echo，业务成败只看 retcode（0 成功），HTTP 一般 200。
 *   - 发消息必须显式 send_private_message / send_group_message，没有通用入口。
 *
 * 与插件之间的 stdio 契约见 lib/transport/bridge/CONTRACT.md。
 */

import http from 'node:http';
import process from 'node:process';
import { createEmitter, createSendQueue, installStdin, installCrashHandlers, postJson } from '../bridge/stdio.mjs';
import { createLinkSet, connectForward, bearerOrQueryToken, resolveListenAddress } from '../bridge/ws.mjs';
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
const RAW_WS = String(argv.ws ?? process.env.MILKY_WS_URL ?? '').trim();
const RAW_HTTP = String(argv.http ?? process.env.MILKY_HTTP_URL ?? '').trim();
const LISTEN = String(argv.listen ?? process.env.MILKY_LISTEN ?? '').trim();
const ACCESS_TOKEN = String(argv.token ?? process.env.MILKY_ACCESS_TOKEN ?? '');
// 协议端没有 heartbeat 事件、也没有主动消息配额；QQ 侧风控靠发送节流兜（研报建议单群 >= 1s/条）。
const SEND_GAP_MS = Number(argv['send-gap-ms'] ?? 900);
const CALL_TIMEOUT_MS = Number(argv['api-timeout-ms'] ?? 15000);

/** 允许只写 host:port；没有路径时补规范的 /event。 */
function normalizeWsUrl(raw) {
  if (raw === '') return '';
  let text = raw;
  if (!/^wss?:\/\//i.test(text)) text = (/^https?:\/\//i.test(text) ? text.replace(/^http/i, 'ws') : 'ws://' + text);
  try {
    const url = new URL(text);
    if (url.pathname === '' || url.pathname === '/') url.pathname = '/event';
    return url.toString();
  } catch { return text; }
}

/** 规范：/api 与 /event 是同一个 HTTP 服务器的两个端点，因此 HTTP 地址可由 WS 地址推导。 */
function deriveHttpUrl(wsUrl) {
  if (wsUrl === '') return '';
  try {
    const url = new URL(wsUrl);
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = '/';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch { return ''; }
}

const WS_URL = normalizeWsUrl(RAW_WS);
const HTTP_URL = (RAW_HTTP !== '' ? RAW_HTTP : deriveHttpUrl(WS_URL)).replace(/\/+$/, '');
const MODE = LISTEN !== '' ? 'webhook' : 'forward';

// ------------------------------------------------------------------ 输出与链路

const { emit, log, fail } = createEmitter();
let shuttingDown = false;
let lastReason = '';
let selfId = argv['self-id'] ?? null;
let versionLogged = false;

const links = createLinkSet({
  onStatus: (info) => {
    if (info.event === 'add') log('链路已连接：' + info.label + '（当前 ' + info.size + ' 条）');
    else log('链路断开：' + info.label + '（剩余 ' + info.size + ' 条）', 'warn');
    setStatus();
  },
});

function setStatus(reason) {
  const connected = links.active() !== null;
  if (connected) lastReason = '';
  else if (reason !== undefined) lastReason = reason;
  emit({ type: 'status', connected, reason: lastReason || null, links: links.size(), mode: MODE });
}

/** message_seq -> { scene, peer }：Milky 的撤回/查询要 message_scene + peer_id，插件只传 message_id。 */
const messageIndex = new Map();
const MESSAGE_INDEX_MAX = 1000;

function rememberMessage(seq, scene, peer) {
  if (seq === undefined || seq === null) return;
  const key = String(seq);
  if (messageIndex.has(key)) messageIndex.delete(key);
  messageIndex.set(key, { scene, peer });
  while (messageIndex.size > MESSAGE_INDEX_MAX) {
    const oldest = messageIndex.keys().next();
    if (oldest.done === true) break;
    messageIndex.delete(oldest.value);
  }
}

const toId = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : value;
};

const sceneOf = (raw) => (raw === 'group' ? 'group' : (raw === 'temp' ? 'temp' : 'friend'));

// ------------------------------------------------------------------ 入站段：Milky -> 统一段

/** 未知段类型一律降级为 text（规范「向前兼容」要求），绝不抛异常。 */
function toUnifiedSegment(segment) {
  if (segment === null || typeof segment !== 'object') return null;
  const type = String(segment.type ?? '').toLowerCase();
  const data = (segment.data !== null && typeof segment.data === 'object') ? segment.data : {};
  switch (type) {
    case 'text':
      return { type: 'text', data: { text: String(data.text ?? '') } };
    case 'mention':
      return { type: 'at', data: { qq: data.user_id === undefined || data.user_id === null ? '' : String(data.user_id), name: data.name ?? null } };
    case 'mention_all':
      return { type: 'at', data: { qq: 'all' } };
    case 'face':
      return { type: 'face', data: { id: String(data.face_id ?? ''), large: data.is_large === true } };
    case 'reply':
      return { type: 'reply', data: { id: Number(data.message_seq), sender_id: data.sender_id ?? null, sender_name: data.sender_name ?? null, time: data.time ?? null } };
    case 'image':
      return { type: 'image', data: { url: String(data.temp_url ?? ''), file: String(data.resource_id ?? ''), summary: data.summary ?? null, sub_type: data.sub_type ?? 'normal', width: data.width ?? null, height: data.height ?? null } };
    case 'record':
      return { type: 'record', data: { url: String(data.temp_url ?? ''), file: String(data.resource_id ?? ''), duration: data.duration ?? null } };
    case 'video':
      return { type: 'video', data: { url: String(data.temp_url ?? ''), file: String(data.resource_id ?? ''), duration: data.duration ?? null, width: data.width ?? null, height: data.height ?? null } };
    case 'file':
      return { type: 'file', data: { name: data.file_name ?? '', file: data.file_id ?? '', size: data.file_size ?? null } };
    case 'forward':
      return { type: 'forward', data: { id: data.forward_id ?? null, title: data.title ?? null, summary: data.summary ?? null } };
    case 'market_face':
      return { type: 'mface', data: { url: data.url ?? '', summary: data.summary ?? null } };
    case 'light_app':
      return { type: 'json', data: { app_name: data.app_name ?? null } };
    case 'xml':
      return { type: 'xml', data: { service_id: data.service_id ?? null } };
    case 'markdown':
      return { type: 'text', data: { text: String(data.content ?? '') } };
    default: {
      const fallback = typeof data.text === 'string' ? data.text
        : (typeof data.summary === 'string' ? data.summary : '');
      return { type: 'text', data: { text: fallback } };
    }
  }
}

function unifySegments(rawSegments) {
  const out = [];
  if (!Array.isArray(rawSegments)) return out;
  for (const segment of rawSegments) {
    const unified = toUnifiedSegment(segment);
    if (unified !== null) out.push(unified);
  }
  return out;
}

/** IncomingMessage -> 插件惯用的 OneBot 风格消息对象（get_msg / *_history 的 data 用）。 */
function mapIncomingMessage(message) {
  if (message === null || typeof message !== 'object') return null;
  const scene = sceneOf(message.message_scene);
  const segments = unifySegments(message.segments);
  const summary = summarizeSegments(segments);
  const member = (message.group_member !== null && typeof message.group_member === 'object') ? message.group_member : null;
  const friend = (message.friend !== null && typeof message.friend === 'object') ? message.friend : null;
  const senderId = message.sender_id ?? (member !== null ? member.user_id : null) ?? (friend !== null ? friend.user_id : null) ?? null;
  return {
    message_id: message.message_seq ?? null,
    message_seq: message.message_seq ?? null,
    message_type: scene === 'group' ? 'group' : 'private',
    message_scene: message.message_scene ?? null,
    group_id: scene === 'group' ? (message.peer_id ?? null) : null,
    peer_id: message.peer_id ?? null,
    user_id: senderId,
    time: message.time ?? null,
    text: summary.text,
    raw_message: summary.text,
    images: summary.images,
    image_urls: summary.imageUrls,
    image_meta: summary.imageMeta ?? [],
    mentions: summary.mentions,
    reply_to: summary.replyTo,
    sender: {
      user_id: senderId,
      nickname: (member !== null ? member.nickname : null) ?? (friend !== null ? friend.nickname : null) ?? null,
      card: member !== null ? (member.card ?? null) : null,
      role: member !== null ? (member.role ?? null) : null,
    },
    message: segments,
  };
}

function mapGroup(group) {
  if (group === null || typeof group !== 'object') return null;
  return {
    group_id: group.group_id ?? null,
    group_name: group.group_name ?? null,
    member_count: group.member_count ?? null,
    max_member_count: group.max_member_count ?? null,
    remark: group.remark ?? null,
    description: group.description ?? null,
    announcement: group.announcement ?? null,
  };
}

function mapMember(member) {
  if (member === null || typeof member !== 'object') return null;
  return {
    group_id: member.group_id ?? null,
    user_id: member.user_id ?? null,
    nickname: member.nickname ?? null,
    card: member.card ?? null,
    role: member.role ?? null,
    title: member.title ?? null,
    level: member.level === undefined || member.level === null ? null : String(member.level),
    sex: member.sex ?? null,
    join_time: member.join_time ?? null,
    last_sent_time: member.last_sent_time ?? null,
  };
}

// ------------------------------------------------------------------ 事件分发

function onLinkMessage(_link, raw) {
  let payload;
  try { payload = JSON.parse(raw); } catch { return; }
  if (payload === null || typeof payload !== 'object') return;
  dispatchEvent(payload);
}

function dispatchEvent(envelope) {
  const eventType = typeof envelope.event_type === 'string' ? envelope.event_type : '';
  const data = (envelope.data !== null && typeof envelope.data === 'object') ? envelope.data : {};
  if (typeof envelope.self_id === 'number' || typeof envelope.self_id === 'string') selfId = envelope.self_id;

  switch (eventType) {
    case 'message_receive':
      dispatchMessage(envelope, data);
      return;
    case 'bot_offline':
      log('协议端报告 bot_offline：' + String(data.reason ?? '未知原因'), 'warn');
      emit({ type: 'status', connected: false, reason: 'bot_offline:' + String(data.reason ?? 'unknown'), links: links.size(), mode: MODE });
      return;
    case 'message_recall': {
      const scene = sceneOf(data.message_scene);
      emit({
        type: 'notice',
        notice_type: scene === 'group' ? 'group_recall' : 'friend_recall',
        sub_type: null,
        user_id: data.sender_id ?? null,
        group_id: scene === 'group' ? (data.peer_id ?? null) : null,
        operator_id: data.operator_id ?? null,
        message_id: data.message_seq ?? null,
        display_suffix: data.display_suffix ?? null,
        milky_event_type: eventType,
        raw: envelope,
      });
      return;
    }
    case 'group_member_increase':
    case 'group_member_decrease':
    case 'group_admin_change':
    case 'group_whole_mute':
    case 'group_mute':
    case 'group_name_change':
    case 'group_message_reaction':
    case 'group_file_upload':
    case 'group_disband':
    case 'friend_nudge':
    case 'group_nudge':
    case 'friend_file_upload':
      emit({
        type: 'notice',
        notice_type: eventType,
        sub_type: null,
        user_id: data.user_id ?? data.sender_id ?? data.initiator_id ?? null,
        group_id: data.group_id ?? (data.message_scene === 'group' ? data.peer_id ?? null : null),
        operator_id: data.operator_id ?? null,
        message_id: data.message_seq ?? null,
        milky_event_type: eventType,
        raw: envelope,
      });
      return;
    case 'friend_request':
      emit({
        type: 'request',
        request_type: 'friend',
        sub_type: null,
        user_id: data.initiator_id ?? null,
        group_id: null,
        comment: data.comment ?? null,
        // 注意：Milky 同意好友请求要用 initiator_uid，不是 QQ 号（插件侧不能直接透传成 flag）
        flag: data.initiator_uid ?? null,
        milky_event_type: eventType,
        raw: envelope,
      });
      return;
    case 'group_join_request':
    case 'group_invited_join_request':
    case 'group_invitation':
      emit({
        type: 'request',
        request_type: 'group',
        sub_type: eventType,
        user_id: data.initiator_id ?? null,
        group_id: data.group_id ?? null,
        comment: data.comment ?? null,
        flag: data.notification_seq ?? data.invitation_seq ?? null,
        milky_event_type: eventType,
        raw: envelope,
      });
      return;
    case 'peer_pin_change':
    case 'group_essence_message_change':
      emit({
        type: 'notice',
        notice_type: eventType,
        sub_type: null,
        user_id: null,
        group_id: data.group_id ?? null,
        operator_id: data.operator_id ?? null,
        message_id: data.message_seq ?? null,
        milky_event_type: eventType,
        raw: envelope,
      });
      return;
    default:
      // 其余（含未知/未来新增 event_type）：不报错，忽略。
      return;
  }
}

function dispatchMessage(envelope, data) {
  const scene = sceneOf(data.message_scene);
  const segments = unifySegments(data.segments);
  const summary = summarizeSegments(segments);
  const member = (data.group_member !== null && typeof data.group_member === 'object') ? data.group_member : null;
  const friend = (data.friend !== null && typeof data.friend === 'object') ? data.friend : null;
  const senderId = data.sender_id ?? (member !== null ? member.user_id : null) ?? (friend !== null ? friend.user_id : null) ?? null;
  const groupId = scene === 'group' ? (data.peer_id ?? null) : null;
  const peer = data.peer_id ?? groupId ?? senderId;

  rememberMessage(data.message_seq, scene, peer);

  emit({
    type: 'message',
    message_type: scene === 'group' ? 'group' : 'private',
    sub_type: scene === 'temp' ? 'temp' : null,
    message_id: data.message_seq ?? null,
    group_id: groupId,
    user_id: senderId,
    self_id: envelope.self_id ?? selfId ?? null,
    time: data.time ?? envelope.time ?? Math.floor(Date.now() / 1000),
    text: summary.text,
    images: summary.images,
    image_urls: summary.imageUrls,
    image_meta: summary.imageMeta ?? [],
    mentions: summary.mentions,
    reply_to: summary.replyTo,
    raw_message: summary.text,
    sender: {
      user_id: senderId,
      nickname: (member !== null ? member.nickname : null) ?? (friend !== null ? friend.nickname : null) ?? null,
      card: member !== null ? (member.card ?? null) : null,
      role: member !== null ? (member.role ?? null) : null,
    },
    message: segments,
  });
}

// ------------------------------------------------------------------ 出站段：统一段 -> Milky

const URI_SCHEME = /^(?:https?|base64|file):\/\//i;

/** 富媒体 -> uri（规范只认 file:// http(s):// base64:// 三种 scheme）。 */
function toUri(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return null;
  if (URI_SCHEME.test(text)) return text;
  if (/^data:[^,]*,/i.test(text)) {
    const comma = text.indexOf(',');
    return 'base64://' + text.slice(comma + 1);
  }
  const normalized = text.replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(normalized)) return 'file:///' + normalized;
  if (normalized.startsWith('/')) return 'file://' + normalized;
  // 裸文件名/资源 id：原样交给协议端（各家对相对路径的解析不一致，本适配器不做归一）。
  return normalized;
}

const degradedText = (label) => ({ type: 'text', data: { text: label } });

/** 统一段 -> Milky OutgoingSegment；发不了的段降级成文本占位（不假装成功）。 */
function toOutgoingSegment(segment) {
  if (segment === null || typeof segment !== 'object') return null;
  const type = String(segment.type ?? '').toLowerCase();
  const data = (segment.data !== null && typeof segment.data === 'object') ? segment.data : {};
  switch (type) {
    case 'text':
      return { type: 'text', data: { text: String(data.text ?? '') } };
    case 'at': {
      const qq = String(data.qq ?? '');
      if (qq === '' || qq === 'undefined' || qq === 'null') return null;
      if (qq === 'all') return { type: 'mention_all', data: {} };
      return { type: 'mention', data: { user_id: toId(qq) } };
    }
    case 'image': {
      const uri = toUri(data.url ?? data.file ?? data.path);
      if (uri === null) return null;
      const out = { type: 'image', data: { uri, sub_type: data.sub_type === 'sticker' ? 'sticker' : 'normal' } };
      if (typeof data.summary === 'string' && data.summary !== '') out.data.summary = data.summary;
      return out;
    }
    case 'reply': {
      const seq = Number(data.id ?? data.message_seq);
      if (!Number.isFinite(seq)) return null;
      return { type: 'reply', data: { message_seq: seq } };
    }
    case 'face':
      return { type: 'face', data: { face_id: String(data.id ?? data.face_id ?? ''), is_large: data.large === true || data.is_large === true } };
    case 'record': {
      const uri = toUri(data.url ?? data.file ?? data.path);
      return uri === null ? degradedText('[语音]') : { type: 'record', data: { uri } };
    }
    case 'video': {
      const uri = toUri(data.url ?? data.file ?? data.path);
      if (uri === null) return degradedText('[视频]');
      const out = { type: 'video', data: { uri } };
      if (data.thumb_url !== undefined && typeof data.thumb_url === 'string') out.data.thumb_uri = data.thumb_url;
      return out;
    }
    case 'file':
      // Milky 发送侧没有 file 段：发文件要走 upload_group_file / upload_private_file。
      return degradedText('[文件' + (typeof data.name === 'string' && data.name !== '' ? ':' + data.name : '') + ']');
    case 'forward':
      return degradedText('[合并转发]');
    case 'poke':
      return degradedText('[戳一戳]');
    case 'mface':
      return degradedText('[表情]');
    case 'json':
    case 'xml':
      return degradedText('[卡片消息]');
    default:
      return degradedText(typeof data.text === 'string' ? data.text : '');
  }
}

/**
 * 规范要求：reply 段放第一位；mention / mention_all 后面必须补一段空格 text。
 * 顺手合并相邻的 text 段，少发几段。
 */
function normalizeOutgoing(list) {
  const out = [];
  const replies = [];
  // 只用 JSDoc 声明 boolean 不够：初值 false 会被 CFA 收窄成字面量 false，闭包里的赋值不被跟踪。
  let pendingSpace = /** @type {boolean} */ (false);
  const push = (segment) => {
    if (segment.type === 'reply') { replies.push(segment); return; }
    if (pendingSpace === true) {
      pendingSpace = false;
      const startsWithSpace = segment.type === 'text' && String(segment.data.text ?? '').startsWith(' ');
      if (startsWithSpace !== true) out.push({ type: 'text', data: { text: ' ' } });
    }
    if (segment.type === 'mention' || segment.type === 'mention_all') pendingSpace = true;
    const previous = out.length === 0 ? null : out[out.length - 1];
    if (segment.type === 'text' && previous !== null && previous.type === 'text') {
      out[out.length - 1] = { type: 'text', data: { text: String(previous.data.text ?? '') + String(segment.data.text ?? '') } };
      return;
    }
    out.push(segment);
  };
  for (const segment of list) push(segment);
  if (pendingSpace === true) out.push({ type: 'text', data: { text: ' ' } });
  return [...replies.slice(0, 1), ...out];
}

function buildOutgoingMessage(command) {
  let list = [];
  if (Array.isArray(command.message) && command.message.length > 0) {
    for (const segment of command.message) {
      const outgoing = toOutgoingSegment(segment);
      if (outgoing !== null) list.push(outgoing);
    }
  }
  if (list.length === 0) list = [{ type: 'text', data: { text: String(command.text ?? '') } }];
  if (command.reply_to !== undefined && command.reply_to !== null && String(command.reply_to) !== '') {
    const seq = Number(command.reply_to);
    const first = list[0];
    if (!(first !== undefined && first.type === 'reply')) {
      if (Number.isFinite(seq)) list = [{ type: 'reply', data: { message_seq: seq } }, ...list];
      else log('reply_to 不是整数消息序号，已忽略：' + String(command.reply_to), 'warn');
    }
  }
  return normalizeOutgoing(list);
}

// ------------------------------------------------------------------ API 调用

function authHeaders() {
  return ACCESS_TOKEN === '' ? {} : { authorization: 'Bearer ' + ACCESS_TOKEN };
}

function describeRetcode(data, retcode) {
  const message = String(data.message ?? data.wording ?? '').trim();
  if (retcode === -400) return 'Milky 参数解析失败（retcode -400）' + (message === '' ? '' : '：' + message);
  if (retcode === -403) return 'Milky 协议端未处于登录状态（retcode -403）' + (message === '' ? '' : '：' + message);
  if (retcode !== null) return 'Milky 调用失败（retcode ' + String(retcode) + '）' + (message === '' ? '' : '：' + message);
  return message === '' ? 'Milky 调用失败（响应无 retcode）' : message;
}

/** POST /api/:api —— 业务成败只看 retcode（我从不相信 HTTP 200 本身）。 */
async function callApi(api, params) {
  if (HTTP_URL === '') {
    return { ok: false, error: '没有可用的 Milky HTTP API 地址（需要 --http 或可推导的 --ws）', retcode: null, data: null };
  }
  let response;
  try {
    response = await postJson(HTTP_URL + '/api/' + api, authHeaders(), (params === undefined || params === null) ? {} : params, CALL_TIMEOUT_MS);
  } catch (error) {
    const text = String(error && error.message ? error.message : error);
    const timeout = error !== null && error !== undefined && (error.name === 'AbortError' || /abort/i.test(text));
    return { ok: false, error: '调用 Milky API 失败（' + api + '）：' + (timeout ? '超时（' + CALL_TIMEOUT_MS + 'ms）' : text), retcode: null, data: null };
  }
  if (response.status === 401) {
    return { ok: false, error: '鉴权失败：Milky 协议端拒绝了 access_token（HTTP 401）', retcode: null, data: null };
  }
  if (response.status === 404) {
    return { ok: false, error: 'Milky 协议端没有这个 API：' + api + '（HTTP 404）', retcode: null, data: null };
  }
  if (response.status === 415) {
    return { ok: false, error: 'Milky 拒绝了请求格式（HTTP 415）：' + api, retcode: null, data: null };
  }
  if (!response.ok && response.data === null) {
    return { ok: false, error: 'HTTP ' + String(response.status) + '（' + api + '）', retcode: null, data: null };
  }
  const data = response.data;
  if (data === null || typeof data !== 'object') {
    return { ok: false, error: 'Milky 返回了非 JSON 响应（' + api + '，HTTP ' + String(response.status) + '）', retcode: null, data: null };
  }
  const retcode = typeof data.retcode === 'number' ? data.retcode : null;
  const ok = retcode === 0 ? true : (retcode === null ? data.status === 'ok' : false);
  const payload = data.data === undefined || data.data === null ? (ok ? {} : null) : data.data;
  return { ok, retcode, data: payload, error: ok ? null : describeRetcode(data, retcode) };
}

async function callSend(api, params) {
  const result = await callApi(api, params);
  const messageSeq = result.ok && result.data !== null ? result.data.message_seq ?? null : null;
  if (result.ok && messageSeq !== null) {
    const scene = api === 'send_group_message' ? 'group' : 'friend';
    const peer = api === 'send_group_message' ? params.group_id : params.user_id;
    rememberMessage(messageSeq, scene, peer);
  }
  return { ok: result.ok, messageId: messageSeq, data: result.data, error: result.ok ? null : result.error, retcode: result.retcode };
}

const queue = createSendQueue({ gapMs: SEND_GAP_MS, send: (action, params) => callSend(action, params), emit });

// ------------------------------------------------------------------ 动作映射

/** 撤回/查询需要场景：优先显式参数，其次入站缓存里学到的 scene/peer。 */
function resolveScene(params) {
  if (typeof params.message_scene === 'string' && params.peer_id !== undefined && params.peer_id !== null) {
    return { scene: sceneOf(params.message_scene), peer: toId(params.peer_id) };
  }
  const seq = params.message_seq ?? params.message_id;
  if (seq !== undefined && seq !== null) {
    const known = messageIndex.get(String(seq));
    if (known !== undefined) return known;
  }
  if (params.group_id !== undefined && params.group_id !== null) return { scene: 'group', peer: toId(params.group_id) };
  if (params.user_id !== undefined && params.user_id !== null) return { scene: 'friend', peer: toId(params.user_id) };
  return null;
}

const actionHandlers = {
  // ---- 系统 / 查询 ----------------------------------------------------------
  get_login_info: {
    build: () => ({ api: 'get_login_info', params: {} }),
    data: (d) => ({ user_id: d.uin ?? null, nickname: d.nickname ?? null }),
  },
  get_impl_info: {
    build: () => ({ api: 'get_impl_info', params: {} }),
    data: (d) => d,
  },
  get_group_list: {
    build: () => ({ api: 'get_group_list', params: { no_cache: false } }),
    data: (d) => (Array.isArray(d.groups) ? d.groups.map(mapGroup) : []),
  },
  get_group_info: {
    build: (p) => ({ api: 'get_group_info', params: { group_id: toId(p.group_id), no_cache: p.no_cache === true } }),
    data: (d) => mapGroup(d.group ?? d),
  },
  get_group_member_list: {
    build: (p) => ({ api: 'get_group_member_list', params: { group_id: toId(p.group_id), no_cache: p.no_cache === true } }),
    data: (d) => (Array.isArray(d.members) ? d.members.map(mapMember) : []),
  },
  get_group_member_info: {
    build: (p) => ({ api: 'get_group_member_info', params: { group_id: toId(p.group_id), user_id: toId(p.user_id), no_cache: p.no_cache === true } }),
    data: (d) => mapMember(d.member ?? d),
  },

  // ---- 群管理 --------------------------------------------------------------
  set_group_ban: {   // duration 0 = 解禁，与 Milky 一致
    build: (p) => ({ api: 'set_group_member_mute', params: { group_id: toId(p.group_id), user_id: toId(p.user_id), duration: Math.max(0, Math.floor(Number(p.duration ?? 0) || 0)) } }),
    data: (d) => d,
  },
  set_group_whole_ban: {
    build: (p) => ({ api: 'set_group_whole_mute', params: { group_id: toId(p.group_id), is_mute: p.enable === true } }),
    data: (d) => d,
  },
  set_group_kick: {
    build: (p) => ({ api: 'kick_group_member', params: { group_id: toId(p.group_id), user_id: toId(p.user_id), reject_add_request: p.reject_add_request === true } }),
    data: (d) => d,
  },
  set_group_card: {
    build: (p) => ({ api: 'set_group_member_card', params: { group_id: toId(p.group_id), user_id: toId(p.user_id), card: String(p.card ?? '') } }),
    data: (d) => d,
  },
  set_group_admin: {
    build: (p) => ({ api: 'set_group_member_admin', params: { group_id: toId(p.group_id), user_id: toId(p.user_id), is_set: p.enable === true } }),
    data: (d) => d,
  },
  set_group_name: {
    build: (p) => ({ api: 'set_group_name', params: { group_id: toId(p.group_id), new_group_name: String(p.group_name ?? p.name ?? '') } }),
    data: (d) => d,
  },
  set_group_leave: {
    build: (p) => ({ api: 'quit_group', params: { group_id: toId(p.group_id) } }),
    data: (d) => d,
  },
  send_group_poke: {
    build: (p) => ({ api: 'send_group_nudge', params: { group_id: toId(p.group_id), user_id: toId(p.user_id) } }),
    data: (d) => d,
  },
  set_group_essence: {   // OneBot 侧常叫 set_essence_msg
    build: (p) => ({ api: 'set_group_essence_message', params: { group_id: toId(p.group_id), message_seq: toId(p.message_id ?? p.message_seq), is_set: p.enable !== false } }),
    data: (d) => d,
  },
  set_essence_msg: {
    build: (p) => ({ api: 'set_group_essence_message', params: { group_id: toId(p.group_id), message_seq: toId(p.message_id ?? p.message_seq), is_set: p.enable !== false } }),
    data: (d) => d,
  },
  get_group_announcements: {
    build: (p) => ({ api: 'get_group_announcements', params: { group_id: toId(p.group_id) } }),
    data: (d) => (Array.isArray(d.announcements) ? d.announcements : []),
  },

  // ---- 消息 ----------------------------------------------------------------
  delete_msg: {
    build: (p) => {
      const seq = Number(p.message_seq ?? p.message_id);
      if (!Number.isFinite(seq)) return { error: 'delete_msg 需要 message_id（= Milky 的 message_seq）' };
      const resolved = resolveScene(p);
      if (resolved === null) {
        return { error: '撤回失败：Milky 的 recall_* 需要 message_scene 与 peer_id，delete_msg 只给了 message_id，且该消息不在入站缓存里（可传 group_id / user_id / message_scene+peer_id 补全）' };
      }
      if (resolved.scene === 'temp') {
        return { error: '本协议不支持撤回临时会话（temp）消息：Milky 只有 recall_private_message / recall_group_message' };
      }
      return resolved.scene === 'group'
        ? { api: 'recall_group_message', params: { group_id: toId(resolved.peer), message_seq: seq } }
        : { api: 'recall_private_message', params: { user_id: toId(resolved.peer), message_seq: seq } };
    },
    data: (d) => d,
  },
  get_msg: {
    build: (p) => {
      const seq = Number(p.message_seq ?? p.message_id);
      if (!Number.isFinite(seq)) return { error: 'get_msg 需要 message_id（= Milky 的 message_seq）' };
      const resolved = resolveScene(p);
      if (resolved === null) {
        return { error: '查询失败：Milky 的 get_message 需要 message_scene 与 peer_id，get_msg 只给了 message_id，且该消息不在入站缓存里' };
      }
      return { api: 'get_message', params: { message_scene: resolved.scene, peer_id: toId(resolved.peer), message_seq: seq } };
    },
    data: (d) => mapIncomingMessage(d.message ?? d),
  },
  get_group_msg_history: {
    build: (p) => {
      const limit = Math.max(1, Math.min(30, Math.floor(Number(p.count ?? 20) || 20)));
      const params = { message_scene: 'group', peer_id: toId(p.group_id), limit };
      const start = Number(p.message_seq ?? p.message_id);
      if (Number.isFinite(start)) params.start_message_seq = start;
      return { api: 'get_history_messages', params };
    },
    // OneBot/NapCat 语义：不带 reverseOrder 时新→旧；带 reverseOrder 时升序（插件会再反转成新→旧）。
    data: (d, p) => ({
      messages: orderHistory(d.messages, p),
      next_message_seq: d.next_message_seq ?? null,
    }),
  },
  get_friend_msg_history: {
    build: (p) => {
      const limit = Math.max(1, Math.min(30, Math.floor(Number(p.count ?? 20) || 20)));
      const params = { message_scene: 'friend', peer_id: toId(p.user_id), limit };
      const start = Number(p.message_seq ?? p.message_id);
      if (Number.isFinite(start)) params.start_message_seq = start;
      return { api: 'get_history_messages', params };
    },
    data: (d, p) => ({
      messages: orderHistory(d.messages, p),
      next_message_seq: d.next_message_seq ?? null,
    }),
  },
  send_group_msg: {
    build: (p) => ({ api: 'send_group_message', params: { group_id: toId(p.group_id), message: buildOutgoingMessage({ message: p.message, text: p.text }) } }),
    data: (d) => ({ message_id: d.message_seq ?? null, message_seq: d.message_seq ?? null, time: d.time ?? null }),
  },
  send_private_msg: {
    build: (p) => ({ api: 'send_private_message', params: { user_id: toId(p.user_id), message: buildOutgoingMessage({ message: p.message, text: p.text }) } }),
    data: (d) => ({ message_id: d.message_seq ?? null, message_seq: d.message_seq ?? null, time: d.time ?? null }),
  },
  send_msg: {
    build: (p) => (p.group_id !== undefined && p.group_id !== null
      ? { api: 'send_group_message', params: { group_id: toId(p.group_id), message: buildOutgoingMessage({ message: p.message, text: p.text }) } }
      : { api: 'send_private_message', params: { user_id: toId(p.user_id), message: buildOutgoingMessage({ message: p.message, text: p.text }) } }),
    data: (d) => ({ message_id: d.message_seq ?? null, message_seq: d.message_seq ?? null, time: d.time ?? null }),
  },
};

/**
 * Milky 的 get_history_messages 返回升序（message_seq 从小到大）。
 * 按 NapCat 语义对齐：默认给插件新→旧；reverseOrder=true 时给升序（插件自己会反转）。
 */
function orderHistory(rawMessages, params) {
  const list = Array.isArray(rawMessages)
    ? rawMessages.map(mapIncomingMessage).filter((message) => message !== null)
    : [];
  list.sort((a, b) => Number(a.message_id) - Number(b.message_id));
  const ascending = params !== null && params !== undefined && params.reverseOrder === true;
  return ascending ? list : list.slice().reverse();
}

/** Milky 自己的 API 名（1.3）——插件若透传原名，直接放行，不谎报「不支持」。 */
const MILKY_ENDPOINTS = new Set([
  'get_login_info', 'get_impl_info', 'get_user_profile', 'get_friend_list', 'get_friend_info',
  'get_group_list', 'get_group_info', 'get_group_member_list', 'get_group_member_info',
  'get_peer_pins', 'set_peer_pin', 'set_avatar', 'set_nickname', 'set_bio',
  'get_custom_face_url_list', 'get_cookies', 'get_csrf_token',
  'send_private_message', 'send_group_message', 'recall_private_message', 'recall_group_message',
  'get_message', 'get_history_messages', 'get_resource_temp_url', 'get_forwarded_messages',
  'mark_message_as_read',
  'send_friend_nudge', 'send_profile_like', 'delete_friend', 'get_friend_requests',
  'accept_friend_request', 'reject_friend_request',
  'set_group_name', 'set_group_avatar', 'set_group_member_card', 'set_group_member_special_title',
  'set_group_member_admin', 'set_group_member_mute', 'set_group_whole_mute', 'kick_group_member',
  'get_group_announcements', 'send_group_announcement', 'delete_group_announcement',
  'get_group_essence_messages', 'set_group_essence_message', 'quit_group',
  'send_group_message_reaction', 'send_group_nudge', 'get_group_notifications',
  'accept_group_request', 'reject_group_request', 'accept_group_invitation', 'reject_group_invitation',
  'upload_private_file', 'upload_group_file', 'get_private_file_download_url',
  'get_group_file_download_url', 'get_group_files', 'move_group_file', 'rename_group_file',
  'delete_group_file', 'persist_group_file', 'create_group_folder', 'rename_group_folder',
  'delete_group_folder',
]);

function emitActionResult(action, echo, ok, data, error, retcode) {
  emit({
    type: 'action_result',
    action,
    echo,
    ok,
    retcode: retcode === undefined ? null : retcode,
    data: data === undefined ? null : data,
    error: ok ? null : (error === undefined || error === null ? '未知错误' : String(error)),
  });
}

async function runAction(action, params, echo) {
  const handler = actionHandlers[action];
  let plan;
  if (handler !== undefined) {
    try {
      plan = handler.build(params);
    } catch (error) {
      emitActionResult(action, echo, false, null, String(error && error.message ? error.message : error));
      return;
    }
  } else if (MILKY_ENDPOINTS.has(action)) {
    plan = { api: action, params };
  } else {
    emitActionResult(action, echo, false, null, '本协议不支持 ' + action + '（Milky 1.3 无对应 API）');
    return;
  }

  if (plan !== undefined && plan.error !== undefined) {
    emitActionResult(action, echo, false, null, plan.error);
    return;
  }
  const result = await callApi(plan.api, plan.params);
  if (result.ok !== true) {
    emitActionResult(action, echo, false, null, result.error, result.retcode);
    return;
  }
  let data = result.data;
  if (handler !== undefined && typeof handler.data === 'function') {
    try { data = handler.data(result.data ?? {}, params); }
    catch (error) { data = result.data; log('归一化 ' + action + ' 的响应失败：' + String(error && error.message ? error.message : error), 'warn'); }
  }
  emitActionResult(action, echo, true, data, null, result.retcode);
}

// ------------------------------------------------------------------ 命令

function handleCommand(command) {
  if (command === null || typeof command !== 'object') return;
  switch (command.type) {
    case 'send': {
      const messageType = command.message_type === 'group' ? 'group' : 'private';
      const targetId = command.target_id;
      if (targetId === undefined || targetId === null || String(targetId) === '') {
        emit({ type: 'send_result', ok: false, echo: command.echo ?? null, message_id: null, error: '缺少 target_id' });
        return;
      }
      if (HTTP_URL === '') {
        emit({ type: 'send_result', ok: false, echo: command.echo ?? null, message_id: null, error: '没有可用的 Milky HTTP API 地址（需要 --http 或可推导的 --ws）' });
        return;
      }
      const message = buildOutgoingMessage(command);
      const api = messageType === 'group' ? 'send_group_message' : 'send_private_message';
      const params = messageType === 'group'
        ? { group_id: toId(targetId), message }
        : { user_id: toId(targetId), message };
      queue.enqueue({ action: api, params, echo: command.echo ?? null });
      return;
    }
    case 'action': {
      const actionName = typeof command.action === 'string' ? command.action : '';
      if (actionName === '') {
        emitActionResult(null, command.echo ?? null, false, null, '缺少 action');
        return;
      }
      const params = (command.params !== null && typeof command.params === 'object') ? command.params : {};
      void runAction(actionName, params, command.echo ?? null);
      return;
    }
    default:
      emit({ type: 'error', text: '未知命令：' + String(command.type) });
  }
}

// ------------------------------------------------------------------ 传输

/** 可选自检：get_impl_info 确认协议端与 milky_version（规范落地清单第 9 条）。 */
async function selfCheck() {
  const result = await callApi('get_impl_info', {});
  if (result.ok !== true) {
    if (versionLogged !== true) log('协议端自检失败：' + String(result.error), 'warn');
    return;
  }
  const info = result.data ?? {};
  versionLogged = true;
  log('协议端：' + String(info.impl_name ?? '未知') + ' ' + String(info.impl_version ?? '')
    + '｜milky_version ' + String(info.milky_version ?? '未知')
    + '｜QQ 协议 ' + String(info.qq_protocol_type ?? '?') + ' ' + String(info.qq_protocol_version ?? ''));
  if (info.milky_version !== undefined && String(info.milky_version).split('.')[0] !== '1') {
    log('协议端 Milky 版本是 ' + String(info.milky_version) + '，本适配器按 1.3 写成，字段可能有出入', 'warn');
  }
}

if (WS_URL !== '') {
  connectForward({
    url: WS_URL,
    token: ACCESS_TOKEN,
    linkSet: links,
    onText: (link, text) => onLinkMessage(link, text),
    onOpen: () => {
      log('正向 WS 已连接 ' + WS_URL);
      setStatus('');
      void selfCheck();
    },
    onClose: (info) => setStatus('closed(' + String(info.code ?? '?') + ')'),
    onError: (info) => {
      if (info.phase === 'retry') log('正向 WS ' + String(info.delayMs) + 'ms 后重连', 'warn');
      else if (info.phase === 'create') fail('正向 WS 建立失败：' + String(info.error && info.error.message ? info.error.message : info.error));
    },
  });
}

const MAX_WEBHOOK_BODY = 1024 * 1024;

/** 读回调体，最多 1 MiB（超限后停止缓存、继续排空，避免把内存交给对面）。 */
function readBody(req, maxBytes = MAX_WEBHOOK_BODY) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let oversize = false;
    req.on('data', (chunk) => {
      if (oversize === true) return;
      total += chunk.length;
      if (total > maxBytes) { oversize = true; chunks.length = 0; return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve({ body: oversize === true ? '' : Buffer.concat(chunks).toString('utf8'), oversize }));
    req.on('error', () => resolve({ body: '', oversize }));
  });
}

/** WebHook 模式：协议端把事件 POST 过来（body 与 WS 帧完全相同，鉴权方向反过来由我们校验）。 */
function startWebhookServer(options) {
  const { listen, token, onListening, onError } = options;
  // 与反向 WS 同一条规则：没配 token 时回调口只能听回环。
  // 事件里的 user_id 直接决定身份，绑 0.0.0.0 且不校验 token 等于「谁都能冒充任意 QQ 号」（#33）。
  const addr = resolveListenAddress(listen, token !== '' && token !== undefined && token !== null);
  const host = addr.host;
  const port = Number(addr.port);
  if (!Number.isFinite(port)) { onError('--listen 端口无效：' + listen); return null; }
  if (addr.forcedLoopback === true) {
    onError('WebHook 未配置 access_token：已强制只监听 127.0.0.1（要公网监听请先配置 token）');
  }
  const authorized = bearerOrQueryToken(token);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://' + (host === '0.0.0.0' ? '127.0.0.1' : host));
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('只接受 POST 事件回调');
      return;
    }
    if (authorized(req, url) !== true) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'failed', retcode: -1, message: 'access token mismatch' }));
      return;
    }
    const read = await readBody(req);
    if (read.oversize === true) {
      res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'failed', retcode: -1, message: 'event body too large（上限 1 MiB）' }));
      log('WebHook 回调体超过 1 MiB，已拒收', 'warn');
      return;
    }
    const raw = read.body;
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end('{}');
    if (raw.trim() === '') return;
    let payload;
    try { payload = JSON.parse(raw); } catch { log('WebHook 收到非 JSON 事件：' + raw.slice(0, 200), 'warn'); return; }
    if (payload !== null && typeof payload === 'object') dispatchEvent(payload);
  });

  server.on('error', (error) => onError('WebHook 服务启动失败：' + String(error && error.message ? error.message : error)));
  server.listen(port, host, () => {
    const bound = server.address();
    const actualPort = bound !== null && typeof bound === 'object' ? bound.port : port;
    onListening({ host, port: actualPort });
  });
  return server;
}

if (LISTEN !== '') {
  const webhook = startWebhookServer({
    listen: LISTEN,
    token: ACCESS_TOKEN,
    onListening: (info) => {
      log('WebHook 监听 ' + info.host + ':' + String(info.port) + '（在协议端把事件回调地址填成 http://<本机IP>:' + String(info.port) + '/event）');
      emit({ type: 'listening', host: info.host, port: info.port });
      // WebHook 模式没有长连接：用一条哑链路表示「回调服务就绪」，让插件看到 connected=true。
      links.add({
        label: 'webhook ' + info.host + ':' + String(info.port),
        ready: true,
        send: () => false,
        close: () => { if (webhook !== null) { try { webhook.close(); } catch { /* ignore */ } } },
      });
      setStatus('');
    },
    onError: (text) => fail(text),
  });
}

// ------------------------------------------------------------------ 生命周期

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
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
  type: 'hello',
  adapter: 'milky',
  protocolVersion: '1.3',
  mode: MODE,
  wsUrl: WS_URL,
  httpUrl: HTTP_URL,
  listen: LISTEN,
  hasToken: ACCESS_TOKEN !== '',
  pid: process.pid,
});

if (LISTEN === '' && WS_URL === '') fail('既没有 --ws 也没有 --listen，无法接收 Milky 事件');
if (HTTP_URL === '') log('没有 HTTP API 地址（--http），调 API / 发消息都会失败', 'warn');
setStatus('starting');
