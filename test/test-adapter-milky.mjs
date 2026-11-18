#!/usr/bin/env node
/**
 * Milky 适配器自测：用本地假协议端（HTTP + WS，随机端口）跑通整条链路，不连真实 QQ。
 *
 *   node test/test-adapter-milky.mjs
 *
 * 覆盖：
 *   1. hello/status 与 /event 正向 WS 连接、派生 HTTP 地址、启动自检；
 *   2. 群消息翻译（mention/text/image/reply -> 统一段 + text/images/image_urls/reply_to/sender/self_id）；
 *   3. 私聊消息翻译（message_scene=friend，group_id=null）；
 *   4. 图片与引用（image_urls、reply_to、未知段降级为 text 不抛）；
 *   5. 发送 payload（send_group_message / send_private_message、段映射、reply 置顶、mention 补空格、降级占位）；
 *   6. 鉴权失败路径（WS 401 + HTTP 401）；
 *   7. 不支持的动作 ok=false 且说明「本协议不支持」；常用 OneBot 动作映射到 Milky API；
 *   8. ping/pong 与 shutdown。
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const here = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.join(here, '..', 'lib', 'transport', 'adapters', 'milky.mjs');

// ====================================================================== 假协议端

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const acceptKey = (key) => createHash('sha1').update(key + WS_GUID).digest('base64');

function encodeTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length;
  let header;
  if (length < 126) header = Buffer.from([0x81, length]);
  else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

/** 最小 Milky 1.3 协议端：POST /api/:api + GET /event(Upgrade)。 */
async function startMockMilky(options = {}) {
  const host = options.host ?? '127.0.0.1';
  const requiredToken = options.token ?? '';
  const selfId = 10000;
  const apiCalls = [];
  const sockets = new Set();
  const messages = new Map();
  let seq = 5000;

  const authorized = (req, url) => {
    if (requiredToken === '') return true;
    if (String(req.headers.authorization ?? '') === 'Bearer ' + requiredToken) return true;
    if (url.searchParams.get('access_token') === requiredToken) return true;
    return false;
  };

  const members = [
    { group_id: 33333, user_id: 22222, nickname: '小明', card: '卡小明', role: 'admin', sex: 'unknown', level: 3, title: '', join_time: 0, last_sent_time: 0 },
    { group_id: 33333, user_id: 10000, nickname: '机器人', card: '', role: 'owner', sex: 'unknown', level: 5, title: '', join_time: 0, last_sent_time: 0 },
  ];

  const handleApi = (endpoint, params) => {
    switch (endpoint) {
      case 'get_impl_info':
        return { status: 'ok', retcode: 0, data: { impl_name: 'mock-milky', impl_version: '1.3.0', qq_protocol_version: '9.9.9', qq_protocol_type: 'linux', milky_version: '1.3' } };
      case 'get_login_info':
        return { status: 'ok', retcode: 0, data: { uin: selfId, nickname: '机器人' } };
      case 'get_group_list':
        return { status: 'ok', retcode: 0, data: { groups: [{ group_id: 33333, group_name: '测试群', member_count: 2, max_member_count: 200 }] } };
      case 'get_group_info':
        return { status: 'ok', retcode: 0, data: { group: { group_id: Number(params.group_id), group_name: '测试群', member_count: 2, max_member_count: 200 } } };
      case 'get_group_member_list':
        return { status: 'ok', retcode: 0, data: { members } };
      case 'get_group_member_info': {
        const found = members.find((m) => String(m.user_id) === String(params.user_id));
        if (found === undefined) return { status: 'failed', retcode: -404, message: 'member not found' };
        return { status: 'ok', retcode: 0, data: { member: found } };
      }
      case 'get_message': {
        const found = messages.get(String(params.message_seq));
        if (found === undefined) return { status: 'failed', retcode: -404, message: 'message not found' };
        return { status: 'ok', retcode: 0, data: { message: found } };
      }
      case 'get_history_messages': {
        const all = [...messages.values()]
          .filter((m) => m.message_scene === params.message_scene && String(m.peer_id) === String(params.peer_id))
          .sort((a, b) => Number(a.message_seq) - Number(b.message_seq));
        const limit = Math.max(1, Math.min(30, Number(params.limit ?? 20)));
        return { status: 'ok', retcode: 0, data: { messages: all.slice(-limit), next_message_seq: all.length > limit ? all[all.length - limit].message_seq : undefined } };
      }
      case 'send_group_message':
      case 'send_private_message': {
        seq += 1;
        return { status: 'ok', retcode: 0, data: { message_seq: seq, time: Math.floor(Date.now() / 1000) } };
      }
      case 'recall_group_message':
      case 'recall_private_message':
      case 'set_group_member_mute':
      case 'set_group_whole_mute':
      case 'set_group_member_card':
      case 'set_group_member_admin':
      case 'set_group_name':
      case 'kick_group_member':
      case 'send_group_nudge':
      case 'quit_group':
        return { status: 'ok', retcode: 0, data: {} };
      case 'get_group_announcements':
        return { status: 'ok', retcode: 0, data: { announcements: [{ group_id: 33333, announcement_id: 'a1', content: '公告' }] } };
      default:
        return null;
    }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://' + host);
    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'POST' || !url.pathname.startsWith('/api/')) { json(404, { status: 'failed', retcode: -404, message: 'no such endpoint' }); return; }
    if (!authorized(req, url)) { json(401, { status: 'failed', retcode: -1, message: 'access token mismatch' }); return; }
    const raw = await readBody(req);
    let params = {};
    try { params = raw.trim() === '' ? {} : JSON.parse(raw); } catch { json(200, { status: 'failed', retcode: -400, message: 'bad json' }); return; }
    if (params === null || typeof params !== 'object') params = {};
    if (req.headers['content-type'] === undefined) { json(415, { status: 'failed', retcode: -415, message: 'content-type required' }); return; }
    const endpoint = url.pathname.slice('/api/'.length);
    apiCalls.push({ endpoint, params, at: Date.now(), authz: String(req.headers.authorization ?? '') });
    const response = handleApi(endpoint, params);
    if (response === null) { json(404, { status: 'failed', retcode: -404, message: 'unknown api ' + endpoint }); return; }
    json(200, response);
  });

  // 规范：/api 与 /event 是同一个 HTTP 服务器的两个端点，因此这里只有一个端口。
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') { socket.destroy(); return; }
    const url = new URL(req.url ?? '/', 'http://' + host);
    if (url.pathname !== '/event') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!authorized(req, url)) {
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
    sockets.add(socket);
    const cleanup = () => { sockets.delete(socket); };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
    socket.on('data', () => { /* 本适配器不在 WS 上发命令，忽略入站帧 */ });
  });

  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve(server.address().port));
  });

  const broadcast = (payload) => {
    const frame = encodeTextFrame(JSON.stringify(payload));
    for (const socket of sockets) { try { socket.write(frame); } catch { /* ignore */ } }
  };

  return {
    selfId,
    apiCalls,
    port,
    httpUrl: 'http://' + host + ':' + port,
    wsUrl: 'ws://' + host + ':' + port + '/event',
    socketCount: () => sockets.size,
    /** 推一个 event_type 事件（信封与 WS 帧完全相同）。 */
    inject(eventType, data) {
      const envelope = { time: Math.floor(Date.now() / 1000), self_id: selfId, event_type: eventType, data };
      if (eventType === 'message_receive' && data !== null && typeof data === 'object') {
        messages.set(String(data.message_seq), data);
      }
      broadcast(envelope);
      return envelope;
    },
    callsOf(endpoint) { return apiCalls.filter((call) => call.endpoint === endpoint); },
    lastCall(endpoint) { const list = apiCalls.filter((call) => call.endpoint === endpoint); return list.length === 0 ? null : list[list.length - 1]; },
    async close() {
      for (const socket of sockets) { try { socket.destroy(); } catch { /* ignore */ } }
      sockets.clear();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// ====================================================================== 测试骨架

let failures = 0;
const results = [];
function check(name, ok, detail = '') {
  const passed = Boolean(ok);
  results.push({ name, passed });
  if (!passed) failures += 1;
  console.log('  [' + (passed ? 'PASS' : 'FAIL') + '] ' + name + (passed || detail === '' ? '' : ' — ' + detail));
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('等待超时：' + label);
    await sleep(40);
  }
}

function startAdapter(args) {
  const proc = spawn(process.execPath, [ADAPTER, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  const frames = [];
  let buffer = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line === '') continue;
      try { frames.push(JSON.parse(line)); } catch { /* 忽略噪声 */ }
    }
  });
  let stderrText = '';
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk) => { stderrText += chunk; });
  const exited = new Promise((resolve) => proc.once('exit', (code) => resolve(code)));
  return {
    proc,
    frames,
    stderr: () => stderrText,
    send: (frame) => proc.stdin.write(JSON.stringify(frame) + '\n'),
    exited,
    of: (type) => frames.filter((frame) => frame.type === type),
    first: (type) => frames.find((frame) => frame.type === type),
    last: (type) => { const list = frames.filter((frame) => frame.type === type); return list.length === 0 ? null : list[list.length - 1]; },
  };
}

const imageUrl = 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=abc';
const mock = await startMockMilky({ token: 'secret-token' });
console.log('假 Milky 协议端：http=' + mock.httpUrl + ' event=' + mock.wsUrl);

const adapter = startAdapter(['--ws', mock.wsUrl, '--token', 'secret-token', '--send-gap-ms', '10']);
let wrongToken = null;

try {
  // ---------------------------------------------------------------- 1. hello / status
  console.log('\n1. hello / status / 正向 WS');
  const hello = await waitFor(() => adapter.first('hello'), 8000, 'hello 帧');
  check('hello 声明 adapter=milky', hello.adapter === 'milky', String(hello.adapter));
  check('hello 带协议版本 1.3', hello.protocolVersion === '1.3', String(hello.protocolVersion));
  check('hello 的 wsUrl 指向 /event', String(hello.wsUrl).endsWith('/event'), String(hello.wsUrl));
  check('HTTP 地址由 WS 地址派生（同端口）', hello.httpUrl === mock.httpUrl, String(hello.httpUrl));
  check('hello 通报 hasToken', hello.hasToken === true);
  const connected = await waitFor(() => adapter.frames.find((frame) => frame.type === 'status' && frame.connected === true), 8000, 'connected 状态');
  check('事件链路建立后上报 connected', connected !== undefined);
  await waitFor(() => mock.socketCount() === 1, 5000, '假协议端看到一个 WS 客户端');
  check('假协议端只收到一个 /event 连接', mock.socketCount() === 1);
  const implLog = await waitFor(() => adapter.frames.find((f) => f.type === 'log' && String(f.text).includes('milky_version')), 6000, 'get_impl_info 自检日志');
  check('启动自检调用 get_impl_info 并读出版本', String(implLog.text).includes('1.3'), String(implLog.text));
  check('HTTP API 用 Authorization: Bearer 令牌', mock.callsOf('get_impl_info').length >= 1
    && mock.callsOf('get_impl_info').every((call) => call.authz === 'Bearer secret-token'),
    JSON.stringify(mock.callsOf('get_impl_info').map((call) => call.authz)));

  // ---------------------------------------------------------------- 2. 群消息翻译
  console.log('\n2. 群消息翻译');
  mock.inject('message_receive', {
    message_scene: 'group',
    peer_id: 33333,
    message_seq: 9001,
    sender_id: 22222,
    time: 1700000000,
    group: { group_id: 33333, group_name: '测试群', member_count: 2, max_member_count: 200 },
    group_member: { group_id: 33333, user_id: 22222, nickname: '小明', card: '卡小明', role: 'admin', sex: 'unknown', level: 3 },
    segments: [
      { type: 'mention', data: { user_id: 10000, name: '机器人' } },
      { type: 'text', data: { text: ' 帮我看看' } },
      { type: 'image', data: { resource_id: 'res-1', temp_url: imageUrl, width: 100, height: 100, summary: '[图片]', sub_type: 'normal' } },
    ],
  });
  const groupFrame = await waitFor(() => adapter.first('message'), 6000, '群消息帧');
  check('群消息归类为 group', groupFrame.message_type === 'group', String(groupFrame.message_type));
  check('群号取自 peer_id', String(groupFrame.group_id) === '33333', String(groupFrame.group_id));
  check('发送者取自 sender_id', String(groupFrame.user_id) === '22222', String(groupFrame.user_id));
  check('self_id 取自事件信封', String(groupFrame.self_id) === '10000', String(groupFrame.self_id));
  check('message_id 就是 message_seq', String(groupFrame.message_id) === '9001', String(groupFrame.message_id));
  check('time 透传', groupFrame.time === 1700000000, String(groupFrame.time));
  check('mention 变成 @10000', String(groupFrame.text).startsWith('@10000 '), JSON.stringify(groupFrame.text));
  check('text/images/image_urls 齐全', groupFrame.images === 1 && groupFrame.image_urls.length === 1 && groupFrame.image_urls[0] === imageUrl, JSON.stringify(groupFrame.image_urls));
  check('sender 用内联 group_member（昵称/名片/角色）',
    groupFrame.sender !== null && groupFrame.sender.nickname === '小明' && groupFrame.sender.card === '卡小明' && groupFrame.sender.role === 'admin',
    JSON.stringify(groupFrame.sender));
  check('message 段数组归一为统一段', Array.isArray(groupFrame.message) && groupFrame.message[0].type === 'at'
    && groupFrame.message[1].type === 'text' && groupFrame.message[2].type === 'image', JSON.stringify(groupFrame.message));
  check('图片段的 url 用 temp_url', groupFrame.message[2].data.url === imageUrl, JSON.stringify(groupFrame.message[2].data));

  // ---------------------------------------------------------------- 3. 私聊消息翻译
  console.log('\n3. 私聊消息翻译');
  adapter.frames.length = 0;
  mock.inject('message_receive', {
    message_scene: 'friend',
    peer_id: 44444,
    message_seq: 9002,
    sender_id: 44444,
    time: 1700000001,
    friend: { user_id: 44444, nickname: '小红', sex: 'female', qid: '', remark: '' },
    segments: [
      { type: 'text', data: { text: '你好' } },
      { type: 'face', data: { face_id: '1', is_large: false } },
    ],
  });
  const privateFrame = await waitFor(() => adapter.first('message'), 6000, '私聊消息帧');
  check('私聊归类为 private', privateFrame.message_type === 'private', String(privateFrame.message_type));
  check('私聊的 group_id 是 null', privateFrame.group_id === null, String(privateFrame.group_id));
  check('私聊 sender 用内联 friend', privateFrame.sender !== null && privateFrame.sender.nickname === '小红', JSON.stringify(privateFrame.sender));
  check('私聊 sender.role/card 不编造（null）', privateFrame.sender.card === null && privateFrame.sender.role === null);
  check('表情段转成 [表情] 占位', privateFrame.text === '你好[表情]', JSON.stringify(privateFrame.text));
  check('表情段类型转换为 face', privateFrame.message[1].type === 'face' && privateFrame.message[1].data.id === '1', JSON.stringify(privateFrame.message[1]));

  // ---------------------------------------------------------------- 4. 图片与引用 + 未知段降级
  console.log('\n4. 图片与引用');
  adapter.frames.length = 0;
  mock.inject('message_receive', {
    message_scene: 'group',
    peer_id: 33333,
    message_seq: 9003,
    sender_id: 22222,
    time: 1700000002,
    group: { group_id: 33333, group_name: '测试群' },
    group_member: { group_id: 33333, user_id: 22222, nickname: '小明', card: '', role: 'member' },
    segments: [
      { type: 'reply', data: { message_seq: 9001, sender_id: 22222, sender_name: '小明', time: 1700000000, segments: [] } },
      { type: 'image', data: { resource_id: 'res-2', temp_url: imageUrl, width: 64, height: 64, summary: '[图片]', sub_type: 'normal' } },
      { type: 'markdown', data: { content: '**粗体**' } },
      { type: 'brand_new_segment', data: { text: '未来段' } },
    ],
  });
  const quoteFrame = await waitFor(() => adapter.first('message'), 6000, '引用消息帧');
  check('引用 id 取自 reply.message_seq', quoteFrame.reply_to === 9001, String(quoteFrame.reply_to));
  check('图片计数为 1', quoteFrame.images === 1, String(quoteFrame.images));
  check('image_urls 给视觉模型用', quoteFrame.image_urls[0] === imageUrl);
  check('reply 段不占正文', quoteFrame.text.includes('[图片]') && quoteFrame.text.includes('**粗体**') && !quoteFrame.text.includes('9001'), JSON.stringify(quoteFrame.text));
  check('未知段类型降级为 text 而不是报错', quoteFrame.message.some((seg) => seg.type === 'text' && seg.data.text === '未来段'), JSON.stringify(quoteFrame.message));
  check('markdown 段转成正文', quoteFrame.message.some((seg) => seg.type === 'text' && seg.data.text === '**粗体**'), JSON.stringify(quoteFrame.message));

  // ---------------------------------------------------------------- 5. 发送 payload
  console.log('\n5. 发送 payload');
  adapter.frames.length = 0;
  adapter.send({ type: 'send', message_type: 'group', target_id: '33333', text: '收到，我看看。', echo: 'e1' });
  const sendResult = await waitFor(() => adapter.first('send_result'), 8000, 'send_result');
  check('send_result ok 且回传 echo', sendResult.ok === true && sendResult.echo === 'e1', String(sendResult.error));
  check('send_result 带 message_id（= message_seq）', sendResult.message_id !== null && sendResult.message_id !== undefined, String(sendResult.message_id));
  const groupSend = await waitFor(() => mock.lastCall('send_group_message'), 5000, 'send_group_message 调用');
  check('群发送走 POST /api/send_group_message', groupSend !== null);
  check('group_id 转成数字', groupSend.params.group_id === 33333, JSON.stringify(groupSend.params.group_id));
  check('文本段结构正确', JSON.stringify(groupSend.params.message) === JSON.stringify([{ type: 'text', data: { text: '收到，我看看。' } }]), JSON.stringify(groupSend.params.message));

  adapter.frames.length = 0;
  adapter.send({
    type: 'send',
    message_type: 'group',
    target_id: '33333',
    reply_to: 9001,
    echo: 'e2',
    message: [
      { type: 'at', data: { qq: 'all' } },
      { type: 'at', data: { qq: '22222' } },
      { type: 'text', data: { text: '看这张' } },
      { type: 'image', data: { url: imageUrl } },
      { type: 'file', data: { name: 'a.txt' } },
      { type: 'reply', data: { id: 9001 } },
    ],
  });
  await waitFor(() => adapter.first('send_result'), 8000, '第二个 send_result');
  const richSend = mock.callsOf('send_group_message');
  const richPayload = richSend[richSend.length - 1].params.message;
  check('reply 段被置顶且只留一条', richPayload[0].type === 'reply' && richPayload[0].data.message_seq === 9001
    && richPayload.filter((seg) => seg.type === 'reply').length === 1, JSON.stringify(richPayload));
  const mentionAllIndex = richPayload.findIndex((seg) => seg.type === 'mention_all');
  const mentionIndex = richPayload.findIndex((seg) => seg.type === 'mention' && seg.data.user_id === 22222);
  check('@全体 用 mention_all', mentionAllIndex > 0);
  check('@人 用 mention(user_id) 且转数字', mentionIndex > 0, JSON.stringify(richPayload));
  const spaceAfter = (index) => index >= 0 && index + 1 < richPayload.length
    && richPayload[index + 1].type === 'text' && String(richPayload[index + 1].data.text).startsWith(' ');
  check('mention 与 mention_all 后面都补了空格 text', spaceAfter(mentionAllIndex) && spaceAfter(mentionIndex),
    JSON.stringify(richPayload.slice(Math.min(mentionAllIndex, mentionIndex), Math.min(mentionAllIndex, mentionIndex) + 3)));
  check('image 用 uri', richPayload.some((seg) => seg.type === 'image' && seg.data.uri === imageUrl), JSON.stringify(richPayload));
  check('不支持发送的 file 段降级成文本占位', richPayload.some((seg) => seg.type === 'text' && seg.data.text === '[文件:a.txt]'), JSON.stringify(richPayload));

  adapter.frames.length = 0;
  adapter.send({ type: 'send', message_type: 'private', target_id: '44444', text: '私聊回复', echo: 'e3' });
  await waitFor(() => adapter.first('send_result'), 8000, '私聊 send_result');
  const privateSend = await waitFor(() => mock.lastCall('send_private_message'), 5000, 'send_private_message 调用');
  check('私聊走 send_private_message', privateSend !== null && privateSend.params.user_id === 44444, JSON.stringify(privateSend === null ? null : privateSend.params));

  adapter.frames.length = 0;
  adapter.send({ type: 'send', message_type: 'group', text: '没有目标', echo: 'e4' });
  const badSend = await waitFor(() => adapter.first('send_result'), 5000, '缺 target_id 的 send_result');
  check('缺 target_id 时 ok=false', badSend.ok === false && String(badSend.error).includes('target_id'), String(badSend.error));

  // ---------------------------------------------------------------- 6. 鉴权失败
  console.log('\n6. 鉴权失败路径');
  wrongToken = startAdapter(['--ws', mock.wsUrl, '--token', 'wrong-token', '--send-gap-ms', '10']);
  await sleep(1200);
  check('错误令牌拿不到事件链路', mock.socketCount() === 1, String(mock.socketCount()));
  check('错误令牌不会上报 connected=true', wrongToken.frames.some((f) => f.type === 'status' && f.connected === true) === false);
  check('错误令牌时适配器仍在运行（指数重连）', wrongToken.proc.exitCode === null);
  wrongToken.frames.length = 0;
  wrongToken.send({ type: 'send', message_type: 'group', target_id: '33333', text: '试图发送', echo: 'w1' });
  const denied = await waitFor(() => wrongToken.first('send_result'), 8000, '鉴权失败的 send_result');
  check('HTTP 401 变成 ok=false', denied.ok === false && String(denied.error).includes('401'), String(denied.error));
  check('错误令牌没有消息真正发出', mock.callsOf('send_group_message').every((call) => call.params.message[0].data.text !== '试图发送') === true);
  wrongToken.send({ type: 'shutdown' });
  await wrongToken.exited;
  wrongToken = null;

  // ---------------------------------------------------------------- 7. 动作映射
  console.log('\n7. 动作映射与不支持的动作');
  adapter.frames.length = 0;
  adapter.send({ type: 'action', action: 'get_group_info', params: { group_id: 33333 }, echo: 'a1' });
  const info = await waitFor(() => adapter.first('action_result'), 6000, 'get_group_info');
  check('get_group_info -> ok + 群字段归一到 OneBot 形状', info.ok === true && info.data.group_name === '测试群' && info.data.member_count === 2, JSON.stringify(info.data));
  check('get_group_info 打到 get_group_info API', mock.lastCall('get_group_info') !== null);

  adapter.frames.length = 0;
  adapter.send({ type: 'action', action: 'set_group_ban', params: { group_id: 33333, user_id: 22222, duration: 600 }, echo: 'a2' });
  const mute = await waitFor(() => adapter.first('action_result'), 6000, 'set_group_ban');
  check('set_group_ban -> set_group_member_mute(duration)', mute.ok === true && mock.lastCall('set_group_member_mute').params.duration === 600, JSON.stringify(mute));
  check('mute 参数带上 group/user 数字 id', mock.lastCall('set_group_member_mute').params.user_id === 22222);

  adapter.frames.length = 0;
  adapter.send({ type: 'action', action: 'get_group_member_info', params: { group_id: 33333, user_id: 22222 }, echo: 'a3' });
  const member = await waitFor(() => adapter.first('action_result'), 6000, 'get_group_member_info');
  check('get_group_member_info 归一出 role/card', member.ok === true && member.data.role === 'admin' && member.data.card === '卡小明', JSON.stringify(member.data));

  adapter.frames.length = 0;
  adapter.send({ type: 'action', action: 'get_msg', params: { message_id: 9001 }, echo: 'a4' });
  const quoted = await waitFor(() => adapter.first('action_result'), 6000, 'get_msg');
  check('get_msg 用入站缓存推断场景并查 get_message', quoted.ok === true && mock.lastCall('get_message').params.message_scene === 'group', JSON.stringify(quoted));
  check('get_msg 返回 OneBot 风格 message/sender', Array.isArray(quoted.data.message)
    && quoted.data.message.some((seg) => seg.type === 'image' && seg.data.url === imageUrl)
    && String(quoted.data.sender.user_id) === '22222', JSON.stringify(quoted.data));

  adapter.frames.length = 0;
  adapter.send({ type: 'action', action: 'delete_msg', params: { message_id: 9002 }, echo: 'a5' });
  const recall = await waitFor(() => adapter.first('action_result'), 6000, 'delete_msg');
  check('delete_msg 按缓存走 recall_private_message', recall.ok === true && mock.lastCall('recall_private_message').params.message_seq === 9002
    && mock.lastCall('recall_private_message').params.user_id === 44444, JSON.stringify(recall));

  adapter.frames.length = 0;
  adapter.send({ type: 'action', action: 'delete_msg', params: { message_id: 123456 }, echo: 'a6' });
  const recallUnknown = await waitFor(() => adapter.first('action_result'), 6000, '未知消息撤回');
  check('未知消息撤回 ok=false 并说明原因', recallUnknown.ok === false && String(recallUnknown.error).includes('message_scene'), String(recallUnknown.error));

  adapter.frames.length = 0;
  adapter.send({ type: 'action', action: 'get_group_msg_history', params: { group_id: 33333, count: 10 }, echo: 'a7' });
  const history = await waitFor(() => adapter.first('action_result'), 6000, 'get_group_msg_history');
  const ids = history.data.messages.map((message) => Number(message.message_id));
  check('历史消息默认新->旧（对齐常见实现）', history.ok === true && ids.length >= 2 && ids.every((id, index) => index === 0 || ids[index - 1] > id), JSON.stringify(ids));
  check('历史消息 limit 不超过 30', mock.lastCall('get_history_messages').params.limit <= 30, String(mock.lastCall('get_history_messages').params.limit));

  adapter.frames.length = 0;
  adapter.send({ type: 'action', action: 'get_group_msg_history', params: { group_id: 33333, count: 5, message_seq: 9002, reverseOrder: true }, echo: 'a7b' });
  const paged = await waitFor(() => adapter.first('action_result'), 6000, '分页历史');
  const pagedIds = paged.data.messages.map((message) => Number(message.message_id));
  check('带 reverseOrder 时给升序（插件自己反转成新->旧）',
    paged.ok === true && pagedIds.every((id, index) => index === 0 || pagedIds[index - 1] < id), JSON.stringify(pagedIds));
  check('分页游标透传成 start_message_seq', mock.lastCall('get_history_messages').params.start_message_seq === 9002,
    JSON.stringify(mock.lastCall('get_history_messages').params));

  adapter.frames.length = 0;
  adapter.send({ type: 'action', action: 'set_group_whole_ban', params: { group_id: 33333, enable: true }, echo: 'a7c' });
  const wholeBan = await waitFor(() => adapter.first('action_result'), 6000, 'set_group_whole_ban');
  check('set_group_whole_ban.enable -> set_group_whole_mute.is_mute', wholeBan.ok === true
    && mock.lastCall('set_group_whole_mute').params.is_mute === true, JSON.stringify(wholeBan));

  adapter.frames.length = 0;
  adapter.send({ type: 'action', action: 'set_group_kick', params: { group_id: 33333, user_id: 22222, reject_add_request: false }, echo: 'a7d' });
  const kick = await waitFor(() => adapter.first('action_result'), 6000, 'set_group_kick');
  check('set_group_kick -> kick_group_member', kick.ok === true
    && mock.lastCall('kick_group_member').params.user_id === 22222, JSON.stringify(kick));

  adapter.frames.length = 0;
  adapter.send({ type: 'action', action: 'get_group_announcements', params: { group_id: 33333 }, echo: 'a8' });
  const announcement = await waitFor(() => adapter.first('action_result'), 6000, 'Milky 原生 API 透传');
  check('Milky 原生 API 名可透传', announcement.ok === true && Array.isArray(announcement.data) && announcement.data[0].content === '公告', JSON.stringify(announcement.data));

  adapter.frames.length = 0;
  adapter.send({ type: 'action', action: 'send_like', params: { user_id: 22222, times: 10 }, echo: 'a9' });
  const unsupported = await waitFor(() => adapter.first('action_result'), 6000, '不支持的动作');
  check('不支持的动作 ok=false', unsupported.ok === false);
  check('错误文案说明「本协议不支持」', String(unsupported.error).includes('本协议不支持 send_like'), String(unsupported.error));
  check('不支持的动作回传 echo', unsupported.echo === 'a9');
  check('不支持的动作没有打到协议端', mock.lastCall('send_like') === null);

  // ---------------------------------------------------------------- 8. ping / shutdown
  console.log('\n8. ping / shutdown');
  adapter.frames.length = 0;
  adapter.send({ type: 'ping' });
  const pong = await waitFor(() => adapter.first('pong'), 5000, 'pong');
  check('ping 回 pong', pong !== undefined && typeof pong.at === 'number');
  adapter.send({ type: 'shutdown' });
  const exitCode = await Promise.race([adapter.exited, sleep(5000).then(() => 'timeout')]);
  check('shutdown 后退出码 0', exitCode === 0, 'exit=' + String(exitCode));
  // ---------------------------------------------------------------- 9. WebHook 模式（--listen）
  console.log('\n9. WebHook 模式（--listen）');
  const hook = startAdapter(['--listen', '127.0.0.1:0', '--http', mock.httpUrl, '--token', 'secret-token', '--send-gap-ms', '10']);
  try {
    const listening = await waitFor(() => hook.first('listening'), 8000, 'listening 帧');
    check('WebHook 模式上报真实监听端口', listening.port > 0, String(listening.port));
    const hookStatus = await waitFor(() => hook.frames.find((frame) => frame.type === 'status' && frame.connected === true), 6000, 'WebHook connected');
    check('WebHook 模式上报 connected（回调服务就绪）', hookStatus !== undefined);
    const hookUrl = 'http://127.0.0.1:' + listening.port + '/event';
    const accepted = await fetch(hookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret-token' },
      body: JSON.stringify({
        time: 1700000003,
        self_id: 10000,
        event_type: 'message_receive',
        data: {
          message_scene: 'group',
          peer_id: 33333,
          message_seq: 9009,
          sender_id: 22222,
          time: 1700000003,
          group: { group_id: 33333, group_name: '测试群' },
          group_member: { group_id: 33333, user_id: 22222, nickname: '小明', card: '', role: 'member' },
          segments: [{ type: 'text', data: { text: 'webhook 你好' } }],
        },
      }),
    });
    check('WebHook 接收合规事件并回 200', accepted.status === 200, String(accepted.status));
    const hookMessage = await waitFor(() => hook.first('message'), 6000, 'WebHook 消息帧');
    check('WebHook 事件翻译成同样的 message 帧', hookMessage.text === 'webhook 你好' && String(hookMessage.group_id) === '33333', JSON.stringify(hookMessage.text));
    const rejected = await fetch(hookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-token' },
      body: JSON.stringify({ event_type: 'message_receive', data: {} }),
    });
    check('WebHook 错误令牌被拒（401）', rejected.status === 401, String(rejected.status));
    hook.frames.length = 0;
    hook.send({ type: 'send', message_type: 'group', target_id: '33333', text: 'webhook 发送', echo: 'wh1' });
    const hookSend = await waitFor(() => hook.first('send_result'), 8000, 'WebHook 模式 send_result');
    check('WebHook 模式仍用 HTTP API 发送', hookSend.ok === true && hookSend.echo === 'wh1', String(hookSend.error));
    hook.send({ type: 'shutdown' });
    const hookExit = await Promise.race([hook.exited, sleep(5000).then(() => 'timeout')]);
    check('WebHook 模式能正常退出', hookExit === 0, 'exit=' + String(hookExit));
  } finally {
    try { hook.proc.kill('SIGKILL'); } catch { /* 已退出 */ }
  }

  // ---------------------------------------------------------------- 9b. WebHook 默认准入（#33）
  console.log('\n9b. WebHook 未配 token：强制回环 + 读体上限');
  const openHook = startAdapter(['--listen', '0.0.0.0:0', '--http', mock.httpUrl, '--send-gap-ms', '10']);
  try {
    const openListening = await waitFor(() => openHook.first('listening'), 8000, 'listening 帧（无 token）');
    check('没配 token 时 0.0.0.0 被收回到 127.0.0.1', openListening.host === '127.0.0.1', String(openListening.host));
    const openUrl = 'http://127.0.0.1:' + openListening.port + '/event';
    const anon = await fetch(openUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ time: 1700000004, self_id: 10000, event_type: 'message_receive', data: { message_scene: 'friend', peer_id: 55555, sender_id: 55555, segments: [{ type: 'text', data: { text: '回环匿名' } }] } }),
    });
    check('回环内匿名事件仍可投递（本机信任语义不变）', anon.status === 200, String(anon.status));
    const huge = await fetch(openUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event_type: 'message_receive', data: { text: 'x'.repeat(1024 * 1024 + 1) } }),
    });
    check('超过 1 MiB 的回调体回 413（不整包读入）', huge.status === 413, String(huge.status));
    openHook.send({ type: 'shutdown' });
    const openExit = await Promise.race([openHook.exited, sleep(5000).then(() => 'timeout')]);
    check('无 token 的 WebHook 也能正常退出', openExit === 0, 'exit=' + String(openExit));
  } finally {
    try { openHook.proc.kill('SIGKILL'); } catch { /* 已退出 */ }
  }
} catch (error) {
  failures += 1;
  console.log('\nERROR: ' + (error && error.message ? error.message : String(error)));
  if (adapter.stderr().trim() !== '') console.log('适配器 stderr：\n' + adapter.stderr());
} finally {
  try { adapter.proc.kill('SIGKILL'); } catch { /* 已退出 */ }
  if (wrongToken !== null) { try { wrongToken.proc.kill('SIGKILL'); } catch { /* 忽略 */ } }
  await mock.close();
}

const passed = results.filter((result) => result.passed).length;
console.log('\n' + passed + '/' + results.length + ' 项通过');
if (failures > 0) {
  console.log('MILKY 适配器自测失败');
  process.exit(1);
}
console.log('MILKY 适配器自测通过');
process.exit(0);
