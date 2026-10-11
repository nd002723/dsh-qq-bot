#!/usr/bin/env node
/**
 * Self-test for the OneBot 11 adapter: proves the transport half works against
 * a real WebSocket + HTTP peer, with no QQ account involved.
 *
 *   node test-adapter.mjs
 *
 * Verifies:
 *   1. the adapter connects to a forward WebSocket and reports `status: connected`;
 *   2. an inbound OneBot `message` event (array segments AND a legacy CQ string)
 *      is normalized into the adapter's stdio `message` frame with readable text;
 *   3. an outbound `send` command on stdin reaches the OneBot HTTP API and its
 *      `send_result` comes back ok.
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

function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  results.push({ name, ok });
  if (!ok) failures += 1;
  console.log('  [' + (ok ? 'PASS' : 'FAIL') + '] ' + name + (ok || detail === '' ? '' : ' — ' + detail));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + label);
    await sleep(50);
  }
}

const mock = await startMockOneBot({ quiet: true });
console.log('mock OneBot listening: http=' + mock.httpUrl + ' ws=' + mock.wsUrl);

const adapter = spawn(process.execPath, [
  ADAPTER,
  '--ws', mock.wsUrl,
  '--http', mock.httpUrl,
  '--send-gap-ms', '10',
  '--heartbeat-ms', '0',
], { stdio: ['pipe', 'pipe', 'pipe'] });

const frames = [];
let stdoutBuffer = '';
adapter.stdout.setEncoding('utf8');
adapter.stdout.on('data', (chunk) => {
  stdoutBuffer += chunk;
  let index;
  while ((index = stdoutBuffer.indexOf('\n')) >= 0) {
    const line = stdoutBuffer.slice(0, index).trim();
    stdoutBuffer = stdoutBuffer.slice(index + 1);
    if (line === '') continue;
    try { frames.push(JSON.parse(line)); } catch { /* ignore non-JSON noise */ }
  }
});
adapter.stderr.setEncoding('utf8');
let stderrText = '';
adapter.stderr.on('data', (chunk) => { stderrText += chunk; });

const send = (command) => adapter.stdin.write(JSON.stringify(command) + '\n');
const frameOfType = (type) => frames.find((f) => f.type === type);

try {
  console.log('\n1. connection handshake');
  const status = await waitFor(() => frames.find((f) => f.type === 'status' && f.connected === true), 10000, 'websocket connect');
  check('adapter reports connected status', status !== undefined);
  check('adapter announced hello with the configured ws url', frames.some((f) => f.type === 'hello' && f.wsUrl === mock.wsUrl));
  await waitFor(() => mock.clientCount() === 1, 5000, 'mock to see one client');
  check('mock server sees exactly one websocket client', mock.clientCount() === 1);

  console.log('\n2. inbound message normalization (segment array)');
  mock.injectMessage({
    message_type: 'group',
    group_id: 33333,
    user_id: 22222,
    nickname: '小明',
    message: [
      { type: 'at', data: { qq: '10000' } },
      { type: 'text', data: { text: '你好，帮我看看' } },
      { type: 'image', data: { file: 'x.jpg' } },
    ],
  });
  const inbound = await waitFor(() => frameOfType('message'), 5000, 'inbound message frame');
  check('inbound frame is a group message', inbound.message_type === 'group');
  check('group id preserved', String(inbound.group_id) === '33333', String(inbound.group_id));
  check('user id preserved', String(inbound.user_id) === '22222', String(inbound.user_id));
  check('segment array became readable text', inbound.text === '@10000 你好，帮我看看[图片]', JSON.stringify(inbound.text));
  check('image attachment counted', inbound.images === 1, String(inbound.images));
  check('sender nickname preserved', inbound.sender && inbound.sender.nickname === '小明', String(inbound.sender && inbound.sender.nickname));

  console.log('\n3. inbound normalization (legacy CQ string)');
  frames.length = 0;
  mock.injectMessage({ message_type: 'private', user_id: 44444, message: 'hi [CQ:face,id=1] there [CQ:at,qq=all]' });
  const legacy = await waitFor(() => frameOfType('message'), 5000, 'legacy message frame');
  check('legacy CQ string became readable text', legacy.text === 'hi [表情] there @全体成员 ', JSON.stringify(legacy.text));
  check('private message classified as private', legacy.message_type === 'private');

  console.log('\n4. outbound send through the OneBot HTTP API');
  send({ type: 'send', message_type: 'group', target_id: '33333', text: '收到，我这就看看。' });
  const sendResult = await waitFor(() => frameOfType('send_result'), 10000, 'send_result frame');
  check('send_result is ok', sendResult.ok === true, String(sendResult.error));
  check('send_result carries a message_id', sendResult.message_id !== null && sendResult.message_id !== undefined);

  const delivered = await waitFor(() => (mock.sent.length > 0 ? mock.sent : null), 5000, 'mock to record the outbound message');
  check('OneBot HTTP API received send_group_msg', delivered[0].action === 'send_group_msg', String(delivered[0].action));
  check('outbound group id matches', String(delivered[0].group_id) === '33333', String(delivered[0].group_id));
  check(
    'outbound text survived the round trip',
    delivered[0].message && delivered[0].message[0] && delivered[0].message[0].data.text === '收到，我这就看看。',
    JSON.stringify(delivered[0].message),
  );

  console.log('\n5. private send + ping');
  send({ type: 'send', message_type: 'private', target_id: '44444', text: 'private reply' });
  await waitFor(() => (mock.sent.length >= 2 ? true : null), 10000, 'second outbound message');
  check('second send used send_private_msg', mock.sent[1].action === 'send_private_msg', String(mock.sent[1].action));
  send({ type: 'ping' });
  const pong = await waitFor(() => frameOfType('pong'), 5000, 'pong frame');
  check('adapter answers ping with pong', pong !== undefined);

  console.log('\n6. clean shutdown');
  send({ type: 'shutdown' });
  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 5000);
    adapter.once('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  check('adapter exits on shutdown command', exitCode === 0, 'exit=' + String(exitCode));
} catch (error) {
  failures += 1;
  console.log('\nERROR: ' + (error && error.message ? error.message : String(error)));
  if (stderrText.trim() !== '') console.log('adapter stderr:\n' + stderrText);
} finally {
  try { adapter.kill('SIGKILL'); } catch { /* already gone */ }
  await mock.close();
}

const passed = results.filter((r) => r.ok).length;
console.log('\n' + passed + '/' + results.length + ' checks passed');
if (failures > 0) {
  console.log('ADAPTER SELF-TEST FAILED');
  process.exit(1);
}
console.log('ADAPTER SELF-TEST PASSED');
process.exit(0);
