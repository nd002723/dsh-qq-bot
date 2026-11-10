#!/usr/bin/env node
/**
 * Satori 协议适配器（零 npm 依赖，ESM，Node >= 22）。
 *
 * 拓扑与 OneBot 相反：SDK（Koishi / satori-protocol 实现）是**服务端**，
 * 我们是应用（客户端）：
 *   事件面：我们主动连 WS  <sdk>/v1/events，连上 10s 内发 IDENTIFY{op:3}，
 *           之后每 10s 发 PING{op:1}，SDK 回 PONG{op:2}，事件是 op:0 的 body。
 *   控制面：POST <sdk>/v1/{resource}.{method}，参数即 body，响应直接是结果 JSON。
 *   鉴权：Authorization: Bearer <token> + 业务路由头 Satori-Platform / Satori-User-ID。
 *   消息体：类 XHTML 元素字符串（"hi<at id=\"1\"/>"），不是段数组；本文件自带 parser/serializer。
 *
 * 参数：
 *   --ws <url>           事件 WS 地址（不带路径时自动补 /v1/events）
 *   --http <url>         RPC 基址（省略时由 --ws 推导）
 *   --token <token>      访问令牌（IDENTIFY.body.token 与 HTTP Bearer）
 *   --platform <name>    Satori-Platform（默认 qq）
 *   --self-id <id>       Satori-User-ID（留空则用 READY / 事件里的 login.user.id）
 *   --ping-ms <ms>       PING 间隔（默认 10000，协议规定 10s）
 *   --send-gap-ms <ms>   发送队列间隔（默认 350）
 *   --referrer-ttl-ms    被动消息 referrer 复用窗口（默认 0 = 关闭：同一 referrer 的被动消息
 *                        额度有限，复用窗口开大了会把额度提前耗尽）
 *
 * 与插件之间的 stdio 契约见 lib/transport/bridge/CONTRACT.md。
 */
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { createEmitter, createSendQueue, installStdin, installCrashHandlers, postJson } from '../bridge/stdio.mjs';
import { createLinkSet, connectForward } from '../bridge/ws.mjs';
import { segmentsToText, countImages, imageUrlsOf, imageMetaOf, atQqsOf } from '../../message/segments.mjs';

// =================================================================== 编解码
// Satori 的 content 是「类 XHTML 元素串」。下面这组函数是纯函数，测试可直接 import。

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
const TAG_NAME = /^[a-zA-Z][a-zA-Z0-9-]*/;

/** 解 XML 实体（命名实体 + &#NNN; + &#xHH;）。无法识别的保持原样。 */
export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

/** 文本节点转义：& < >（正文里不需要转义引号）。 */
export function escapeText(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 属性值转义：在文本转义基础上再转双引号与单引号。 */
export function escapeAttr(text) {
  return escapeText(text).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * 解析单个标签。返回 null 表示「不是合法标签」，调用方按普通文本处理。
 */
function parseTag(text, start) {
  let i = start + 1;
  let closing = false;
  if (text[i] === '/') { closing = true; i += 1; }
  const match = TAG_NAME.exec(text.slice(i));
  if (match === null) return null;
  const name = match[0].toLowerCase();
  i += match[0].length;
  const attrs = {};
  let selfClosing = false;
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (i >= text.length) return null;                 // 没有 '>'：按文本
    if (text[i] === '>') { i += 1; break; }
    if (text[i] === '/') {
      if (text[i + 1] === '>') { selfClosing = true; i += 2; break; }
      i += 1;
      continue;
    }
    if (closing) return null;                          // 闭合标签不该带属性
    const keyStart = i;
    while (i < text.length && !/[\s=>]/.test(text[i])) i += 1;
    const key = text.slice(keyStart, i).toLowerCase();
    if (key === '') return null;
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (i < text.length && text[i] === '=') {
      i += 1;
      while (i < text.length && /\s/.test(text[i])) i += 1;
      let value = '';
      const quote = text[i];
      if (quote === '"' || quote === "'") {
        i += 1;
        const end = text.indexOf(quote, i);
        if (end < 0) return null;
        value = text.slice(i, end);
        i = end + 1;
      } else {
        const valueStart = i;
        while (i < text.length && !/[\s>]/.test(text[i])) i += 1;
        value = text.slice(valueStart, i);
      }
      attrs[key] = decodeEntities(value);
    } else {
      attrs[key] = '';
    }
  }
  return { name, attrs, selfClosing, closing, end: i };
}

/**
 * 把 content 解析成节点树（文本节点是 {name:'#text', text}）。
 * 宽容策略：非标签的 '<' 当文本；未闭合标签解析到串尾视为闭合；多余闭合标签忽略；注释丢弃。
 */
export function parseNodes(content) {
  const root = { name: '#root', attrs: {}, children: [] };
  const stack = [root];
  const text = String(content ?? '');
  let i = 0;
  let buffer = '';
  const flush = () => {
    if (buffer === '') return;
    stack[stack.length - 1].children.push({ name: '#text', text: decodeEntities(buffer) });
    buffer = '';
  };
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) { buffer += text.slice(i); break; }
    buffer += text.slice(i, lt);
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end < 0) { i = text.length; break; }
      i = end + 3;
      continue;
    }
    const tag = parseTag(text, lt);
    if (tag === null) { buffer += '<'; i = lt + 1; continue; }
    flush();
    i = tag.end;
    if (tag.closing) {
      for (let depth = stack.length - 1; depth >= 1; depth -= 1) {
        if (stack[depth].name === tag.name) { stack.length = depth; break; }
      }
      continue;
    }
    const node = { name: tag.name, attrs: tag.attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!tag.selfClosing) stack.push(node);
  }
  flush();
  return root.children;
}

/** 节点子树的纯文本（a 的标签、button 的 text 都缺时用它兜底；sharp 用的是 '#' + name，不走这里）。 */
function plainTextOf(nodes) {
  let out = '';
  for (const node of nodes ?? []) {
    if (node.name === '#text') out += node.text;
    else if (node.name === 'br') out += '\n';
    else out += plainTextOf(node.children);
  }
  return out;
}

/** 平台内部资源（internal: / 本地路径）转成可下载的 /v1/proxy/ 地址。 */
function resolveSrc(src, proxyBase) {
  const raw = String(src ?? '');
  if (raw === '') return { url: '', file: '' };
  if (/^https?:\/\//i.test(raw) || /^data:/i.test(raw)) return { url: raw, file: raw };
  if (proxyBase === '') return { url: raw, file: raw };
  return { url: proxyBase + '/v1/proxy/' + raw.replace(/ /g, '%20'), file: raw };
}

function appendText(list, text) {
  if (text === '') return;
  const last = list[list.length - 1];
  if (last !== undefined && last.type === 'text') last.data.text += text;
  else list.push({ type: 'text', data: { text } });
}

/** 去掉首尾的换行与空文本段（协议规定首尾空白忽略）。 */
function tidySegments(segments) {
  const list = [];
  for (const segment of segments) {
    if (segment.type === 'text' && segment.data.text === '') continue;
    const last = list[list.length - 1];
    if (segment.type === 'text' && last !== undefined && last.type === 'text') { last.data.text += segment.data.text; continue; }
    list.push(segment);
  }
  const first = list[0];
  if (first !== undefined && first.type === 'text') first.data.text = first.data.text.replace(/^[\n\s]+/, '');
  const last = list[list.length - 1];
  if (last !== undefined && last.type === 'text') last.data.text = last.data.text.replace(/[\n\s]+$/, '');
  return list.filter((segment) => !(segment.type === 'text' && segment.data.text === ''));
}

/**
 * content（元素串）-> 统一消息段数组 + 文本/图片/引用摘要。
 * @param {string} content
 * @param {{proxyBase?: string}} [options]
 */
export function contentToSegments(content, options = {}) {
  const proxyBase = options.proxyBase ?? '';
  const state = { segments: [], replyTo: null };

  const walk = (nodes) => {
    for (const node of nodes ?? []) {
      switch (node.name) {
        case '#text': appendText(state.segments, node.text); break;
        case 'br': appendText(state.segments, '\n'); break;
        case 'p': {
          walk(node.children);
          appendText(state.segments, '\n');
          break;
        }
        case 'at': {
          const type = String(node.attrs.type ?? '').toLowerCase();
          const id = node.attrs.id ?? '';
          if (type === 'all') appendText(state.segments, '@全体成员 ');
          else if (type === 'here') appendText(state.segments, '@在线成员 ');
          else if (id !== '') {
            const data = { qq: String(id) };
            if (node.attrs.name !== undefined && node.attrs.name !== '') data.name = node.attrs.name;
            state.segments.push({ type: 'at', data });
          } else if (node.attrs.name !== undefined && node.attrs.name !== '') {
            appendText(state.segments, '@' + node.attrs.name + ' ');
          } else appendText(state.segments, '@');
          break;
        }
        case 'img':
        case 'audio':
        case 'video':
        case 'file': {
          const src = resolveSrc(node.attrs.src, proxyBase);
          const type = node.name === 'img' ? 'image' : node.name === 'audio' ? 'record' : node.name;
          const data = { url: src.url, file: src.file };
          if (node.name === 'file') data.name = node.attrs.title ?? '';
          state.segments.push({ type, data });
          break;
        }
        case 'quote': {
          const id = node.attrs.id ?? '';
          if (id !== '') {
            state.replyTo = /^\d+$/.test(id) ? Number(id) : id;
            state.segments.push({ type: 'reply', data: { id: state.replyTo } });
          }
          // 引用的子元素是被引用消息的正文，不并进本条正文
          break;
        }
        case 'message': {
          if (node.attrs.forward !== undefined) { appendText(state.segments, '[合并转发]'); break; }
          walk(node.children);
          appendText(state.segments, '\n');
          break;
        }
        case 'a': {
          walk(node.children);
          const href = node.attrs.href ?? '';
          const label = plainTextOf(node.children);
          if (label === '' && href !== '') appendText(state.segments, href);
          else if (href !== '') appendText(state.segments, ' (' + href + ')');
          break;
        }
        case 'sharp': {
          appendText(state.segments, '#' + String(node.attrs.name ?? node.attrs.id ?? ''));
          break;
        }
        case 'emoji': {
          const data = {};
          if (node.attrs.id !== undefined) data.id = node.attrs.id;
          if (node.attrs.name !== undefined) data.name = node.attrs.name;
          state.segments.push({ type: 'face', data });
          break;
        }
        case 'author': break;               // 元信息，不进正文
        case 'button': {
          const label = node.attrs.text ?? node.attrs.id ?? plainTextOf(node.children);
          appendText(state.segments, label === '' ? '[按钮]' : String(label));
          break;
        }
        default: walk(node.children); break; // 装饰 / 未知元素：丢标签留子元素
      }
    }
  };

  walk(parseNodes(content));
  const segments = tidySegments(state.segments);
  return {
    segments,
    text: segmentsToText(segments),
    images: countImages(segments),
    imageUrls: imageUrlsOf(segments),
    imageMeta: imageMetaOf(segments),
    mentions: atQqsOf(segments),
    replyTo: state.replyTo,
  };
}

/**
 * 统一消息段数组 -> Satori content 字符串。
 * 段数组优先；无法表达的段（合并转发 / 卡片）会退化成占位文本。
 * @param {Array} segments
 * @param {{replyTo?: number|string|null}} [options]
 */
export function segmentsToContent(segments, options = {}) {
  let out = '';
  let quoted = false;
  const replyTo = options.replyTo;
  if (replyTo !== undefined && replyTo !== null && String(replyTo) !== '') {
    out += '<quote id="' + escapeAttr(replyTo) + '"/>';
    quoted = true;
  }
  for (const raw of Array.isArray(segments) ? segments : []) {
    if (raw === null || typeof raw !== 'object') continue;
    const type = String(raw.type ?? '').toLowerCase();
    const data = raw.data ?? {};
    switch (type) {
      case 'text': out += escapeText(data.text ?? ''); break;
      case 'at': {
        const qq = String(data.qq ?? '');
        if (qq === 'all') out += '<at type="all"/>';
        else if (qq === 'here') out += '<at type="here"/>';
        else if (qq !== '') out += '<at id="' + escapeAttr(qq) + '"/>';
        break;
      }
      case 'image': {
        const src = String(data.url ?? data.file ?? '');
        if (src !== '') out += '<img src="' + escapeAttr(src) + '"/>';
        break;
      }
      case 'reply': {
        if (quoted) break;
        const id = data.id ?? '';
        if (String(id) !== '') { out += '<quote id="' + escapeAttr(id) + '"/>'; quoted = true; }
        break;
      }
      case 'face': {
        if (data.id !== undefined && String(data.id) !== '') out += '<emoji id="' + escapeAttr(data.id) + '"/>';
        else if (data.name !== undefined && String(data.name) !== '') out += '<emoji name="' + escapeAttr(data.name) + '"/>';
        break;
      }
      case 'record': {
        const src = String(data.url ?? data.file ?? '');
        if (src !== '') out += '<audio src="' + escapeAttr(src) + '"/>';
        break;
      }
      case 'video': {
        const src = String(data.url ?? data.file ?? '');
        if (src !== '') out += '<video src="' + escapeAttr(src) + '"/>';
        break;
      }
      case 'file': {
        const src = String(data.url ?? data.file ?? '');
        if (src !== '') {
          out += '<file src="' + escapeAttr(src) + '"'
            + (data.name !== undefined && String(data.name) !== '' ? ' title="' + escapeAttr(data.name) + '"' : '')
            + '/>';
        }
        break;
      }
      case 'forward': out += '[合并转发]'; break;
      case 'json':
      case 'xml': out += '[卡片消息]'; break;
      default: if (typeof data.text === 'string' && data.text !== '') out += escapeText(data.text); break;
    }
  }
  return out;
}

// ---------------------------------------------------------------- channel_id

const PRIVATE_PREFIXES = new Set(['private', 'direct', 'friend', 'user', 'c2c']);
const GROUP_PREFIXES = new Set(['group', 'guild', 'channel', 'groupchannel', 'guildchannel']);

/**
 * channel_id -> {messageType, targetId, prefix}。
 * 约定：群 group:123、私聊 private:456；无前缀时按 channel.type（DIRECT=1）判断。
 */
export function parseChannelId(channelId, channelType) {
  const raw = String(channelId ?? '');
  const index = raw.indexOf(':');
  if (index > 0) {
    const prefix = raw.slice(0, index).toLowerCase();
    const rest = raw.slice(index + 1);
    if (PRIVATE_PREFIXES.has(prefix)) return { messageType: 'private', targetId: rest, prefix };
    if (GROUP_PREFIXES.has(prefix)) return { messageType: 'group', targetId: rest, prefix };
  }
  const type = channelType === undefined || channelType === null ? null : Number(channelType);
  if (type === 1) return { messageType: 'private', targetId: raw, prefix: 'private' };
  return { messageType: 'group', targetId: raw, prefix: 'group' };
}

/** {messageType,targetId} -> 本适配器使用的 channel_id 约定。 */
export function toChannelId(messageType, targetId) {
  return (messageType === 'private' ? 'private:' : 'group:') + String(targetId);
}

// ------------------------------------------------------------ event -> frame

const ROLE_HINT = /(owner|admin)/i;

function idOf(value) {
  return value === undefined || value === null || String(value) === '' ? null : String(value);
}

/**
 * Satori 的 message-created 事件 -> CONTRACT 的 message 帧。
 * 不是消息事件时返回 null。
 * @param {Record<string, any>} event
 * @param {{selfId?: string, proxyBase?: string}} [options]
 */
export function eventToFrame(event, options = {}) {
  if (event === null || typeof event !== 'object') return null;
  const type = String(event.type ?? '');
  if (type !== 'message-created' && type !== 'message') return null;

  const message = event.message !== null && typeof event.message === 'object' ? event.message : {};
  const channel = event.channel !== null && typeof event.channel === 'object' ? event.channel : {};
  const guild = event.guild !== null && typeof event.guild === 'object' ? event.guild : null;
  const login = event.login !== null && typeof event.login === 'object' ? event.login : null;
  const member = event.member !== null && typeof event.member === 'object' ? event.member : null;
  const user = event.user !== null && typeof event.user === 'object' ? event.user : (member !== null && member.user ? member.user : {});

  const rawChannelId = idOf(channel.id);
  const guildId = guild === null ? null : idOf(guild.id);
  const userKey = idOf(user.id);
  let parsed;
  if (rawChannelId !== null) parsed = parseChannelId(rawChannelId, channel.type);
  else if (guildId !== null) parsed = { messageType: 'group', targetId: guildId, prefix: 'guild' };
  else parsed = { messageType: 'private', targetId: userKey ?? '', prefix: 'private' };

  const isGroup = parsed.messageType === 'group';
  const content = contentToSegments(message.content ?? '', { proxyBase: options.proxyBase ?? '' });
  const configuredSelf = options.selfId === undefined || options.selfId === null ? '' : String(options.selfId);
  const selfId = configuredSelf !== '' ? configuredSelf : (login !== null && login.user ? idOf(login.user.id) : null);
  const timestamp = Number(event.timestamp ?? message.created_at ?? 0);
  const roles = member !== null && Array.isArray(member.roles) ? member.roles : [];
  const roleHit = roles.find((role) => role !== null && typeof role === 'object' && ROLE_HINT.test(String(role.name ?? role.id ?? '')));
  const channelId = rawChannelId ?? toChannelId(parsed.messageType, parsed.targetId);

  return {
    type: 'message',
    message_type: parsed.messageType,
    sub_type: null,
    message_id: message.id ?? null,
    group_id: isGroup ? (parsed.targetId !== '' ? parsed.targetId : guildId) : null,
    user_id: userKey,
    self_id: selfId,
    time: timestamp > 0 ? Math.floor(timestamp / 1000) : Math.floor(Date.now() / 1000),
    text: content.text,
    images: content.images,
    image_urls: content.imageUrls,
    image_meta: content.imageMeta ?? [],
    mentions: content.mentions,
    reply_to: content.replyTo,
    raw_message: typeof message.content === 'string' ? message.content : null,
    sender: {
      user_id: userKey,
      nickname: userKey === null ? null : (idOf(user.nick) ?? idOf(user.name) ?? (member === null ? null : idOf(member.nick))),
      card: null,
      // 只在平台明确给了 owner/admin 角色时才填，避免误授权
      role: roleHit === undefined ? null : String(roleHit.name ?? roleHit.id ?? '').toLowerCase(),
    },
    message: content.segments,
    channel_id: channelId,
  };
}

// =================================================================== 主程序

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

const describeError = (error) => String(error && error.message ? error.message : error);

/** 裸地址自动补 /v1/events（Koishi 默认 5140 根路径就是事件 WS）。 */
export function normalizeWsUrl(raw) {
  const value = String(raw ?? '');
  if (value === '') return '';
  let url;
  try { url = new URL(value); } catch { return value; }
  if (url.pathname === '' || url.pathname === '/') url.pathname = '/v1/events';
  return url.toString();
}

/** 由事件 WS 地址推导 RPC 基址（去掉 /v1/events，ws->http）。 */
export function deriveHttpBase(rawWs) {
  try {
    const url = new URL(String(rawWs ?? ''));
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = url.pathname.replace(/\/v1\/events\/?$/, '');
    url.search = '';
    url.hash = '';
    return (url.origin + url.pathname).replace(/\/+$/, '');
  } catch { return ''; }
}

function main() {
  const argv = parseArgs(process.argv.slice(2));
  const wsUrl = normalizeWsUrl(argv.ws ?? process.env.SATORI_WS_URL ?? '');
  const explicitHttp = String(argv.http ?? process.env.SATORI_HTTP_URL ?? '').replace(/\/+$/, '');
  const httpBase = explicitHttp !== '' ? explicitHttp : deriveHttpBase(wsUrl);
  const token = String(argv.token ?? process.env.SATORI_TOKEN ?? '');
  const platform = String(argv.platform ?? process.env.SATORI_PLATFORM ?? 'qq');
  let selfId = String(argv['self-id'] ?? process.env.SATORI_SELF_ID ?? '');
  const PING_MS = Math.max(1000, Number(argv['ping-ms'] ?? 10000) || 10000);
  const SEND_GAP_MS = Number(argv['send-gap-ms'] ?? 350);
  const REFERRER_TTL_MS = Math.max(0, Number(argv['referrer-ttl-ms'] ?? 0) || 0);

  const { emit, log, fail } = createEmitter();
  const linkStates = new Map();       // link -> {identified, identifyTimer, pingTimer, awaiting, warned}
  const channelByTarget = new Map();  // "group:123" -> channel_id（回发用）
  const targetByChannel = new Map();  // channel_id -> {messageType, targetId}
  const channelByMessage = new Map(); // message_id -> {channelId, messageType, targetId, userId, at}
  const referrerByChannel = new Map();// channel_id -> {referrer, at}
  let lastSn = 0;
  let shuttingDown = false;
  let lastReason = '';

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
    emit({
      type: 'status',
      connected,
      reason: lastReason || null,
      links: links.size(),
      mode: 'forward',
      platform,
      selfId: selfId === '' ? null : selfId,
    });
  }

  // ------------------------------------------------------------- 有界缓存
  function boundedSet(map, key, value, limit = 800) {
    map.set(key, value);
    while (map.size > limit) {
      const oldest = map.keys().next();
      if (oldest.done === true) break;
      map.delete(oldest.value);
    }
  }

  function rememberChannel(messageType, targetId, channelId) {
    if (channelId === '' || channelId === null || channelId === undefined) return;
    boundedSet(channelByTarget, messageType + ':' + String(targetId), String(channelId));
    boundedSet(targetByChannel, String(channelId), { messageType, targetId: String(targetId) });
  }

  function resolveChannelId(messageType, targetId) {
    const observed = channelByTarget.get(messageType + ':' + String(targetId));
    return observed !== undefined ? observed : toChannelId(messageType, targetId);
  }

  function rememberReferrer(channelId, referrer) {
    if (REFERRER_TTL_MS <= 0 || referrer === undefined || referrer === null) return;
    boundedSet(referrerByChannel, String(channelId), { referrer, at: Date.now() });
  }

  function referrerFor(channelId) {
    if (REFERRER_TTL_MS <= 0) return null;
    const hit = referrerByChannel.get(String(channelId));
    if (hit === undefined) return null;
    if (Date.now() - hit.at > REFERRER_TTL_MS) {
      referrerByChannel.delete(String(channelId));
      return null;
    }
    return hit.referrer;
  }

  // ------------------------------------------------------------- HTTP RPC
  function rpcHeaders() {
    const headers = {
      'satori-platform': platform,
      // 协议要求每个业务请求都带这两个头；self id 还没学到时占位 '0'（多账号必须显式配 --self-id）
      'satori-user-id': selfId === '' ? '0' : selfId,
    };
    if (token !== '') headers.authorization = 'Bearer ' + token;
    return headers;
  }

  async function rpc(method, params) {
    if (httpBase === '') return { ok: false, error: '没有 --http，且无法从 --ws 推导 RPC 基址' };
    let response;
    try {
      response = await postJson(httpBase + '/v1/' + method, rpcHeaders(), params ?? {});
    } catch (error) {
      return { ok: false, error: 'Satori RPC 请求失败（' + method + '）：' + describeError(error) };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, status: response.status, error: 'Satori 鉴权失败（HTTP ' + response.status + '，请检查 --token）' };
    }
    if (response.status === 404) {
      return { ok: false, status: 404, error: 'Satori/该平台不支持 ' + method + '（HTTP 404）' };
    }
    if (!response.ok) {
      const detail = response.data !== null && typeof response.data === 'object'
        ? String(response.data.message ?? response.data.error ?? '') : '';
      return {
        ok: false,
        status: response.status,
        error: 'Satori ' + method + ' 失败：HTTP ' + response.status + (detail === '' ? '' : ' ' + detail),
      };
    }
    return { ok: true, status: response.status, data: response.data };
  }

  /** message.create 统一出口：返回 {ok, messageId, data}。 */
  async function createMessage(channelId, content) {
    const body = { channel_id: channelId, content };
    const referrer = referrerFor(channelId);
    if (referrer !== null) body.referrer = referrer;
    const result = await rpc('message.create', body);
    if (!result.ok) return result;
    const list = Array.isArray(result.data) ? result.data : (result.data === null || result.data === undefined ? [] : [result.data]);
    const first = list.find((item) => item !== null && typeof item === 'object' && item.id !== undefined) ?? null;
    return { ok: true, data: result.data, messageId: first === null ? null : first.id };
  }

  const queue = createSendQueue({
    gapMs: SEND_GAP_MS,
    send: (action, params) => (action === 'message.create'
      ? createMessage(params.channel_id, params.content)
      : rpc(action, params)),
    emit,
  });

  // ------------------------------------------------------------- WS 信号
  function sendSignal(link, op, body) {
    return link.send(JSON.stringify({ op, body: body ?? {} }));
  }

  function stopLinkTimers(state) {
    if (state.identifyTimer !== null) { clearTimeout(state.identifyTimer); state.identifyTimer = null; }
    if (state.pingTimer !== null) { clearInterval(state.pingTimer); state.pingTimer = null; }
  }

  function onOpen(info) {
    const link = info.link;
    const state = { identified: false, identifyTimer: null, pingTimer: null, awaiting: 0, warned: false };
    linkStates.set(link, state);
    log('Satori 事件 WS 已连接 ' + wsUrl + (httpBase === '' ? '（未配置 RPC 基址，无法发送）' : '，RPC ' + httpBase));
    const body = {};
    if (token !== '') body.token = token;
    if (lastSn > 0) body.sn = lastSn;      // 会话恢复：补推断线期间的事件
    sendSignal(link, 3, body);
    state.identifyTimer = setTimeout(() => {
      if (state.identified) return;
      fail('Satori IDENTIFY 超时：10 秒内没有收到 READY（请检查 --token / --platform）');
      setStatus('identify-timeout');
    }, 10000);
    if (state.identifyTimer.unref) state.identifyTimer.unref();
    state.pingTimer = setInterval(() => {
      if (!link.ready) return;
      sendSignal(link, 1, {});
      state.awaiting += 1;
      if (state.awaiting >= 3 && !state.warned) {
        state.warned = true;
        // 只告警不处理等于「静默失联」：这条链路既不会自己好，也不会被换掉。
        // 主动断开，让 connectForward 的退避重连去建一条新的。
        log('连续 ' + state.awaiting + ' 次 PING 没有 PONG，SDK 可能失联，主动断开重连', 'warn');
        try { link.close(); } catch { /* 已经关了 */ }
      }
    }, PING_MS);
    if (state.pingTimer.unref) state.pingTimer.unref();
    setStatus('');
  }

  function onClose(info) {
    const state = linkStates.get(info.link);
    if (state !== undefined) { stopLinkTimers(state); linkStates.delete(info.link); }
    const code = info.code === null || info.code === undefined ? null : Number(info.code);
    if (code === 4001 || code === 4003 || code === 1008) {
      fail('Satori 鉴权失败：SDK 关闭了 WS（close code ' + String(code) + '），请检查 --token');
      setStatus('unauthorized(' + String(code) + ')');
      return;
    }
    setStatus('closed(' + String(code === null ? '?' : code) + ')');
  }

  function onReady(link, body) {
    const state = linkStates.get(link);
    if (state !== undefined) {
      state.identified = true;
      if (state.identifyTimer !== null) { clearTimeout(state.identifyTimer); state.identifyTimer = null; }
    }
    const logins = Array.isArray(body.logins) ? body.logins : [];
    const first = logins.find((entry) => entry !== null && typeof entry === 'object'
      && entry.user !== undefined && entry.user !== null) ?? null;
    if (first !== null && selfId === '') {
      const id = idOf(first.user.id);
      if (id !== null) {
        selfId = id;
        log('从 READY 学到 self_id=' + selfId + '（platform=' + String(first.platform ?? platform) + '）');
      }
    }
    const features = first !== null && Array.isArray(first.features) ? first.features.join(',') : '';
    log('Satori READY：login ' + String(logins.length) + ' 个，self_id='
      + (selfId === '' ? '(未知)' : selfId) + '，features=' + (features === '' ? '(无)' : features));
    setStatus('');
  }

  // ------------------------------------------------------------- 事件
  function handleEvent(body) {
    if (body === null || typeof body !== 'object') return;
    const type = String(body.type ?? '');
    if (type === 'message-created' || type === 'message') { onMessageEvent(body); return; }
    if (type === 'message-deleted') { onMessageDeleted(body); return; }
    if (type === 'guild-member-added' || type === 'guild-member-removed' || type === 'guild-member-deleted') {
      const added = type === 'guild-member-added';
      const member = body.member !== null && typeof body.member === 'object' ? body.member : {};
      const user = body.user !== null && typeof body.user === 'object' ? body.user
        : (member.user !== null && typeof member.user === 'object' ? member.user : {});
      const guild = body.guild !== null && typeof body.guild === 'object' ? body.guild : {};
      const operator = body.operator !== null && typeof body.operator === 'object' ? body.operator : {};
      emit({
        type: 'notice',
        notice_type: added ? 'group_increase' : 'group_decrease',
        sub_type: added ? 'approve' : 'leave',
        user_id: idOf(user.id),
        group_id: idOf(guild.id),
        operator_id: idOf(operator.id),
        raw: body,
      });
      return;
    }
    if (type === 'friend-request' || type === 'guild-request' || type === 'guild-member-request') {
      const message = body.message !== null && typeof body.message === 'object' ? body.message : {};
      const guild = body.guild !== null && typeof body.guild === 'object' ? body.guild : {};
      const user = body.user !== null && typeof body.user === 'object' ? body.user : {};
      emit({
        type: 'request',
        request_type: type === 'friend-request' ? 'friend' : 'group',
        sub_type: type,
        flag: message.id ?? null,
        user_id: idOf(user.id),
        group_id: idOf(guild.id),
        comment: typeof message.content === 'string' ? message.content : null,
        raw: body,
      });
      return;
    }
    if (type === 'login-added' || type === 'login-updated') {
      const login = body.login !== null && typeof body.login === 'object' ? body.login : {};
      const id = login.user !== null && typeof login.user === 'object' ? idOf(login.user.id) : null;
      if (id !== null && selfId === '') selfId = id;
      log(type + '：self_id=' + String(id ?? '(未知)'));
      setStatus('');
      return;
    }
    if (type === 'login-removed') { log('login-removed：SDK 侧登录被移除', 'warn'); return; }
    // 未定义 / 未知事件：忽略（不生成 message / notice / request 帧）
  }

  function onMessageEvent(body) {
    const frame = eventToFrame(body, { selfId, proxyBase: httpBase });
    if (frame === null) return;
    const targetId = frame.message_type === 'group' ? frame.group_id : frame.user_id;
    const channelId = frame.channel_id ?? toChannelId(frame.message_type, targetId);
    rememberChannel(frame.message_type, targetId, channelId);
    if (frame.message_id !== null && frame.message_id !== undefined) {
      boundedSet(channelByMessage, String(frame.message_id), {
        channelId,
        messageType: frame.message_type,
        targetId,
        userId: frame.user_id,
        at: Date.now(),
      });
    }
    rememberReferrer(channelId, body.referrer);
    if (selfId === '' && body.login !== null && typeof body.login === 'object'
      && body.login.user !== null && body.login.user !== undefined) {
      const id = idOf(body.login.user.id);
      if (id !== null) selfId = id;
    }
    emit(frame);
  }

  function onMessageDeleted(body) {
    const message = body.message !== null && typeof body.message === 'object' ? body.message : {};
    const channel = body.channel !== null && typeof body.channel === 'object' ? body.channel : {};
    const channelId = idOf(channel.id);
    const known = channelId === null ? undefined : targetByChannel.get(channelId);
    const user = body.user !== null && typeof body.user === 'object' ? body.user : {};
    const operator = body.operator !== null && typeof body.operator === 'object' ? body.operator : {};
    emit({
      type: 'notice',
      notice_type: 'message_deleted',
      sub_type: null,
      message_id: message.id ?? null,
      group_id: known !== undefined && known.messageType === 'group' ? known.targetId : null,
      user_id: idOf(user.id),
      operator_id: idOf(operator.id),
      channel_id: channelId,
      raw: body,
    });
  }

  function onText(link, raw) {
    let payload;
    try { payload = JSON.parse(raw); } catch { return; }
    if (payload === null || typeof payload !== 'object') return;
    const state = linkStates.get(link)
      ?? { identified: false, identifyTimer: null, pingTimer: null, awaiting: 0, warned: true };
    const body = payload.body !== null && typeof payload.body === 'object' ? payload.body : {};
    const op = Number(payload.op);
    if (op === 0) {
      state.awaiting = 0;
      if (typeof body.sn === 'number' && Number.isFinite(body.sn)) lastSn = body.sn;
      handleEvent(body);
      return;
    }
    if (op === 2) { state.awaiting = 0; state.identified = true; return; }
    if (op === 4) { onReady(link, body); return; }
    if (op === 1) { sendSignal(link, 2, {}); return; }   // 容错：SDK 反向 PING
    if (op === 5) { log('META：proxy_urls=' + JSON.stringify(body.proxy_urls ?? [])); return; }
    log('未知 opcode ' + String(payload.op) + '，已忽略', 'warn');
  }

  // ------------------------------------------------------------- 动作
  const numeric = (value) => {
    const text = String(value ?? '');
    if (text === '') return null;
    return /^-?\d+$/.test(text) ? Number(text) : text;
  };

  function oneBotMessage(message) {
    const content = contentToSegments(message.content ?? '', { proxyBase: httpBase });
    const member = message.member !== null && typeof message.member === 'object' ? message.member : {};
    const user = message.user !== null && typeof message.user === 'object' ? message.user
      : (member.user !== null && typeof member.user === 'object' ? member.user : {});
    const createdAt = Number(message.created_at ?? 0);
    return {
      message_id: message.id ?? null,
      time: createdAt > 0 ? Math.floor(createdAt / 1000) : Math.floor(Date.now() / 1000),
      user_id: idOf(user.id),
      sender: {
        user_id: idOf(user.id),
        nickname: idOf(user.nick) ?? idOf(user.name) ?? null,
        card: null,
        role: null,
      },
      message: content.segments,
      text: content.text,
      raw_message: String(message.content ?? ''),
    };
  }

  const listOf = (data) => {
    if (Array.isArray(data)) return data;
    if (data !== null && typeof data === 'object' && Array.isArray(data.data)) return data.data;
    return [];
  };

  function memberRole(member) {
    const roles = member !== null && typeof member === 'object' && Array.isArray(member.roles) ? member.roles : [];
    const hit = roles.find((role) => role !== null && typeof role === 'object'
      && ROLE_HINT.test(String(role.name ?? role.id ?? '')));
    // 只上报平台明确声明的 owner/admin，其余留 null（避免误授权）
    return hit === undefined ? null : String(hit.name ?? hit.id ?? '').toLowerCase();
  }

  const UNSUPPORTED = {
    set_group_card: 'Satori/该平台不支持「设置群名片」（Satori 标准 API 无对应）',
    set_group_admin: 'Satori/该平台不支持「设置群管理员」（Satori 标准 API 无对应）',
    set_group_leave: 'Satori/该平台不支持「退群」（Satori 标准 API 无对应）',
    send_group_poke: 'Satori/该平台不支持「戳一戳」（Satori 标准 API 无对应）',
    set_group_add_request: 'Satori/该平台不支持「处理加群请求」（Satori 标准 API 无对应）',
    set_friend_add_request: 'Satori/该平台不支持「处理加好友请求」（Satori 标准 API 无对应）',
  };

  async function dispatchAction(name, params) {
    // 原生 Satori API 直通：resource.method
    if (/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(name)) return await rpc(name, params);

    if (name === 'send_group_msg' || name === 'send_private_msg' || name === 'send_msg') {
      const messageType = name === 'send_private_msg' ? 'private'
        : name === 'send_group_msg' ? 'group'
        : (params.group_id !== undefined && params.group_id !== null ? 'group' : 'private');
      const targetId = messageType === 'group' ? params.group_id : params.user_id;
      if (targetId === undefined || targetId === null || String(targetId) === '') {
        return { ok: false, error: '缺少 ' + (messageType === 'group' ? 'group_id' : 'user_id') };
      }
      const content = Array.isArray(params.message) && params.message.length > 0
        ? segmentsToContent(params.message, { replyTo: params.reply_to ?? null })
        : segmentsToContent([{ type: 'text', data: { text: String(params.text ?? '') } }], { replyTo: params.reply_to ?? null });
      if (content === '') return { ok: false, error: '没有可发送的内容' };
      const result = await createMessage(resolveChannelId(messageType, targetId), content);
      if (!result.ok) return result;
      return { ok: true, data: { message_id: result.messageId } };
    }

    if (Object.prototype.hasOwnProperty.call(UNSUPPORTED, name)) return { ok: false, error: UNSUPPORTED[name] };

    switch (name) {
      case 'get_status':
      case 'get_login_info': {
        const result = await rpc('login.get', {});
        if (!result.ok) return result;
        const login = result.data !== null && typeof result.data === 'object' ? result.data : {};
        const user = login.user !== null && typeof login.user === 'object' ? login.user : {};
        return {
          ok: true,
          data: {
            online: true,
            good: true,
            app_name: 'satori',
            user_id: numeric(user.id),
            nickname: user.nick ?? user.name ?? null,
            platform: login.platform ?? platform,
          },
        };
      }
      case 'set_group_kick': {
        const body = { guild_id: numeric(params.group_id), user_id: numeric(params.user_id) };
        if (params.reject_add_request === true) body.permanent = true;
        const result = await rpc('guild.member.kick', body);
        return result.ok ? { ok: true, data: {} } : result;
      }
      case 'set_group_ban': {
        const seconds = Number(params.duration ?? 0);
        const result = await rpc('guild.member.mute', {
          guild_id: numeric(params.group_id),
          user_id: numeric(params.user_id),
          duration: Math.max(0, Number.isFinite(seconds) ? seconds : 0) * 1000, // OneBot 秒 -> Satori 毫秒
        });
        return result.ok ? { ok: true, data: {} } : result;
      }
      case 'set_group_whole_ban': {
        const guildId = params.group_id;
        const result = await rpc('channel.mute', {
          guild_id: numeric(guildId),
          channel_id: resolveChannelId('group', guildId),
          enable: params.enable === true,
        });
        return result.ok ? { ok: true, data: {} } : result;
      }
      case 'set_group_name': {
        const result = await rpc('guild.update', {
          guild_id: numeric(params.group_id),
          data: { name: String(params.group_name ?? '') },
        });
        return result.ok ? { ok: true, data: {} } : result;
      }
      case 'delete_msg': {
        const messageId = params.message_id;
        if (messageId === undefined || messageId === null) return { ok: false, error: '缺少 message_id' };
        const known = channelByMessage.get(String(messageId));
        const channelId = params.channel_id ?? (known === undefined ? null : known.channelId);
        if (channelId === null || channelId === undefined) {
          return {
            ok: false,
            error: '无法撤回：Satori 的 message.delete 需要 channel_id，而这条消息不在本进程缓存里'
              + '（可用 params.channel_id 显式传入）',
          };
        }
        const result = await rpc('message.delete', { channel_id: channelId, message_id: messageId });
        return result.ok ? { ok: true, data: {} } : result;
      }
      case 'get_group_info': {
        const result = await rpc('guild.get', { guild_id: numeric(params.group_id) });
        if (!result.ok) return result;
        const guild = result.data !== null && typeof result.data === 'object' ? result.data : {};
        return {
          ok: true,
          data: {
            group_id: numeric(guild.id ?? params.group_id),
            group_name: guild.name ?? null,
            member_count: guild.member_count ?? null,
            max_member_count: guild.max_member_count ?? null,
          },
        };
      }
      case 'get_group_list': {
        const result = await rpc('guild.list', {});
        if (!result.ok) return result;
        return {
          ok: true,
          data: listOf(result.data).map((guild) => ({ group_id: numeric(guild.id), group_name: guild.name ?? null })),
        };
      }
      case 'get_group_member_info': {
        const result = await rpc('guild.member.get', {
          guild_id: numeric(params.group_id),
          user_id: numeric(params.user_id),
        });
        if (!result.ok) return result;
        const member = result.data !== null && typeof result.data === 'object' ? result.data : {};
        const user = member.user !== null && typeof member.user === 'object' ? member.user : {};
        return {
          ok: true,
          data: {
            user_id: numeric(user.id ?? params.user_id),
            group_id: numeric(params.group_id),
            nickname: user.nick ?? user.name ?? member.nick ?? null,
            card: member.nick ?? null,
            role: memberRole(member),
          },
        };
      }
      case 'get_group_member_list': {
        const result = await rpc('guild.member.list', { guild_id: numeric(params.group_id) });
        if (!result.ok) return result;
        return {
          ok: true,
          data: listOf(result.data).map((member) => {
            const user = member.user !== null && typeof member.user === 'object' ? member.user : {};
            return {
              user_id: numeric(user.id),
              group_id: numeric(params.group_id),
              nickname: user.nick ?? user.name ?? member.nick ?? null,
              card: member.nick ?? null,
              role: memberRole(member),
            };
          }),
        };
      }
      case 'get_msg': {
        const messageId = params.message_id;
        if (messageId === undefined || messageId === null) return { ok: false, error: '缺少 message_id' };
        const known = channelByMessage.get(String(messageId));
        const channelId = params.channel_id ?? (known === undefined ? null : known.channelId);
        if (channelId === null || channelId === undefined) {
          return { ok: false, error: '无法查询：消息不在本进程缓存里（可用 params.channel_id 显式传入）' };
        }
        const result = await rpc('message.get', { channel_id: channelId, message_id: messageId });
        if (!result.ok) return result;
        return { ok: true, data: oneBotMessage(result.data !== null && typeof result.data === 'object' ? result.data : {}) };
      }
      case 'get_group_msg_history':
      case 'get_friend_msg_history': {
        const messageType = name === 'get_group_msg_history' ? 'group' : 'private';
        const targetId = messageType === 'group' ? params.group_id : params.user_id;
        if (targetId === undefined || targetId === null) {
          return { ok: false, error: '缺少 ' + (messageType === 'group' ? 'group_id' : 'user_id') };
        }
        const body = {
          channel_id: params.channel_id ?? resolveChannelId(messageType, targetId),
          limit: Math.max(1, Number(params.count ?? 20) || 20),
        };
        if (params.message_seq !== undefined && params.message_seq !== null) body.next = String(params.message_seq);
        const result = await rpc('message.list', body);
        if (!result.ok) return result;
        return { ok: true, data: { messages: listOf(result.data).map(oneBotMessage) } };
      }
      default:
        return { ok: false, error: 'Satori 适配器不认识该动作：' + name + '（Satori/该平台不支持）' };
    }
  }

  async function runAction(action, params, echo) {
    const name = String(action ?? '').trim();
    if (name === '') {
      emit({ type: 'action_result', action: null, echo, ok: false, data: null, error: '缺少 action' });
      return;
    }
    let result;
    try { result = await dispatchAction(name, params ?? {}); }
    catch (error) { result = { ok: false, error: describeError(error) }; }
    emit({
      type: 'action_result',
      action: name,
      echo,
      ok: result.ok === true,
      data: result.data === undefined ? null : result.data,
      error: result.ok === true ? null : (result.error === undefined ? '未知错误' : result.error),
    });
  }

  // ------------------------------------------------------------- 命令
  function handleCommand(command) {
    if (command === null || typeof command !== 'object') return;
    switch (command.type) {
      case 'action':
        void runAction(
          command.action,
          command.params !== null && typeof command.params === 'object' ? command.params : {},
          command.echo ?? null,
        );
        break;
      case 'send': {
        const messageType = command.message_type === 'group' ? 'group' : 'private';
        const targetId = command.target_id;
        if (targetId === undefined || targetId === null || String(targetId) === '') {
          emit({ type: 'send_result', ok: false, echo: command.echo ?? null, error: '缺少 target_id', message_id: null });
          return;
        }
        const content = Array.isArray(command.message) && command.message.length > 0
          ? segmentsToContent(command.message, { replyTo: command.reply_to ?? null })
          : segmentsToContent([{ type: 'text', data: { text: String(command.text ?? '') } }], { replyTo: command.reply_to ?? null });
        if (content === '') {
          emit({
            type: 'send_result',
            ok: false,
            echo: command.echo ?? null,
            error: '空消息：没有可发送的 text 或 message 段',
            message_id: null,
          });
          return;
        }
        // channel_id 可由插件显式透传（SDK 的 channel 形态不可由 group/private 重建时用），否则按会话缓存/约定构造
        const channelId = command.channel_id === undefined || command.channel_id === null || String(command.channel_id) === ''
          ? resolveChannelId(messageType, targetId)
          : String(command.channel_id);
        queue.enqueue({
          action: 'message.create',
          params: { channel_id: channelId, content },
          echo: command.echo ?? null,
        });
        break;
      }
      default: emit({ type: 'error', text: '未知命令：' + String(command.type) }); break;
    }
  }

  // ------------------------------------------------------------- 生命周期
  function shutdown(code) {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const state of linkStates.values()) stopLinkTimers(state);
    linkStates.clear();
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
    adapter: 'satori',
    mode: 'forward',
    wsUrl,
    httpUrl: httpBase,
    platform,
    selfId: selfId === '' ? null : selfId,
    hasToken: token !== '',
    pid: process.pid,
  });

  if (wsUrl === '') { fail('没有 --ws，无法接收 Satori 事件'); setStatus('no-ws'); return; }
  if (httpBase === '') fail('没有 --http 且无法从 --ws 推导 RPC 基址，只能收消息不能发消息');

  connectForward({
    url: wsUrl,
    token: '',                     // Satori 的 token 在 IDENTIFY 里，不走 OneBot 的 ?access_token=
    linkSet: links,
    onText: (link, text) => onText(link, text),
    onOpen: (info) => onOpen(info),
    onClose: (info) => onClose(info),
    onError: (info) => {
      if (info.phase === 'retry') log('Satori WS ' + String(info.delayMs) + 'ms 后重连', 'warn');
      else if (info.phase === 'create') fail('Satori WS 建立失败：' + describeError(info.error));
    },
  });

  setStatus('starting');
}

const isMain = (() => {
  if (process.argv[1] === undefined) return false;
  try { return pathToFileURL(process.argv[1]).href === import.meta.url; } catch { return false; }
})();

if (isMain) main();
