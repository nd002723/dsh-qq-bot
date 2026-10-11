#!/usr/bin/env node
/**
 * 反向 WS 自测：本脚本扮演 NapCat，主动连到适配器的监听端口。
 *
 *   node test-adapter-reverse.mjs
 *
 * 验证：
 *   1. 适配器能起反向 WS 服务并上报真实端口；
 *   2. 我们推一条 OneBot message 过去，适配器归一化后转成 stdio 帧；
 *   3. 适配器通过 stdin 收到 send 命令后，走 OneBot HTTP API 把消息发出去；
 *   4. access_token 设置后，错误 token 被拒、正确 token 通过。
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import { startMockOneBot } from './mock-onebot.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.join(here, '..', 'lib', 'onebot-adapter.mjs');

let failures = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  if (!ok) failures += 1;
  console.log('  [' + (ok ? 'PASS' : 'FAIL') + '] ' + name + (ok || detail === '' ? '' : ' — ' + detail));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('等待超时：' + label);
    await sleep(50);
  }
}

/** 起一个适配器进程，收集它的 stdout 帧 */
function startAdapter(args) {
  const proc = spawn(process.execPath, [ADAPTER, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  const frames = [];
  let buf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { frames.push(JSON.parse(line)); } catch { /* 忽略噪声 */ }
    }
  });
  let err = '';
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (c) => { err += c; });
  return { proc, frames, stderr: () => err, send: (o) => proc.stdin.write(JSON.stringify(o) + '\n') };
}

const mock = await startMockOneBot({ quiet: true });
console.log('假 OneBot HTTP：' + mock.httpUrl);

try {
  console.log('\n1. 反向 WS 服务与事件归一化');
  const a = startAdapter(['--listen', '127.0.0.1:0', '--http', mock.httpUrl, '--send-gap-ms', '10', '--heartbeat-ms', '0']);
  const listening = await waitFor(() => a.frames.find((f) => f.type === 'listening'), 8000, 'listening 帧');
  check('适配器上报了监听端口', listening.port > 0, String(listening.port));

  const ws = new WebSocket('ws://127.0.0.1:' + listening.port + '/');
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('反向 WS 连接失败')), { once: true });
  });
  check('客户端能连上反向 WS', true);
  const connected = await waitFor(() => a.frames.find((f) => f.type === 'status' && f.connected === true), 5000, 'connected 状态');
  check('适配器上报已连接', connected !== undefined);

  ws.send(JSON.stringify({
    post_type: 'message', message_type: 'group', sub_type: 'normal', message_id: 9001,
    self_id: 10000, time: Math.floor(Date.now() / 1000), user_id: 22222, group_id: 33333,
    sender: { user_id: 22222, nickname: '反向测试', card: '' },
    message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: '反向 WS 你好' } }],
    raw_message: '',
  }));
  const inbound = await waitFor(() => a.frames.find((f) => f.type === 'message'), 5000, 'message 帧');
  check('反向 WS 推来的消息被归一化', inbound.text === '@10000 反向 WS 你好', JSON.stringify(inbound.text));
  check('群号解析正确', String(inbound.group_id) === '33333', String(inbound.group_id));

  console.log('\n2. 经 stdin 发消息（走 HTTP API）');
  a.send({ type: 'send', message_type: 'group', target_id: '33333', text: '反向链路回复' });
  const sr = await waitFor(() => a.frames.find((f) => f.type === 'send_result'), 8000, 'send_result');
  check('send_result 成功', sr.ok === true, String(sr.error));
  const sent = await waitFor(() => (mock.sent.length > 0 ? mock.sent : null), 5000, 'mock 收到消息');
  check('OneBot HTTP API 收到了 send_group_msg', sent[0].action === 'send_group_msg', String(sent[0].action));
  check('文本内容正确', sent[0].message[0].data.text === '反向链路回复', JSON.stringify(sent[0].message));

  a.send({ type: 'shutdown' });
  await new Promise((r) => { const t = setTimeout(r, 4000); a.proc.once('exit', () => { clearTimeout(t); r(); }); });
  check('适配器收到 shutdown 后退出', a.proc.exitCode === 0, String(a.proc.exitCode));

  console.log('\n3. access_token 鉴权');
  const b = startAdapter(['--listen', '127.0.0.1:0', '--http', mock.httpUrl, '--token', 'secret123', '--heartbeat-ms', '0']);
  const l2 = await waitFor(() => b.frames.find((f) => f.type === 'listening'), 8000, 'listening 帧');
  const bad = new WebSocket('ws://127.0.0.1:' + l2.port + '/');
  const badOutcome = await new Promise((resolve) => {
    bad.addEventListener('open', () => resolve('opened'), { once: true });
    bad.addEventListener('error', () => resolve('rejected'), { once: true });
    bad.addEventListener('close', () => resolve('rejected'), { once: true });
    setTimeout(() => resolve('timeout'), 4000);
  });
  check('错误 token 被拒绝', badOutcome === 'rejected', badOutcome);

  const good = new WebSocket('ws://127.0.0.1:' + l2.port + '/?access_token=secret123');
  const goodOutcome = await new Promise((resolve) => {
    good.addEventListener('open', () => resolve('opened'), { once: true });
    good.addEventListener('error', () => resolve('rejected'), { once: true });
    setTimeout(() => resolve('timeout'), 4000);
  });
  check('正确 token（query 参数）通过', goodOutcome === 'opened', goodOutcome);
  const conn2 = await waitFor(() => b.frames.find((f) => f.type === 'status' && f.connected === true), 5000, 'connected');
  check('带 token 连接后上报已连接', conn2 !== undefined);
  b.send({ type: 'shutdown' });
  await new Promise((r) => { const t = setTimeout(r, 3000); b.proc.once('exit', () => { clearTimeout(t); r(); }); });
} catch (error) {
  failures += 1;
  console.log('\n错误：' + (error && error.message ? error.message : String(error)));
} finally {
  await mock.close();
}

const passed = results.filter(Boolean).length;
console.log('\n' + passed + '/' + results.length + ' 项通过');
if (failures > 0) { console.log('反向 WS 自测失败'); process.exit(1); }
console.log('反向 WS 自测通过');
process.exit(0);
