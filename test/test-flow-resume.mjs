#!/usr/bin/env node
/**
 * 授权续跑自测：`node test/test-flow-resume.mjs`
 *
 * 守的是一条**跨模块**的链：
 *   `/auth <6位>` → handleAuthMessage → resumeAfterAuth → `getRunTurn()(entry, frame, …)`
 * 它一头在 `gateway/auth-flow.js`，另一头在 `gateway/turn-runtime.js`，中间靠
 * `plugin.js` 注入的 `getRunTurn: () => turnRuntime.runTurn` 连接。
 *
 * 这条链曾经断过一次：turn-runtime 的工厂没把 `runTurn` 导出，`getRunTurn()` 取到
 * undefined，调用它抛 TypeError，又被链末尾的 `.catch` 吞成一行「授权后续跑失败」——
 * 用户侧表现为动态码用掉了、被拦下的任务再也没继续，而测试集当时一条用例都没覆盖到。
 * 所以这里既验行为，也验**接线形状**（第 2 节），后者才是能提前拦住同类问题的那个。
 */
import { readFileSync } from 'node:fs';
import { createTurnRuntime } from '../lib/gateway/turn-runtime.js';
import { createAuthFlow } from '../lib/gateway/auth-flow.js';
import { buildPersonaHint } from '../lib/gateway/turn-text.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail === '' ? '' : ' — ' + detail)); }
}

// 工厂只需要「能把函数建出来」；真正用到的依赖都在具体调用点，这里一律给桩。
const anyDeps = () => new Proxy({}, { get: () => () => undefined });

console.log('1. turn-runtime 工厂必须导出 runTurn');
{
  const rt = createTurnRuntime(anyDeps());
  check('导出 acceptMessage', typeof rt.acceptMessage === 'function');
  check('导出 scheduleImageSweep', typeof rt.scheduleImageSweep === 'function');
  check('导出 runTurn（授权续跑靠它）', typeof rt.runTurn === 'function', '实际：' + typeof rt.runTurn);
}

console.log('2. 接线形状：plugin.js 取用的每个属性都得真的存在');
{
  // 这一节直接对着接线处验：插件写 `turnRuntime.xxx`，工厂就必须把 xxx 导出来。
  // 漏一个键不会报错，只会变成 undefined 调用——正是上面那次故障的形状。
  const source = readFileSync(new URL('../lib/gateway/plugin.js', import.meta.url), 'utf8');
  const used = [...new Set([...source.matchAll(/\bturnRuntime\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))];
  check('插件里确实有对 turnRuntime 的取用（守卫本身没有失效）', used.length > 0, used.join(','));
  const rt = createTurnRuntime(anyDeps());
  const missing = used.filter((name) => !(name in rt));
  check('plugin.js 取的每个 turnRuntime 属性都已导出', missing.length === 0, '缺少：' + missing.join(','));
  check('plugin.js 的 getRunTurn 接的就是 runTurn', /getRunTurn:\s*\(\)\s*=>\s*turnRuntime\.runTurn/.test(source));
}

console.log('3. 续跑链端到端（真实 auth-flow + 真实工厂产物）');
{
  const state = { flow: { resume: null, active: '' }, stats: { errors: 0 } };
  const makeDeps = (getRunTurn) => new Proxy({
    TAG: '[test] ',
    getState: () => state,
    getConfig: () => ({ admin: { prefix: '/' }, auth: { owners: ['1'], superAdmins: [], grantTtlMinutes: 60 }, flow: { enabled: true } }),
    describeError: (error) => String(error && error.message ? error.message : error),
    getRunTurn,
    getDeliverFlowArtifacts: () => () => Promise.resolve(),
  }, { get: (target, key) => (key in target ? target[key] : () => undefined) });

  // 3a：接线取到的是真函数（本次故障的精确复现点）
  const rt = createTurnRuntime(anyDeps());
  const wired = makeDeps(() => rt.runTurn);
  const wiredFlow = createAuthFlow(wired);
  // 照 plugin.js 的写法取一次：`() => turnRuntime.runTurn`，再调用，必须拿到函数。
  const wiredGetRunTurn = () => rt.runTurn;
  check('真实工厂 → 接线 → getRunTurn() 是函数', typeof wiredGetRunTurn() === 'function', '实际：' + typeof wiredGetRunTurn());
  wiredFlow.resumeAfterAuth(); // 没有 pending，应当安静返回
  check('没有 pending 时安静返回（不抛错、不记错）', state.stats.errors === 0 && state.flow.resume === null);

  // 3b：有 pending 时，runTurn 被调用并且参数原样传下去
  const calls = [];
  const spyDeps = makeDeps(() => (entry, frame, prompt, generation, allowDsh, quoteReply, speaker) => {
    calls.push({ entry, frame, prompt, generation, allowDsh, quoteReply, speaker });
    return Promise.resolve();
  });
  const flow = createAuthFlow(spyDeps);
  const entry = { queue: Promise.resolve(), generation: 7 };
  const frame = { group_id: '1', user_id: '2' };
  state.flow.resume = { entry, frame, speaker: null };
  flow.resumeAfterAuth();
  await entry.queue;
  check('runTurn 被调用一次', calls.length === 1, '实际 ' + calls.length);
  check('entry / frame 原样传回', calls[0] && calls[0].entry === entry && calls[0].frame === frame);
  check('generation 沿用 entry.generation', calls[0] && calls[0].generation === 7);
  check('allowDsh=true、quoteReply=false', calls[0] && calls[0].allowDsh === true && calls[0].quoteReply === false);
  check('提示词要求直接重试那个工具', Boolean(calls[0] && calls[0].prompt.includes('已完成流程授权') && calls[0].prompt.includes('不要重复申请授权')));
  check('resume 用完即清', state.flow.resume === null);
  check('续跑成功不记错误', state.stats.errors === 0);

  // 3c：反向证明——把 getRunTurn 退化成 undefined（= 这次的真实故障），链路会**静默**失败。
  // 这一条是给未来的自己看的：它不报错、不抛到用户面前，只悄悄少跑一个回合。
  const savedError = console.error;
  const logged = [];
  console.error = (line) => logged.push(String(line));
  const brokenFlow = createAuthFlow(makeDeps(() => undefined));
  const entry2 = { queue: Promise.resolve(), generation: 1 };
  state.flow.resume = { entry: entry2, frame, speaker: null };
  state.stats.errors = 0;
  brokenFlow.resumeAfterAuth();
  await entry2.queue;
  console.error = savedError;
  check('runTurn 缺失时回合不会续上（静默失败）', state.stats.errors === 1);
  check('只打一行日志、不惊动用户', logged.length === 1 && logged[0].includes('授权后续跑失败'), logged.join(' | '));
}


console.log('6. 输出风格系统提示：挂成 agent 级 section，只作用于本插件的 QQ 会话');
{
  const makeAgent = () => ({ ctx: { sections: [], sp: { section(spec) { this.calls = (this.calls || 0) + 1; this.last = spec; }, } } });
  const makeSp = (agent) => {
    agent.ctx.sp.section = (spec) => { agent.ctx.sections.push(spec); };
    return agent.ctx.sp;
  };
  const runtime = createTurnRuntime({
    TAG: '[test]', getConfig: () => ({ verbose: false, reply: { stylePrompt: '输出纯文本，不要 Markdown' } }),
    ctx: { get: () => undefined }, getState: () => ({}), describeError: (e) => String(e && e.message ? e.message : e),
  });
  const agent = makeAgent();
  agent.ctx.get = (name) => (name === 'systemPrompt' ? makeSp(agent) : undefined);
  runtime.ensureStyleSection(agent);
  runtime.ensureStyleSection(agent);
  check('只注册一次（重复调用不重复挂段）', agent.ctx.sections.length === 1, String(agent.ctx.sections.length));
  const spec = agent.ctx.sections[0] || {};
  check('段落名固定 qq:output-style', spec.name === 'qq:output-style', String(spec.name));
  check('不开模板插值（避免 {{}} 被解析）', spec.interpolate === false, String(spec.interpolate));
  check('段落序在人格之后、工具说明之前', spec.order === 100, String(spec.order));
  check('文本来自 reply.stylePrompt', spec.text === '输出纯文本，不要 Markdown', String(spec.text).slice(0, 24));

  const emptyRuntime = createTurnRuntime({
    TAG: '[test]', getConfig: () => ({ verbose: false, reply: { stylePrompt: '' } }),
    ctx: { get: () => undefined }, getState: () => ({}), describeError: String,
  });
  const agent2 = makeAgent();
  agent2.ctx.get = (name) => (name === 'systemPrompt' ? makeSp(agent2) : undefined);
  emptyRuntime.ensureStyleSection(agent2);
  check('stylePrompt 留空就不注入（complete 人格 preset 下的退路）', agent2.ctx.sections.length === 0, String(agent2.ctx.sections.length));

  const agent3 = makeAgent();
  agent3.ctx.get = () => undefined;
  runtime.ensureStyleSection(agent3);
  check('没有 systemPrompt 服务时静默跳过', agent3.ctx.sections.length === 0);

  const agent4 = { ctx: { get() { throw new Error('boom'); } } };
  let threw = false;
  try { runtime.ensureStyleSection(agent4); } catch (error) { threw = true; }
  check('注册失败不把异常抛给回合', threw === false);
}

console.log('6b. 图片提示：同样的 agent 级 section，可与风格段共存');
{
  const makeAgent = () => ({ ctx: { sections: [] } });
  const wire = (agent) => {
    agent.ctx.systemPrompt = { section(spec) { agent.ctx.sections.push(spec); } };
    agent.ctx.get = (name) => (name === 'systemPrompt' ? agent.ctx.systemPrompt : undefined);
    return agent;
  };
  const runtime = createTurnRuntime({
    TAG: '[test]',
    getConfig: () => ({ verbose: false, reply: { stylePrompt: '风格', imageHint: '图片提示' } }),
    ctx: { get: () => undefined }, getState: () => ({}), describeError: String,
  });
  const agent = wire(makeAgent());
  check('图片提示挂上（返回 true）', runtime.ensureImageHintSection(agent) === true);
  check('段名固定 qq:image-hint', agent.ctx.sections[0].name === 'qq:image-hint', String(agent.ctx.sections[0].name));
  check('图片提示排在风格之后（order 200）', agent.ctx.sections[0].order === 200, String(agent.ctx.sections[0].order));
  check('两段可共存、互不影响', runtime.ensureStyleSection(agent) === true && agent.ctx.sections.length === 2,
    JSON.stringify(agent.ctx.sections.map((s) => s.name)));
  check('同一段重复调用不重复挂', runtime.ensureImageHintSection(agent) === true && agent.ctx.sections.length === 2);

  const runtime2 = createTurnRuntime({
    TAG: '[test]', getConfig: () => ({ verbose: false, reply: { stylePrompt: '风格', imageHint: '' } }),
    ctx: { get: () => undefined }, getState: () => ({}), describeError: String,
  });
  const agent2 = wire(makeAgent());
  check('imageHint 留空就不挂（消息内文本兜底）', runtime2.ensureImageHintSection(agent2) === false, String(agent2.ctx.sections.length));

  const agent3 = { ctx: { get: () => undefined } };
  check('没有 systemPrompt 服务时返回 false，由消息内文本兜底', runtime.ensureImageHintSection(agent3) === false);
}

console.log('6c. 人格段：同一套 attachAgentSection，排在风格之前');
{
  const makeAgent = () => ({ ctx: { sections: [] } });
  const wire = (agent) => {
    agent.ctx.systemPrompt = { section(spec) { agent.ctx.sections.push(spec); } };
    agent.ctx.get = (name) => (name === 'systemPrompt' ? agent.ctx.systemPrompt : undefined);
    return agent;
  };
  const makeRuntime = (persona) => createTurnRuntime({
    TAG: '[test]',
    getConfig: () => ({ verbose: false, persona, reply: { stylePrompt: '', imageHint: '' } }),
    ctx: { get: () => undefined }, getState: () => ({}), describeError: String, buildPersonaHint,
  });
  const runtime = makeRuntime({ enabled: true, name: '小助手', text: '说话简短' });
  const agent = wire(makeAgent());
  check('人格段挂上（返回 true）', runtime.ensurePersonaSection(agent) === true);
  check('段名固定 qq:persona', agent.ctx.sections[0].name === 'qq:persona', String(agent.ctx.sections[0].name));
  check('人格排在风格之前（order 90）', agent.ctx.sections[0].order === 90, String(agent.ctx.sections[0].order));
  check('文本沿用 buildPersonaHint 的渲染', agent.ctx.sections[0].text.includes('你是小助手'), String(agent.ctx.sections[0].text).slice(0, 40));

  const offRuntime = makeRuntime({ enabled: false, name: '小助手', text: '说话简短' });
  const agent2 = wire(makeAgent());
  check('persona.enabled=false 就不挂', offRuntime.ensurePersonaSection(agent2) === false, String(agent2.ctx.sections.length));

  const emptyRuntime = makeRuntime({ enabled: true, name: '', text: '' });
  const agent3 = wire(makeAgent());
  check('名字与设定都空就不挂', emptyRuntime.ensurePersonaSection(agent3) === false);

  const noService = { ctx: { get: () => undefined } };
  check('没有 systemPrompt 服务时返回 false，由首轮消息兜底', runtime.ensurePersonaSection(noService) === false);
}

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail > 0) process.exitCode = 1;
