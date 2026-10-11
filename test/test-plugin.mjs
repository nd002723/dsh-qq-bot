#!/usr/bin/env node
/**
 * 打包后插件的独立验证：不需要 DSH，不需要 QQ。
 *
 *   node test-plugin.mjs
 *
 * 用假的 ctx（实现 subprocess / sessionController / timer / effect / tools）
 * 直接加载真正的 lib/index.js，配一个真的假 OneBot 服务，跑完整链路：
 *
 *   假 QQ 消息 -> 假 OneBot -> 真适配器 -> 真插件 -> 假 Agent -> 回复 -> 真适配器 -> 假 OneBot
 *
 * 顺带验证 defineTool 能接受我们的参数 DSL，以及 ctx.tools.register 被调用。
 * 注：@deepseek-ai/dsh-tools 在未安装到 profile 时解析不到，脚本会临时建一个
 * node_modules 软链来模拟安装后的位置，结束后删除。
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
// 装到 DSH profile 之后，@deepseek-ai/dsh-tools 由 DSH 运行时解析。这里允许用
// DSH_PROFILE_MODULES 显式指向 profile 的 node_modules 来复现那种布局；
// 解析不到就跳过依赖宿主服务的断言（裸克隆照样跑）。
const PROFILE_MODULES = process.env.DSH_PROFILE_MODULES
  ?? path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'profiles', 'node_modules');

let failures = 0;
const results = [];
function check(name2, ok, detail = '') {
  results.push(ok);
  if (!ok) failures += 1;
  console.log('  [' + (ok ? 'PASS' : 'FAIL') + '] ' + name2 + (ok || detail === '' ? '' : ' — ' + detail));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('等待超时：' + label);
    await sleep(50);
  }
}

// ---- 临时软链：模拟「装进 profile 之后」的解析位置 ----
const linkPath = path.join(PKG_ROOT, 'node_modules');
let createdLink = false;
if (!fs.existsSync(linkPath) && fs.existsSync(PROFILE_MODULES)) {
  fs.symlinkSync(PROFILE_MODULES, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  createdLink = true;
}
// 插件现在静态 import @deepseek-ai/schemastery（Config schema 必需）。
try { await import.meta.resolve('@deepseek-ai/schemastery'); }
catch {
  console.log('缺少 @deepseek-ai/schemastery —— 请先在本目录执行 npm install / pnpm install。');
  process.exit(2);
}

// 工具注册需要 @deepseek-ai/dsh-tools（只在 DSH 部署里可解析）。裸克隆下跳过相关断言，
// 其余断言照常运行，这样 npm test 在没装 DSH 的机器上也是绿的。
let hasDshTools = true;
try { await import.meta.resolve("@deepseek-ai/dsh-tools"); } catch { hasDshTools = false; }
if (!hasDshTools) console.log("提示：解析不到 @deepseek-ai/dsh-tools，将跳过工具注册断言（适配器/路由断言不受影响）");

// 插件用 console.log / console.error 汇报状态；抓下来做行为断言（适配器是否重启）。
const logLines = [];
const realLog = console.log;
const realErr = console.error;
console.log = (...args) => { logLines.push(args.map(String).join(' ')); realLog(...args); };
console.error = (...args) => { logLines.push(args.map(String).join(' ')); realErr(...args); };

const mock = await startMockOneBot({ quiet: true });
console.log('假 OneBot：http=' + mock.httpUrl + ' ws=' + mock.wsUrl);

// ---- 假 ctx ----
const disposers = [];
const registeredTools = [];
const createdSessions = [];
const agents = new Map();
// 工作区 mock：让插件走「会话 attach 到 QQ_msg 分组」的路径。
const fakeWorkspaces = new Map();
const fakeWorkspaceRegistry = {
  async resolveByPath(p) { return fakeWorkspaces.get(p); },
  async create(p, title) {
    const ws = { id: 'ws-' + (fakeWorkspaces.size + 1), path: p, title };
    fakeWorkspaces.set(p, ws);
    return ws;
  },
};

function fakeAgent(sessionId) {
  const messages = [];
  let pending = [];
  let busy = false;
  const agent = {
    id: sessionId,
    guards: [],
    ctx: { tools: { guard(fn) { agent.guards.push(fn); return () => { const i = agent.guards.indexOf(fn); if (i >= 0) agent.guards.splice(i, 1); }; } } },
    status: 'idle',
    session: {
      get seq() { return messages.length; },
      deriveMessages: () => messages.slice(),
      snapshotEvents: () => [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }],
    },
    followup(message) {
      busy = true;
      agent.status = 'running';
      messages.push({ id: message.id, role: 'user', content: message.content, source: message.source });
      const replyText = 'REPLY:' + message.content[0].text;
      setTimeout(() => {
        messages.push({ id: 'asst-' + messages.length, role: 'assistant', content: [{ type: 'text', text: replyText }], source: { kind: 'model' } });
        busy = false;
        agent.status = 'idle';
        const waiters = pending; pending = [];
        for (const w of waiters) w();
      }, 40);
    },
    async whenIdle() { if (!busy) return; await new Promise((r) => pending.push(r)); },
    cancel() { busy = false; },
  };
  return agent;
}

// 设置服务桩（DSH ≥ 0.1.7 契约）：插件不再自己 register 命名空间 —— 那个 API 在
// 0.1.7 被删掉了。现在 DSH 直接拿插件导出的 schemastery Config 当表单来源，插件只需
// 声明「设置页由我自带的选项卡负责」（configure({auto:false})）。
const configuredSettings = [];
const settingsStub = {
  configure(presentation, owner) {
    configuredSettings.push({ presentation, owner });
    return () => {};
  },
};

// loader/volatile-update 的监听者：cordis-plugin-loader 在 volatile 字段变化时就地
// 更新运行中 fiber 的引用并触发它，不重挂插件。
const volatileUpdateHandlers = [];

const ctx = {
  fiber: { marker: 'plugin-fiber' },
  inject(names, callback) {
    if (Array.isArray(names) && names.includes('settings')) {
      callback({
        effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return () => {}; },
        settings: settingsStub,
      });
    }
    return () => {};
  },
  on(event, handler) {
    if (event === 'loader/volatile-update') volatileUpdateHandlers.push(handler);
    return () => {};
  },
  subprocess: {
    async resolveExecutable() { return process.execPath; },
    spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      const done = new Promise((resolve) => child.on('close', (exitCode, signal) => resolve({ exitCode, signal })));
      return {
        stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, done,
        terminate() { try { child.kill('SIGTERM'); } catch { /* ignore */ } },
        waitForExit: () => done.then(() => true),
        _child: child,
      };
    },
  },
  // Cordis 的 ctx.<服务> 需要 inject；ctx.reflect.get(name) 是免注入读服务。
  reflect: {
    get(name) { return name === 'workspaceRegistry' ? fakeWorkspaceRegistry : undefined; },
  },
  workspaceRegistry: fakeWorkspaceRegistry,
  sessionController: {
    async create(request) { createdSessions.push(request); return { sessionId: request.sessionId }; },
    async resolveAgent(sessionId) {
      if (!agents.has(sessionId)) agents.set(sessionId, fakeAgent(sessionId));
      return { agent: agents.get(sessionId) };
    },
  },
  timeout(cb, delay) { const t = setTimeout(cb, delay); return () => clearTimeout(t); },
  effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return () => {}; },
  tools: { register(tool) { registeredTools.push(tool); return () => {}; } },
  // 图片视觉桩：saveImage 返回假 ref；resolveModelInfo 返回能力；stream 产出识别文本。
  attachments: {
    async saveImage({ data, mediaType }) {
      return { attachmentId: 'test-img-' + (visionRefs.length + 1), mediaType, bytes: data, width: 0, height: 0 };
    },
  },
  llm: {
    async resolveModelInfo(provider, model) {
      visionCalls.push({ kind: 'resolve', provider, model });
      if (visionModelModalities !== null) return { provider, model, inputModalities: visionModelModalities };
      throw new Error('no such model');
    },
    async *stream(options) {
      visionCalls.push({ kind: 'stream', provider: options.provider, model: options.model });
      yield { type: 'text-delta', index: 0, text: '【视觉识别】画面里是一只白猫' };
      yield { type: 'text-delta', index: 0, text: '，坐在窗台上。' };
    },
  },
};
const visionRefs = [];
const visionCalls = [];
let visionModelModalities = null;

try {
  const mod = await import(pathToFileURL(path.join(PKG_ROOT, 'lib', 'index.js')).href);
  check('模块导出了 name/inject/apply', mod.name === 'dsh-qq-bot' && Array.isArray(mod.inject) && typeof mod.apply === 'function');
  check('inject 声明了 subprocess/sessionController/timer',
    mod.inject.includes('subprocess') && mod.inject.includes('sessionController') && mod.inject.includes('timer'));
  check('inject 声明了 attachments/llm（图片视觉依赖）',
    mod.inject.includes('attachments') && mod.inject.includes('llm'));


  console.log('\n1. 加载插件（正向 WS 连假 OneBot）');
  // 按 Cordis 的做法求值配置：Config['~standard'].validate(raw)，volatile 字段变成引用。
  const validated = mod.Config['~standard'].validate({
    onebot: { wsUrl: mock.wsUrl, httpUrl: mock.httpUrl },
    reply: { ackAfterMs: 0 },
    vision: { enabled: true, provider: 'mock-provider', model: 'vision-exp' },
  });
  check('Config.validate 没有 issues', validated.issues === undefined, JSON.stringify(validated.issues));
  const liveConfig = validated.value;

  await mod.apply(ctx, liveConfig);
  await waitFor(() => mock.clientCount() === 1, 10000, '适配器连上假 OneBot');
  check('适配器已连上假 OneBot', mock.clientCount() === 1);

  console.log('\n2. Host 配置契约（DSH ≥ 0.1.7：Config schema 取代 settings.register）');
  check('导出了 schemastery Config',
    Boolean(mod.Config) && mod.Config['~standard'] !== undefined && mod.Config['~standard'].vendor === 'schemastery',
    JSON.stringify(mod.Config && mod.Config['~standard'] && mod.Config['~standard'].vendor));
  check('配置默认值已解析（含 onebot/group/reply）',
    Boolean(liveConfig.onebot && liveConfig.group && liveConfig.reply));
  check('行配置覆盖了默认值',
    liveConfig.onebot.wsUrl.get() === mock.wsUrl && liveConfig.reply.ackAfterMs.get() === 0);
  check('声明了「设置页由本插件自带的选项卡负责」(auto:false)',
    configuredSettings.length === 1 && configuredSettings[0].presentation.auto === false
      && configuredSettings[0].owner === ctx.fiber,
    JSON.stringify(configuredSettings.map((c) => c.presentation)));

  // 设置页能不能出现、能不能保存，全看字段是不是 volatile：
  //   * dsh-settings 的 volatileForm() 只投影 volatile 字段（一个都没有 => 整个条目不出现）
  //   * write() 对非 volatile 路径直接抛 "Config field ... is not volatile"
  // 所以直接从 lib/client.js 里抠出 FIELDS 的 path 逐条核对，避免两边各写一份而漂移。
  const clientSource = fs.readFileSync(path.join(PKG_ROOT, 'lib', 'client.js'), 'utf-8');
  const fieldPaths = [];
  for (const match of clientSource.matchAll(/\{\s*path:\s*\[([^\]]+)\]/g)) {
    const parts = [...match[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
    if (parts.length > 0) fieldPaths.push(parts);
  }
  check('从 client.js 抠出了表单字段', fieldPaths.length >= 30, String(fieldPaths.length));

  const isVolatilePath = (schema, p) => {
    if (schema.meta !== undefined && schema.meta.volatile) return true;
    const [key, ...rest] = p;
    const child = key === undefined ? undefined : (schema.dict === undefined ? {} : schema.dict)[key];
    return child !== undefined && isVolatilePath(child, rest);
  };
  const notVolatile = fieldPaths.filter((p) => !isVolatilePath(mod.Config, p)).map((p) => p.join('.'));
  check('设置页里的每个字段都是 volatile（否则保存会被拒）', notVolatile.length === 0, notVolatile.join(', '));

  const volatileForm = (schema) => {
    if (schema.meta !== undefined && schema.meta.volatile) return schema;
    if (schema.type === 'object') {
      const dict = {};
      for (const [key, child] of Object.entries(schema.dict === undefined ? {} : schema.dict)) {
        const field = volatileForm(child);
        if (field !== undefined) dict[key] = field;
      }
      return Object.keys(dict).length > 0 ? { type: 'object', dict } : undefined;
    }
    return undefined;
  };
  check('volatileForm(Config) 非空（否则设置页里根本不会出现这个条目）', volatileForm(mod.Config) !== undefined);

  check('accessToken 声明为 secret（值不下发到浏览器）',
    mod.Config.dict.onebot.dict.accessToken.meta.role === 'secret');
  check('内部字段不进设置页（restart / adapterPath / firstTurnHint 非 volatile）',
    !isVolatilePath(mod.Config, ['restart', 'baseMs'])
      && !isVolatilePath(mod.Config, ['adapterPath'])
      && !isVolatilePath(mod.Config, ['reply', 'firstTurnHint']));

  let schemaJson = null;
  try { schemaJson = mod.Config.toJSON(); JSON.stringify(schemaJson); } catch (error) { schemaJson = null; }
  check('Config.toJSON() 可 JSON 序列化（describe 需要）', schemaJson !== null && typeof schemaJson === 'object');
  check('工作目录配置项已移除（工作区自动管理）', liveConfig.workspace === undefined || liveConfig.workspace === null);

  console.log('\n2. 动态工具注册（走真的 defineTool）');
  const tool = registeredTools.find((t) => t.name === 'qqbot');
  if (hasDshTools !== true) {
    check('（跳过）工具注册需 @deepseek-ai/dsh-tools；路由/回复断言不受影响', true);
  } else {
    check('注册了 qqbot + qqgroup 两个工具', registeredTools.length === 2, String(registeredTools.length));
    check('工具名分别是 qqbot / qqgroup',
      registeredTools.map((t) => t.name).sort().join(',') === 'qqbot,qqgroup',
      JSON.stringify(registeredTools.map((t) => t.name)));
    check('工具名是 qqbot', tool && tool.name === 'qqbot', String(tool && tool.name));
    check('defineTool 接受了参数 DSL（含 action）', Boolean(tool && tool.parameters && tool.parameters.properties && tool.parameters.properties.action),
      JSON.stringify(tool && tool.parameters));
  }

  console.log('\n3. 群消息 @机器人 -> Agent -> 回复回 QQ');
  await fetch(mock.httpUrl + '/__inject', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message_type: 'group', group_id: 33333, user_id: 22222, nickname: '小明',
      message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: '你好' } }],
    }),
  });
  const sent = await waitFor(() => (mock.sent.length > 0 ? mock.sent : null), 15000, '回复到达假 OneBot');
  check('回复用 send_group_msg 发出', sent[0].action === 'send_group_msg', String(sent[0].action));
  const replyText = sent[0].message[0].data.text;
  check('回复带上了 QQ 上下文头', replyText.startsWith('REPLY:[QQ群 33333 · 小明(22222)'), JSON.stringify(replyText.slice(0, 60)));
  check('上下文头带上了说话人身份（交给 Agent 判断）', replyText.includes('身份:'), JSON.stringify(replyText.slice(0, 60)));
  check('首轮追加了人格提示', replyText.includes('这是一次 QQ 聊天'), JSON.stringify(replyText.slice(0, 40)));
  check('会话通过 sessionController 创建', createdSessions.length === 1 && createdSessions[0].sessionId === 'qqbot-group-33333',
    JSON.stringify(createdSessions.map((s) => s.sessionId)));
  check('会话传了 workspaceId（自动归入 QQ_msg 分组）', typeof createdSessions[0].workspaceId === 'string' && createdSessions[0].workspaceId.startsWith('ws-'), JSON.stringify(createdSessions[0]));

  console.log('\n4. 群里没 @ 机器人 -> 忽略');
  const before = mock.sent.length;
  await fetch(mock.httpUrl + '/__inject', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message_type: 'group', group_id: 33333, user_id: 22222, text: '闲聊' }),
  });
  await sleep(1500);
  check('未 @ 的消息没有触发回复', mock.sent.length === before, String(mock.sent.length - before));

  console.log('\n4b. 图片视觉：模型支持时识别并入 Agent 输入');
  // 给 example.com 的图片 URL 装 fetch 桩（返回假 PNG），其余请求走真实 fetch。
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://example.com/cat.png')) {
      return {
        ok: true, status: 200,
        headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'image/png' : null) },
        arrayBuffer: async () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer,
      };
    }
    return realFetch(url, init);
  };
  visionModelModalities = ['text', 'image'];
  const sentBeforeVision = mock.sent.length;
  await fetch(mock.httpUrl + '/__inject', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message_type: 'group', group_id: 33333, user_id: 22222, nickname: '小明',
      message: [
        { type: 'at', data: { qq: '10000' } },
        { type: 'image', data: { url: 'https://example.com/cat.png' } },
        { type: 'text', data: { text: '看看这张图' } },
      ],
    }),
  });
  const visionSent = await waitFor(() => (mock.sent.length > sentBeforeVision ? mock.sent[mock.sent.length - 1] : null), 15000, '视觉回复到达假 OneBot');
  check('图片消息触发了回复', Boolean(visionSent), 'sent=' + mock.sent.length);
  const visionReply = visionSent.message[0].data.text;
  check('调用了 llm.resolveModelInfo + stream', visionCalls.some((c) => c.kind === 'resolve') && visionCalls.some((c) => c.kind === 'stream'),
    JSON.stringify(visionCalls));
  check('图片被注册成附件（saveImage 调用）', visionCalls.filter((c) => c.kind === 'stream').length === 1,
    String(visionCalls.filter((c) => c.kind === 'stream').length));
  check('识别文本并入了 Agent 输入', visionReply.includes('【视觉识别】画面里是一只白猫，坐在窗台上。'),
    JSON.stringify(visionReply.slice(0, 200)));

  console.log('\n4c. 图片视觉：模型不支持 -> 可读报错（不进入 Agent）');
  visionModelModalities = ['text'];
  const sentBeforeUnsupported = mock.sent.length;
  await fetch(mock.httpUrl + '/__inject', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message_type: 'group', group_id: 33333, user_id: 22222, nickname: '小明',
      message: [
        { type: 'at', data: { qq: '10000' } },
        { type: 'image', data: { url: 'https://example.com/cat.png' } },
        { type: 'text', data: { text: '看看这张图' } },
      ],
    }),
  });
  const unsupportedSent = await waitFor(() => (mock.sent.length > sentBeforeUnsupported ? mock.sent[mock.sent.length - 1] : null), 15000, '不支持报错到达假 OneBot');
  check('模型不支持时仍回复（可读报错）', Boolean(unsupportedSent), 'sent=' + mock.sent.length);
  const unsupportedReply = unsupportedSent.message[0].data.text;
  check('报错提示了切换模型', unsupportedReply.includes('不支持图片识别') && unsupportedReply.includes('图片视觉'),
    JSON.stringify(unsupportedReply.slice(0, 200)));
  check('未进入 Agent（没有识别流）', visionCalls.filter((c) => c.kind === 'stream').length === 1,
    String(visionCalls.filter((c) => c.kind === 'stream').length));

  console.log('\n5. 工具 status 动作');
  const status = hasDshTools === true ? await tool.execute({ action: 'status' }, {}) : null;
  if (status !== null) {
    check('status 报告已连接', status.connected === true);
    check('status 报告 1 个会话', status.conversations.length === 1, JSON.stringify(status.conversations));
    check('status 里有统计计数', status.stats.accepted >= 1 && status.stats.replies >= 1, JSON.stringify(status.stats));
  }
  if (status === null) check('（跳过）status 动作需要 dsh-tools', true);

  console.log('\n6. 配置热更新（volatile 就地更新 + loader/volatile-update）');
  const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');
  check('volatile 引用带共享写符号', typeof liveConfig.onebot.accessToken[VOLATILE_WRITE] === 'function');
  check('注册了 loader/volatile-update 监听', volatileUpdateHandlers.length === 1, String(volatileUpdateHandlers.length));

  const startsBefore = logLines.filter((line) => line.includes('适配器已启动')).length;
  // 模拟 loader：就地把新值写进引用，然后发事件（不重挂插件）
  liveConfig.onebot.accessToken[VOLATILE_WRITE]('fresh-token');
  for (const handler of volatileUpdateHandlers) handler([['onebot', 'accessToken']]);
  await waitFor(() => logLines.filter((line) => line.includes('适配器已启动')).length > startsBefore, 10000, '连接配置变化后重启适配器');
  check('连接配置变化 -> 重启适配器', logLines.filter((line) => line.includes('适配器已启动')).length > startsBefore);
  await sleep(700);
  check('重启后适配器重新连上假 OneBot', mock.clientCount() === 1, 'clients=' + mock.clientCount());

  const startsAfterTransport = logLines.filter((line) => line.includes('适配器已启动')).length;
  liveConfig.reply.maxChars[VOLATILE_WRITE](999);
  for (const handler of volatileUpdateHandlers) handler([['reply', 'maxChars']]);
  await sleep(900);
  check('非连接类改动不重启适配器',
    logLines.filter((line) => line.includes('适配器已启动')).length === startsAfterTransport,
    String(logLines.filter((line) => line.includes('适配器已启动')).length - startsAfterTransport));

  console.log('\n7. 卸载');
  for (const d of disposers) { try { d(); } catch (error) { console.log('  disposer 抛错：' + error.message); } }
  await sleep(600);
  check('卸载后适配器进程已终止', mock.clientCount() === 0, 'clients=' + mock.clientCount());
} catch (error) {
  failures += 1;
  console.log('\n错误：' + (error && error.stack ? error.stack : String(error)));
} finally {
  await mock.close();
  if (createdLink) {
    // 只删链接本身：对 junction 用 rmSync(recursive) 会把目标目录删空。
    try { if (process.platform === 'win32') fs.rmdirSync(linkPath); else fs.unlinkSync(linkPath); } catch { /* ignore */ }
  }
}

const passed = results.filter(Boolean).length;
console.log('\n' + passed + '/' + results.length + ' 项通过');
if (failures > 0) { console.log('插件自测失败'); process.exit(1); }
console.log('插件自测通过');
process.exit(0);
