/** 单元测试：lib/tools/websearch.js —— 后端优先级（order）编排 + 可用性/失败归类 */
import {
  runWebSearch, normalizeOrder, hasUsableSnippets, backendAvailable, backendSkipReason,
  classifySearchError, FREE_BACKEND_ID, DEEPSEEK_BACKEND_ID, SEARCH_DEFAULT_ORDER, __setSearchLogger,
  parseYandexResults, parseBingResults, parseBingRss, parseDdgResults, meLooksRelevant, BACKEND_LABELS,
} from '../lib/tools/websearch.js';
import { meCleanText, __setNetworkHooks } from '../lib/shared/http.js';

/** 装/卸出网桩：M3 的行为断言必须走免 Key 多引擎那条路径，那条要真网络。 */
const netHooks = (hooks) => __setNetworkHooks(hooks);

/** 取消是否被正确处理：抛出来的必须是「已中止」那一类，而不是被吞成空结果。 */
function r5iOk(error) {
  if (error === null || error === undefined) return false;
  const name = String(error.name === undefined ? '' : error.name);
  const message = String(error.message === undefined ? '' : error.message);
  return name === 'AbortError' || /abort/i.test(name) || /abort/i.test(message);
}

const results = [];
let failures = 0;
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok));
  if (ok) console.log('  [PASS] ' + name);
  else { failures += 1; console.log('  [FAIL] ' + name + (detail ? ' — ' + detail : '')); }
};

console.log('1. 默认优先级：DeepSeek Search API 打头，免 Key 多引擎垫底');
check('默认顺序是 Search API → 智谱 GLM → 内置免 Key 多引擎',
  JSON.stringify(SEARCH_DEFAULT_ORDER) === JSON.stringify([DEEPSEEK_BACKEND_ID, 'zhipu-web-search-prime', FREE_BACKEND_ID]),
  JSON.stringify(SEARCH_DEFAULT_ORDER));
check('默认顺序里 DeepSeek 只有一条（Search API）',
  SEARCH_DEFAULT_ORDER.filter((id) => id.indexOf('deepseek') === 0).length === 1
  && SEARCH_DEFAULT_ORDER[0] === DEEPSEEK_BACKEND_ID, JSON.stringify(SEARCH_DEFAULT_ORDER));
check('免 Key 多引擎永远排最后（前面都不行了才花它）',
  SEARCH_DEFAULT_ORDER.indexOf(FREE_BACKEND_ID) === SEARCH_DEFAULT_ORDER.length - 1,
  JSON.stringify(SEARCH_DEFAULT_ORDER));

console.log('\n2. normalizeOrder：去重 / 去非字符串 / 上限 / 空列表回默认');
check('非数组 / 空数组 / 全是空白项 → 回默认顺序（本插件没有「不接管」语义）',
  JSON.stringify(normalizeOrder(undefined)) === JSON.stringify(SEARCH_DEFAULT_ORDER.slice())
  && JSON.stringify(normalizeOrder([])) === JSON.stringify(SEARCH_DEFAULT_ORDER.slice())
  && JSON.stringify(normalizeOrder(['', '   '])) === JSON.stringify(SEARCH_DEFAULT_ORDER.slice()));
check('去重 + 丢掉非字符串 + 逐项 trim',
  JSON.stringify(normalizeOrder([' a ', 'a', 42, null, 'b'])) === JSON.stringify(['a', 'b']),
  JSON.stringify(normalizeOrder([' a ', 'a', 42, null, 'b'])));
check('超过上限（8）时截断',
  normalizeOrder(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']).length === 8,
  String(normalizeOrder(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']).length));
check('保持用户给的顺序（不排序、不打乱）',
  JSON.stringify(normalizeOrder(['dsh-qq-bot-free', 'deepseek-search-api'])) === JSON.stringify(['dsh-qq-bot-free', 'deepseek-search-api']));

console.log('\n3. hasUsableSnippets：整批无简介视为后端降级');
check('空结果集算「可用」（无结果是合法结局，不该换后端重试）', hasUsableSnippets([]) === true);
check('全部有简介 → true', hasUsableSnippets([{ url: 'a', snippet: 'x' }, { url: 'b', snippet: 'y' }]) === true);
check('全部无简介 → false（只有标题和链接时，模型看不出每条讲什么）', hasUsableSnippets([{ url: 'a' }, { url: 'b' }]) === false);
check('一半有简介（覆盖率恰好 0.5）→ true', hasUsableSnippets([{ url: 'a', snippet: 'x' }, { url: 'b' }]) === true);
check('三分之一有简介（覆盖率 0.33 < 0.5）→ false', hasUsableSnippets([{ url: 'a', snippet: 'x' }, { url: 'b' }, { url: 'c' }]) === false);
check('空白 snippet 不算有简介', hasUsableSnippets([{ url: 'a', snippet: '   ' }]) === false);

console.log('\n4. backendAvailable：只看注册表，不做任何回退');
const fakeCtx = (providers) => ({
  get: (name) => (name === 'web' ? { searchProviders: new Map(providers) } : undefined),
});
check('内置免 Key 多引擎永远「可用」（它就是本模块自己，失败由降级逻辑兜住）',
  backendAvailable(fakeCtx([]), FREE_BACKEND_ID) === true);
// 关键语义：DeepSeek 的后端**不由本模块自带实现**——注册表里没有就是不可用，绝不回退。
check('注册表里没有 deepseek-search-api → 不可用（本模块不自带实现、不回退）',
  backendAvailable(fakeCtx([]), DEEPSEEK_BACKEND_ID) === false);
check('未注册的第三方 provider → 不可用（静默跳过，不记为失败）',
  backendAvailable(fakeCtx([]), 'zhipu-web-search-prime') === false);
check('注册表里有且 available() 为真 → 可用',
  backendAvailable(fakeCtx([['zhipu-web-search-prime', { id: 'zhipu-web-search-prime', available: () => true, search: async () => ({ sources: [] }) }]]), 'zhipu-web-search-prime') === true);
check('注册表里有但 available() 为假 → 不可用',
  backendAvailable(fakeCtx([['zhipu-web-search-prime', { id: 'zhipu-web-search-prime', available: () => false, search: async () => ({ sources: [] }) }]]), 'zhipu-web-search-prime') === false);
check('available() 抛异常 → 按不可用处理（不把异常抛到搜索主链路）',
  backendAvailable(fakeCtx([['boom', { id: 'boom', available: () => { throw new Error('boom'); }, search: async () => ({ sources: [] }) }]]), 'boom') === false);
check('拿不到 web 服务也不炸', backendAvailable({}, 'deepseek-search-api') === false && backendAvailable(null, FREE_BACKEND_ID) === true);

console.log('\n4b. backendSkipReason：跳过原因要能分开记（未注册 / 不可用 / 探测异常）');
check('内置免 Key 多引擎没有跳过原因', backendSkipReason(fakeCtx([]), FREE_BACKEND_ID) === null);
check('未注册 → unregistered（不是「不可用」）',
  backendSkipReason(fakeCtx([]), DEEPSEEK_BACKEND_ID).kind === 'unregistered',
  JSON.stringify(backendSkipReason(fakeCtx([]), DEEPSEEK_BACKEND_ID)));
check('provider 报 available()=false → unavailable（凭据缺失 / 端点无效走这一支）',
  backendSkipReason(fakeCtx([['p', { id: 'p', available: () => false, search: async () => ({ sources: [] }) }]]), 'p').kind === 'unavailable',
  JSON.stringify(backendSkipReason(fakeCtx([['p', { id: 'p', available: () => false, search: async () => ({ sources: [] }) }]]), 'p')));
check('available() 抛异常 → probe-failed（不是「没配」，是 provider 内部坏了）',
  backendSkipReason(fakeCtx([['p', { id: 'p', available: () => { throw new Error('boom'); }, search: async () => ({ sources: [] }) }]]), 'p').kind === 'probe-failed');
check('可用时返回 null', backendSkipReason(fakeCtx([['p', { id: 'p', available: () => true, search: async () => ({ sources: [] }) }]]), 'p') === null);

console.log('\n4c. classifySearchError：余额不足必须与「凭据无效 / 未配置」分开');
{
  const cls = (error) => classifySearchError(error).kind;
  const mk = (message, code) => Object.assign(new Error(message), code === undefined ? {} : { code });
  check('HTTP 402 → no-balance', cls(mk('DeepSeek API error (HTTP 402)', 402)) === 'no-balance');
  check('消息含 Insufficient Balance → no-balance',
    cls(mk('DeepSeek API error (HTTP 402): Insufficient Balance')) === 'no-balance');
  check('中文「余额不足」→ no-balance', cls(mk('搜索失败：官方 API 余额不足')) === 'no-balance');
  check('401 → auth（是凭据问题，不是没钱）', cls(mk('Unauthorized', 401)) === 'auth');
  check('WEB_PROVIDER_CREDENTIAL_MISSING → credential',
    cls(mk('DeepSeek search has no API key', 'WEB_PROVIDER_CREDENTIAL_MISSING')) === 'credential');
  check('429 → rate-limit', cls(mk('Too Many Requests', 429)) === 'rate-limit');
  check('provider 报 configured unavailable → unavailable',
    cls(mk('configured web provider is registered but unavailable', 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE')) === 'unavailable');
  check('认不出的错误 → error（不硬套成上面任何一类）', cls(mk('something odd')) === 'error');
  check('每类都有给人看的中文标签', ['no-balance', 'auth', 'rate-limit', 'credential', 'unavailable', 'error']
    .every((kind) => ['余额不足', '凭据无效 / 未登录', '被限流', '凭据缺失', '后端不可用', '调用失败']
      .includes(classifySearchError(Object.assign(new Error('x'), { code: kind === 'no-balance' ? 402 : kind === 'auth' ? 401 : kind === 'rate-limit' ? 429 : kind === 'credential' ? 'WEB_PROVIDER_CREDENTIAL_MISSING' : kind === 'unavailable' ? 'WEB_PROVIDER_UNAVAILABLE' : 'x' })).label)));
}

console.log('\n4d. 日志：跳过 / 降级 / 失败（含「余额不足」）必须是不同的句子');
{
  const lines = [];
  __setSearchLogger((line) => lines.push(line));
  const mk = (message, code) => Object.assign(new Error(message), code === undefined ? {} : { code });

  // 未注册的后端 → 「跳过」而不是「失败」
  const ctxNone = { get: () => ({ searchProviders: new Map() }) };
  await runWebSearch('q', { order: ['not-registered'], perQuery: 0 }, undefined, ctxNone);
  check('未注册写「跳过」并说明原因', lines.some((l) => l.includes('跳过') && l.includes('未注册')), lines.join(' | '));

  // 余额不足 → 「余额不足」，且不写成「凭据缺失」
  lines.length = 0;
  const broke = { id: 'broke', available: () => true, search: async () => { throw mk('DeepSeek API error (HTTP 402): Insufficient Balance', 402); } };
  try { await runWebSearch('q', { order: ['broke'], perQuery: 0 }, undefined, { get: () => ({ searchProviders: new Map([['broke', broke]]) }) }); } catch {}
  check('余额不足写「余额不足」', lines.some((l) => l.includes('余额不足')), lines.join(' | '));
  check('余额不足不写成「凭据缺失 / 未配置」', !lines.some((l) => l.includes('凭据缺失')), lines.join(' | '));

  // 401 → 「凭据无效」，同样不能写成「余额不足」
  lines.length = 0;
  const unauthorized = { id: 'unauth', available: () => true, search: async () => { throw mk('Unauthorized', 401); } };
  try { await runWebSearch('q', { order: ['unauth'], perQuery: 0 }, undefined, { get: () => ({ searchProviders: new Map([['unauth', unauthorized]]) }) }); } catch {}
  check('401 写「凭据无效 / 未登录」', lines.some((l) => l.includes('凭据无效')), lines.join(' | '));
  check('401 不写成「余额不足」', !lines.some((l) => l.includes('余额不足')), lines.join(' | '));

  // 整批无简介 → 「降级」
  lines.length = 0;
  const noSnippet = { id: 'nosnip', available: () => true, search: async () => ({ sources: [{ url: 'https://a.example/' }], truncated: false }) };
  const okNext = { id: 'oknext', available: () => true, search: async () => ({ sources: [{ url: 'https://b.example/', snippet: 's' }], truncated: false }) };
  await runWebSearch('q', { order: ['nosnip', 'oknext'], perQuery: 0 }, undefined, { get: () => ({ searchProviders: new Map([['nosnip', noSnippet], ['oknext', okNext]]) }) });
  check('整批无简介写「降级」而不是「失败」', lines.some((l) => l.includes('降级')), lines.join(' | '));

  __setSearchLogger(null);
}

console.log('\n4e. 解析器：属性再长也不能整批丢结果（Yandex 回归）');
{
  // 2026-11 实测：Yandex 把 onmousedown 埋点内联在 title 链接标签里，那段约 2.2K 字符。
  // 旧实现用 /href="…"[^>]{0,512}?>/ 限定属性窗口，于是真实页面上 14 个 title-link 全解析不出来，
  // Yandex 这个兜底引擎常年空转（表现为「多引擎结果全是 Bing 的泛匹配」）。
  const longAttr = 'onmousedown="rc(this, \'' + '//yandex.com/clck/jsredir?'.padEnd(2200, 'x') + '\')"';
  const page = '<ol class="b-serp-list">'
    + '<li class="b-serp-item"><h3 class="b-serp-item__title">'
    + '<a class="b-serp-item__title-link" href="https://github.com/deepseek-ai/deepseek-harness" ' + longAttr + '>DeepSeek Harness</a>'
    + '</h3><div class="b-serp-item__text">release notes 摘要</div></li>'
    + '<li class="b-serp-item"><h3 class="b-serp-item__title">'
    + '<a class="b-serp-item__title-link" href="https://example.com/second">第二条</a>'
    + '</h3><div class="b-serp-item__text">第二段摘要</div></li>'
    + '</ol>';
  const got = parseYandexResults(page);
  check('超长属性（约 2.2K）不再让整批结果丢失', got.length === 2, String(got.length));
  check('URL / 标题 / 摘要都解析出来',
    got[0].url === 'https://github.com/deepseek-ai/deepseek-harness' && got[0].title === 'DeepSeek Harness'
    && got[0].snippet === 'release notes 摘要' && got[1].url === 'https://example.com/second',
    JSON.stringify(got[0]));
  check('CSS 里出现的类名不会被当成结果（前面不是 <a）',
    parseYandexResults('<style>.b-serp-item__title-link{color:red}</style>').length === 0);
  check('clck/jsredir 跳转链接被丢弃',
    parseYandexResults('<a class="b-serp-item__title-link" href="//yandex.com/clck/jsredir?url=x">x</a>').length === 0);
}


/** 规模翻倍耗时不该翻倍以上：病态输入下若退化成平方级，比例会到 3–4 倍。 */
function timeMs(fn, input) {
  const t0 = performance.now();
  fn(input);
  return performance.now() - t0;
}

console.log('\n4h. hasUsableSnippets 也要认 summary（DSH 的 WebSearchSource 允许只给 summary）');
{
  check('只有 summary 的整批判为可用（不该白白降级换后端）',
    hasUsableSnippets([{ url: 'https://a', summary: '有摘要没 snippet' }, { url: 'https://b', summary: '也有' }]) === true);
  check('只有 snippet 的整批仍可用',
    hasUsableSnippets([{ url: 'https://a', snippet: 's' }, { url: 'https://b', snippet: 's' }]) === true);
  check('两个字段都没有的整批判为不可用',
    hasUsableSnippets([{ url: 'https://a' }, { url: 'https://b' }]) === false);
  check('snippet 与 summary 混着给也认（各占一半）',
    hasUsableSnippets([{ url: 'https://a', snippet: 's' }, { url: 'https://b', summary: 'm' }]) === true);
}

console.log('\n4i. 覆盖率判定与错误分类的边界（M1/M2/M3 回归）');
{
  // M1：覆盖率先于截断判定 —— 前 2 条没简介、后 8 条有，整批本来就合格。
  // 旧实现先 cap 到 2 条（全是没简介的）→ 覆盖率 0 → 白白降级换后端。
  const partial = [
    { url: 'https://a' }, { url: 'https://b' },
    ...Array.from({ length: 8 }, (_, i) => ({ url: 'https://c' + i, snippet: 'has snippet' })),
  ];
  check('M1：整批覆盖率按**截断前**算（10 条里 8 条有简介 = 合格）',
    hasUsableSnippets(partial) === true);
  check('M1：截断后只有没简介的那些才算不合格（这正是要避免的误判）',
    hasUsableSnippets(partial.slice(0, 2)) === false);

  // M2：「余额」二字不能单独当成没钱
  const mk = (s) => Object.assign(new Error(s), { code: 'WEB_PROVIDER_ERROR' });
  check('M2：余额查询失败不算余额不足', classifySearchError(mk('余额查询接口返回 500')).kind === 'error',
    classifySearchError(mk('余额查询接口返回 500')).kind);
  check('M2：余额耗尽仍算余额不足', classifySearchError(mk('账户余额耗尽')).kind === 'no-balance');
  check('M2：error after 402 ms 不误判成 402', classifySearchError(mk('error after 402 ms')).kind === 'error',
    classifySearchError(mk('error after 402 ms')).kind);
  check('M2：403 优先于余额字样', classifySearchError(mk('403 insufficient permissions')).kind === 'auth');

  // M3 的 aborted 判定在**免 Key 多引擎**那条路径里（provider 路径走不到），所以要桩掉出网。
  // 判据：上游回「Request cancelled by server」时，用户**没有**点停止，结果必须是「搜索失败」
  // 而不是「搜索已取消」—— 后者会把真故障伪装成用户操作，而且零日志。
  const fakeAbort = Object.assign(new Error('Request cancelled by server'), { code: 'WEB_PROVIDER_ERROR' });
  check('M3：上游文本含 cancelled 的分类不是「余额不足」',
    classifySearchError(fakeAbort).kind === 'error', classifySearchError(fakeAbort).kind);
  {
    // 判据不能只看 name：聚合错误被包成普通 Error 后 name 仍是 'Error'，
    // 变异（按文本判取消）会把它伪装成「搜索已取消」却仍叫 Error —— 必须查消息内容。
    const hooks = { request: async () => { throw new Error('Request cancelled by server'); } };
    netHooks(hooks);
    let thrown = null;
    try { await runWebSearch('q', { order: [FREE_BACKEND_ID] }, undefined, fakeCtx([])); }
    catch (e) { thrown = e; }
    netHooks(null);
    check('M3：上游回 cancelled 时抛的是「搜索失败」而不是「已取消」',
      thrown !== null && thrown.name !== 'AbortError' && !String(thrown.message).includes('已取消'),
      thrown === null ? '未抛出' : thrown.name + ' | ' + String(thrown.message).slice(0, 60));
  }
}
console.log('\n4g. 解析器对病态输入必须保持线性（H4/H5 回归）');
{
  const buildBing = (n) => '<item>'.repeat(n);
  const b1 = timeMs(parseBingRss, buildBing(20000));
  const b2 = timeMs(parseBingRss, buildBing(80000));
  check('Bing RSS 未闭合 item：4 倍输入耗时不到 8 倍（线性≈4x，平方≈16x）',
    b2 < Math.max(b1, 0.5) * 8, 'q1=' + b1.toFixed(1) + 'ms q4=' + b2.toFixed(1) + 'ms');

  // 关键：整段里**一个 </div> 都没有**，也没���下一条 marker 之外的边界 ——
  // 这才触发「无界 indexOf 每轮扫到末尾」那条平方级路径（实测去掉记忆后比值 9.6x）。
  const buildYandex = (n) => {
    let s = '';
    for (let i = 0; i < n; i += 1) {
      s += '<a class="b-serp-item__title-link" href="https://x.com/' + i + '">t</a>'
        + '<div class="b-serp-item__text">摘要无闭合' + i;
    }
    return s;
  };
  const y1 = timeMs(parseYandexResults, buildYandex(1000));
  const y2 = timeMs(parseYandexResults, buildYandex(4000));
  check('Yandex 缺 </div> 闭合：4 倍输入耗时不到 8 倍（线性≈4x，平方≈16x）',
    y2 < Math.max(y1, 0.5) * 8, 'q1=' + y1.toFixed(1) + 'ms q4=' + y2.toFixed(1) + 'ms');

  const buildTags = (n) => '<a '.repeat(n);
  const c1 = timeMs(meCleanText, buildTags(5000));
  const c2 = timeMs(meCleanText, buildTags(20000));
  check('meCleanText 未闭合尖括号：4 倍输入耗时不到 8 倍（线性≈4x，平方≈16x）',
    c2 < Math.max(c1, 0.5) * 8, 'q1=' + c1.toFixed(1) + 'ms q4=' + c2.toFixed(1) + 'ms');

  // 语义就是「去掉标签、保留可见文本」——相邻标签之间不补空格（与旧实现一致）。
  check('meCleanText 正常输入语义不变（去标签保留文本）',
    meCleanText('<p>hello</p><b>world</b>') === 'helloworld', JSON.stringify(meCleanText('<p>hello</p><b>world</b>')));
  check('meCleanText 保留正文里的孤立尖括号（不误当成标签吞掉整段）',
    meCleanText('a < b') === 'a < b', JSON.stringify(meCleanText('a < b')));
}
console.log('\n4f. 解析器：Bing / DDG 的结构回归');
{
  const bingRss = '<rss><channel><item><title>甲</title><link>https://a.example/</link>'
    + '<description>摘要甲</description><pubDate>Wed, 12 Nov 2025 10:00:00 GMT</pubDate></item>'
    + '<item><title>乙</title><link>https://b.example/</link><description>摘要乙</description></item>'
    + '</channel></rss>';
  const rss = parseBingRss(bingRss);
  check('Bing RSS 解析出标题/链接/摘要', rss.length === 2 && rss[0].title === '甲' && rss[0].url === 'https://a.example/' && rss[0].snippet === '摘要甲');
  check('Bing RSS 的 pubDate 能转成 ISO（非法日期则省略）',
    typeof rss[0].publishedAt === 'string' && rss[0].publishedAt.indexOf('2025-11-12') === 0 && rss[1].publishedAt === undefined,
    String(rss[0].publishedAt));

  const bingHtml = '<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=1&amp;u=a1aHR0cHM6Ly9hLmV4YW1wbGUv">甲</a></h2>'
    + '<div class="b_caption"><p class="b_lineclamp4">摘要甲</p></div></li>';
  const bh = parseBingResults(bingHtml);
  check('Bing HTML 的 ck/a 跳转能还原成真实 URL',
    bh.length === 1 && bh[0].url === 'https://a.example/' && bh[0].title === '甲', JSON.stringify(bh[0]));

  const ddg = '<div class="result"><h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fx">标题</a></h2>'
    + '<a class="result__snippet">摘要</a></div>';
  const d = parseDdgResults(ddg);
  check('DDG html 的 uddg 跳转能还原成真实 URL',
    d.length === 1 && d[0].url === 'https://example.com/x' && d[0].title === '标题' && d[0].snippet === '摘要', JSON.stringify(d[0]));
}

console.log('\n5. runWebSearch：按优先级降级（顺序 / 失败 / 无简介 / 全部失败 / 全部无结果 / 取消 / 条数）');
{
  // 用注册表里的假 provider 当后端，避开内置免 Key 多引擎的真实网络请求：
  // 降级逻辑本身与「后端怎么实现」无关，这正是要验证的那部分。
  const provider = (id, behavior) => ({
    id,
    available: () => true,
    search: async (request) => behavior(request),
  });
  const ctxWith = (...providers) => ({
    get: (name) => (name === 'web' ? { searchProviders: new Map(providers.map((item) => [item.id, item])) } : undefined),
  });
  const good = (tag) => ({ sources: [{ url: 'https://' + tag + '.example/x', title: tag, snippet: '摘要' + tag }], truncated: false });
  const callLog = [];
  const cfgWith = (order) => ({ order, perQuery: 0 });

console.log('\n4j. low 批次：字典打穿 / truncated 传递 / 相关性闸门覆盖');
{
  // L：普通对象当字典会被原型链打穿 —— 'constructor' / 'toString' 会拿到函数而不是 undefined。
  // 用 null 原型之后这些名字查不到，日志才不会打出 "[Function: Object]"。
  {
    const { BACKEND_LABELS_PROBE } = { BACKEND_LABELS_PROBE: null };
    // 通过行为间接验证：构造一个 id 为 'constructor' 的后端，看降级日志里写的是什么
    // 必须让 provider **抛错**：只有走失败分支才会调 describeSkipLabel → 查 BACKEND_LABELS[id]。
    // 返回空数组走的是「无结果」分支，压根不查字典，那样断言就没有判别力（实测过）。
    const weird = provider('constructor', async () => { throw new Error('boom'); });
    const cfgW = { order: ['constructor'] };
    let logs = [];
    __setSearchLogger((line) => logs.push(line));
    let thrown = null;
    try { await runWebSearch('q', cfgW, undefined, ctxWith(weird)); } catch (e) { thrown = e; }
    __setSearchLogger(null);
    // 直接验字典形状：普通对象查 'constructor' 会拿到 Object 构造函数（实测确认过），
    // null 原型则返回 undefined。这条比「看日志里有没有 [Function:」更直接，
    // 因为日志文案在撞名后本来就会拼成「其它后端 · constructor」，两种实现看不出差别。
    check('L：BACKEND_LABELS 不会从原型链上取到值（constructor/toString 查不到）',
      BACKEND_LABELS['constructor'] === undefined && BACKEND_LABELS['toString'] === undefined,
      'constructor=' + typeof BACKEND_LABELS['constructor']);
  }

  // L：provider 报 truncated 时要能传出来（挂在 sources 上，不改返回值形状）
  {
    const truncProvider = provider('fake-trunc', async () => ({
      sources: [{ url: 'https://t.example/x', title: 'T', snippet: 'S' }],
      truncated: true,
    }));
    const got = await runWebSearch('q', { order: ['fake-trunc'] }, undefined, ctxWith(truncProvider));
    check('L：provider 的 truncated 被保留下来（不是丢弃）',
      got.length === 1 && got.truncated === true, 'len=' + got.length + ' truncated=' + String(got.truncated));
  }

  // L：相关性闸门现在也覆盖 DDG / Tavily / Wikipedia（整批零重叠时不交出去）
  {
    const irrelevant = [{ url: 'https://spam.example/p', title: '完全无关的页面', snippet: 'nothing related' }];
    check('L：整批与查询零重叠时相关性闸门判为不相关',
      meLooksRelevant(irrelevant, 'rust 1.91.0 release') === false);
    check('L：有一条命中词元就算相关（最强召回口径，不误杀）',
      meLooksRelevant([{ url: 'https://x', title: 'Rust 1.91.0 released', snippet: '' }], 'rust 1.91.0 release') === true);
  }
}

  // M1 的**行为**断言：cap=2 时不能因为「前 2 条没简介」就把整批换掉。
  // 旧实现先截到 cap 再算覆盖率 → 整批被换；修后多要一些、截断在判定之后。
  {
    // 判据是「上层向 provider 要了多少条」：要多一些，才能拿到「前 2 条没简介」之后那些有简介的。
    // 只断言「最终返回 2 条」抓不住回退 —— 旧实现也只返回 2 条（就是那 2 条没简介的）。
    const allPartial = [
      { url: 'https://a' }, { url: 'https://b' },
      ...Array.from({ length: 8 }, (_, i) => ({ url: 'https://c' + i, title: 'T' + i, snippet: 'has snippet' })),
    ];
    let asked = null;
    const partialProvider = provider('fake-partial', async (req) => {
      asked = req.maxResults;
      return { sources: typeof req.maxResults === 'number' ? allPartial.slice(0, req.maxResults) : allPartial };
    });
    const r2 = await runWebSearch('q', { order: ['fake-partial'], perQuery: 2 }, undefined, ctxWith(partialProvider));
    check('M1：perQuery=2 时向 provider 要多于 2 条（否则覆盖率只能看到没简介的头几条）',
      typeof asked === 'number' && asked > 2, String(asked));
    check('M1：最终返回条数仍被 cap 到 perQuery',
      Array.isArray(r2) && r2.length === 2, JSON.stringify(r2 && r2.length));
  }

  // M3 的**行为**断言：上游回 cancelled 必须走「失败」而不是「用户取消」。
  {
    const cancelProvider = provider('fake-cancel', async () => { throw Object.assign(new Error('Request cancelled by server'), { code: 'WEB_PROVIDER_ERROR' }); });
    let thrown = null;
    try { await runWebSearch('q', { order: ['fake-cancel'] }, undefined, ctxWith(cancelProvider), undefined); }
    catch (e) { thrown = e; }
    check('M3：上游 cancelled 不被伪装成「搜索已取消」',
      thrown !== null && thrown.name !== 'AbortError', thrown === null ? '未抛出' : thrown.name + ':' + String(thrown.message).slice(0, 40));
  }

  // 5a. 第一个成功就停：第二个必须一次都不被调用（不是「都跑一遍再挑」）。
  callLog.length = 0;
  const a = provider('fake-a', async () => { callLog.push('a'); return good('a'); });
  const b = provider('fake-b', async () => { callLog.push('b'); return good('b'); });
  const r5a = await runWebSearch('q', cfgWith(['fake-a', 'fake-b']), undefined, ctxWith(a, b));
  check('第一个后端成功即返回，后续后端不被调用',
    callLog.join(',') === 'a' && r5a.length === 1 && r5a[0].title === 'a', callLog.join(','));

  // 5b. 第一个抛错 → 第二个接上；错误不冒泡到调用方。
  callLog.length = 0;
  const a2 = provider('fake-a', async () => { callLog.push('a'); throw new Error('fake-a 挂了'); });
  const b2 = provider('fake-b', async () => { callLog.push('b'); return good('b'); });
  const r5b = await runWebSearch('q', cfgWith(['fake-a', 'fake-b']), undefined, ctxWith(a2, b2));
  check('前一个后端失败时降级到下一个（错误不外抛）',
    callLog.join(',') === 'a,b' && r5b.length === 1 && r5b[0].title === 'b', callLog.join(','));

  // 5c. 第一个「成功但整批无简介」→ 记为回落候选，继续试第二个。
  callLog.length = 0;
  const a3 = provider('fake-a', async () => { callLog.push('a'); return { sources: [{ url: 'https://a.example/n' }], truncated: false }; });
  const b3 = provider('fake-b', async () => { callLog.push('b'); return good('b'); });
  const r5c = await runWebSearch('q', cfgWith(['fake-a', 'fake-b']), undefined, ctxWith(a3, b3));
  check('整批无简介的后端被跳过，用后面带简介的结果',
    callLog.join(',') === 'a,b' && r5c[0].title === 'b', callLog.join(','));

  // 5d. 全部无简介 → 回落到候选（绝不比不加闸门更差：宁可少简介，也别给空结果或报错）。
  callLog.length = 0;
  const a4 = provider('fake-a', async () => { callLog.push('a'); return { sources: [{ url: 'https://a.example/n1' }], truncated: false }; });
  const b4 = provider('fake-b', async () => { callLog.push('b'); return { sources: [{ url: 'https://b.example/n2' }], truncated: false }; });
  const r5d = await runWebSearch('q', cfgWith(['fake-a', 'fake-b']), undefined, ctxWith(a4, b4));
  check('全部后端都无简介时回落到候选结果（不返回空、不报错）',
    r5d.length === 1 && r5d[0].url === 'https://b.example/n2', JSON.stringify(r5d));

  // 5e. 全部失败 → 抛聚合错误，每个后端的归因都要在（只报最后一个会把 A 的故障当成全局故障）。
  callLog.length = 0;
  const a5 = provider('fake-a', async () => { callLog.push('a'); throw new Error('A 挂了'); });
  const b5 = provider('fake-b', async () => { callLog.push('b'); throw new Error('B 挂了'); });
  let err5e = null;
  try { await runWebSearch('q', cfgWith(['fake-a', 'fake-b']), undefined, ctxWith(a5, b5)); } catch (error) { err5e = error; }
  check('全部失败时抛错，且错误里聚合了每个后端的归因',
    err5e !== null && String(err5e.message).includes('其它后端 · fake-a') && String(err5e.message).includes('其它后端 · fake-b')
    && String(err5e.message).includes('A 挂了') && String(err5e.message).includes('B 挂了'),
    err5e === null ? '没抛错' : String(err5e.message).slice(0, 200));

  // 5f. 全部「无结果」且没有真实失败 → 空数组（不是错误：没搜到东西是合法结局）。
  callLog.length = 0;
  const a6 = provider('fake-a', async () => { callLog.push('a'); return { sources: [], truncated: false }; });
  const b6 = provider('fake-b', async () => { callLog.push('b'); return { sources: [], truncated: false }; });
  const r5f = await runWebSearch('q', cfgWith(['fake-a', 'fake-b']), undefined, ctxWith(a6, b6));
  check('全部后端都没结果时返回空数组（不报错）',
    Array.isArray(r5f) && r5f.length === 0 && callLog.join(',') === 'a,b', JSON.stringify(r5f) + ' / ' + callLog.join(','));

  // 5g. 未注册的后端静默跳过：既不算失败、也不该阻断后面的后端。
  callLog.length = 0;
  const b7 = provider('fake-b', async () => { callLog.push('b'); return good('b'); });
  const r5g = await runWebSearch('q', cfgWith(['not-registered', 'fake-b']), undefined, ctxWith(b7));
  check('未注册的后端被静默跳过（不记失败、不阻断后续）',
    callLog.join(',') === 'b' && r5g[0].title === 'b', callLog.join(','));

  // 5g2. 注册表里没有 deepseek-search-api 时**不回退**：直接跳过，落到下一项。
  callLog.length = 0;
  const c8 = provider('fake-c', async () => { callLog.push('c'); return good('c'); });
  const r5g2 = await runWebSearch('q', cfgWith([DEEPSEEK_BACKEND_ID, 'fake-c']), undefined, ctxWith(c8));
  check('deepseek-search-api 未注册时跳过（本模块不自带实现、不回退到自有 HTTP 实现）',
    callLog.join(',') === 'c' && r5g2[0].title === 'c', callLog.join(','));
  // 只列 deepseek-search-api 且注册表里没有它：既没有真实失败也没有结果 → 空数组（不是报错）。
  const r5g3 = await runWebSearch('q', cfgWith([DEEPSEEK_BACKEND_ID]), undefined, ctxWith());
  check('唯一列出的后端未注册时返回空数组（跳过不算失败）',
    Array.isArray(r5g3) && r5g3.length === 0, JSON.stringify(r5g3));

  // 5h. perQuery 生效：cap 传参 > cfg.perQuery > 默认；0 = 不截断。
  const many = { sources: [1, 2, 3, 4, 5].map((n) => ({ url: 'https://x.example/' + n, title: 't' + n, snippet: 's' })), truncated: false };
  const capProvider = provider('fake-cap', async () => many);
  const r5h = await runWebSearch('q', { order: ['fake-cap'], perQuery: 2 }, undefined, ctxWith(capProvider));
  check('cfg.perQuery 生效（截到 2 条）', r5h.length === 2, String(r5h.length));
  const r5hCap = await runWebSearch('q', { order: ['fake-cap'], perQuery: 2 }, 4, ctxWith(capProvider));
  check('调用方传的条数优先于 cfg.perQuery（截到 4 条）', r5hCap.length === 4, String(r5hCap.length));
  const r5hOff = await runWebSearch('q', { order: ['fake-cap'], perQuery: 0 }, undefined, ctxWith(capProvider));
  check('perQuery = 0 表示不截断（5 条全留）', r5hOff.length === 5, String(r5hOff.length));
  const r5hMax = await runWebSearch('q', { order: ['fake-cap'], perQuery: 0 }, 99, ctxWith(capProvider));
  check('调用方条数被钳到上限（50）而不是原样透传', r5hMax.length === 5, String(r5hMax.length));

  // 5i. 取消信号：已中止时不再继续降级，并且把取消原样抛回去（不是「当成后端失败」）。
  callLog.length = 0;
  const controller = new AbortController();
  controller.abort();
  const a9 = provider('fake-a', async () => { callLog.push('a'); return good('a'); });
  let err5i = null;
  try { await runWebSearch('q', cfgWith(['fake-a']), undefined, ctxWith(a9), controller.signal); } catch (error) { err5i = error; }
  check('取消后立即停止（不再调用后端，且抛出取消原因而不是空结果）',
    callLog.length === 0 && r5iOk(err5i), String(err5i));

  // 5j. 传给 provider 的 maxResults 与 cap 一致（后端能按需少取）。
  let seenMaxResults = null;
  const spy = provider('fake-spy', async (request) => { seenMaxResults = request.maxResults; return good('spy'); });
  await runWebSearch('q', { order: ['fake-spy'], perQuery: 3 }, undefined, ctxWith(spy));
  // 语义变更（M1）：上层要先按「整批覆盖率」判定要不要降级，所以向后端**多要一些**
  // （cap*2 且至少 10），最终展示条数仍由上层 capSources 截到 cap。
  // 断言改为「不少于 cap 且不超过上限」，既锁住「不会少要」，也锁住「不会无上限地要」。
  check('provider 收到的 maxResults 不少于 perQuery（多要一部分给覆盖率判定用）',
    typeof seenMaxResults === 'number' && seenMaxResults >= 3 && seenMaxResults <= 50, String(seenMaxResults));
  seenMaxResults = null;
  await runWebSearch('q', { order: ['fake-spy'], perQuery: 0 }, undefined, ctxWith(spy));
  check('perQuery = 0 时不向后端声明条数（交给它自己的默认）',
    seenMaxResults === undefined, String(seenMaxResults));
}

const passed = results.filter(Boolean).length;
console.log('\n' + passed + '/' + results.length + ' 项通过');
if (failures > 0) { console.log('WebSearch 自测失败'); process.exit(1); }
console.log('WebSearch 自测通过');
process.exit(0);