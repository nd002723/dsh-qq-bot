/** 单元测试：lib/config.js —— DEFAULTS / plainConfig（volatile 还原）/ mergeConfig / describeError */
import { DEFAULTS, DEFAULTS_SOURCES, Config, plainConfig, mergeConfig, staleConfigPaths, describeError, SETTINGS_FIELDS, SETTINGS_SOURCES } from '../lib/config.js';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');

const results = [];
let failures = 0;
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok));
  if (ok) console.log('  [PASS] ' + name);
  else { failures += 1; console.log('  [FAIL] ' + name + (detail ? ' — ' + detail : '')); }
};

console.log('1. DEFAULTS 默认值');
check('连接默认 forward + 默认 wsUrl', DEFAULTS.mode === 'forward' && DEFAULTS.onebot.wsUrl === 'ws://127.0.0.1:3001');
check('群聊默认仅 @ 响应', DEFAULTS.group.enabled === true && DEFAULTS.group.requireAt === true && Array.isArray(DEFAULTS.group.allow) && DEFAULTS.group.allow.length === 0);
check('访客白名单默认含 qq_history（不含 web_fetch）', Array.isArray(DEFAULTS.auth.guestToolAllow) && DEFAULTS.auth.guestToolAllow.includes('qq_history') && !DEFAULTS.auth.guestToolAllow.includes('web_fetch'));

console.log('2. plainConfig：volatile 引用还原成普通对象');
const vref = (val) => { const ref = { get: () => val }; ref[Symbol.for('cosmokit.volatile.write')] = true; return ref; };
check('顶层 volatile 引用还原', plainConfig(vref({ a: 1, b: 'x' })).a === 1 && plainConfig(vref({ a: 1, b: 'x' })).b === 'x');
check('嵌套对象里的 volatile 引用还原', (() => { const out = plainConfig({ auth: vref({ guestToolAllow: ['qq_history'] }) }); return out.auth.guestToolAllow.includes('qq_history'); })());
check('数组元素递归还原', (() => { const out = plainConfig([vref(1), vref('a'), { k: vref(2) }]); return out[0] === 1 && out[1] === 'a' && out[2].k === 2; })());

console.log('3. mergeConfig：深合并/数组覆盖/undefined 跳过');
check('两层深合并保留 base 未覆盖字段', (() => { const out = mergeConfig({ a: 1, group: { enabled: true, requireAt: true } }, { group: { requireAt: false } }); return out.a === 1 && out.group.enabled === true && out.group.requireAt === false; })());
check('数组整体覆盖（非合并）', (() => { const out = mergeConfig({ allow: [1, 2] }, { allow: [3] }); return Array.isArray(out.allow) && out.allow.length === 1 && out.allow[0] === 3; })());
check('undefined 跳过、标量覆盖', (() => { const out = mergeConfig({ a: 1, b: 2 }, { a: undefined, b: 9 }); return out.a === 1 && out.b === 9; })());
check('null override 直接生效', (() => { const out = mergeConfig({ a: 1 }, { a: null }); return out.a === null; })());

console.log('4. describeError');
check('Error 取 message / 字符串原样 / null 兜底', describeError(new Error('boom')) === 'boom' && describeError('直接文本') === '直接文本' && describeError(null) === 'null');

console.log('8. staleConfigPaths：找出 schema 不认识的键（版本升级删字段后的残留）');
check('干净配置没有废弃键', staleConfigPaths({ proactive: { enabled: true, groups: ['1'] }, onebot: { wsUrl: 'ws://a' } }).length === 0);
check('单个废弃键能被认出（返回键名数组）',
  JSON.stringify(staleConfigPaths({ proactive: { judgeProvider: 'uymu' } })) === '[["proactive","judgeProvider"]]');
check('整段不认识的子树只报最浅的一层', JSON.stringify(staleConfigPaths({ legacy: { a: 1, b: { c: 2 } } })) === '[["legacy"]]');
check('键名本身带点也不会被拆成嵌套路径',
  JSON.stringify(staleConfigPaths({ 'onebot.wsUrl': 'x' })) === '[["onebot.wsUrl"]]');
check('DEFAULTS 里每个键都是 schema 认识的（防默认值与 schema 漂移）',
  staleConfigPaths(DEFAULTS).length === 0,
  JSON.stringify(staleConfigPaths(DEFAULTS)));
check('空对象不算废弃（只是没写过）', staleConfigPaths({ restart: {} }).length === 0);
check('数组整体算叶子，不检查里面的键', staleConfigPaths({ proactive: { groups: ['a', 'b'] } }).length === 0);
check('非对象入参返回空', staleConfigPaths(null).length === 0 && staleConfigPaths([1, 2]).length === 0 && staleConfigPaths('x').length === 0);

console.log('9. staleConfigPaths 的两个边界（评审提出，曾会破坏用户配置）');
{
  // !!js 表达式在 DSH 配置里是合法值，解析出来是类实例；当成「未知子键」删掉会把表达式换成默认值。
  class JsExpr { constructor(source) { this.source = source; } }
  check('已知键上的 !!js 表达式不被当成废弃子键',
    staleConfigPaths({ mode: new JsExpr('x'), auth: new JsExpr('y') }).length === 0,
    JSON.stringify(staleConfigPaths({ mode: new JsExpr('x'), auth: new JsExpr('y') })));
  check('带 symbol 标记的表达式包装也不被拆', (() => {
    const tag = Symbol('expr');
    const wrapped = { [tag]: true, value: 1 };
    return staleConfigPaths({ auth: wrapped }).length === 0;
  })());
  check('DSH 的 !!js 表达式包装键（__jsExpr）不算废弃子键',
    staleConfigPaths({ flowAuth: { __jsExpr: 'x', enabled: true }, legacy: { __jsExpr: 'y' } }).length === 1,
    JSON.stringify(staleConfigPaths({ flowAuth: { __jsExpr: 'x', enabled: true }, legacy: { __jsExpr: 'y' } })));
  check('未知键的值是 null 也算残留（以前永远清不掉）',
    JSON.stringify(staleConfigPaths({ legacy: null })) === '[["legacy"]]');
  const cleanDefaults = staleConfigPaths(DEFAULTS);
  check('加了表达式跳过之后，DEFAULTS 仍然没有废弃键', cleanDefaults.length === 0, JSON.stringify(cleanDefaults));
}

console.log('\n10. 默认值 JSON：自动发现 / 与 schema 一致 / 邪门输入被挡');
{
  check('自动发现到默认值文件', DEFAULTS_SOURCES.length >= 8, JSON.stringify(DEFAULTS_SOURCES.map((s2) => s2.file)));
  check('工具目录与阀门目录都有', DEFAULTS_SOURCES.some((s2) => s2.file.startsWith('tools/'))
    && DEFAULTS_SOURCES.some((s2) => s2.file.startsWith('valve/')), JSON.stringify(DEFAULTS_SOURCES.map((s2) => s2.file)));

  const missingDefaults = DEFAULTS_SOURCES.filter((s2) => DEFAULTS[s2.group] === undefined);
  check('每个 group 都进了 DEFAULTS', missingDefaults.length === 0, JSON.stringify(missingDefaults));

  // 关键护栏：group 写错一个字母，这组默认值就成了 schema 不认识的键，而
  // staleConfigPaths 正是拿 schema 判废弃字段——启动清理会把用户配置当垃圾删掉。
  const dict = Config.dict || {};
  const unknown = DEFAULTS_SOURCES.filter((s2) => dict[s2.group] === undefined);
  check('每个 group 都在 Config schema 里', unknown.length === 0, JSON.stringify(unknown));

  // 默认值只有一个来源：JSON 改了，schema 求值结果必须跟着变（这里是反向核对）。
  // 比对下沉到**叶子级**：以前只比 group 下的一层键，嵌套对象靠 JSON.stringify
  // 整体比较，schema 多出一片默认值（JSON 没写）时不会被发现。
  const evaluated = plainConfig(new Config({}));
  const flattenLeaves = (value, prefix, out) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const key of Object.keys(value)) flattenLeaves(value[key], prefix === '' ? key : prefix + '.' + key, out);
      return out;
    }
    out.set(prefix, value);
    return out;
  };
  const jsonLeaves = new Map();
  const schemaLeaves = new Map();
  // 全量比对（含 CORE_DEFAULTS 的核心分组）：只比 8 份 -conf.json 覆盖的分组会漏掉
  // config.js 里手写的核心默认值——那正是「同一份知识写两遍」的另一半。
  flattenLeaves(DEFAULTS, '', jsonLeaves);
  flattenLeaves(evaluated, '', schemaLeaves);
  const drift = [];
  for (const [path, value] of jsonLeaves) {
    if (!schemaLeaves.has(path)) { drift.push(path + ': JSON 有、schema 没有'); continue; }
    if (JSON.stringify(schemaLeaves.get(path)) !== JSON.stringify(value)) {
      drift.push(path + ': ' + JSON.stringify(value) + ' vs ' + JSON.stringify(schemaLeaves.get(path)));
    }
  }
  for (const [path, value] of schemaLeaves) {
    // undefined 表示「这个字段没有默认值」（密钥类字段就是这样：没填就不该存在键）。
    // JSON 表达不了 undefined，所以这类叶子只要求 JSON 里也「没有」——两边都空才算一致。
    if (value === undefined) { if (jsonLeaves.has(path) && jsonLeaves.get(path) !== undefined) drift.push(path + ': schema 无默认值、JSON 却写了'); continue; }
    if (!jsonLeaves.has(path)) drift.push(path + ': schema 有、JSON 没写');
  }
  check('JSON 默认值与 schema 求值逐叶子一致（嵌套也能抓到）', drift.length === 0, drift.slice(0, 4).join('；'));

  // 设置页顺序由模板自己声明的 priority 决定，不再由文件名排序决定。
  // 以前按路径排：图片反搜排在 moli 前面、moli 卡片卡在分区中间，改个文件名就换一次版面。
  const orderOf = (subtab) => {
    const seen = [];
    for (const f of SETTINGS_FIELDS) {
      if (f.subtab !== subtab) continue;
      const g = f.group === '' ? '(核心)' : f.group;
      if (seen[seen.length - 1] !== g) seen.push(g);
    }
    return seen.join(' → ');
  };
  check('检索分区按 priority 排：联网 → 图片反搜 → moli 卡片收尾',
    orderOf('retrieval') === 'webSearch → imgSearch → moli', orderOf('retrieval'));
  check('视觉分区按 priority 排：识图 → 历史 → 生图',
    orderOf('vision') === 'vision → history → imageGen', orderOf('vision'));
  // 排序口径是「先按标签页/二级标签分桶，桶内再按 priority」，所以跨模板交织是可能的：
  // 会话与排错要的是 ①自定义（核心 100）→ ②按身份（auth 150）→ ③兜底（核心 190），
  // 以前按文件排只能得到 ①③②②——auth 的 ② 整块落在 core 的 ③ 后面。
  check('会话分区跨模板交织：核心① → auth② → 核心③',
    orderOf('session') === '(核心) → auth → (核心)', orderOf('session'));
  const sessionOrder = SETTINGS_FIELDS.filter((f) => f.subtab === 'session').map((f) => f.path.join('.'));
  check('会话分区的 ①②③ 顺序与标签上的序号一致',
    sessionOrder.indexOf('agentPresetCustom') < sessionOrder.indexOf('auth.ownerPreset')
    && sessionOrder.indexOf('auth.ownerPreset') < sessionOrder.indexOf('agentPreset'),
    sessionOrder.join(' → '));
  // priority 只在同一个分区内比较，所以不同分区复用同一个号是正常的：
  // 100/200/300 就是「该分区的第 1/2/3 位」。以后加内容只看自己那个分区，
  // 不必去全局序列里找空档，也就不会因为插一个号把别人的顺序顶乱。
  const prioOf = (group) => SETTINGS_SOURCES.find((s2) => s2.group === group).priority;
  check('不同分区复用同一个 priority（核心 / vision / webSearch 都是 100）',
    prioOf('') === 100 && prioOf('vision') === 100 && prioOf('webSearch') === 100,
    [prioOf(''), prioOf('vision'), prioOf('webSearch')].join('/'));
  check('分区内按 100 / 200 / 300 的位次递增',
    prioOf('history') === 200 && prioOf('imageGen') === 300
    && prioOf('imgSearch') === 200 && prioOf('moli') === 300
    && prioOf('auth') === 200 && prioOf('flowAuth') === 200,
    [prioOf('history'), prioOf('imageGen'), prioOf('imgSearch'), prioOf('moli'), prioOf('auth'), prioOf('flowAuth')].join('/'));
  check('每份模板都声明了 priority（内置的 10 份）',
    SETTINGS_SOURCES.every((s2) => typeof s2.priority === 'number') && SETTINGS_SOURCES.length === 10,
    SETTINGS_SOURCES.map((s2) => s2.group + ':' + s2.priority).join(' '));

  // 邪门输入：拷一份最小树到仓库内（这样 @deepseek-ai/schemastery 还能解析到），
  // 分别塞「重复 group」和「schema 里没有的 group」，两者都必须在加载时炸掉。
  const scratch = mkdtempSync(path.join(repoRoot, 'test', '.tmp-defaults-'));
  try {
    cpSync(path.join(repoRoot, 'lib'), path.join(scratch, 'lib'), { recursive: true });
    const target = pathToFileURL(path.join(scratch, 'lib', 'config.js')).href;
    const runImport = () => execFileSync(process.execPath, ['--input-type=module', '-e', 'await import(' + JSON.stringify(target) + ')'],
      { stdio: 'pipe', encoding: 'utf8' });
    let okFirst = true;
    try { runImport(); } catch (error) { okFirst = false; }
    check('干净副本可以正常装载', okFirst === true);

    writeFileSync(path.join(scratch, 'lib', 'tools', 'dup-conf.json'),
      JSON.stringify({ group: 'vision', defaults: { enabled: false } }), 'utf8');
    let dupError = '';
    try { runImport(); } catch (error) { dupError = String((error.stderr || '') + (error.message || '')); }
    check('重复的 group 在加载时报错', dupError.includes('默认配置组重复'), dupError.slice(0, 120));

    rmSync(path.join(scratch, 'lib', 'tools', 'dup-conf.json'));
    writeFileSync(path.join(scratch, 'lib', 'tools', 'typo-conf.json'),
      JSON.stringify({ group: 'webSerach', defaults: { maxUses: 5 } }), 'utf8');
    let typoError = '';
    try { runImport(); } catch (error) { typoError = String((error.stderr || '') + (error.message || '')); }
    check('schema 里没有的 group 在加载时报错（否则清理会删用户配置）',
      typoError.includes('不在 Config schema 里'), typoError.slice(0, 120));

    // 设置页模板的护栏分两种口径：路径写错 / 标签页写错 **加载时炸掉**；
    // 文件名少了 -conf.json 后缀则是**静默忽略**（当成不相干文件，不报错）。
    rmSync(path.join(scratch, 'lib', 'tools', 'typo-conf.json'));

    // 覆盖已有的那份，而不是新增：新增会和现成的模板撞 group，先触发「组重复」那条。
    const setFile = path.join(scratch, 'lib', 'tools', 'websearch-set.json');
    const setFileBackup = readFileSync(setFile, 'utf8');
    writeFileSync(setFile, JSON.stringify({
      group: 'webSearch',
      fields: [{ path: ['webSearch', 'maxUse'], label: '拼错的字段', kind: 'number', tab: 'capability', subtab: 'retrieval' }],
    }), 'utf8');
    let badPathError = '';
    try { runImport(); } catch (error) { badPathError = String((error.stderr || '') + (error.message || '')); }
    check('设置页模板里拼错的路径在加载时报错（否则配置永远读不到）',
      badPathError.includes('路径不在 Config schema 里'), badPathError.slice(0, 160));

    writeFileSync(setFile, JSON.stringify({
      group: 'webSearch',
      fields: [{ path: ['webSearch', 'maxUses'], label: '标签页写错', kind: 'number', tab: 'nope', subtab: 'retrieval' }],
    }), 'utf8');
    let badTabError = '';
    try { runImport(); } catch (error) { badTabError = String((error.stderr || '') + (error.message || '')); }
    check('设置页模板里不存在的标签页在加载时报错（否则字段掉进谁也点不到的页）',
      badTabError.includes('不在设置页骨架里'), badTabError.slice(0, 160));

    writeFileSync(setFile, setFileBackup, 'utf8');

    // 后缀是「这份 JSON 归谁管」的区分：没后缀的文件两类扫描都不该收。
    writeFileSync(path.join(scratch, 'lib', 'tools', 'nosuffix.json'),
      JSON.stringify({ group: 'vision', defaults: { enabled: false } }), 'utf8');
    let suffixOk = true;
    try { runImport(); } catch (error) { suffixOk = false; }
    check('没有 -conf/-set 后缀的 JSON 被忽略（不会被当成默认值）', suffixOk === true);
    rmSync(path.join(scratch, 'lib', 'tools', 'nosuffix.json'));

    // priority：能改顺序、缺省落在内置之后、写错就在加载时炸掉。
    const readSources = () => JSON.parse(execFileSync(process.execPath,
      ['--input-type=module', '-e',
        'const m = await import(' + JSON.stringify(target) + '); console.log(JSON.stringify(m.SETTINGS_SOURCES.map((s2) => [s2.group, s2.priority])))'],
      { stdio: 'pipe', encoding: 'utf8' }));
    const moliFile = path.join(scratch, 'lib', 'tools', 'moli-set.json');
    const moliBackup = readFileSync(moliFile, 'utf8');
    const moliParsed = JSON.parse(moliBackup);
    writeFileSync(moliFile, JSON.stringify(Object.assign({}, moliParsed, { priority: 1 })), 'utf8');
    const withMoliFirst = readSources();
    check('把 moli 的 priority 改成 1 就排到最前（顺序真的由它决定）',
      withMoliFirst[0][0] === 'moli', JSON.stringify(withMoliFirst.slice(0, 2)));

    // 去掉 priority 时要把文件头其余部分（group / tab / subtab）原样留着：
    // 字段现在可以只靠文件头声明标签页，整份重建成 { group, fields } 会把 tab 弄丢。
    const noPriority = Object.assign({}, moliParsed);
    delete noPriority.priority;
    writeFileSync(moliFile, JSON.stringify(noPriority), 'utf8');
    const withoutPriority = readSources();
    check('不写 priority 时落在内置模板之后（默认 1000，不插队）',
      withoutPriority[withoutPriority.length - 1][0] === 'moli' && withoutPriority[withoutPriority.length - 1][1] === 1000,
      JSON.stringify(withoutPriority[withoutPriority.length - 1]));

    writeFileSync(moliFile, JSON.stringify(Object.assign({}, moliParsed, { priority: '9' })), 'utf8');
    let priError = '';
    try { runImport(); } catch (error) { priError = String((error.stderr || '') + (error.message || '')); }
    check('priority 不是数字时在加载时报错', priError.includes('priority 必须是有限数字'), priError.slice(0, 120));
    writeFileSync(moliFile, moliBackup, 'utf8');   // 先还原，后面几条都基于干净的文件

    // 同优先级：靠 tab / subtab 区分，不同分区怎么撞都不影响版面；
    // 只有「同一分区内同优先级」才回退到文件名（确定，但不再是版面的大局）。
    const histFile = path.join(scratch, 'lib', 'tools', 'history-set.json');
    const histBackup = readFileSync(histFile, 'utf8');
    const histParsed = JSON.parse(histBackup);
    const readVisionSub = () => JSON.parse(execFileSync(process.execPath,
      ['--input-type=module', '-e',
        'const m = await import(' + JSON.stringify(target) + '); console.log(JSON.stringify(m.SETTINGS_FIELDS.filter((f) => f.subtab === "vision").map((f) => f.group)))'],
      { stdio: 'pipe', encoding: 'utf8' }));

    writeFileSync(histFile, JSON.stringify(Object.assign({}, histParsed, { priority: 200 })), 'utf8');
    let crossOk = true;
    try { runImport(); } catch (error) { crossOk = false; }
    check('不同 tab / subtab 可以同优先级（flowAuth 200 与 history 200 互不干扰）', crossOk === true);

    writeFileSync(histFile, JSON.stringify(Object.assign({}, histParsed, { priority: 100 })), 'utf8');
    const tied = readVisionSub();
    check('同一分区内同优先级回退到文件名（history-set 排在 vision-set 之前）',
      tied[0] === 'history', JSON.stringify(tied.slice(0, 3)));
    writeFileSync(histFile, histBackup, 'utf8');

    // 文件头 tab / subtab：整份模板默认落哪个标签页，单条字段可以覆盖。
    const readFieldTabs = () => JSON.parse(execFileSync(process.execPath,
      ['--input-type=module', '-e',
        'const m = await import(' + JSON.stringify(target) + '); console.log(JSON.stringify(m.SETTINGS_FIELDS.filter((f) => f.group === "moli").map((f) => [f.path.join("."), f.tab, f.subtab])))'],
      { stdio: 'pipe', encoding: 'utf8' }));
    const headerOnly = readFieldTabs();
    check('字段不写 tab，靠文件头也能定位到标签页',
      headerOnly.every((row) => row[1] === 'capability' && row[2] === 'retrieval'), JSON.stringify(headerOnly.slice(0, 2)));

    const overrideDoc = Object.assign({}, moliParsed);
    overrideDoc.fields = moliParsed.fields.map((f, i) => (i === 0 ? Object.assign({}, f, { tab: 'advanced', subtab: 'flow' }) : f));
    writeFileSync(moliFile, JSON.stringify(overrideDoc), 'utf8');
    const overridden = readFieldTabs();
    // 排序改成「先按标签页/二级标签分桶」之后，moli 的字段不再连续了：
    // 被搬到 advanced/flow 的那条会出现在 advanced 段里，其余仍在 capability/retrieval。
    const moved = overridden.find((row) => row[0] === 'moli.enabled');   // 模板第一条，被改到 advanced/flow
    check('单条字段写的 tab / subtab 覆盖文件头',
      moved !== undefined && moved[1] === 'advanced' && moved[2] === 'flow'
      && overridden.filter((row) => row[0] !== 'moli.enabled')
        .every((row) => row[1] === 'capability' && row[2] === 'retrieval'),
      JSON.stringify(moved));

    const noTabDoc = Object.assign({}, moliParsed);
    delete noTabDoc.tab;
    delete noTabDoc.subtab;
    noTabDoc.fields = moliParsed.fields.map((f) => { const g = Object.assign({}, f); delete g.tab; delete g.subtab; return g; });
    writeFileSync(moliFile, JSON.stringify(noTabDoc), 'utf8');
    let noTabError = '';
    try { runImport(); } catch (error) { noTabError = String((error.stderr || '') + (error.message || '')); }
    check('文件头和字段都没写 tab 时在加载时报错', noTabError.includes('字段缺少 tab'), noTabError.slice(0, 120));
    writeFileSync(moliFile, moliBackup, 'utf8');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const passed = results.filter(Boolean).length;
console.log('\n' + passed + '/' + results.length + ' 项通过');
if (failures > 0) { console.log('配置自测失败'); process.exit(1); }
console.log('配置自测通过');
process.exit(0);
