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
import { ensureDshToolsLink } from './dsh-tools-link.mjs';
import path from 'node:path';
import fs from 'node:fs';
import process from 'node:process';
import { startMockOneBot } from './mock-onebot.mjs';
import { __setNetworkHooks } from '../lib/shared/http.js';

// 公共抓取（qq_websearch / qq_imgsearch / 识图下载）走 lib/shared/http.js 的 node:http 实现，不再经过
// globalThis.fetch：要打桩只能用 http.js 的 __setNetworkHooks（解析 + 单次请求两个动作）。
const TEST_PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const TEST_DDG_HTML = '<html><body><div class="result">'
  + '<h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ftest-page">测试结果标题</a></h2>'
  + '<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ftest-page">这是测试搜索的摘要内容</a>'
  + '</div></body></html>';
const TEST_TRACEMOE_JSON = JSON.stringify({
  quota: 100, quotaUsed: 1, result: [
    { anilist: { id: 6702, title: { chinese: '妖精的尾巴', romaji: 'FAIRY TAIL' }, siteUrl: 'https://anilist.co/anime/6702' },
      episode: 1, similarity: 0.97, from: 123.4, filename: 'FT_EP1.mp4' },
  ],
});
const TEST_HOSTS = new Set(['example.com', 'cdn.example.com', 'html.duckduckgo.com', 'lite.duckduckgo.com', 'api.trace.moe']);
// 打桩命中记录：用来断言「首选端点真的被请求过」，而不是又被测试自己的 DNS 桩屏蔽、退回兜底。
const TEST_HIT_HOSTS = [];
__setNetworkHooks({
  lookup: async (host) => (TEST_HOSTS.has(host) ? [{ address: '93.184.216.34', family: 4 }] : []),
  request: async ({ parsed }) => {
    const host = parsed.hostname;
    TEST_HIT_HOSTS.push(host);
    const ok = (contentType, body) => ({ status: 200, location: '', setCookie: '', contentType, body: Buffer.from(body), truncated: false });
    // html 与 lite 回同一份结果页：parseDdgResults 先按 result__a（html 形态）解析，
    // 解析不到才退到 result-link（lite 形态），一份夹具两边都能用。
    if (host === 'html.duckduckgo.com' || host === 'lite.duckduckgo.com') return ok('text/html', TEST_DDG_HTML);
    if (host === 'api.trace.moe') return ok('application/json', TEST_TRACEMOE_JSON);
    if (host === 'example.com' || host === 'cdn.example.com') return ok('image/png', TEST_PNG);
    return { status: 404, location: '', setCookie: '', contentType: 'text/plain', body: Buffer.from('no stub'), truncated: false };
  },
});


const here = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.join(here, '..');
// 装到 DSH profile 之后，@deepseek-ai/dsh-tools 由 DSH 运行时解析。临时软链逻辑与 test-admin
// 共用（dsh-tools-link.mjs：显式环境变量 > profile 的 node_modules > DSH 安装目录）。
// 解析不到就跳过依赖宿主服务的断言（裸克隆照样跑），但跳过会单独标 [SKIP]、不记成通过——
// 否则工具注册面从没被验证过也全绿（0.11 那次工具数 7→9 漂移就是这么漏掉的）。
const createdLink = ensureDshToolsLink(PKG_ROOT);

let failures = 0;
let skips = 0;
// 「跳过」不能算通过：以前写成 check('（跳过）…', true)，裸克隆/CI 上 70 条工具断言会静静变成
// PASS，工具注册面从没被验证过也全绿（0.11 那次工具数 7→9 漂移就是这么漏掉的）。
const skip = (name) => { skips += 1; console.log('  [SKIP] ' + name); };
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
    restricts: [],
    registers: [],
    ctx: {
      tools: {
        guard(fn) { agent.guards.push(fn); return () => { const i = agent.guards.indexOf(fn); if (i >= 0) agent.guards.splice(i, 1); }; },
        get() { return undefined; },
        restrict(filter) { agent.restricts.push(filter); return () => {}; },
        register(definition) { agent.registers.push(definition); return () => {}; },
      },
    },
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
      const wantsInterim = message.content[0].text.includes('[interim-test]');
      if (wantsInterim === true) {
        setTimeout(() => { messages.push({ id: 'asst-i1', role: 'assistant', content: [{ type: 'text', text: '我先查一下' }, { type: 'tool-call', name: 'qq_websearch' }], source: { kind: 'model' } }); }, 60);
        setTimeout(() => { messages.push({ id: 'tool-i1', role: 'tool', content: [{ type: 'tool-result', text: 'ok' }] }); }, 120);
        setTimeout(() => {
          messages.push({ id: 'asst-i2', role: 'assistant', content: [{ type: 'text', text: '结论：查完了' }], source: { kind: 'model' } });
          busy = false;
          agent.status = 'idle';
          const waitersInterim = pending; pending = [];
          for (const w of waitersInterim) w();
        }, 1100);
        return;
      }
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
      // 真服务内部要读 this（选容器模式），这里照做——桩要是完全不碰 this，
      // 「把方法裸传、丢了 this」这种接线错误就永远测不出来。
      // 曾经为此让线上适配器起不来、每 30 秒重试一次，而当时 148 项测试全绿。
      if (this === undefined || this === null || typeof this.resolveExecutable !== 'function') {
        throw new TypeError("Cannot read properties of undefined (reading 'selectContainmentMode')");
      }

      // 凭据现在走 env（不进 argv），mock 也要透传，否则适配器拿不到 token。
      const env = spec.env === undefined ? process.env : { ...process.env, ...spec.env };
      const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, stdio: ['pipe', 'pipe', 'pipe'], env });
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
  // 0.2 起宿主用 ctx.get('tools') 取工具服务（Guard 要求）；mock 不实现的话会被当成
  // 「服务还没就绪」，工具注册走 inject 分支，registeredTools 永远是空的。
  get(name) { return name === 'tools' ? this.tools : undefined; },
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
  // 设置页字段的组装结果在 config.js 里（index.js 不转出它）。
  const configMod = await import(pathToFileURL(path.join(PKG_ROOT, 'lib', 'config.js')).href);
  check('模块导出了 name/inject/apply', mod.name === 'dsh-qq-bot' && Array.isArray(mod.inject) && typeof mod.apply === 'function');
  check('inject 声明了 subprocess/sessionController/timer',
    mod.inject.includes('subprocess') && mod.inject.includes('sessionController') && mod.inject.includes('timer'));
  check('inject 声明了 attachments/llm（图片视觉依赖）',
    mod.inject.includes('attachments') && mod.inject.includes('llm'));


  console.log('\n1. 加载插件（正向 WS 连假 OneBot）');
  // 按 Cordis 的做法求值配置：Config['~standard'].validate(raw)，volatile 字段变成引用。
  const validated = mod.Config['~standard'].validate({
    // #27 起 auth.owners 为空即 fail-closed（不驱动任何会话），测试必须显式配拥有者。
    auth: { owners: ['22222'] },
    onebot: { wsUrl: mock.wsUrl, httpUrl: mock.httpUrl },
    reply: { ackAfterMs: 0, interimMinGapMs: 500 },
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
  // 所以直接从 lib/client/settings.js 里抠出 FIELDS 的 path 逐条核对，避免两边各写一份而漂移。
  // 字段定义已从客户端 bundle 搬到各所有者目录的 *-set.json，这里直接看组装结果。
  // virtual: true 的是纯界面卡片（例如扫码绑定），不对应 schema 字段，不参与 volatile 核对。
  const fieldPaths = configMod.SETTINGS_FIELDS
    .filter((field) => field.virtual !== true)
    .map((field) => field.path);
  check('从 -set.json 模板里组装出了表单字段', fieldPaths.length >= 30, String(fieldPaths.length));

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

  // ---------------------------------------------------------------- 设置页模板路由
  // 客户端 bundle 读不到 lib/ 下的文件，模板只能由服务端下发。这条路由是设置页的命脉：
  // 挂了就是整页空白，所以要在假 webServer 上真的走一遍请求/响应。
  const { registerSettingsRoutes, SETTINGS_PATH } = await import(pathToFileURL(path.join(PKG_ROOT, 'lib', 'gateway', 'routes-settings.js')).href);
  const { registerDefaultsRoutes, DEFAULTS_PATH } = await import(pathToFileURL(path.join(PKG_ROOT, 'lib', 'gateway', 'routes-defaults.js')).href);

  const mounted = new Map();
  const fakeServer = { register: (route) => { mounted.set(route.path, route.handler); return () => mounted.delete(route.path); } };
  const capture = () => {
    const res = { status: 0, headers: null, body: '' };
    res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
    res.end = (body) => { res.body = body; };
    return res;
  };

  const settingsMount = registerSettingsRoutes({ webServer: fakeServer });
  check('设置页模板路由挂上了', settingsMount.ok === true && mounted.has(SETTINGS_PATH), JSON.stringify(settingsMount));

  const settingsRes = capture();
  await mounted.get(SETTINGS_PATH)({ method: 'GET' }, settingsRes);
  let settingsBody = null;
  try { settingsBody = JSON.parse(settingsRes.body); } catch { settingsBody = null; }
  check('模板路由回 200 且是合法 JSON', settingsRes.status === 200 && settingsBody !== null, String(settingsRes.status));
  // update 只是「有没有新版本」的状态（版本号/兼容位），不含任何用户配置值。
  check('模板路由不回用户配置（模板 + 来源 + 更新状态）',
    settingsBody !== null && Object.keys(settingsBody).sort().join(',') === 'fields,ok,sources,tabs,update'
      && (settingsBody.update === null || typeof settingsBody.update === 'object'),
    settingsBody === null ? '' : Object.keys(settingsBody).join(','));
  check('模板里有标签页与字段',
    settingsBody !== null && settingsBody.tabs.length === 4 && settingsBody.fields.length === configMod.SETTINGS_FIELDS.length,
    settingsBody === null ? '' : settingsBody.tabs.length + ' 页 / ' + settingsBody.fields.length + ' 字段');
  check('模板响应禁止缓存（改 JSON 后要能立刻看到）',
    settingsRes.headers !== null && String(settingsRes.headers['cache-control']).includes('no-store'));

  const methodRes = capture();
  await mounted.get(SETTINGS_PATH)({ method: 'POST' }, methodRes);
  check('模板路由只认 GET', methodRes.status === 405, String(methodRes.status));

  const defaultsMount = registerDefaultsRoutes({ webServer: fakeServer });
  check('默认值路由仍然挂着', defaultsMount.ok === true && mounted.has(DEFAULTS_PATH));

  console.log('\n1b. 路由鉴权闸门（插件具名路由在 DSH 鉴权层之前处理，2026-10-28 审计 B1）');
  {
    const { createRouteGuard } = await import(pathToFileURL(path.join(PKG_ROOT, 'lib', 'gateway', 'route-auth.js')).href);
    const mkRes = () => { const r = { status: 0, headers: null, body: '' }; r.writeHead = (st, hd) => { r.status = st; r.headers = hd; }; r.end = (b) => { r.body = b; }; return r; };
    // 服务名是 `connection`（HostConnectionService 的 super(ctx, "connection")），不是插件名
    // `client-connection`。这里两种拼法都要能拿到，否则实装时会静默降级成「只做同源校验」。
    const mkCtx = (auth, serviceName = 'connection') => ({
      get: (name) => (name === serviceName ? { browserAuth: auth } : (name === 'webServer' ? { protocol: 'http:' } : undefined)),
    });

    // 1) 拿不到 client-connection（桌面端 / 老版本）→ 放行，不把设置页锁死。
    const looseGuard = createRouteGuard({ get: () => undefined }, () => {});
    const looseRes = mkRes();
    check('服务不可用时放行（降级，不锁死设置页）', looseGuard({ method: 'GET', headers: { host: 'h:1' } }, looseRes) === true, String(looseRes.status));

    // 2) 服务在、验签失败 → 401。
    const strictGuard = createRouteGuard(mkCtx({ isAuthenticated: () => false }), () => {});
    const denyRes = mkRes();
    check('未登录 → 401', strictGuard({ method: 'GET', headers: { host: 'h:1' } }, denyRes) === false && denyRes.status === 401, String(denyRes.status));
    check('401 文案与 DSH 自己的一致（排障时不会误判成插件坏了）',
      String(denyRes.body).includes('dsh web authentication required'));

    // 3) 验签通过 → 放行。
    const okGuard = createRouteGuard(mkCtx({ isAuthenticated: () => true }), () => {});
    const okRes = mkRes();
    check('已登录 → 放行', okGuard({ method: 'GET', headers: { host: 'h:1' } }, okRes) === true);

    // 3b) 服务名的两种拼法都要认（实装踩过：按插件名取不到 → 静默降级 → 鉴权形同虚设）。
    const byPluginName = createRouteGuard(mkCtx({ isAuthenticated: () => true }, 'client-connection'), () => {});
    check('服务名写成 client-connection 也能拿到', byPluginName({ method: 'GET', headers: { host: 'h:1' } }, mkRes()) === true);
    const byServiceName = createRouteGuard(mkCtx({ isAuthenticated: () => false }, 'connection'), () => {});
    const svcRes = mkRes();
    check('服务名写成 connection 时确实在验签（未登录 → 401）',
      byServiceName({ method: 'GET', headers: { host: 'h:1' } }, svcRes) === false && svcRes.status === 401, String(svcRes.status));

    // 4) 跨站请求（Origin 与 Host 不同）直接拒，连验签都不做。
    let called = 0;
    const spyGuard = createRouteGuard(mkCtx({ isAuthenticated: () => { called += 1; return true; } }), () => {});
    const crossRes = mkRes();
    check('跨站 Origin → 401', spyGuard({ method: 'POST', headers: { host: 'a:1', origin: 'http://evil.test' } }, crossRes) === false && crossRes.status === 401);
    check('跨站请求不消耗验签', called === 0, 'called=' + String(called));
    const sameRes = mkRes();
    check('同源 Origin → 放行', spyGuard({ method: 'GET', headers: { host: 'a:1', origin: 'http://a:1' } }, sameRes) === true);
  }

  const unmounted = settingsMount.unregister;
  unmounted();
  check('注销后路由从服务端摘掉', !mounted.has(SETTINGS_PATH));
  check('工作目录配置项已移除（工作区自动管理）', liveConfig.workspace === undefined || liveConfig.workspace === null);
  check('访客默认白名单含 qq_websearch/qq_history 且不含 web_fetch（联网统一走 qq_websearch 代理，历史自取走 qq_history）',
    Array.isArray(liveConfig.auth.guestToolAllow.get()) && liveConfig.auth.guestToolAllow.get().includes('qq_websearch') && liveConfig.auth.guestToolAllow.get().includes('qq_history') && !liveConfig.auth.guestToolAllow.get().includes('web_fetch'),
    JSON.stringify(liveConfig.auth.guestToolAllow.get()));

  console.log('\n2. 动态工具注册（走真的 defineTool）');
  const tool = registeredTools.find((t) => t.name === 'qqbot');
  if (hasDshTools !== true) {
    skip('工具注册需 @deepseek-ai/dsh-tools；路由/回复断言不受影响');
  } else {
    const EXPECTED_TOOLS = ['qqbot', 'qqconfig', 'qqgroup', 'qq_websearch', 'qq_webfetch', 'qq_imgsearch', 'qq_history', 'qq_draw', 'qq_sticker', 'qqauth'];
    check('注册了 ' + EXPECTED_TOOLS.length + ' 个工具（qqbot / qqconfig / qqgroup / qq_websearch / qq_webfetch / qq_imgsearch / qq_history / qq_draw / qq_sticker / qqauth）',
      registeredTools.length === EXPECTED_TOOLS.length, String(registeredTools.length));
    check('工具名与预期完全一致', (() => {
      const names = registeredTools.map((t) => t.name).slice().sort();
      return JSON.stringify(names) === JSON.stringify(EXPECTED_TOOLS.slice().sort());
    })(), JSON.stringify(registeredTools.map((t) => t.name)));
    check('工具名含 qqbot / qqgroup / qq_websearch / qq_history / qqauth', (() => { const names = registeredTools.map((t) => t.name); return names.includes('qqauth'); })());
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

  {
    const ownerAgent = agents.get('qqbot-group-33333');
    const touched = ownerAgent === undefined ? 0 : (ownerAgent.restricts.length + ownerAgent.registers.length);
    // 0.12 起接管只在流程授权开启时发生：关着的时候必须与 0.11 完全一致（既不遮蔽也不摘除）。
    check('流程授权关着时不动工具面（0.11 行为）', touched === 0, JSON.stringify({ restricts: ownerAgent === undefined ? -1 : ownerAgent.restricts.length, registers: ownerAgent === undefined ? -1 : ownerAgent.registers.length }));
  }
  console.log('\n3a. 入站去重（模拟重连/重投同一条消息）');
  {
    mock.sent.length = 0;
    const body = {
      message_type: 'group', group_id: 33333, user_id: 22222, nickname: '小明',
      message_id: 777001,
      message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: '[dedupe-test] 只应回一次' } }],
    };
    await fetch(mock.httpUrl + '/__inject', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await waitFor(() => (mock.sent.length > 0 ? mock.sent : null), 15000, '第一次回复');
    // 同一条 message_id 再投一次（模拟 WS resume 重放 / webhook 重投）
    await fetch(mock.httpUrl + '/__inject', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await sleep(1200);
    check('重复 message_id 只回一次', mock.sent.length === 1, 'sent=' + mock.sent.length);
    check('重复消息对应的是 dedupe-test 那一轮', textOf(mock.sent[0]).includes('dedupe-test'), textOf(mock.sent[0]).slice(0, 80));
  }

  console.log('\n3c. /model 指令在群里被 @ 时也要被截获（不进模型回合）');
  {
    mock.sent.length = 0;
    await fetch(mock.httpUrl + '/__inject', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message_type: 'group', group_id: 33333, user_id: 22222, nickname: '小明',
        message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ' /model' } }],
      }),
    });
    const modelSends = await waitFor(() => (mock.sent.length > 0 ? mock.sent.slice() : null), 15000, '/model 回复');
    const modelText = textOf(modelSends[0]);
    check('/model 走到了指令分支（回复里有模型/接口字样）', modelText.includes('模型') || modelText.includes('provider'), modelText.slice(0, 80));
    check('/model 没有进模型回合（回复不是 Agent 的 REPLY: 信封）', modelText.startsWith('REPLY:') === false, modelText.slice(0, 80));
  }

  console.log('\n3d. requireAt 只认 at 段，不认正文（2026-10-28 审计 A1）');
  {
    // 1) 正文里手打 '@10000'（bot 的 QQ）但没有任何 at 段 —— 旧实现用 text.includes 判定，
    //    于是谁都能靠「在正文里写一串 @机器人QQ」绕过 requireAt。
    const beforeText = mock.sent.length;
    await fetch(mock.httpUrl + '/__inject', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message_type: 'group', group_id: 33333, user_id: 22222, nickname: '小明',
        message: [{ type: 'text', data: { text: '@10000 正文里的假艾特' } }],
      }),
    });
    await sleep(1500);
    check('正文里手打 @机器人QQ 不算点名（不触发回复）', mock.sent.length === beforeText,
      'sent=' + String(mock.sent.length - beforeText) + ' last=' + JSON.stringify(mock.sent.slice(beforeText).map(textOf).join('|').slice(0, 160)));

    // 2) 前缀碰撞：群友 QQ 是 100001，'@10000' 是它的前缀。
    //    旧实现既会误判成 @ 了我，又会在 split('@10000').join(' ') 时把对方号咬成 '1'。
    const beforePrefix = mock.sent.length;
    await fetch(mock.httpUrl + '/__inject', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message_type: 'group', group_id: 33333, user_id: 22222, nickname: '小明',
        message: [{ type: 'at', data: { qq: '100001' } }, { type: 'text', data: { text: ' 找一下他' } }],
      }),
    });
    await sleep(1500);
    check('@100001 不会被当成 @10000（前缀碰撞不再误判）', mock.sent.length === beforePrefix,
      'sent=' + String(mock.sent.length - beforePrefix));

    // 3) 真的 @ 了 bot：仍然要正常触发（别把修复做成「一律不响应」）。
    const beforeReal = mock.sent.length;
    await fetch(mock.httpUrl + '/__inject', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message_type: 'group', group_id: 33333, user_id: 22222, nickname: '小明',
        message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: '[real-at] 真的艾特' } }],
      }),
    });
    const realSent = await waitFor(() => (mock.sent.length > beforeReal ? mock.sent.slice(beforeReal) : null), 15000, '真 @ 的回复');
    check('真 @ 机器人照常触发', realSent.length >= 1, 'sent=' + String(realSent.length));
    const realText = textOf(realSent[0]);
    check('剥掉 @ 之后正文完整（没有咬掉数字）', realText.includes('[real-at] 真的艾特'), realText.slice(0, 120));
  }

  console.log('\n3b. 中间发言：先发一句（不引用），结论照常引用回复');
{
  const beforeInterim = mock.sent.length;
  await fetch(mock.httpUrl + '/__inject', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message_type: 'group', group_id: 33333, user_id: 22222, nickname: '小明',
      message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: '[interim-test] 帮我查个东西' } }],
    }),
  });
  const interimSends = await waitFor(() => (mock.sent.length >= beforeInterim + 2 ? mock.sent.slice(beforeInterim) : null), 15000,
    '中间发言与最终回复都到达假 OneBot');
  const interim = interimSends[0];
  const finalOne = interimSends[1];
  check('中间发言先发出', textOf(interim) === '我先查一下', JSON.stringify(textOf(interim)));
  check('中间发言不引用（没有 reply 段）',
    Array.isArray(interim.message) && interim.message.every((seg) => seg.type !== 'reply'), JSON.stringify(interim.message));
  check('结论仍然引用触发消息',
    Array.isArray(finalOne.message) && finalOne.message[0] && finalOne.message[0].type === 'reply', JSON.stringify(finalOne.message && finalOne.message[0]));
  check('结论只发了一次（中间发言没有把结论提前念出来）',
    interimSends.filter((m) => textOf(m).includes('结论：查完了')).length === 1,
    JSON.stringify(interimSends.map(textOf)));
}

  console.log('\n4. 群里没 @ 机器人 -> 忽略');
  const before = mock.sent.length;
  await fetch(mock.httpUrl + '/__inject', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message_type: 'group', group_id: 33333, user_id: 22222, text: '闲聊' }),
  });
  await sleep(1500);
  check('未 @ 的消息没有触发回复', mock.sent.length === before, String(mock.sent.length - before));

  console.log('\n4a. 回复（引用）机器人消息 -> 视同 @ + 引用回复（不再自动塞上下文）');
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

  console.log('\n4a4. 回复别人 + 正文 @bot -> 处理 + 引用回复（不再自动拉上下文）');
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

  console.log('\n4a7. 相关发言为空时 -> 只留发言人本条（不并入被回复消息）');
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
  // 识图下载走 publicFetch（node:http 直连 + 地址钉死），**globalThis.fetch 桩拦不到它**
  // （本文件第 27 行就写明了这一点），所以这里用测试网络钩子下发假 PNG。
  // 域名解析仍走判定：example.com → 93.184.216.34 是公网地址，isNonPublicIp 放行后才下发假响应。
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
  if (hasDshTools === true) {
  const wsTool4d = registeredTools.find((t) => t.name === 'qq_websearch');
  TEST_HIT_HOSTS.length = 0;
  const meResult = wsTool4d !== undefined ? await wsTool4d.execute({ query: '测试搜索' }, {}) : null;
  check('多引擎首选 html.duckduckgo.com 端点（没有被测试自己的 DNS 桩挡回兜底）',
    TEST_HIT_HOSTS.includes('html.duckduckgo.com'), JSON.stringify(TEST_HIT_HOSTS));
  check('多引擎搜索返回 mock DuckDuckGo 结果（未走官方 DeepSeek）',
    meResult !== null && meResult !== undefined && meResult.ok === true
    && Array.isArray(meResult.sources) && meResult.sources.some((s) => s.url === 'https://example.com/test-page'),
    JSON.stringify(meResult).slice(0, 220));
  check('多引擎结果带标题与摘要',
    meResult !== null && meResult !== undefined && meResult.sources[0]
    && meResult.sources[0].title === '测试结果标题' && meResult.sources[0].snippet.includes('测试搜索'),
    JSON.stringify(meResult && meResult.sources && meResult.sources[0]));
  } else {
    skip('4d 多引擎工具断言需 @deepseek-ai/dsh-tools');
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
    skip('4e 图片反搜工具断言需 @deepseek-ai/dsh-tools');
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
  // 图片下载走 publicFetch + 网络钩子（TEST_HOSTS 里的 cdn.example.com 回 TEST_PNG），
  // 不再需要 globalThis.fetch 桩 —— #32 之后那种桩根本拦不到请求。
  const histExec = { agent: agents.get('qqbot-group-33333') };
  const histRes = histTool !== undefined ? await histTool.execute({ count: 20 }, histExec) : null;
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
    skip('4f qq_history 工具断言需 @deepseek-ai/dsh-tools');
  }
  check('qq_history 默认在访客白名单', Array.isArray(liveConfig.auth.guestToolAllow.get())
    && liveConfig.auth.guestToolAllow.get().includes('qq_history'),
    JSON.stringify(liveConfig.auth.guestToolAllow.get()));


  console.log('\n4g. 入站限流只对「真的驱动回合」的消息计费（#22）');
  {
    // 以前 takeTurnSlot 放在消息入口：群里的闲聊、图片、没点名的消息都吃额度，
    // 一个活跃群几十条闲聊之后，真正的 @ 就被静默丢掉（群里还不回复，等于人间蒸发）。
    const floodGroup = 77777;
    const floodUser = 66666;
    for (let i = 0; i < 25; i += 1) {
      await fetch(mock.httpUrl + '/__inject', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message_type: 'group', group_id: floodGroup, user_id: floodUser, nickname: '话痨',
          message: [{ type: 'text', data: { text: '闲聊' + String(i) } }] }),
      });
    }
    await new Promise((r) => setTimeout(r, 300));
    const beforeMention = mock.sent.length;
    await fetch(mock.httpUrl + '/__inject', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message_type: 'group', group_id: floodGroup, user_id: floodUser, nickname: '话痨',
        message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: '现在真的叫我' } }] }),
    });
    const mentioned = await Promise.race([
      waitFor(() => (mock.sent.length > beforeMention ? mock.sent.slice(beforeMention) : null), 15000, '闲聊之后的 @ 应当被回复'),
      new Promise((resolve) => setTimeout(() => resolve(null), 15000)),
    ]);
    check('25 条群闲聊之后 @ 仍然有回复（闲聊不占回合额度）', mentioned !== null,
      'sent=' + String(mock.sent.length));
  }

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
    check('status 报告当前会话（至少含 group-33333）',
      status.conversations.some((c) => c.conversation === 'group-33333'), JSON.stringify(status.conversations));
    check('status 里有统计计数', status.stats.accepted >= 1 && status.stats.replies >= 1, JSON.stringify(status.stats));
  }
  if (status === null) skip('status 动作需要 dsh-tools');

  console.log('\n5b. 非 QQ 会话（Web UI / 子代理）调用：外发动作默认拒、只读放行');
  if (hasDshTools !== true) {
    skip('非 QQ 会话来源闸（需要 @deepseek-ai/dsh-tools 才能注册工具）');
  } else {
    // exec 里没有 QQ 会话的 agent → entryForAgent 返回 null。以前这里整段跳过拥有者判断，
    // 等于任何 Web UI 会话/子代理都能拿 qqbot send 往任意群发消息、掐断任意会话的回合。
    const sendsBefore = mock.sent.length;
    const consoleSend = await tool.execute({ action: 'send', message_type: 'group', target_id: '88888', text: '越权外发' }, {});
    check('console 调 send：默认被拒（admin.allowConsole 未开）',
      consoleSend !== null && consoleSend !== undefined && consoleSend.ok === false
      && String(consoleSend.error).includes('allowConsole'), JSON.stringify(consoleSend));
    check('console 调 send：没有真的发出去', mock.sent.length === sendsBefore, String(mock.sent.length));
    const consoleInterrupt = await tool.execute({ action: 'interrupt', conversation: 'all' }, {});
    check('console 调 interrupt：默认被拒',
      consoleInterrupt !== null && consoleInterrupt !== undefined && consoleInterrupt.ok === false, JSON.stringify(consoleInterrupt));
    const consoleStatus = await tool.execute({ action: 'status' }, {});
    check('console 调 status：只读动作照旧放行',
      consoleStatus !== null && consoleStatus !== undefined && consoleStatus.connected !== undefined, JSON.stringify(consoleStatus).slice(0, 120));
    const drawTool = registeredTools.find((t) => t.name === 'qq_draw');
    if (drawTool !== undefined) {
      // 生图会把图发到参数指定的任意群/人，和 send 同级；console 来源默认不许。
      // 这里靠「未启用生图」之前的那道来源闸，所以先断言它先被拦住（不看 imageGen 开关）。
      const consoleDraw = await drawTool.execute({ prompt: '一只鲸鱼', target_id: '88888' }, {});
      check('console 调 qq_draw：被来源闸拦下（不是只靠生图开关或目标校验）',
        consoleDraw !== null && consoleDraw !== undefined && consoleDraw.ok === false
        && String(consoleDraw.error).includes('allowConsole'), JSON.stringify(consoleDraw));
    }
  }

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
  // 幽灵适配器要 2 秒后才冒头（旧进程 done 晚到 → 再排一次重启），所以这里必须多等一会儿。
  await sleep(3200);
  const restartsAfter = logLines.filter((line) => line.includes('适配器已启动')).length - startsBefore;
  check('热更新只重启一个适配器，旧进程不会回来再起一个',
    restartsAfter === 1 && mock.clientCount() === 1,
    'starts=' + restartsAfter + ' clients=' + mock.clientCount());

  const startsAfterTransport = logLines.filter((line) => line.includes('适配器已启动')).length;
  liveConfig.reply.maxChars[VOLATILE_WRITE](999);
  for (const handler of volatileUpdateHandlers) handler([['reply', 'maxChars']]);
  await sleep(900);
  check('非连接类改动不重启适配器',
    logLines.filter((line) => line.includes('适配器已启动')).length === startsAfterTransport,
    String(logLines.filter((line) => line.includes('适配器已启动')).length - startsAfterTransport));

  console.log('\n6b. 默认准入 fail-closed：owners 为空时不驱动会话（#27）');
  liveConfig.auth.owners[VOLATILE_WRITE]([]);
  for (const handler of volatileUpdateHandlers) handler([['auth', 'owners']]);
  await sleep(200);
  const noOwnerBefore = mock.sent.length;
  const agentsBeforeNoOwner = agents.size;
  await fetch(mock.httpUrl + '/__inject', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message_type: 'private', user_id: 22222, nickname: '主人',
      message: [{ type: 'text', data: { text: '在吗' } }] }),
  });
  const noOwnerSent = await waitFor(() => (mock.sent.length > noOwnerBefore ? mock.sent.slice(noOwnerBefore) : null), 12000, '未配置拥有者的配置指引');
  const noOwnerText = String(textOf(noOwnerSent[0]));
  check('owners 为空：私聊收到配置指引', noOwnerText.includes('还没配置拥有者'), JSON.stringify(noOwnerText.slice(0, 120)));
  check('owners 为空：不新建会话、不驱动模型', agents.size === agentsBeforeNoOwner, 'agents=' + agents.size + ' before=' + agentsBeforeNoOwner);
  liveConfig.auth.owners[VOLATILE_WRITE](['22222']);
  for (const handler of volatileUpdateHandlers) handler([['auth', 'owners']]);
  await sleep(300);

  console.log('\n6c. 入站限制（#22）：每人每分钟条数 + 单条长度');
  liveConfig.limits.perMinute[VOLATILE_WRITE](1);
  liveConfig.limits.maxChars[VOLATILE_WRITE](100);
  for (const handler of volatileUpdateHandlers) handler([['limits', 'perMinute'], ['limits', 'maxChars']]);
  await sleep(200);
  const limitedUser = 31337;
  const longText = '长'.repeat(300);
  const longBefore = mock.sent.length;
  await fetch(mock.httpUrl + '/__inject', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message_type: 'private', user_id: limitedUser, nickname: '路人甲',
      message: [{ type: 'text', data: { text: longText } }] }),
  });
  const longOut = await waitFor(() => (mock.sent.length > longBefore ? mock.sent.slice(longBefore) : null), 15000, '超长消息回复');
  const longReply = String(textOf(longOut[0]));
  check('超长正文进 Agent 前被截断（回复里能看到截断标记）', longReply.includes('已截断'), JSON.stringify(longReply.slice(0, 160)));
  check('截断保留原文长度说明', longReply.includes('原文 300 字'), JSON.stringify(longReply.slice(0, 200)));
  const rateBefore = mock.sent.length;
  await fetch(mock.httpUrl + '/__inject', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message_type: 'private', user_id: limitedUser, nickname: '路人甲',
      message: [{ type: 'text', data: { text: '第二条' } }] }),
  });
  const rateOut = await waitFor(() => (mock.sent.length > rateBefore ? mock.sent.slice(rateBefore) : null), 15000, '限流提示');
  const rateReply = String(textOf(rateOut[0]));
  check('同一分钟第二条被限流并回提示', rateReply.includes('发得太快'), JSON.stringify(rateReply.slice(0, 160)));
  check('限流的那条没有进 Agent（没有 REPLY: 回显）', !rateReply.includes('REPLY:'), JSON.stringify(rateReply.slice(0, 160)));
  liveConfig.limits.perMinute[VOLATILE_WRITE](20);
  liveConfig.limits.maxChars[VOLATILE_WRITE](4000);
  for (const handler of volatileUpdateHandlers) handler([['limits', 'perMinute'], ['limits', 'maxChars']]);
  await sleep(200);

  console.log('\n7. 废弃配置清理（升级删字段后残留在 patch 里的旧键）');
  const staleOverride = { proactive: { enabled: true, judgeProvider: 'uymu', judgeModel: 'judge-m' }, onebot: { wsUrl: 'ws://x' }, agentPreset: 'standard' };
  let editedConfig = null;
  const editorCtx = {
    get(name) {
      if (name !== 'configEditor') return undefined;
      return {
        configuration: () => [{ entry: { options: { id: 'dsh-qq-bot', name: 'dsh-qq-bot' } }, inherited: {}, override: staleOverride }],
        async edit(entry, change) { editedConfig = change(staleOverride, {}); },
      };
    },
  };
  const cleanedPaths = await mod.cleanupStaleConfig(editorCtx, { log: () => {} });
  check('认出并摘掉两个废弃键', JSON.stringify(cleanedPaths) === '["proactive.judgeProvider","proactive.judgeModel"]', JSON.stringify(cleanedPaths));
  check('写回的配置保留正常字段、去掉废弃键',
    editedConfig !== null && editedConfig.proactive.enabled === true && editedConfig.proactive.judgeProvider === undefined
      && editedConfig.proactive.judgeModel === undefined && editedConfig.onebot.wsUrl === 'ws://x' && editedConfig.agentPreset === 'standard');
  let wroteAgain = false;
  const cleanCtx = { get: () => ({ configuration: () => [{ entry: { options: { id: 'dsh-qq-bot' } }, override: { proactive: { enabled: true } } }], async edit() { wroteAgain = true; } }) };
  check('没有废弃键时不写盘', (await mod.cleanupStaleConfig(cleanCtx, { log: () => {} })).length === 0 && wroteAgain === false);
  let touchedOther = false;
  const otherCtx = { get: () => ({ configuration: () => [{ entry: { options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' } }, override: { legacyKey: 1 } }], async edit() { touchedOther = true; } }) };
  check('不碰别的插件的配置行', (await mod.cleanupStaleConfig(otherCtx, { log: () => {} })).length === 0 && touchedOther === false);

  // 精确匹配：id 以 -qq-bot 结尾但不是我们（如 my-qq-bot）的插件排在前面，也只能清自己那一行。
  let editedEntryId = null;
  let foreignEdited = false;
  const shadowCtx = {
    get: () => ({
      configuration: () => [
        { entry: { options: { id: 'my-qq-bot', name: 'my-qq-bot' } }, override: { ownSetting: 1 } },
        { entry: { options: { id: 'dsh-qq-bot', name: 'dsh-qq-bot' } }, override: { proactive: { judgeModel: 'dead' } } },
      ],
      async edit(entry, change) {
        editedEntryId = entry.options.id;
        if (entry.options.id !== 'dsh-qq-bot') foreignEdited = true;
        change({}, {});
      },
    }),
  };
  const shadowCleaned = await mod.cleanupStaleConfig(shadowCtx, { log: () => {} });
  check('id 以 -qq-bot 结尾的别的插件不会被误清',
    foreignEdited === false && editedEntryId === 'dsh-qq-bot' && JSON.stringify(shadowCleaned) === '["proactive.judgeModel"]',
    JSON.stringify({ foreignEdited, editedEntryId, shadowCleaned }));

  // 键名本身带点：不能被当成嵌套路径，否则会删掉合法的 onebot.wsUrl。
  const dottedOverride = { 'onebot.wsUrl': 'literal', onebot: { wsUrl: 'ws://valid' } };
  let dottedWritten = null;
  const dottedCtx = {
    get: () => ({
      configuration: () => [{ entry: { options: { id: 'dsh-qq-bot' } }, override: dottedOverride }],
      async edit(entry, change) { dottedWritten = change({}, {}); },
    }),
  };
  const dottedCleaned = await mod.cleanupStaleConfig(dottedCtx, { log: () => {} });
  check('键名带点时只删字面键，合法嵌套值保留',
    JSON.stringify(dottedCleaned) === '["onebot.wsUrl"]'
      && dottedWritten !== null && dottedWritten['onebot.wsUrl'] === undefined
      && dottedWritten.onebot.wsUrl === 'ws://valid',
    JSON.stringify(dottedWritten));

  // 真实契约：edit 回调拿到的是「各层合并后的最终配置」，不是 profile 层的 override。
  // 写回必须以 override 为基座，否则会把上层 patch 的内容抄进 profile 行。
  let contractWritten = null;
  const contractCtx = {
    get: () => ({
      configuration: () => [{ entry: { options: { id: 'dsh-qq-bot' } }, override: { proactive: { judgeModel: 'dead', enabled: true } } }],
      async edit(entry, change) {
        contractWritten = change({ proactive: { judgeModel: 'dead', enabled: true }, overlayOnly: 'from-overlay' }, {});
      },
    }),
  };
  await mod.cleanupStaleConfig(contractCtx, { log: () => {} });
  check('写回基座是 profile 层 override，不把上层 patch 抄进来',
    contractWritten !== null && contractWritten.overlayOnly === undefined
      && contractWritten.proactive.enabled === true && contractWritten.proactive.judgeModel === undefined,
    JSON.stringify(contractWritten));

  // 失败路径：读清单抛错、写盘抛错都不能影响插件运行。
  const throwReadCtx = { get: () => ({ configuration() { throw new Error('boom'); }, async edit() {} }) };
  check('读配置清单抛错时安全返回', (await mod.cleanupStaleConfig(throwReadCtx, { log: () => {} })).length === 0);
  const logs = [];
  const throwEditCtx = {
    get: () => ({
      configuration: () => [{ entry: { options: { id: 'dsh-qq-bot' } }, override: { legacy: 1 } }],
      async edit() { throw new Error('write failed'); },
    }),
  };
  const failedClean = await mod.cleanupStaleConfig(throwEditCtx, { log: (line) => logs.push(line) });
  check('写盘失败时安全返回并留下日志', failedClean.length === 0 && logs.some((line) => line.includes('清理废弃配置失败')));

  // 旧值要进日志：降级/升级来回折腾时能照着加回去。
  const valueLogs = [];
  const valueCtx = {
    get: () => ({
      configuration: () => [{ entry: { options: { id: 'dsh-qq-bot' } }, override: { proactive: { judgeModel: 'deepseek-x' } } }],
      async edit() {},
    }),
  };
  await mod.cleanupStaleConfig(valueCtx, { log: (line) => valueLogs.push(line) });
  check('日志里带上被删键的旧值', valueLogs.some((line) => line.includes('proactive.judgeModel=') && line.includes('deepseek-x')), JSON.stringify(valueLogs));

  console.log('\n7b. 白名单排在群管理指令之前（2026-10-28 审计 A2）');
  {
    // 以前 allowlistOk 排在 handleAdminCommand 之后，于是 group.allow 收紧到单群后，
    // 其它群里的 /help、/whoami 照样会拿到回复——白名单只挡住了「进 Agent 回合」。
    const sendHelp = async () => {
      const before = mock.sent.length;
      await fetch(mock.httpUrl + '/__inject', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message_type: 'group', group_id: 33333, user_id: 22222, nickname: '小明',
          message: [{ type: 'text', data: { text: '/help' } }],
        }),
      });
      await sleep(1500);
      return mock.sent.length - before;
    };
    const flushVolatile = () => {
      for (const handler of volatileUpdateHandlers) { try { handler(); } catch (error) { console.log('  volatile handler 抛错：' + error.message); } }
    };

    const openReplies = await sendHelp();
    check('白名单为空（不限）时 /help 有回复', openReplies >= 1, 'sent=' + String(openReplies));

    const savedAllow = liveConfig.group.allow;
    liveConfig.group.allow = ['99999'];
    flushVolatile();
    await sleep(300);
    const closedReplies = await sendHelp();
    check('白名单收紧到别的群后 /help 不再回复', closedReplies === 0, 'sent=' + String(closedReplies));

    liveConfig.group.allow = savedAllow;
    flushVolatile();
    await sleep(300);
    const restoredReplies = await sendHelp();
    check('还原白名单后 /help 恢复', restoredReplies >= 1, 'sent=' + String(restoredReplies));
  }

  console.log('\n8. 卸载');
  for (const d of disposers) { try { d(); } catch (error) { console.log('  disposer 抛错：' + error.message); } }
  await sleep(600);
  check('卸载后适配器进程已终止', mock.clientCount() === 0, 'clients=' + mock.clientCount());
} catch (error) {
  failures += 1;
  console.log('\n错误：' + (error && error.stack ? error.stack : String(error)));
} finally {
  await mock.close();
  if (createdLink === true) {
    // 只删链接本身：对 junction 用 rmSync(recursive) 会把目标目录删空。
    try { if (process.platform === 'win32') fs.rmdirSync(linkPath); else fs.unlinkSync(linkPath); } catch { /* ignore */ }
  }
}

const passed = results.filter(Boolean).length;
console.log('\n' + passed + '/' + results.length + ' 项通过' + (skips > 0 ? '（另有 ' + skips + ' 项跳过：环境缺 @deepseek-ai/dsh-tools）' : ''));
if (failures > 0) { console.log('插件自测失败'); process.exit(1); }
console.log('插件自测通过');
process.exit(0);
