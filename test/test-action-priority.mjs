#!/usr/bin/env node
/**
 * 适配器写调度自测：`node test/test-action-priority.mjs`
 *
 * 守两件事：
 *   1. 「发完几 MB 的图，紧接着读历史」不能让动作帧排到整条队列后面（否则动作超时）；
 *   2. **帧不能被切开**：管道是字节流、适配器按行解析，一帧的字节里绝不能插进别的帧
 *      （曾经按 64KB 分片写、片间插小帧 → 大帧 JSON 被劈成两行 → 适配器「JSON 解析失败」、图片发坏）。
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createAdapterSupervision } from '../lib/gateway/adapter-supervision.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail === '' ? '' : ' — ' + detail)); }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 可控的假 stdin：记录每次 write，paused 时返回 false（模拟管道背压）。 */
function makeSup() {
  const sink = new EventEmitter();
  sink.writes = [];
  sink.paused = false;
  sink.write = (text) => {
    sink.writes.push(text);
    return sink.paused === true ? false : true;
  };
  // 放行：真实管道消费掉缓冲后会 emit drain；这里的 paused 只是「读得慢」
  sink.resume = () => { sink.paused = false; sink.emit('drain'); };
  const proc = { stdin: sink, stdout: new PassThrough(), stderr: new PassThrough(), done: new Promise(() => {}), terminate: async () => {} };
  const state = { stopping: false, connected: false, statusReason: '', stats: { errors: 0 }, pending: new Map(), actionSeq: 0 };
  const sup = createAdapterSupervision({
    TAG: '[test]',
    getConfig: () => ({ protocol: 'onebot11', mode: 'forward', onebot: { wsUrl: 'ws://x', httpUrl: '', accessToken: '' }, restart: { baseMs: 10, maxMs: 10 } }),
    getState: () => state,
    // 不 unref：测试进程没有别的事件源，unref 掉定时器会让「等超时」的用例直接退出
    ctx: { timeout: (fn, ms) => { const t = setTimeout(fn, typeof ms === 'number' ? ms : 1000); return () => clearTimeout(t); } },
    describeError: (e) => String(e),
    nodePath: process.execPath,
    getAdapterPath: () => '/tmp/fake-adapter.mjs',
    spawn: () => proc,
    qqMsgRoot: () => '/tmp',
    // 与生产插件一致：action_result 回到 pending 上
    onFrame: (frame) => {
      if (frame === null || frame === undefined) return;
      if (frame.type === 'action_result' && frame.echo && state.pending.has(frame.echo)) {
        const settle = state.pending.get(frame.echo);
        state.pending.delete(frame.echo);
        settle({ ok: frame.ok === true, data: frame.data === undefined ? null : frame.data, error: frame.error === undefined ? null : frame.error });
      }
    },
  });
  sup.spawnAdapter();
  return { sup, sink, proc, state };
}

/** 把写入序列按行切开并逐行 JSON.parse —— 这是「帧没被切开」的判据。 */
function parseFrames(writes) {
  const lines = writes.join('').split('\n').filter((line) => line !== '');
  const frames = [];
  for (const line of lines) {
    try { frames.push(JSON.parse(line)); } catch { frames.push(null); }
  }
  return { lines, frames };
}

console.log('1. 大帧整帧一次写（不切分）');
{
  const { sup, sink } = makeSup();
  sup.writeToAdapter({ type: 'send', text: 'x'.repeat(200 * 1024) });
  await sleep(40);
  check('200KB 的大帧只写一次（整帧原子写）', sink.writes.length === 1, 'writes=' + sink.writes.length);
  const parsed = parseFrames(sink.writes);
  check('写入内容按行能整行解析', parsed.lines.length === 1 && parsed.frames[0] !== null && parsed.frames[0].type === 'send', 'lines=' + parsed.lines.length);
  await sup.stopAdapter();
}

console.log('\n2. 小帧在帧边界插队（不切进大帧字节里）');
{
  const { sup, sink } = makeSup();
  sink.paused = true; // 第一帧就背压，后面的帧必须排队
  sup.writeToAdapter({ type: 'send', text: 'y'.repeat(200 * 1024) }); // 大帧 1
  await sleep(10);
  // 大帧 1 还在等 drain：这时排进来的动作帧 + 随后的大帧 2
  sup.writeToAdapter({ type: 'action', action: 'get_group_msg_history', params: { group_id: 299564047, count: 5 }, echo: 'act-1' });
  sup.writeToAdapter({ type: 'send', text: 'z'.repeat(200 * 1024) }); // 大帧 2
  sink.resume();
  await sleep(80);
  const parsed = parseFrames(sink.writes);
  const order = parsed.frames.map((frame) => (frame === null ? 'INVALID' : (frame.type === 'action' ? 'action' : 'send')));
  check('每一行都能解析（帧没有被切开）', parsed.frames.every((frame) => frame !== null), JSON.stringify(order));
  check('动作帧插在两个大帧之间', order.length === 3 && order[0] === 'send' && order[1] === 'action' && order[2] === 'send', JSON.stringify(order));
  await sup.stopAdapter();
}

console.log('\n3. 管道空闲时小帧仍一片直写');
{
  const { sup, sink } = makeSup();
  sup.writeToAdapter({ type: 'ping', echo: 'p1' });
  check('空闲时小帧只有一次 write', sink.writes.length === 1 && sink.writes[0].includes('"type":"ping"'), JSON.stringify(sink.writes));
  await sup.stopAdapter();
}

console.log('\n4. 动作请求 / 结果往返');
{
  const { sup, sink, proc } = makeSup();
  const pending = sup.callAdapterAction('get_group_msg_history', { group_id: 1, count: 5 }, 2000);
  await sleep(10);
  const frame = sink.writes.map((text) => { try { return JSON.parse(text); } catch { return null; } }).find((item) => item !== null && item.type === 'action');
  check('动作帧带 echo', frame !== undefined && frame !== null && typeof frame.echo === 'string' && frame.echo !== '', JSON.stringify(frame));
  proc.stdout.write(JSON.stringify({ type: 'action_result', echo: frame.echo, ok: true, data: { messages: [{ message_id: 1 }] } }) + '\n');
  const result = await pending;
  check('callAdapterAction 拿到 action_result', result.ok === true && Array.isArray(result.data.messages), JSON.stringify(result));
  await sup.stopAdapter();
}

console.log('\n5. 动作失败要能报出来（不再静默变空）');
{
  const { sup } = makeSup();
  const result = await sup.callAdapterAction('get_group_msg_history', { group_id: 1 }, 30);
  check('超时返回 ok:false 且带原因', result.ok === false && String(result.error).includes('动作超时'), JSON.stringify(result));
  await sup.stopAdapter();
}

console.log('\n6. writeToAdapterAsync 大帧写完才 resolve，且不破坏帧');
{
  const { sup, sink } = makeSup();
  sink.paused = true; // 需要等 drain
  const drains = setInterval(() => sink.emit('drain'), 5); // 不 unref：否则进程可能在等 drain 时退出
  const ok = await sup.writeToAdapterAsync({ type: 'send', text: 'q'.repeat(150 * 1024) }, 3000);
  clearInterval(drains);
  check('大帧异步写最终返回 true', ok === true);
  const parsed = parseFrames(sink.writes);
  check('异步写同样整帧原子（一行、可解析）', parsed.lines.length === 1 && parsed.frames[0] !== null && parsed.frames[0].type === 'send', 'lines=' + parsed.lines.length);
  await sup.stopAdapter();
}

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
