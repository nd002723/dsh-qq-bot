#!/usr/bin/env node
/**
 * Self-test for the OneBot 11 adapter: proves the transport half works against
 * a real WebSocket + HTTP peer, with no QQ account involved.
 *
 *   node test-adapter.mjs
 *
 * Six sections（24 条断言），不是「三件事」——早先这里只列了三条，与用例数对不上：
 *   1. connection handshake（连上正向 WS 并报 status: connected）；
 *   2. inbound message normalization（段数组 → 可读文本 + mentions）；
 *   3. inbound normalization（legacy CQ 字符串，含「已转义的手打不算 @」）；
 *   4. outbound send（stdin 的 send 命令走 OneBot HTTP API，send_result ok）；
 *   5. private send + ping；
 *   6. clean shutdown（shutdown 命令后适配器 exit 0）。
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import { startMockOneBot } from './mock-onebot.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.join(here, '..', 'lib', 'transport', 'onebot-adapter.mjs');

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
    try {
      const frame = JSON.parse(line);
      frames.push(frame);
      // log 帧单独累积：frames 在每段用例前会被清空，而「只提示一次」这类断言要看全程。
      if (frame.type === 'log' && frame.level === 'warn') warnLog.push(frame);
    } catch { /* ignore non-JSON noise */ }
  }
});
adapter.stderr.setEncoding('utf8');
let stderrText = '';
adapter.stderr.on('data', (chunk) => { stderrText += chunk; });

const send = (command) => adapter.stdin.write(JSON.stringify(command) + '\n');
const frameOfType = (type) => frames.find((f) => f.type === type);
/** 全程累积的 warn 级 log 帧（frames 会被逐段清空，这个不会）。 */
const warnLog = [];

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
  check('segment array carries mentions（准入判定只认它，不看正文）',
    Array.isArray(inbound.mentions) && inbound.mentions.join(',') === '10000', JSON.stringify(inbound.mentions));

  console.log('\n3. inbound normalization (legacy CQ string)');
  frames.length = 0;
  mock.injectMessage({ message_type: 'private', user_id: 44444, message: 'hi [CQ:face,id=1] there [CQ:at,qq=all]' });
  const legacy = await waitFor(() => frameOfType('message'), 5000, 'legacy message frame');
  check('legacy CQ string became readable text', legacy.text === 'hi [表情] there @全体成员 ', JSON.stringify(legacy.text));
  check('legacy CQ string 也带 mentions（漏了就会退回「正文里 @机器人QQ 就算点名」的正则兜底）',
    Array.isArray(legacy.mentions) && legacy.mentions.join(',') === 'all', JSON.stringify(legacy.mentions));

  frames.length = 0;
  mock.injectMessage({ message_type: 'group', group_id: 33333, user_id: 44444, message: '[CQ:at,qq=10000] 在吗' });
  const legacyAt = await waitFor(() => frameOfType('message'), 5000, 'legacy at frame');
  check('CQ 字符串里的数字 @ 同样进 mentions', Array.isArray(legacyAt.mentions) && legacyAt.mentions[0] === '10000', JSON.stringify(legacyAt.mentions));

  // 伪造 @：用户在正文里手打一行 [CQ:at,qq=<机器人QQ>]，协议端会把方括号转义成 &#91; / &#93;。
  // 那样原文里只剩 "&#91;CQ:at,qq=10000&#93;"，绝不能算成 @，否则准入判定被绕过。
  frames.length = 0;
  mock.injectMessage({ message_type: 'group', group_id: 33333, user_id: 44444, message: '看这个 &#91;CQ:at,qq=10000&#93; 好玩吗' });
  const forged = await waitFor(() => frameOfType('message'), 5000, 'forged at frame');
  check('正文里手打的（已转义）[CQ:at…] 不算 mentions',
    Array.isArray(forged.mentions) && forged.mentions.length === 0, JSON.stringify(forged.mentions));

  // 决策 1-B：收到 CQ 字符串本身就是「实现端没配 post_format=array」的确证，应提示一次。
  // 只提示一次是刻意的——每条消息都刷一遍会把真告警淹掉。
  // 注意断言对象是 warnLog（全程累积的 log 帧），不是 frames：frames 在每段用例前会被清空。
  const cqWarn = warnLog.filter((f) => String(f.text).indexOf('post_format') >= 0);
  check('首次收到 CQ 字符串时提示 post_format 建议（且只提示一次）',
    cqWarn.length === 1, String(cqWarn.length));

  // 关于「未转义」的那种情形，这里**故意不做断言**，因为它在字符串层面无法判定：
  //   CQ 字符串里，协议层真给的 [CQ:at,qq=…] 与用户手打的 [CQ:at,qq=…] 字节完全一致。
  //   任何正则都区分不了这两者——想「挡住手打」就等于「挡住协议给的」，会把正常 @ 也吃掉。
  // 所以安全的做法只有两条，都不在这里：
  //   · 优先用段数组（post_format=array）：那条路径没有这个问题，也是默认配置；
  //   · 拿到 CQ 串时，其可信度取决于实现端是否遵守转义约定 —— 这是外部前提，不是插件能保证的。
  // 这条边界如实写在 onebot11.mjs 的注释里，测试只锁「已转义的手打不算 @」这半边。
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
