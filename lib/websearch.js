// qq_websearch 联网搜索模块（官方 DeepSeek + 免费多引擎组合）。
// 全部请求经 ./http.js 的 multiEngineRequest，受 webSearch.proxy 管控。
import { multiEngineRequest, meDecodeEntities, meCleanText, meStripCdata, ME_BROWSER_UA } from './http.js';
import { request as httpRequest } from 'node:http';
import { connect as tlsConnect } from 'node:tls';

// —— 联网搜索（qq_websearch）：复用 DSH 的 DeepSeek web search（Anthropic Messages 格式）。
// 代理仅作用于搜索请求：webSearch.proxy 非空时走 HTTP CONNECT 隧道，留空则直连。
const WS_DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic/v1';
const WS_DEFAULT_API_KEY_ENV = 'DEEPSEEK_BALANCE_API_KEY';
const WS_DEFAULT_MODEL = 'deepseek-v4-flash';
const WS_API_VERSION = '2023-06-01';
const WS_MAX_TOKENS = 4096;

function wsSearchBaseUrl(cfg) {
  const base = (cfg !== null && cfg !== undefined && typeof cfg.baseUrl === 'string' && cfg.baseUrl.trim() !== '')
    ? cfg.baseUrl.trim() : WS_DEFAULT_BASE_URL;
  return base.replace(/\/+$/, '');
}
// key 解析顺序：DSH credentials 服务（~/.dsh/.credentials.yaml 的 refs）→ process.env 兜底。
async function wsSearchKey(cfg, ctx) {
  const envName = (cfg !== null && cfg !== undefined && typeof cfg.apiKeyEnv === 'string' && cfg.apiKeyEnv.trim() !== '')
    ? cfg.apiKeyEnv.trim() : WS_DEFAULT_API_KEY_ENV;
  let key = (process.env[envName] ?? '').trim();
  try {
    if (ctx !== null && ctx !== undefined && typeof ctx.get === 'function') {
      const credentials = ctx.get('credentials');
      if (credentials !== null && credentials !== undefined && typeof credentials.resolve === 'function') {
        const resolved = await credentials.resolve(envName);
        if (resolved !== null && resolved !== undefined && typeof resolved.value === 'string' && resolved.value.length > 0) {
          key = resolved.value;
        }
      }
    }
  } catch (error) { /* 凭据服务异常则回退 process.env */ }
  return { envName, key };
}
// 解析 DeepSeek Messages 响应 → 来源列表（与 DSH web-search-deepseek 同一映射）
function parseWebSearchResponse(body) {
  const blocks = (body !== null && body !== undefined && Array.isArray(body.content)) ? body.content : [];
  const resultBlocks = blocks.filter((b) => b !== null && b !== undefined && b.type === 'web_search_tool_result');
  if (resultBlocks.length === 0) throw new Error('DeepSeek 未返回 web_search_tool_result 块，本次请求未触发原生搜索');
  const snippets = new Map();
  for (const block of blocks) {
    if (block === null || block === undefined || block.type !== 'text') continue;
    for (const cite of block.citations ?? []) {
      if (cite === null || cite === undefined) continue;
      const u = cite.url, s = cite.cited_text;
      if (typeof u === 'string' && u.length > 0 && typeof s === 'string' && s.length > 0 && !snippets.has(u)) snippets.set(u, s);
    }
  }
  const seen = new Set();
  const sources = [];
  for (const block of resultBlocks) {
    for (const item of block.content ?? []) {
      if (item === null || item === undefined || item.type !== 'web_search_result') continue;
      const url = item.url;
      if (typeof url !== 'string' || url.length === 0 || seen.has(url)) continue;
      seen.add(url);
      const source = { url };
      if (typeof item.title === 'string' && item.title.length > 0) source.title = item.title;
      const snippet = snippets.get(url);
      if (snippet !== undefined) source.snippet = snippet;
      if (typeof item.page_age === 'string' && item.page_age.length > 0) source.publishedAt = item.page_age;
      sources.push(source);
    }
  }
  return sources;
}
// 从 HTTP 响应原文里取出状态码与实体（处理 chunked / content-length / connection: close）。
function webSearchPost(endpoint, headers, body, proxy) {
  if (proxy === undefined || proxy === null || proxy === '') {
    return fetch(endpoint, { method: 'POST', redirect: 'error', headers, body: JSON.stringify(body) })
      .then(async (resp) => {
        let parsed = null;
        try { parsed = await resp.json(); } catch { /* 保留 null */ }
        return { status: resp.status, parsed };
      });
  }
  return new Promise((resolve, reject) => {
    let proxyUrl;
    try { proxyUrl = new URL(proxy); } catch (error) { reject(new Error('webSearch.proxy 无效：' + proxy)); return; }
    if (proxyUrl.protocol !== 'http:' && proxyUrl.protocol !== 'https:') {
      reject(new Error('webSearch.proxy 仅支持 http:// 或 https://（得到 ' + proxyUrl.protocol + '）')); return;
    }
    let targetUrl;
    try { targetUrl = new URL(endpoint); } catch (error) { reject(new Error('搜索端点无效：' + endpoint)); return; }
    if (targetUrl.protocol !== 'https:') {
      reject(new Error('搜索端点必须是 https（代理隧道仅支持 https 目标）')); return;
    }
    const targetPort = targetUrl.port || 443;
    const connectTarget = targetUrl.hostname + ':' + targetPort;
    const connectReq = httpRequest({
      host: proxyUrl.hostname,
      port: proxyUrl.port || (proxyUrl.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: connectTarget,
      headers: { Host: connectTarget, 'Proxy-Connection': 'keep-alive' },
    });
    connectReq.on('error', reject);
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); reject(new Error('代理 CONNECT 失败：HTTP ' + res.statusCode)); return; }
      const tlsSocket = tlsConnect({ socket, servername: targetUrl.hostname });
      tlsSocket.on('error', reject);
      tlsSocket.on('secureConnect', () => {
        const raw = JSON.stringify(body);
        tlsSocket.write('POST ' + targetUrl.pathname + targetUrl.search + ' HTTP/1.1\r\n'
          + 'Host: ' + targetUrl.host + '\r\n'
          + Object.entries(headers).map(([k, v]) => k + ': ' + v).join('\r\n')
          + '\r\ncontent-length: ' + Buffer.byteLength(raw) + '\r\nconnection: close\r\n\r\n' + raw);
      });
      const chunks = [];
      tlsSocket.on('data', (chunk) => chunks.push(chunk));
      tlsSocket.on('end', () => {
        const rawResp = Buffer.concat(chunks).toString('utf8');
        const { status, body: bodyPart } = extractHttpBody(rawResp);
        let parsed = null;
        try { parsed = JSON.parse(bodyPart); } catch { /* 保留 null */ }
        resolve({ status, parsed });
      });
    });
    connectReq.end();
  });
}
// 执行一次搜索：query 关键词，maxUses 覆盖默认
async function runWebSearch(query, cfg, maxUses, ctx) {
  const proxy = (cfg !== null && cfg !== undefined && typeof cfg.proxy === 'string') ? cfg.proxy.trim() : '';
  const multiEngine = (cfg !== null && cfg !== undefined && typeof cfg.multiEngine === 'boolean')
    ? cfg.multiEngine : true;
  const max = Math.max(1, Math.min(10, Math.floor(Number.isFinite(maxUses)
    ? maxUses
    : (cfg !== null && cfg !== undefined && Number.isFinite(cfg.maxUses) ? cfg.maxUses : 5))));
  // 多引擎组合搜索（默认开）：Tavily → DuckDuckGo → Yandex/Bing/Wikipedia，全部受 proxy 管控。
  if (multiEngine) {
    return await runMultiEngineSearch(query, max, proxy, ctx);
  }
  // 关闭时落回官方默认：DeepSeek web_search（deepseek-official 语义）。
  const base = wsSearchBaseUrl(cfg);
  const endpoint = base + '/messages';
  const { envName, key } = await wsSearchKey(cfg, ctx);
  if (key === '') throw new Error('搜索 API key 缺失：凭据 ' + envName + ' 未配置（可在「设置 → QQ 机器人 → 联网搜索」改 apiKeyEnv，或在 DSH 凭据服务里存 DEEPSEEK_BALANCE_API_KEY）');
  const headers = {
    'x-api-key': key,
    'authorization': 'Bearer ' + key,
    'anthropic-version': WS_API_VERSION,
    'content-type': 'application/json',
    'accept': 'application/json',
    'accept-encoding': 'identity',
    'user-agent': 'dsh-qq-bot/0.6.3',
  };
  const body = {
    model: WS_DEFAULT_MODEL,
    max_tokens: WS_MAX_TOKENS,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Perform a web search for the query: ' + query }] }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: max }],
  };
  let resp;
  try { resp = await webSearchPost(endpoint, headers, body, proxy); }
  catch (error) { throw new Error('搜索请求失败：' + String(error)); }
  if (resp.status < 200 || resp.status >= 300) {
    const parsed = resp.parsed;
    const detail = (parsed !== null && parsed !== undefined)
      ? (parsed.error !== null && parsed.error !== undefined && parsed.error.message !== undefined ? parsed.error.message
        : (parsed.message !== undefined ? parsed.message
          : (typeof parsed.error === 'string' ? parsed.error : '')))
      : '';
    throw new Error('DeepSeek 搜索 API 错误（HTTP ' + resp.status + '）' + (detail !== '' ? '：' + detail : ''));
  }
  return parseWebSearchResponse(resp.parsed);
}

// ============ 多引擎组合搜索（webSearch.multiEngine，默认开，完全独立实现） ============
// 组合（参考 deepseek-harness-zh_pro 的免费引擎集，本插件独立实现、不依赖任何其它插件）：
//   Tavily（可选，配 TAVILY_API_KEY 才启用）→ DuckDuckGo（html→lite，串行 + 限流记忆）
//   → Yandex + Bing + Wikipedia 并发兜底、聚合去重。所有引擎请求都受 webSearch.proxy
//   管控：留空直连，非空走 HTTP CONNECT 隧道（与官方路径同一套代理语义）。
// 关闭 multiEngine 时落回官方默认 DeepSeek web_search（deepseek-official）。
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
/** 解析 DuckDuckGo html/lite 结果页。 */
function parseDdgResults(html) {
  const sources = [];
  const seen = new Set();
  const blockRe = /<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]+class="[^"]*\bresult__a\b|<\/body>|$)/g;
  let block;
  while ((block = blockRe.exec(html)) !== null) {
    const url = meUnwrapDdgHref(meDecodeEntities(block[1] ?? ''));
    if (url.length === 0 || seen.has(url)) continue;
    const title = meCleanText(block[2] ?? '');
    const tail = block[3] ?? '';
    const sm = tail.match(/<a[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    const snippet = sm !== null ? meCleanText(sm[1] ?? '') : '';
    seen.add(url);
    sources.push({ url, ...(title.length > 0 ? { title } : {}), ...(snippet.length > 0 ? { snippet } : {}) });
  }
  if (sources.length > 0) return sources;
  const liteRe = /<a[^>]+class="[^"]*\bresult-link\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]+class="[^"]*\bresult-link\b|<\/body>|$)/g;
  let lite;
  while ((lite = liteRe.exec(html)) !== null) {
    const url = meUnwrapDdgHref(meDecodeEntities(lite[1] ?? ''));
    if (url.length === 0 || seen.has(url)) continue;
    const title = meCleanText(lite[2] ?? '');
    const tail = lite[3] ?? '';
    const sm = tail.match(/<td[^>]+class="[^"]*\bresult-snippet\b[^"]*"[^>]*>([\s\S]*?)<\/td>/);
    const snippet = sm !== null ? meCleanText(sm[1] ?? '') : '';
    seen.add(url);
    sources.push({ url, ...(title.length > 0 ? { title } : {}), ...(snippet.length > 0 ? { snippet } : {}) });
  }
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
function parseBingResults(html) {
  const sources = [];
  const seen = new Set();
  const itemRe = /<li\b[^>]*\bclass="[^"]*\bb_algo\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
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
/** 解析 Yandex /search/site/ 结果页（href 即真实 URL；命中词 <b> 逐字包中文）。 */
function parseYandexResults(html) {
  const sources = [];
  const seen = new Set();
  const itemRe = /<a[^>]+class="[^"]*\bb-serp-item__title-link\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]+class="[^"]*\bb-serp-item__title-link\b|<\/ol>|$)/gi;
  let item;
  while ((item = itemRe.exec(html)) !== null) {
    const url = meDecodeEntities(item[1] ?? '').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    if (/\/\/yandex\.[a-z.]+\/clck\/jsredir/i.test(url)) continue;
    if (seen.has(url)) continue;
    const title = meCleanText(item[2] ?? '');
    const sm = (item[3] ?? '').match(/<div[^>]*\bclass="[^"]*\bb-serp-item__text\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const snippet = sm !== null ? meCleanText(sm[1] ?? '') : '';
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
/** 相关性闸门：整批结果与查询零重叠视为「投毒/无关」，宁可不交出去。 */
function meLooksRelevant(sources, query) {
  const tokens = meQueryTokens(query);
  if (tokens.length === 0) return true;
  return sources.some((source) => {
    const haystack = ((source.title ?? '') + ' ' + (source.snippet ?? '') + ' ' + source.url).toLowerCase();
    return tokens.some((token) => haystack.includes(token));
  });
}

/** Tavily key：环境变量 TAVILY_API_KEY → DSH 凭据服务 refs 兜底。 */
async function meResolveTavilyKey(ctx) {
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
async function meDdgSearchOnce(endpoint, query, proxy) {
  if (Date.now() < meDdgLimitedUntil) throw new Error('DuckDuckGo 限流记忆生效中');
  const resp = await multiEngineRequest('POST', endpoint,
    { 'user-agent': ME_BROWSER_UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8', 'content-type': 'application/x-www-form-urlencoded' },
    new URLSearchParams({ q: query, b: '', kl: 'wt-wt' }).toString(), proxy);
  if (resp.status === 202 || /\banomaly\b|challenge-platform|unusual\s+traffic/i.test(resp.body)) {
    meDdgLimitedUntil = Date.now() + ME_DDG_LIMIT_MEMORY_MS;
    throw new Error('DuckDuckGo 触发反爬限流 (HTTP ' + resp.status + ')');
  }
  if (resp.status !== 200) throw new Error('DuckDuckGo 返回 HTTP ' + resp.status);
  return parseDdgResults(resp.body);
}
/** DDG 引擎：html → lite 内部级联。 */
async function meDdgSearch(query, proxy) {
  let lastError = null;
  for (const endpoint of [ME_DDG_HTML, ME_DDG_LITE]) {
    try {
      const sources = await meDdgSearchOnce(endpoint, query, proxy);
      if (sources.length > 0) return sources;
    } catch (error) {
      lastError = error;
      if (/限流/.test(String(error.message ?? ''))) break;
    }
  }
  if (lastError !== null) throw lastError;
  return [];
}
/** Bing：主机 cn→www × 通道 RSS→HTML 遍历；空/不沾边换下一个；全失败抛错。 */
async function meBingSearch(query, proxy) {
  const encoded = encodeURIComponent(query);
  const channels = ME_BING_HOSTS.flatMap((host) => [
    { label: 'Bing RSS (' + new URL(host).hostname + ')', url: host + '?q=' + encoded + '&format=rss&setlang=zh-CN&count=30', parse: parseBingRss },
    { label: 'Bing (' + new URL(host).hostname + ')', url: host + '?q=' + encoded + '&setlang=zh-CN&count=30', parse: parseBingResults },
  ]);
  let lastError = null;
  for (const channel of channels) {
    try {
      const resp = await multiEngineRequest('GET', channel.url,
        { 'user-agent': ME_BROWSER_UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
        null, proxy);
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
async function meYandexSearch(query, proxy) {
  const searchid = String(Math.floor(1000000 + Math.random() * 9000000));
  const url = ME_YANDEX_SEARCH + '?text=' + encodeURIComponent(query) + '&web=1&searchid=' + searchid;
  const resp = await multiEngineRequest('GET', url,
    { 'user-agent': ME_BROWSER_UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    null, proxy);
  if (resp.status === 200 && /showcaptcha|SmartCaptcha|form-unique_key/i.test(resp.body)) {
    throw new Error('Yandex 触发验证码');
  }
  if (resp.status !== 200) throw new Error('Yandex 返回 HTTP ' + resp.status);
  const sources = parseYandexResults(resp.body);
  return meLooksRelevant(sources, query) ? sources : [];
}
/** Wikipedia opensearch（无 Key、稳定）。 */
async function meWikipediaSearch(query, proxy) {
  const url = ME_WIKI_API + '?action=opensearch&format=json&limit=8&search=' + encodeURIComponent(query);
  const resp = await multiEngineRequest('GET', url,
    { 'user-agent': ME_BROWSER_UA, accept: 'application/json,*/*;q=0.8' }, null, proxy);
  if (resp.status !== 200) throw new Error('Wikipedia 返回 HTTP ' + resp.status);
  return parseOpensearchJson(resp.body);
}
/** Tavily（配 TAVILY_API_KEY 才启用；429/432 = 额度耗尽 → 1 小时退避）。 */
async function meTavilySearch(query, cap, proxy, apiKey) {
  if (Date.now() < meTavilyBackoffUntil) throw new Error('Tavily 退避中');
  const resp = await multiEngineRequest('POST', ME_TAVILY_SEARCH,
    { 'user-agent': ME_BROWSER_UA, 'content-type': 'application/json', accept: 'application/json,*/*;q=0.8', authorization: 'Bearer ' + apiKey },
    JSON.stringify({ query, max_results: cap > 0 ? cap : ME_TAVILY_DEFAULT_RESULTS, search_depth: 'basic' }), proxy);
  if (resp.status === 429 || resp.status === 432) {
    meTavilyBackoffUntil = Date.now() + ME_TAVILY_BACKOFF_MS;
    throw new Error('Tavily 额度耗尽或限流 (HTTP ' + resp.status + ')');
  }
  if (resp.status !== 200) throw new Error('Tavily 返回 HTTP ' + resp.status);
  return parseTavilyJson(resp.body);
}
/** 免费多引擎编排：Tavily → DDG → Yandex+Bing+Wikipedia 并发聚合。 */
async function freeMultiEngineSearch(query, cap, proxy, ctx) {
  const outcomes = [];
  // 0) Tavily（配 key 且不在退避窗口才试）
  const tavilyKey = await meResolveTavilyKey(ctx);
  if (tavilyKey !== '') {
    try {
      const sources = await meTavilySearch(query, cap, proxy, tavilyKey);
      outcomes.push({ engine: 'Tavily', sources });
      if (sources.length > 0) return sources;
    } catch (error) { outcomes.push({ engine: 'Tavily', sources: [], error }); }
  }
  // 1) DuckDuckGo
  try {
    const sources = await meDdgSearch(query, proxy);
    outcomes.push({ engine: 'DuckDuckGo', sources });
    if (sources.length > 0) return sources;
  } catch (error) { outcomes.push({ engine: 'DuckDuckGo', sources: [], error }); }
  // 2) Yandex + Bing + Wikipedia 并发兜底，聚合去重（合并顺序即优先级）
  const [y, b, w] = await Promise.allSettled([
    meYandexSearch(query, proxy),
    meBingSearch(query, proxy),
    meWikipediaSearch(query, proxy),
  ]);
  const merged = [];
  const seen = new Set();
  for (const [engine, settled] of [['Yandex', y], ['Bing', b], ['Wikipedia', w]]) {
    if (settled.status === 'fulfilled') {
      outcomes.push({ engine, sources: settled.value });
      for (const source of settled.value) {
        if (seen.has(source.url)) continue;
        seen.add(source.url);
        merged.push(source);
      }
    } else {
      outcomes.push({ engine, sources: [], error: settled.reason });
    }
  }
  if (merged.length > 0) return merged.slice(0, cap);
  const failures = outcomes.filter((o) => o.error !== undefined);
  if (failures.length === 0) return [];
  throw new Error('多引擎搜索失败: ' + outcomes.map((o) => {
    const msg = o.error instanceof Error ? o.error.message : (typeof o.error === 'string' ? o.error : String(o.error ?? '未知错误'));
    return msg.startsWith(o.engine) ? msg : o.engine + ' ' + msg;
  }).join('；'));
}
/** 多引擎入口（multiEngine=true 时走这里）：Tavily → DDG → 免费兜底。 */
async function runMultiEngineSearch(query, cap, proxy, ctx) {
  const max = Math.max(1, Math.min(10, Math.floor(Number.isFinite(cap) ? cap : 5)));
  return await freeMultiEngineSearch(query, max, proxy, ctx);
}

// —— 模块导出（qq_websearch 入口，供 index.js 使用）
export { runWebSearch, parseWebSearchResponse };
