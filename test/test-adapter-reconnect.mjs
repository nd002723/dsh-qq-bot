#!/usr/bin/env node
/**
 * 适配器重连自测：`node test/test-adapter-reconnect.mjs`
 *
 * 守的是 NapCat 重启 / 对端静默后适配器「进程活着但再也不重连」那类静默掉线：
 *   1. 握手超时必须主动放弃并重试（以前会挂死）；
 *   2. 握手完成前 linkSet 里不能出现「可用链路」（禁止假 connected）；
 *   3. 建连后对端直接断开，必须继续重试并最终连上；
 *   4. reconnect() 能主动断开重连。
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createLinkSet, connectForward } from '../lib/transport/bridge/ws.mjs';
import { createAdapterSupervision } from '../lib/gateway/adapter-supervision.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail === '' ? '' : ' — ' + detail)); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error('等待超时：' + label);
    await sleep(20);
  }
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}
function handshake(socket, req) {
  const key = req.headers['sec-websocket-key'];
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n');
}

/** 起一个可控的 WS 服务端：mode = silent / drop-once / delayed / open */
function startServer(mode, delayMs = 150) {
  const state = { sockets: [], upgrades: 0 };
  const server = http.createServer((_req, res) => { res.writeHead(426); res.end(); });
  server.on('upgrade', (req, socket) => {
    state.upgrades += 1;
    state.sockets.push(socket);
    socket.on('error', () => {});
    if (mode === 'silent') return; // 永远不回 101
    if (mode === 'delayed') { setTimeout(() => { try { handshake(socket, req); } catch {} }, delayMs); return; }
    handshake(socket, req);
    if (mode === 'drop-once' && state.upgrades === 1) {
      setTimeout(() => { try { socket.destroy(); } catch {} }, 50);
    }
    socket.on('data', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        url: 'ws://127.0.0.1:' + port + '/',
        state,
        close() {
          for (const s of state.sockets) { try { s.destroy(); } catch {} }
          server.close();
        },
      });
    });
  });
}

console.log('1. 握手超时：不回 101 也必须重试（以前永久挂起）');
{
  const srv = await startServer('silent');
  const links = createLinkSet();
  let retries = 0;
  const cf = connectForward({
    url: srv.url, linkSet: links, onText: () => {},
    maxRetryMs: 200, connectTimeoutMs: 120,
    onError: (info) => { if (info.phase === 'retry') retries += 1; },
  });
  await waitFor(() => retries >= 2, 3000, '两次重试');
  check('静默对端会触发 ≥2 次重试', retries >= 2, 'retries=' + retries);
  check('握手未完成时没有可用链路', links.active() === null);
  cf.close(); srv.close();
}

console.log('2. 握手完成前 linkSet 必须是空的（禁止假 connected）');
{
  const srv = await startServer('delayed', 200);
  const links = createLinkSet();
  let opens = 0;
  const cf = connectForward({
    url: srv.url, linkSet: links, onText: () => {},
    connectTimeoutMs: 2000,
    onOpen: () => { opens += 1; },
  });
  await sleep(50);
  check('open 之前 links.active() 为 null', links.active() === null);
  await waitFor(() => opens >= 1, 3000, 'open');
  check('open 之后 links.active() 可用', links.active() !== null);
  cf.close(); srv.close();
}

console.log('3. 建连后对端直接断开：继续重试并最终连上');
{
  const srv = await startServer('drop-once');
  const links = createLinkSet();
  let opens = 0;
  let closes = 0;
  const cf = connectForward({
    url: srv.url, linkSet: links, onText: () => {},
    maxRetryMs: 300, connectTimeoutMs: 1000,
    onOpen: () => { opens += 1; },
    onClose: () => { closes += 1; },
  });
  await waitFor(() => opens >= 2, 5000, '第二次 open');
  check('对端断开后会重新握手成功（open ≥2）', opens >= 2, 'opens=' + opens);
  check('断开事件被上报', closes >= 1, 'closes=' + closes);
  check('最终链路可用', links.active() !== null);
  cf.close(); srv.close();
}

console.log('4. reconnect() 主动断开并重连');
{
  const srv = await startServer('open');
  const links = createLinkSet();
  let opens = 0;
  const cf = connectForward({
    url: srv.url, linkSet: links, onText: () => {},
    connectTimeoutMs: 1000,
    onOpen: () => { opens += 1; },
  });
  await waitFor(() => opens >= 1, 3000, '首次 open');
  cf.reconnect();
  await waitFor(() => opens >= 2, 5000, 'reconnect 后 open');
  check('reconnect() 触发新的握手（open ≥2）', opens >= 2, 'opens=' + opens);
  cf.close(); srv.close();
}


console.log('5. 背压不判失败（大图 base64 超过管道缓冲）');
{
  function makeSup(withSpawn) {
    const stdin = new EventEmitter();
    stdin.write = () => false;
    const proc = { stdin, stdout: new PassThrough(), stderr: new PassThrough(), done: new Promise(() => {}), terminate: async () => {} };
    const state = { stopping: false, connected: false, statusReason: '', stats: { errors: 0 }, pending: new Map() };
    const sup = createAdapterSupervision({
      TAG: '[test]',
      getConfig: () => ({ protocol: 'onebot11', mode: 'forward', onebot: { wsUrl: 'ws://x', httpUrl: '', accessToken: '' }, restart: { baseMs: 10, maxMs: 10 } }),
      getState: () => state,
      ctx: { timeout: (fn) => { const t = setTimeout(fn, 1000); return () => clearTimeout(t); } },
      describeError: (e) => String(e),
      nodePath: process.execPath,
      getAdapterPath: () => '/tmp/fake-adapter.mjs',
      spawn: () => proc,
      qqMsgRoot: () => '/tmp',
      onFrame: () => {},
    });
    if (withSpawn) sup.spawnAdapter();
    return { sup, stdin };
  }

  const { sup, stdin } = makeSup(true);
  check('write 返回 false 时同步写仍算接受', sup.writeToAdapter({ type: 'send', text: 'x'.repeat(200000) }) === true);
  const pending = sup.writeToAdapterAsync({ type: 'send', text: 'y'.repeat(200000) });
  setTimeout(() => stdin.emit('drain'), 20);
  check('异步写在 drain 后返回 true', (await pending) === true);
  const empty = makeSup(false);
  check('适配器未运行时仍返回 false', empty.sup.writeToAdapter({ type: 'send' }) === false && (await empty.sup.writeToAdapterAsync({ type: 'send' })) === false);
  await sup.stopAdapter();
}

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail > 0) process.exitCode = 1;
