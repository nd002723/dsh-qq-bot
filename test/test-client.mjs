#!/usr/bin/env node
/**
 * 客户端半边（lib/client/settings.js）的独立验证：不需要浏览器。
 *
 *   node test-client.mjs
 *
 * 做法：
 *   1. 模拟 DSH 的客户端模块加载器 window.__ModuleLoader__.load；
 *   2. 用最小 React stub 提供 createElement / useState / useCallback / useEffect；
 *   3. 真的 import 那个 bundle，拿到插件对象；
 *   4. 用假 ctx 跑 apply，断言它在 plugins.bundle.config 注册了本插件的配置面板；
 *   5. 调注入的 faces，断言设置读写走到正确的 Remote 方法；
 *   6. 真渲染一次组件（走完异步加载），断言表单字段都出来了。
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import { readFileSync } from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.join(here, '..', 'lib', 'client', 'settings.js');
// 模块 id 必须等于包名，而包名会变（0.12 起带作用域）——从 package.json 读，别再写死，
// 否则这条断言会在改名后继续“通过”，而线上 bundle 其实是坏的。
const PKG_ID = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8')).name;

let failures = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  if (!ok) failures += 1;
  console.log('  [' + (ok ? 'PASS' : 'FAIL') + '] ' + name + (ok || detail === '' ? '' : ' — ' + detail));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------- 最小 React stub

const reactRuntime = (() => {
  let states = [];
  let refs = [];
  let cursor = 0;
  let effects = [];
  return {
    createElement(type, props) {
      const children = [];
      for (let i = 2; i < arguments.length; i += 1) {
        const child = arguments[i];
        if (child === null || child === undefined || child === false || child === true) continue;
        if (Array.isArray(child)) { for (const item of child) if (item !== null && item !== undefined) children.push(item); }
        else children.push(child);
      }
      // 函数组件就地展开：真实 React 也是在渲染期调用它们，这里只是省掉了调度。
      // 不展开的话，像 ListInput 这种包了一层的字段在树里永远是个空节点，测不到。
      if (typeof type === 'function') {
        const merged = Object.assign({}, props || {});
        if (children.length > 0) merged.children = children.length === 1 ? children[0] : children;
        return type(merged);
      }
      return { type, props: props || {}, children };
    },
    useState(initial) {
      const index = cursor;
      cursor += 1;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], (next) => { states[index] = typeof next === 'function' ? next(states[index]) : next; }];
    },
    useCallback(fn) { cursor += 1; return fn; },
    useEffect(fn) { cursor += 1; effects.push(fn); },
    useMemo(fn) { cursor += 1; return fn(); },
    // useRef 必须跨渲染持久：ListInput 靠 committedHook 记住「上一次同步过的值」，
    // 每次渲染给个新对象的话，draft 变了输入框也不会跟着变（浏览器里不是这样）。
    useRef(value) {
      const index = cursor;
      cursor += 1;
      if (!(index in refs)) refs[index] = { current: value };
      return refs[index];
    },
    Fragment: 'Fragment',
    __beginRender() { cursor = 0; },
    // 测试专用：位置式 useState 的槽位读写（只给「必须改组件内部状态」的断言用）。
    __state(index) { return states[index]; },
    __setState(index, value) { states[index] = value; },
    __stateKeys() { return Object.keys(states); },
    __takeEffects() { const taken = effects; effects = []; return taken; },
  };
})();

// -------------------------------------------- 模拟客户端模块加载器

let registration = null;
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      if (definition === null || typeof definition !== 'object') throw new Error('load 需要对象');
      if (typeof definition.id !== 'string' || definition.id === '') throw new Error('load 需要字符串 id');
      if (typeof definition.factory !== 'function') throw new Error('load 需要 factory');
      registration = definition;
    },
  },
};

await import(pathToFileURL(BUNDLE).href);

try {
  console.log('\n1. 模块格式与导出');
  check('bundle 用 __ModuleLoader__.load 注册了自己', registration !== null);
  check('模块 id 与包名一致', registration && registration.id === PKG_ID, String(registration && registration.id));

  const fakeRequire = (spec) => {
    if (spec === 'react') return reactRuntime;
    throw new Error('未预期的外部依赖: ' + spec);
  };
  // 只允许 require('react')：真的 bundle 不该依赖别的东西
  const plugin = registration.factory(fakeRequire);
  check('导出了 name/inject/apply', typeof plugin.name === 'string' && Array.isArray(plugin.inject) && typeof plugin.apply === 'function');
  check('inject 声明了 slots 与 remote.settings（DSH ≥ 0.1.7 的要求）',
    Array.isArray(plugin.inject) && plugin.inject.includes('slots') && plugin.inject.includes('remote.settings'),
    JSON.stringify(plugin.inject));

  console.log('\n2. 注册设置选项卡');
  let injectName = null;
  let registered = null;
  const slotsCtx = {
    slots: {
      inject(name, callback) { injectName = name; return callback(); },
      register(options, component) { registered = { options, component }; return () => {}; },
    },
  };

  // 注意 onebot 里没有 accessToken：它是 secret，Host 侧的 redactSecrets 已经把它剔除了
  const SETTINGS_VALUE = {
    mode: 'forward',
    onebot: { wsUrl: 'ws://127.0.0.1:3001', listen: '0.0.0.0:6199', httpUrl: 'http://127.0.0.1:3000' },
    group: { enabled: true, allow: [], requireAt: true },
    private: { enabled: true, allow: [] },
    commandPrefix: '',
    reply: { maxChars: 1200, ackAfterMs: 8000, ackText: '正在处理，请稍候…', firstTurnHint: 'x', contextHeader: true },
    perChatSession: true,
    agentPreset: '',
    logAdapterFrames: false,
    auth: { owners: ['66666'], superAdmins: ['22222'], ownerPreset: '', guestPreset: '', grantTtlMinutes: 60, grantMaxTtlMinutes: 1440, guestDshTools: false, guestToolAllow: ['qqbot', 'qqgroup'] },
    admin: { enabled: true, manageGroups: [], requireGroupAdmin: true, prefix: '/', dryRun: false, allowConsole: false },
    // 闸门区：动态码开着，用于验证「名单默认锁定」与「闸门区字段存在」。
    flowAuth: { enabled: true, gatedTools: ['subagent', 'moli_fetch'], gateEditCode: '', grantTtlSeconds: 30 },
    // 表情包图库关着：验证「未启用就折叠」这条默认行为。
    sticker: { enabled: false, dir: '', autoTag: true, provider: '', model: '', maxPerRun: 40, timeoutMs: 60000 },
  };
  // dsh-moli 引擎检测的假数据：插件清单 + 它自己命名空间里的 engineState/engineVersion。
  // 默认「插件装了但停用、引擎就绪」——正好验证「只借它装引擎」这条设计。
  let moliPluginRows = [{ entryId: 'dsh-moli', moduleName: 'dsh-moli', enabled: false, fiberPhase: 'active' }];
  let moliEngine = { engineState: 'installed', engineVersion: 'moli 1.1.19' };
  const fakePluginManager = { async listPlugins() { return { ok: true, value: moliPluginRows }; } };
  const mutateCalls = [];
  const fakeSettingsApi = {
    async describe() {
      const namespaces = [{ ns: 'dsh-qq-bot', value: SETTINGS_VALUE, revision: 7, secrets: [{ path: ['onebot', 'accessToken'], set: true }, { path: ['flowAuth', 'totpSecret'], set: true }] }];
      if (moliEngine !== null) namespaces.push({ ns: 'dsh-moli', value: moliEngine, revision: 1, secrets: [] });
      return { ok: true, value: { writable: true, hasDocument: true, namespaces } };
    },
    async mutate(ns, ops, revision) { mutateCalls.push({ ns, ops, revision }); return { ok: true, value: { ns, revision: 8 } }; },
  };
  slotsCtx.get = (name) => {
    if (name === 'remote.settings') return fakeSettingsApi;
    if (name === 'remote.pluginManager') return fakePluginManager;
    return undefined;
  };

  plugin.apply(slotsCtx);
  check('注入到 plugins.bundle.config（插件详情页配置区）', injectName === 'plugins.bundle.config', String(injectName));
  check('注册项 name=plugins.bundle.config', registered && registered.options.name === 'plugins.bundle.config');
  check('注册项 key 与包名一致（插件页按 pkg.name 派发）', registered && registered.options.key === PKG_ID, String(registered && registered.options.key));
  check('不再注册旧的 settings.section 入口', injectName !== 'settings.section', String(injectName));
  check('提供了组件', registered && typeof registered.component === 'function');

  const faces = registered.options.inject();
  check('注入面里有 loadConfig / saveConfig', typeof faces.loadConfig === 'function' && typeof faces.saveConfig === 'function');

  console.log('\n3. 设置读写走对 Remote');
  const loaded = await faces.loadConfig();
  check('loadConfig 找到 dsh-qq-bot 命名空间', loaded.ok === true && loaded.value && loaded.value.onebot.wsUrl === 'ws://127.0.0.1:3001', JSON.stringify(loaded).slice(0, 120));
  check('loadConfig 带回了 revision', loaded.revision === 7, String(loaded.revision));

  const saved = await faces.saveConfig([{ op: 'set', path: ['onebot', 'wsUrl'], value: 'ws://10.0.0.5:3001' }], loaded.revision);
  check('saveConfig 调用了 mutate', mutateCalls.length === 1 && mutateCalls[0].ns === 'dsh-qq-bot', JSON.stringify(mutateCalls).slice(0, 120));
  check('mutate 收到了正确的路径操作', mutateCalls[0].ops[0].op === 'set' && mutateCalls[0].ops[0].path.join('.') === 'onebot.wsUrl');
  check('mutate 收到了 revision（乐观并发）', mutateCalls[0].revision === 7, String(mutateCalls[0].revision));
  check('saveConfig 返回 ok', saved.ok === true);

  console.log('\n3b. 条目被改名时仍能找到（回退匹配）');
  const renamedApi = {
    async describe() { return { ok: true, value: { writable: true, hasDocument: true, namespaces: [{ ns: 'my-qq-bot', value: SETTINGS_VALUE, revision: 3, secrets: [] }] } }; },
    async mutate(ns, ops, revision) { return { ok: true, value: { ns, revision } }; },
  };
  let renamedRegistered = null;
  const renamedCtx = {
    slots: {
      inject(name, callback) { return callback(); },
      register(options, component) { renamedRegistered = { options, component }; return () => {}; },
    },
    get: (name) => (name === 'remote.settings' ? renamedApi : undefined),
  };
  plugin.apply(renamedCtx);
  const renamedLoaded = await renamedRegistered.options.inject().loadConfig();
  check('改名后回退匹配成功', renamedLoaded.ok === true && renamedLoaded.revision === 3, JSON.stringify(renamedLoaded).slice(0, 140));

  console.log('\n4. 真实渲染一次（走完异步加载）');
  // 设置页模板：字段定义现在住在 lib/**/*-set.json 里，由服务端组装后下发。
  // 测试直接用同一份组装结果，避免测试自己维护一份会过期的字段表。
  const settingsModule = await import(pathToFileURL(path.join(here, '..', 'lib', 'config.js')).href);
  const template = { tabs: settingsModule.SETTINGS_TABS, fields: settingsModule.SETTINGS_FIELDS };
  const props = {
    ...faces,
    loadTemplate: () => Promise.resolve({ ok: true, value: template }),
    close: () => {},
  };
  reactRuntime.__beginRender();
  const first = registered.component(props);
  check('首次渲染（加载中）不抛错', first !== null && typeof first === 'object');
  for (const effect of reactRuntime.__takeEffects()) effect();
  await sleep(40);
  reactRuntime.__beginRender();
  const tree = registered.component(props);
  check('加载完成后渲染出表单', tree !== null && typeof tree === 'object');

  const texts = [];
  const collect = (node) => {
    if (node === null || node === undefined) return;
    if (typeof node === 'string' || typeof node === 'number') { texts.push(String(node)); return; }
    if (Array.isArray(node)) { for (const item of node) collect(item); return; }
    if (typeof node === 'object') { for (const child of node.children || []) collect(child); }
  };
  collect(tree);
  const joined = texts.join(' | ');
  // 默认打开的是第一个标签「连接」
  const expectLabels = ['协议', '连接方式', '正向 WS 地址', 'HTTP API 地址', 'access_token', '保存', '重新读取'];
  check('默认标签页含连接类关键字段', expectLabels.every((label) => joined.includes(label)),
    expectLabels.filter((label) => !joined.includes(label)).join(','));
  check('默认标签页不显示群聊/权限等基本组字段',
    !joined.includes('群号白名单') && !joined.includes('拥有者账号'), joined.slice(0, 160));
  check('反向模式时才出现监听地址（forward 下不出现）', !joined.includes('反向 WS 监听地址'), joined.slice(0, 120));

  const findByTextEarly = (node, text) => {
    if (node === null || node === undefined || typeof node !== 'object') return null;
    if (Array.isArray(node)) { for (const item of node) { const hit = findByTextEarly(item, text); if (hit) return hit; } return null; }
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        if (typeof child === 'string' && child === text) return node;
        const hit = findByTextEarly(child, text);
        if (hit) return hit;
      }
    }
    const pc = node.props && node.props.children;
    const pcList = Array.isArray(pc) ? pc : (pc === undefined || pc === null ? [] : [pc]);
    for (const child of pcList) {
      if (typeof child === 'string' && child === text) return node;
      const hit = findByTextEarly(child, text);
      if (hit) return hit;
    }
    return null;
  };
  console.log('\n4b. 顶端标签四档分类（连接 / 基本 / 能力 / 高级）');
  const collectButtons = (node, out) => {
    if (node === null || node === undefined || typeof node !== 'object') return out;
    if (Array.isArray(node)) { for (const item of node) collectButtons(item, out); return out; }
    if (node.type === 'button') out.push(node);
    for (const child of node.children || []) collectButtons(child, out);
    return out;
  };
  // mock createElement 把子节点放 .children（真实 React 放 props.children），两者都读。
  const childText = (node) => {
    if (Array.isArray(node.children) && node.children.length > 0) return node.children[0];
    const pc = node.props && node.props.children;
    if (Array.isArray(pc)) return pc[0];
    return pc;
  };
  const tabLabels = collectButtons(tree, []).filter((b) => b.props.role === 'tab' && b.props['data-tab'] !== undefined).map(childText);
  check('顶端渲染出四个标签', tabLabels.length === 4, JSON.stringify(tabLabels));
  check('标签为 连接 / 基本 / 能力 / 高级（连接排最前）', tabLabels.join(',') === '连接,基本,能力,高级', JSON.stringify(tabLabels));
  check('默认选中的是第一个「连接」标签',
    collectButtons(tree, []).some((b) => b.props.role === 'tab' && b.props['aria-selected'] === 'true' && childText(b) === '连接'),
    JSON.stringify(tabLabels));

  const clickTab = (label) => {
    const btn = collectButtons(tree, []).find((b) => b.props.role === 'tab' && childText(b) === label);
    if (!btn) return null;
    btn.props.onClick();
    reactRuntime.__beginRender();
    return registered.component(props);
  };

  // 通用取文本
  const textsOf = (node) => {
    const out = [];
    const walk = (n) => {
      if (n === null || n === undefined) return;
      if (typeof n === 'string' || typeof n === 'number') { out.push(String(n)); return; }
      if (Array.isArray(n)) { for (const item of n) walk(item); return; }
      if (typeof n === 'object') { for (const child of n.children || []) walk(child); }
    };
    walk(node);
    return out.join(' | ');
  };

  // 切到「基本」：默认二级标签「准入与名单」
  const basicTree = clickTab('基本');
  const basicJoined = textsOf(basicTree);
  const accessLabels = ['群里必须 @ 机器人才回复', '群号白名单', '拥有者账号', '后台设定的高级管理员', '允许非拥有者使用 DSH 内部工具', '访客仍可用的工具白名单'];
  check('基本页默认「准入与名单」含群聊私聊与权限字段', accessLabels.every((label) => basicJoined.includes(label)),
    accessLabels.filter((label) => !basicJoined.includes(label)).join(','));
  check('准入名单页不含发言类字段（单条最大字数/演练模式）',
    !basicJoined.includes('单条最大字数') && !basicJoined.includes('演练模式（只回复将执行什么）'), basicJoined.slice(0, 160));
  check('基本页不再显示连接类字段（协议/连接方式）',
    !basicJoined.includes('正向 WS 地址') && !basicJoined.includes('access_token'), basicJoined.slice(0, 160));
  check('基本页底部保存/重新读取仍在', findByTextEarly(basicTree, '保存') !== null);

  // 基本页的二级标签：准入与名单 / 发言与管理
  const basicSubLabels = collectButtons(basicTree, [])
    .filter((b) => b.props.role === 'tab' && b.props['data-subtab'] !== undefined).map(childText);
  check('基本页渲染出两个二级标签', basicSubLabels.length === 2, JSON.stringify(basicSubLabels));
  check('二级标签为 准入与名单 / 发言与管理',
    basicSubLabels.join(',') === '准入与名单,发言与管理', JSON.stringify(basicSubLabels));

  const clickBasicSub = (label) => {
    const btn = collectButtons(basicTree, [])
      .find((b) => b.props.role === 'tab' && b.props['data-subtab'] !== undefined && childText(b) === label);
    if (!btn) return null;
    btn.props.onClick();
    reactRuntime.__beginRender();
    return registered.component(props);
  };

  const basicGovernJoined = textsOf(clickBasicSub('发言与管理'));
  check('发言与管理页含命令前缀/回复策略/群管理字段',
    basicGovernJoined.includes('命令前缀') && basicGovernJoined.includes('单条最大字数')
    && basicGovernJoined.includes('可管理的群号') && basicGovernJoined.includes('演练模式（只回复将执行什么）'),
    basicGovernJoined.slice(0, 200));
  // 注意：管理组的说明文字里会合法地提到「群号白名单」（回退关系），
  // 所以这里只断言准入组独有的字段标签不出现。
  check('发言与管理页不含准入名单字段（拥有者/私聊开关/必须 @）',
    !basicGovernJoined.includes('拥有者账号') && !basicGovernJoined.includes('启用私聊')
    && !basicGovernJoined.includes('群里必须 @ 机器人才回复'), basicGovernJoined.slice(0, 160));
  check('切到发言与管理后底部保存仍在', findByTextEarly(clickBasicSub('发言与管理'), '保存') !== null);
  // 回到「准入与名单」，保持后续断言（basicJoined）语义
  clickBasicSub('准入与名单');

  // 切到「能力」：默认显示第一个二级标签「识图与绘图」
  const capTree = clickTab('能力');
  const capJoined = textsOf(capTree);
  check('能力页默认二级标签为「识图与绘图」（含视觉与生图）',
    capJoined.includes('图片视觉') && capJoined.includes('生图（qq_draw）'), capJoined.slice(0, 160));
  check('识图与绘图页不含检索类字段（联网搜索代理）',
    !capJoined.includes('联网搜索 HTTP 代理'), capJoined.slice(0, 160));
  check('能力页不显示基本组字段（群号白名单）', !capJoined.includes('群号白名单'), capJoined.slice(0, 120));
  check('切到能力页后底部保存/重新读取仍常驻',
    findByTextEarly(capTree, '保存') !== null && findByTextEarly(capTree, '重新读取') !== null);

  // 二级标签：都在，且能切换（表情包是 0.13 新增的第四个）
  const subLabels = collectButtons(capTree, [])
    .filter((b) => b.props.role === 'tab' && b.props['data-subtab'] !== undefined).map(childText);
  check('能力页渲染出四个二级标签', subLabels.length === 4, JSON.stringify(subLabels));
  check('二级标签为 识图与绘图 / 搜索与抓取 / 对话与人格 / 表情包',
    subLabels.join(',') === '识图与绘图,搜索与抓取,对话与人格,表情包', JSON.stringify(subLabels));

  const clickSubTabIn = (root, label) => {
    const btn = collectButtons(root, [])
      .find((b) => b.props.role === 'tab' && b.props['data-subtab'] !== undefined && childText(b) === label);
    if (!btn) return null;
    btn.props.onClick();
    reactRuntime.__beginRender();
    return registered.component(props);
  };
  const clickSubTab = (label) => clickSubTabIn(capTree, label);

  const capRetrievalTree = clickSubTab('搜索与抓取');
  const capRetrievalJoined = textsOf(capRetrievalTree);
  check('搜索与抓取页含联网搜索与图片反搜',
    capRetrievalJoined.includes('联网搜索 HTTP 代理') && capRetrievalJoined.includes('图片反搜'), capRetrievalJoined.slice(0, 200));

  // 找带某个 data-* 标记的元素（卡片里的开关 / 检测按钮）。
  const findDataSet = (node, key) => {
    if (node === null || node === undefined || typeof node !== 'object') return null;
    if (Array.isArray(node)) { for (const item of node) { const hit = findDataSet(item, key); if (hit) return hit; } return null; }
    if (node.props && node.props[key] !== undefined) return node;
    for (const child of node.children || []) { const hit = findDataSet(child, key); if (hit) return hit; }
    return null;
  };

  check('搜索与抓取页把 moli 收成一张卡片',
    capRetrievalJoined.includes('Moli 渲染抓取') && capRetrievalJoined.includes('dsh-moli 装引擎 · qq_webfetch 渲染抓取')
    && !capRetrievalJoined.includes('Moli HTTP 代理') && !capRetrievalJoined.includes('moli 可执行文件路径'),
    capRetrievalJoined.slice(0, 300));
  check('卡片显示引擎就绪（带引擎版本）',
    capRetrievalJoined.includes('引擎就绪') && capRetrievalJoined.includes('moli 1.1.19'), capRetrievalJoined.slice(0, 320));
  check('dsh-moli 停用了也不影响（只借它装引擎）',
    capRetrievalJoined.includes('启不启用它都无所谓') || capRetrievalJoined.includes('启不启用'), capRetrievalJoined.slice(0, 420));
  const moliToggleInstalled = findDataSet(capRetrievalTree, 'data-moli-toggle');
  check('引擎就绪时 moli 开关可点（未禁用）',
    moliToggleInstalled !== null && moliToggleInstalled.props.disabled !== true,
    JSON.stringify(moliToggleInstalled && moliToggleInstalled.props));
  const moliProbeBtn = findDataSet(capRetrievalTree, 'data-moli-probe');
  check('卡片带「检测」按钮', moliProbeBtn !== null && childText(moliProbeBtn) === '检测', String(moliProbeBtn && childText(moliProbeBtn)));

  // 启用状态下的「高级设置」折叠区：默认收起，点开才出现 moli 的参数
  const moliAdvBtn = findDataSet(capRetrievalTree, 'data-moli-advanced');
  check('引擎就绪时卡片有「高级设置」折叠按钮',
    moliAdvBtn !== null && childText(moliAdvBtn) === '高级设置 ▸', String(moliAdvBtn && childText(moliAdvBtn)));
  check('折叠区默认收起（不渲染参数项）', !capRetrievalJoined.includes('渲染超时（毫秒）'), capRetrievalJoined.slice(0, 300));
  moliAdvBtn.props.onClick();
  reactRuntime.__beginRender();
  const capAdvanced = registered.component(props);
  const advancedJoined = textsOf(capAdvanced);
  check('展开后复刻 dsh-moli 1.1.20 的五项参数',
    advancedJoined.includes('moli 可执行文件路径') && advancedJoined.includes('渲染抓取代理')
    && advancedJoined.includes('渲染超时（毫秒）') && advancedJoined.includes('单次输出上限（字符）')
    && advancedJoined.includes('跳过 TLS 证书校验'), advancedJoined.slice(0, 600));
  const moliAdvBtnOpen = findDataSet(capAdvanced, 'data-moli-advanced');
  check('展开后按钮变成「高级设置 ▾」',
    moliAdvBtnOpen !== null && childText(moliAdvBtnOpen) === '高级设置 ▾', String(moliAdvBtnOpen && childText(moliAdvBtnOpen)));
  moliAdvBtnOpen.props.onClick();
  reactRuntime.__beginRender();
  check('再点一次收起', !textsOf(registered.component(props)).includes('渲染超时（毫秒）'));
  reactRuntime.__beginRender();
  // 这里必须用重渲染后的新树：以前误用了上一轮的快照 capRetrievalJoined，断言等于在验旧状态。
  const capRetrievalJoined2 = textsOf(registered.component(props));
  check('搜索与抓取页不显示生图与视觉字段',
    !capRetrievalJoined2.includes('生图（qq_draw）') && !capRetrievalJoined2.includes('图片视觉'), capRetrievalJoined2.slice(0, 160));

  const capVisionJoined = textsOf(clickSubTab('识图与绘图'));
  check('识图与绘图页含图片识别窗口两项',
    capVisionJoined.includes('识图往回找几条消息') && capVisionJoined.includes('这个范围内最多识别几张图'),
    capVisionJoined.slice(0, 240));
  check('图片识别窗口排在生图（qq_draw）之前',
    capVisionJoined.indexOf('识图往回找几条消息') !== -1
    && capVisionJoined.indexOf('识图往回找几条消息') < capVisionJoined.indexOf('生图（qq_draw）'),
    JSON.stringify([capVisionJoined.indexOf('识图往回找几条消息'), capVisionJoined.indexOf('生图（qq_draw）')]));

  const capDialogueJoined = textsOf(clickSubTab('对话与人格'));
  check('对话与人格页含人格与主动发言',
    capDialogueJoined.includes('自定义人格') && capDialogueJoined.includes('启用主动发言'),
    capDialogueJoined.slice(0, 200));
  check('对话与人格页含主动发言的事件去重三项（上游 0.10.1 字段）',
    capDialogueJoined.includes('事件去重（防重复回复）') && capDialogueJoined.includes('事件过气阈值')
    && capDialogueJoined.includes('话题冷却'), capDialogueJoined.slice(0, 240));
  check('对话与人格页不显示视觉与检索字段',
    !capDialogueJoined.includes('图片视觉') && !capDialogueJoined.includes('联网搜索 HTTP 代理')
    && !capDialogueJoined.includes('识图往回找几条消息'), capDialogueJoined.slice(0, 160));
  check('切二级标签后底部保存/重新读取仍常驻',
    findByTextEarly(clickSubTab('搜索与抓取'), '保存') !== null);

  // ---- 卡片交互：没有引擎时开关强制不可启用（点「检测」刷新）----
  moliPluginRows = [];
  moliEngine = null;
  const capBeforeProbe = clickSubTab('搜索与抓取');
  const probeBtn2 = findDataSet(capBeforeProbe, 'data-moli-probe');
  check('检测按钮可点（没装时也能刷新状态）', probeBtn2 !== null && probeBtn2.props.disabled !== true);
  probeBtn2.props.onClick();
  reactRuntime.__beginRender();
  await sleep(40);
  const capMissing = registered.component(props);
  const missingJoined = textsOf(capMissing);
  check('重新检测后显示「未装 dsh-moli」', missingJoined.includes('未装 dsh-moli'), missingJoined.slice(0, 240));
  const moliToggleMissing = findDataSet(capMissing, 'data-moli-toggle');
  check('没装时 moli 开关被禁用（不可启用）',
    moliToggleMissing !== null && moliToggleMissing.props.disabled === true,
    JSON.stringify(moliToggleMissing && moliToggleMissing.props));
  check('没装时开关显示为关闭',
    moliToggleMissing !== null && moliToggleMissing.props.checked === false,
    JSON.stringify(moliToggleMissing && moliToggleMissing.props));
  check('引导文本说明 dsh-moli 只用来装引擎', missingJoined.includes('它只是用来装 Moli 引擎的'), missingJoined.slice(0, 400));
  const moliRepoLink = findDataSet(capMissing, 'data-moli-repo');
  check('没装时给出 dsh-moli 仓库链接',
    moliRepoLink !== null && moliRepoLink.type === 'a'
    && moliRepoLink.props.href === 'https://github.com/27painter/dsh-moli'
    && moliRepoLink.props.target === '_blank' && moliRepoLink.props.rel === 'noopener noreferrer',
    JSON.stringify(moliRepoLink && moliRepoLink.props));
  check('链接文案指向 dsh-moli 仓库',
    moliRepoLink !== null && childText(moliRepoLink) === '去 GitHub 看 dsh-moli →',
    String(moliRepoLink && childText(moliRepoLink)));
  check('引擎就绪时不显示安装链接', findDataSet(capRetrievalTree, 'data-moli-repo') === null);
  // 折叠入口与 canToggle 解绑：引擎没装好时仍然能点开「高级设置」（比如先填引擎路径救场）。
  // 以前这里断言「没装就看不到入口」，那正是本次要修的行为。
  check('没装时也能点开「高级设置」（入口不再跟引擎状态绑定）',
    findDataSet(capMissing, 'data-moli-advanced') !== null,
    JSON.stringify(findDataSet(capMissing, 'data-moli-advanced') === null ? null : 'present'));

  // ---- 插件在、引擎缺失：同样不可启用 ----
  moliPluginRows = [{ entryId: 'dsh-moli', moduleName: 'dsh-moli', enabled: true, fiberPhase: 'active' }];
  moliEngine = { engineState: 'missing', engineVersion: '' };
  const capEngineMissing = clickSubTab('搜索与抓取');
  findDataSet(capEngineMissing, 'data-moli-probe').props.onClick();
  reactRuntime.__beginRender();
  await sleep(40);
  const capEngineTree = registered.component(props);
  const engineJoined = textsOf(capEngineTree);
  check('插件在但引擎缺失时显示「引擎缺失」', engineJoined.includes('引擎缺失'), engineJoined.slice(0, 300));
  const toggleEngineMissing = findDataSet(capEngineTree, 'data-moli-toggle');
  check('引擎缺失时开关不可启用',
    toggleEngineMissing !== null && toggleEngineMissing.props.disabled === true,
    JSON.stringify(toggleEngineMissing && toggleEngineMissing.props));

  // 复原，后面的「高级」页测试继续用引擎就绪态
  moliPluginRows = [{ entryId: 'dsh-moli', moduleName: 'dsh-moli', enabled: false, fiberPhase: 'active' }];
  moliEngine = { engineState: 'installed', engineVersion: 'moli 1.1.19' };

  // 切到「高级」：三个二级标签（流程授权 / 闸门区 / 会话与排错）。闸门区单独一档，
  // 里面是「哪些工具要动态码」+ 改名单用的动态码（填码解锁、保存即消费）。
  const advTree = clickTab('高级');
  const advSubTabs = collectButtons(advTree, [])
    .filter((b) => b.props.role === 'tab' && b.props['data-subtab'] !== undefined)
    .map((b) => childText(b));
  check('高级页有三个二级标签（流程授权 / 闸门区 / 会话与排错）',
    JSON.stringify(advSubTabs) === JSON.stringify(['流程授权', '闸门区', '会话与排错']), JSON.stringify(advSubTabs));

  const advFlowJoined = textsOf(advTree);
  // 密钥是 role(secret)，远程读会脱敏成空串：这时必须靠 isSecret 判断「配过没有」，
  // 否则页面会说「还没有可用密钥」并给出「生成密钥」按钮，一点就覆盖线上密钥。
  check('已配密钥（被脱敏）时不再显示「还没有可用密钥」',
    advFlowJoined.includes('密钥已经配置好了') && advFlowJoined.includes('还没有可用密钥') === false,
    advFlowJoined.slice(0, 200));
  check('流程授权页含闸门开关与绑定二维码区',
    advFlowJoined.includes('流程授权（子代理 / 队友 / 工作流先要私聊动态码）')
    && advFlowJoined.includes('绑定二维码'), advFlowJoined.slice(0, 240));

  const gateJoined = textsOf(clickSubTabIn(advTree, '闸门区'));
  check('闸门区含「需要动态码的工具名」与「改名单用的动态码」',
    gateJoined.includes('需要动态码的工具名') && gateJoined.includes('改名单用的动态码'), gateJoined.slice(0, 240));
  check('动态码开着时闸门名单默认锁定（有「已锁定」提示）',
    gateJoined.includes('已锁定'), gateJoined.slice(0, 240));

  const advJoined = textsOf(clickSubTabIn(advTree, '会话与排错'));
  check('高级页含会话命名与排错项',
    advJoined.includes('固定新建会话名') && advJoined.includes('日志打印每一帧'), advJoined.slice(0, 120));
  check('高级页不显示能力组字段（生图）', !advJoined.includes('生图（qq_draw）'), advJoined.slice(0, 120));
  check('连接页没有二级标签',
    collectButtons(tree, []).filter((b) => b.props.role === 'tab' && b.props['data-subtab'] !== undefined).length === 0);

  console.log('\n4c. 重叠项处理（preset 优先级 / 人格兜底 / key 回退链 / 视觉风险提示）');
  // 第 4 项：四个 preset 字段集中在「高级」，且带优先级编号
  check('高级页含 preset 优先级分组（①②③ 都在）',
    advJoined.includes('① 自定义 agent preset id') && advJoined.includes('② 拥有者会话的 preset')
    && advJoined.includes('② 非拥有者会话的 preset') && advJoined.includes('③ Agent preset'),
    advJoined.slice(0, 160));
  check('高级页写明 preset 生效优先级', advJoined.includes('① 自定义 id > ② 拥有者/访客分流 > ③ 本项'), advJoined.slice(0, 200));
  check('基本页不再出现 agent preset 字段（已集中到高级）',
    !basicJoined.includes('拥有者会话的 agent preset') && !basicJoined.includes('非拥有者会话的 agent preset'), basicJoined.slice(0, 160));
  check('能力页不再出现自定义 preset id（已移到高级）', !capJoined.includes('自定义 agent preset id'));

  // 第 5 项：人格兜底关系写清
  check('主动发言人设标注「复用全局人格」', capDialogueJoined.includes('主动发言人设（留空 = 复用全局人格）'), capDialogueJoined.slice(0, 160));
  check('全局人格说明提到主动发言会复用', capDialogueJoined.includes('主动发言未单独设人设时也会复用这里'), capDialogueJoined.slice(0, 200));

  // 第 6 项：三处 key 的回退链与独立性
  // 空选项文案现在跟随字段自己的 placeholder（判断阶段是「群会话模型」，发言阶段是「与判断阶段相同」）。
  check('主动发言 provider 是模型目录下拉（留空 = 群会话模型）', capDialogueJoined.includes('（留空 = 群会话模型）'), capDialogueJoined.slice(0, 240));
  check('发言阶段 provider 留空时，发言模型标明自动跟随、不给单独设',
    capDialogueJoined.includes('发言模型自动跟随判断模型，不用单独设'), capDialogueJoined.slice(0, 600));
  check('生图 key 说明不再给主动发言兜底', capJoined.includes('不再给主动发言兜底'), capJoined.slice(0, 240));
  check('搜索 key 声明与生图/主动发言互不影响', capRetrievalJoined.includes('与生图的 key 互不影响'), capRetrievalJoined.slice(0, 200));

  // 第 8 项：视觉留空 = 会话模型的风险提示
  check('视觉 provider 标注会话模型不一定支持图片', capJoined.includes('会话模型不一定支持图片'), capJoined.slice(0, 200));
  check('视觉 model 说明留空时会探测并回报可读错误', capJoined.includes('它会先探测是否支持图片'), capJoined.slice(0, 200));

  console.log('\n4d. 审查补齐的字段（OneBot 12 接入方式 / 主动发言模型下拉与超时）');
  check('主动发言 model 跟随 provider 下拉且未选时禁用',
    capDialogueJoined.includes('留空 = 跟随会话模型；想指定模型，先在上面的 provider 里选一个'), capDialogueJoined.slice(0, 260));
  check('主动发言不再出现自定义端点三件套',
    !capDialogueJoined.includes('判断用接口地址') && !capDialogueJoined.includes('判断用 API key'), capDialogueJoined.slice(0, 260));
  check('对话与人格页含「判断请求超时」',
    capDialogueJoined.includes('判断请求超时（毫秒）'), capDialogueJoined.slice(0, 240));

  // OneBot 12 的接入方式只在 protocol=onebot12 时出现
  const draftOnebot12 = JSON.parse(JSON.stringify(SETTINGS_VALUE));
  draftOnebot12.protocol = 'onebot12';
  // 通过渲染验证 when() 分支：切回连接页、改协议需要走内部 draft，
  // 这里直接验证 FIELDS 里该字段存在且带 select 选项（结构断言）。
  const bundleSource = (await import('node:fs')).readFileSync(BUNDLE, 'utf8');
  // 字段定义已经搬出 bundle（住在 lib/**/*-set.json），所以这里断言的是组装后的模板，
  // 不再去源码里正则匹配字段字面量。
  const tplField = (dotted) => settingsModule.SETTINGS_FIELDS.find((f) => f.path.join('.') === dotted);
  const ob12Mode = tplField('protocols.onebot12.mode');
  check('设置页含 OneBot 12 接入方式字段',
    ob12Mode !== undefined && ob12Mode.kind === 'select' && ob12Mode.options.length === 2,
    ob12Mode === undefined ? '模板里没有该字段' : JSON.stringify(ob12Mode.options));
  const ob12Ws = tplField('protocols.onebot12.wsUrl');
  const ob12Listen = tplField('protocols.onebot12.listen');
  check('OneBot 12 正向/反向字段按 mode 显隐',
    ob12Ws !== undefined && ob12Listen !== undefined
    && ob12Ws.when && ob12Ws.when['protocols.onebot12.mode'] && ob12Ws.when['protocols.onebot12.mode'].$ne === 'reverse'
    && ob12Listen.when && ob12Listen.when['protocols.onebot12.mode'] === 'reverse',
    '正向应 when mode != reverse，反向应 when mode == reverse');
  check('不再有死样式 heading', !/^\s{6}heading:/m.test(bundleSource));
  // 迁移的回归护栏：字段定义不许再回到 bundle 里（否则又会变成「改个字段要动前端」）。
  check('bundle 里不再写死字段定义',
    !/path: \['[a-zA-Z]+', '[a-zA-Z]+'\], label:/.test(bundleSource));

  console.log('\n4e. 设置页字段覆盖 schema（防止上游新增字段被静默漏掉）');
  const { Config: ConfigSchema } = await import('../lib/config.js');
  const walkSchema = (node, trail, out) => {
    if (node === null || node === undefined) return;
    if (!node.dict) { out.push(trail.join('.')); return; }
    for (const key of Object.keys(node.dict)) walkSchema(node.dict[key], trail.concat(key), out);
  };
  const schemaLeaves = [];
  walkSchema(ConfigSchema, [], schemaLeaves);
  // 有意不暴露：非 volatile（改它们会整体重挂插件）或纯内部路径
  const NOT_EXPOSED = new Set(['adapterPath', 'nodePath', 'reply.firstTurnHint', 'restart.baseMs', 'restart.maxMs']);
  // virtual: true 的字段是「纯界面卡片」（例如扫码绑定），不对应 schema 里的配置项，
  // 不参与「有没有拼错路径」的比对。字段来源改为组装后的模板。
  const exposedPaths = new Set(settingsModule.SETTINGS_FIELDS
    .filter((f) => f.virtual !== true)
    .map((f) => f.path.join('.')));
  const uncovered = schemaLeaves.filter((leafPath) => !NOT_EXPOSED.has(leafPath) && !exposedPaths.has(leafPath));
  check('schema 里可配置的字段全部出现在设置页', uncovered.length === 0, '漏掉：' + uncovered.join(', '));
  const orphanFields = [...exposedPaths].filter((onlyInUi) => !schemaLeaves.includes(onlyInUi));
  check('设置页没有拼错的字段路径（每个都在 schema 里）', orphanFields.length === 0, '多出：' + orphanFields.join(', '));

  // 切回「基本」继续后面的保存测试
  clickTab('基本');

  console.log('\n5. 密钥字段是只写的（不会把 access_token 清空）');
  check('loadConfig 带回了 secrets 位置', loaded.secrets && loaded.secrets.length === 2 && loaded.secrets[0].path.join('.') === 'onebot.accessToken',
    JSON.stringify(loaded.secrets));

  const findByText = (node, text) => {
    if (node === null || node === undefined || typeof node !== 'object') return null;
    if (Array.isArray(node)) { for (const item of node) { const hit = findByText(item, text); if (hit) return hit; } return null; }
    for (const child of node.children || []) {
      if (typeof child === 'string' && child === text) return node;
      const hit = findByText(child, text);
      if (hit) return hit;
    }
    return null;
  };
  // 密钥字段的状态徽章：已设置=绿框绿字，未设置=灰框灰字（以前是无条件的一行灰字，
  // 「填了」和「没填」看起来一模一样）。
  const setBadge = findByText(tree, '已设置');
  const setBadgeStyle = (setBadge === null || setBadge.props === undefined) ? undefined : setBadge.props.style;
  check('「已设置」渲染成绿框绿字',
    setBadgeStyle !== undefined && setBadgeStyle.color === '#2ea043'
    && String(setBadgeStyle.border).includes('46, 160, 67'),
    JSON.stringify(setBadgeStyle === undefined ? null : setBadgeStyle));
  check('「已设置」旁边仍说明「留空则保持不变」', joined.includes('留空则保持不变'));
  check('未设置时走灰框灰字分支（源码里有 secretBadgeOff 与「未设置」）',
    bundleSource.includes('secretBadgeOff') && bundleSource.includes("'未设置'"));
  // 同类缺陷：secrets 里每个 secret 字段都会有一条记录（set 可能为 false），
  // 以前看「条目存在」就当已配置，于是没配过 TOTP 也显示「密钥已经配置好了」。
  check('TOTP 是否已配置看 secrets 的 set（不是看条目存在）',
    /secretKey === 'flowAuth\.totpSecret'\) totpSecretSet = entry\.set === true/.test(bundleSource), '');
  check('扫码绑定的「已绑定 AppID」用去空白后的非空判断',
    /String\(st\.appId \|\| ''\)\.trim\(\) !== ''/.test(bundleSource), '');

  const collectInputs = (node, out) => {
    if (node === null || node === undefined || typeof node !== 'object') return out;
    if (Array.isArray(node)) { for (const item of node) collectInputs(item, out); return out; }
    if (node.type === 'input') out.push(node);
    for (const child of node.children || []) collectInputs(child, out);
    return out;
  };

  // 只改一个普通字段后保存：不应出现 accessToken 的写操作
  mutateCalls.length = 0;
  const wsInput = collectInputs(tree, []).find((el) => el.props.value === 'ws://127.0.0.1:3001');
  check('能找到正向 WS 输入框', Boolean(wsInput));
  wsInput.props.onChange({ target: { value: 'ws://192.168.1.9:3001' } });
  reactRuntime.__beginRender();
  const tree2 = registered.component(props);
  reactRuntime.__takeEffects();
  const saveButton = findByText(tree2, '保存');
  check('能找到保存按钮', Boolean(saveButton) && typeof saveButton.props.onClick === 'function');
  await saveButton.props.onClick();
  const sentPaths = mutateCalls.length > 0 ? mutateCalls[mutateCalls.length - 1].ops.map((op) => op.path.join('.')) : [];
  check('保存只提交改动字段', sentPaths.length === 1 && sentPaths[0] === 'onebot.wsUrl', JSON.stringify(sentPaths));
  check('没有提交 accessToken（否则会把 token 清空）', !sentPaths.includes('onebot.accessToken'), JSON.stringify(sentPaths));

  // 真的输入新 token 后保存：应提交它
  mutateCalls.length = 0;
  // access_token 在「连接」标签：用默认（连接）那次渲染的树取输入框
  const pwInput = collectInputs(tree, []).find((el) => el.props.type === 'password');
  check('能找到 access_token 密码框', Boolean(pwInput));
  pwInput.props.onChange({ target: { value: 'new-token-abc' } });
  reactRuntime.__beginRender();
  const tree3 = registered.component(props);
  reactRuntime.__takeEffects();
  const saveButton3 = findByText(tree3, '保存');
  await saveButton3.props.onClick();
  const finalPaths = mutateCalls.length > 0 ? mutateCalls[mutateCalls.length - 1].ops : [];
  const tokenOp = finalPaths.find((op) => op.path.join('.') === 'onebot.accessToken');
  check('输入新值后会提交 accessToken', Boolean(tokenOp) && tokenOp.value === 'new-token-abc', JSON.stringify(finalPaths));

  const secretCount = mutateCalls.length > 0 ? mutateCalls[mutateCalls.length - 1].ops.length : 0;
  check('新 token 是唯一改动', secretCount === 1, String(secretCount));

  reactRuntime.__beginRender();
  const treeReverse0 = registered.component(props);
  reactRuntime.__takeEffects();
  // 切到反向模式：真的驱动「连接方式」下拉的 onChange，再重渲染断言字段跟着换。
  // 以前这里造了个 reverseDraft 却从没用过，最后断言还是 check(..., true) —— 恒真，白占一行。
  const collectSelects = (node, out) => {
    if (node === null || node === undefined || typeof node !== 'object') return out;
    if (Array.isArray(node)) { for (const item of node) collectSelects(item, out); return out; }
    if (node.type === 'select') out.push(node);
    for (const child of node.children || []) collectSelects(child, out);
    return out;
  };
  // 设置面板按标签渲染，mode 在「连接」标签里：先点回那个标签。
  const collectByProp = (node, key, out) => {
    if (node === null || node === undefined || typeof node !== 'object') return out;
    if (Array.isArray(node)) { for (const item of node) collectByProp(item, key, out); return out; }
    if (node.props !== undefined && node.props !== null && node.props[key] !== undefined) out.push(node);
    for (const child of node.children || []) collectByProp(child, key, out);
    return out;
  };
  const connectionTab = collectByProp(treeReverse0, 'data-tab', []).find((el) => el.props['data-tab'] === 'connection');
  check('找得到「连接」标签按钮', Boolean(connectionTab));
  if (connectionTab !== undefined) {
    connectionTab.props.onClick();
    reactRuntime.__beginRender();
    registered.component(props);
    reactRuntime.__takeEffects();
  }
  const connectionTree = (() => {
    reactRuntime.__beginRender();
    const t = registered.component(props);
    reactRuntime.__takeEffects();
    return t;
  })();
  // select 渲染成 <select> + <option> 子节点（不是 props.options 数组），按 option 的 value 认。
  const optionValues = (el) => {
    const out = [];
    const walk = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return;
      if (Array.isArray(node)) { for (const item of node) walk(item); return; }
      if (node.type === 'option') out.push(String(node.props && node.props.value));
      for (const child of node.children || []) walk(child);
    };
    walk(el.children || []);
    return out;
  };
  const modeSelect = collectSelects(connectionTree, []).find((el) => optionValues(el).includes('reverse'));
  check('找得到「连接方式」下拉（含 forward / reverse 两个选项）', Boolean(modeSelect));
  if (modeSelect === undefined) throw new Error('找不到连接方式下拉，反向分支无法验证');
  modeSelect.props.onChange({ target: { value: 'reverse' } });
  reactRuntime.__beginRender();
  const treeReverse = registered.component(props);
  reactRuntime.__takeEffects();
  const labelsReverse = [];
  const collectLabels = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const item of node) collectLabels(item); return; }
    for (const child of node.children || []) {
      if (typeof child === 'string' && child.length > 1) labelsReverse.push(child);
      collectLabels(child);
    }
  };
  collectLabels(treeReverse);
  const hasListen = labelsReverse.some((t) => t.includes('反向 WS 监听地址'));
  const hasForward = labelsReverse.some((t) => t.includes('正向 WS 地址'));
  check('切到反向模式：出现「反向 WS 监听地址」', hasListen, JSON.stringify(labelsReverse.slice(0, 12)));
  check('切到反向模式：正向 WS 地址被隐藏', hasForward === false && hasListen === true, JSON.stringify(labelsReverse.slice(0, 12)));

  // ------------------------------------------------------------------
  // 5. 纯数字名单（QQ 号 / 群号）：硬过滤 + 逐项校验 + 保存前拦下
  // ------------------------------------------------------------------
  console.log('\n5. 纯数字名单的输入过滤与校验');
  let treeN = null;
  const renderNow = () => {
    reactRuntime.__beginRender();
    treeN = registered.component(props);
    // 只取不跑：这条测试桩不区分 deps，真跑会把挂载时的 reload 每渲染触发一次。
    reactRuntime.__takeEffects();
    return treeN;
  };
  // 保存成功后组件会 reload（state 先回到 loading），等它把表单渲染回来再断言。
  const renderSettled = async () => {
    for (let i = 0; i < 12; i += 1) {
      renderNow();
      if (!textsOf(treeN).includes('正在读取设置')) return treeN;
      await sleep(25);
    }
    return treeN;
  };
  const clickTabN = (label) => {
    const btn = collectButtons(treeN, []).find((b) => b.props.role === 'tab' && b.props['data-tab'] !== undefined && childText(b) === label);
    if (btn) btn.props.onClick();
    return renderNow();
  };
  await renderSettled();
  await clickTabN('基本');
  const numericInputs = () => collectInputs(treeN, []).filter((el) => el.props.inputMode === 'numeric');
  check('数字名单输入框标了 inputMode=numeric', numericInputs().length >= 3, String(numericInputs().length));

  const emptyList = numericInputs().find((el) => el.props.value === '');
  check('找到空的群号白名单输入框', Boolean(emptyList));
  emptyList.props.onChange({ target: { value: '123abc456' } });
  await renderSettled();
  check('非数字字符敲不进去（123abc456 → 123456）',
    numericInputs().some((el) => el.props.value === '123456'),
    JSON.stringify(numericInputs().map((el) => el.props.value)));

  const typed = numericInputs().find((el) => el.props.value === '123456');
  typed.props.onChange({ target: { value: '123456,12' } });
  await renderSettled();
  check('非法项不再行内标红（免得输到一半丢焦点）',
    !textsOf(treeN).includes('不是合法的号码'), textsOf(treeN).slice(0, 140));
  const stillNumeric = numericInputs();
  check('输入框仍是裸 input（没有被包进容器）',
    stillNumeric.length > 0 && stillNumeric.every((el) => el.type === 'input'),
    JSON.stringify(stillNumeric.map((el) => el.type)));
  check('输到一半的号码原样留着（123456,12）',
    stillNumeric.some((el) => el.props.value === '123456,12'),
    JSON.stringify(stillNumeric.map((el) => el.props.value)));

  mutateCalls.length = 0;
  await findByText(treeN, '保存').props.onClick();
  await renderSettled();
  check('有非法项时保存被拦下（没发 mutate）', mutateCalls.length === 0, JSON.stringify(mutateCalls));
  check('保存时给出可读的拦截提示', textsOf(treeN).includes('5–12 位纯数字'), textsOf(treeN).slice(0, 160));

  const typed2 = numericInputs().find((el) => el.props.value === '123456,12');
  typed2.props.onChange({ target: { value: '123456,789012' } });
  await renderSettled();
  mutateCalls.length = 0;
  await findByText(treeN, '保存').props.onClick();
  await renderSettled();
  const listOps = (mutateCalls.length > 0 ? mutateCalls[0].ops : []).filter((op) => op.path.join('.') === 'group.allow');
  check('合法后保存：提交的是拆开的数组', listOps.length === 1 && Array.isArray(listOps[0].value) && listOps[0].value.join(',') === '123456,789012',
    JSON.stringify(listOps));

  // 「只能输数字」和「可以输多个值」是两件事：6 位动态码是单值，连逗号都不该能敲。
  console.log('\n5b. 单值纯数字字段不吃分隔符');
  await renderSettled();
  await clickTabN('高级');
  // 动态码在「高级 → 闸门区」这个二级标签下，不切过去看不到。
  const clickSubN = async (label) => {
    const btn = collectButtons(treeN, [])
      .find((b) => b.props.role === 'tab' && b.props['data-subtab'] !== undefined && childText(b) === label);
    if (btn) btn.props.onClick();
    return renderSettled();
  };
  await clickSubN('闸门区');
  const codeInput = collectInputs(treeN, []).find((el) => el.props.type === 'password'
    && el.props.inputMode === 'numeric');
  check('动态码输入框标了 inputMode=numeric', Boolean(codeInput),
    JSON.stringify(collectInputs(treeN, []).map((el) => el.props.inputMode)));
  codeInput.props.onChange({ target: { value: '12,34 56' } });
  await renderSettled();
  const codeAfter = collectInputs(treeN, []).find((el) => el.props.type === 'password'
    && el.props.inputMode === 'numeric');
  check('逗号与空格敲不进单值字段（12,34 56 → 123456）',
    Boolean(codeAfter) && codeAfter.props.value === '123456', String(codeAfter && codeAfter.props.value));

  // ------------------------------------------------------------------
  // 6. 一键还原默认：只改 draft、不保存、密钥字段不碰
  // ------------------------------------------------------------------
  console.log('\n6. 一键还原默认（仅本页）');
  const fetchCalls = [];
  const DEFAULTS_STUB = {
    mode: 'forward',
    onebot: { wsUrl: 'ws://127.0.0.1:3001', listen: '0.0.0.0:6199', httpUrl: 'http://127.0.0.1:3000', accessToken: '' },
    group: { allow: [], requireAt: true },
    private: { allow: [] },
    auth: { owners: [], superAdmins: [], guestToolAllow: [], guestDshTools: false, ownerSettings: true },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return { json: async () => ({ ok: true, defaults: DEFAULTS_STUB }) };
  };

  await renderSettled();
  await clickTabN('基本');
  const allBasicInputs = () => collectInputs(treeN, []).filter((el) => el.type === 'input');
  check('还原前：拥有者账号是 66666',
    allBasicInputs().some((el) => el.props.value === '66666'),
    JSON.stringify(allBasicInputs().map((el) => el.props.value)));
  const restoreBtn = findByText(treeN, '还原本页默认');
  check('底栏出现「还原本页默认」按钮', Boolean(restoreBtn) && typeof restoreBtn.props.onClick === 'function');
  mutateCalls.length = 0;
  await restoreBtn.props.onClick();
  await renderSettled();
  check('默认值取自插件路由 /dsh-qq-bot/defaults',
    fetchCalls.length >= 1 && fetchCalls[0].url === '/dsh-qq-bot/defaults',
    JSON.stringify(fetchCalls.map((c) => c.url)));
  check('还原没有写盘（没发 mutate）', mutateCalls.length === 0, JSON.stringify(mutateCalls));
  check('提示说明还没保存', textsOf(treeN).includes('未保存'), textsOf(treeN).slice(0, 200));

  // 「还原改的是 draft、保存才落盘」用提交内容验证：输入框的本地文本在测试桩里不会跑
  // effect 同步（浏览器会），所以看提交值比看显示值更接近真实结论。
  mutateCalls.length = 0;
  await findByText(treeN, '保存').props.onClick();
  await renderSettled();
  const restoreOps = mutateCalls.length > 0 ? mutateCalls[0].ops : [];
  const ownerOp = restoreOps.find((op) => op.path.join('.') === 'auth.owners');
  check('保存时提交的是还原后的默认值（auth.owners → []）',
    Boolean(ownerOp) && Array.isArray(ownerOp.value) && ownerOp.value.length === 0, JSON.stringify(ownerOp));

  // 密钥字段：留空 = 保持不变，所以还原必须绕开它，否则就是假还原
  await renderSettled();
  await clickTabN('连接');
  const tokenInput = collectInputs(treeN, []).find((el) => el.props.type === 'password');
  check('连接页有 access_token 密码框', Boolean(tokenInput));
  tokenInput.props.onChange({ target: { value: 'secret-xyz' } });
  await renderSettled();
  await findByText(treeN, '还原本页默认').props.onClick();
  await renderSettled();
  const tokenAfter = collectInputs(treeN, []).find((el) => el.props.type === 'password');
  check('还原不动密钥字段（输入的新 token 还在）', Boolean(tokenAfter) && tokenAfter.props.value === 'secret-xyz',
    String(tokenAfter && tokenAfter.props.value));
  check('提示说明密钥类字段未动', textsOf(treeN).includes('密钥类字段未动'), textsOf(treeN).slice(0, 200));
  // ------------------------------------------------------------------
  // 7. 表情包卡片（放在最后：这个卡片带 hooks，测试桩的 state 是位置式的，
  //    提前渲染会把后面 ListInput 的 useRef 位置顶乱，所以只在这里验一次）
  // ------------------------------------------------------------------
  console.log('\n7. 表情包卡片（能力 → 表情包）');
  const stickerFetchCalls = [];
  const stickerStatusPayload = {
    ok: true, enabled: true, autoTag: true, dir: '/tmp/QQ_msg/sticker', indexFile: '/tmp/QQ_msg/sticker/index.json',
    indexExists: true, corrupt: false, total: 3, tagged: 2, untagged: 1,
    series: [{ name: '', count: 1 }, { name: '猫猫', count: 2 }],
    updatedAt: 1700000000000, model: { provider: 'test-provider', model: 'test-model' }, job: null, busy: false, maxPerRun: 40,
  };
  globalThis.fetch = (url) => {
    stickerFetchCalls.push(String(url));
    if (String(url).includes('/sticker/rebuild')) {
      return Promise.resolve({ json: () => Promise.resolve(Object.assign({}, stickerStatusPayload, {
        started: true, job: { running: true, mode: 'tag', total: 1, done: 0, tagged: 0, failed: 0, note: '', error: '' },
      })) });
    }
    return Promise.resolve({ json: () => Promise.resolve(stickerStatusPayload) });
  };
  const renderWithEffects = () => {
    reactRuntime.__beginRender();
    const tree = registered.component(props);
    return { tree, effects: reactRuntime.__takeEffects() };
  };
  const stickerStep0 = renderWithEffects();
  const capabilityTabBtn = collectButtons(stickerStep0.tree, [])
    .find((b) => b.props.role === 'tab' && b.props['data-tab'] === 'capability');
  check('找得到「能力」标签按钮', Boolean(capabilityTabBtn));
  capabilityTabBtn.props.onClick();
  let stickerStep = renderWithEffects();
  const stickerSubBtn0 = collectButtons(stickerStep.tree, [])
    .find((b) => b.props.role === 'tab' && b.props['data-subtab'] === 'sticker');
  check('找得到「表情包」二级标签', Boolean(stickerSubBtn0));
  stickerSubBtn0.props.onClick();
  stickerStep = renderWithEffects();
  const collapsedToggle = findDataSet(stickerStep.tree, 'data-sticker-toggle');
  const collapsedText = textsOf(stickerStep.tree);
  // 折叠口径与 moli 对齐：默认折叠，但折叠与否只看「有没有点高级设置」，不看启用开关。
  check('默认折叠（参数未渲染，但有折叠按钮）',
    collapsedToggle !== null
    && findDataSet(stickerStep.tree, 'data-sticker-advanced') !== null
    && findDataSet(stickerStep.tree, 'data-sticker-rebuild') === null
    && collapsedText.includes('表情包目录') === false,
    collapsedText.slice(0, 200));
  check('未启用时也提示「勾上开关才会真正扫描」',
    collapsedToggle.props.checked !== true
    && findDataSet(stickerStep.tree, 'data-sticker-collapsed') !== null,
    collapsedText.slice(0, 200));

  // 未启用（没勾开关）也能点开高级设置看参数——这正是这次要改的行为。
  const advancedBtnOff = findDataSet(stickerStep.tree, 'data-sticker-advanced');
  check('未启用时折叠按钮可点（不是 disabled）',
    advancedBtnOff !== null && advancedBtnOff.props.disabled !== true, JSON.stringify(advancedBtnOff === null ? null : advancedBtnOff.props));
  advancedBtnOff.props.onClick();
  stickerStep = renderWithEffects();
  check('未启用也能展开（参数与状态区都渲染出来了）',
    textsOf(stickerStep.tree).includes('表情包目录')
    && findDataSet(stickerStep.tree, 'data-sticker-toggle').props.checked !== true,
    textsOf(stickerStep.tree).slice(0, 200));

  // 勾上开关 → 组件把 sticker.enabled 写进 draft；展开状态由折叠按钮单独管，不受开关影响。
  const offToggle = findDataSet(stickerStep.tree, 'data-sticker-toggle');
  offToggle.props.onChange({ target: { checked: true } });
  stickerStep = renderWithEffects();
  const expandedToggle = findDataSet(stickerStep.tree, 'data-sticker-toggle');
  check('勾上开关后开关变 checked，且折叠状态保持不变',
    expandedToggle !== null && expandedToggle.props.checked === true
    && findDataSet(stickerStep.tree, 'data-sticker-advanced') !== null,
    textsOf(stickerStep.tree).slice(0, 160));
  // 重建按钮住在状态区里：状态区要先拿到 GET 结果才会渲染按钮，所以放到下面那段之后断言。
  check('展开后卡片参数已渲染（目录字段出现）',
    textsOf(stickerStep.tree).includes('表情包目录'), textsOf(stickerStep.tree).slice(0, 200));

  // 卡片展开后的这一轮渲染才会挂上状态区（StickerStatus）：先发 GET，拿到结果再重渲染。
  // 测试桩是位置式 hook：渲染一次就没法回头跑「上一轮」的 effect，所以按
  // 「渲染 → 立刻跑这一轮 effect → 等 fetch → 再渲染」的顺序推进，最多推几轮。
  const capStickerTree = stickerStep.tree;
  const capStickerJoined = textsOf(capStickerTree);
  check('表情包页渲染出图库卡片',
    capStickerJoined.includes('表情包图库') && capStickerJoined.includes('目录 = 图库 · 子目录 = 系列 · index.json = 索引'),
    capStickerJoined.slice(0, 260));
  const stickerToggle = findDataSet(capStickerTree, 'data-sticker-toggle');
  check('卡片带启用开关（checkbox）', stickerToggle !== null && stickerToggle.props.type === 'checkbox',
    JSON.stringify(stickerToggle === null ? null : stickerToggle.props));
  check('卡片参数就位（重建按钮在状态区里，见下面的状态区断言）',
    capStickerJoined.includes('AI 自动标记'), capStickerJoined.slice(0, 300));
  check('卡片内参数都在（目录 / AI 自动标记 / 每次最多）',
    capStickerJoined.includes('表情包目录') && capStickerJoined.includes('AI 自动标记')
    && capStickerJoined.includes('每次最多标记几张'), capStickerJoined.slice(0, 600));
  check('表情包页不串入其它分区的字段',
    !capStickerJoined.includes('生图（qq_draw）') && !capStickerJoined.includes('联网搜索 HTTP 代理'),
    capStickerJoined.slice(0, 240));
  // 状态区（StickerStatus）是卡片里嵌的子组件。位置式 useState 的桩做不到「子组件自己的
  // hook 列表」，所以这里不整页递归：直接把状态区的渲染结果单独拿一次，验证它取到的数据与按钮。
  // 契约（GET 打在这里、按钮发 POST）由 routes-sticker 的测试与下面的 fetch 断言覆盖。
  let statusSnapshot = null;
  let statusText = '';
  if (typeof plugin.__stickerStatusForTest === 'function') {
    reactRuntime.__beginRender();
    statusSnapshot = plugin.__stickerStatusForTest();
    for (const effect of reactRuntime.__takeEffects()) effect();
    await sleep(30);
    reactRuntime.__beginRender();
    statusSnapshot = plugin.__stickerStatusForTest();
    statusText = textsOf(statusSnapshot);
  }
  check('状态区能渲染（test hook 可用）', statusSnapshot !== null, String(typeof plugin.__stickerStatusForTest));

  // 两段式的那两个字段：provider/model 必须是**一对**，发言模型不能去列判断阶段的模型。
  if (typeof plugin.__providerPathForTest === 'function') {
    const pp = plugin.__providerPathForTest;
    check('proactive.model 的 provider 是 proactive.provider',
      JSON.stringify(pp(['proactive', 'model'])) === JSON.stringify(['proactive', 'provider']), JSON.stringify(pp(['proactive', 'model'])));
    check('proactive.speakModel 的 provider 是 proactive.speakProvider（不是判断阶段那个）',
      JSON.stringify(pp(['proactive', 'speakModel'])) === JSON.stringify(['proactive', 'speakProvider']), JSON.stringify(pp(['proactive', 'speakModel'])));
    check('vision.model 的 provider 仍是 vision.provider',
      JSON.stringify(pp(['vision', 'model'])) === JSON.stringify(['vision', 'provider']), JSON.stringify(pp(['vision', 'model'])));
    check('空路径不炸', JSON.stringify(pp([])) === JSON.stringify([]));
  } else {
    check('provider 路径推导钩子可用', false, '缺少 __providerPathForTest');
  }

  if (typeof plugin.__providerOptionsForTest === 'function') {
    const opts = plugin.__providerOptionsForTest([{ id: 'uymu-free', name: '鸡蛋', models: [] }], 'uymu-image', '（留空）');
    const values = opts.map((pair) => pair[0]);
    check('已配但不在目录里的 provider 仍出现在选项里（不会显示成空）',
      values.includes('uymu-image') && values[0] === '' && values.includes('uymu-free'), JSON.stringify(values));
    check('该选项带「不在模型目录里」提示', opts.some((pair) => pair[0] === 'uymu-image' && String(pair[1]).includes('不在模型目录里')), JSON.stringify(opts));
    check('目录里已有的 provider 不重复追加',
      plugin.__providerOptionsForTest([{ id: 'uymu-free', name: '鸡蛋', models: [] }], 'uymu-free', '（留空）').filter((pair) => pair[0] === 'uymu-free').length === 1);
  } else {
    check('provider 选项钩子可用', false, '缺少 __providerOptionsForTest');
  }
  check('状态区拿到了运行状态（走了 GET /dsh-qq-bot/sticker）',
    stickerFetchCalls.includes('/dsh-qq-bot/sticker') && statusText.includes('共 3 张 · 2 个系列 · 已标记 2 / 待标记 1')
    && statusText.includes('猫猫 2'), statusText.slice(0, 400));
  check('状态区显示打标模型', statusText.includes('打标模型：test-provider / test-model'), statusText.slice(0, 400));
  const statusRebuild = statusSnapshot === null ? null : findDataSet(statusSnapshot, 'data-sticker-rebuild');
  check('卡片带「扫描并打标」「只重建索引」按钮',
    statusRebuild !== null && statusText.includes('扫描并打标') && statusText.includes('只重建索引'),
    statusText.slice(0, 300));
  if (statusRebuild !== null) {
    statusRebuild.props.onClick();
    await sleep(10);
  }
  check('点「扫描并打标」会 POST 到 rebuild', stickerFetchCalls.includes('/dsh-qq-bot/sticker/rebuild'),
    JSON.stringify(stickerFetchCalls));

  globalThis.fetch = realFetch;
} catch (error) {
  failures += 1;
  console.log('\n错误：' + (error && error.stack ? error.stack : String(error)));
}

const passed = results.filter(Boolean).length;
console.log('\n' + passed + '/' + results.length + ' 项通过');
if (failures > 0) { console.log('客户端自测失败'); process.exit(1); }
console.log('客户端自测通过');
process.exit(0);
