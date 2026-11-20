// qq_websearch 联网搜索模块：**搜索后端优先级**（一份有序后端列表 + 逐级降级）。
//
// 有序列表从上到下依次尝试，每一项都是一个后端 id：
//
//   dsh-qq-bot-free          → 本插件内置的免 Key 多引擎（Tavily → DuckDuckGo → Yandex+Bing+Wikipedia）
//   deepseek-search-api      → DSH web seam 里注册的 DeepSeek Search API provider
//   zhipu-web-search-prime   → 装了对应插件时注册的 GLM 搜索 provider
//   …其它任何已注册的 search provider id
//
// **本模块不自带任何 DeepSeek / 第三方搜索实现**：除内置的免 Key 多引擎外，所有后端都只通过
// ctx.web 的 provider 注册表按 id 取用——凭据、端点、以及「先官方 key、后 DSH 登录账号」那一套
// 选源逻辑全部由 provider 自己负责。本模块不填端点、不读 key、不做任何回退：
// 注册表里没有、或 provider 自己报告不可用，就直接跳过这一项。
//
// 某后端未注册、不可用、调用失败或「成功但整批结果没有简介」时降级到下一个；
// 全部失败才报错，且错误里聚合每个后端的归因（只报最后一个会把 DDG 的限流当成全局故障）。
//
// 免 Key 多引擎的请求经 ../shared/http.js；代理不在这里决定——由网络阀门（valve/network）
// 安装的策略说了算，本模块只声明「这次要出网」。
import { multiEngineRequest, meDecodeEntities, meCleanText, meStripCdata, ME_BROWSER_UA } from '../shared/http.js';


// —— 搜索后端优先级（webSearch.order）——
/** 优先级列表里的「本插件内置免 Key 多引擎」占位 id（不是真实注册的 provider）。 */
const FREE_BACKEND_ID = 'dsh-qq-bot-free';
/** DeepSeek 的检索后端：DeepSeek Search API。 */
const DEEPSEEK_BACKEND_ID = 'deepseek-search-api';
/**
 * 默认优先级：
 *   1. deepseek-search-api —— DeepSeek Search API。凭据按「**官方 key 优先、DSH 登录账号兜底**」
 *      选源（provider 自己的规则，见 dsh-web-deepseek-api 的 searchBilling=auto；QQ 会话跑在
 *      非 DeepSeek 模型路由上，解析结果就是 official → account）；
 *   2. zhipu-web-search-prime —— 智谱 GLM 搜索（装了对应插件才会注册，没装时静默跳过）；
 *   3. dsh-qq-bot-free —— 免 Key 多引擎兜底（不花钱，但依赖公共站点可达性）。
 */
const SEARCH_DEFAULT_ORDER = Object.freeze([DEEPSEEK_BACKEND_ID, 'zhipu-web-search-prime', FREE_BACKEND_ID]);
/** 优先级列表上限（防误配超长数组）。 */
const SEARCH_ORDER_MAX = 8;
/** 单条查询返回条数的默认值与上限（0 表示不截断，交给各后端自己的默认）。 */
const SEARCH_DEFAULT_PER_QUERY = 8;
const SEARCH_PER_QUERY_MAX = 50;
/** 「结果带简介」的最低覆盖率：低于它视为该后端降级，继续尝试下一个。 */
const SNIPPET_COVERAGE_MIN = 0.5;


// ============ 内置免 Key 多引擎（一项后端，完全独立实现） ============
// 组合（本插件独立实现、不依赖任何其它插件）：
//   Tavily（可选，配 TAVILY_API_KEY 才启用）→ DuckDuckGo（html→lite，串行 + 限流记忆）
//   → Yandex + Bing + Wikipedia 并发兜底、聚合去重。所有引擎请求都走同一套出网策略：
//   代理由网络阀门决定（留空直连、非空 CONNECT 隧道），本模块不持有代理串。
const ME_DDG_HTML = 'https://html.duckduckgo.com/html/';
const ME_DDG_LITE = 'https://lite.duckduckgo.com/lite/';
const ME_BING_HOSTS = ['https://cn.bing.com/search', 'https://www.bing.com/search'];
const ME_YANDEX_SEARCH = 'https://yandex.com/search/site/';
const ME_TAVILY_SEARCH = 'https://api.tavily.com/search';
const ME_TAVILY_KEY_REF = 'TAVILY_API_KEY';
const ME_WIKI_API = 'https://en.wikipedia.org/w/api.php';
const ME_TAVILY_DEFAULT_RESULTS = 10;
const ME_TAVILY_SNIPPET_MAX = 500;
const ME_DDG_LIMIT_MEMORY_MS = 60000;
const ME_TAVILY_BACKOFF_MS = 3600000;
let meDdgLimitedUntil = 0;
let meTavilyBackoffUntil = 0;
function meUnwrapDdgHref(href) {
  const match = String(href).match(/[?&]uddg=([^&]+)/);
  if (match === null) {
    if (String(href).includes('duckduckgo.com/y.js')) return '';
    return String(href).startsWith('//') ? 'https:' + href : href;
  }
  try { return decodeURIComponent(match[1]); } catch { return ''; }
}
/**
 * 解析器的输入上限：真正有结果的第一屏通常几十 KB，1MB 已远超任何正常页面。
 * 超过就截断——即使正则将来又退化成回溯写法，输入有界也不会被拖死。
 */
const PARSE_MAX_BYTES = 1024 * 1024;

/** 单个结果块的标题区间上限（字节）：标题再长也不可能超过这个，搜索窗口必须有界。 */
const TITLE_WINDOW = 4096;

/** 截断到 PARSE_MAX_BYTES（超长 HTML 解析出来也没用，只会白白吃 CPU）。 */
function clampHtmlForParse(html) {
  const text = String(html === undefined || html === null ? '' : html);
  return text.length <= PARSE_MAX_BYTES ? text : text.slice(0, PARSE_MAX_BYTES);
}

/** 解析 DuckDuckGo html/lite 结果页。 */
function parseDdgResults(rawHtml) {
  const html = clampHtmlForParse(rawHtml);
  const sources = [];
  const seen = new Set();
  // 线性扫描，不用回溯块正则：起点未知时正则会为每个起点扫到文档末尾（实测平方级增长，
  // 480KB 病态输入 1.5 秒、4 倍长度约 16 倍耗时）。响应上限 8MB、qq_websearch 又在访客白名单，
  // 群里任何人都能拖住插件进程。做法：indexOf 找起点，再在该起点的已知区间里找闭合标签。
  const harvest = (marker, snippetMarker, snippetClose) => {
    let cursor = 0;
    for (;;) {
      const at = html.indexOf(marker, cursor);
      if (at < 0) break;
      const tagStart = html.lastIndexOf('<a', at);
      if (tagStart < 0) { cursor = at + marker.length; continue; }
      const tagEnd = html.indexOf('>', at);
      if (tagEnd < 0) break;
      const hrefAt = html.indexOf('href="', tagStart);
      if (hrefAt < 0 || hrefAt > tagEnd) { cursor = tagEnd + 1; continue; }
      const hrefEnd = html.indexOf('"', hrefAt + 6);
      if (hrefEnd < 0) break;
      // 闭合标签只在**有界窗口**里找：窗口 = min(下一个结果起点, tagEnd + 1 + TITLE_WINDOW)。
      // 不能用「从头 indexOf / lastIndexOf」——病态输入里 `</a>` 根本不存在，每次都要扫到
      // 区间边界，整体就退化成平方级（实测 656KB 要 2.6 秒）。切片 + 窗口内 indexOf 是 O(1)。
      const nextStart = html.indexOf(marker, tagEnd + 1);
      const hardLimit = Math.min(html.length, tagEnd + 1 + TITLE_WINDOW);
      const regionLimit = nextStart >= 0 && nextStart < hardLimit ? nextStart : hardLimit;
      const windowText = html.slice(tagEnd + 1, regionLimit);
      const closeRel = windowText.indexOf('</a>');
      const regionEnd = closeRel >= 0 ? tagEnd + 1 + closeRel : regionLimit;
      const url = meUnwrapDdgHref(meDecodeEntities(html.slice(hrefAt + 6, hrefEnd)));
      cursor = Math.max(regionEnd + 1, tagEnd + 1);
      if (url.length === 0 || seen.has(url)) continue;
      const title = meCleanText(html.slice(tagEnd + 1, regionEnd));
      // 摘要只在这个结果块之后的有限窗口里找（窗口有界，不扫全文）。
      const windowEnd = Math.min(html.length, regionEnd + 4096);
      let snippet = '';
      const snipAt = html.indexOf(snippetMarker, regionEnd);
      if (snipAt >= 0 && snipAt < windowEnd) {
        const sStart = html.indexOf('>', snipAt);
        const sEnd = html.indexOf(snippetClose, snipAt);
        if (sStart >= 0 && sEnd > sStart && sEnd < windowEnd) snippet = meCleanText(html.slice(sStart + 1, sEnd));
      }
      seen.add(url);
      sources.push({ url, ...(title.length > 0 ? { title } : {}), ...(snippet.length > 0 ? { snippet } : {}) });
    }
  };

  // DDG html 版：结果是 a.result__a，摘要在同一块里
  harvest('result__a', 'result__snippet', '</a>');
  if (sources.length > 0) return sources;
  // DDG lite 版：a.result-link，摘要放在紧随其后的 td.result-snippet 里
  harvest('result-link', 'result-snippet', '</td>');
  return sources;
}
/** Bing ck/a 跳转 URL 还原（u=a1<base64url>）；广告与无法还原的返回空串。 */
function meUnwrapBingUrl(href) {
  const url = String(href).trim();
  if (url.includes('bing.com/aclick')) return '';
  const match = url.match(/[?&]u=a1([A-Za-z0-9_-]+)/);
  if (match !== null) {
    const b64 = match[1].replace(/-/g, '+').replace(/_/g, '/');
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    return /^https?:\/\//i.test(decoded) ? decoded : '';
  }
  if (url.includes('bing.com/ck/')) return '';
  return /^https?:\/\//i.test(url) ? url : '';
}
/** 解析 Bing HTML 结果页（b_algo 块）。 */
function parseBingResults(rawHtml) {
  const html = clampHtmlForParse(rawHtml);
  const sources = [];
  const seen = new Set();
  const itemRe = /<li\b[^>]{0,512}?\bclass="[^"]{0,256}?\bb_algo\b[^"]{0,256}?"[^>]{0,512}?>([\s\S]{0,16384}?)<\/li>/gi;
  let item;
  while ((item = itemRe.exec(html)) !== null) {
    const block = item[1] ?? '';
    const linkMatch = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"/i);
    if (linkMatch === null) continue;
    const url = meUnwrapBingUrl(meDecodeEntities(linkMatch[1] ?? ''));
    if (url.length === 0 || seen.has(url)) continue;
    const tm = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = tm !== null ? meCleanText(tm[1] ?? '') : '';
    const sm = block.match(/<p[^>]*\bclass="[^"]*\bb_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
      ?? block.match(/<div[^>]*\bclass="[^"]*\bb_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = sm !== null ? meCleanText(sm[1] ?? '') : '';
    seen.add(url);
    sources.push({ url, ...(title.length > 0 ? { title } : {}), ...(snippet.length > 0 ? { snippet } : {}) });
  }
  return sources;
}
/** 解析 Bing RSS 通道（&format=rss，link 为真实 URL，无需解包）。 */
function parseBingRss(body) {
  const sources = [];
  const seen = new Set();
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let item;
  while ((item = itemRe.exec(body)) !== null) {
    const block = item[1] ?? '';
    const url = meCleanText(meStripCdata(block.match(/<link>([\s\S]*?)<\/link>/i)?.[1] ?? ''));
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    const title = meCleanText(meStripCdata(block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? ''));
    const snippet = meCleanText(meStripCdata(block.match(/<description>([\s\S]*?)<\/description>/i)?.[1] ?? ''));
    const rawDate = meCleanText(meStripCdata(block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1] ?? ''));
    const publishedAt = rawDate.length > 0 && !Number.isNaN(Date.parse(rawDate)) ? new Date(rawDate).toISOString() : '';
    seen.add(url);
    sources.push({ url, ...(title.length > 0 ? { title } : {}), ...(snippet.length > 0 ? { snippet } : {}),
      ...(publishedAt.length > 0 ? { publishedAt } : {}) });
  }
  return sources;
}
/**
 * 解析 Yandex /search/site/ 结果页（href 即真实 URL；命中词 <b> 逐字包中文）。
 *
 * 用 indexOf 线性扫描，**不要**改回一条大正则——2026-11 实测 Yandex 把 onmousedown 埋点
 * 内联在 title 链接的 <a> 标签里，那段属性有 2200 字符，远超原来正则里 href 之后
 * [^>]{0,512}? 的窗口，于是整条正则在真实页面上一条都匹配不到（HTML 里 14 个 title-link，
 * 解析结果 0 条），Yandex 这个兜底引擎等于常年空转。线性扫描没有「属性长度窗口」这类
 * 假设，也不再需要防回溯。
 */
function parseYandexResults(rawHtml) {
  const html = clampHtmlForParse(rawHtml);
  const sources = [];
  const seen = new Set();
  const marker = 'b-serp-item__title-link';
  const tagWindow = 4096;   // 从 marker 往前找 <a、往后找 > 的上限（实测属性约 2.2K）
  const titleLimit = 8192;  // 标题正文上限
  let cursor = 0;
  for (;;) {
    const at = html.indexOf(marker, cursor);
    if (at < 0) break;
    cursor = at + marker.length;
    // 必须在 class 属性里：CSS 选择器里也会出现这个类名，那种位置前面不是 <a
    const tagStart = html.lastIndexOf('<a', at);
    if (tagStart < 0 || at - tagStart > tagWindow) continue;
    const tagEnd = html.indexOf('>', at);
    if (tagEnd < 0) break;
    if (tagEnd - at > tagWindow) continue;
    const hrefAt = html.indexOf('href="', tagStart);
    if (hrefAt < 0 || hrefAt > tagEnd) continue;
    const hrefEnd = html.indexOf('"', hrefAt + 6);
    if (hrefEnd < 0) break;
    const url = meDecodeEntities(html.slice(hrefAt + 6, hrefEnd)).trim();
    if (!/^https?:\/\//i.test(url)) continue;
    if (/\/\/yandex\.[a-z.]+\/clck\/jsredir/i.test(url)) continue;
    if (seen.has(url)) continue;
    // 标题：紧跟 <a ...> 之后到 </a> 之间（同样在有界窗口里找）
    const closeRel = html.indexOf('</a>', tagEnd + 1);
    const closeAt = (closeRel >= 0 && closeRel - tagEnd <= titleLimit) ? closeRel : tagEnd + 1 + titleLimit;
    const title = meCleanText(html.slice(tagEnd + 1, closeAt));
    // 摘要：本条之后、下一条 title-link 之前的有界窗口里的 b-serp-item__text
    const nextAt = html.indexOf(marker, closeAt);
    const windowEnd = nextAt > 0 ? nextAt : html.length;
    let snippet = '';
    const textAt = html.indexOf('b-serp-item__text', closeAt);
    if (textAt >= 0 && textAt < windowEnd) {
      const divStart = html.indexOf('>', textAt);
      const divEnd = html.indexOf('</div>', divStart);
      if (divStart >= 0 && divEnd > divStart && divEnd <= windowEnd + 4096) snippet = meCleanText(html.slice(divStart + 1, divEnd));
    }
    seen.add(url);
    sources.push({ url, ...(title.length > 0 ? { title } : {}), ...(snippet.length > 0 ? { snippet } : {}) });
  }
  return sources;
}
/** 解析 Tavily JSON：{ results: [{ url, title, content }] }，content 截到 500 字符。 */
function parseTavilyJson(body) {
  try {
    const data = JSON.parse(body);
    if (typeof data !== 'object' || data === null) return [];
    const results = data.results;
    if (!Array.isArray(results)) return [];
    const sources = [];
    const seen = new Set();
    for (const entry of results) {
      if (typeof entry !== 'object' || entry === null) continue;
      const url = typeof entry.url === 'string' ? entry.url.trim() : '';
      if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
      const title = typeof entry.title === 'string' ? meCleanText(entry.title) : '';
      const rawContent = typeof entry.content === 'string' ? meCleanText(entry.content) : '';
      const snippet = rawContent.length > ME_TAVILY_SNIPPET_MAX
        ? rawContent.slice(0, ME_TAVILY_SNIPPET_MAX) + '…' : rawContent;
      seen.add(url);
      sources.push({ url, ...(title.length > 0 ? { title } : {}), ...(snippet.length > 0 ? { snippet } : {}) });
    }
    return sources;
  } catch { return []; }
}
/** 解析 MediaWiki opensearch JSON：[词, 标题[], 摘要[], URL[]]。 */
function parseOpensearchJson(body) {
  try {
    const data = JSON.parse(body);
    if (!Array.isArray(data) || data.length < 4) return [];
    const titles = data[1], descriptions = data[2], urls = data[3];
    if (!Array.isArray(titles) || !Array.isArray(urls)) return [];
    const sources = [];
    for (let i = 0; i < urls.length; i++) {
      const url = String(urls[i] ?? '');
      if (!/^https?:\/\//.test(url)) continue;
      const title = String(titles[i] ?? '');
      const snippet = Array.isArray(descriptions) ? String(descriptions[i] ?? '') : '';
      sources.push({ url, ...(title.length > 0 ? { title } : {}), ...(snippet.length > 0 ? { snippet } : {}) });
    }
    return sources;
  } catch { return []; }
}
/** 查询词元：拉丁词(≥2) + CJK 连续片段 2-gram，只用于「结果与查询是否沾边」的粗判。 */
function meQueryTokens(query) {
  const tokens = new Set();
  for (const m of String(query).toLowerCase().matchAll(/[a-z0-9][a-z0-9.+#_-]*/g)) {
    if (m[0].length >= 2) tokens.add(m[0]);
  }
  for (const m of String(query).matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = m[0];
    if (run.length === 1) tokens.add(run);
    else for (let i = 0; i + 2 <= run.length; i++) tokens.add(run.slice(i, i + 2));
  }
  return [...tokens];
}
/**
 * 相关性闸门：整批结果与查询零重叠视为「投毒/无关」，宁可不交出去。
 *
 * 判据是「**任一条结果的标题/摘要/URL 命中任一词元**」——这是最强的召回口径，
 * 再放松就等于不设闸；反过来收紧（要求多数命中）会把正常结果全判死。
 *
 * 所以真正的质量控制在**引擎编排**上，而不是这里：像 "Rust 1.91.0 release announcement"
 * 这种查询，Bing 会返回一屏「Rust」泛匹配站点（rust-lang 首页、菜鸟教程、腾讯游戏），
 * 每条都命中 "rust" 这个词元、闸门认为「沾边」，实际却答不了「1.91.0 发布公告」。
 * 这类泛匹配只能靠换引擎/改主机顺序解决（见 meBingSearch 的实测说明），
 * 不能指望闸门识别——它无法区分「命中一个词」与「命中意图」。
 */
function meLooksRelevant(sources, query) {
  const tokens = meQueryTokens(query);
  if (tokens.length === 0) return true;
  return sources.some((source) => {
    const haystack = ((source.title ?? '') + ' ' + (source.snippet ?? '') + ' ' + source.url).toLowerCase();
    return tokens.some((token) => haystack.includes(token));
  });
}

/**
 * 结果「够不够专」：命中词元**个数**的中位数。用于在多个引擎之间挑更好的一批。
 *
 * 两条实测驱动的规则（2026-11）：
 *   - "Claude Sonnet 4.6 announcement"：Yandex 5/5 条都带 3+ 个词元，Bing 只给泛匹配首页；
 *   - "Rust 1.91.0 release announcement"：Bing 泛匹配（都是 "rust" 一个词），Yandex 反而给出
 *     github / docker hub / 无关俄文站。
 * 也就是说**没有永远的赢家**，只能按查询现算：哪一批的词元命中分布更集中（中位数更高），
 * 就把哪一批排在前面。同分时保留原来的引擎顺序，保持行为可预期。
 */
function meSpecificityOf(sources, query) {
  const tokens = meQueryTokens(query);
  if (tokens.length === 0 || sources.length === 0) return 0;
  const hits = sources.map((source) => {
    const haystack = ((source.title ?? '') + ' ' + (source.snippet ?? '') + ' ' + source.url).toLowerCase();
    return tokens.filter((token) => haystack.includes(token)).length;
  });
  hits.sort((a, b) => a - b);
  // 取中位数（偶数取偏下的那个），避免一条特别好的结果把整批抬起来。
  return hits[Math.floor((hits.length - 1) / 2)];
}

/**
 * Tavily key 的解析顺序，与 SauceNAO 那类「设置页 secret 字段」完全一致：
 *   ① webSearch.tavilyKey（设置页填的，落在 profile 配置里，只写不回显）
 *   ② 环境变量 / DSH 凭据服务 refs（TAVILY_API_KEY）——没在设置页填时用它
 * 设置页填的值优先：用户在界面上明确保存的东西，不该被一个环境变量悄悄覆盖。
 */
async function meResolveTavilyKey(cfg, ctx) {
  if (cfg !== null && cfg !== undefined && typeof cfg.tavilyKey === 'string' && cfg.tavilyKey.trim() !== '') {
    return cfg.tavilyKey.trim();
  }
  let key = (process.env[ME_TAVILY_KEY_REF] ?? '').trim();
  try {
    if (ctx !== null && ctx !== undefined && typeof ctx.get === 'function') {
      const credentials = ctx.get('credentials');
      if (credentials !== null && credentials !== undefined && typeof credentials.resolve === 'function') {
        const resolved = await credentials.resolve(ME_TAVILY_KEY_REF);
        if (resolved !== null && resolved !== undefined && typeof resolved.value === 'string' && resolved.value.length > 0) {
          key = resolved.value;
        }
      }
    }
  } catch (error) { /* 凭据异常回退 env */ }
  return key;
}
/** 一次 DuckDuckGo 抓取（POST form；202/anomaly = 反爬限流，记 60s 记忆）。 */
async function meDdgSearchOnce(endpoint, query, signal) {
  if (Date.now() < meDdgLimitedUntil) throw new Error('DuckDuckGo 限流记忆生效中');
  const resp = await multiEngineRequest('POST', endpoint,
    { 'user-agent': ME_BROWSER_UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8', 'content-type': 'application/x-www-form-urlencoded' },
    new URLSearchParams({ q: query, b: '', kl: 'wt-wt' }).toString(), { signal });
  if (resp.status === 202 || /\banomaly\b|challenge-platform|unusual\s+traffic/i.test(resp.body)) {
    meDdgLimitedUntil = Date.now() + ME_DDG_LIMIT_MEMORY_MS;
    throw new Error('DuckDuckGo 触发反爬限流 (HTTP ' + resp.status + ')');
  }
  if (resp.status !== 200) throw new Error('DuckDuckGo 返回 HTTP ' + resp.status);
  return parseDdgResults(resp.body);
}
/** DDG 引擎：html → lite 内部级联。 */
async function meDdgSearch(query, signal) {
  let lastError = null;
  for (const endpoint of [ME_DDG_HTML, ME_DDG_LITE]) {
    try {
      const sources = await meDdgSearchOnce(endpoint, query, signal);
      if (sources.length > 0) return sources;
    } catch (error) {
      lastError = error;
      if (/限流/.test(String(error.message ?? ''))) break;
    }
  }
  if (lastError !== null) throw lastError;
  return [];
}
/**
 * Bing：主机 cn→www × 通道 RSS→HTML 遍历；空/不沾边换下一个；全失败抛错。
 *
 * 实测（2026-11，本机出口经 HTTP 代理）：**cn.bing.com 对英文技术查询会返回一屏
 * 与查询无关的中文站**（"Rust 1.91.0 release announcement" → rust-lang 首页 + 菜鸟教程 +
 * 腾讯游戏，全是「Rust」这个词的泛匹配），而 www.bing.com 同一查询给的是
 * rust-lang.org 首页、中文书、官方站。所以主机顺序改成 **www → cn**：
 * 中文查询两边差别不大，英文查询只有 www 能用。
 *
 * 相关性闸门只看「有没有任意一个查询词命中」，对这种「泛匹配」判不出来
 * （"Rust" 这个词确实在标题里），所以只能靠主机顺序，不能指望闸门兜住。
 */
async function meBingSearch(query, signal) {
  const encoded = encodeURIComponent(query);
  // 主机顺序 www → cn（见上面的实测说明）。
  const channels = ['https://www.bing.com', 'https://cn.bing.com'].flatMap((host) => [
    { label: 'Bing RSS (' + new URL(host).hostname + ')', url: host + '/search?q=' + encoded + '&format=rss&setlang=zh-CN&count=30', parse: parseBingRss },
    { label: 'Bing (' + new URL(host).hostname + ')', url: host + '/search?q=' + encoded + '&setlang=zh-CN&count=30', parse: parseBingResults },
  ]);
  let lastError = null;
  for (const channel of channels) {
    try {
      const resp = await multiEngineRequest('GET', channel.url,
        { 'user-agent': ME_BROWSER_UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
        null, { signal });
      if (resp.status !== 200) { lastError = new Error(channel.label + ' HTTP ' + resp.status); continue; }
      const sources = channel.parse(resp.body);
      if (sources.length === 0) continue;
      if (!meLooksRelevant(sources, query)) continue;
      return sources;
    } catch (error) { lastError = error; }
  }
  if (lastError !== null) throw lastError;
  return [];
}
/** Yandex 旧端点 /search/site/（无 Key）；正文含 captcha 标记按失败处理。 */
async function meYandexSearch(query, signal) {
  const searchid = String(Math.floor(1000000 + Math.random() * 9000000));
  const url = ME_YANDEX_SEARCH + '?text=' + encodeURIComponent(query) + '&web=1&searchid=' + searchid;
  const resp = await multiEngineRequest('GET', url,
    { 'user-agent': ME_BROWSER_UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    null, { signal });
  if (resp.status === 200 && /showcaptcha|SmartCaptcha|form-unique_key/i.test(resp.body)) {
    throw new Error('Yandex 触发验证码');
  }
  if (resp.status !== 200) throw new Error('Yandex 返回 HTTP ' + resp.status);
  const sources = parseYandexResults(resp.body);
  return meLooksRelevant(sources, query) ? sources : [];
}
/** Wikipedia opensearch（无 Key、稳定）。 */
async function meWikipediaSearch(query, signal) {
  const url = ME_WIKI_API + '?action=opensearch&format=json&limit=8&search=' + encodeURIComponent(query);
  const resp = await multiEngineRequest('GET', url,
    { 'user-agent': ME_BROWSER_UA, accept: 'application/json,*/*;q=0.8' }, null, { signal });
  if (resp.status !== 200) throw new Error('Wikipedia 返回 HTTP ' + resp.status);
  return parseOpensearchJson(resp.body);
}
/** Tavily（配 TAVILY_API_KEY 才启用；429/432 = 额度耗尽 → 1 小时退避）。 */
async function meTavilySearch(query, cap, apiKey, signal) {
  if (Date.now() < meTavilyBackoffUntil) throw new Error('Tavily 退避中');
  const resp = await multiEngineRequest('POST', ME_TAVILY_SEARCH,
    { 'user-agent': ME_BROWSER_UA, 'content-type': 'application/json', accept: 'application/json,*/*;q=0.8', authorization: 'Bearer ' + apiKey },
    JSON.stringify({ query, max_results: cap > 0 ? cap : ME_TAVILY_DEFAULT_RESULTS, search_depth: 'basic' }), { signal });
  if (resp.status === 429 || resp.status === 432) {
    meTavilyBackoffUntil = Date.now() + ME_TAVILY_BACKOFF_MS;
    throw new Error('Tavily 额度耗尽或限流 (HTTP ' + resp.status + ')');
  }
  if (resp.status !== 200) throw new Error('Tavily 返回 HTTP ' + resp.status);
  return parseTavilyJson(resp.body);
}
/**
 * 内置免 Key 多引擎（后端 id `dsh-qq-bot-free`）：
 * Tavily（配 TAVILY_API_KEY 才启用）→ DuckDuckGo（html→lite，串行 + 限流记忆）
 * → Yandex + Bing + Wikipedia 并发兜底、聚合去重（合并顺序即优先级）。
 *
 * 引擎集本身是**一项**后端，不再各自占一个优先级位：DDG 被限流时并发兜底仍然并行，
 * 不会因为逐个串行尝试把最坏延迟翻倍。
 */
async function meFreeBackendSearch(query, cap, cfg, ctx, signal) {
  const outcomes = [];
  // 0) Tavily（配 key 且不在退避窗口才试）
  const tavilyKey = await meResolveTavilyKey(cfg, ctx);
  if (tavilyKey !== '') {
    try {
      const sources = await meTavilySearch(query, cap, tavilyKey, signal);
      outcomes.push({ engine: 'Tavily', sources });
      if (sources.length > 0) return sources;
    } catch (error) { outcomes.push({ engine: 'Tavily', sources: [], error }); }
  }
  // 1) DuckDuckGo
  try {
    const sources = await meDdgSearch(query, signal);
    outcomes.push({ engine: 'DuckDuckGo', sources });
    if (sources.length > 0) return sources;
  } catch (error) { outcomes.push({ engine: 'DuckDuckGo', sources: [], error }); }
  // 2) Yandex + Bing + Wikipedia 并发兜底，聚合去重（合并顺序即优先级）
  const [y, b, w] = await Promise.allSettled([
    meYandexSearch(query, signal),
    meBingSearch(query, signal),
    meWikipediaSearch(query, signal),
  ]);
  // 三个引擎都是 async 且返回 source 数组；显式标成元组，否则下面 [engine, settled] 解构会把
  // 引擎名（string）和 PromiseSettledResult 混成联合类型，取 .status/.value/.reason 都不成立。
  const settledPairs = /** @type {[string, PromiseSettledResult<{ url: string, title?: string, snippet?: string }[]>][]} */ ([
    ['Yandex', y], ['Bing', b], ['Wikipedia', w],
  ]);
  // 按「结果够不够专」现算合并顺序：哪一批的查询词元命中中位数更高，谁的链接先进结果列表。
  // 固定顺序在实测里两头不讨好（英文技术查询 Bing 泛匹配、部分查询 Yandex 反而给无关站），
  // 见 meSpecificityOf 的说明。同分时保持原来的引擎顺序，行为可预期。
  for (const [engine, settled] of settledPairs) {
    if (settled.status === 'fulfilled') outcomes.push({ engine, sources: settled.value });
    else outcomes.push({ engine, sources: [], error: settled.reason });
  }
  const rankable = outcomes.filter((o) => o.error === undefined && o.sources.length > 0);
  const rank = new Map(
    rankable
      .map((o, index) => ({ engine: o.engine, spec: meSpecificityOf(o.sources, query), count: o.sources.length, index }))
      // 先比「够不够专」，再比条数；同分时保留原来的引擎顺序（index），排序结果可预期。
      .sort((a, b) => (b.spec - a.spec) || (b.count - a.count) || (a.index - b.index))
      .map((entry, position) => [entry.engine, position]),
  );
  const merged = [];
  const seen = new Set();
  for (const outcome of outcomes.slice().sort((a, b) => {
    const ra = rank.has(a.engine) ? rank.get(a.engine) : Number.MAX_SAFE_INTEGER;
    const rb = rank.has(b.engine) ? rank.get(b.engine) : Number.MAX_SAFE_INTEGER;
    return ra - rb;
  })) {
    if (outcome.error !== undefined || outcome.sources.length === 0) continue;
    for (const source of outcome.sources) {
      if (seen.has(source.url)) continue;
      seen.add(source.url);
      merged.push(source);
    }
  }
  // cap <= 0 是「不截断」的语义（出厂默认 perQuery:0 就靠它）；这里必须走 capSources，
  // 直接 slice(0, cap) 在 cap=0 时会得到空数组，把整批聚合结果丢掉。
  if (merged.length > 0) return capSources(merged, cap);
  const failures = outcomes.filter((o) => o.error !== undefined);
  if (failures.length === 0) return [];
  // 取消不是「失败」：任何一个引擎是因为 signal 中止的，就把取消原样抛回去，
  // 不能让用户点「停止」后收到「多引擎搜索失败」这种排障指令。
  const aborted = outcomes.some((o) => o.error !== undefined && o.error !== null
    && (o.error.name === 'AbortError' || (typeof o.error.message === 'string' && /aborted|cancel|取消/i.test(o.error.message))));
  if (aborted === true) {
    throw Object.assign(new Error('搜索已取消'), { name: 'AbortError' });
  }
  throw new Error('多引擎搜索失败: ' + outcomes.map((o) => {
    const msg = o.error instanceof Error ? o.error.message : (typeof o.error === 'string' ? o.error : String(o.error ?? '未知错误'));
    return msg.startsWith(o.engine) ? msg : o.engine + ' ' + msg;
  }).join('；'));
}

// ============ 后端优先级（webSearch.order）============
// 列表里的每一项要么是 web seam 注册表里的 provider id，要么是这两个内置占位 id：
//   `dsh-qq-bot-free`     内置免 Key 多引擎（见 meFreeBackendSearch）
// 未注册、不可用、失败、或「成功但整批无简介」都降级到下一项；用户取消视为整体失败。
// FREE_BACKEND_ID / DEEPSEEK_BACKEND_ID 与 SEARCH_* 常量声明在文件头（默认顺序要用它们）。

/** 列表里每一项的展示名（设置页与错误归因共用；认不出的一律按「其它后端」）。 */
const BACKEND_LABELS = Object.freeze({
  'deepseek-search-api': 'DeepSeek Search API',
  'zhipu-web-search-prime': '智谱 GLM 搜索',
  [FREE_BACKEND_ID]: '免 Key 多引擎（DDG/Bing/Yandex/Wikipedia + Tavily）',
});

/**
 * 优先级列表里的每一项在运行时是否「有能力用」。**只看本地状态、不发网络请求**；
 * 本模块**不做任何回退**——注册表里没有这个 provider 就是不可用，跳过。
 *
 * 唯一的例外是内置免 Key 多引擎：它就是本模块自己，永远「可用」（真跑不通由降级逻辑兜住）。
 */
function backendAvailable(ctx, backendId) {
  return backendSkipReason(ctx, backendId) === null;
}

/**
 * 这一项为什么跳过（null = 能用）。**三种原因必须分开记**，否则排障时全糊成一句「不可用」：
 *
 *   unregistered  注册表里没有这个 provider（没装插件 / 装了没挂载）；
 *   unavailable   provider 自己报 `available() === false`——凭据缺失、端点无效、配置非法都走这一支；
 *   probe-failed  `available()` 抛异常（provider 内部坏了，不是「没配」）。
 *
 * **余额不足不在这三种里**：`available()` 只看凭据在不在、不发网络请求，所以余额为 0 的
 * 官方 key 仍然显示「可用」，要到真正发请求时才以 HTTP 402 / Insufficient Balance 暴露出来
 * （见 classifySearchError）。
 */
function backendSkipReason(ctx, backendId) {
  if (backendId === FREE_BACKEND_ID) return null;
  const provider = registeredProviderById(ctx, backendId);
  if (provider === undefined) return { kind: 'unregistered', detail: 'provider 未注册' };
  try {
    if (typeof provider.available === 'function' && provider.available() === false) {
      return { kind: 'unavailable', detail: 'provider 报告不可用（凭据缺失 / 端点无效 / 配置非法）' };
    }
    return null;
  } catch (error) {
    return { kind: 'probe-failed', detail: 'available() 抛异常：' + describeLite(error) };
  }
}

/** 错误文本的极简归一（不打栈、不引入依赖）。 */
function describeLite(error) {
  if (error === null || error === undefined) return '未知错误';
  if (typeof error === 'string') return error;
  const message = error.message === undefined ? String(error) : String(error.message);
  return message.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** 取错误对象上的 code / status（不同 provider 放的位置不一样）。 */
function errorCodeOf(error) {
  if (error === null || error === undefined || typeof error !== 'object') return '';
  const code = error.code === undefined ? (error.status === undefined ? '' : error.status) : error.code;
  return String(code === undefined || code === null ? '' : code);
}

/**
 * 把一次后端失败归类。**「官方 key 没余额」必须与其它失败分开**：它是「配好了但没钱」，
 * 不是「没配」，两者的处理方式完全不同（前者去充值、后者去填 key / 重新登录）。
 *
 * 归类依据（DSH 的搜索 provider 与第三方实现都在这个形状里）：
 *   402、或消息里出现 insufficient / balance / 余额        → no-balance
 *   401 / 403、或消息里出现 unauthorized / invalid api key  → auth
 *   429、或消息里出现 rate limit / 限流                      → rate-limit
 *   WEB_PROVIDER_CREDENTIAL_MISSING 等 provider 自己的码   → credential
 *   其余                                                  → error
 */
/** 六类失败的中文标签（日志、工具错误、上层重试判定共用同一份，避免文案分叉）。 */
const SEARCH_KIND_LABELS = Object.freeze({
  'no-balance': '余额不足',
  auth: '凭据无效 / 未登录',
  'rate-limit': '被限流',
  credential: '凭据缺失',
  unavailable: '后端不可用',
  error: '调用失败',
});

function classifySearchError(error) {
  // 真实 provider（dsh-web-deepseek-api）抛的 WebError 里，code **恒为** WEB_PROVIDER_ERROR，
  // 状态码只出现在 message 文本中（形如 "DeepSeek API error (HTTP 402): ..."）。所以不能只认 code，
  // 必须从文本里把状态码抠出来；否则 402/429 全落到「调用失败」、排障指令全错。
  const code = errorCodeOf(error);
  const text = describeLite(error).toLowerCase();
  const status = statusOf(error, text);
  // 余额不足：402 是权威信号；中文侧认「余额不足 / 余额耗尽 / 余额为 0」，
  // 英文侧用整词 balance（不能是 /balance/ 子串，否则 "load balancer"（502）
  // 和 "unbalanced quotes" 都会被误判成余额不足）。
  if (status === 402 || /insufficient_balance|insufficient balance|余额|\bbalance\b/.test(text)) {
    return { kind: 'no-balance', label: SEARCH_KIND_LABELS['no-balance'], detail: describeLite(error) };
  }
  // 401/403：凭据问题。403 优先于余额（403 是权限，不是没钱）。
  if (status === 401 || status === 403 || /unauthori[sz]ed|invalid api key|authentication fails|forbidden|permission denied/.test(text)) {
    return { kind: 'auth', label: SEARCH_KIND_LABELS['auth'], detail: describeLite(error) };
  }
  if (status === 429 || /rate.?limit|too many requests|限流/.test(text)) {
    return { kind: 'rate-limit', label: SEARCH_KIND_LABELS['rate-limit'], detail: describeLite(error) };
  }
  if (/WEB_PROVIDER_CREDENTIAL_MISSING|CREDENTIAL_MISSING/.test(code) || /no api key|缺少.*key|凭据.*未配置/.test(text)) {
    return { kind: 'credential', label: SEARCH_KIND_LABELS['credential'], detail: describeLite(error) };
  }
  if (/WEB_PROVIDER_CONFIGURED_UNAVAILABLE|WEB_PROVIDER_UNAVAILABLE/.test(code)) {
    return { kind: 'unavailable', label: SEARCH_KIND_LABELS['unavailable'], detail: describeLite(error) };
  }
  return { kind: 'error', label: SEARCH_KIND_LABELS['error'], detail: describeLite(error) };
}

/**
 * 从错误里抠 HTTP 状态码：优先 code/status 字段，其次 message 文本里的 (HTTP 402) 这类字样。
 * 只在 4xx/5xx 范围内认，避免把 "500 毫秒超时" 里的数字当状态码。
 */
function statusOf(error, text) {
  const code = errorCodeOf(error);
  const direct = Number(code);
  if (Number.isFinite(direct) === true && direct >= 400 && direct <= 599) return direct;
  // 只认「HTTP 语境 + 三位数」：以前先裸匹配 \b(4\d{2}|5\d{2})\b，于是「耗时 402 ms」
  // 「429 条结果」这种正文数字会被当成状态码，还会盖住真正的「(HTTP 402)」。
  const match = text.match(/\b(?:http[ /]?|status[ :]?|code[ :]?)(4\d{2}|5\d{2})\b/);
  if (match !== null) {
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed) === true && parsed >= 400 && parsed <= 599) return parsed;
  }
  // 真实 provider 也常写成「403 insufficient permissions」这种**没有 HTTP 前缀**的形态。
  // 这一支只接受「裸码紧跟权限/错误字样」或「权限字样在前」的写法，
  // 所以「耗时 402 ms」「429 条结果」这类正文数字仍然不会被误认。
  const trailing = text.match(/\b(4\d{2}|5\d{2})\b(?:\s|:)+(insufficient|forbidden|unauthori[sz]ed|permission|denied)/);
  if (trailing !== null) return Number(trailing[1]);
  const leading = text.match(/(?:error|status|code|http)[^0-9]{0,8}(4\d{2}|5\d{2})\b/);
  if (leading !== null) return Number(leading[1]);
  return 0;
}

/** 从 web seam 的注册表里按 id 取一个 search provider（拿不到注册表就返回 undefined）。 */
function registeredProviderById(ctx, backendId) {
  try {
    if (ctx === null || ctx === undefined || typeof ctx.get !== 'function') return undefined;
    const web = ctx.get('web');
    const registry = (web !== null && web !== undefined) ? web.searchProviders : undefined;
    if (registry === null || registry === undefined || typeof registry.get !== 'function') return undefined;
    const candidate = registry.get(backendId);
    if (candidate === null || candidate === undefined) return undefined;
    if (typeof candidate.id !== 'string' || typeof candidate.search !== 'function') return undefined;
    return candidate;
  } catch (error) { return undefined; }
}

/**
 * 归一化优先级列表：丢非字符串、去重、截到上限。
 *
 * 空列表**不表示「不接管」**：本插件只有 qq_websearch 一个消费者，
 * 没有「不接管就交给本插件的默认链路」这回事，所以空列表归一成默认顺序，而不是表示禁用。
 * 上限 8（防误配超长数组）。
 */
function normalizeOrder(value) {
  const seen = new Set();
  const order = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const id = item.trim();
      if (id === '' || seen.has(id)) continue;
      seen.add(id);
      order.push(id);
      if (order.length >= SEARCH_ORDER_MAX) break;
    }
  }
  return order.length > 0 ? order : SEARCH_DEFAULT_ORDER.slice();
}

/**
 * 结果是否「带简介」到可用程度：snippet 非空的条数占比 ≥ 0.5。
 *
 * 用途：识别「只有标题和链接」的后端降级结果（摘要缺失时，模型只看得到标题和 URL）。
 * 空结果集返回 true——「无结果」是合法结局，不该因此换后端重试。
 */
function hasUsableSnippets(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return true;
  const withSnippet = sources.filter((source) => typeof source.snippet === 'string' && source.snippet.trim() !== '').length;
  return (withSnippet / sources.length) >= SNIPPET_COVERAGE_MIN;
}

/** 截断到 cap 条（0 或非数字 = 不截断）。 */
function capSources(sources, cap) {
  if (!Number.isFinite(cap) || cap <= 0) return sources;
  return sources.length <= cap ? sources : sources.slice(0, cap);
}

/**
 * 一次后端尝试的归因文案。**跳过与失败要分开写**：
 *   - 跳过（未注册 / provider 不可用 / 探测异常）：写「跳过（原因）」，不改判成调用失败；
 *   - 失败：写「<类别> — 细节」，类别里「余额不足 / 凭据无效」必须显式区分（见 classifySearchError）。
 */
function backendOutcomeLabel(outcome) {
  const label = BACKEND_LABELS[outcome.backendId] !== undefined ? BACKEND_LABELS[outcome.backendId] : ('其它后端 · ' + outcome.backendId);
  if (outcome.skip !== undefined && outcome.skip !== null) {
    return label + ' 跳过（' + outcome.skip.detail + '）';
  }
  if (outcome.error !== undefined && outcome.error !== null) {
    const cls = classifySearchError(outcome.error);
    return label + ' ' + cls.label + '：' + cls.detail;
  }
  return label + ' 无结果';
}

// —— 后端事件日志 ——
// 编排层跑在插件进程里，日志默认走 console；测试可以 __setSearchLogger 换掉它。
// 三类事件分开记（跳过 / 降级 / 失败），失败再按类别细分（余额不足、凭据无效…）。
let searchLogger = (line) => console.log('[qq_websearch] ' + line);

/** 安装/清除日志出口（只有插件与测试该调它）。 */
function __setSearchLogger(fn) {
  searchLogger = (typeof fn === 'function') ? fn : (line) => console.log('[qq_websearch] ' + line);
}

function logBackendSkip(backendId, skip) {
  searchLogger('后端跳过：' + describeSkip(backendId, skip));
}

function logBackendDegraded(backendId, count) {
  searchLogger('后端降级：' + describeSkipLabel(backendId) + ' 返回 ' + String(count) + ' 条但整批没有简介，继续尝试下一个');
}

function logBackendFailure(backendId, cls) {
  searchLogger('后端失败：' + describeSkipLabel(backendId) + ' ' + cls.label + ' — ' + cls.detail);
}

function describeSkipLabel(backendId) {
  return BACKEND_LABELS[backendId] !== undefined ? BACKEND_LABELS[backendId] : ('其它后端 · ' + backendId);
}

/** 一条给人看的跳过摘要（启动日志与错误归因共用同一种措辞）。 */
function describeSkip(backendId, skip) {
  const label = BACKEND_LABELS[backendId] !== undefined ? BACKEND_LABELS[backendId] : ('其它后端 · ' + backendId);
  if (skip.kind === 'unregistered') return label + ' 未注册，跳过';
  if (skip.kind === 'unavailable') return label + ' 报告不可用（凭据缺失 / 端点无效 / 配置非法），跳过';
  return label + ' 探测异常（' + skip.detail + '），跳过';
}

/**
 * 按优先级列表依次尝试一次搜索。返回去重后的来源（可能为空数组）。
 *
 * 降级语义逐条如下：
 *   1. 未注册 / 不可用 → 静默跳过，不记失败；
 *   2. 失败 → 记一笔归因，继续下一个（用户取消除外：那是整体失败）；
 *   3. 成功但整批无简介 → 记为回落候选，继续下一个，保证「绝不比不加闸门更差」；
 *   4. 全部跳过/失败 → 有回落候选就给候选，否则抛最后一个真实错误；
 *   5. 全部无结果且无真实失败 → 空数组。
 */
async function runOrderedSearch(query, cap, order, cfg, ctx, signal) {
  const outcomes = [];
  let snippetPoorFallback;
  /** 取消是终止条件，不是「这个后端坏了」：不降级、原样抛给调用方。 */
  // 取消一律抛 name=AbortError 的错误：signal.reason 可能是任意值（甚至是个普通 Error），
  // 原样抛出会让上层按 name 判取消的地方漏判（用户点「停止」被显示成调用失败）。
  const abortError = () => {
    const reason = typeof signal.reason === 'object' && signal.reason !== null && signal.reason.message !== undefined
      ? String(signal.reason.message) : (signal.reason !== undefined ? String(signal.reason) : '搜索已取消');
    return Object.assign(new Error(reason), { name: 'AbortError' });
  };
  for (const backendId of order) {
    if (signal !== undefined && signal !== null && signal.aborted === true) throw abortError();
    // 跳过原因单独记一笔：它既不是「这条后端失败」，也不是「没结果」，报错时不能混为一谈。
    const skip = backendSkipReason(ctx, backendId);
    if (skip !== null) {
      outcomes.push({ backendId, sources: [], skip });
      logBackendSkip(backendId, skip);
      continue;
    }
    try {
      const sources = await searchByBackend(backendId, query, cap, cfg, ctx, signal);
      outcomes.push({ backendId, sources });
      // 成功也要先看取消：请求发出后用户点了「停止」，这里必须抛取消而不是照常返回结果。
      if (signal !== undefined && signal !== null && signal.aborted === true) throw abortError();
      if (sources.length > 0 && hasUsableSnippets(sources) === true) return capSources(sources, cap);
      if (sources.length > 0) snippetPoorFallback = sources;
      if (sources.length > 0) logBackendDegraded(backendId, sources.length);
    } catch (error) {
      // 已取消时一律抛标准的 AbortError（不再原样透传任意 error）：上层按 name 判取消，
      // 透传一个普通 Error 会让「用户点了停止」被当成调用失败。
      if (signal !== undefined && signal !== null && signal.aborted === true) throw abortError();
      const cls = classifySearchError(error);
      outcomes.push({ backendId, sources: [], error });
      // 「官方 key 没余额」与「没配 / key 无效 / 被限流」在日志里必须是不同的句子：
      // 前者去充值，后者去改配置——混在一起会把排障人引向错误的方向。
      logBackendFailure(backendId, cls);
    }
  }
  // 循环里最后一步被取消（比如请求刚发出就中止）：同样按取消处理，不静默返回空数组。
  if (signal !== undefined && signal !== null && signal.aborted === true) throw abortError();
  // 全部后端都没有「带简介的结果」：有回落候选就给它（宁可少简介，也别给空结果或报错）。
  if (snippetPoorFallback !== undefined) return capSources(snippetPoorFallback, cap);
  // 全部失败 → 归因**聚合每一个**后端（只报最后一个会把第一个的故障当成全局故障）。
  const failures = outcomes.filter((outcome) => outcome.error !== undefined);
  if (failures.length > 0) {
    // 聚合串只给人看；分类结论另挂在 error.searchKinds 上，让上层（qq_websearch 的重试判定）
    // 不必再从拼接文本里二次猜测——那个二次猜测此前让 402/429 全都白重试一次。
    const kinds = outcomes
      .filter((outcome) => outcome.error !== undefined)
      .map((outcome) => classifySearchError(outcome.error).kind)
      .filter((kind) => kind !== 'error');
    const aggregate = /** @type {Error & { searchKinds?: string[] }} */ (
      new Error('搜索失败：' + outcomes.map((outcome) => backendOutcomeLabel(outcome)).join('；'))
    );
    aggregate.searchKinds = kinds;
    throw aggregate;
  }
  return [];
}

/**
 * 按后端 id 执行一次搜索。
 *
 * 只有内置的免 Key 多引擎由本模块自己实现；其余**一律**走 ctx.web 的 provider 注册表，
 * 本模块不自带任何 DeepSeek / 智谱实现，也不读 key、不填端点、不做回退。
 * 注册表里没有 → 抛「未注册」，由上层按「降级到下一个」处理。
 */
async function searchByBackend(backendId, query, cap, cfg, ctx, signal) {
  // 内置免 Key 多引擎也要能被打断：signal 一路传到每个引擎请求，取消时立刻停。
  if (backendId === FREE_BACKEND_ID) return await meFreeBackendSearch(query, cap, cfg, ctx, signal);
  const provider = registeredProviderById(ctx, backendId);
  if (provider === undefined) throw new Error('后端 ' + backendId + ' 未注册');
  const result = await provider.search({ query, ...(cap > 0 ? { maxResults: cap } : {}) }, signal);
  const sources = (result !== null && result !== undefined && Array.isArray(result.sources)) ? result.sources : [];
  return capSources(sources, cap);
}

/**
 * qq_websearch 的入口：query 关键词，cap 覆盖默认条数。
 *
 * `signal` 是 agent 侧的取消信号（可选）：收到取消时立刻停止降级、把取消原样抛回去，
 * 不再让一整串引擎跑到超时才结束。
 */
async function runWebSearch(query, cfg, cap, ctx, signal) {
  // 条数：调用方显式传的 > cfg.perQuery > 默认；**0（或负数）= 不截断**，交给各后端自己的默认条数。
  // 不能无条件 Math.max(1, …)：那会把「0 = 不接管」的语义吃掉，永远只剩 1 条。
  const wants = Number.isFinite(cap)
    ? cap
    : (cfg !== null && cfg !== undefined && Number.isFinite(cfg.perQuery) ? cfg.perQuery : SEARCH_DEFAULT_PER_QUERY);
  const max = wants > 0 ? Math.max(1, Math.min(SEARCH_PER_QUERY_MAX, Math.floor(wants))) : 0;
  const order = normalizeOrder(cfg !== null && cfg !== undefined ? cfg.order : undefined);
  return await runOrderedSearch(query, max, order, cfg, ctx, signal);
}

// —— 模块导出（qq_websearch 入口，供 index.js / 设置页路由使用）
export {
  runWebSearch,
  classifySearchError,
  SEARCH_KIND_LABELS,
  parseYandexResults,
  parseBingResults,
  parseBingRss,
  parseDdgResults,
  normalizeOrder,
  hasUsableSnippets,
  backendAvailable,
  FREE_BACKEND_ID,
  DEEPSEEK_BACKEND_ID,
  backendSkipReason,
  describeSkip,
  __setSearchLogger,
  SEARCH_DEFAULT_ORDER,
  SEARCH_ORDER_MAX,
  SEARCH_DEFAULT_PER_QUERY,
  SEARCH_PER_QUERY_MAX,
  BACKEND_LABELS,
};
