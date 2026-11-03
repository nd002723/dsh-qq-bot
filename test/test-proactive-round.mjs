#!/usr/bin/env node
/**
 * 主动发言回合的端到端验证：不需要 DSH，不需要 QQ，也不需要等定时器。
 *
 *   node test/test-proactive-round.mjs
 *
 * 目的：把「轮到该说话 → 判断 → 发言 → 校验（requireCjk）→ 回退 → 发送」整条链在
 * 真插件代码上跑一遍。此前这条链只有生产实例上肉眼验证过，纯函数测试盖不到
 * index.js 里那段胶水——尤其「requireCjk 有没有真的透传进发言阶段」这种接线错误。
 *
 * requireCjk 在 index.js 里有两处接线（单段一处、两段式的发言阶段一处），漏掉任何一处
 * 纯函数测试都看不出来，所以按场景各跑一遍：
 *   1. 两段式（配了 speakModel）：发言模型两次回英文拒绝语 → 被拦 → 回退判断正文 → 发出；
 *   2. 单段式（不配 speakModel）：判断正文本身就是英文拒绝语 → 被拦 → 一条都不发；
 *   3. 反向对照：同一句话在 requireCjk 关掉时会被发出去。
 *
 * 做法：每个场景各自起假 OneBot、各自 apply、跑完各自清理；假 ctx + 真 lib/index.js，
 * 把插件注册的定时器回调抓出来手动触发，于是整轮检查是确定性的，不用 sleep 五分钟。
 */

import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import process from 'node:process';
import { startMockOneBot } from './mock-onebot.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.join(here, '..');
let failures = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  if (!ok) failures += 1;
  console.log('  [' + (ok ? 'PASS' : 'FAIL') + '] ' + name + (ok || detail === '' ? '' : ' — ' + detail));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (sent) => {
  const msg = (sent && Array.isArray(sent.message)) ? sent.message : [];
  const seg = msg.find((s) => s && s.type === 'text');
  return seg && seg.data && typeof seg.data.text === 'string' ? seg.data.text : '';
};

const linkPath = path.join(PKG_ROOT, 'node_modules');
let createdLink = false;
const PROFILE_MODULES = process.env.DSH_PROFILE_MODULES ?? path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'profiles', 'node_modules');
if (!fs.existsSync(linkPath) && fs.existsSync(PROFILE_MODULES)) {
  fs.symlinkSync(PROFILE_MODULES, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  createdLink = true;
}
try { await import.meta.resolve('@deepseek-ai/schemastery'); }
catch {
  console.log('缺少 @deepseek-ai/schemastery —— 请先在本目录执行 npm install / pnpm install。');
  process.exit(2);
}

const logLines = [];
const realLog = console.log;
console.log = (...args) => { logLines.push(args.map(String).join(' ')); realLog(...args); };

// 假模型的三句台词：判断模型的正常正文、以及「整句英文拒绝语」——后者是 requireCjk 要拦的东西。
// 一句 61 字符、一个 CJK 都没有，正好落在「> 12 字且无 CJK」这个判据里。
const JUDGE_TEXT = '那就下午三点老地方见';
const ENGLISH_REJECT = "Sorry, it looks like I can't chat about this topic right now.";

/**
 * 跑一个主动发言场景：起假 OneBot → 假 ctx + 真 lib/index.js → 手动触发那一轮检查 → 断言 → 清理。
 *
 * 每个场景的 mock / ctx / 定时器数组都是新造的，同一个进程里顺序跑多次也不会互相串味
 * （插件状态全在 apply() 的闭包里）；清理（disposers + mock.close）在本函数返回前做完。
 *
 * @param {{ label: string, judgeMessage: string, proactive?: object, verify: Function }} options
 */
async function runScenario(options) {
  const { label, judgeMessage, proactive: overrides, verify } = options;
  console.log('\n场景：' + label);
  const mock = await startMockOneBot({ quiet: true });
  const disposers = [];
  const agents = new Map();
  const fakeWorkspaces = new Map();
  // 抓 proactive 的定时器：首次检查 = intervalMinutes*60000/2，远大于阈值。
  const proactiveTimers = [];
  const stats = { speakCalls: 0, prompts: [] };
  // 模拟插件 fiber 已经卸载：此时 ctx.timeout 会抛 INACTIVE（真 cordis 的 assertActive）。
  let timerBroken = false;
  // 只看本场景这段日志：上一个场景的「OneBot 已连接」「no-cjk」不能算数。
  const logStart = logLines.length;
  const logs = () => logLines.slice(logStart);
  const waitFor = async (fn, timeoutMs, what) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > deadline) {
        const tail = logs().slice(-8).map((line) => '  ' + line).join('\n');
        throw new Error('等待超时：' + what + '\n已发送 ' + mock.sent.length + ' 条\n最近日志：\n' + tail);
      }
      await sleep(50);
    }
  };
  const fakeWorkspaceRegistry = {
    async resolveByPath(p) { return fakeWorkspaces.get(p); },
    async create(p, title) { const ws = { id: 'ws-' + (fakeWorkspaces.size + 1), path: p, title }; fakeWorkspaces.set(p, ws); return ws; },
    async list() { return [...fakeWorkspaces.values()]; },
  };
  const fakeAgent = (sessionId) => ({ sessionId, options: { provider: '', model: '' }, async followup() {}, async whenIdle() {} });

  const ctx = {
    fiber: { marker: 'plugin-fiber' },
    inject(names, callback) {
      if (Array.isArray(names) && names.includes('settings')) callback({ effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return () => {}; }, settings: { configure() { return () => {}; } } });
      return () => {};
    },
    on() { return () => {}; },
    subprocess: {
      async resolveExecutable() { return process.execPath; },
      spawn(spec) {
      // 真服务内部要读 this（选容器模式），这里照做——桩要是完全不碰 this，
      // 「把方法裸传、丢了 this」这种接线错误就永远测不出来。
      // 曾经为此让线上适配器起不来、每 30 秒重试一次，而当时 148 项测试全绿。
      if (this === undefined || this === null || typeof this.resolveExecutable !== 'function') {
        throw new TypeError("Cannot read properties of undefined (reading 'selectContainmentMode')");
      }

        const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
        const done = new Promise((resolve) => child.on('close', (exitCode, signal) => resolve({ exitCode, signal })));
        return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, done, terminate() { try { child.kill('SIGTERM'); } catch { /* ignore */ } }, waitForExit: () => done.then(() => true), _child: child };
      },
    },
    reflect: { get(name) { return name === 'workspaceRegistry' ? fakeWorkspaceRegistry : undefined; } },
    workspaceRegistry: fakeWorkspaceRegistry,
    sessionController: {
      async create(request) { return { sessionId: request.sessionId }; },
      async resolveAgent(sessionId) { if (!agents.has(sessionId)) agents.set(sessionId, fakeAgent(sessionId)); return { agent: agents.get(sessionId) }; },
    },
    timeout(cb, delay) {
      if (Number(delay) >= 30000) {
        if (timerBroken === true) throw new Error('cannot get required service "timer" in inactive context');
        proactiveTimers.push({ cb, delay: Number(delay) });
        return () => {};
      }
      const t = setTimeout(cb, delay);
      return () => clearTimeout(t);
    },
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return () => {}; },
    tools: { register() { return () => {}; } },
    attachments: { async saveImage() { return { attachmentId: 'x', mediaType: 'image/png', bytes: 1, width: 0, height: 0 }; } },
    llm: {
      async resolveModelInfo(provider, model) { return { provider, model, inputModalities: ['text'] }; },
      async *stream(options) {
        const model = String(options.model ?? '');
        const promptText = (() => {
          const msg = Array.isArray(options.messages) && options.messages.length > 0 ? options.messages[0] : null;
          const part = msg !== null && Array.isArray(msg.content) && msg.content.length > 0 ? msg.content[0] : null;
          return part !== null && typeof part.text === 'string' ? part.text : '';
        })();
        stats.prompts.push({ model, text: promptText });
        if (model === 'judge-m') {
          yield { type: 'text-delta', index: 0, text: JSON.stringify({ speak: true, topic: '下午打球', message: judgeMessage }) };
          return;
        }
        stats.speakCalls += 1;
        // 发言阶段故意返回整句英文拒绝语：requireCjk 开着时应当被拦，然后回退到判断正文。
        yield { type: 'text-delta', index: 0, text: ENGLISH_REJECT };
      },
    },
  };

  try {
    const mod = await import(pathToFileURL(path.join(PKG_ROOT, 'lib', 'index.js')).href);
    const validated = mod.Config['~standard'].validate({
      onebot: { wsUrl: mock.wsUrl, httpUrl: mock.httpUrl },
      reply: { ackAfterMs: 0 },
      proactive: {
        enabled: true,
        groups: ['33333'],
        intervalMinutes: 5,
        windowMessages: 20,
        minNewMessages: 1,
        quietHours: [],
        maxPerHour: 5,
        maxPerDay: 20,
        minGapMinutes: 0,
        provider: 'mockp',
        model: 'judge-m',
        dryRun: false,
        verbose: true,
        maxChars: 120,
        ...(overrides === undefined ? {} : overrides),
      },
    });
    check('Config 校验通过', validated.issues === undefined, JSON.stringify(validated.issues));
    await mod.apply(ctx, validated.value);
    await waitFor(() => mock.clientCount() === 1, 10000, '适配器连上假 OneBot');
    await waitFor(() => logs().some((l) => l.includes('OneBot 已连接')), 20000, 'OneBot 已连接');
    check('适配器已连接且 OneBot 就绪', mock.clientCount() === 1 && logs().some((l) => l.includes('OneBot 已连接')));
    check('抓到了主动发言定时器', proactiveTimers.length >= 1, String(proactiveTimers.length));
    // 适配器重启（restart）也走同一个 ctx.timeout：混进来就会让下面「手动触发」打到错的东西。
    check('只抓到 1 条主动发言定时器', proactiveTimers.length === 1, String(proactiveTimers.length));

    // 造一段「有三人、最新一条是问题、时间新鲜」的群聊，绕开事件闸的各种跳过条件。
    const nowSec = Math.floor(Date.now() / 1000);
    const chat = [
      [30001, '阿七', '下午有人打球吗', 300],
      [30002, '小满', '我去，不过得三点后', 240],
      [30003, '路人', '我也想去，场地订了吗', 180],
      [30001, '阿七', '还没订，人够就订', 120],
      [30002, '小满', '那我来订，你们几点到', 60],
    ];
    for (const [index, [uid, nick, text, ago]] of chat.entries()) {
      mock.history.push({
        message_id: 900000 + index + 1, time: nowSec - ago, message_type: 'group', group_id: 33333,
        user_id: uid, sender: { user_id: uid, nickname: nick, card: '' },
        message: [{ type: 'text', data: { text } }], raw_message: text,
      });
    }

    // 手动触发那一轮检查（不用真的等三分钟）。
    const best = proactiveTimers.slice().sort((a, b) => b.delay - a.delay)[0];
    const tick = best.cb;
    // 让 tick 结束后的「排下一轮」撞上已卸载的定时器服务（B1 的回归点）。
    if (options.breakTimer === true) timerBroken = true;
    await tick();
    await verify({ mock, stats, logs, waitFor });
  } catch (error) {
    // 抛异常（多半是等待超时）也要记一条失败：只加 failures 会让汇总出现「N/N 项通过」却判失败。
    check('整个场景没有抛异常', false, error && error.message ? error.message : String(error));
    console.log('\n错误：' + (error && error.stack ? error.stack : String(error)));
  } finally {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
    await sleep(400);
    await mock.close();
  }
}

// 顺序跑：上一个场景的清理（disposers → 适配器退出 → mock.close）做完，下一个才开新的 mock。
for (const scenario of [
  {
    label: '两段式：发言模型两次回英文拒绝语 → 拦截 → 回退判断正文 → 发出',
    judgeMessage: JUDGE_TEXT,
    // 两段式要求 provider + model 成对（provider 留空 = 跟随判断阶段，不启用）；兜底开关控制发言阶段的校验。
    proactive: { speakProvider: 'speak-p', speakModel: 'speak-m', speakFallback: true, requireCjk: true },
    async verify({ mock, stats, logs, waitFor }) {
      const sentGroup = await waitFor(() => mock.sent.find((s) => Number(s.group_id) === 33333 || Number(s.target_id) === 33333), 20000, '主动发言发送');
      const text = textOf({ message: sentGroup.message });
      check('发言阶段正好试了 2 次（attempts 改了这里会挂）', stats.speakCalls === 2, 'speakCalls=' + stats.speakCalls);
      // 摘要方向：旧→新。排序被删掉时这条会挂（此前只有纯函数测试，端到端漏了）。
      const judgePrompt = stats.prompts.find((item) => item.model === 'judge-m');
      const promptText = judgePrompt === undefined ? '' : judgePrompt.text;
      const oldAt = promptText.indexOf('下午有人打球吗');
      const newAt = promptText.indexOf('那我来订');
      check('判断提示词里的摘要按旧→新排列', oldAt >= 0 && newAt > oldAt, 'old@' + oldAt + ' new@' + newAt);
      check('英文拒绝语没有被发出去', !/^Sorry,/i.test(text), JSON.stringify(text.slice(0, 40)));
      check('回退到了判断阶段的正文', text.includes('老地方'), JSON.stringify(text));
      check('verbose 日志记录了 no-cjk 拦截', logs().some((l) => l.includes('no-cjk')), 'logLines=' + logs().length);
    },
  },
  {
    label: '单段式：判断正文就是整句英文拒绝语 → 拦截 → 一条都不发',
    judgeMessage: ENGLISH_REJECT,
    // 不设 speakProvider/speakModel = 单段模式；requireCjk 必须把判断阶段那句英文拦在发送之前。
    proactive: { requireCjk: true },
    async verify({ mock, stats, logs }) {
      // tick 已经把整轮检查 await 完了，再留一点余量给适配器的 HTTP 往返，避免「刚好还没写进去」。
      await sleep(300);
      check('单段兜底：英文拒绝语一条都没发出去', mock.sent.length === 0, 'sent=' + mock.sent.length);
      check('单段兜底：发言模型一次也没有调用（没配 speakModel）', stats.speakCalls === 0, 'speakCalls=' + stats.speakCalls);
      check('日志记录了「内容被拦（no-cjk）」', logs().some((l) => l.includes('内容被拦（no-cjk）')), 'logLines=' + logs().length);
    },
  },
  {
    label: '反向对照：同一句英文在 requireCjk 关掉时会被发出去',
    judgeMessage: ENGLISH_REJECT,
    // 关掉兜底 → 同一句英文直接发：证明上面那条拦截确实是 requireCjk 干的，而不是别的校验碰巧拦住。
    proactive: { requireCjk: false },
    async verify({ mock, waitFor }) {
      const sentGroup = await waitFor(() => mock.sent.find((s) => Number(s.group_id) === 33333 || Number(s.target_id) === 33333), 20000, '主动发言发送');
      const text = textOf({ message: sentGroup.message });
      check('反向对照：requireCjk 关掉后英文被发出去了（且只发一条）', mock.sent.length === 1, 'sent=' + mock.sent.length);
      check('反向对照：发出去的正是判断阶段那句英文', /^Sorry,/.test(text), JSON.stringify(text.slice(0, 40)));
    },
  },
  {
    label: '两段式关掉兜底：发言模型两次回英文 → 一条都不发（不回退）',
    judgeMessage: JUDGE_TEXT,
    // speakFallback:false 时发言阶段全军覆没就该闭嘴；此前没有用例，把它改成恒 true 也不会挂。
    proactive: { speakProvider: 'speak-p', speakModel: 'speak-m', speakFallback: false, requireCjk: true },
    async verify({ mock, stats, logs }) {
      await sleep(300);
      check('关掉兜底：发言阶段仍旧试了 2 次', stats.speakCalls === 2, 'speakCalls=' + stats.speakCalls);
      check('关掉兜底：一条都没有发出去', mock.sent.length === 0, 'sent=' + mock.sent.length);
      check('关掉兜底：没有走回退分支', !logs().some((line) => line.includes('回退用判断模型给的正文')));
    },
  },
  {
    label: '卸载竞态：tick 回来时定时器服务已不可用（B1 回归点）',
    judgeMessage: JUDGE_TEXT,
    proactive: {},
    // 让 tick 结束后的「排下一轮」抛 INACTIVE：以前这个异常会变成 unhandled rejection，
    // timer 回调丢弃返回值，Node 24 直接 exit 1——插件重挂/升级就能带崩整个宿主。
    breakTimer: true,
    async verify({ logs }) {
      await sleep(200);
      check('排不了下一轮时只记一行日志，不把异常抛进进程', logs().some((line) => line.includes('不再排下一轮')), 'logLines=' + logs().length);
      check('进程还活着（能跑到这一行就说明没有 unhandled rejection）', true);
    },
  },
]) {
  await runScenario(scenario);
}

if (createdLink) { try { if (process.platform === 'win32') fs.rmdirSync(linkPath); else fs.unlinkSync(linkPath); } catch { /* ignore */ } }

const passed = results.filter(Boolean).length;
console.log('\n' + passed + '/' + results.length + ' 项通过');
if (failures > 0) { console.log('主动发言回合自测失败'); process.exit(1); }
console.log('主动发言回合自测通过');
process.exit(0);
