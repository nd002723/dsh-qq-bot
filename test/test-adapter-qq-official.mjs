#!/usr/bin/env node
/**
 * Self-test for the QQ 官方机器人（QQ 开放平台 API v2）适配器。
 *
 *   node test/test-adapter-qq-official.mjs
 *
 * 全程本地假服务端（随机端口），不连真实 QQ、不联网：
 *   - 假 OpenAPI：/app/getAppAccessToken、/gateway、/v2/{users,groups}/.../messages、
 *     /v2/{users,groups}/.../files、DELETE .../messages/{id}
 *   - 假 WS 网关：op10 Hello -> op2 Identify -> op0 READY / 心跳 op1 -> op11
 *   - 假平台回调：直接 POST 到适配器起的 webhook 服务（带/不带 Ed25519 签名）
 *
 * 覆盖：token 获取/缓存/刷新、webhook 签名校验与 op13 回调验证、事件翻译（群/单聊/引用/@/图片）、
 *       WS 网关握手与心跳、发送 payload 形状（文本/私聊/被动回复 msg_seq）、图片上传流程、
 *       不支持动作 ok=false、recall 走 DELETE、鉴权失败路径、ping/pong、shutdown。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import http from 'node:http';
import crypto from 'node:crypto';
import { acceptKey, encodeTextFrame, decodeFrames } from '../lib/transport/bridge/ws.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.join(here, '..', 'lib', 'transport', 'adapters', 'qq-official.mjs');

const APPID = '102030405';
const SECRET = 'test-bot-secret';
// 固定回归向量：Ed25519(seed(secret) 前 32 字节).sign('1725442341' + 'pt-123')
const OP13_SIGNATURE = 'aaa4a71016a90dc495d0d60257d260284b665a8b219b9918c6aa2eb2461ce094ad37bc71f92753d44060b39b8530e8cc1a2d28a9e2d81ecae7923180b026c80f';

// ------------------------------------------------------------------ 断言与工具

let failures = 0;
const results = [];

function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  results.push({ name, ok });
  if (!ok) failures += 1;
  console.log('  [' + (ok ? 'PASS' : 'FAIL') + '] ' + name + (ok || detail === '' ? '' : ' — ' + detail));
}

const sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); if (t.unref) t.unref(); });

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + label);
    await sleep(40);
  }
}

// ------------------------------------------------------------------ Ed25519（测试侧独立实现）

function secretSeed(secret) {
  let seed = Buffer.from(secret, 'utf8');
  while (seed.length < 32) seed = Buffer.concat([seed, seed]);
  return seed.subarray(0, 32);
}

function privateKeyFor(secret) {
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), secretSeed(secret)]);
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

const signWith = (secret, message) => crypto.sign(null, Buffer.from(message, 'utf8'), privateKeyFor(secret)).toString('hex');

// ------------------------------------------------------------------ 假 QQ 开放平台（OpenAPI + WS 网关）

const state = {
  tokenRequests: [],
  tokensIssued: 0,
  currentToken: null,
  expiresIn: '7200',
  failAuth: false,
  requests: [],
  sent: [],
  streams: [],
  uploads: [],
  deletes: [],
  interactions: [],
  gatewayRequests: [],
  wsFrames: [],
  wsClients: new Set(),
  identify: null,
  heartbeats: [],
  resumes: [],
  seq: 1,
  heartbeatIntervalMs: 30000,
  sentCounter: 0,
  fileCounter: 0,
};

function readRaw(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > 2_000_000) { settled = true; req.destroy(); resolve(''); return; }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    req.on('error', () => { if (!settled) { settled = true; resolve(''); } });
  });
}

async function startMockQQ() {
  const host = '127.0.0.1';
  let port = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://' + host);
    const raw = await readRaw(req);
    let body = null;
    if (raw !== '') { try { body = JSON.parse(raw); } catch { body = null; } }
    const auth = String(req.headers.authorization ?? '');
    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    state.requests.push({ method: req.method, path: url.pathname, auth, body });

    // ---- 鉴权 -------------------------------------------------------------
    if (url.pathname === '/app/getAppAccessToken' && req.method === 'POST') {
      state.tokenRequests.push(body);
      if (state.failAuth || body === null || body.appId !== APPID || body.clientSecret !== SECRET) {
        // 规范：token 接口失败 HTTP 仍是 200，错误码在 body.code
        json(200, { code: 100016, message: 'appid or secret invalid' });
        return;
      }
      state.tokensIssued += 1;
      state.currentToken = 'T' + String(state.tokensIssued);
      json(200, { access_token: state.currentToken, expires_in: state.expiresIn });
      return;
    }

    // ---- 网关地址（必须带 Authorization: QQBot <token>）--------------------
    if (url.pathname === '/gateway' && req.method === 'GET') {
      if (auth !== 'QQBot ' + String(state.currentToken)) { json(401, { code: 11244, message: 'invalid token' }); return; }
      state.gatewayRequests.push(auth);
      json(200, { url: 'ws://' + host + ':' + String(port) + '/websocket' });
      return;
    }

    // ---- 流式消息（仅 C2C）-------------------------------------------------
    const streamMatch = /^\/v2\/users\/([^/]+)\/stream_messages$/.exec(url.pathname);
    if (streamMatch && req.method === 'POST') {
      state.streams.push({ openid: decodeURIComponent(streamMatch[1]), path: url.pathname, body, auth });
      json(200, { id: 'STREAM.' + String(state.streams.length) });
      return;
    }

    // ---- 发消息 ------------------------------------------------------------
    const messageMatch = /^\/v2\/(users|groups)\/([^/]+)\/messages$/.exec(url.pathname);
    if (messageMatch && req.method === 'POST') {
      state.sentCounter += 1;
      state.sent.push({
        kind: messageMatch[1] === 'groups' ? 'group' : 'private',
        openid: decodeURIComponent(messageMatch[2]),
        path: url.pathname,
        body,
        auth,
      });
      json(200, {
        id: 'ROBOT1.0_SENT_' + String(state.sentCounter),
        timestamp: new Date().toISOString(),
        ext_info: { ref_idx: 'REFIDX_SENT_' + String(state.sentCounter) + '==' },
      });
      return;
    }

    // ---- 上传富媒体 --------------------------------------------------------
    const fileMatch = /^\/v2\/(users|groups)\/([^/]+)\/files$/.exec(url.pathname);
    if (fileMatch && req.method === 'POST') {
      state.fileCounter += 1;
      state.uploads.push({
        kind: fileMatch[1] === 'groups' ? 'group' : 'private',
        openid: decodeURIComponent(fileMatch[2]),
        path: url.pathname,
        body,
        auth,
      });
      json(200, { file_uuid: 'FU_' + String(state.fileCounter), file_info: 'FILEINFO_' + String(state.fileCounter), ttl: 3600 });
      return;
    }

    // ---- 撤回 --------------------------------------------------------------
    const deleteMatch = /^\/v2\/(users|groups)\/([^/]+)\/messages\/([^/]+)$/.exec(url.pathname);
    if (deleteMatch && req.method === 'DELETE') {
      state.deletes.push({ path: url.pathname, auth });
      res.writeHead(200);
      res.end();
      return;
    }

    // ---- 互动事件应答 ------------------------------------------------------
    if (/^\/interactions\/[^/]+$/.test(url.pathname) && req.method === 'PUT') {
      state.interactions.push({ path: url.pathname, body, auth });
      json(200, { code: 0 });
      return;
    }

    json(404, { code: 404, message: 'unsupported endpoint ' + url.pathname });
  });

  // ---- WS 网关 -------------------------------------------------------------
  const sendGateway = (frame) => {
    const encoded = encodeTextFrame(JSON.stringify(frame));
    for (const socket of state.wsClients) {
      try { socket.write(encoded); } catch { /* 客户端已消失 */ }
    }
  };

  const onGatewayFrame = (frame) => {
    state.wsFrames.push(frame);
    if (frame.op === 2) {
      state.identify = frame.d;
      sendGateway({ op: 0, s: 1, t: 'READY', d: { version: 1, session_id: 'sess-1', user: { id: 'bot-openid-1', username: '测试机器人', bot: true }, shard: [0, 1] } });
      return;
    }
    if (frame.op === 6) {
      state.resumes.push(frame.d);
      sendGateway({ op: 0, s: 2, t: 'RESUMED', d: '' });
      return;
    }
    if (frame.op === 1) {
      state.heartbeats.push(frame.d);
      sendGateway({ op: 11 });
    }
  };

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') { socket.destroy(); return; }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
      + 'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n',
    );
    socket.setNoDelay(true);
    state.wsClients.add(socket);
    socket.write(encodeTextFrame(JSON.stringify({ op: 10, d: { heartbeat_interval: state.heartbeatIntervalMs } })));

    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const decoded = decodeFrames(buffer);
      buffer = decoded.rest;
      for (const message of decoded.messages) {
        if (message.type === 'close') { socket.end(); continue; }
        if (message.type !== 'text') continue;
        let frame = null;
        try { frame = JSON.parse(message.payload.toString('utf8')); } catch { continue; }
        onGatewayFrame(frame);
      }
    });
    const cleanup = () => state.wsClients.delete(socket);
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });

  port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve(server.address().port));
  });

  return {
    base: 'http://' + host + ':' + String(port),
    pushGatewayEvent(eventName, d) {
      state.seq += 1;
      sendGateway({ op: 0, s: state.seq, t: eventName, id: 'evt-' + String(state.seq), d });
    },
    async close() {
      for (const socket of state.wsClients) { try { socket.destroy(); } catch { /* ignore */ } }
      state.wsClients.clear();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// ------------------------------------------------------------------ 适配器进程

function startAdapter(args) {
  const child = spawn(process.execPath, [ADAPTER, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  const frames = [];
  let stdoutBuffer = '';
  let stderrText = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    let index;
    while ((index = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, index).trim();
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      if (line === '') continue;
      try { frames.push(JSON.parse(line)); } catch { /* 非 JSON 噪音忽略 */ }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderrText += chunk; });
  return {
    child,
    frames,
    stderr: () => stderrText,
    mark: () => frames.length,
    send: (command) => child.stdin.write(JSON.stringify(command) + '\n'),
    exit: () => new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 5000);
      child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
    }),
    stop: () => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } },
  };
}

async function waitFrame(handle, type, fromIndex = 0, predicate = null, timeoutMs = 10000) {
  return await waitFor(
    () => handle.frames.slice(fromIndex).find((f) => f.type === type && (predicate === null || predicate(f))),
    timeoutMs,
    type + ' frame',
  );
}

function postWebhook(port, payload, options = {}) {
  const raw = JSON.stringify(payload);
  const headers = { 'content-type': 'application/json', 'user-agent': 'QQBot-Callback', 'x-bot-appid': options.appid ?? APPID };
  if (options.sign !== false) {
    const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
    let signature = signWith(options.secret ?? SECRET, timestamp + raw);
    if (options.tamper === true) signature = (signature[0] === 'a' ? 'b' : 'a') + signature.slice(1);
    headers['x-signature-ed25519'] = signature;
    headers['x-signature-timestamp'] = timestamp;
  }
  return fetch('http://127.0.0.1:' + String(port) + (options.path ?? '/qq/webhook'), {
    method: 'POST', headers, body: raw,
  }).then(async (response) => {
    const text = await response.text();
    let json = null;
    if (text !== '') { try { json = JSON.parse(text); } catch { json = null; } }
    return { status: response.status, json, text };
  });
}

// ------------------------------------------------------------------ 测试主体

const mock = await startMockQQ();
console.log('mock QQ openapi / gateway: ' + mock.base);

let webhookAdapter = null;
let refreshAdapter = null;
let wsAdapter = null;
let badAdapter = null;

try {
  // ================================================================ 1. webhook
  console.log('\n1. webhook 模式：listening / hello');
  webhookAdapter = startAdapter([
    '--mode', 'webhook',
    '--listen', '127.0.0.1:0',
    '--path', '/qq/webhook',
    '--appid', APPID,
    '--secret', SECRET,
    '--api-base', mock.base,
    '--self-id', 'self-openid-9',
    '--send-gap-ms', '10',
  ]);
  const hello = await waitFrame(webhookAdapter, 'hello');
  check('hello 声明 adapter=qq-official / mode=webhook', hello.adapter === 'qq-official' && hello.mode === 'webhook', JSON.stringify(hello));
  check('hello 里带 appId 且不泄露 secret', hello.appId === APPID && hello.hasSecret === true && !('secret' in hello), JSON.stringify(hello));
  const listening = await waitFrame(webhookAdapter, 'listening');
  const webhookPort = listening.port;
  check('listening 帧给出随机端口', Number.isInteger(webhookPort) && webhookPort > 0, String(webhookPort));
  check('listening 帧保留配置的 path', listening.path === '/qq/webhook', String(listening.path));
  // status 帧与 listening 帧的先后**不保证**（两个通道各自异步写 stdout，全量并发时更明显）。
  // 以前这里立刻扫一眼 frames，于是偶发「listening 已到、status 还没到」→ 单跑五次全绿、
  // 全量跑偶发一红（run-all 靠重试兜住，但那掩盖了真正的竞态）。改成等它出现。
  // 注意：status 帧是**多次**上报的（先 starting，连接成功后才是 connected），
  // 所以必须带上 predicate 找「connected===true」那一条，不能只等第一条 status。
  const connectedFrame = await waitFrame(webhookAdapter, 'status', 0, (f) => f.connected === true);
  check('启动后上报 status connected', connectedFrame.connected === true, JSON.stringify(connectedFrame));

  console.log('\n2. op13 回调地址验证（Ed25519）');
  const challenge = await postWebhook(webhookPort, { op: 13, d: { plain_token: 'pt-123', event_ts: '1725442341' } });
  check('op13 返回 HTTP 200', challenge.status === 200, 'status=' + String(challenge.status));
  check('op13 回显 plain_token', challenge.json !== null && challenge.json.plain_token === 'pt-123', JSON.stringify(challenge.json));
  check('op13 签名命中固定回归向量', challenge.json !== null && challenge.json.signature === OP13_SIGNATURE, String(challenge.json && challenge.json.signature));

  console.log('\n2c. 允许无签名回调时 Webhook 只绑回环（#33）');
  {
    // 适配器启动本身强制要 secret，所以「可鉴别」的判定条件实际是 --allow-unsigned：
    // 允许无签名回调时，任何人都能 POST 一个 op=0 进来自称任意用户，这种配置必须收回 127.0.0.1。
    const noSecret = startAdapter([
      '--mode', 'webhook', '--listen', '0.0.0.0:0', '--path', '/qq/webhook',
      '--appid', APPID, '--secret', SECRET, '--allow-unsigned', 'true',
      '--api-base', mock.base, '--self-id', 'self-openid-9', '--send-gap-ms', '10',
    ]);
    try {
      const listenNoSecret = await waitFrame(noSecret, 'listening');
      check('--allow-unsigned + --listen 0.0.0.0：实际只绑回环 (#33)',
        listenNoSecret.host === '127.0.0.1' || listenNoSecret.host === 'localhost', 'host=' + String(listenNoSecret.host));
    } finally {
      try { noSecret.proc.kill('SIGKILL'); } catch { /* 已退出 */ }
    }
  }

  console.log('\n2d. AppSecret 与 BotSecret 分开时，签名 seed 取 BotSecret（配置里那个字段不再是装饰）');
  {
    // QQ 官方规范：回调签名 seed = BotSecret；取 access_token 才用 AppSecret。两者正常不同值。
    const APP_ONLY = 'app-secret-only';
    const BOT_ONLY = 'bot-secret-abc';
    const splitAdapter = startAdapter([
      '--mode', 'webhook', '--listen', '127.0.0.1:0', '--path', '/qq/webhook',
      '--appid', APPID, '--secret', APP_ONLY, '--bot-secret', BOT_ONLY,
      '--api-base', mock.base, '--self-id', 'self-openid-9', '--send-gap-ms', '10',
    ]);
    try {
      const splitListening = await waitFrame(splitAdapter, 'listening');
      const splitPort = splitListening.port;
      const byBot = await postWebhook(splitPort, { op: 13, d: { plain_token: 'pt-split', event_ts: '1725442341' } }, { secret: BOT_ONLY });
      check('按 BotSecret 签名 → 通过（200）', byBot.status === 200, 'status=' + String(byBot.status));
      check('op13 用 BotSecret 派生出的签名正确', byBot.json !== null && byBot.json.signature === signWith(BOT_ONLY, '1725442341pt-split'), String(byBot.json && byBot.json.signature));
      const byApp = await postWebhook(splitPort, { op: 13, d: { plain_token: 'pt-split2', event_ts: '1725442342' } }, { secret: APP_ONLY });
      check('按 AppSecret 签名 → 被拒（401，说明 seed 没被混用）', byApp.status === 401, 'status=' + String(byApp.status));
    } finally {
      try { splitAdapter.proc.kill('SIGKILL'); } catch { /* 已退出 */ }
    }
  }

  console.log('\n3. 群消息事件翻译（GROUP_AT_MESSAGE_CREATE）');
  const groupMessageEvent = {
    op: 0, s: 7, t: 'GROUP_AT_MESSAGE_CREATE', id: 'evt-group-1',
    d: {
      id: 'ROBOT1.0_inbound_group',
      content: '你好<@member-openid-b>看看这个',
      timestamp: '2026-10-25T10:00:00+08:00',
      group_openid: 'group-openid-1',
      author: { id: 'member-openid-a', member_openid: 'member-openid-a', username: '小明', member_role: 'member', bot: false },
      message_type: 0,
      message_scene: { source: 'default', ext: ['msg_idx=REFIDX_in1=='] },
      attachments: [{ url: 'https://example.com/a.png', filename: 'a.png', content_type: 'image/png', width: 100, height: 80, size: 1000 }],
      mentions: [{ id: 'member-openid-b' }],
    },
  };
  const markGroup = webhookAdapter.mark();
  const ack = await postWebhook(webhookPort, groupMessageEvent);
  check('op0 事件回 ACK {"op":12}', ack.status === 200 && ack.json !== null && ack.json.op === 12, JSON.stringify(ack.json));
  const groupFrame = await waitFrame(webhookAdapter, 'message', markGroup);
  check('群消息 message_type=group', groupFrame.message_type === 'group', String(groupFrame.message_type));
  check('group_id 放 group_openid', groupFrame.group_id === 'group-openid-1', String(groupFrame.group_id));
  check('user_id 放 member_openid', groupFrame.user_id === 'member-openid-a', String(groupFrame.user_id));
  check('self_id 来自 --self-id', groupFrame.self_id === 'self-openid-9', String(groupFrame.self_id));
  check('message_id 用事件 d.id', groupFrame.message_id === 'ROBOT1.0_inbound_group', String(groupFrame.message_id));
  check('content 的 <@openid> 转成 @openid 文本', groupFrame.text === '你好@member-openid-b 看看这个[图片]', JSON.stringify(groupFrame.text));
  check('图片计数与 URL 正确', groupFrame.images === 1 && groupFrame.image_urls.length === 1 && groupFrame.image_urls[0] === 'https://example.com/a.png', JSON.stringify(groupFrame.image_urls));
  check('message 段数组含 at 段', Array.isArray(groupFrame.message) && groupFrame.message.some((s) => s.type === 'at' && s.data.qq === 'member-openid-b'), JSON.stringify(groupFrame.message));
  check('message 段数组含 image 段', Array.isArray(groupFrame.message) && groupFrame.message.some((s) => s.type === 'image' && s.data.url === 'https://example.com/a.png'));
  check('sender 昵称/群角色来自平台字段', groupFrame.sender && groupFrame.sender.nickname === '小明' && groupFrame.sender.role === 'member', JSON.stringify(groupFrame.sender));
  check('time 由 RFC3339 转成秒', groupFrame.time === Math.floor(Date.parse('2026-10-25T10:00:00+08:00') / 1000), String(groupFrame.time));
  check('没有引用时 reply_to 为 null', groupFrame.reply_to === null, String(groupFrame.reply_to));

  console.log('\n3b. 重放防护（#22）：事件 id 去重 + 时间戳新鲜度');
  const replayEvent = JSON.parse(JSON.stringify(groupMessageEvent));
  replayEvent.id = 'evt-replay-1';
  replayEvent.d.id = 'ROBOT1.0_replay_1';
  const replayMarkFirst = webhookAdapter.mark();
  const firstReplay = await postWebhook(webhookPort, replayEvent);
  const firstReplayFrame = await waitFrame(webhookAdapter, 'message', replayMarkFirst);
  check('首次投递正常派发', firstReplay.status === 200 && firstReplayFrame !== null, String(firstReplay.status));
  const replayMarkSecond = webhookAdapter.mark();
  const secondReplay = await postWebhook(webhookPort, replayEvent);
  await sleep(400);
  check('重复事件仍回 ACK（平台重投不算失败）',
    secondReplay.status === 200 && secondReplay.json !== null && secondReplay.json.op === 12, JSON.stringify(secondReplay.json));
  check('重复事件不再派发',
    webhookAdapter.frames.slice(replayMarkSecond).some((frame) => frame.type === 'message') === false,
    JSON.stringify(webhookAdapter.frames.slice(replayMarkSecond).map((frame) => frame.type)));
  const staleTs = Math.floor(Date.now() / 1000) - 3600;
  const stale = await postWebhook(webhookPort, { op: 0, s: 9, t: 'GROUP_AT_MESSAGE_CREATE', id: 'evt-stale-1', d: groupMessageEvent.d }, { timestamp: staleTs });
  check('时间戳超出 ±5 分钟被拒（401）', stale.status === 401, 'status=' + String(stale.status));

  console.log('\n4. 单聊消息事件翻译（C2C_MESSAGE_CREATE + 引用）');
  const markC2C = webhookAdapter.mark();
  await postWebhook(webhookPort, {
    op: 0, s: 8, t: 'C2C_MESSAGE_CREATE', id: 'evt-c2c-1',
    d: {
      id: 'ROBOT1.0_inbound_c2c',
      content: '帮我查一下',
      timestamp: '2026-10-25T10:01:00+08:00',
      author: { id: 'user-openid-1', user_openid: 'user-openid-1', username: '小红' },
      message_type: 103,
      message_scene: { source: 'default', ext: ['msg_idx=REFIDX_n==', 'ref_msg_idx=REFIDX_prev=='] },
      msg_elements: [{ msg_idx: 'REFIDX_prev==', content: '上一句' }],
    },
  });
  const c2cFrame = await waitFrame(webhookAdapter, 'message', markC2C);
  check('单聊 message_type=private', c2cFrame.message_type === 'private', String(c2cFrame.message_type));
  check('单聊 group_id 为 null', c2cFrame.group_id === null, String(c2cFrame.group_id));
  check('user_id 放 user_openid', c2cFrame.user_id === 'user-openid-1', String(c2cFrame.user_id));
  check('引用消息 reply_to 取 message_scene.ref_msg_idx', c2cFrame.reply_to === 'REFIDX_prev==', String(c2cFrame.reply_to));
  check('单聊无图片时 images=0 / image_urls 为空', c2cFrame.images === 0 && c2cFrame.image_urls.length === 0, JSON.stringify(c2cFrame.image_urls));

  console.log('\n4b. 关系事件通知（GROUP_ADD_ROBOT）');
  const noticeMark = webhookAdapter.mark();
  await postWebhook(webhookPort, {
    op: 0, s: 9, t: 'GROUP_ADD_ROBOT', id: 'evt-add-bot-1',
    d: { timestamp: 1790000000, group_openid: 'group-openid-new', op_member_openid: 'member-openid-admin' },
  });
  const addBot = await waitFrame(webhookAdapter, 'notice', noticeMark, (f) => f.notice_type === 'group_add_bot');
  check('GROUP_ADD_ROBOT -> notice(group_add_bot)', addBot.notice_type === 'group_add_bot' && addBot.sub_type === 'GROUP_ADD_ROBOT', JSON.stringify(addBot));
  check('通知带 group_id / operator_id / event_id', addBot.group_id === 'group-openid-new' && addBot.operator_id === 'member-openid-admin' && addBot.event_id === 'evt-add-bot-1', JSON.stringify([addBot.group_id, addBot.operator_id, addBot.event_id]));

  console.log('\n5. webhook 签名校验失败路径');
  const messageCountBefore = webhookAdapter.frames.filter((f) => f.type === 'message').length;
  const unsigned = await postWebhook(webhookPort, { op: 0, t: 'C2C_MESSAGE_CREATE', id: 'evt-bad-1', d: { id: 'x', content: 'unsigned' } }, { sign: false });
  check('缺签名头的回调被拒 401', unsigned.status === 401, 'status=' + String(unsigned.status));
  const tampered = await postWebhook(webhookPort, { op: 0, t: 'C2C_MESSAGE_CREATE', id: 'evt-bad-2', d: { id: 'y', content: 'tampered' } }, { tamper: true });
  check('签名错误的回调被拒 401', tampered.status === 401, 'status=' + String(tampered.status));
  const appidMismatch = await postWebhook(webhookPort, { op: 0, t: 'C2C_MESSAGE_CREATE', id: 'evt-bad-3', d: { id: 'z', content: 'wrong appid' } }, { appid: '999999' });
  check('X-Bot-Appid 与配置不符被拒 403', appidMismatch.status === 403, 'status=' + String(appidMismatch.status));
  await sleep(250);
  check('被拒回调不会产生 message 帧', webhookAdapter.frames.filter((f) => f.type === 'message').length === messageCountBefore);

  console.log('\n6. 发送：群聊文本 + 被动回复 msg_id/msg_seq');
  const sentMark1 = state.sent.length;
  const tokenMark = state.tokenRequests.length;
  webhookAdapter.send({ type: 'send', message_type: 'group', target_id: 'group-openid-1', text: '收到，我看看。', reply_to: 'ROBOT1.0_inbound_group', echo: 'e1' });
  const sendResult1 = await waitFrame(webhookAdapter, 'send_result', 0, (f) => f.echo === 'e1');
  check('send_result ok 且回传 echo', sendResult1.ok === true && sendResult1.echo === 'e1', String(sendResult1.error));
  check('send_result 带平台 message_id', sendResult1.message_id === 'ROBOT1.0_SENT_1', String(sendResult1.message_id));
  const outboundGroup = state.sent[sentMark1];
  check('群聊打到 /v2/groups/{group_openid}/messages', outboundGroup.path === '/v2/groups/group-openid-1/messages', outboundGroup.path);
  check('请求体 msg_type=0 + content', outboundGroup.body.msg_type === 0 && outboundGroup.body.content === '收到，我看看。', JSON.stringify(outboundGroup.body));
  check('被动回复带 msg_id（事件 d.id）', outboundGroup.body.msg_id === 'ROBOT1.0_inbound_group', JSON.stringify(outboundGroup.body));
  check('被动回复 msg_seq 从 1 开始', outboundGroup.body.msg_seq === 1, String(outboundGroup.body.msg_seq));
  check('HTTP 用 Authorization: QQBot <token>', outboundGroup.auth === 'QQBot T1', outboundGroup.auth);
  check('token 请求体含 appId/clientSecret 且只取一次', state.tokenRequests.length - tokenMark === 1
    && state.tokenRequests[tokenMark].appId === APPID && state.tokenRequests[tokenMark].clientSecret === SECRET, JSON.stringify(state.tokenRequests[tokenMark]));

  console.log('\n7. 发送：私聊文本（无引用 => 主动消息，不带 msg_id）');
  const sentMark2 = state.sent.length;
  webhookAdapter.send({ type: 'send', message_type: 'private', target_id: 'user-openid-1', text: '私聊回复', echo: 'e2' });
  const sendResult2 = await waitFrame(webhookAdapter, 'send_result', 0, (f) => f.echo === 'e2');
  check('私聊 send_result ok', sendResult2.ok === true, String(sendResult2.error));
  const outboundPrivate = state.sent[sentMark2];
  check('私聊打到 /v2/users/{user_openid}/messages', outboundPrivate.path === '/v2/users/user-openid-1/messages', outboundPrivate.path);
  check('主动消息不带 msg_id/msg_seq', outboundPrivate.body.msg_id === undefined && outboundPrivate.body.msg_seq === undefined, JSON.stringify(outboundPrivate.body));
  check('多次发送复用缓存 token', state.tokenRequests.length - tokenMark === 1, String(state.tokenRequests.length - tokenMark));

  console.log('\n8. 发送：段数组（文本 + 图片）=> 先上传 /files 再 msg_type=7');
  const sentMark3 = state.sent.length;
  const uploadMark = state.uploads.length;
  webhookAdapter.send({
    type: 'send',
    message_type: 'group',
    target_id: 'group-openid-1',
    message: [{ type: 'text', data: { text: '图来了' } }, { type: 'image', data: { url: 'https://example.com/b.png' } }],
    reply_to: 'ROBOT1.0_inbound_group',
    echo: 'e3',
  });
  const sendResult3 = await waitFrame(webhookAdapter, 'send_result', 0, (f) => f.echo === 'e3');
  check('图文混合 send_result ok', sendResult3.ok === true, String(sendResult3.error));
  const upload = state.uploads[uploadMark];
  check('图片上传打到 /v2/groups/{id}/files', upload.path === '/v2/groups/group-openid-1/files', upload.path);
  check('上传体 file_type=1 + url + srv_send_msg=false', upload.body.file_type === 1 && upload.body.url === 'https://example.com/b.png' && upload.body.srv_send_msg === false, JSON.stringify(upload.body));
  const textPart = state.sent[sentMark3];
  const mediaPart = state.sent[sentMark3 + 1];
  check('文本段先发（msg_type=0）且 msg_seq 递增到 2', textPart.body.msg_type === 0 && textPart.body.content === '图来了' && textPart.body.msg_seq === 2, JSON.stringify(textPart.body));
  check('图片段后发（msg_type=7 + media.file_info）', mediaPart.body.msg_type === 7 && mediaPart.body.media && mediaPart.body.media.file_info === 'FILEINFO_1', JSON.stringify(mediaPart.body));
  check('图片段继续递增到 msg_seq 3', mediaPart.body.msg_seq === 3, String(mediaPart.body.msg_seq));
  check('图片段仍带同一个被动回复 msg_id', mediaPart.body.msg_id === 'ROBOT1.0_inbound_group');

  console.log('\n8c. 富消息：markdown + keyboard + 输入中');
  {
    const sentMarkMd = state.sent.length;
    webhookAdapter.send({ type: 'send', message_type: 'group', target_id: 'group-openid-1', markdown: '**粗体** 正文', keyboard: { rows: [{ buttons: [] }] }, reply_to: 'ROBOT1.0_inbound_group', typing: true, echo: 'e-md' });
    const mdSent = await waitFor(() => state.sent.slice(sentMarkMd).find((s) => s.body && s.body.msg_type === 2), 4000, 'markdown send');
    check('markdown 用 msg_type=2 + markdown.content', mdSent.body.msg_type === 2 && String(mdSent.body.markdown.content).includes('粗体'), JSON.stringify(mdSent.body));
    check('keyboard 原样透传', mdSent.body.keyboard !== undefined && Array.isArray(mdSent.body.keyboard.rows), JSON.stringify(mdSent.body.keyboard));
    check('markdown 也带被动回复 msg_id / 递增 msg_seq', mdSent.body.msg_id === 'ROBOT1.0_inbound_group' && mdSent.body.msg_seq >= 2, JSON.stringify([mdSent.body.msg_id, mdSent.body.msg_seq]));
    const typingSent = await waitFor(() => state.sent.slice(sentMarkMd).find((s) => s.body && s.body.msg_type === 6), 4000, 'typing');
    check('输入中提示用 msg_type=6', typingSent.body.msg_type === 6, JSON.stringify(typingSent.body));
  }

  console.log('\n8d. 按钮点击（INTERACTION_CREATE）→ message 帧');
  {
    const interMark = webhookAdapter.mark();
    await postWebhook(webhookPort, {
      op: 0, s: 21, t: 'INTERACTION_CREATE', id: 'inter-1',
      d: {
        id: 'INTER-1', type: 11,
        group_openid: 'group-openid-1', user_openid: 'user-openid-1',
        data: { resolved: { button_id: 'b1', button_data: '/help' } },
      },
    });
    const interFrame = await waitFrame(webhookAdapter, 'message', interMark, (f) => f.sub_type === 'interaction');
    check('按钮点击翻译成 message（带按钮 data 文本）', interFrame.text === '/help', String(interFrame.text));
    check('按钮点击保留群与用户身份', interFrame.group_id === 'group-openid-1' && interFrame.user_id === 'user-openid-1', JSON.stringify([interFrame.group_id, interFrame.user_id]));
    check('交互事件仍回 notice（原有行为不丢）', webhookAdapter.frames.some((f) => f.type === 'notice' && f.notice_type === 'interaction'));
  }

  console.log('\n8e. 流式消息（C2C stream_messages）');
  {
    const streamMark = state.streams.length;
    webhookAdapter.send({ type: 'stream', message_type: 'private', target_id: 'user-openid-1', msg_id: 'ROBOT1.0_STREAM_SRC', text: '第一段', echo: 's1' });
    await waitFrame(webhookAdapter, 'send_result', 0, (f) => f.echo === 's1');
    webhookAdapter.send({ type: 'stream', message_type: 'private', target_id: 'user-openid-1', msg_id: 'ROBOT1.0_STREAM_SRC', text: '第一段 + 第二段', done: true, echo: 's2' });
    await waitFrame(webhookAdapter, 'send_result', 0, (f) => f.echo === 's2');
    const frames = state.streams.slice(streamMark);
    check('两帧都打到 /v2/users/{openid}/stream_messages', frames.length === 2 && frames.every((f) => f.path === '/v2/users/user-openid-1/stream_messages'), JSON.stringify(frames.map((f) => f.path)));
    check('input_mode=replace + content_type=markdown', frames.every((f) => f.body.input_mode === 'replace' && f.body.content_type === 'markdown'));
    check('index 递增 0 → 1', frames[0].body.index === 0 && frames[1].body.index === 1, JSON.stringify(frames.map((f) => f.body.index)));
    check('同一 msg_seq（不是每帧递增）', frames[0].body.msg_seq === frames[1].body.msg_seq, JSON.stringify(frames.map((f) => f.body.msg_seq)));
    check('input_state 1 → 10（完成）', frames[0].body.input_state === 1 && frames[1].body.input_state === 10, JSON.stringify(frames.map((f) => f.body.input_state)));
    check('第二帧带 stream_msg_id', typeof frames[1].body.stream_msg_id === 'string' && frames[1].body.stream_msg_id !== '', JSON.stringify(frames[1].body.stream_msg_id));
    check('群聊不支持流式（适配器不产出 stream 帧）', frames.every((f) => f.type !== 'stream'));
  }

  console.log('\n9. 动作：官方不支持的一律 ok=false');
  const actionMark = webhookAdapter.mark();
  webhookAdapter.send({ type: 'action', action: 'kick', params: { group_id: 'group-openid-1', user_id: 'u1' }, echo: 'a1' });
  const kick = await waitFrame(webhookAdapter, 'action_result', actionMark, (f) => f.echo === 'a1');
  check('kick 回 action_result ok=false', kick.ok === false && kick.action === 'kick', JSON.stringify(kick));
  check('kick 的错误写明「QQ 官方 API 不支持 kick」', String(kick.error).includes('QQ 官方 API 不支持 kick'), String(kick.error));
  const actionMark2 = webhookAdapter.mark();
  webhookAdapter.send({ type: 'action', action: 'set_card', params: { group_id: 'group-openid-1', user_id: 'u1' }, echo: 'a1b' });
  const setCard = await waitFrame(webhookAdapter, 'action_result', actionMark2, (f) => f.echo === 'a1b');
  check('set_card 同样 ok=false 且不假装成功', setCard.ok === false && String(setCard.error).includes('不支持'), JSON.stringify(setCard));

  console.log('\n10. 动作：recall 走 DELETE（官方支持）');
  const deleteMark = state.deletes.length;
  webhookAdapter.send({ type: 'action', action: 'recall', params: { message_type: 'group', target_id: 'group-openid-1', message_id: 'ROBOT1.0_SENT_1' }, echo: 'a2' });
  const recall = await waitFrame(webhookAdapter, 'action_result', 0, (f) => f.echo === 'a2');
  check('recall 回 ok=true', recall.ok === true, String(recall.error));
  check('recall 打到 DELETE /v2/groups/{id}/messages/{message_id}', state.deletes[deleteMark].path === '/v2/groups/group-openid-1/messages/ROBOT1.0_SENT_1', String(state.deletes[deleteMark] && state.deletes[deleteMark].path));

  console.log('\n11. access_token 刷新（expires_in 40s < 60s 边距 => 每次发送前换新）');
  state.expiresIn = '40';
  refreshAdapter = startAdapter([
    '--mode', 'webhook',
    '--listen', '127.0.0.1:0',
    '--path', '/cb',
    '--appid', APPID,
    '--secret', SECRET,
    '--api-base', mock.base,
    '--send-gap-ms', '10',
  ]);
  await waitFrame(refreshAdapter, 'listening');
  const refreshMark = state.tokenRequests.length;
  const sentMark4 = state.sent.length;
  refreshAdapter.send({ type: 'send', message_type: 'group', target_id: 'group-openid-1', text: '第一次发送', echo: 'e4' });
  const sendResult4 = await waitFrame(refreshAdapter, 'send_result', 0, (f) => f.echo === 'e4');
  check('首次发送只取一次 token', state.tokenRequests.length - refreshMark === 1, String(state.tokenRequests.length - refreshMark));
  check('首次发送成功', sendResult4.ok === true, String(sendResult4.error));
  refreshAdapter.send({ type: 'send', message_type: 'group', target_id: 'group-openid-1', text: '第二次发送', echo: 'e5' });
  const sendResult5 = await waitFrame(refreshAdapter, 'send_result', 0, (f) => f.echo === 'e5');
  check('距过期 < 60s 时第二次发送前重新获取 token', state.tokenRequests.length - refreshMark === 2, String(state.tokenRequests.length - refreshMark));
  check('新 token 与旧 token 不同且被实际使用', state.sent[sentMark4].auth !== state.sent[sentMark4 + 1].auth
    && state.sent[sentMark4 + 1].auth === 'QQBot ' + String(state.currentToken), String(state.sent[sentMark4].auth) + ' -> ' + String(state.sent[sentMark4 + 1].auth));
  check('刷新后发送仍成功', sendResult5.ok === true, String(sendResult5.error));
  state.expiresIn = '7200';
  refreshAdapter.send({ type: 'shutdown' });
  check('刷新测试实例正常退出', (await refreshAdapter.exit()) === 0);

  console.log('\n12. ping / shutdown');
  webhookAdapter.send({ type: 'ping' });
  await waitFrame(webhookAdapter, 'pong');
  check('ping 得到 pong', true);
  webhookAdapter.send({ type: 'shutdown' });
  check('webhook 适配器收到 shutdown 后 exit 0', (await webhookAdapter.exit()) === 0);

  // ================================================================ 2. WS 网关
  console.log('\n13. ws 模式：/gateway -> op10 -> op2 identify -> READY');
  state.identify = null;
  state.heartbeats.length = 0;
  state.heartbeatIntervalMs = 300;
  const wsTokenMark = state.tokenRequests.length;
  wsAdapter = startAdapter([
    '--mode', 'ws',
    '--appid', APPID,
    '--secret', SECRET,
    '--api-base', mock.base,
    '--send-gap-ms', '10',
  ]);
  const wsHello = await waitFrame(wsAdapter, 'hello');
  check('ws hello 的 mode=ws', wsHello.adapter === 'qq-official' && wsHello.mode === 'ws', JSON.stringify(wsHello));
  const identify = await waitFor(() => state.identify, 10000, 'op2 identify');
  check('先取 token 再请求 /gateway', state.tokenRequests.length - wsTokenMark === 1 && state.gatewayRequests.length >= 1);
  check('/gateway 带 Authorization: QQBot <token>', state.gatewayRequests[state.gatewayRequests.length - 1] === 'QQBot ' + String(state.currentToken), String(state.gatewayRequests[state.gatewayRequests.length - 1]));
  check('op2 identify 的 d.token 是 "QQBot <token>"', identify.token === 'QQBot ' + String(state.currentToken), String(identify.token));
  check('identify 带群/单聊 intents 100663296', identify.intents === 100663296, String(identify.intents));
  check('identify 带 shard [0,1]', Array.isArray(identify.shard) && identify.shard[0] === 0 && identify.shard[1] === 1, JSON.stringify(identify.shard));
  check('identify 带 properties（$os/$browser/$device）', identify.properties && typeof identify.properties.$os === 'string' && identify.properties.$browser === 'dsh', JSON.stringify(identify.properties));
  await waitFrame(wsAdapter, 'status', 0, (f) => f.connected === true);
  check('READY 之后上报 connected', wsAdapter.frames.some((f) => f.type === 'status' && f.connected === true));

  console.log('\n14. ws 心跳 op1 / op11');
  const heartbeat = await waitFor(() => state.heartbeats[0], 5000, 'op1 heartbeat');
  check('收到 op10 后按 heartbeat_interval 发 op1（d=最新 s，首帧可为 null）', heartbeat === 1 || heartbeat === null, 'd=' + JSON.stringify(heartbeat));

  console.log('\n15. ws 事件翻译（群 @ / 单聊）=> self_id 来自 READY');
  const wsMark = wsAdapter.mark();
  mock.pushGatewayEvent('GROUP_AT_MESSAGE_CREATE', {
    id: 'ROBOT1.0_ws_group',
    content: '网关群消息',
    timestamp: '2026-10-25T11:00:00+08:00',
    group_openid: 'group-openid-ws',
    author: { id: 'member-openid-ws', member_openid: 'member-openid-ws', username: '网关用户', member_role: 'owner' },
    message_type: 0,
    message_scene: { source: 'default', ext: [] },
    attachments: [
      { url: 'https://example.com/ws-voice.wav', content_type: 'voice', voice_wav_url: 'https://example.com/ws-voice.wav', asr_refer_text: '语音转写' },
      { url: 'https://example.com/ws-file.pdf', filename: '报告.pdf', content_type: 'file' },
    ],
  });
  const wsGroup = await waitFrame(wsAdapter, 'message', wsMark, (f) => f.message_type === 'group');
  check('ws 群消息 self_id 来自 READY 的 user.id', wsGroup.self_id === 'bot-openid-1', String(wsGroup.self_id));
  check('ws 群消息 group_id/user_id 正确', wsGroup.group_id === 'group-openid-ws' && wsGroup.user_id === 'member-openid-ws', JSON.stringify([wsGroup.group_id, wsGroup.user_id]));
  check('语音/文件附件降级成占位符文本', wsGroup.text === '网关群消息[语音][文件:报告.pdf]', JSON.stringify(wsGroup.text));
  check('语音不算图片', wsGroup.images === 0 && wsGroup.image_urls.length === 0, JSON.stringify(wsGroup.image_urls));
  const wsMark2 = wsAdapter.mark();
  mock.pushGatewayEvent('C2C_MESSAGE_CREATE', {
    id: 'ROBOT1.0_ws_c2c',
    content: '网关单聊',
    timestamp: '2026-10-25T11:01:00+08:00',
    author: { id: 'user-openid-ws', user_openid: 'user-openid-ws' },
    message_type: 0,
  });
  const wsC2C = await waitFrame(wsAdapter, 'message', wsMark2, (f) => f.message_type === 'private');
  check('ws 单聊 message_type=private / group_id=null', wsC2C.group_id === null && wsC2C.user_id === 'user-openid-ws', JSON.stringify([wsC2C.group_id, wsC2C.user_id]));

  console.log('\n16. ws 模式发送（payload 与本 test 的 OpenAPI 一致）');
  const wsSentMark = state.sent.length;
  wsAdapter.send({ type: 'send', message_type: 'group', target_id: 'group-openid-ws', text: 'ws 发出的回复', reply_to: 'ROBOT1.0_ws_group', echo: 'w1' });
  const wsSendResult = await waitFrame(wsAdapter, 'send_result', 0, (f) => f.echo === 'w1');
  check('ws 模式 send_result ok', wsSendResult.ok === true, String(wsSendResult.error));
  const wsOutbound = state.sent[wsSentMark];
  check('ws 模式同样走 msg_type=0 + msg_id + msg_seq', wsOutbound.body.msg_type === 0 && wsOutbound.body.msg_id === 'ROBOT1.0_ws_group' && wsOutbound.body.msg_seq === 1, JSON.stringify(wsOutbound.body));
  check('ws 模式 HTTP 仍用 QQBot <token>', /^QQBot T\d+$/.test(wsOutbound.auth), wsOutbound.auth);
  wsAdapter.send({ type: 'action', action: 'get_group_info', params: { group_id: 'group-openid-ws' }, echo: 'w2' });
  const wsAction = await waitFrame(wsAdapter, 'action_result', 0, (f) => f.echo === 'w2');
  check('ws 模式下不支持动作也 ok=false', wsAction.ok === false && String(wsAction.error).includes('QQ 官方 API 不支持 get_group_info'), JSON.stringify(wsAction));
  wsAdapter.send({ type: 'shutdown' });
  check('ws 适配器 shutdown 后 exit 0', (await wsAdapter.exit()) === 0);

  // ================================================================ 3. 鉴权失败
  console.log('\n17. access_token 失败路径（错误码在 body.code，HTTP 200）');
  state.failAuth = true;
  badAdapter = startAdapter([
    '--mode', 'webhook',
    '--listen', '127.0.0.1:0',
    '--path', '/cb',
    '--appid', APPID,
    '--secret', 'wrong-secret',
    '--api-base', mock.base,
    '--send-gap-ms', '10',
  ]);
  await waitFrame(badAdapter, 'listening');
  badAdapter.send({ type: 'send', message_type: 'private', target_id: 'user-openid-1', text: 'x', echo: 'bad1' });
  const badResult = await waitFrame(badAdapter, 'send_result', 0, (f) => f.echo === 'bad1');
  check('token 获取失败 -> send_result ok=false', badResult.ok === false, JSON.stringify(badResult));
  check('错误里带平台 code 100016 / appid 提示', /100016|appid/i.test(String(badResult.error)), String(badResult.error));
  badAdapter.send({ type: 'ping' });
  await waitFrame(badAdapter, 'pong');
  check('鉴权失败后适配器仍存活（能回 pong）', true);
  badAdapter.send({ type: 'shutdown' });
  check('鉴权失败实例也能正常退出', (await badAdapter.exit()) === 0);
  state.failAuth = false;
} catch (error) {
  failures += 1;
  console.log('\nERROR: ' + (error && error.message ? error.message : String(error)));
  for (const [name, handle] of [['webhook', webhookAdapter], ['refresh', refreshAdapter], ['ws', wsAdapter], ['bad', badAdapter]]) {
    if (handle !== null && handle.stderr().trim() !== '') console.log(name + ' adapter stderr:\n' + handle.stderr());
  }
} finally {
  for (const handle of [webhookAdapter, refreshAdapter, wsAdapter, badAdapter]) if (handle !== null) handle.stop();
  await mock.close();
}

const passed = results.filter((r) => r.ok).length;
console.log('\n' + String(passed) + '/' + String(results.length) + ' checks passed');
if (failures > 0) {
  console.log('QQ OFFICIAL ADAPTER SELF-TEST FAILED');
  process.exit(1);
}
console.log('QQ OFFICIAL ADAPTER SELF-TEST PASSED');
process.exit(0);
