#!/usr/bin/env node
/**
 * A tiny, dependency-free OneBot 11 simulator.
 *
 * It implements just enough of the OneBot 11 surface that the DSH QQ Bot bridge
 * needs, so the whole integration can be exercised end-to-end on localhost with
 * no QQ account, no NapCat, and no Docker:
 *
 *   - HTTP API: POST /send_group_msg, /send_private_msg, /send_msg, /get_status
 *               -> records every outbound message.
 *   - Forward WebSocket: pushes OneBot `message` events.
 *   - Control API: POST /__inject  -> pretend a QQ user sent a message
 *                  GET  /__sent    -> list every message the bot sent
 *                  GET  /__health  -> readiness probe
 *                  POST /__reset   -> forget recorded messages
 *
 * The WebSocket server is hand-rolled on node:http + node:crypto (SHA-1
 * handshake + RFC 6455 frame codec) so this file has zero npm dependencies.
 *
 * Standalone:
 *   node mock-onebot.mjs [--http-port 3000] [--ws-port 3001]
 *
 * As a module:
 *   import { startMockOneBot } from './mock-onebot.mjs'
 */

import http from 'node:http';
import { createHash } from 'node:crypto';
import process from 'node:process';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ------------------------------------------------------------ WS frame codec

function acceptKey(key) {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}

/** Encode one unmasked server text frame. */
function encodeTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x81, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * Decode as many complete client frames as `buffer` holds.
 * @returns complete messages plus the unconsumed remainder.
 */
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
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break;
      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }

    let maskKey = null;
    if (masked) {
      if (buffer.length - cursor < 4) break;
      maskKey = buffer.subarray(cursor, cursor + 4);
      cursor += 4;
    }
    if (buffer.length - cursor < length) break;

    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (maskKey !== null) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
    }
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
    if (fin) {
      messages.push({ type: opcode === 0x1 ? 'text' : 'binary', payload });
    } else {
      fragments = [payload];
      fragmentOpcode = opcode;
    }
  }

  return { messages, rest: buffer.subarray(offset) };
}

// ------------------------------------------------------------------ server

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

/**
 * Start the simulator.
 * @param {{ httpPort?: number, wsPort?: number, host?: string, quiet?: boolean, token?: string }} options
 */
export async function startMockOneBot(options = {}) {
  const host = options.host ?? '127.0.0.1';
  const quiet = options.quiet === true;
  const requiredToken = options.token ?? '';
  const sent = [];
  // 群管理相关动作的记录（测试断言用）与成员角色（授权校验用）
  const actions = [];
  const memberRoles = new Map([['10000', 'owner'], ['22222', 'member']]);
  const sockets = new Set();
  let messageSeq = 100000;
  const selfId = 10000;

  const say = (...args) => { if (!quiet) console.log('[mock-onebot]', ...args); };

  const checkToken = (req, url, body) => {
    if (requiredToken === '') return true;
    if (String(req.headers.authorization ?? '') === 'Bearer ' + requiredToken) return true;
    if (url.searchParams.get('access_token') === requiredToken) return true;
    if (body !== null && typeof body === 'object' && body.access_token === requiredToken) return true;
    return false;
  };

  const broadcast = (payload) => {
    const frame = encodeTextFrame(JSON.stringify(payload));
    for (const socket of sockets) {
      try { socket.write(frame); } catch { /* client vanished */ }
    }
    return sockets.size;
  };

  /** Pretend a QQ user sent a message, exactly as OneBot 11 would report it. */
  const injectMessage = (input) => {
    messageSeq += 1;
    const messageType = input.message_type === 'private' ? 'private' : 'group';
    const event = Object.assign({
      post_type: 'message',
      message_type: messageType,
      sub_type: input.sub_type ?? (messageType === 'group' ? 'normal' : 'friend'),
      message_id: input.message_id ?? messageSeq,
      self_id: selfId,
      time: Math.floor(Date.now() / 1000),
      user_id: Number(input.user_id ?? 22222),
      message: input.message ?? [{ type: 'text', data: { text: String(input.text ?? '') } }],
      raw_message: typeof input.text === 'string' ? input.text : '',
      font: 0,
      sender: {
        user_id: Number(input.user_id ?? 22222),
        nickname: input.nickname ?? '测试用户',
        card: input.card ?? '',
        role: input.role ?? 'member',
      },
    }, messageType === 'group' ? { group_id: Number(input.group_id ?? 33333), anonymous: null } : {});
    const delivered = broadcast(event);
    say('injected ' + messageType + ' message from ' + event.user_id + ' -> ' + delivered + ' client(s)');
    return { event, delivered };
  };

  // ---- 群管理动作（HTTP 与 WS 共用同一套实现）-------------------------------
  const recordAction = (action, params, via) => { actions.push({ action, params, via, at: Date.now() }); };

  const roleOf = (qq) => memberRoles.get(String(qq)) ?? 'member';

  const groupActions = {
    get_group_member_info(params) {
      const qq = String(params.user_id);
      return { user_id: Number(qq), group_id: Number(params.group_id), nickname: '成员' + qq, card: '', role: roleOf(qq), join_time: 0, last_sent_time: 0, level: '1', sex: 'unknown', age: 0, area: '', title: '' };
    },
    get_group_member_list(params) {
      const rows = [];
      for (const [qq, role] of memberRoles) rows.push({ user_id: Number(qq), group_id: Number(params.group_id), nickname: '成员' + qq, card: '', role, join_time: 0, last_sent_time: 0, level: '1' });
      return rows;
    },
    get_group_list() { return [{ group_id: 33333, group_name: '测试群', member_count: memberRoles.size, max_member_count: 200 }]; },
    get_group_info(params) { return { group_id: Number(params.group_id), group_name: '测试群', member_count: memberRoles.size, max_member_count: 200 }; },
    set_group_ban() { return {}; },
    set_group_kick() { return {}; },
    set_group_whole_ban() { return {}; },
    set_group_card() { return {}; },
    set_group_admin() { return {}; },
    set_group_name() { return {}; },
    set_group_leave() { return {}; },
    delete_msg() { return {}; },
    send_group_poke() { return {}; },
    set_group_add_request() { return {}; },
  };

  // ---- HTTP API -----------------------------------------------------------
  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://' + host);
    const path = url.pathname;
    const raw = req.method === 'POST' ? await readBody(req) : '';
    let body = null;
    if (raw.length > 0) {
      try { body = JSON.parse(raw); } catch { body = null; }
    }

    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };

    if (path === '/__health') { json(200, { ok: true, clients: sockets.size, sent: sent.length }); return; }
    if (path === '/__sent') { json(200, { ok: true, messages: sent }); return; }
    if (path === '/__inject') {
      if (body === null) { json(400, { ok: false, error: 'expected a JSON body' }); return; }
      const result = injectMessage(body);
      json(200, { ok: true, delivered: result.delivered, message_id: result.event.message_id });
      return;
    }
    if (path === '/__reset' && req.method === 'POST') { sent.length = 0; json(200, { ok: true }); return; }

    if (!checkToken(req, url, body)) {
      json(403, { status: 'failed', retcode: 1403, message: 'access token mismatch', wording: 'access token mismatch' });
      return;
    }

    const record = (action, kind) => {
      const target = kind === 'group'
        ? { group_id: body && body.group_id !== undefined ? body.group_id : null }
        : { user_id: body && body.user_id !== undefined ? body.user_id : null };
      const entry = Object.assign({
        action,
        at: Date.now(),
      }, target, {
        message: body ? body.message : null,
      });
      if (body && body.message_type !== undefined) entry.message_type = body.message_type;
      sent.push(entry);
      say('sent ' + action + ' ' + JSON.stringify(target) + ' ' + JSON.stringify(entry.message));
      return { status: 'ok', retcode: 0, data: { message_id: messageSeq + sent.length }, wording: '' };
    };

    const actionName = path.startsWith('/') ? path.slice(1) : '';
    if (Object.prototype.hasOwnProperty.call(groupActions, actionName)) {
      const params = body === null ? {} : body;
      recordAction(actionName, params, 'http');
      json(200, { status: 'ok', retcode: 0, data: groupActions[actionName](params), wording: '' });
      return;
    }

    if (path === '/send_group_msg') { json(200, record('send_group_msg', 'group')); return; }
    if (path === '/send_private_msg') { json(200, record('send_private_msg', 'private')); return; }
    if (path === '/send_msg') {
      const kind = body && body.group_id !== undefined ? 'group' : 'private';
      json(200, record(kind === 'group' ? 'send_group_msg' : 'send_private_msg', kind));
      return;
    }
    if (path === '/get_status') {
      json(200, { status: 'ok', retcode: 0, data: { online: true, good: true, app_name: 'mock-onebot' } });
      return;
    }

    json(404, { status: 'failed', retcode: 1404, message: 'unsupported action ' + path });
  });

  // ---- Forward WebSocket --------------------------------------------------
  const wsServer = http.createServer((_req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('Upgrade Required');
  });

  wsServer.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') { socket.destroy(); return; }
    const url = new URL(req.url ?? '/', 'http://' + host);
    if (requiredToken !== '' && url.searchParams.get('access_token') !== requiredToken) { socket.destroy(); return; }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + 'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n',
    );
    socket.setNoDelay(true);
    sockets.add(socket);
    say('websocket client connected (' + sockets.size + ' total)');

    socket.write(encodeTextFrame(JSON.stringify({
      post_type: 'meta_event',
      meta_event_type: 'lifecycle',
      sub_type: 'connect',
      time: Math.floor(Date.now() / 1000),
      self_id: selfId,
    })));

    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const decoded = decodeFrames(buffer);
      buffer = decoded.rest;
      for (const message of decoded.messages) {
        if (message.type === 'close') { socket.end(); continue; }
        if (message.type === 'ping') {
          const pong = Buffer.alloc(message.payload.length + 2);
          pong[0] = 0x8a;
          pong[1] = message.payload.length;
          message.payload.copy(pong, 2);
          try { socket.write(pong); } catch { /* ignore */ }
          continue;
        }
        if (message.type !== 'text') continue;
        let action;
        try { action = JSON.parse(message.payload.toString('utf8')); } catch { continue; }
        say('ws action: ' + String(action && action.action));
        const reply = { status: 'ok', retcode: 0, data: { message_id: messageSeq + 1 }, echo: action ? action.echo ?? null : null };
        const name = action ? action.action : undefined;
        if (name === 'get_status') reply.data = { online: true, good: true, app_name: 'mock-onebot' };
        if (name !== undefined && Object.prototype.hasOwnProperty.call(groupActions, name)) {
          recordAction(name, action.params ?? {}, 'websocket');
          reply.data = groupActions[name](action.params ?? {});
        } else if (name === 'send_group_msg' || name === 'send_private_msg' || name === 'send_msg') {
          const kind = name === 'send_private_msg' ? 'private'
            : name === 'send_group_msg' ? 'group'
            : (action.params && action.params.group_id !== undefined ? 'group' : 'private');
          const target = kind === 'group'
            ? { group_id: action.params ? action.params.group_id ?? null : null }
            : { user_id: action.params ? action.params.user_id ?? null : null };
          sent.push(Object.assign({ action: name, at: Date.now(), via: 'websocket' }, target, {
            message: action.params ? action.params.message ?? null : null,
          }));
        }
        try { socket.write(encodeTextFrame(JSON.stringify(reply))); } catch { /* ignore */ }
      }
    });

    const cleanup = () => {
      if (sockets.delete(socket)) say('websocket client disconnected (' + sockets.size + ' left)');
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });

  const listen = (server, port) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server.address().port));
  });

  const httpPort = await listen(httpServer, options.httpPort ?? 0);
  const wsPort = await listen(wsServer, options.wsPort ?? 0);

  return {
    host,
    httpPort,
    actions,
    setMemberRole(qq, role) { memberRoles.set(String(qq), role); },
    wsPort,
    httpUrl: 'http://' + host + ':' + httpPort,
    wsUrl: 'ws://' + host + ':' + wsPort,
    sent,
    injectMessage,
    broadcast,
    clientCount: () => sockets.size,
    async close() {
      for (const socket of sockets) { try { socket.destroy(); } catch { /* ignore */ } }
      sockets.clear();
      await Promise.all([
        new Promise((resolve) => httpServer.close(resolve)),
        new Promise((resolve) => wsServer.close(resolve)),
      ]);
    },
  };
}

// ---------------------------------------------------------------------- CLI

const isMain = process.argv[1] !== undefined
  && import.meta.url === new URL('file://' + process.argv[1]).href;

if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (name, fallback) => {
    const index = argv.indexOf('--' + name);
    return index >= 0 && argv[index + 1] !== undefined ? Number(argv[index + 1]) : fallback;
  };
  const server = await startMockOneBot({ httpPort: flag('http-port', 3000), wsPort: flag('ws-port', 3001) });
  console.log('[mock-onebot] HTTP API   :', server.httpUrl);
  console.log('[mock-onebot] Forward WS :', server.wsUrl);
  console.log('[mock-onebot] inject a fake inbound QQ message:');
  console.log('  curl -s -X POST ' + server.httpUrl + '/__inject -H "content-type: application/json"'
    + ' -d \'{"message_type":"group","group_id":33333,"user_id":22222,"text":"你好"}\'');
  console.log('[mock-onebot] read what the bot sent:');
  console.log('  curl -s ' + server.httpUrl + '/__sent');
}
