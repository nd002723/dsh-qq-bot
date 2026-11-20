// 通用 HTTP 传输层（multiEngineRequest / 代理 CONNECT 隧道 / 文本工具）。
// 被 tools/websearch.js 与 tools/imgsearch.js 共用 —— 两个搜索模块都受本模块的 http 代理管控。
//
// 分层：**能不能出站**由 valve/network/policy.js 判定（公网校验、内网黑名单、钉地址），
// 本文件只负责**怎么出站**（直连 / CONNECT 隧道、超时、体积上限、截断语义）。
// 任何新增出网路径都必须先过策略层，别在这里另写一套判定。
//
// 代理归属：本层**不读配置**。用哪个代理由网络阀门安装的解析器决定
// （valve/network/index.js 在成型时调 __setProxyResolver），调用方只声明意图：
// 不传 = 按阀门策略走；显式传 '' = 强制直连；显式传地址 = 只给测试/特例用。
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { canonicalHost, isNonPublicIp, resolvePublicAddresses, assertPublicHost, __setNetworkHooks, __networkHooks, pinnedLookup } from '../valve/network/policy.js';
/**
 * 代理解析器：由网络阀门在网络阀门成型时安装（stage 10），传输层自己不读配置。
 * 工具层因此拿不到代理串，也就没法「顺手」绕开阀门——这是有意为之。
 */
let proxyResolver = () => '';

/** 安装/清除代理解析器（只有网络阀门该调它；测试可注入桩）。 */
export function __setProxyResolver(fn) {
  proxyResolver = (typeof fn === 'function') ? fn : () => '';
}

/** 当前生效的代理串（'' = 直连）。 */
export function currentProxy() {
  let value;
  try { value = proxyResolver(); } catch (error) { value = ''; }
  return (value === undefined || value === null) ? '' : String(value).trim();
}

/**
 * 解析出这次出网该用的代理。
 * @param {string|{useProxy?: boolean}|undefined} spec 调用方给的意图
 * @param {boolean} legacy true = 老的位置参数（字符串或 undefined）
 */
function resolveProxySpec(spec, legacy) {
  if (legacy === true) {
    // 老的位置参数：显式给了字符串就照用（'' = 直连）；undefined/null = 按阀门策略。
    // 注意 null 在老代码里曾被当成「直连」，现在统一按「未指定」处理——lib/ 内无调用方传 null，
    // 若外部有调用依赖旧语义，显式传 '' 即可。
    if (spec === undefined || spec === null) return currentProxy();
    return String(spec).trim();
  }
  // 非 legacy 分支约定 spec 是意图对象（字符串只可能出现在 legacy=true 的老式调用里）。
  const opts = /** @type {{useProxy?: boolean}} */ ((spec === null || spec === undefined) ? {} : spec);
  if (opts.useProxy === false) return '';   // 明确要求直连
  // 这里刻意**不接受** opts.proxy：代理串只能由网络阀门安装的解析器提供，
  // 否则任何直接 import 本模块的代码都能自带一个代理、绕开阀门的策略与审计。
  // 测试要自定义代理，用 __setProxyResolver 装桩。
  return currentProxy();
}

function extractHttpBody(rawText) {
  const headEnd = rawText.indexOf('\r\n\r\n');
  if (headEnd < 0) return { status: 0, body: '', head: '' };
  const head = rawText.slice(0, headEnd);
  const statusMatch = head.match(/^HTTP\/\S+ (\d{3})/);
  const rest = rawText.slice(headEnd + 4);
  if (/transfer-encoding:\s*chunked/i.test(head)) {
    // 按 RFC 7230 解码 chunked：逐帧读大小行 + 数据 + 尾部 CRLF（Buffer 操作，带越界保护）。
    const buf = Buffer.from(rest, 'utf8');
    const parts = [];
    let pos = 0;
    while (pos < buf.length) {
      const nl = buf.indexOf('\r\n', pos);
      if (nl < 0) break;
      const size = parseInt(buf.slice(pos, nl).toString('utf8').trim(), 16);
      // size 必须 > 0：parseInt('-5', 16) 是 -5，而 Number.isFinite(-5) 为 true、-5 !== 0，
      // 于是 end = nl + 2 - 5 比 nl 还小，pos = end + 2 往回退 —— 死循环并且 parts 无限增长。
      // 实测 --max-old-space-size=256 下 6.8 秒 FATAL OOM / exit 134，触发面是任意畸形上游响应。
      // 非正数一律当「块结束」处理（与 size === 0 的语义一致）。
      if (!Number.isFinite(size) || size <= 0) break;
      const end = nl + 2 + size;
      if (end > buf.length) { parts.push(buf.slice(nl + 2)); break; }
      parts.push(buf.slice(nl + 2, end));
      // 前进量必须为正：即使上面哪步算错，也不允许 pos 倒退（那是死循环的唯一入口）。
      const next = end + 2;
      if (next <= pos) break;
      pos = next;
    }
    return { status: statusMatch ? Number(statusMatch[1]) : 0, body: Buffer.concat(parts).toString('utf8'), head };
  }
  return { status: statusMatch ? Number(statusMatch[1]) : 0, body: rest, head };
}
/** 从 HTTP 响应头文本里取 set-cookie（合并成 name=value; 串），供 Copyseeker 等需要会话 cookie 的引擎用。 */
function meHeadersFromRaw(head) {
  const out = {};
  if (typeof head !== 'string' || head === '') return out;
  for (const line of head.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim().toLowerCase();
    if (k === 'set-cookie') {
      const pair = line.slice(idx + 1).trim().split(';')[0];
      if (pair !== '') out[k] = out[k] !== undefined ? out[k] + '; ' + pair : pair;
    }
  }
  return out;
}

// 抓取一个 http(s) 网页原文：proxy 非空时经 webSearch.proxy 的 CONNECT 隧道（https 目标包 TLS），
// 否则直连。抓取前先校验目标为公网 IP；只返回文本体，二进制/非文本由调用方按 content-type 判断。
const MAX_FETCH_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECT_HOPS = 5;

/** 单跳请求：lookup 钉死已校验地址、响应体边读边截、超时覆盖到读完。 */
function requestOnce(parsed, addresses, options, maxBytes, binary, deadline, started) {
  const left = deadline - (Date.now() - started);
  if (left <= 0) return Promise.reject(new Error('抓取超时（' + deadline + 'ms）'));
  const secure = parsed.protocol === 'https:';
  const hostBare = parsed.hostname.replace(/^\[|\]$/g, '');
  const headers = Object.assign({ 'accept-encoding': 'identity' }, options.headers === undefined || options.headers === null ? {} : options.headers);
  const payload = options.body === undefined || options.body === null
    ? null
    : (Buffer.isBuffer(options.body) ? options.body : Buffer.from(String(options.body)));
  if (payload !== null) headers['content-length'] = String(payload.length);
  const limit = Math.max(1024, Math.floor(Number(maxBytes) || MAX_FETCH_BYTES));
  const hooks = __networkHooks();
  if (hooks !== null && typeof hooks.request === 'function') {
    return Promise.resolve(hooks.request({ parsed, addresses, options, headers, payload, maxBytes: limit, binary, deadline, started, left }));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    // 绝对 deadline：requestOptions.timeout 是「socket 空闲」超时，对端每 10 秒滴一个字节
    // 就能一直不触发；慢速滴灌必须被总时长按住，否则一个访客就能长期占用连接。
    let hardTimer = null;
    const done = (fn, value) => {
      if (settled === true) return;
      settled = true;
      if (hardTimer !== null) { clearTimeout(hardTimer); hardTimer = null; }
      if (typeof abortCleanup === 'function') abortCleanup();
      fn(value);
    };
    let reqRef = null;
    let abortCleanup = null;
    // 取消：signal 触发就立刻销毁在途请求（上层「点停止」不该等满 15 秒超时）。
    const signal = options.signal;
    const onAbort = () => {
      const why = (typeof signal.reason === 'object' && signal.reason !== null && signal.reason.message !== undefined)
        ? String(signal.reason.message) : '请求已取消';
      try { if (reqRef !== null) reqRef.destroy(new Error(why)); } catch { /* 已结束 */ }
      done(reject, Object.assign(new Error(why), { name: 'AbortError' }));
    };
    if (signal !== undefined && signal !== null && typeof signal.addEventListener === 'function') {
      if (signal.aborted === true) return Promise.reject(Object.assign(new Error('请求已取消'), { name: 'AbortError' }));
      signal.addEventListener('abort', onAbort, { once: true });
      abortCleanup = () => { try { signal.removeEventListener('abort', onAbort); } catch { /* 已移除 */ } };
    }
    hardTimer = setTimeout(() => {
      const why = '抓取超时（' + deadline + 'ms）';
      try { if (reqRef !== null) reqRef.destroy(new Error(why)); } catch { /* 已结束 */ }
      done(reject, new Error(why));
    }, left);
    if (typeof hardTimer.unref === 'function') hardTimer.unref();
    const requestOptions = {
      protocol: parsed.protocol,
      hostname: hostBare,
      port: parsed.port === '' ? (secure ? 443 : 80) : Number(parsed.port),
      path: parsed.pathname + parsed.search,
      method: options.method === undefined || options.method === null ? 'GET' : options.method,
      headers,
      lookup: pinnedLookup(addresses),
      timeout: left,
    };
    // 只有域名才设 SNI：给 IP 设 servername 会触发 Node 告警，证书校验也用不上。
    if (secure === true && isIP(hostBare) === 0) requestOptions.servername = hostBare;
    const req = (secure === true ? httpsRequest : httpRequest)(requestOptions);
    reqRef = req;
    req.on('timeout', () => req.destroy(new Error('抓取超时（' + deadline + 'ms）')));
    req.on('error', (error) => done(reject, error));
    req.on('response', (res) => {
      const status = Number(res.statusCode === undefined || res.statusCode === null ? 0 : res.statusCode);
      const location = typeof res.headers.location === 'string' ? res.headers.location : '';
      const rawCookie = res.headers['set-cookie'];
      const setCookie = Array.isArray(rawCookie)
        ? rawCookie.map((item) => String(item).split(';')[0].trim()).filter((item) => item.includes('=')).join('; ')
        : '';
      const contentType = typeof res.headers['content-type'] === 'string' ? res.headers['content-type'] : '';
      const parts = [];
      let total = 0;
      let truncated = false;
      const finish = () => {
        const joined = Buffer.concat(parts, total);
        done(resolve, { status, location, setCookie, contentType, body: binary === true ? joined : joined.toString('utf8'), truncated });
      };
      if (status >= 300 && status < 400) { res.resume(); finish(); return; }
      res.on('data', (chunk) => {
        if (total >= limit) return;
        const buf = Buffer.from(chunk);
        if (total + buf.length > limit) {
          parts.push(buf.subarray(0, limit - total));
          total = limit;
          truncated = true;
          res.destroy();
          return;
        }
        parts.push(buf);
        total += buf.length;
      });
      res.on('end', finish);
      res.on('close', finish);
      res.on('error', (error) => done(reject, error));
    });
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/**
 * 只允许公网的抓取：逐跳解析并钉住地址、响应体带上限、显式 identity（防 SSRF / rebinding / 压缩炸弹）。
 * 返回 { status, body, finalUrl, truncated, setCookie, contentType }。
 */
async function publicFetch(url, options = {}) {
  const binary = options.binary === true;
  const maxBytes = Math.max(1024, Math.floor(Number(options.maxBytes) || MAX_FETCH_BYTES));
  const deadline = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 15000;
  const started = Date.now();
  let current = String(url === undefined || url === null ? '' : url);
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    let parsed;
    try { parsed = new URL(current); } catch (error) { throw new Error('抓取地址无效：' + current); }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('抓取仅支持 http:// 或 https://（得到 ' + parsed.protocol + '）');
    }
    const addresses = await resolvePublicAddresses(parsed.hostname);
    const res = await requestOnce(parsed, addresses, options, maxBytes, binary, deadline, started);
    if (res.status >= 300 && res.status < 400) {
      if (res.location === '') {
        return { status: res.status, body: binary ? Buffer.alloc(0) : '', finalUrl: parsed.href, truncated: false, setCookie: '', contentType: '' };
      }
      current = new URL(res.location, parsed.href).href;
      continue;
    }
    // 归一：binary 给 Buffer，否则给字符串。测试钩子（__setNetworkHooks）经常直接塞 Buffer，
    // 不归一的话同一个函数在两条路径上返回不同类型，调用方得两套判断。
    const rawBody = res.body === undefined || res.body === null ? Buffer.alloc(0) : res.body;
    const asBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
    return {
      status: res.status,
      body: binary ? asBuffer : asBuffer.toString('utf8'),
      finalUrl: parsed.href,
      truncated: res.truncated === true,
      setCookie: res.setCookie,
      contentType: res.contentType,
    };
  }
  throw new Error('抓取跳转次数过多（>' + MAX_REDIRECT_HOPS + '）');
}

// ---- 代理隧道（CONNECT）统一实现 ----
// 以前三段调用方各写一遍，于是漂移成三种语义：fetchUrlViaProxy 有 timer 没体积上限、
// webSearchPost 两者都没有（注释还写着「代理分支自己带定时器」）、multiEngineRequest 有 timer 没上限。
// 三处还都是「校验主机名 → 把主机名原样交给代理再解析」：校验对象和执行对象不是同一个字符串，
// TTL=0 的域名先答公网让我方校验通过、代理再解析成内网，SSRF 防护就被绕开了。
// 现在收成一处：
//   1) 目标主机先解析成公网地址，CONNECT 直接用 IP:port（TLS 的 SNI 仍用原主机名，证书校验不受影响）；
//   2) 建连与读体共用一个 deadline（对端不吐字节也不会让回合永远挂着）；
//   3) 响应体边读边截，超限只截断并标记 truncated（与直连路径 requestOnce 同语义）。
function dechunkBuffer(buf) {
  const parts = [];
  let pos = 0;
  while (pos < buf.length) {
    const lineEnd = buf.indexOf('\r\n', pos);
    if (lineEnd < 0) break;
    // 只认正数：'-24' 会被 parseInt 解成 -24，end 落在 pos 之前，pos 往回退之后同一段
    // 被反复解析——同步死循环，一条 11 字节的畸形响应就能把整个宿主卡住。
    const size = parseInt(buf.subarray(pos, lineEnd).toString('utf8').trim(), 16);
    if (!Number.isFinite(size) || size <= 0) break;
    const start = lineEnd + 2;
    const end = Math.min(start + size, buf.length);
    parts.push(buf.subarray(start, end));
    if (end >= buf.length) break;
    // 单调推进：任何异常大小都不允许让 pos 回退。
    const next = end + 2;
    if (next <= pos) break;
    pos = next;
  }
  return Buffer.concat(parts);
}

/** 从响应头文本里取单个头的值（location 等，meHeadersFromRaw 只收 set-cookie）。 */
function headerValueOf(head, name) {
  const want = String(name).toLowerCase() + ':';
  for (const line of String(head).split('\r\n')) {
    if (line.toLowerCase().startsWith(want) === true) return line.slice(want.length).trim();
  }
  return '';
}

function proxyRequest(options) {
  const opts = options === undefined || options === null ? {} : options;
  const label = typeof opts.label === 'string' ? opts.label : '抓取';
  const method = typeof opts.method === 'string' && opts.method !== '' ? opts.method : 'GET';
  const headers = opts.headers !== undefined && opts.headers !== null ? opts.headers : {};
  const deadline = Number.isFinite(opts.deadline) && opts.deadline > 0 ? opts.deadline : ME_TIMEOUT_MS;
  const maxBytes = Math.max(1024, Math.floor(Number(opts.maxBytes) || MAX_FETCH_BYTES));
  let targetUrl;
  try { targetUrl = new URL(String(opts.url)); } catch (error) { return Promise.reject(new Error(label + '地址无效：' + String(opts.url))); }
  if (targetUrl.protocol !== 'https:' && targetUrl.protocol !== 'http:') {
    return Promise.reject(new Error(label + '仅支持 http:// 或 https://（得到 ' + targetUrl.protocol + '）'));
  }
  let proxyUrl;
  try { proxyUrl = new URL(String(opts.proxy)); } catch (error) { return Promise.reject(new Error('webSearch.proxy 无效：' + String(opts.proxy))); }
  if (proxyUrl.protocol !== 'http:' && proxyUrl.protocol !== 'https:') {
    return Promise.reject(new Error('webSearch.proxy 仅支持 http:// 或 https://（得到 ' + proxyUrl.protocol + '）'));
  }
  const payload = opts.body === undefined || opts.body === null
    ? null
    : (Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(String(opts.body)));
  const targetPort = targetUrl.port !== '' ? targetUrl.port : (targetUrl.protocol === 'https:' ? '443' : '80');
  const proxyPort = proxyUrl.port !== '' ? proxyUrl.port : (proxyUrl.protocol === 'https:' ? 443 : 80);
  return resolvePublicAddresses(targetUrl.hostname).then((addresses) => new Promise((resolve, reject) => {
    const pinned = String(addresses[0].address);
    const connectTarget = (pinned.includes(':') ? '[' + pinned + ']' : pinned) + ':' + targetPort;
    let settled = false;
    let timer = null;
    let socket = null;
    let connectReq = null;
    const finish = (fn, value) => {
      if (settled === true) return;
      settled = true;
      if (timer !== null) { clearTimeout(timer); timer = null; }
      if (socket !== null) { try { socket.destroy(); } catch (error) { /* 已销毁 */ } }
      if (connectReq !== null) { try { connectReq.destroy(); } catch (error) { /* 已销毁 */ } }
      if (typeof abortCleanup === 'function') abortCleanup();
      fn(value);
    };
    // 取消（代理路径）：signal 触发直接 finish(reject)，顺手销毁隧道与 CONNECT 请求。
    const signal = opts.signal;
    let abortCleanup = null;
    const onAbort = () => {
      const why = (typeof signal.reason === 'object' && signal.reason !== null && signal.reason.message !== undefined)
        ? String(signal.reason.message) : '请求已取消';
      finish(reject, Object.assign(new Error(why), { name: 'AbortError' }));
    };
    if (signal !== undefined && signal !== null && typeof signal.addEventListener === 'function') {
      if (signal.aborted === true) { finish(reject, Object.assign(new Error('请求已取消'), { name: 'AbortError' })); return; }
      signal.addEventListener('abort', onAbort, { once: true });
      abortCleanup = () => { try { signal.removeEventListener('abort', onAbort); } catch { /* 已移除 */ } };
    }
    const proxyRequestFn = proxyUrl.protocol === 'https:' ? httpsRequest : httpRequest;
    connectReq = proxyRequestFn({
      host: proxyUrl.hostname,
      port: Number(proxyPort),
      method: 'CONNECT',
      path: connectTarget,
      headers: { Host: connectTarget, 'Proxy-Connection': 'keep-alive' },
    });
    timer = setTimeout(() => finish(reject, new Error(label + '超时（' + deadline + 'ms）')), deadline);
    connectReq.on('error', (error) => finish(reject, error));
    connectReq.on('connect', (res, sock) => {
      socket = sock;
      if (res.statusCode !== 200) { finish(reject, new Error('代理 CONNECT 失败：HTTP ' + res.statusCode)); return; }
      const send = (stream) => {
        stream.on('error', (error) => finish(reject, error));
        const lines = [method + ' ' + targetUrl.pathname + targetUrl.search + ' HTTP/1.1', 'Host: ' + targetUrl.host];
        for (const pair of Object.entries(headers)) {
          // 手拼报文时，头名/头值里只要有一个 CR/LF 就能凭空多插一条头（甚至插进请求体区）。
          // 直连走 node:http 有内建校验，隧道这条路径必须自己挡。
          const name = String(pair[0]);
          const value = String(pair[1]);
          if (/[\r\n]/u.test(name) === true || /[\r\n]/u.test(value) === true) {
            finish(reject, new Error(label + '请求头含换行，已拒绝'));
            return;
          }
          lines.push(name + ': ' + value);
        }
        lines.push('accept-encoding: identity', 'connection: close');
        if (payload !== null) lines.push('content-length: ' + String(payload.length));
        stream.write(lines.join('\r\n') + '\r\n\r\n');
        if (payload !== null) stream.write(payload);
        const chunks = [];
        let received = 0;      // 已并入 chunks 的字节数（含响应头）
        let bodyTotal = 0;     // 其中属于 body 的字节数
        let headDone = false;  // 响应头是否已经完整落在 chunks 里
        let truncated = false;
        stream.on('data', (chunk) => {
          if (settled === true || truncated === true) return;
          const buf = Buffer.from(chunk);
          if (headDone !== true) {
            // 头部还没读完就先全收（上限只管 body）；读到头后把已收字节里属于头的部分扣掉。
            chunks.push(buf);
            received += buf.length;
            // 响应头也有上限：正常的头不会超过几十 KB。以前这里是「读到空行为止无上限」，
            // 而且每块都 Buffer.concat 整个缓冲（O(n²)），0.5MB 的头能让进程多占几十 MB。
            if (received > 64 * 1024) { finish(reject, new Error(label + '响应头过大（超过 64KB）')); return; }
            const joined = Buffer.concat(chunks);
            const sepIdx = joined.indexOf('\r\n\r\n');
            if (sepIdx >= 0) {
              headDone = true;
              bodyTotal = joined.length - (sepIdx + 4);
            }
            if (bodyTotal > maxBytes) {
              truncated = true;
              stream.destroy();
            }
            return;
          }
          if (bodyTotal + buf.length > maxBytes) {
            chunks.push(buf.subarray(0, maxBytes - bodyTotal));
            bodyTotal = maxBytes;
            truncated = true;
            stream.destroy();
            return;
          }
          chunks.push(buf);
          bodyTotal += buf.length;
        });
        const emit = () => {
          const rawBuf = Buffer.concat(chunks);
          const sepIdx = rawBuf.indexOf('\r\n\r\n');
          if (sepIdx < 0) { finish(reject, new Error(label + '响应无效（无 HTTP 状态）')); return; }
          const head = rawBuf.subarray(0, sepIdx).toString('utf8');
          const statusMatch = /^HTTP\/1\.[01] (\d{3})/.exec(head);
          if (statusMatch === null) { finish(reject, new Error(label + '响应无效（无 HTTP 状态）')); return; }
          let bodyBuf = rawBuf.subarray(sepIdx + 4);
          if (truncated === true && bodyBuf.length > maxBytes) bodyBuf = bodyBuf.subarray(0, maxBytes);
          if (/transfer-encoding:\s*chunked/i.test(head)) bodyBuf = dechunkBuffer(bodyBuf);
          finish(resolve, {
            status: Number(statusMatch[1]),
            location: headerValueOf(head, 'location'),
            headers: meHeadersFromRaw(head),
            body: bodyBuf,
            truncated,
            finalUrl: targetUrl.href,
          });
        };
        stream.on('close', emit);
      };
      if (targetUrl.protocol === 'https:') send(tlsConnect({ socket: sock, servername: targetUrl.hostname }));
      else send(sock);
    });
    connectReq.end();
  }));
}

function fetchUrlViaProxy(url, spec, legacyTimeoutMs) {
  const legacy = (spec === undefined || spec === null || typeof spec === 'string');
  const proxy = resolveProxySpec(spec, legacy);
  const opts = (legacy === true || spec === null || spec === undefined) ? {} : spec;
  const timeoutMs = legacy === true
    ? legacyTimeoutMs
    : (Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : legacyTimeoutMs);
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000;
  const started = Date.now();
  const direct = proxy === undefined || proxy === null || proxy === '';
  // 调用方的体积上限与 binary 必须透传：以前直连分支只传 timeoutMs + 固定 headers，
  // 于是 maxBytes 在「有代理」那条链路被静默丢弃 —— 不是「无上限」，而是落回 proxyRequest 的 8 MiB 默认值。
  const maxBytes = legacy === true ? undefined
    : (Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : undefined);
  const wantBinary = legacy === true ? false : opts.binary === true;
  if (direct === true) {
    // 直连：publicFetch 自己逐跳校验跳转目标、带上限与 identity、超时覆盖到读完。
    return publicFetch(url, {
      timeoutMs: deadline,
      ...(maxBytes === undefined ? {} : { maxBytes }),
      binary: wantBinary,
      headers: { 'accept': 'text/html,text/plain,application/json,*/*', 'user-agent': 'dsh-qq-bot/0.6.4' },
    }).then((res) => ({ status: res.status, text: res.body, finalUrl: res.finalUrl, truncated: res.truncated }));
  }
  // 代理：逐跳自己跟（proxyRequest 只做一跳），每一跳都重新校验并钉地址，预算共用一个 deadline。
  const hop = (current, hops) => {
    if (hops > MAX_REDIRECT_HOPS) return Promise.reject(new Error('抓取跳转次数过多（>' + MAX_REDIRECT_HOPS + '）'));
    const left = deadline - (Date.now() - started);
    if (left <= 0) return Promise.reject(new Error('抓取超时（' + deadline + 'ms）'));
    return proxyRequest({
      url: current,
      proxy,
      method: 'GET',
      headers: { 'accept': 'text/html,text/plain,application/json,*/*', 'user-agent': 'dsh-qq-bot/0.6.4' },
      deadline: left,
      label: '抓取',
      ...(maxBytes === undefined ? {} : { maxBytes }),
    }).then((res) => {
      if (res.status >= 300 && res.status < 400 && res.location !== '') {
        let next = '';
        try { next = new URL(res.location, current).href; } catch (error) { next = ''; }
        if (next !== '') return hop(next, hops + 1);
      }
      return { status: res.status, text: res.body.toString('utf8'), finalUrl: current, truncated: res.truncated === true };
    });
  };
  return hop(url, 0);
}
// 带可选代理的 POST：proxy 为空 → publicFetch 直连；非空 → 手动 CONNECT 隧道 + TLS over socket。
function webSearchPost(endpoint, headers, body, spec) {
  const legacy = (spec === undefined || spec === null || typeof spec === 'string');
  const proxy = resolveProxySpec(spec, legacy);
  if (proxy === '') {
    // 直连也要有超时：端点挂起时 otherwise 会把整条会话队列拖死。
    // 走 publicFetch：端点同样过公网校验 + 8 MB 上限 + 显式 identity（以前直接 fetch + resp.json()
    // 会把对端塞来的 gzip 炸弹整包解压进内存，对端挂起时也没有读体超时）。
    return publicFetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), timeoutMs: 60000 })
      .then((res) => {
        let parsed = null;
        try { parsed = JSON.parse(String(res.body)); } catch (error) { /* 保留 null */ }
        return { status: res.status, parsed };
      });
  }
  // 代理分支以前完全没有超时（注释还写着「代理分支自己带定时器」）：端点不吐字节，这个 Promise
  // 就永不 settle，而 runWebSearch 是在回合里被 await 的，整条会话队列跟着堵死。
  // 现在与直连同语义：公网校验 + 上限 + 超时，全在 proxyRequest 里。
  return proxyRequest({
    url: endpoint,
    proxy,
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    deadline: 60000,
    label: '搜索请求',
  }).then((res) => {
    let parsed = null;
    try { parsed = JSON.parse(res.body.toString('utf8')); } catch (error) { /* 保留 null */ }
    return { status: res.status, parsed };
  });
}
const ME_TIMEOUT_MS = 15000;
const ME_BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
function multiEngineRequest(method, url, headers, body, spec, legacyTimeoutMs, legacyBinary, legacySignal) {
  // 两种调用都认：老的位置参数 (…, proxy, timeoutMs, binary)，新的意图对象 (…, { timeoutMs, binary, useProxy })。
  const legacy = (spec === undefined || spec === null || typeof spec === 'string');
  const proxy = resolveProxySpec(spec, legacy);
  const opts = (legacy === true || spec === null || spec === undefined) ? {} : spec;
  const wantBinary = legacy === true ? legacyBinary === true : opts.binary === true;
  // 取消信号：位置参数写法的第 7 个实参，或新写法 spec.signal。用于让上层「点停止」能
  // 立刻掐断在途请求（以前只有 provider 路径能取消，内置免 Key 多引擎收不到）。
  const signal = legacy === true ? legacySignal : opts.signal;
  const timeoutMs = legacy === true ? legacyTimeoutMs : opts.timeoutMs;
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : ME_TIMEOUT_MS;
  let targetUrl;
  try { targetUrl = new URL(url); } catch (error) { return Promise.reject(new Error('搜索地址无效：' + url)); }
  if (targetUrl.protocol !== 'https:' && targetUrl.protocol !== 'http:') {
    return Promise.reject(new Error('仅支持 http(s) 搜索地址（得到 ' + targetUrl.protocol + '）'));
  }
  if (proxy === '') {
    // 直连与代理必须同一道公网校验：以前只有代理分支校验，直连分支可被拿来打内网。
    return assertPublicHost(targetUrl.hostname)
      .then(() => publicFetch(url, { method, headers, body, timeoutMs: deadline, binary: wantBinary, signal }))
      .then((res) => {
        const out = {};
        if (typeof res.setCookie === 'string' && res.setCookie !== '') out['set-cookie'] = res.setCookie;
        return { status: res.status, body: res.body, headers: out };
      });
  }
  // 代理路径也走 proxyRequest：公网校验（解析即钉死）、同一套超时与体积上限。
  return proxyRequest({
    url,
    proxy,
    method,
    headers,
    body,
    deadline,
    maxBytes: MAX_FETCH_BYTES,
    label: '搜索请求',
    signal,
  }).then((res) => {
    const out = {};
    if (typeof res.headers['set-cookie'] === 'string' && res.headers['set-cookie'] !== '') out['set-cookie'] = res.headers['set-cookie'];
    return { status: res.status, body: wantBinary ? res.body : res.body.toString('utf8'), headers: out };
  });
}

// ---- HTML 实体解码与文本清理（Yandex 命中词是 <b> 逐字包住中文，剥标签必须用空串） ----
function meDecodeEntities(text) {
  return text
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x27;|&#39;/g, "'").replace(/&#x2F;/g, '/')
    .replace(/&nbsp;/g, ' ').replace(/&ensp;/g, ' ').replace(/&emsp;/g, ' ')
    .replace(/&#0*39;/g, "'").replace(/&#0*183;/g, '·')
    .replace(/&#0*8212;/g, '—').replace(/&#0*8230;/g, '…')
    .replace(/&hellip;/g, '…').replace(/&mdash;/g, '—').replace(/&middot;/g, '·')
    .replace(/&#x201[0-9a-f];/gi, ' ');
}
function meCleanText(text) {
  return meDecodeEntities(String(text).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim());
}
function meStripCdata(text) {
  return String(text).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

// —— 模块导出（http 传输层，供 websearch.js / imgsearch.js 使用）
export { proxyRequest, multiEngineRequest, extractHttpBody, meHeadersFromRaw, isNonPublicIp, canonicalHost, resolvePublicAddresses, pinnedLookup, __setNetworkHooks, assertPublicHost, publicFetch, MAX_FETCH_BYTES, fetchUrlViaProxy, webSearchPost, meDecodeEntities, meCleanText, meStripCdata, ME_BROWSER_UA };
