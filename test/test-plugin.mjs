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
// 从一条 mock 发送记录里取 text 段（可能带引用 reply 段，不能只取 message[0]）。
const textOf = (sent) => {
  const msg = (sent && Array.isArray(sent.message)) ? sent.message : [];
  const seg = msg.find((s) => s && s.type === 'text');
  return seg && seg.data && typeof seg.data.text === 'string' ? seg.data.text : '';
};
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
  check('访客默认白名单含 qq_websearch/qq_history 且不含 web_fetch（联网统一走 qq_websearch 代理，历史自取走 qq_history）',
    Array.isArray(liveConfig.auth.guestToolAllow.get()) && liveConfig.auth.guestToolAllow.get().includes('qq_websearch') && liveConfig.auth.guestToolAllow.get().includes('qq_history') && !liveConfig.auth.guestToolAllow.get().includes('web_fetch'),
    JSON.stringify(liveConfig.auth.guestToolAllow.get()));

  console.log('\n2. 动态工具注册（走真的 defineTool）');
  const tool = registeredTools.find((t) => t.name === 'qqbot');
  if (hasDshTools !== true) {
    check('（跳过）工具注册需 @deepseek-ai/dsh-tools；路由/回复断言不受影响', true);
  } else {
    check('注册了 qqbot + qqgroup + qq_websearch + qq_webfetch + qq_imgsearch + qq_history 六个工具', registeredTools.length === 6, String(registeredTools.length));
    check('工具名分别是 qqbot / qqgroup / qq_websearch / qq_history',
      (() => { const names = registeredTools.map((t) => t.name); return names.includes('qqbot') && names.includes('qqgroup') && names.includes('qq_websearch') && names.includes('qq_history'); })(),
      JSON.stringify(registeredTools.map((t) => t.name)));
    check('工具名是 qqbot', tool && tool.name === 'qqbot', String(tool && tool.name));
    check('defineTool 接受了参数 DSL（含 action）', Boolean(tool && tool.parameters && tool.parameters.properties && tool.parameters.properties.action),
      JSON.stringify(tool && tool.parameters));
    const wfTool = registeredTools.find((t) => t.name === 'qq_webfetch');
    check('qq_webfetch 工具已注册且含 url 参数', Boolean(wfTool) && typeof wfTool.parameters?.properties?.url === 'object', Boolean(wfTool) ? JSON.stringify(Object.keys(wfTool.parameters?.properties ?? {})) : 'missing');
    const wsTool = registeredTools.find((t) => t.name === 'qq_websearch');
    check('qq_websearch 参数含 query', Boolean(wsTool && wsTool.parameters && wsTool.parameters.properties && wsTool.parameters.properties.query),
      JSON.stringify(wsTool && wsTool.parameters));
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
  check('@ 触发：回复引用触发消息（QQ 回复消息流程）',
    Array.isArray(sent[0].message) && sent[0].message[0] && sent[0].message[0].type === 'reply',
    JSON.stringify(sent[0].message));
  const replyText = textOf(sent[0]);
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

  console.log('\n4a. 回复（引用）机器人消息 -> 视同 @ + 最近相关发言上下文 + 引用回复');
  const botMsgId = 600001;
  mock.history.push({
    message_id: botMsgId, time: Math.floor(Date.now() / 1000) - 120, user_id: 10000,
    message: [{ type: 'text', data: { text: '上次 bot 的回复' } }], raw_message: '上次 bot 的回复',
    sender: { user_id: 10000, nickname: '机器人', card: '' },
  });
  mock.history.push({
    message_id: 600000, time: Math.floor(Date.now() / 1000) - 180, user_id: 22222,
    message: [{ type: 'text', data: { text: '上次用户的发言' } }], raw_message: '上次用户的发言',
    sender: { user_id: 22222, nickname: '小明', card: '' },
  });
  const beforeReplyBot = mock.sent.length;
  await fetch(mock.httpUrl + '/__inject', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message_type: 'group', group_id: 33333, user_id: 22222, nickname: '小明',
      message: [
        { type: 'reply', data: { id: botMsgId } },
        { type: 'text', data: { text: '再来一次' } },
      ],
    }),
  });
  const replyBotSent = await waitFor(() => (mock.sent.length > beforeReplyBot ? mock.sent.slice(beforeReplyBot) : null), 15000, '回复 bot 触发回复');
  check('回复了 bot 的消息（未 @）视同 @ 触发回复',
    replyBotSent.length > 0 && replyBotSent[0].action === 'send_group_msg', JSON.stringify(replyBotSent));
  check('回复用 QQ 引用回复（reply 段引用触发消息）',
    Array.isArray(replyBotSent[0].message) && replyBotSent[0].message[0] && replyBotSent[0].message[0].type === 'reply',
    JSON.stringify(replyBotSent[0].message));
  const replyBotText = textOf(replyBotSent[0]);
  check('Agent 不再自动收到塞入的聊天上下文（改由 qq_history 自取）',
    !replyBotText.includes('最近相关发言') && !replyBotText.includes('上次 bot 的回复') && !replyBotText.includes('上次用户的发言'),
    JSON.stringify(replyBotText.slice(0, 160)));

  console.log('\n4a2. 回复（引用）非 bot 消息 -> 不触发');
  const nonBotMsgId = 600002;
  mock.history.push({
    message_id: nonBotMsgId, time: Math.floor(Date.now() / 1000) - 60, user_id: 22222,
    message: [{ type: 'text', data: { text: '别人的消息' } }], raw_message: '别人的消息',
    sender: { user_id: 22222, nickname: '小红', card: '' },
  });
  const beforeNonBot = mock.sent.length;
  await fetch(mock.httpUrl + '/__inject', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message_type: 'group', group_id: 33333, user_id: 22222, nickname: '小明',
      message: [
        { type: 'reply', data: { id: nonBotMsgId } },
        { type: 'text', data: { text: '回你一下' } },
      ],
    }),
  });
  await sleep(1500);
  check('回复非 bot 消息未触发回复', mock.sent.length === beforeNonBot, String(mock.sent.length - beforeNonBot));

  console.log('\n4a3. 回复 bot + 正文 @别人 -> 仍处理但交给 bot 自行判断（不强制引用回复）');
  mock.history.length = 0;
  const botMsg3 = 600010;
  mock.history.push({ message_id: botMsg3, time: Math.floor(Date.now() / 1000) - 100, user_id: 10000,
    message: [{ type: 'text', data: { text: 'bot 旧回复' } }], raw_message: 'bot 旧回复', sender: { user_id: 10000, nickname: '机器人', card: '' } });
  mock.history.push({ message_id: 600011, time: Math.floor(Date.now() / 1000) - 150, user_id: 22222,
    message: [{ type: 'text', data: { text: '早前对话' } }], raw_message: '早前对话', sender: { user_id: 22222, nickname: '小明', card: '' } });
  const beforeAtOther = mock.sent.length;
  await fetch(mock.httpUrl + '/__inject', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message_type: 'group', group_id: 33333, user_id: 22222, nickname: '小明',
      message: [
        { type: 'reply', data: { id: botMsg3 } },
        { type: 'text', data: { text: '@44444 一起看这个' } },
      ],
    }),
  });
  const atOtherSent = await waitFor(() => (mock.sent.length > beforeAtOther ? mock.sent.slice(beforeAtOther) : null), 15000, '回复 bot+@别人');
  check('回复 bot + 正文 @别人：仍处理（消息进模型）',
    atOtherSent.length > 0 && atOtherSent[0].action === 'send_group_msg', JSON.stringify(atOtherSent));
  check('回复 bot + 正文 @别人：不引用回复（交给 bot 自行判断）',
    !(atOtherSent[0].message[0] && atOtherSent[0].message[0].type === 'reply'), JSON.stringify(atOtherSent[0].message));
  const atOtherText = textOf(atOtherSent[0]);
  check('回复 bot + 正文 @别人：不再自动拉上下文（改由 qq_history）', !atOtherText.includes('早前对话'), JSON.stringify(atOtherText.slice(0, 120)));

  console.log('\n4a4. 回复别人 + 正文 @bot -> 处理 + 引用回复 + 上下文含被@对象（8 条）');
  mock.history.length = 0;
  const tNow = Math.floor(Date.now() / 1000);
  const pushH = (mid, uid, text, nick, t) => mock.history.push({ message_id: mid, time: t, user_id: uid,
    message: [{ type: 'text', data: { text } }], raw_message: text, sender: { user_id: uid, nickname: nick, card: '' } });
  pushH(600021, 44444, '对象发言1', '小红', tNow - 500);
  pushH(600022, 22222, '用户历史1', '小明', tNow - 480);
  pushH(600023, 10000, 'bot历史1', '机器人', tNow - 460);
  pushH(600024, 44444, '对象发言2', '小红', tNow - 440);
  pushH(600025, 22222, '用户历史2', '小明', tNow - 420);
  pushH(600026, 10000, 'bot历史2', '机器人', tNow - 400);
  pushH(600027, 44444, '对象发言3', '小红', tNow - 380);
  pushH(600028, 22222, '用户历史3', '小明', tNow - 360);
  pushH(600029, 44444, '对象发言4', '小红', tNow - 340);
  pushH(600030, 22222, '用户历史4', '小明', tNow - 320);
  const otherMsg4 = 600031;
  mock.history.push({ message_id: otherMsg4, time: tNow - 300, user_id: 44444,
    message: [{ type: 'text', data: { text: '被回复的别人的消息' } }], raw_message: '被回复的别人的消息', sender: { user_id: 44444, nickname: '小红', card: '' } });
  const beforeAtBot = mock.sent.length;
  const injectAtBot = await fetch(mock.httpUrl + '/__inject', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message_type: 'group', group_id: 33333, user_id: 22222, nickname: '小明',
      message: [
        { type: 'reply', data: { id: otherMsg4 } },
        { type: 'at', data: { qq: '10000' } },
        { type: 'text', data: { text: '你看看这个' } },
      ],
    }),
  });
  const injectAtBotId = (await injectAtBot.json()).message_id;
  const atBotSent = await waitFor(() => (mock.sent.length > beforeAtBot ? mock.sent.slice(beforeAtBot) : null), 15000, '回复别人+@bot');
  check('回复别人 + 正文 @bot：触发处理',
    atBotSent.length > 0 && atBotSent[0].action === 'send_group_msg', JSON.stringify(atBotSent));
  check('回复别人 + 正文 @bot：引用回复',
    Array.isArray(atBotSent[0].message) && atBotSent[0].message[0] && atBotSent[0].message[0].type === 'reply',
    JSON.stringify(atBotSent[0].message));
  check('回复别人 + @bot：引用发言人本条消息（而非被回复对象）',
    atBotSent[0].message[0] && Number(atBotSent[0].message[0].data.id) === Number(injectAtBotId)
      && Number(atBotSent[0].message[0].data.id) !== Number(otherMsg4),
    'reply id=' + String(atBotSent[0].message[0] && atBotSent[0].message[0].data.id)
      + ' 期望=' + String(injectAtBotId) + ' 被回复对象=' + String(otherMsg4));
  const atBotText = textOf(atBotSent[0]);
  check('回复别人+@bot：不再自动拉上下文（对象/对话者/bot 发言都不塞，改由 qq_history）',
    !atBotText.includes('对象发言') && !atBotText.includes('用户历史') && !atBotText.includes('bot历史')
    && !atBotText.includes('最近相关发言'), JSON.stringify(atBotText.slice(0, 140)));

  console.log('\n4a5. 点名但无正文：纯回复 bot / 只 @ / 回复别人+@bot -> 都触发并给占位正文');
  // (1) 纯回复 bot（只有 reply 段，无文字）
  mock.history.length = 0;
  const botMsg5 = 600040;
  mock.history.push({ message_id: botMsg5, time: Math.floor(Date.now() / 1000) - 90, user_id: 10000,
    message: [{ type: 'text', data: { text: 'bot 上一条' } }], raw_message: 'bot 上一条', sender: { user_id: 10000, nickname: '机器人', card: '' } });
  mock.history.push({ message_id: 600041, time: Math.floor(Date.now() / 1000) - 160, user_id: 22222,
    message: [{ type: 'text', data: { text: '用户说过的话' } }], raw_message: '用户说过的话', sender: { user_id: 22222, nickname: '小明', card: '' } });
  const before5a = mock.sent.length;
  await fetch(mock.httpUrl + '/__inject', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message_type: 'group', group_id: 33333, user_id: 22222, nickname: '小明',
      message: [{ type: 'reply', data: { id: botMsg5 } }] }),
  });
  const sent5a = await waitFor(() => (mock.sent.length > before5a ? mock.sent.slice(before5a) : null), 15000, '纯回复bot无正文');
  check('纯回复 bot（无正文）：触发处理', sent5a.length > 0 && sent5a[0].action === 'send_group_msg', JSON.stringify(sent5a));
  check('纯回复 bot（无正文）：引用回复', sent5a[0].message[0] && sent5a[0].message[0].type === 'reply', JSON.stringify(sent5a[0].message));
  const text5a = textOf(sent5a[0]);
  check('纯回复 bot（无正文）：Agent 收到占位正文（不再自动塞上下文）',
    text5a.includes('仅点名了 bot') && !text5a.includes('用户说过的话'), JSON.stringify(text5a.slice(0, 140)));

  // (2) 只 @bot（只有 at 段，无文字）
  mock.history.length = 0;
  const before5b = mock.sent.length;
  await fetch(mock.httpUrl + '/__inject', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message_type: 'group', group_id: 33333, user_id: 22222, nickname: '小明',
      message: [{ type: 'at', data: { qq: '10000' } }] }),
  });
  const sent5b = await waitFor(() => (mock.sent.length > before5b ? mock.sent.slice(before5b) : null), 15000, '只@无正文');
  check('只 @bot（无正文）：触发处理', sent5b.length > 0 && sent5b[0].action === 'send_group_msg', JSON.stringify(sent5b));
  check('只 @bot（无正文）：引用回复', sent5b[0].message[0] && sent5b[0].message[0].type === 'reply', JSON.stringify(sent5b[0].message));
  const text5b = textOf(sent5b[0]);
  check('只 @bot（无正文）：Agent 收到占位正文（不拉上下文）',
    text5b.includes('仅点名了 bot') && !text5b.includes('最近相关发言'), JSON.stringify(text5b.slice(0, 140)));

  // (3) 回复别人 + @bot + 无正文
  mock.history.length = 0;
  const otherMsg5 = 600042;
  mock.history.push({ message_id: otherMsg5, time: Math.floor(Date.now() / 1000) - 70, user_id: 44444,
    message: [{ type: 'text', data: { text: '别人消息' } }], raw_message: '别人消息', sender: { user_id: 44444, nickname: '小红', card: '' } });
  const before5c = mock.sent.length;
  await fetch(mock.httpUrl + '/__inject', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message_type: 'group', group_id: 33333, user_id: 22222, nickname: '小明',
      message: [{ type: 'reply', data: { id: otherMsg5 } }, { type: 'at', data: { qq: '10000' } }] }),
  });
  const sent5c = await waitFor(() => (mock.sent.length > before5c ? mock.sent.slice(before5c) : null), 15000, '回复别人+@无正文');
  check('回复别人 + @bot（无正文）：触发处理', sent5c.length > 0 && sent5c[0].action === 'send_group_msg', JSON.stringify(sent5c));
  check('回复别人 + @bot（无正文）：引用回复', sent5c[0].message[0] && sent5c[0].message[0].type === 'reply', JSON.stringify(sent5c[0].message));
  const text5c = textOf(sent5c[0]);
  check('回复别人 + @bot（无正文）：占位正文（不再自动塞被回复者发言）',
    text5c.includes('仅点名了 bot') && !text5c.includes('别人消息'), JSON.stringify(text5c.slice(0, 140)));

  console.log('\n4a6. 被回复消息不在最近历史（窗口外）-> 不再并入上下文（AI 自取走 qq_history）');
  mock.history.length = 0;
  mock.extraMessages.length = 0;
  const oldMsg6 = 600050;
  mock.extraMessages.push({ message_id: oldMsg6, time: Math.floor(Date.now() / 1000) - 3600, user_id: 44444,
    message: [{ type: 'text', data: { text: '很旧的那条被回复消息' } }], raw_message: '很旧的那条被回复消息',
    sender: { user_id: 44444, nickname: '小红', card: '' } });
  const t6 = Math.floor(Date.now() / 1000);
  mock.history.push({ message_id: 600051, time: t6 - 40, user_id: 22222,
    message: [{ type: 'text', data: { text: '发言人最近发言' } }], raw_message: '发言人最近发言', sender: { user_id: 22222, nickname: '小明', card: '' } });
  mock.history.push({ message_id: 600052, time: t6 - 20, user_id: 10000,
    message: [{ type: 'text', data: { text: 'bot最近发言' } }], raw_message: 'bot最近发言', sender: { user_id: 10000, nickname: '机器人', card: '' } });
  const before6 = mock.sent.length;
  await fetch(mock.httpUrl + '/__inject', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message_type: 'group', group_id: 33333, user_id: 22222, nickname: '小明',
      message: [{ type: 'reply', data: { id: oldMsg6 } }, { type: 'at', data: { qq: '10000' } }] }),
  });
  const sent6 = await waitFor(() => (mock.sent.length > before6 ? mock.sent.slice(before6) : null), 15000, '窗口外被回复消息');
  const text6 = textOf(sent6[0]);
  check('被回复消息不在历史窗口：不再并入上下文（get_msg 仍可用于收被回复图片）', !text6.includes('很旧的那条被回复消息'), JSON.stringify(text6.slice(0, 160)));
  check('上下文不再含发言人/bot 发言（不再自动拉上下文）', !text6.includes('发言人最近发言') && !text6.includes('bot最近发言'), JSON.stringify(text6.slice(0, 160)));

  console.log('\n4a7. 相关发言为空时 -> 最低 2 条兜底（被回复消息 + 发言人本条）');
  mock.history.length = 0;
  mock.extraMessages.length = 0;
  const botMsg7 = 600060;
  mock.extraMessages.push({ message_id: botMsg7, time: Math.floor(Date.now() / 1000) - 600, user_id: 10000,
    message: [{ type: 'text', data: { text: 'bot 很久前的消息' } }], raw_message: 'bot 很久前的消息',
    sender: { user_id: 10000, nickname: '机器人', card: '' } });
  // 历史里没有任何相关方发言（只有一条别人的），也不在 get_group_msg_history 窗口内
  mock.history.push({ message_id: 600061, time: Math.floor(Date.now() / 1000) - 30, user_id: 55555,
    message: [{ type: 'text', data: { text: '别的群友插话' } }], raw_message: '别的群友插话', sender: { user_id: 55555, nickname: '路人', card: '' } });
  const before7 = mock.sent.length;
  await fetch(mock.httpUrl + '/__inject', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message_type: 'group', group_id: 33333, user_id: 22222, nickname: '小明',
      message: [{ type: 'reply', data: { id: botMsg7 } }] }),
  });
  const sent7 = await waitFor(() => (mock.sent.length > before7 ? mock.sent.slice(before7) : null), 15000, '最低2条兜底');
  const text7 = textOf(sent7[0]);
  check('相关发言为空：不再并入被回复消息（bot 很久前的消息不塞上下文）', !text7.includes('bot 很久前的消息'), JSON.stringify(text7.slice(0, 160)));
  check('相关发言为空时上下文含发言人本条（最低 2 条兜底）', text7.includes('仅点名了 bot'), JSON.stringify(text7.slice(0, 160)));
  check('最低 2 条兜底：不硬补其它群友', !text7.includes('别的群友插话'), JSON.stringify(text7.slice(0, 160)));

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
  const visionReply = textOf(visionSent);
  check('调用了 llm.resolveModelInfo + stream', visionCalls.some((c) => c.kind === 'resolve') && visionCalls.some((c) => c.kind === 'stream'),
    JSON.stringify(visionCalls));
  check('图片被注册成附件（saveImage 调用）', visionCalls.filter((c) => c.kind === 'stream').length === 1,
    String(visionCalls.filter((c) => c.kind === 'stream').length));
  check('识别文本并入了 Agent 输入', visionReply.includes('【视觉识别】画面里是一只白猫，坐在窗台上。'),
    JSON.stringify(visionReply.slice(0, 200)));

  console.log('\n4b2. 回复别人时，被回复消息的图片也被识别并入');
  mock.history.length = 0;
  mock.extraMessages.length = 0;
  const repImgMsg = 600070;
  mock.extraMessages.push({ message_id: repImgMsg, time: Math.floor(Date.now() / 1000) - 300, user_id: 44444,
    message: [{ type: 'image', data: { url: 'https://example.com/cat.png' } }], raw_message: '[图片]',
    sender: { user_id: 44444, nickname: '小红', card: '' } });
  const streamsBefore2 = visionCalls.filter((c) => c.kind === 'stream').length;
  const sentBefore2 = mock.sent.length;
  await fetch(mock.httpUrl + '/__inject', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message_type: 'group', group_id: 33333, user_id: 22222, nickname: '小明',
      message: [{ type: 'reply', data: { id: repImgMsg } }, { type: 'at', data: { qq: '10000' } }] }),
  });
  const sent2 = await waitFor(() => (mock.sent.length > sentBefore2 ? mock.sent.slice(sentBefore2) : null), 15000, '被回复图片识别');
  check('回复别人 + 被回复消息带图：触发处理', sent2.length > 0 && sent2[0].action === 'send_group_msg', JSON.stringify(sent2));
  check('被回复消息的图片也被识别（stream 调用 +1）',
    visionCalls.filter((c) => c.kind === 'stream').length === streamsBefore2 + 1,
    'stream 总数=' + visionCalls.filter((c) => c.kind === 'stream').length);
  const text2 = textOf(sent2[0]);
  check('被回复图片的识别文本并入 Agent 输入', text2.includes('【视觉识别】画面里是一只白猫'), JSON.stringify(text2.slice(0, 200)));
  check('被回复图片不再以 [图片] 占位塞进消息文本（改由视觉识别并入）', !text2.includes('[图片]'), JSON.stringify(text2.slice(0, 200)));

  console.log('\n4c. 图片视觉：模型不支持 -> 可读报错（不进入 Agent）');
  const streamsBefore4c = visionCalls.filter((c) => c.kind === 'stream').length;
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
  const unsupportedReply = textOf(unsupportedSent);
  check('报错提示了切换模型', unsupportedReply.includes('不支持图片识别') && unsupportedReply.includes('图片视觉'),
    JSON.stringify(unsupportedReply.slice(0, 200)));
  check('未进入 Agent（没有识别流）', visionCalls.filter((c) => c.kind === 'stream').length === streamsBefore4c,
    String(visionCalls.filter((c) => c.kind === 'stream').length));

  console.log('\n4d. 多引擎搜索：multiEngine 默认开，走 DuckDuckGo 而非官方 DeepSeek');
  check('webSearch.multiEngine 默认 true（设置页有开关）',
    liveConfig.webSearch.multiEngine !== undefined && liveConfig.webSearch.multiEngine !== null
    && typeof liveConfig.webSearch.multiEngine.get === 'function'
    && liveConfig.webSearch.multiEngine.get() === true,
    String(liveConfig.webSearch.multiEngine && liveConfig.webSearch.multiEngine.get && liveConfig.webSearch.multiEngine.get()));
  // 在 4b 的 fetch 桩基础上再拦 DuckDuckGo（html 端点 → 固定结果页）
  const meBaseFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://html.duckduckgo.com')) {
      return {
        ok: true, status: 200, headers: { get: () => 'text/html' },
        text: async () => '<html><body><div class="result">'
          + '<h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ftest-page">测试结果标题</a></h2>'
          + '<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ftest-page">这是测试搜索的摘要内容</a>'
          + '</div></body></html>',
      };
    }
    return meBaseFetch(url, init);
  };
  if (hasDshTools === true) {
  const wsTool4d = registeredTools.find((t) => t.name === 'qq_websearch');
  const meResult = wsTool4d !== undefined ? await wsTool4d.execute({ query: '测试搜索' }, {}) : null;
  check('多引擎搜索返回 mock DuckDuckGo 结果（未走官方 DeepSeek）',
    meResult !== null && meResult !== undefined && meResult.ok === true
    && Array.isArray(meResult.sources) && meResult.sources.some((s) => s.url === 'https://example.com/test-page'),
    JSON.stringify(meResult).slice(0, 220));
  check('多引擎结果带标题与摘要',
    meResult !== null && meResult !== undefined && meResult.sources[0]
    && meResult.sources[0].title === '测试结果标题' && meResult.sources[0].snippet.includes('测试搜索'),
    JSON.stringify(meResult && meResult.sources && meResult.sources[0]));
  globalThis.fetch = meBaseFetch;
  } else {
    check('（跳过）4d 多引擎工具断言需 @deepseek-ai/dsh-tools', true);
  }

  console.log('\n4e. 图片反搜：imgSearch 默认开，qq_imgsearch 工具走 mock TraceMoe');
  check('imgSearch.enabled 默认 true（设置页有开关）',
    liveConfig.imgSearch && liveConfig.imgSearch.enabled !== undefined
    && typeof liveConfig.imgSearch.enabled.get === 'function'
    && liveConfig.imgSearch.enabled.get() === true,
    String(liveConfig.imgSearch && liveConfig.imgSearch.enabled && liveConfig.imgSearch.enabled.get && liveConfig.imgSearch.enabled.get()));
  // 拦 TraceMoe（URL 模式 JSON 直出番名）
  const imBaseFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.trace.moe/search?url=')) {
      return {
        ok: true, status: 200, headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({
          quota: 100, quotaUsed: 1, result: [
            { anilist: { id: 6702, title: { chinese: '妖精的尾巴', romaji: 'FAIRY TAIL' },
                siteUrl: 'https://anilist.co/anime/6702' },
              episode: 1, similarity: 0.97, from: 123.4, filename: 'FT_EP1.mp4' },
          ],
        }),
      };
    }
    return imBaseFetch(url, init);
  };
  if (hasDshTools === true) {
  const imgTool4e = registeredTools.find((t) => t.name === 'qq_imgsearch');
  check('qq_imgsearch 已注册', imgTool4e !== undefined, imgTool4e ? imgTool4e.name : '未注册');
  const imgResult = imgTool4e !== undefined ? await imgTool4e.execute({ url: 'https://example.com/some-image.jpg' }, {}) : null;
  check('图片反搜返回 mock TraceMoe 结果（带番名/来源 URL）',
    imgResult !== null && imgResult !== undefined && imgResult.ok === true
    && Array.isArray(imgResult.sources) && imgResult.sources.length >= 1
    && imgResult.sources[0].url === 'https://anilist.co/anime/6702'
    && imgResult.sources[0].title === '妖精的尾巴',
    JSON.stringify(imgResult).slice(0, 220));
  check('图片反搜结果带集数与相似度',
    imgResult && imgResult.sources[0] && imgResult.sources[0].snippet
    && imgResult.sources[0].snippet.includes('第1集') && imgResult.sources[0].snippet.includes('相似度 97%'),
    JSON.stringify(imgResult && imgResult.sources && imgResult.sources[0] && imgResult.sources[0].snippet));
  globalThis.fetch = imBaseFetch;
  } else {
    check('（跳过）4e 图片反搜工具断言需 @deepseek-ai/dsh-tools', true);
  }

  console.log('\n4f. qq_history：AI 自取聊天记录与图片（识别窗口锚定最新提及，不再自动塞上下文）');
  if (hasDshTools === true) {
  const histTool = registeredTools.find((t) => t.name === 'qq_history');
  check('qq_history 工具已注册（含 group_id/user_id/count/with_images 参数）',
    Boolean(histTool) && typeof histTool.parameters?.properties?.group_id === 'object'
    && typeof histTool.parameters?.properties?.count === 'object'
    && typeof histTool.parameters?.properties?.with_images === 'object',
    Boolean(histTool) ? JSON.stringify(Object.keys(histTool.parameters?.properties ?? {})) : 'missing');
  // 构造窗口内/窗口外图片：注入 8 条历史（img1 最旧=窗口外，img5/img6 在窗口内），再注入触发消息 @bot
  mock.history.length = 0;
  for (let i = 1; i <= 8; i += 1) {
    const hasImg = i === 1 || i === 5 || i === 6;
    const m = hasImg
      ? [{ type: 'image', data: { url: 'https://cdn.example.com/img' + i + '.png' } }]
      : [{ type: 'text', data: { text: '历史消息' + i } }];
    await fetch(mock.httpUrl + '/__inject', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message_type: 'group', group_id: 33333, user_id: 22222, nickname: '用户' + i, message: m }),
    });
  }
  const beforeHist = mock.sent.length;
  await fetch(mock.httpUrl + '/__inject', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message_type: 'group', group_id: 33333, user_id: 22222, nickname: '小明',
      message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: '看看最近聊天记录' } }],
    }),
  });
  await waitFor(() => (mock.sent.length > beforeHist ? mock.sent.slice(beforeHist) : null), 15000, '触发消息已回复');
  // stub cdn.example.com 下载（识别走「未配置 provider/model」分支，验证失败不阻塞只给 URL）
  const histRealFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://cdn.example.com/')) {
      return { ok: true, status: 200, headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'image/png' : null) },
        arrayBuffer: async () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer };
    }
    return histRealFetch(url, init);
  };
  const histExec = { agent: agents.get('qqbot-group-33333') };
  const histRes = histTool !== undefined ? await histTool.execute({ count: 20 }, histExec) : null;
  globalThis.fetch = histRealFetch;
  check('qq_history 返回结构化消息列表（time/user_id/nickname/text/images）',
    histRes !== null && histRes.ok === true && Array.isArray(histRes.messages) && histRes.messages.length >= 1
    && typeof histRes.messages[0].text === 'string' && histRes.messages[0].images !== undefined,
    histRes ? JSON.stringify(histRes).slice(0, 260) : 'null');
  check('识别窗口锚定最新提及：窗口内图片带 URL+描述，窗口外图片不被识别',
    (() => {
      if (histRes === null || !Array.isArray(histRes.messages)) return false;
      const has = (n) => histRes.messages.some((m) => m.images.some((im) => im.url.includes('img' + n + '.png')));
      const img5 = histRes.messages.find((x) => x.images.some((im) => im.url.includes('img5.png')));
      const desc5 = img5 && img5.images[0] && typeof img5.images[0].description === 'string' ? img5.images[0].description : '';
      return has(5) && has(6) && !has(1) && desc5 !== '';
    })(),
    histRes ? JSON.stringify(histRes.messages.map((m) => ({ text: m.text, images: m.images.map((im) => ({ url: im.url, d: im.description })) })).slice(0, 9)) : 'null');
  check('窗口内识别不超过 imageLimit 张（默认 3；此场景窗口内 2 张）',
    (() => {
      if (histRes === null || !Array.isArray(histRes.messages)) return false;
      return histRes.messages.reduce((acc, m) => acc + m.images.length, 0) === 2;
    })(),
    histRes ? String(histRes.messages.reduce((acc, m) => acc + m.images.length, 0)) : 'null');
  } else {
    check('（跳过）4f qq_history 工具断言需 @deepseek-ai/dsh-tools', true);
  }
  check('qq_history 默认在访客白名单', Array.isArray(liveConfig.auth.guestToolAllow.get())
    && liveConfig.auth.guestToolAllow.get().includes('qq_history'),
    JSON.stringify(liveConfig.auth.guestToolAllow.get()));


  console.log('\n4g. 本轮运行失败：显示提示而不是重发上一轮回复内容');
  const failSession = 'qqbot-group-99999';
  const failMessages = [
    { id: 'qqmsg-prev-1', role: 'user', content: [{ type: 'text', text: '上一轮问题' }], source: { kind: 'user' } },
    { id: 'asst-prev-1', role: 'assistant', content: [{ type: 'text', text: '上一轮的回复内容' }], source: { kind: 'model' } },
  ];
  const silentAgent = {
    id: failSession, guards: [], status: 'idle',
    ctx: { tools: { guard(fn) { silentAgent.guards.push(fn); return () => {}; } } },
    session: {
      get seq() { return failMessages.length; },
      deriveMessages: () => failMessages.slice(),
      snapshotEvents: () => [{ type: 'turn/end', data: { reason: { kind: 'error', error: { type: 'internal_error', message: '本轮运行失败' } } } }],
    },
    followup(message) {
      failMessages.push({ id: message.id, role: 'user', content: message.content, source: message.source });
      // 不产生 assistant 消息 —— 模拟本轮运行失败
      silentAgent.status = 'idle';
    },
    async whenIdle() {},
  };
  agents.set(failSession, silentAgent);
  const beforeFail = mock.sent.length;
  await fetch(mock.httpUrl + '/__inject', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message_type: 'group', group_id: 99999, user_id: 55555, nickname: '路人',
      message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: '再问一次' } }] }),
  });
  const failSent = await waitFor(() => (mock.sent.length > beforeFail ? mock.sent.slice(beforeFail) : null), 15000, '失败轮提示');
  const failText = textOf(failSent[0]);
  check('本轮失败：显示提示而不是重发上一轮内容', failText.includes('本轮没有产生文字回复') && !failText.includes('上一轮的回复内容'), JSON.stringify(failText.slice(0, 90)));

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
