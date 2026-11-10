#!/usr/bin/env node
/**
 * QQ 官方机器人（QQ 开放平台 API v2）适配器 —— 零 npm 依赖，Node >= 22。
 *
 * 规范来源：https://bot.q.qq.com/wiki/develop/api-v2/
 *
 * 传输（二选一，--mode 切换）：
 *   ws       --appid --secret                      先 POST /app/getAppAccessToken 拿 access_token，
 *                                                  再 GET /gateway 拿 wss 地址，走 op10 hello -> op2 identify
 *                                                  -> op0 dispatch（心跳 op1/op11，断线 op6 resume，op7 重连）。
 *   webhook  --listen 127.0.0.1:8080 --path /cb     用 node:http 起回调服务：Ed25519 签名校验、
 *                                                  op13 回调地址验证、op0 事件 ACK {"op":12}。
 *
 * 与 OneBot 11 的关键差异（本文件据此实现，勿照搬 OneBot 语义）：
 *   - 鉴权：HTTP 头 Authorization: QQBot <token>；WS identify 里 d.token = "QQBot <token>"；token 2h 过期需刷新。
 *   - ID 是 OpenID 字符串（user_openid / group_openid / member_openid），不是 QQ 号，不能反查。
 *   - 事件信封 { op, s, t, d, id }，t 是事件名；没有 post_type / CQ 码 / 消息段上行。
 *   - 上行消息 = content（@ 已剥离机器人，别名 @ 形如 <@member_openid>）+ attachments + ark_data + msg_elements。
 *   - 下行只能 msg_type 0(文本)/2(markdown)/6(输入中)/7(富媒体)；**没有 at 段、没有 ARK/Embed 发送**。
 *   - 图片必须先 POST /v2/{users|groups}/{id}/files 换 file_info，再 msg_type=7 带 media.file_info。
 *   - 被动回复用 msg_id（事件 d.id）+ 递增 msg_seq；主动消息有严格频控。
 *
 * 与插件之间的 stdio 契约见 lib/transport/bridge/CONTRACT.md。
 */
import http from 'node:http';
import { resolveListenAddress } from '../bridge/ws.mjs';
import crypto from 'node:crypto';
import process from 'node:process';
import { readFile } from 'node:fs/promises';
import { createEmitter, createSendQueue, installStdin, installCrashHandlers, postJson } from '../bridge/stdio.mjs';
import { segmentsToText, atQqsOf, imageMetaOf } from '../../message/segments.mjs';

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
const MODE = String(argv.mode ?? process.env.QQ_BOT_MODE ?? 'ws').trim().toLowerCase() === 'webhook' ? 'webhook' : 'ws';
const APP_ID = String(argv.appid ?? process.env.QQ_BOT_APPID ?? '').trim();
const APP_SECRET = String(argv.secret ?? process.env.QQ_BOT_SECRET ?? '').trim();
// 回调签名用的是 BotSecret（规范：seed = botSecret 反复自乘到 32 字节），取 token 用的是 AppSecret。
// 两者正常就是不同的值；没配 botSecret 时回落 appSecret，保持对老配置的兼容。
const BOT_SECRET = String(argv['bot-secret'] ?? process.env.QQ_BOT_BOTSECRET ?? APP_SECRET).trim();
const API_BASE = String(argv['api-base'] ?? process.env.QQ_BOT_API_BASE ?? 'https://api.bot.qq.com').replace(/\/+$/, '');
const LISTEN = String(argv.listen ?? process.env.QQ_BOT_LISTEN ?? '').trim();
const WEBHOOK_PATH = normalizePath(argv.path ?? process.env.QQ_BOT_PATH ?? '/');
const INTENTS = Number(argv.intents ?? process.env.QQ_BOT_INTENTS ?? 100663296) || 100663296;
const SHARD_INDEX = Math.max(0, Number(argv['shard-index'] ?? 0) || 0);
const SHARD_COUNT = Math.max(1, Number(argv['shard-count'] ?? 1) || 1);
const SELF_ID_ARG = String(argv['self-id'] ?? process.env.QQ_BOT_SELF_ID ?? '').trim();
const GATEWAY_URL_ARG = String(argv['gateway-url'] ?? '').trim();
const SEND_GAP_MS = Number(argv['send-gap-ms'] ?? 350);
const TOKEN_MARGIN_MS = Number(argv['token-margin-ms'] ?? 60000);
const HTTP_TIMEOUT_MS = Number(argv['http-timeout-ms'] ?? 15000);
const TEXT_CHUNK = Math.max(200, Number(argv['text-chunk'] ?? 1800) || 1800);
// 本地调试用：平台回调必须带 Ed25519 签名。显式 --allow-unsigned 会**整块跳过**签名校验与
// 时间戳新鲜度检查——签名错误、时间戳过期的回调也照收（只剩 event id 去重）。默认关，别在线上开。
const ALLOW_UNSIGNED = argv['allow-unsigned'] === 'true' || argv['allow-unsigned'] === true;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // /files file_data 直传上限 5MB
// 回调重放防护（#22）：签名只覆盖 timestamp+body，本身不保证新鲜度——
// 抓到一条合法回调就能无限重放，所以①时间戳必须在 ±5 分钟内，②事件 id 去重。
const WEBHOOK_SKEW_SECONDS = 300;
const seenEventIds = new Map(); // eventId -> 首次见到的时间（毫秒）
/** 记下事件 id；重复返回 true。表按时间戳剪枝，最多留 2000 条。 */
function isDuplicateEvent(eventId) {
  const now = Date.now();
  for (const [key, at] of seenEventIds) {
    if (now - at > WEBHOOK_SKEW_SECONDS * 1000) seenEventIds.delete(key);
  }
  if (seenEventIds.has(eventId)) return true;
  seenEventIds.set(eventId, now);
  while (seenEventIds.size > 2000) {
    const oldest = seenEventIds.keys().next().value;
    seenEventIds.delete(oldest);
  }
  return false;
}

function normalizePath(raw) {
  const text = String(raw ?? '/').trim();
  if (text === '') return '/';
  return text.startsWith('/') ? text : '/' + text;
}

// ------------------------------------------------------------------ 输出与状态

const { emit, log, fail } = createEmitter();
let shuttingDown = false;
let webhookListening = false;
let gatewayReady = false;
let lastReason = '';
let selfId = SELF_ID_ARG !== '' ? SELF_ID_ARG : null;
let webhookServer = null;

function setStatus(reason) {
  const connected = MODE === 'webhook' ? webhookListening : gatewayReady;
  if (connected) lastReason = '';
  else if (reason !== undefined) lastReason = reason;
  emit({ type: 'status', connected, reason: lastReason || null, links: connected ? 1 : 0, mode: MODE });
}

const errorText = (error) => String(error && error.message ? error.message : error);

// ------------------------------------------------------------------ 鉴权（access_token 缓存 + 刷新）

const tokenState = { value: '', expiresAt: 0, inflight: null, fetched: 0 };

/**
 * POST {api.base}/app/getAppAccessToken —— 注意 expires_in 是**字符串**，
 * 且失败时 HTTP 仍是 200，错误在 body.code（100016 = appid/secret 错）。
 */
async function fetchAccessToken() {
  if (APP_ID === '' || APP_SECRET === '') throw new Error('缺少 appId/clientSecret');
  const response = await postJson(API_BASE + '/app/getAppAccessToken', {}, { appId: APP_ID, clientSecret: APP_SECRET }, HTTP_TIMEOUT_MS);
  const data = response.data;
  if (data === null || typeof data !== 'object') throw new Error('access_token 接口返回非 JSON（HTTP ' + String(response.status) + '）');
  if (data.code !== undefined && data.code !== null && Number(data.code) !== 0) {
    throw new Error('access_token 获取失败 code=' + String(data.code) + ' ' + String(data.message ?? ''));
  }
  const token = data.access_token;
  if (typeof token !== 'string' || token === '') throw new Error('access_token 响应缺少 access_token');
  const ttlText = data.expires_in;
  const ttlSeconds = Number(ttlText);
  const ttlMs = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds * 1000 : 7200 * 1000;
  tokenState.value = token;
  // 距过期 < 60s 就换新（平台允许新旧 token 并存 60s，天然双 token 轮换）。
  tokenState.expiresAt = Date.now() + ttlMs - TOKEN_MARGIN_MS;
  tokenState.fetched += 1;
  log('access_token 已刷新（第 ' + String(tokenState.fetched) + ' 次，有效期 ' + String(ttlSeconds || 7200) + 's）');
  return token;
}

function getAccessToken(force = false) {
  if (!force && tokenState.value !== '' && Date.now() < tokenState.expiresAt) return Promise.resolve(tokenState.value);
  if (tokenState.inflight !== null) return tokenState.inflight;
  tokenState.inflight = (async () => {
    try { return await fetchAccessToken(); }
    finally { tokenState.inflight = null; }
  })();
  return tokenState.inflight;
}

// ------------------------------------------------------------------ HTTP OpenAPI

async function rawRequest(method, apiPath, body, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  if (timer.unref) timer.unref();
  try {
    const headers = { authorization: 'QQBot ' + token };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(API_BASE + apiPath, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    if (text !== '') { try { data = JSON.parse(text); } catch { data = null; } }
    return { status: response.status, ok: response.ok, data, text };
  } catch (error) {
    return { status: null, ok: false, data: null, text: '', error: '请求 ' + apiPath + ' 失败：' + errorText(error) };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeResponse(response) {
  if (typeof response.error === 'string') return { ok: false, status: null, data: null, code: null, error: response.error };
  const data = response.data;
  const hasCode = data !== null && typeof data === 'object' && data.code !== undefined && data.code !== null;
  const code = hasCode ? Number(data.code) : 0;
  const ok = response.ok === true && code === 0;
  let error = null;
  if (!ok) {
    const message = data !== null && typeof data === 'object' ? String(data.message ?? data.msg ?? '') : '';
    error = message !== '' ? message + '（code ' + String(code) + '）' : 'HTTP ' + String(response.status);
  }
  return { ok, status: response.status, data, code: code === 0 ? null : code, error };
}

/** 带 token 的 OpenAPI 调用；401 时强制换 token 重试一次。 */
async function apiRequest(method, apiPath, body) {
  let token;
  try { token = await getAccessToken(); }
  catch (error) { return { ok: false, status: null, data: null, code: null, error: '获取 access_token 失败：' + errorText(error) }; }
  let response = await rawRequest(method, apiPath, body, token);
  if (response.status === 401) {
    try { token = await getAccessToken(true); } catch { /* 保留首个错误 */ }
    response = await rawRequest(method, apiPath, body, token);
  }
  return normalizeResponse(response);
}

// ------------------------------------------------------------------ Ed25519（webhook 签名 / op13）

let cachedSecretSeed = null;
let cachedPrivateKey = null;

/** 规范：seed = secret 反复自乘（seed = seed + seed）直到 >= 32 字节，取前 32 字节。 */
function secretSeed(secret) {
  let seed = Buffer.from(String(secret ?? ''), 'utf8');
  if (seed.length === 0) throw new Error('BotSecret 为空，无法派生 Ed25519 种子');
  while (seed.length < 32) seed = Buffer.concat([seed, seed]);
  return seed.subarray(0, 32);
}

function ed25519PrivateKeyFromSeed(seed) {
  // PKCS#8 DER 前缀 + 32 字节 seed
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

function privateKey() {
  if (cachedPrivateKey === null) {
    if (cachedSecretSeed === null) cachedSecretSeed = secretSeed(BOT_SECRET);
    cachedPrivateKey = ed25519PrivateKeyFromSeed(cachedSecretSeed);
  }
  return cachedPrivateKey;
}

function signEd25519(message) {
  return crypto.sign(null, Buffer.from(message, 'utf8'), privateKey()).toString('hex');
}

function verifyEd25519(message, signatureHex) {
  if (typeof signatureHex !== 'string' || !/^[0-9a-fA-F]{128}$/.test(signatureHex)) return false;
  try {
    const publicKey = crypto.createPublicKey(privateKey());
    return crypto.verify(null, Buffer.from(message, 'utf8'), publicKey, Buffer.from(signatureHex, 'hex'));
  } catch { return false; }
}

// ------------------------------------------------------------------ 事件 -> message 帧

/** 规范化时间戳：RFC3339 字符串 / 数字（秒或毫秒）-> 秒。 */
function toSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  if (typeof value === 'string' && value !== '') {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  return Math.floor(Date.now() / 1000);
}

/**
 * 上行 content + attachments -> { segments, text, images, imageUrls }。
 * content 里 @ 形如 <@member_openid> / <@all>（@机器人已被平台剥离）；附件按 content_type 分类。
 */
function buildInbound(content, attachments) {
  const segments = [];
  const imageUrls = [];
  let images = 0;
  const text = typeof content === 'string' ? content : '';
  const mentionPattern = /<@!?([^>\s]+)>/g;
  let cursor = 0;
  let match;
  while ((match = mentionPattern.exec(text)) !== null) {
    if (match.index > cursor) segments.push({ type: 'text', data: { text: text.slice(cursor, match.index) } });
    const raw = match[1];
    segments.push({ type: 'at', data: { qq: raw === 'all' ? 'all' : raw } });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) segments.push({ type: 'text', data: { text: text.slice(cursor) } });

  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    if (attachment === null || typeof attachment !== 'object') continue;
    const contentType = String(attachment.content_type ?? '').toLowerCase();
    const url = typeof attachment.url === 'string' ? attachment.url : '';
    if (contentType.startsWith('image')) {
      images += 1;
      if (url !== '') imageUrls.push(url);
      // QQ 官方接口对「表情」会给 sub_type=1 或 summary 文案，与 OneBot 口径对齐后再交给收图判定。
      segments.push({
        type: 'image',
        data: {
          url,
          width: attachment.width ?? null,
          height: attachment.height ?? null,
          sub_type: attachment.sub_type ?? null,
          summary: attachment.summary ?? null,
        },
      });
      continue;
    }
    if (contentType === 'voice') {
      const voiceUrl = typeof attachment.voice_wav_url === 'string' && attachment.voice_wav_url !== '' ? attachment.voice_wav_url : url;
      segments.push({ type: 'record', data: { url: voiceUrl, text: attachment.asr_refer_text ?? null } });
      continue;
    }
    if (contentType.startsWith('video')) { segments.push({ type: 'video', data: { url } }); continue; }
    segments.push({ type: 'file', data: { name: String(attachment.filename ?? ''), url } });
  }

  return { segments, text: segmentsToText(segments).trim(), images, imageUrls, imageMeta: imageMetaOf(segments), mentions: atQqsOf(segments) };
}

/** message_scene.ext 是 ["key=value", ...]；取引用索引（被引用消息的 msg_idx）。 */
function sceneExt(d) {
  const out = {};
  const scene = d !== null && typeof d === 'object' ? d.message_scene : null;
  const ext = scene !== null && typeof scene === 'object' && Array.isArray(scene.ext) ? scene.ext : [];
  for (const item of ext) {
    if (typeof item !== 'string') continue;
    const index = item.indexOf('=');
    if (index <= 0) continue;
    out[item.slice(0, index)] = item.slice(index + 1);
  }
  return out;
}

function emitMessage(messageType, d, eventId) {
  const author = d !== null && typeof d === 'object' && d.author !== null && typeof d.author === 'object' ? d.author : {};
  const userId = messageType === 'group'
    ? (author.member_openid ?? author.id ?? null)
    : (author.user_openid ?? author.id ?? null);
  const groupId = messageType === 'group' ? (d.group_openid ?? null) : null;
  const built = buildInbound(d.content, d.attachments);
  const ext = sceneExt(d);
  const quoted = Array.isArray(d.msg_elements) && d.msg_elements.length > 0 && d.msg_elements[0] !== null
    ? (d.msg_elements[0].msg_idx ?? null)
    : null;
  const replyTo = ext.ref_msg_idx ?? quoted ?? null;

  emit({
    type: 'message',
    message_type: messageType,
    sub_type: null,
    message_id: d.id !== undefined && d.id !== null ? String(d.id) : (eventId !== null && eventId !== undefined ? String(eventId) : null),
    group_id: groupId !== null ? String(groupId) : null,
    user_id: userId !== null ? String(userId) : null,
    self_id: selfId,
    time: toSeconds(d.timestamp),
    text: built.text,
    images: built.images,
    image_urls: built.imageUrls,
    image_meta: built.imageMeta ?? [],
    mentions: built.mentions,
    reply_to: replyTo !== null ? String(replyTo) : null,
    raw_message: typeof d.content === 'string' ? d.content : null,
    sender: {
      user_id: userId !== null ? String(userId) : null,
      nickname: typeof author.username === 'string' && author.username !== '' ? author.username : null,
      card: null, // 官方 API 无群名片概念
      role: messageType === 'group' && typeof author.member_role === 'string' ? author.member_role : null,
    },
    message: built.segments,
  });
}

const NOTICE_EVENTS = {
  GROUP_ADD_ROBOT: 'group_add_bot',
  GROUP_DEL_ROBOT: 'group_del_bot',
  GROUP_MSG_RECEIVE: 'group_msg_receive',
  GROUP_MSG_REJECT: 'group_msg_reject',
  C2C_MSG_RECEIVE: 'c2c_msg_receive',
  C2C_MSG_REJECT: 'c2c_msg_reject',
  FRIEND_ADD: 'friend_add',
  FRIEND_DEL: 'friend_del',
  MESSAGE_AUDIT_PASS: 'message_audit_pass',
  MESSAGE_AUDIT_REJECT: 'message_audit_reject',
};

/** 分发一条平台事件（WS op0 / webhook op0 共用）。 */
function dispatchEvent(eventName, d, eventId) {
  const body = d !== null && typeof d === 'object' ? d : {};
  switch (String(eventName ?? '')) {
    case 'C2C_MESSAGE_CREATE': emitMessage('private', body, eventId); return;
    case 'GROUP_AT_MESSAGE_CREATE':
    case 'GROUP_MESSAGE_CREATE': emitMessage('group', body, eventId); return;
    case 'GROUP_JOIN_REQUEST':
      emit({
        type: 'request',
        request_type: 'group',
        sub_type: 'group_join_request',
        flag: body.join_request_id ?? body.id ?? eventId ?? null,
        comment: body.comment ?? null,
        user_id: body.member_openid ?? null,
        group_id: body.group_openid ?? null,
        raw: body,
      });
      return;
    case 'INTERACTION_CREATE': {
      emit({
        type: 'notice',
        notice_type: 'interaction',
        sub_type: body.type !== undefined ? String(body.type) : null,
        user_id: body.user_openid ?? null,
        group_id: body.group_openid ?? null,
        operator_id: body.group_member_openid ?? null,
        event_id: eventId ?? null,
        raw: body,
      });
      // 按钮点击也翻译成一条 message：否则模型只能看到 notice，用户点了按钮像石沉大海。
      // 文本优先取按钮的 data（约定放指令），没有就退回按钮 id 的占位。
      const interactive = (body.data !== null && typeof body.data === 'object') ? body.data : {};
      const resolved = (interactive.resolved !== null && typeof interactive.resolved === 'object') ? interactive.resolved : {};
      const buttonData = resolved.button_data ?? interactive.button_data ?? '';
      const buttonId = resolved.button_id ?? interactive.button_id ?? '';
      const clickText = String(buttonData) !== '' ? String(buttonData) : ('[按钮 ' + String(buttonId || '未知') + ']');
      emit({
        type: 'message',
        sub_type: 'interaction',
        message_id: body.id ?? eventId ?? null,
        message_type: (body.group_openid !== undefined && body.group_openid !== null) ? 'group' : 'private',
        user_id: body.user_openid ?? null,
        group_id: body.group_openid ?? null,
        text: clickText,
        // 互动事件没有 at 段：显式给空数组，别让插件退化成「正文里有没有 @」的猜测。
        mentions: [],
        raw: body,
      });
      // 规范：type 11/12 不回应会让用户端一直转圈，这里统一回 code=0（成功）。
      if (body.id !== undefined && body.id !== null) {
        void apiRequest('PUT', '/interactions/' + encodeURIComponent(String(body.id)), { code: 0 })
          .then((result) => { if (!result.ok) log('互动事件应答失败：' + String(result.error), 'warn'); });
      }
      return;
    }
    default: break;
  }
  if (Object.prototype.hasOwnProperty.call(NOTICE_EVENTS, String(eventName ?? ''))) {
    emit({
      type: 'notice',
      notice_type: NOTICE_EVENTS[String(eventName)],
      sub_type: String(eventName),
      user_id: body.user_openid ?? body.openid ?? null,
      group_id: body.group_openid ?? null,
      operator_id: body.op_member_openid ?? body.operator_openid ?? null,
      // 关系类事件（GROUP_ADD_ROBOT / FRIEND_ADD ...）的平台被动回复凭证是 event_id（外层 Payload id），
      // 透出给插件，欢迎语之类可直接拿它做被动回复。
      event_id: eventId ?? null,
      raw: body,
    });
    return;
  }
  log('未处理的事件：' + String(eventName ?? '(空)'));
}

// ------------------------------------------------------------------ 发送

/** 被引用消息的 msg_id -> 已用 msg_seq（同 msg_id+msg_seq 重发必失败，必须递增）。 */
const msgSeqMap = new Map();

function nextMsgSeq(msgId) {
  const used = msgSeqMap.get(msgId) ?? 0;
  const next = used + 1;
  msgSeqMap.set(msgId, next);
  if (msgSeqMap.size > 500) {
    // 简单的容量保护：丢掉最早的一半（被动窗口只有 5 分钟，旧记录意义不大）。
    const keys = [...msgSeqMap.keys()].slice(0, 250);
    for (const key of keys) msgSeqMap.delete(key);
  }
  return next;
}

function messagePath(messageType, targetId) {
  const id = encodeURIComponent(String(targetId));
  return messageType === 'group' ? '/v2/groups/' + id + '/messages' : '/v2/users/' + id + '/messages';
}

function filePath(messageType, targetId) {
  const id = encodeURIComponent(String(targetId));
  return messageType === 'group' ? '/v2/groups/' + id + '/files' : '/v2/users/' + id + '/files';
}

function imageSourceOf(data) {
  const candidate = typeof data.url === 'string' && data.url !== '' ? data.url
    : (typeof data.file === 'string' && data.file !== '' ? data.file : '');
  if (candidate === '') return null;
  if (/^https?:\/\//i.test(candidate)) return { kind: 'url', value: candidate };
  if (candidate.startsWith('base64://')) return { kind: 'base64', value: candidate.slice('base64://'.length) };
  if (candidate.startsWith('data:')) {
    const comma = candidate.indexOf(',');
    if (comma > 0) return { kind: 'base64', value: candidate.slice(comma + 1) };
  }
  return { kind: 'path', value: candidate };
}

/** 插件下发的 send 命令 -> 发送计划（文本优先，图片走 /files 上传）。 */
function planSend(command) {
  const images = [];
  const texts = [];
  let replyId = null;
  const segments = Array.isArray(command.message) && command.message.length > 0 ? command.message : null;
  if (segments !== null) {
    for (const segment of segments) {
      if (segment === null || typeof segment !== 'object') continue;
      const type = String(segment.type ?? '').toLowerCase();
      const data = segment.data !== null && typeof segment.data === 'object' ? segment.data : {};
      switch (type) {
        case 'text': texts.push(String(data.text ?? '')); break;
        case 'at': texts.push(String(data.qq) === 'all' ? '@全体成员 ' : '@' + String(data.qq ?? '') + ' '); break;
        case 'image': {
          const source = imageSourceOf(data);
          if (source !== null) images.push(source);
          break;
        }
        case 'reply':
          if (data.id !== undefined && data.id !== null && String(data.id) !== '') replyId = String(data.id);
          break;
        case 'face': texts.push('[表情]'); break;
        case 'record': texts.push('[语音]'); break;
        case 'video': texts.push('[视频]'); break;
        case 'file': texts.push('[文件]'); break;
        default: if (typeof data.text === 'string') texts.push(data.text); break;
      }
    }
  } else {
    texts.push(String(command.text ?? ''));
  }
  if (command.reply_to !== undefined && command.reply_to !== null && String(command.reply_to) !== '') {
    replyId = String(command.reply_to);
  }
  // 官方 API v2 的富消息：markdown（msg_type=2）可带 keyboard（按钮/键盘）；
  // typing 是「输入中」提示（msg_type=6），只尽力而为，失败不影响正文。
  const markdown = (typeof command.markdown === 'string' && command.markdown.trim() !== '') ? command.markdown : '';
  const keyboard = (command.keyboard !== null && typeof command.keyboard === 'object' && !Array.isArray(command.keyboard))
    ? command.keyboard : null;
  const typing = command.typing === true;
  return { text: texts.join(''), images, replyId, markdown, keyboard, typing };
}

function chunkText(text, limit) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < Math.floor(limit / 2)) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest !== '') chunks.push(rest);
  return chunks;
}

async function uploadImage(messageType, targetId, source) {
  const body = { file_type: 1, srv_send_msg: false };
  if (source.kind === 'url') {
    body.url = source.value;
  } else if (source.kind === 'base64') {
    if (source.value.length === 0) return { ok: false, error: '图片 base64 为空' };
    if (source.value.length * 0.75 > MAX_IMAGE_BYTES) return { ok: false, error: '图片超过 5MB，官方 /files 直传不支持' };
    body.file_data = source.value;
  } else {
    let buffer;
    try { buffer = await readFile(source.value); }
    catch (error) { return { ok: false, error: '读取本地图片失败：' + errorText(error) }; }
    if (buffer.length > MAX_IMAGE_BYTES) return { ok: false, error: '图片超过 5MB，官方 /files 直传不支持' };
    body.file_data = buffer.toString('base64');
  }
  const response = await apiRequest('POST', filePath(messageType, targetId), body);
  if (!response.ok) return { ok: false, error: '上传图片失败：' + String(response.error) };
  const fileInfo = response.data !== null && typeof response.data === 'object' ? response.data.file_info : null;
  if (typeof fileInfo !== 'string' || fileInfo === '') return { ok: false, error: '上传图片响应缺少 file_info' };
  return { ok: true, fileInfo, body };
}

async function postMessage(messageType, targetId, payload) {
  const response = await apiRequest('POST', messagePath(messageType, targetId), payload);
  if (!response.ok) return { ok: false, error: response.error, response };
  const id = response.data !== null && typeof response.data === 'object' ? response.data.id : null;
  return { ok: true, messageId: id !== null && id !== undefined ? id : null, response };
}

/** 队列的 send 回调：文本按 msg_type=0 发，图片先 /files 换 file_info 再 msg_type=7。 */
async function sendMessage(params) {
  const messageType = params.messageType === 'group' ? 'group' : 'private';
  const targetId = String(params.targetId);
  const replyId = params.replyId ?? null;
  const text = String(params.text ?? '').trim();
  const markdown = (typeof params.markdown === 'string') ? params.markdown : '';
  const keyboard = (params.keyboard !== null && typeof params.keyboard === 'object') ? params.keyboard : null;
  const images = Array.isArray(params.images) ? params.images : [];
  if (text === '' && markdown === '' && images.length === 0) return { ok: false, error: '发送内容为空' };

  let lastMessageId = null;
  // 输入中提示：官方 v2 的 msg_type=6，纯尽力而为（消息可能因频控失败，不该拦正文）。
  if (params.typing === true) {
    const notify = { msg_type: 6 };
    if (replyId !== null) { notify.msg_id = replyId; notify.msg_seq = nextMsgSeq(replyId); }
    const typed = await postMessage(messageType, targetId, notify);
    if (!typed.ok) log('输入中提示发送失败（忽略）：' + String(typed.error), 'warn');
  }
  // Markdown（msg_type=2）可带 keyboard；keyboard 单独给时把正文包成 markdown。
  if (markdown !== '' || keyboard !== null) {
    const body = markdown !== '' ? markdown : text;
    const payload = { msg_type: 2, markdown: { content: body } };
    if (keyboard !== null) payload.keyboard = keyboard;
    if (replyId !== null) { payload.msg_id = replyId; payload.msg_seq = nextMsgSeq(replyId); }
    const result = await postMessage(messageType, targetId, payload);
    if (!result.ok) return result;
    if (result.messageId !== null) lastMessageId = result.messageId;
    if (markdown !== '') return { ok: true, messageId: lastMessageId };
  }

  if (text !== '') {
    for (const chunk of chunkText(text, TEXT_CHUNK)) {
      const payload = { msg_type: 0, content: chunk };
      if (replyId !== null) {
        payload.msg_id = replyId; // 被动回复：事件 d.id，5 分钟窗口
        payload.msg_seq = nextMsgSeq(replyId);
      }
      const result = await postMessage(messageType, targetId, payload);
      if (!result.ok) return result;
      if (result.messageId !== null) lastMessageId = result.messageId;
    }
  }

  for (const source of images) {
    const upload = await uploadImage(messageType, targetId, source);
    if (!upload.ok) return { ok: false, error: upload.error };
    const payload = { msg_type: 7, media: { file_info: upload.fileInfo } };
    if (replyId !== null) {
      payload.msg_id = replyId;
      payload.msg_seq = nextMsgSeq(replyId);
    }
    const result = await postMessage(messageType, targetId, payload);
    if (!result.ok) return result;
    if (result.messageId !== null) lastMessageId = result.messageId;
  }

  return { ok: true, messageId: lastMessageId };
}

// ------------------------------------------------------------------ 流式消息
// QQ 开放平台只对 C2C（私聊）开放 stream_messages；一次流式消息由「同一条 msg_id + 同一个
// msg_seq + 递增 index」的多帧组成，每帧全量替换（input_mode=replace），最后一帧 input_state=10。
// 序号状态放在适配器进程里（同一 msg_id 的帧都打到同一个 map），插件只负责给全量文本。
const streamSessions = new Map();

function streamStateKey(messageType, targetId, msgId) {
  return String(messageType) + ':' + String(targetId) + ':' + String(msgId);
}

async function streamMessage(params) {
  const messageType = params.messageType === 'group' ? 'group' : 'private';
  if (messageType !== 'private') return { ok: false, error: '官方流式消息只支持私聊（C2C）' };
  const targetId = String(params.targetId);
  const msgId = String(params.msgId ?? '');
  if (msgId === '') return { ok: false, error: '流式消息缺少 msg_id（被动回复凭证）' };
  const text = String(params.text ?? '');
  const done = params.done === true;
  const key = streamStateKey(messageType, targetId, msgId);
  let state = streamSessions.get(key);
  if (state === undefined) {
    state = { index: 0, msgSeq: nextMsgSeq(msgId), streamId: null };
    streamSessions.set(key, state);
  }
  const body = {
    input_mode: 'replace',
    input_state: done === true ? 10 : 1,
    content_type: 'markdown',
    content_raw: text,
    event_id: msgId,
    msg_id: msgId,
    msg_seq: state.msgSeq,
    index: state.index,
  };
  state.index += 1;
  if (state.streamId !== null) body.stream_msg_id = state.streamId;
  const path = '/v2/users/' + encodeURIComponent(targetId) + '/stream_messages';
  const response = await apiRequest('POST', path, body);
  if (!response.ok) {
    if (done === true) streamSessions.delete(key);
    return { ok: false, error: response.error };
  }
  const id = (response.data !== null && typeof response.data === 'object' && response.data.id !== undefined) ? String(response.data.id) : null;
  if (id !== null && state.streamId === null) state.streamId = id;
  if (done === true) streamSessions.delete(key);
  return { ok: true, messageId: id !== null ? id : state.streamId };
}
function callSend(action, params) {
  if (action === 'send_message') return sendMessage(params);
  if (action === 'stream_message') return streamMessage(params);
  return Promise.resolve({ ok: false, error: '未知发送动作：' + String(action) });
}

const queue = createSendQueue({ gapMs: SEND_GAP_MS, send: (action, params) => callSend(action, params), emit });

// ------------------------------------------------------------------ 动作

/**
 * 官方 API 只有极少数「动作」概念；qqgroup 的大多数动作（禁言/踢人/改名片/群信息查询）
 * 官方开放平台**没有**对应接口，一律回 ok=false，绝不假装成功。
 */
const SUPPORTED_ACTIONS = new Set(['recall', 'delete_msg']);

async function runAction(action, params, echo) {
  let result;
  try {
    result = SUPPORTED_ACTIONS.has(action) ? await recallMessage(params) : { ok: false, error: 'QQ 官方 API 不支持 ' + action };
  } catch (error) {
    result = { ok: false, error: errorText(error) };
  }
  emit({
    type: 'action_result',
    action,
    echo,
    ok: result.ok === true,
    data: result.data !== undefined ? result.data : null,
    error: result.ok === true ? null : String(result.error ?? '未知错误'),
  });
}

async function recallMessage(params) {
  const messageId = params.message_id ?? params.id ?? null;
  if (messageId === null || String(messageId) === '') return { ok: false, error: 'recall 缺少 message_id' };
  const isGroup = params.message_type === 'group'
    || (params.message_type === undefined && (params.group_id !== undefined || params.group_openid !== undefined));
  const targetId = params.target_id ?? (isGroup
    ? (params.group_openid ?? params.group_id)
    : (params.user_openid ?? params.user_id));
  if (targetId === undefined || targetId === null || String(targetId) === '') {
    return { ok: false, error: 'recall 缺少 target_id（群 openid 或用户 openid）' };
  }
  const path = isGroup
    ? '/v2/groups/' + encodeURIComponent(String(targetId)) + '/messages/' + encodeURIComponent(String(messageId))
    : '/v2/users/' + encodeURIComponent(String(targetId)) + '/messages/' + encodeURIComponent(String(messageId));
  const response = await apiRequest('DELETE', path);
  if (!response.ok) return { ok: false, error: response.error };
  return { ok: true, data: { message_id: String(messageId) } };
}

// ------------------------------------------------------------------ 命令

function handleCommand(command) {
  if (command === null || typeof command !== 'object') return;
  switch (command.type) {
    case 'action': {
      const action = typeof command.action === 'string' ? command.action : '';
      if (action === '') {
        emit({ type: 'action_result', action: null, echo: command.echo ?? null, ok: false, data: null, error: '缺少 action' });
        return;
      }
      const params = command.params !== null && typeof command.params === 'object' ? command.params : {};
      void runAction(action, params, command.echo ?? null);
      return;
    }
    case 'stream': {
      const messageType = command.message_type === 'group' ? 'group' : 'private';
      const targetId = command.target_id;
      if (targetId === undefined || targetId === null || String(targetId) === '') {
        emit({ type: 'send_result', ok: false, echo: command.echo ?? null, message_id: null, error: '缺少 target_id' });
        return;
      }
      if (command.msg_id === undefined || command.msg_id === null || String(command.msg_id) === '') {
        emit({ type: 'send_result', ok: false, echo: command.echo ?? null, message_id: null, error: '流式消息缺少 msg_id' });
        return;
      }
      queue.enqueue({ action: 'stream_message', params: { messageType, targetId, msgId: String(command.msg_id), text: String(command.text ?? ''), done: command.done === true }, echo: command.echo ?? null });
      return;
    }
    case 'send': {
      const messageType = command.message_type === 'group' ? 'group' : 'private';
      const targetId = command.target_id;
      if (targetId === undefined || targetId === null || String(targetId) === '') {
        emit({ type: 'send_result', ok: false, echo: command.echo ?? null, message_id: null, error: '缺少 target_id' });
        return;
      }
      const plan = planSend(command);
      queue.enqueue({ action: 'send_message', params: { messageType, targetId, text: plan.text, images: plan.images, replyId: plan.replyId, markdown: plan.markdown, keyboard: plan.keyboard, typing: plan.typing }, echo: command.echo ?? null });
      return;
    }
    default:
      emit({ type: 'error', text: '未知命令：' + String(command.type) });
  }
}

// ------------------------------------------------------------------ Webhook 传输

function readBody(req, limitBytes = 1 << 20) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limitBytes) { settled = true; resolve(null); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    req.on('error', () => { if (!settled) { settled = true; resolve(''); } });
  });
}

function sendJson(res, status, value) {
  const text = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

async function handleWebhookRequest(req, res) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== WEBHOOK_PATH) { sendJson(res, 404, { message: 'not found' }); return; }
  if (req.method !== 'POST') { sendJson(res, 405, { message: 'method not allowed' }); return; }

  const raw = await readBody(req);
  if (raw === null) { sendJson(res, 413, { message: 'payload too large' }); return; }

  // 0) 平台回调都会带 X-Bot-Appid；配了 appid 就核对，防串号。
  const botAppId = String(req.headers['x-bot-appid'] ?? '');
  if (APP_ID !== '' && botAppId !== '' && botAppId !== APP_ID) {
    log('Webhook 的 X-Bot-Appid 与配置不符，已拒绝（403）', 'warn');
    sendJson(res, 403, { message: 'appid mismatch' });
    return;
  }

  // 1) 签名校验：Ed25519(timestamp + body)，头是 X-Signature-Ed25519 / X-Signature-Timestamp。
  if (APP_SECRET !== '' && !ALLOW_UNSIGNED) {
    const signature = String(req.headers['x-signature-ed25519'] ?? '');
    const timestamp = String(req.headers['x-signature-timestamp'] ?? '');
    if (signature === '' || timestamp === '') {
      log('Webhook 缺少签名头，已拒绝（401）', 'warn');
      sendJson(res, 401, { message: 'missing signature' });
      return;
    }
    if (!verifyEd25519(timestamp + raw, signature)) {
      log('Webhook 签名校验失败，已拒绝（401）', 'warn');
      sendJson(res, 401, { message: 'invalid signature' });
      return;
    }
    // 新鲜度：算得出时间戳就卡 ±5 分钟。抓到的旧回调不能拿来无限重放（签名本身不防重放）。
    const sentAt = Number(timestamp);
    if (Number.isFinite(sentAt) && sentAt > 0) {
      const skew = Math.abs(Math.floor(Date.now() / 1000) - sentAt);
      if (skew > WEBHOOK_SKEW_SECONDS) {
        log('Webhook 回调时间戳超出 ±' + WEBHOOK_SKEW_SECONDS + 's（偏差 ' + skew + 's），已拒绝（401）', 'warn');
        sendJson(res, 401, { message: 'stale timestamp' });
        return;
      }
    }
  }

  let payload = null;
  try { payload = JSON.parse(raw); } catch { payload = null; }
  if (payload === null || typeof payload !== 'object') { sendJson(res, 400, { message: 'invalid json' }); return; }

  // 2) 回调地址验证 op=13：回 { plain_token, signature=hex(sign(event_ts + plain_token)) }。
  if (payload.op === 13) {
    const d = payload.d !== null && typeof payload.d === 'object' ? payload.d : {};
    const plainToken = String(d.plain_token ?? '');
    const eventTs = String(d.event_ts ?? '');
    if (plainToken === '') { sendJson(res, 400, { message: 'missing plain_token' }); return; }
    let signature;
    try { signature = signEd25519(eventTs + plainToken); }
    catch (error) { log('op13 签名失败：' + errorText(error), 'warn'); sendJson(res, 500, { message: 'sign failed' }); return; }
    log('回调地址验证 op13 已应答');
    sendJson(res, 200, { plain_token: plainToken, signature });
    return;
  }

  // 3) 事件推送 op=0：先 ACK {"op":12}，再本地分发。
  if (payload.op === 0) {
    // 事件 id 去重：平台重投同一条事件（或攻击者重放）时只处理一次。
    const eventId = payload.id === undefined || payload.id === null ? '' : String(payload.id);
    if (eventId !== '' && isDuplicateEvent(eventId) === true) {
      log('Webhook 收到重复事件（id=' + eventId + '），已丢弃', 'warn');
      sendJson(res, 200, { op: 12 });
      return;
    }
    sendJson(res, 200, { op: 12 });
    dispatchEvent(payload.t, payload.d, payload.id ?? null);
    return;
  }

  sendJson(res, 200, { op: 12 });
}

function startWebhookServer() {
  // 回调不可鉴别时只绑回环（与 milky / 反向 WS 同一口径）：
  // 允许无签名回调（--allow-unsigned）时任何人都能 POST 一个 op=0 进来自称任意用户，
  // 这种配置下绑 0.0.0.0 等于把「以任意 QQ 号说话」的入口开到局域网。
  const verified = APP_SECRET !== '' && ALLOW_UNSIGNED !== true;
  const resolved = resolveListenAddress(LISTEN, verified);
  const host = resolved.host;
  const port = Number(resolved.port);
  if (!Number.isFinite(port)) { fail('--listen 端口无效：' + LISTEN); return; }
  if (resolved.forcedLoopback === true) {
    log('允许了无签名回调（--allow-unsigned）：Webhook 只监听 127.0.0.1，公网回调收不到；要对外收事件请关掉它');
  }
  const server = http.createServer((req, res) => {
    handleWebhookRequest(req, res).catch((error) => {
      log('Webhook 处理异常：' + errorText(error), 'warn');
      try { sendJson(res, 500, { message: 'internal error' }); } catch { /* 响应已结束 */ }
    });
  });
  server.on('error', (error) => {
    fail('Webhook 服务启动失败：' + errorText(error));
    webhookListening = false;
    setStatus('listen-error');
  });
  server.listen(port, host, () => {
    webhookListening = true;
    const bound = server.address();
    const actualPort = bound !== null && typeof bound === 'object' ? bound.port : port;
    log('Webhook 监听 http://' + host + ':' + String(actualPort) + WEBHOOK_PATH + '（平台上需填 HTTPS 地址）');
    emit({ type: 'listening', host, port: actualPort, path: WEBHOOK_PATH });
    setStatus('');
  });
  webhookServer = server;
}

// ------------------------------------------------------------------ WebSocket 网关

let socket = null;
let heartbeatTimer = null;
let heartbeatIntervalMs = 45000;
let authTimer = null;
let wsSeq = null;
let sessionId = null;
let retryMs = 1000;

function sendGateway(frame) {
  if (socket === null || typeof socket.send !== 'function') return false;
  // WHATWG WebSocket.OPEN === 1
  if (socket.readyState !== 1) return false;
  try { socket.send(JSON.stringify(frame)); return true; } catch { return false; }
}

function stopHeartbeat() {
  if (heartbeatTimer !== null) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (authTimer !== null) { clearTimeout(authTimer); authTimer = null; }
}

function startHeartbeat() {
  stopHeartbeat();
  const interval = heartbeatIntervalMs > 0 ? heartbeatIntervalMs : 45000;
  heartbeatTimer = setInterval(() => {
    if (!sendGateway({ op: 1, d: wsSeq })) return;
    // 两个周期内没有 op11 就认为链路已死，主动重连。
    if (authTimer !== null) clearTimeout(authTimer);
    authTimer = setTimeout(() => {
      log('心跳没有收到 op11 回执，主动重连', 'warn');
      if (socket !== null) { try { socket.close(); } catch { /* ignore */ } }
    }, Math.max(interval * 2, 5000));
    if (authTimer.unref) authTimer.unref();
  }, interval);
  if (heartbeatTimer.unref) heartbeatTimer.unref();
}

async function identifyOrResume() {
  let token;
  try { token = await getAccessToken(); }
  catch (error) {
    fail('网关登录失败（access_token）：' + errorText(error));
    setStatus('auth-failed');
    return;
  }
  const authToken = 'QQBot ' + token;
  if (sessionId !== null && wsSeq !== null) {
    sendGateway({ op: 6, d: { token: authToken, session_id: sessionId, seq: wsSeq } });
    log('已发送 op6 Resume（session=' + sessionId + ' seq=' + String(wsSeq) + '）');
    return;
  }
  sendGateway({
    op: 2,
    d: {
      token: authToken,
      intents: INTENTS,
      shard: [SHARD_INDEX, SHARD_COUNT],
      properties: { $os: process.platform, $browser: 'dsh', $device: 'dsh' },
    },
  });
  log('已发送 op2 Identify（intents=' + String(INTENTS) + ' shard=' + SHARD_INDEX + '/' + SHARD_COUNT + '）');
}

function onGatewayPayload(raw) {
  let payload = null;
  try { payload = JSON.parse(raw); } catch { return; }
  if (payload === null || typeof payload !== 'object') return;

  if (typeof payload.s === 'number') wsSeq = payload.s;

  switch (payload.op) {
    case 10: {
      heartbeatIntervalMs = Number(payload.d && payload.d.heartbeat_interval) || 45000;
      log('收到 op10 Hello（heartbeat_interval=' + String(heartbeatIntervalMs) + 'ms）');
      startHeartbeat();
      void identifyOrResume();
      return;
    }
    case 11:
      if (authTimer !== null) { clearTimeout(authTimer); authTimer = null; }
      return;
    case 1:
      sendGateway({ op: 1, d: wsSeq });
      return;
    case 0: {
      const eventName = String(payload.t ?? '');
      if (eventName === 'READY') {
        const d = payload.d !== null && typeof payload.d === 'object' ? payload.d : {};
        sessionId = d.session_id !== undefined && d.session_id !== null ? String(d.session_id) : null;
        if (d.user !== null && typeof d.user === 'object' && d.user.id !== undefined && d.user.id !== null) {
          selfId = String(d.user.id);
        }
        gatewayReady = true;
        log('网关 READY（self=' + String(selfId ?? '?') + ' session=' + String(sessionId ?? '?') + '）');
        setStatus('');
        return;
      }
      if (eventName === 'RESUMED') {
        gatewayReady = true;
        log('网关 RESUMED（补发完成）');
        setStatus('');
        return;
      }
      dispatchEvent(eventName, payload.d, payload.id ?? null);
      return;
    }
    case 7:
      log('服务端要求重连（op7），断开后走 Resume', 'warn');
      if (socket !== null) { try { socket.close(); } catch { /* ignore */ } }
      return;
    case 9:
      log('会话失效（op9），重置 session 后重新 Identify', 'warn');
      sessionId = null;
      wsSeq = null;
      if (socket !== null) { try { socket.close(); } catch { /* ignore */ } }
      return;
    default:
      log('未处理的网关 opcode：' + String(payload.op));
  }
}

function scheduleReconnect(label) {
  if (shuttingDown) return;
  const delay = retryMs;
  retryMs = Math.min(retryMs * 2, 30000);
  log('QQ 网关' + label + '，' + String(delay) + 'ms 后重连', 'warn');
  const timer = setTimeout(() => { if (timer.unref) timer.unref(); void connectGateway(); }, delay);
  if (timer.unref) timer.unref();
}

function openGatewaySocket(url) {
  let opening;
  try { opening = new WebSocket(url); }
  catch (error) { fail('QQ 网关连接失败：' + errorText(error)); scheduleReconnect('创建失败'); return; }
  socket = opening;
  opening.addEventListener('open', () => {
    retryMs = 1000;
    log('QQ 网关已连接 ' + url);
    setStatus('handshaking');
  });
  opening.addEventListener('message', (event) => {
    onGatewayPayload(typeof event.data === 'string' ? event.data : String(event.data));
  });
  opening.addEventListener('error', () => {
    if (socket === opening) log('QQ 网关连接出错', 'warn');
  });
  opening.addEventListener('close', (event) => {
    stopHeartbeat();
    if (socket === opening) socket = null;
    const wasReady = gatewayReady;
    gatewayReady = false;
    setStatus('closed(' + String(event && event.code !== undefined && event.code !== null ? event.code : '?') + ')');
    if (wasReady) log('QQ 网关断开', 'warn');
    scheduleReconnect('断开');
  });
}

async function connectGateway() {
  if (shuttingDown) return;
  let url = GATEWAY_URL_ARG;
  if (url === '') {
    const response = await apiRequest('GET', '/gateway');
    if (!response.ok) {
      fail('获取网关地址失败：' + String(response.error));
      setStatus('gateway-failed');
      scheduleReconnect('地址获取失败');
      return;
    }
    const data = response.data !== null && typeof response.data === 'object' ? response.data : {};
    url = typeof data.url === 'string' ? data.url : '';
    if (url === '') {
      fail('GET /gateway 未返回 url');
      scheduleReconnect('地址为空');
      return;
    }
  }
  openGatewaySocket(url);
}

// ------------------------------------------------------------------ 生命周期

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopHeartbeat();
  if (socket !== null) { try { socket.close(); } catch { /* ignore */ } socket = null; }
  if (webhookServer !== null) { try { webhookServer.close(); } catch { /* ignore */ } }
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
  adapter: 'qq-official',
  mode: MODE,
  apiBase: API_BASE,
  appId: APP_ID !== '' ? APP_ID : null,
  hasSecret: APP_SECRET !== '',
  intents: INTENTS,
  listen: LISTEN !== '' ? LISTEN : null,
  path: WEBHOOK_PATH,
  pid: process.pid,
});

setStatus('starting');

if (APP_ID === '' || APP_SECRET === '') {
  fail('缺少 --appid / --secret（QQ 开放平台的 AppID 与 AppSecret），无法鉴权');
} else if (MODE === 'webhook') {
  if (LISTEN === '') fail('webhook 模式必须给 --listen host:port（平台只允许 80/443/8080/8443）');
  else startWebhookServer();
} else {
  void connectGateway();
}
