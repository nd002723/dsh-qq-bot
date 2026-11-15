/** 单元测试：lib/shared/http.js + lib/valve/network/policy.js —— IP 公网判定 / HTTP 响应体解析 / 实体解码净化 / set-cookie 合并 */
import http from 'node:http';
import { isNonPublicIp, canonicalHost, extractHttpBody, meHeadersFromRaw, meDecodeEntities, meCleanText, meStripCdata, proxyRequest, fetchUrlViaProxy, __setNetworkHooks, MAX_FETCH_BYTES } from '../lib/shared/http.js';

const results = [];
let failures = 0;
const checkSync = (name, ok, detail = '') => {
  results.push(Boolean(ok));
  if (ok) console.log('  [PASS] ' + name);
  else { failures += 1; console.log('  [FAIL] ' + name + (detail ? ' — ' + detail : '')); }
};
// 代理隧道用例要真起一个本地 CONNECT 代理，所以 check 得能等 Promise。
const check = async (name, value, detail = '') => {
  let ok = value;
  let why = detail;
  if (typeof value === 'function') {
    try { ok = await value(); } catch (error) { ok = false; why = detail !== '' ? detail : String(error && error.message ? error.message : error); }
  }
  checkSync(name, ok, why);
};

console.log('1. isNonPublicIp：公网/私网/IPv6/边界判定（防 SSRF 第一道闸）');
await check('公网 IPv4 放行', isNonPublicIp('8.8.8.8') === false && isNonPublicIp('1.1.1.1') === false);
await check('公网边缘 223.x 放行 / 224+ 组播拒绝', isNonPublicIp('223.255.255.255') === false && isNonPublicIp('224.0.0.1') === true);
await check('10/8 与 172.16-31/12 拒绝', isNonPublicIp('10.0.0.1') === true && isNonPublicIp('172.16.0.1') === true && isNonPublicIp('172.31.255.255') === true && isNonPublicIp('172.32.0.1') === false);
await check('192.168/16 与 169.254 链路本地与 127 回环拒绝', isNonPublicIp('192.168.1.1') === true && isNonPublicIp('169.254.1.1') === true && isNonPublicIp('127.0.0.1') === true);
await check('100.64/10 CGN 拒绝', isNonPublicIp('100.64.0.1') === true && isNonPublicIp('100.127.255.255') === true && isNonPublicIp('100.128.0.1') === false);
await check('IPv6 回环/未指定/ULA/链路本地拒绝', isNonPublicIp('::1') === true && isNonPublicIp('::') === true && isNonPublicIp('fc00::1') === true && isNonPublicIp('fe80::1') === true);
await check('IPv4 映射的 IPv6 递归判定', isNonPublicIp('::ffff:8.8.8.8') === false && isNonPublicIp('::ffff:192.168.1.1') === true);
await check('非字符串/空串视为不可信', isNonPublicIp('') === true && isNonPublicIp(null) === true && isNonPublicIp(undefined) === true);

// F1（验收复测发现）：判定必须建立在「URL 解析器归一后的写法」上。
// 只认某一种写法 = 留下一条换写法就能过的旁路：WHATWG URL 会把 [::ffff:127.0.0.1] 写成 [::ffff:7f00:1]。
await check('IPv4 映射按十六进制组写也被拒', ['::ffff:7f00:1', '::ffff:a00:1', '::ffff:c0a8:101', '::ffff:a9fe:a9fe'].every((ip) => isNonPublicIp(ip) === true));
await check('IPv4-translated（::ffff:0:0/96）与 NAT64 内嵌 IPv4 被拒', isNonPublicIp('::ffff:0:7f00:1') === true && isNonPublicIp('64:ff9b::7f00:1') === true && isNonPublicIp('::7f00:1') === true);
await check('IPv4 非常规写法（八进制/十六进制/短写/整数）归一后仍拒绝', ['0177.0.0.1', '0x7f.0.0.1', '127.1', '2130706433', '0177.0.0.1'].every((ip) => isNonPublicIp(ip) === true));
await check('公网不会因归一而被误伤', ['::ffff:5db8:d822', '2001:db8::1', '93.184.216.34', '0x59000000' /* 89.0.0.0 */].every((ip) => isNonPublicIp(ip) === false));
await check('canonicalHost 归一结果与 URL 一致', canonicalHost('0177.0.0.1') === '127.0.0.1'
  && canonicalHost('[::ffff:127.0.0.1]') === '[::ffff:7f00:1]'
  && canonicalHost('2130706433') === '127.0.0.1'
  && canonicalHost('example.com') === 'example.com'
  && canonicalHost('a/../b') === '');
await check('域名不会被当成字面量放行', isNonPublicIp('example.com') === true && isNonPublicIp('localhost') === true);

console.log('2. extractHttpBody：普通/chunked/截断/无头');
await check('普通响应解析出状态码与正文', (() => { const r = extractHttpBody('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\nHello'); return r.status === 200 && r.body === 'Hello' && r.head.includes('200 OK'); })());
await check('chunked 按 RFC 7230 解码', (() => { const r = extractHttpBody('HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n5\r\nHello\r\n6\r\n World\r\n0\r\n\r\n'); return r.status === 200 && r.body === 'Hello World'; })());
await check('chunked 数据被截断时保留已解析部分（带越界保护）', (() => { const r = extractHttpBody('HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n5\r\nHello\r\nA\r\n12345'); return r.status === 200 && r.body.startsWith('Hello'); })());
await check('无头部分隔符返回空', (() => { const r = extractHttpBody('no-header-here'); return r.status === 0 && r.body === ''; })());
await check('负数 chunk-size 不死循环（RFC 里非法，攻击者可控）', (() => {
  // parseInt('-5', 16) === -5：Number.isFinite 为 true、!== 0，旧代码会让 pos 倒退，
  // 于是 while 永不结束、parts 无限增长（实测 256MB 堆下 6.8 秒 FATAL OOM）。
  const r = extractHttpBody('HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n-5\r\nXXXX\r\n0\r\n\r\n');
  return r.status === 200 && r.body === '';
})(), 500);

console.log('3. meHeadersFromRaw：set-cookie 合并');
await check('同名 set-cookie 合并为一条', (() => { const h = meHeadersFromRaw('Set-Cookie: a=1; Path=/\nSet-Cookie: b=2\nContent-Type: text/plain'); return h['set-cookie'] === 'a=1; b=2'; })());
await check('空/非字符串输入返回空对象', (() => { const h = meHeadersFromRaw(''); return Object.keys(h).length === 0; })());

console.log('4. 实体解码与文本净化');
await check('HTML 实体解码', meDecodeEntities('&amp;lt;&amp;gt;') === '<>' && meDecodeEntities('&#39;quoted&#x2F;') === '\'quoted/' && meDecodeEntities('a&nbsp;b&mdash;c&hellip;') === 'a b—c…');
await check('meCleanText 去标签并压缩空白', meCleanText('<p>  hello <b>world</b>  </p>') === 'hello world');
await check('meStripCdata 剥 CDATA 包裹', meStripCdata('x<![CDATA[inner]]>y') === 'xinnery');

console.log('5. 代理隧道（CONNECT）：钉地址 / 体积上限 / 超时 / 跳转（#13 #22）');

let proxySeen = [];

// 起一个最小 CONNECT 代理：记录 CONNECT 的 path（这是我们唯一能观察到「到底连了谁」的位置），
// 然后自己扮演源站，按 handler 的指示回一个假响应。
async function withProxy(handler, fn) {
  const server = http.createServer((req, res) => { res.writeHead(400); res.end(); });
  const sockets = new Set();
  server.on('connect', (req, clientSocket) => {
    proxySeen.push(String(req.url));
    sockets.add(clientSocket);
    clientSocket.on('close', () => sockets.delete(clientSocket));
    clientSocket.on('error', () => { /* 用例会主动断开 */ });
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    handler(clientSocket);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  try {
    return await fn('http://127.0.0.1:' + String(addr.port));
  } finally {
    // 升级过的 CONNECT 连接不归 http server 管，close() 会一直等它；先自己收干净。
    for (const socket of sockets) { try { socket.destroy(); } catch (error) { /* 已关闭 */ } }
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

// 源站桩：读完请求行就回固定响应
function respondWith(raw) {
  return (socket) => {
    socket.on('data', () => { socket.write(raw); socket.end(); });
  };
}

await check('CONNECT 目标是校验过的 IP，不是主机名（DNS 重绑定拿不到第二次解析机会）', async () => {
  proxySeen = [];
  __setNetworkHooks({ lookup: async (host) => (host === 'example.com' ? [{ address: '93.184.216.34', family: 4 }] : []) });
  try {
    const res = await withProxy(respondWith('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok'), (proxy) => proxyRequest({
      url: 'http://example.com/page', proxy, method: 'GET', deadline: 4000, label: '抓取',
    }));
    if (proxySeen[0] !== '93.184.216.34:80') return 'CONNECT 目标 = ' + String(proxySeen[0]);
    return res.status === 200 && res.body.toString('utf8') === 'ok';
  } finally { __setNetworkHooks(null); }
});

await check('响应体超过 maxBytes 时截断并标记 truncated（不整包读进内存）', async () => {
  proxySeen = [];
  __setNetworkHooks({ lookup: async () => [{ address: '93.184.216.34', family: 4 }] });
  try {
    const big = Buffer.alloc(8192, 65);
    const res = await withProxy(respondWith('HTTP/1.1 200 OK\r\ncontent-length: ' + String(big.length) + '\r\n\r\n' + big.toString('utf8')), (proxy) => proxyRequest({
      url: 'http://example.com/big', proxy, method: 'GET', deadline: 4000, maxBytes: 4096, label: '抓取',
    }));
    return res.truncated === true && res.body.length === 4096;
  } finally { __setNetworkHooks(null); }
});

await check('对端接受 CONNECT 后不吐字节 → 到 deadline 就 reject（不再永久挂住回合）', async () => {
  proxySeen = [];
  __setNetworkHooks({ lookup: async () => [{ address: '93.184.216.34', family: 4 }] });
  const started = Date.now();
  try {
    const threw = await withProxy(() => { /* 故意不回任何字节 */ }, (proxy) => proxyRequest({
      url: 'http://example.com/hang', proxy, method: 'GET', deadline: 600, label: '搜索请求',
    }).then(() => '没超时').catch((error) => String(error.message)));
    const elapsed = Date.now() - started;
    return threw.includes('超时') && elapsed < 5000;
  } finally { __setNetworkHooks(null); }
});

await check('代理分支也拦非公网目标（打不到 127.0.0.1 与 169.254.169.254）', async () => {
  proxySeen = [];
  __setNetworkHooks(null);
  return withProxy(respondWith('HTTP/1.1 200 OK\r\n\r\nleak'), async (proxy) => {
    const messages = [];
    for (const url of ['http://127.0.0.1/admin', 'http://169.254.169.254/latest/meta-data']) {
      messages.push(await proxyRequest({ url, proxy, method: 'GET', deadline: 2000, label: '抓取' })
        .then(() => '放行了').catch((error) => String(error.message)));
    }
    return messages.every((m) => m.includes('非公网')) && proxySeen.length === 0;
  });
});

await check('代理分支跟 302：每一跳重新校验并钉地址，finalUrl 是最后一跳', async () => {
  proxySeen = [];
  __setNetworkHooks({
    lookup: async (host) => (host === 'a.example' ? [{ address: '93.184.216.34', family: 4 }]
      : host === 'b.example' ? [{ address: '93.184.216.35', family: 4 }] : []),
  });
  try {
    let hop = 0;
    const res = await withProxy((socket) => {
      hop += 1;
      const n = hop;
      socket.on('data', () => {
        if (n === 1) {
          socket.write('HTTP/1.1 302 Found\r\nlocation: http://b.example/ok\r\ncontent-length: 0\r\n\r\n');
        } else {
          socket.write('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok');
        }
        socket.end();
      });
    }, (proxy) => fetchUrlViaProxy('http://a.example/start', proxy, 4000));
    const targetsOk = proxySeen[0] === '93.184.216.34:80' && proxySeen[1] === '93.184.216.35:80';
    return targetsOk && res.status === 200 && res.text === 'ok' && res.finalUrl === 'http://b.example/ok';
  } finally { __setNetworkHooks(null); }
});

await check('代理分支跟上来的跳转目标若是内网 → 拒绝（不跟裸跳转）', async () => {
  proxySeen = [];
  __setNetworkHooks({ lookup: async (host) => (host === 'a.example' ? [{ address: '93.184.216.34', family: 4 }] : []) });
  try {
    const message = await withProxy((socket) => {
      socket.on('data', () => {
        socket.write('HTTP/1.1 302 Found\r\nlocation: http://127.0.0.1/secret\r\ncontent-length: 0\r\n\r\n');
        socket.end();
      });
    }, (proxy) => fetchUrlViaProxy('http://a.example/start', proxy, 4000)
      .then(() => '跳转被跟随了').catch((error) => String(error.message)));
    return message.includes('非公网') && proxySeen.length === 1;
  } finally { __setNetworkHooks(null); }
});

console.log('6. 体积上限常量');
await check('MAX_FETCH_BYTES 是 8 MB（三段路径共用这一条）', MAX_FETCH_BYTES === 8 * 1024 * 1024);

const passed = results.filter(Boolean).length;
console.log('\n' + passed + '/' + results.length + ' 项通过');
if (failures > 0) { console.log('HTTP 自测失败'); process.exit(1); }
console.log('HTTP 自测通过');
process.exit(0);
