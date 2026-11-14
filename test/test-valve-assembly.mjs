/**
 * 阀门与组装顺序的自测（纯逻辑，不联网、不起进程）。
 *
 * 锁住三件事：
 *   1. 三个阀门各自独立成型、契约字段齐全（谁被拆掉都会红）；
 *   2. 组装顺序不可悄悄改（network → security → tool，改了就红）；
 *   3. 网络阀门的判定口径：能证明是内网的才拒绝，域名交给解析阶段判；
 *      工具阀消费安全阀发出的授权，一次授权只能用一次。
 *
 * 用法：node test/test-valve-assembly.mjs
 */
import assert from 'node:assert/strict';
import netModule from 'node:net';

/**
 * 一个「必然拒绝连接」的代理地址。
 *
 * 不用 127.0.0.1:9 这种约定端口：Windows 上它可能被过滤成「一直超时」而不是 ECONNREFUSED，
 * 断言就变成平台相关。这里临时开一个回环端口再立刻关掉，连接时各平台都会秒拒。
 */
async function deadProxyUrl() {
  const server = netModule.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return 'http://127.0.0.1:' + String(port);
}

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass += 1; console.log('  ok   ' + name); }
  catch (error) { fail += 1; console.log('  FAIL ' + name + '\n       ' + (error && error.message ? error.message : error)); }
}

const { STAGE, orderedValves, createNetworkValve, createSecurityValve, createToolValve } = await import('../lib/valve/index.js');
const { currentProxy, multiEngineRequest } = await import('../lib/shared/http.js');
const { __setNetworkHooks } = await import('../lib/valve/network/policy.js');
const { assembleValves, describeAssembly, ASSEMBLY_ORDER } = await import('../lib/assemble.js');
const { resolveAdapterPath, supportedProtocols } = await import('../lib/transport/index.js');

console.log('\n1. 阀门清单与顺序');
await check('三道阀门按 stage 升序排列', () => {
  const list = orderedValves();
  assert.deepEqual(list.map((v) => v.name), ['network', 'security', 'tool']);
  assert.deepEqual(list.map((v) => v.stage), [STAGE.NETWORK, STAGE.SECURITY, STAGE.TOOL]);
});
await check('依赖声明的方向正确（tool 依赖 security）', () => {
  const tool = orderedValves().find((v) => v.name === 'tool');
  assert.deepEqual(tool.dependsOn, ['security']);
});
await check('全链路装配顺序覆盖六层', () => {
  assert.deepEqual(ASSEMBLY_ORDER.map((x) => x.layer), ['valve/network', 'valve/security', 'valve/tool', 'message', 'gateway', 'transport']);
  assert.ok(describeAssembly().includes('10:valve/network'));
});

console.log('\n2. 网络阀门：判定口径');
const net = createNetworkValve({ proxy: () => '' });
await check('公网字面量放行', () => {
  assert.equal(net.isAllowedTarget('8.8.8.8'), true);
});
await check('内网/回环/云元数据一律拒绝', () => {
  for (const host of ['127.0.0.1', '192.168.1.1', '10.0.0.1', '169.254.169.254', '::1', 'fe80::1']) {
    assert.equal(net.isAllowedTarget(host), false, host + ' 应被拒绝');
  }
});
await check('编码变体先归一（0x7f.0.0.1 / 2130706433）', () => {
  assert.equal(net.isAllowedTarget('0x7f.0.0.1'), false);
  assert.equal(net.isAllowedTarget('2130706433'), false);
  assert.equal(net.isAllowedTarget('[::ffff:7f00:1]'), false);
});
await check('域名同步判不出来时放行（交给 assertHost 解析后再判）', () => {
  assert.equal(net.isAllowedTarget('example.com'), true);
});
await check('本机保留名算内网', () => {
  for (const host of ['localhost', 'foo.internal', 'a.local']) {
    assert.equal(net.isAllowedTarget(host), false, host);
    assert.equal(net.isLoopback(host), true, host);
  }
});
await check('域名不被误判成本机（否则会绕过代理）', () => {
  assert.equal(net.isLoopback('example.com'), false);
});
await check('空主机名拒绝', () => {
  assert.equal(net.isAllowedTarget(''), false);
  assert.equal(net.isAllowedTarget('a b'), false);
});
await check('assertHost 对内网目标抛错', async () => {
  await assert.rejects(() => net.assertHost('127.0.0.1'), /非公网/);
});

console.log('\n3. 安全阀与工具阀：授权链路');
const cfgHolder = { value: { flowAuth: { enabled: true, gatedTools: ['qq_draw'] } } };
const security = createSecurityValve({ config: () => cfgHolder.value });
const tool = createToolValve({ auth: security.flowAuth, enabled: security.enabled, gatedTools: security.gatedTools });
await check('安全阀暴露契约字段', () => {
  // 只暴露「状态机 + 两个查询」；verifyToken / judgeHistory / checkOwnerCaller 那类薄包装
  // 曾经在这里，实际零调用，已删（判定实现直接 import 各自模块）。
  for (const key of ['flowAuth', 'flowStore', 'enabled', 'gatedTools']) {
    assert.ok(security[key] !== undefined, '缺少 ' + key);
  }
  for (const gone of ['verifyToken', 'verifyRecovery', 'judgeHistory', 'checkOwnerCaller']) {
    assert.equal(security[gone], undefined, '不该再暴露 ' + gone);
  }
});
await check('工具阀只放行名单内的工具', () => {
  assert.equal(tool.isGated('qq_draw'), true);
  assert.equal(tool.isGated('qqbot'), false);
  assert.deepEqual(tool.names(), ['qq_draw']);
});
await check('动态码关闭时名单不生效', () => {
  cfgHolder.value = { flowAuth: { enabled: false, gatedTools: ['qq_draw'] } };
  assert.equal(tool.isGated('qq_draw'), false);
  cfgHolder.value = { flowAuth: { enabled: true, gatedTools: ['qq_draw'] } };
});
await check('没有授权时拒绝', () => {
  const verdict = tool.check('10001', 'qq_draw');
  assert.equal(verdict.allow, false);
  assert.equal(verdict.reason, 'no-grant');
});
await check('授权只能用一次', () => {
  tool.remember('10002', 'grant-x');
  // 这张 grant 不在 auth 里（伪造的），第一次就该被拒——这里锁的是「不会因为 remember 就放行」
  const first = tool.check('10002', 'qq_draw');
  assert.equal(first.allow, false);
  assert.equal(tool.check('10002', 'qq_draw').allow, false);
});
await check('被拦下时有可读的中文说明', () => {
  const text = tool.blockedText('no-grant');
  assert.ok(text.includes('授权'), text);
});

console.log('\n4. 组装根：按优先级成型');
await check('assembleValves 返回三道阀门且顺序正确', () => {
  const a = assembleValves({ config: () => ({ flowAuth: { enabled: true, gatedTools: ['qqbot'] } }) });
  assert.deepEqual(a.order, ['network', 'security', 'tool']);
  assert.equal(a.network.stage, STAGE.NETWORK);
  assert.equal(a.security.stage, STAGE.SECURITY);
  assert.equal(a.tool.stage, STAGE.TOOL);
  assert.equal(a.tool.isGated('qqbot'), true);
});
await check('组装后工具阀能拿到 gate 对象（安全阀在它之前成型）', () => {
  const a = assembleValves({ config: () => ({}) });
  assert.ok(a.tool.gate !== undefined);
  assert.equal(typeof a.security.flowAuth.takeGrant, 'function');
});

console.log('\n6. 传输层注册表');
await check('五种协议都有适配器路径', () => {
  const list = supportedProtocols();
  assert.deepEqual(list.sort(), ['milky', 'onebot11', 'onebot12', 'qq-official', 'satori']);
  for (const protocol of list) {
    const path = resolveAdapterPath(protocol);
    assert.ok(path.endsWith('.mjs'), protocol + ' -> ' + path);
  }
});
await check('未知协议回退 OneBot 11 入口', () => {
  assert.equal(resolveAdapterPath('nope'), resolveAdapterPath('onebot11'));
});

console.log('\n7. 代理归属：阀门决定，工具不持有');
// 阀门会改传输层的模块级状态，用完必须还原：断言中途抛错也要还原，
// 否则同一套件后面的断言会跑在「上一个阀门」的代理上。
const withValve = async (configured, body) => {
  const valve = createNetworkValve({ proxy: () => configured.value });
  try { return await body(valve); } finally { valve.uninstall(); }
};

await check('阀门成型后接管传输层的代理策略', async () => {
  const configured = { value: 'http://127.0.0.1:7890' };
  await withValve(configured, async () => {
    // 成型即安装解析器：传输层跟着阀门走
    assert.equal(currentProxy(), 'http://127.0.0.1:7890');
    configured.value = 'http://10.0.0.9:1080';
    assert.equal(currentProxy(), 'http://10.0.0.9:1080', '配置改了，传输层立刻跟着变');
    configured.value = '';
    assert.equal(currentProxy(), '', '配置清空即直连');
  });
  assert.equal(currentProxy(), '', '卸下后回到默认直连');
});
await check('网络阀门只暴露两个接口：流量管控 + 代理状态', async () => {
  const configured = { value: 'http://127.0.0.1:7890' };
  await withValve(configured, async (valve) => {
    // 接口一：流量管控
    assert.deepEqual(Object.keys(valve.traffic).sort(), ['createGuardProxy', 'fetchText', 'post', 'request']);
    // 接口二：代理状态（只读，不含任何出网能力）
    assert.deepEqual(Object.keys(valve.proxyStatus).sort(), ['hasProxy']);
    for (const name of Object.keys(valve.proxyStatus)) {
      assert.equal(typeof valve.proxyStatus[name], 'function');
      assert.notEqual(valve.proxyStatus[name].constructor.name, 'AsyncFunction', 'proxyStatus 不该是异步出网方法');
    }
    // 代理状态要如实反映配置，插件读它就能判断
    assert.equal(valve.proxyStatus.hasProxy(), true);
    configured.value = '';
    assert.equal(valve.proxyStatus.hasProxy(), false);
  });
});
await check('hasProxy 反映当前是否配了代理', async () => {
  const configured = { value: '' };
  await withValve(configured, async (valve) => {
    assert.equal(valve.proxyStatus.hasProxy(), false);
    configured.value = 'http://127.0.0.1:7890';
    assert.equal(valve.proxyStatus.hasProxy(), true);
  });
});

// 关键断言：代理**确实被用到网络上**，而不只是「内网目标被拒」。
// 内网目标在直连与代理两个分支都会被 assertPublicHost 拒掉，那种写法区分不了两条路径；
// 这里用一个必然连不上的死代理 + 公网目标：只有真的走了代理分支才会 ECONNREFUSED。
await check('配了代理时请求公网目标确实走代理分支（死代理必连不上）', async () => {
  const configured = { value: await deadProxyUrl() };
  let directHits = 0;
  __setNetworkHooks({
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async () => { directHits += 1; return { status: 200, body: '{"ok":1}', headers: {} }; },
  });
  try {
    await withValve(configured, async () => {
      let failure = '';
      try { await multiEngineRequest('GET', 'https://probe.example/x', {}, null); }
      catch (error) { failure = String(error && error.message ? error.message : error); }
      assert.ok(failure !== '', '死代理必须连不上（若成功说明根本没走代理）');
      assert.ok(/ECONNREFUSED|127\.0\.0\.1:9|连接|refused/i.test(failure), '应当是「连代理失败」而不是别的错误：' + failure);
      assert.equal(directHits, 0, '走代理分支时不该落到直连的 request 钩子');
    });
    // 对照组：清空代理后同样的请求应当走直连并命中注入的钩子
    directHits = 0;
    const ok = await multiEngineRequest('GET', 'https://probe.example/x', {}, null);
    assert.equal(ok.status, 200, '没配代理就该直连成功');
    assert.equal(directHits, 1, '直连分支应当命中 request 钩子');
  } finally { __setNetworkHooks(null); }
});
// 门面自己的出网方法也得测：qq_webfetch 走的就是 net.fetchText，
// 只测传输层的话「阀门把代理丢了」这类回归一条断言都抓不到。
await check('net.fetchText：配了代理走代理，没配代理走直连', async () => {
  let directHits = 0;
  __setNetworkHooks({
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async () => { directHits += 1; return { status: 200, body: 'hello', headers: {} }; },
  });
  try {
    // 配死代理：必须连不上代理（证明走的是代理分支，而不是偷偷直连）
    const dead = { value: await deadProxyUrl() };
    await withValve(dead, async (valve) => {
      let failure = '';
      try { await valve.traffic.fetchText('https://probe.example/x', { useProxy: true, timeoutMs: 4000 }); }
      catch (error) { failure = String(error && error.message ? error.message : error); }
      assert.ok(failure !== '', '死代理必须抓取失败（成功说明没走代理）');
      assert.equal(directHits, 0, '走代理时不该落到直连');
    });
    // 不配代理：应走直连并命中钩子
    directHits = 0;
    const plain = { value: '' };
    await withValve(plain, async (valve) => {
      const got = await valve.traffic.fetchText('https://probe.example/x', { useProxy: true, timeoutMs: 4000 });
      assert.equal(got.status, 200, '没配代理就该直连成功');
      assert.equal(directHits, 1, '直连分支应当命中 request 钩子');
    });
    // 显式 useProxy:false：即使配了代理也必须直连
    directHits = 0;
    const configured = { value: 'http://127.0.0.1:9' };
    await withValve(configured, async (valve) => {
      const got = await valve.traffic.fetchText('https://probe.example/x', { useProxy: false, timeoutMs: 4000 });
      assert.equal(got.status, 200, 'useProxy:false 必须直连');
      assert.equal(directHits, 1);
      // 返回契约：两条分支都得给 text。直连走 publicFetch 时它只给 body，
      // 不映射的话 qq_webfetch 永远读到 undefined（页面「成功」但正文为空）。
      assert.equal(got.text, 'hello', '直连分支必须把 body 映射成 text');
    });
  } finally { __setNetworkHooks(null); }
});
await check('工具源码里不再读 webSearch.proxy（只有 moli 分支例外）', async () => {
  const fs = await import('node:fs/promises');
  const read = (p) => fs.readFile(new URL('../lib/tools/' + p, import.meta.url), 'utf8');
  const websearch = await read('websearch.js');
  const imgsearch = await read('imgsearch.js');
  // 这两个文件整份都不该出现 proxy（含注释）。hasProxy() 是「问阀门有没有配代理」，
  // 属于合法用法，先剔掉再查，免得把正解当成违规。
  // 阀门的两个接口名（traffic / proxyStatus）与 hasProxy() 都是合法用法，先剔除再查。
  const strip = (src) => src.replace(/hasProxy/g, '').replace(/proxyStatus/g, '').replace(/traffic/g, '');
  assert.ok(!/proxy/i.test(strip(websearch)), 'websearch 不该出现 proxy');
  assert.ok(!/proxy/i.test(strip(imgsearch)), 'imgsearch 不该出现 proxy');
  const index = await read('index.js');
  // index.js 里只允许 moli 分支保留代理串：凡是提到 proxy 的非注释、非 import 行，
  // 必须同时提到 moli/guard（否则就是「工具自己决定代理」复活了）。
  // 注意：不能把 wsCfg 之类写进白名单——那样原来那行违规代码自己就能过。
  const lines = index.split('\n').filter((l) => /\bproxy\b/i.test(l)
    && !/^\s*\/\//.test(l)
    && !/^\s*import\b/.test(l)
    && !/^\s*\*/.test(l));
  // 允许的两种：moli 自己的上游代理、以及 guard-proxy（本地校验代理，不是出口代理）。
  // 注意白名单里绝不能出现 wsCfg / webSearch 这类「读配置」的线索——
  // 否则原来那行 `const proxy = wsCfg.proxy.trim()` 自己就能过。
  for (const line of lines) {
    assert.ok(/moli|guard-?proxy/i.test(line),
      '非 moli 分支不该碰代理串：' + line.trim().slice(0, 90));
  }
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail > 0) process.exit(1);
