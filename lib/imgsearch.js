// qq_imgsearch 图片反搜模块（多引擎 + 图床上传）。
// 全部请求经 ./http.js 的 multiEngineRequest，受 webSearch.proxy 管控。
import { basename, join, resolve, sep } from 'node:path';
import { promises as fsPromises } from 'node:fs';
import { multiEngineRequest, meDecodeEntities, meCleanText, ME_BROWSER_UA } from './http.js';
// ============ 图片反搜（qq_imgsearch）：TraceMoe + IQDB，全部受 webSearch.proxy 管控 ============
// 引擎实测（2026-10，PicImageSearch 交叉验证）：TraceMoe（api.trace.moe，URL 模式 JSON，
// 动画截图直连可用、最快）、IQDB（iqdb.org，POST form url=，ACG 直连可用）。两个都走
// multiEngineRequest → 与 qq_websearch 同一套代理语义：webSearch.proxy 留空直连、非空走
// CONNECT 隧道。copyseeker/tineye 是多步 token 流程（Node 侧复杂），留作后续。
/** TraceMoe 动画截图识别（URL 模式）。 */
async function imgSearchTraceMoe(imageUrl, cap, proxy) {
  const url = 'https://api.trace.moe/search?url=' + encodeURIComponent(imageUrl) + '&anilistInfo=';
  const resp = await multiEngineRequest('GET', url,
    { 'user-agent': ME_BROWSER_UA, accept: 'application/json,*/*;q=0.8' }, null, proxy);
  if (resp.status !== 200) throw new Error('TraceMoe 返回 HTTP ' + resp.status);
  let data;
  try { data = JSON.parse(resp.body); } catch (error) { throw new Error('TraceMoe 响应解析失败'); }
  const results = (data !== null && data !== undefined && Array.isArray(data.result)) ? data.result : [];
  const sources = [];
  const seen = new Set();
  for (const item of results) {
    if (item === null || typeof item !== 'object') continue;
    const anilist = (typeof item.anilist === 'object' && item.anilist !== null) ? item.anilist : {};
    const titles = anilist.title;
    const title = (titles !== null && typeof titles === 'object')
      ? String(titles.chinese || titles.romaji || titles.english || titles.native || '').trim() : '';
    const siteUrl = typeof anilist.siteUrl === 'string' ? anilist.siteUrl : '';
    const filename = typeof item.filename === 'string' ? item.filename : '';
    const target = siteUrl !== '' ? siteUrl
      : (filename !== '' ? 'https://trace.moe/?' + encodeURIComponent(filename) : '');
    if (target === '' || seen.has(target)) continue;
    seen.add(target);
    const snippetParts = [];
    if (item.episode !== undefined && item.episode !== null && item.episode !== '') snippetParts.push('第' + item.episode + '集');
    if (typeof item.similarity === 'number') snippetParts.push('相似度 ' + Math.round(item.similarity * 100) + '%');
    if (typeof item.from === 'number') snippetParts.push('时间 ' + item.from.toFixed(1) + 's');
    sources.push({ url: target, ...(title !== '' ? { title } : {}),
      ...(snippetParts.length > 0 ? { snippet: snippetParts.join(' · ') } : {}) });
    if (sources.length >= cap) break;
  }
  return sources;
}
/** IQDB 反向搜图（POST form url=）。 */
async function imgSearchIqdb(imageUrl, cap, proxy) {
  const resp = await multiEngineRequest('POST', 'https://iqdb.org/',
    { 'user-agent': ME_BROWSER_UA, accept: 'text/html,*/*;q=0.8', 'content-type': 'application/x-www-form-urlencoded' },
    new URLSearchParams({ url: imageUrl }).toString(), proxy);
  if (resp.status !== 200) throw new Error('IQDB 返回 HTTP ' + resp.status);
  const sources = [];
  const seen = new Set();
  const rowsRe = /<tr>([\s\S]*?)<\/tr>/gi;
  let row;
  while ((row = rowsRe.exec(resp.body)) !== null) {
    const block = row[1];
    const th = block.match(/<th>([\s\S]*?)<\/th>/i);
    const link = block.match(/<a[^>]+href="([^"]+)"[^>]*>/i);
    if (th === null || link === null) continue;
    const matchType = meCleanText(th[1]);
    const href = meDecodeEntities(link[1]);
    // IQDB 页内链接是协议相对格式（//danbooru.donmai.us）或站内路径（/xxxx）：
    // 协议相对 → 补 https:；站内路径 → 拼 iqdb.org 前缀；绝对 URL 直接用。
    let target = href;
    if (/^https?:/i.test(target)) { /* 绝对 URL，直接用 */ }
    else if (target.startsWith('//')) target = 'https:' + target;
    else target = 'https://iqdb.org' + (target.startsWith('/') ? '' : '/') + target;
    if (seen.has(target)) continue;
    seen.add(target);
    const thumb = block.match(/<img[^>]+src="([^"]+)"/i);
    const alt = block.match(/<img[^>]+alt="([^"]*)"/i);
    const snippet = (alt !== null ? meCleanText(alt[1]) : '') + (thumb !== null ? ' 缩略图 https://iqdb.org' + thumb[1] : '');
    sources.push({ url: target, ...(matchType !== '' ? { title: matchType } : {}),
      ...(snippet !== '' ? { snippet } : {}) });
    if (sources.length >= cap) break;
  }
  return sources;
}
/** Tineye 反向搜图（POST result_json → matches，通用图片搜索，体量大）。 */
async function imgSearchTineye(imageUrl, cap, proxy) {
  const params = new URLSearchParams({ url: imageUrl, sort: 'score', order: 'desc', page: '1' });
  const resp = await multiEngineRequest('POST', 'https://tineye.com/api/v1/result_json/',
    { 'user-agent': ME_BROWSER_UA, accept: 'application/json,*/*;q=0.8', 'content-type': 'application/x-www-form-urlencoded' },
    params.toString(), proxy);
  if (resp.status !== 200) throw new Error('Tineye 返回 HTTP ' + resp.status);
  let data;
  try { data = JSON.parse(resp.body); } catch (error) { throw new Error('Tineye 响应解析失败'); }
  const matches = (data !== null && data !== undefined && Array.isArray(data.matches)) ? data.matches : [];
  const sources = [];
  const seen = new Set();
  for (const item of matches) {
    if (item === null || typeof item !== 'object') continue;
    const backlinks = Array.isArray(item.backlinks) ? item.backlinks : [];
    const first = backlinks.length > 0 && typeof backlinks[0] === 'object' && backlinks[0] !== null ? backlinks[0] : null;
    const target = (first !== null && typeof first.backlink === 'string') ? first.backlink : '';
    if (target === '' || seen.has(target)) continue;
    seen.add(target);
    const imageUrl2 = (first !== null && typeof first.url === 'string') ? first.url : '';
    const domain = typeof item.domain === 'string' ? item.domain : '';
    const parts = [];
    if (domain !== '') parts.push('来源 ' + domain);
    if (imageUrl2 !== '') parts.push('图片 ' + imageUrl2);
    sources.push({ url: target, ...(domain !== '' ? { title: domain } : {}),
      ...(parts.length > 0 ? { snippet: parts.join(' · ') } : {}) });
    if (sources.length >= cap) break;
  }
  return sources;
}
/** Copyseeker Next.js action 响应：从 `1:{json}` 行取首个 JSON。 */
function meCopyseekerFirstJson(responseText) {
  for (const line of String(responseText).split('\n')) {
    const t = line.trim();
    if (t.startsWith('1:{')) {
      try { return JSON.parse(t.slice(2)); } catch (error) { /* 跳过坏行 */ }
    }
  }
  return null;
}
/** Copyseeker 反向搜图（3 步 token + 会话 cookie，结果最多）。 */
async function imgSearchCopyseeker(imageUrl, cap, proxy) {
  const BASE = 'https://copyseeker.net';
  const TOKENS = {
    SET: '001d97c0b67ff86415a5834958bf47b1720f17d286',
    URL: '40550e4a7aa709f3b9d811652f4709bc532ddf7ff7',
    GET: '40625aa15a7e11b250e74d850fe96cd50b2d7eca11',
  };
  const SEARCH = '/reverse-image-search';
  let cookie = '';
  // 1) 初始化拿会话 cookie
  const r1 = await multiEngineRequest('POST', BASE + SEARCH,
    { 'user-agent': ME_BROWSER_UA, 'content-type': 'text/plain;charset=UTF-8', 'next-action': TOKENS.SET },
    '[]', proxy);
  if (r1.status !== 200) throw new Error('Copyseeker 初始化 HTTP ' + r1.status);
  if (r1.headers !== undefined && r1.headers !== null && typeof r1.headers['set-cookie'] === 'string' && r1.headers['set-cookie'] !== '') {
    cookie = r1.headers['set-cookie'];
  }
  // 2) 提交图片 URL 拿 discoveryId
  const r2 = await multiEngineRequest('POST', BASE + SEARCH,
    { 'user-agent': ME_BROWSER_UA, 'content-type': 'text/plain;charset=UTF-8', 'next-action': TOKENS.URL, ...(cookie !== '' ? { cookie } : {}) },
    JSON.stringify([{ discoveryType: 'ReverseImageSearch', imageUrl }]), proxy);
  if (r2.status !== 200) throw new Error('Copyseeker 提交 HTTP ' + r2.status);
  const payload2 = meCopyseekerFirstJson(r2.body);
  const discoveryId = (payload2 !== null && payload2 !== undefined && typeof payload2.discoveryId === 'string') ? payload2.discoveryId : '';
  if (discoveryId === '') throw new Error('Copyseeker 未返回 discoveryId');
  // 3) 拿结果
  const r3 = await multiEngineRequest('POST', BASE + '/discovery',
    { 'user-agent': ME_BROWSER_UA, 'content-type': 'text/plain;charset=UTF-8', 'next-action': TOKENS.GET, ...(cookie !== '' ? { cookie } : {}) },
    JSON.stringify([{ discoveryId, hasBlocker: false }]), proxy);
  if (r3.status !== 200) throw new Error('Copyseeker 结果 HTTP ' + r3.status);
  const payload = meCopyseekerFirstJson(r3.body);
  const pages = (payload !== null && payload !== undefined && Array.isArray(payload.pages)) ? payload.pages : [];
  const sources = [];
  const seen = new Set();
  for (const page of pages) {
    if (page === null || typeof page !== 'object') continue;
    const target = typeof page.url === 'string' ? page.url : '';
    if (target === '' || seen.has(target)) continue;
    seen.add(target);
    const title = typeof page.title === 'string' ? page.title : '';
    const mainImage = typeof page.mainImage === 'string' ? page.mainImage : '';
    const snippetParts = [];
    if (mainImage !== '') snippetParts.push('图 ' + mainImage);
    sources.push({ url: target, ...(title !== '' ? { title } : {}),
      ...(snippetParts.length > 0 ? { snippet: snippetParts.join(' · ') } : {}) });
    if (sources.length >= cap) break;
  }
  return sources;
}
/** 取嵌套对象字段（'a.b.c'）。 */
function meDeepGet(obj, path) {
  const keys = String(path).split('.');
  let cur = obj;
  for (const k of keys) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}
/** Yandex 反向搜图（GET images/search?rpt=imageview，解析 data-state → initialState.cbirSites.sites，全球体量大）。 */
async function imgSearchYandex(imageUrl, cap, proxy) {
  const params = new URLSearchParams({ rpt: 'imageview', cbir_page: 'sites', url: imageUrl });
  const resp = await multiEngineRequest('GET', 'https://yandex.com/images/search?' + params.toString(),
    { 'user-agent': ME_BROWSER_UA, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    undefined, proxy);
  if (resp.status !== 200) throw new Error('Yandex 返回 HTTP ' + resp.status);
  const divM = resp.body.match(/<div[^>]*id="ImagesApp-[^"]*"[^>]*>/);
  if (divM === null) throw new Error('Yandex 页面结构异常（无 ImagesApp 容器）');
  const dsM = divM[0].match(/\bdata-state="([^"]*)"/);
  if (dsM === null) throw new Error('Yandex 页面结构异常（无 data-state）');
  let data;
  try { data = JSON.parse(meDecodeEntities(dsM[1])); } catch (error) { throw new Error('Yandex data-state 解析失败'); }
  const sites = meDeepGet(data, 'initialState.cbirSites.sites');
  if (!Array.isArray(sites)) return [];
  const sources = [];
  const seen = new Set();
  for (const site of sites) {
    if (site === null || typeof site !== 'object') continue;
    const target = typeof site.url === 'string' ? site.url : '';
    if (target === '' || seen.has(target)) continue;
    seen.add(target);
    const title = typeof site.title === 'string' ? site.title : '';
    const domain = typeof site.domain === 'string' ? site.domain : '';
    let thumb = '';
    if (site.thumb !== null && typeof site.thumb === 'object' && typeof site.thumb.url === 'string') {
      thumb = site.thumb.url;
      if (thumb.startsWith('//')) thumb = 'https:' + thumb;
    }
    const desc = typeof site.description === 'string' ? site.description : '';
    const parts = [];
    if (domain !== '') parts.push('来源 ' + domain);
    if (thumb !== '') parts.push('图 ' + thumb);
    sources.push({ url: target, ...(title !== '' ? { title } : {}),
      ...(parts.length > 0 ? { snippet: parts.join(' · ') } : (desc !== '' ? { snippet: desc.slice(0, 200) } : {})) });
    if (sources.length >= cap) break;
  }
  return sources;
}
/** SauceNAO 反向搜图（需 imgSearch.saucenaoKey；output_type=2 JSON，直连/代理皆可，ACG + 全网图库）。 */
async function imgSearchSauceNAO(imageUrl, cap, proxy, apiKey) {
  const params = new URLSearchParams({ testmode: '0', numres: String(cap), output_type: '2', hide: '0', db: '999', minsim: '30', url: imageUrl });
  if (typeof apiKey === 'string' && apiKey !== '') params.set('api_key', apiKey);
  const resp = await multiEngineRequest('GET', 'https://saucenao.com/search.php?' + params.toString(),
    { 'user-agent': ME_BROWSER_UA, accept: 'application/json' }, undefined, proxy);
  if (resp.status !== 200) throw new Error('SauceNAO 返回 HTTP ' + resp.status);
  let data;
  try { data = JSON.parse(resp.body); } catch (error) { throw new Error('SauceNAO 响应解析失败'); }
  const results = Array.isArray(data.results) ? data.results : [];
  const sources = [];
  const seen = new Set();
  for (const item of results) {
    if (item === null || typeof item !== 'object') continue;
    const header = (item.header !== null && typeof item.header === 'object') ? item.header : {};
    const body = (item.data !== null && typeof item.data === 'object') ? item.data : {};
    const extUrls = Array.isArray(body.ext_urls) ? body.ext_urls : [];
    const target = extUrls.length > 0 && typeof extUrls[0] === 'string' ? extUrls[0] : '';
    if (target === '' || seen.has(target)) continue;
    seen.add(target);
    const simRaw = header.similarity;
    const sim = typeof simRaw === 'number' ? simRaw : Number.parseFloat(simRaw);
    const indexName = typeof header.index_name === 'string' ? header.index_name : '';
    const title = (typeof body.title === 'string' && body.title !== '') ? body.title
      : (typeof body.material === 'string' && body.material !== '') ? body.material : '';
    const parts = [];
    if (indexName !== '') parts.push('来源 ' + indexName);
    if (Number.isFinite(sim)) parts.push('相似度 ' + Math.round(sim) + '%');
    sources.push({ url: target, ...(title !== '' ? { title } : {}),
      ...(parts.length > 0 ? { snippet: parts.join(' · ') } : {}) });
    if (sources.length >= cap) break;
  }
  return sources;
}
/** Soutubot（搜图Bot酱）：先下载图片再上传搜索（API 只收文件），查 /api/results 多库结果；放 SauceNAO 后面。 */
/** Soutubot 上传 + 查结果 + 解析（公共：URL 下载与本地文件直传共用）。 */
async function meSoutubotUploadAndParse(fileBuf, fileName, mime, cap, proxy) {
  const { body, contentType } = meBuildMultipart({}, fileBuf, fileName, mime, 'file');
  const searchResp = await multiEngineRequest('POST', 'https://soutubot.moe/api/search',
    { 'user-agent': ME_BROWSER_UA, 'content-type': contentType }, body, proxy);
  let sj;
  try { sj = JSON.parse(searchResp.body); } catch (error) { throw new Error('Soutubot 搜索响应解析失败'); }
  if (sj.status !== 'ok' || typeof sj.result_id !== 'string') {
    throw new Error('Soutubot 搜索失败: ' + (sj.detail !== undefined ? JSON.stringify(sj.detail) : String(sj.status)));
  }
  const resResp = await multiEngineRequest('GET', 'https://soutubot.moe/api/results/' + encodeURIComponent(sj.result_id),
    { 'user-agent': ME_BROWSER_UA, accept: 'application/json' }, undefined, proxy);
  let rj;
  try { rj = JSON.parse(resResp.body); } catch (error) { throw new Error('Soutubot 结果解析失败'); }
  const results = Array.isArray(rj.results) ? rj.results : [];
  const sources = [];
  const seen = new Set();
  for (const item of results) {
    if (item === null || typeof item !== 'object') continue;
    const segs = Array.isArray(item.path_segments) ? item.path_segments : [];
    let url = '';
    const tags = { artists: [], characters: [], general: [] };
    for (const seg of segs) {
      if (seg === null || typeof seg !== 'object') continue;
      const md = (seg.metadata !== null && typeof seg.metadata === 'object') ? seg.metadata : {};
      if (Array.isArray(md.source_links)) {
        for (const sl of md.source_links) {
          if (sl !== null && typeof sl === 'object' && typeof sl.url === 'string' && sl.url !== '') { url = sl.url; break; }
        }
      }
      if (url === '' && md.post !== null && typeof md.post === 'object' && typeof md.post.post_url === 'string') url = md.post.post_url;
      if (url === '' && Array.isArray(md.mirrors)) {
        for (const m of md.mirrors) { if (m !== null && typeof m === 'object' && typeof m.post_url === 'string' && m.post_url !== '') { url = m.post_url; break; } }
      }
      if (md.tags !== null && typeof md.tags === 'object') {
        const collect = (key) => { const arr = md.tags[key]; if (Array.isArray(arr)) for (const t of arr) { if (t !== null && typeof t === 'object' && typeof t.text === 'string') tags[key].push(t.text); } };
        collect('artists'); collect('characters'); collect('general');
      }
      if (url !== '') break;
    }
    if (url === '' || seen.has(url)) continue;
    seen.add(url);
    const title = tags.artists.concat(tags.characters).slice(0, 3).join(' / ');
    const parts = [];
    const scoreRaw = item.score;
    const scoreNum = typeof scoreRaw === 'number' ? scoreRaw : Number.parseFloat(scoreRaw);
    if (Number.isFinite(scoreNum)) parts.push('相似度 ' + (scoreNum > 1 ? Math.round(scoreNum) : Math.round(scoreNum * 100)) + '%');
    if (typeof item.api_id === 'string') parts.push(item.api_id);
    if (tags.general.length > 0) parts.push(tags.general.slice(0, 4).join(', '));
    sources.push({ url, ...(title !== '' ? { title } : {}), ...(parts.length > 0 ? { snippet: parts.join(' · ') } : {}) });
    if (sources.length >= cap) break;
  }
  return sources;
}
/** Soutubot URL 模式：先下载图片（二进制走代理）再上传。 */
async function imgSearchSoutubot(imageUrl, cap, proxy) {
  const dl = await multiEngineRequest('GET', imageUrl, { 'user-agent': ME_BROWSER_UA }, undefined, proxy, undefined, true);
  if (dl.status !== 200 || !Buffer.isBuffer(dl.body)) throw new Error('Soutubot 图片下载失败 HTTP ' + dl.status);
  return await meSoutubotUploadAndParse(dl.body, 'image.jpg', 'image/jpeg', cap, proxy);
}
/** Soutubot 本地文件直传（kind=comic + file 用，不上图床）。 */
async function imgSearchSoutubotFile(filePath, cap, proxy) {
  const buf = await fsPromises.readFile(filePath);
  return await meSoutubotUploadAndParse(buf, basename(filePath), meMimeFromExt(filePath), cap, proxy);
}
/** 按权重随机重排（不放回加权抽样）：体量大的常在前，但顺序每次随机，避免固定引擎一直打头（有代理 weightedShuffle 开启时用）。 */
function meWeightedShuffle(items, weights) {
  const pool = items.map((it, i) => ({ it, w: (weights && weights[i] > 0) ? weights[i] : 1 }));
  const out = [];
  while (pool.length > 0) {
    let total = 0;
    for (const p of pool) total += p.w;
    let r = Math.random() * total;
    let idx = 0;
    for (let i = 0; i < pool.length; i++) { r -= pool[i].w; if (r <= 0) { idx = i; break; } }
    out.push(pool[idx].it);
    pool.splice(idx, 1);
  }
  return out;
}
/** 图片反搜入口：有代理 = 全部可用引擎按用户体量优先（Yandex > Tineye > Copyseeker > SauceNAO > IQDB > TraceMoe，可开加权随机重排）；
 *  无代理 = 直连引擎按可用性优先（TraceMoe > IQDB > SauceNAO）。聚合去重，cap 满即停，失败继续下一引擎。 */
async function runImageSearch(imageUrl, cap, proxy, opts) {
  const o = (opts !== null && opts !== undefined && typeof opts === 'object') ? opts : {};
  const hasProxy = typeof proxy === 'string' && proxy.trim() !== '';
  const saucenaoKey = typeof o.saucenaoKey === 'string' ? o.saucenaoKey : '';
  const kind = o.kind === 'comic' ? 'comic' : 'auto';
  const order = [];
  if (kind === 'comic') {
    // 漫画/本子截图：Soutubot + SauceNAO 优先（垂直引擎），通用引擎兜底。
    const items = [];
    items.push(['Soutubot', imgSearchSoutubot]);
    if (saucenaoKey !== '') items.push(['SauceNAO', (u, c, p) => imgSearchSauceNAO(u, c, p, saucenaoKey)]);
    items.push(['IQDB', imgSearchIqdb], ['TraceMoe', imgSearchTraceMoe]);
    if (hasProxy) {
      items.push(['Yandex', imgSearchYandex], ['Tineye', imgSearchTineye], ['Copyseeker', imgSearchCopyseeker]);
      if (o.weightedShuffle === true) {
        const wm = { Soutubot: 40, SauceNAO: 30, IQDB: 20, TraceMoe: 10, Yandex: 5, Tineye: 5, Copyseeker: 5 };
        order.push(...meWeightedShuffle(items, items.map((e) => (wm[e[0]] !== undefined ? wm[e[0]] : 5))));
      } else {
        order.push(...items);
      }
    } else {
      order.push(...items);
    }
  } else if (hasProxy) {
    const items = [
      ['Yandex', imgSearchYandex], ['Tineye', imgSearchTineye], ['Copyseeker', imgSearchCopyseeker], ['Soutubot', imgSearchSoutubot], ['IQDB', imgSearchIqdb], ['TraceMoe', imgSearchTraceMoe],
    ];
    if (saucenaoKey !== '') items.splice(3, 0, ['SauceNAO', (u, c, p) => imgSearchSauceNAO(u, c, p, saucenaoKey)]);
    if (o.weightedShuffle === true) {
      // 体量权重：Yandex/Tineye/Copyseeker 高，IQDB/TraceMoe 低；每次调用随机重排，避免固定引擎一直打头。
      const weightMap = { Yandex: 30, Tineye: 25, Copyseeker: 25, SauceNAO: 15, Soutubot: 8, IQDB: 5, TraceMoe: 5 };
      order.push(...meWeightedShuffle(items, items.map((e) => (weightMap[e[0]] !== undefined ? weightMap[e[0]] : 10))));
    } else {
      order.push(...items);
    }
  } else {
    order.push(['TraceMoe', imgSearchTraceMoe], ['IQDB', imgSearchIqdb]);
    if (saucenaoKey !== '') order.push(['SauceNAO', (u, c, p) => imgSearchSauceNAO(u, c, p, saucenaoKey)]);
    order.push(['Soutubot', imgSearchSoutubot]);
  }
  const outcomes = [];
  const aggregated = [];
  const seen = new Set();
  for (const entry of order) {
    const engine = entry[0];
    const fn = entry[1];
    try {
      const sources = await fn(imageUrl, cap, proxy);
      outcomes.push({ engine, sources });
      for (const s of sources) {
        if (s === null || s === undefined) continue;
        if (!seen.has(s.url)) { seen.add(s.url); aggregated.push(s); }
        if (aggregated.length >= cap) return aggregated;
      }
    } catch (error) { outcomes.push({ engine, sources: [], error }); }
  }
  if (aggregated.length > 0) return aggregated;
  const failures = outcomes.filter((o) => o.error !== undefined);
  if (failures.length === 0) return [];
  throw new Error('图片搜索失败: ' + outcomes.map((o) => {
    const msg = o.error instanceof Error ? o.error.message : (typeof o.error === 'string' ? o.error : String(o.error ?? '未知错误'));
    return msg.startsWith(o.engine) ? msg : o.engine + ' ' + msg;
  }).join('；'));
}

// ---- 图床上传（qq_imgsearch 本地文件 → 上传图床拿公网 URL 再反搜；三床加权随机重排，一律走 webSearch.proxy 管控）----
function meBuildMultipart(fields, fileBuf, filename, mime, fileField) {
  const boundary = '----dshimg' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  const parts = [];
  for (const [k, v] of Object.entries(fields || {})) {
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + v + '\r\n'));
  }
  parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + fileField + '"; filename="' + filename + '"\r\nContent-Type: ' + mime + '\r\n\r\n'));
  parts.push(fileBuf);
  parts.push(Buffer.from('\r\n--' + boundary + '--\r\n'));
  return { body: Buffer.concat(parts), contentType: 'multipart/form-data; boundary=' + boundary };
}
function meMimeFromExt(filename) {
  const ext = String(filename).toLowerCase().split('.').pop();
  const map = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
  return map[ext] !== undefined ? map[ext] : 'application/octet-stream';
}
function meParseHostUrl(host, text) {
  try {
    const j = JSON.parse(text);
    if (host === 'scdn') return (j.success === true && typeof j.url === 'string') ? j.url : '';
    if (host === 'uguu') { const f = Array.isArray(j.files) && j.files[0]; return f && typeof f.url === 'string' ? f.url : ''; }
    if (host === 'zixiaoyun') return (j.result === 'success' && typeof j.url === 'string') ? j.url : '';
  } catch (error) { /* 非 JSON */ }
  return '';
}
/** 本地图片文件白名单校验：只允许 qqMsgRoot/qq-images 目录下的图片（访客也能用，但读不了任意文件）。 */
function meIsAllowedImageFile(filePath) {
  try {
    const abs = resolve(String(filePath));
    let imgRootDir = '';
    try { imgRootDir = resolve(qqMsgRootSync(), 'qq-images'); } catch (error) { return false; }
    return abs === imgRootDir || abs.startsWith(imgRootDir + sep);
  } catch (error) { return false; }
}
/** 上传本地文件到图床：三个可用图床（zixiaoyun/scdn/uguu）按实测质量加权随机重排，依次试到第一个成功；
 *  一律走 webSearch.proxy 管控（留空直连、非空 CONNECT 隧道）。 */
async function uploadToHost(filePath, proxy) {
  const buf = await fsPromises.readFile(filePath);
  const filename = basename(filePath) || 'image.jpg';
  const mime = meMimeFromExt(filename);
  const hosts = [
    { name: 'zixiaoyun', url: 'https://f3.zxgjw.com/localup.php', field: 'file', w: 35 },
    { name: 'scdn', url: 'https://img.scdn.io/api/v1.php', field: 'image', w: 33 },
    { name: 'uguu', url: 'https://uguu.se/upload', field: 'files[]', w: 32 },
  ];
  const ordered = meWeightedShuffle(hosts, hosts.map((h) => h.w));
  const errors = [];
  for (const h of ordered) {
    try {
      const { body, contentType } = meBuildMultipart({}, buf, filename, mime, h.field);
      const resp = await multiEngineRequest('POST', h.url, { 'user-agent': ME_BROWSER_UA, 'content-type': contentType }, body, proxy);
      const url = meParseHostUrl(h.name, resp.body);
      if (url !== '') return { host: h.name, url, error: '' };
      errors.push(h.name + ' 无 URL');
    } catch (error) { errors.push(h.name + ' ' + (error instanceof Error ? error.message : String(error))); }
  }
  throw new Error('图床上传失败: ' + errors.join('；'));
}
/** 回退：不经过图床，直接把本地文件发给 TraceMoe（文件直传搜图）。 */
async function imgSearchTraceMoeFile(filePath, cap, proxy) {
  const buf = await fsPromises.readFile(filePath);
  const filename = basename(filePath) || 'image.jpg';
  const { body, contentType } = meBuildMultipart({}, buf, filename, meMimeFromExt(filename), 'image');
  const resp = await multiEngineRequest('POST', 'https://api.trace.moe/search?anilistInfo=', { 'user-agent': ME_BROWSER_UA, 'content-type': contentType }, body, proxy);
  let data;
  try { data = JSON.parse(resp.body); } catch (error) { throw new Error('TraceMoe 响应解析失败'); }
  const results = Array.isArray(data.result) ? data.result : [];
  const sources = [];
  const seen = new Set();
  for (const item of results) {
    if (item === null || typeof item !== 'object' || typeof item.similarity !== 'number') continue;
    const anime = (item.anilist !== null && typeof item.anilist === 'object') ? item.anilist : {};
    const title = (anime.title !== null && typeof anime.title === 'object') ? anime.title : {};
    const name = String(title.chinese || title.romaji || title.native || title.english || '未知番剧');
    const target = typeof anime.siteUrl === 'string' ? anime.siteUrl : '';
    if (target === '' || seen.has(target)) continue;
    seen.add(target);
    const sim = Math.round(item.similarity * 100);
    const parts = ['相似度 ' + sim + '%'];
    if (typeof item.episode === 'number') parts.push('第' + item.episode + '话');
    sources.push({ url: target, title: name, snippet: parts.join(' · ') });
    if (sources.length >= cap) break;
  }
  return sources;
}

// —— 模块导出（qq_imgsearch 入口，供 index.js 使用）
export { runImageSearch, uploadToHost, imgSearchSoutubotFile, imgSearchTraceMoeFile, meIsAllowedImageFile };
