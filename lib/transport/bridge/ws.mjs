/**
 * 协议适配器共用的 WebSocket 传输层（零依赖，手写 RFC 6455）。
 *
 * 之所以自己写：插件与适配器都以单文件脚本分发，不能引入 ws 依赖。
 * 本模块只负责「管道」——握手、帧编解码、断线重连、反向服务端、
 * 链路集合与状态广播；具体协议语义（消息/事件/动作）由各协议适配器实现。
 */
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function acceptKey(key) {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}

/** 服务端 -> 客户端的未掩码帧 */
export function encodeFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

export const encodeTextFrame = (text) => encodeFrame(0x1, Buffer.from(text, 'utf8'));

/** 解析缓冲区里所有完整帧（客户端帧必须掩码） */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_FRAGMENTS = 64;

function isLoopbackHost(host) {
  const h = String(host === undefined || host === null ? '' : host).toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
}

/**
 * 反向 WS 的监听地址。
 * 没配 access_token 时默认只监听回环：否则任何能连上端口的人都能发帧冒充任意 QQ 号（身份完全来自帧）。
 * 要公网监听，必须显式配 token 或显式允许（allowPublic）。
 */
export function resolveListenAddress(listen, allowPublic) {
  const text = String(listen === undefined || listen === null ? '' : listen).trim();
  const parts = text.includes(':') ? text.split(':') : ['0.0.0.0', text];
  const host = String(parts[0] === '' ? '0.0.0.0' : parts[0]);
  const port = parts[1];
  if (allowPublic === true || isLoopbackHost(host)) return { host, port, forcedLoopback: false };
  return { host: '127.0.0.1', port, forcedLoopback: true };
}

/** 恒定时间比较 token（长度不等直接 false，不泄露前缀）。 */
export function tokenEquals(expected, actual) {
  const a = Buffer.from(String(expected === undefined || expected === null ? '' : expected), 'utf8');
  const b = Buffer.from(String(actual === undefined || actual === null ? '' : actual), 'utf8');
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
export function decodeFrames(buffer) {
  const messages = [];
  let offset = 0;
  let fragments = null;
  let fragmentBytes = 0;   // 分片累计字节（不止片数），超 MAX_FRAME_BYTES 立即判超限
  let fragmentOpcode = 0;
  for (;;) {
    if (buffer.length - offset < 2) break;
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (buffer.length - cursor < 2) break;
      length = buffer.readUInt16BE(cursor); cursor += 2;
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break;
      length = Number(buffer.readBigUInt64BE(cursor)); cursor += 8;
    }
    let maskKey = null;
    if (masked) {
      if (buffer.length - cursor < 4) break;
      maskKey = buffer.subarray(cursor, cursor + 4); cursor += 4;
    }
    if (length > MAX_FRAME_BYTES) return { messages, rest: buffer.subarray(offset), oversize: true };
    if (buffer.length - cursor < length) break;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (maskKey !== null) for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
    cursor += length;
    offset = cursor;
    if (opcode === 0x8) { messages.push({ type: 'close' }); continue; }
    if (opcode === 0x9) { messages.push({ type: 'ping', payload }); continue; }
    if (opcode === 0xa) continue;
    if (opcode === 0x0) {
      if (fragments !== null) {
        if (fragments.length >= MAX_FRAGMENTS) return { messages, rest: buffer.subarray(offset), oversize: true };
        // 以前只在 join 处判总量：先允许攒 63 片、每片最多 8 MB，等于给对端 500 MB 的额度。
        fragmentBytes += payload.length;
        if (fragmentBytes > MAX_FRAME_BYTES) return { messages, rest: buffer.subarray(offset), oversize: true };
        fragments.push(payload);
      }
      if (fin && fragments !== null) {
        const joined = Buffer.concat(fragments);
        if (joined.length > MAX_FRAME_BYTES) return { messages, rest: buffer.subarray(offset), oversize: true };
        messages.push({ type: fragmentOpcode === 0x1 ? 'text' : 'binary', payload: joined });
        fragments = null;
        fragmentBytes = 0;
      }
      continue;
    }
    if (fin) messages.push({ type: opcode === 0x1 ? 'text' : 'binary', payload });
    else { fragments = [payload]; fragmentBytes = payload.length; fragmentOpcode = opcode; }
  }
  return { messages, rest: buffer.subarray(offset) };
}

/**
 * 链路集合：正向/反向连接都归一成 { label, ready, send(text), close() }。
 * @param {object} [options]
 * @param {(info: Record<string, any>) => void} [options.onStatus] 连接数/原因变化时回调（适配器决定怎么上报）
 */
export function createLinkSet(options = {}) {
  const links = new Set();
  const onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {};
  return {
    size: () => links.size,
    active() {
      for (const link of links) if (link.ready) return link;
      return null;
    },
    add(link) { links.add(link); onStatus({ event: 'add', label: link.label, size: links.size }); },
    remove(link) {
      if (!links.delete(link)) return;
      onStatus({ event: 'remove', label: link.label, size: links.size });
    },
    closeAll() { for (const link of links) link.close(); links.clear(); },
  };
}

/**
 * 正向 WS 客户端：断线指数退避重连。
 * token 通过 ?access_token= 传入（WHATWG WebSocket 无法自定义请求头）。
 */
export function connectForward(options) {
  const {
    url, token = '', linkSet, onText,
    onOpen = () => {}, onClose = () => {}, onError = () => {},
    maxRetryMs = 30000, connectTimeoutMs = 10000,
  } = options;
  let retry = 1000;
  let shuttingDown = false;
  let link = null;
  let retryTimer = null;

  function clearRetry() {
    if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
  }

  function scheduleRetry(reason) {
    if (shuttingDown) return;
    clearRetry();
    const delay = retry;
    retry = Math.min(retry * 2, maxRetryMs);
    onError({ phase: 'retry', delayMs: delay, reason });
    // 这条定时器**不能 unref**：重连是适配器存在的意义，unref 后事件循环可能只剩 epoll 干等。
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, delay);
  }

  function connect() {
    if (shuttingDown) return;
    clearRetry();
    const target = token === ''
      ? url
      : url + (url.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(token);
    let socket;
    try {
      socket = new WebSocket(target);
    } catch (error) {
      onError({ phase: 'create', error });
      scheduleRetry('create');
      return;
    }

    let opened = false;
    let terminated = false;
    let timeout = null;

    const current = {
      label: 'forward ' + url,
      ready: false,
      send(text) {
        if (socket.readyState !== 1) return false;
        try { socket.send(text); return true; } catch { return false; }
      },
      close() { try { socket.close(); } catch { /* ignore */ } },
      // 供 reconnect() 主动收口：不等对端回 close 帧，直接走 terminate 重连。
      terminate: (reason) => terminate(reason, null),
    };

    const terminate = (reason, code) => {
      if (terminated) return;
      terminated = true;
      if (timeout !== null) { clearTimeout(timeout); timeout = null; }
      current.ready = false;
      if (link === current) link = null;
      // 只有 open 之后才 add 过；没 add 时 remove 是 no-op。
      linkSet.remove(current);
      try { socket.close(); } catch { /* 已经断开 */ }
      onClose({ link: current, code: code === undefined ? null : code, reason });
      if (!shuttingDown) scheduleRetry(reason);
    };

    // 握手超时：TCP 通了但 101 不回时，WHATWG WebSocket 可以一直挂着不报错。
    timeout = setTimeout(() => terminate('timeout', null), connectTimeoutMs);
    if (timeout.unref) timeout.unref();

    link = current;
    socket.addEventListener('open', () => {
      if (terminated) return;
      opened = true;
      if (timeout !== null) { clearTimeout(timeout); timeout = null; }
      current.ready = true;
      retry = 1000;
      // 握手完成前不算链路：以前在构造后就 add，会出现「已连接」的假状态。
      linkSet.add(current);
      onOpen({ link: current });
    });
    socket.addEventListener('message', (event) => {
      onText(current, typeof event.data === 'string' ? event.data : String(event.data));
    });
    socket.addEventListener('error', (event) => {
      onError({ phase: 'socket', event, reason: opened ? 'socket-error' : 'connect-error' });
      // 有的实现握手失败只发 error、不发 close；不在这里收口就永远等不到重连。
      if (!terminated) terminate(opened ? 'socket-error' : 'connect-error', null);
    });
    socket.addEventListener('close', (event) => {
      terminate('closed', event && event.code !== undefined ? event.code : null);
    });
  }

  connect();
  return {
    close() {
      shuttingDown = true;
      clearRetry();
      if (link !== null) link.close();
    },
    /** 主动重连：有链路就关掉交给 close→retry，没链路立即重连。 */
    reconnect() {
      if (shuttingDown) return;
      clearRetry();
      retry = 1000;
      const current = link;
      if (current !== null && typeof current.terminate === 'function') {
        // 对端可能不回 close 帧（或已经半死），所以不依赖 close 事件，直接收口后立刻重连。
        current.terminate('reconnect');
        clearRetry();
        connect();
      } else {
        connect();
      }
    },
  };
}

/**
 * 反向 WS 服务端：等对端连进来。目前只有 OneBot 11 / OneBot 12 适配器用它（--listen）；
 * Satori 只走正向，Milky 的 --listen 是 HTTP WebHook，都不经过这里。
 * @param {object} options
 * @param {string} options.listen 'host:port' 或 'port'
 * @param {string} [options.path] 只接受该路径（空 = 任意路径）
 * @param {(req: import('node:http').IncomingMessage, url: URL) => boolean} [options.authorize]
 * @param {(link, text) => void} options.onText
 * @param {(link) => void} [options.onReady] 握手完成回调（可在这里发 protocol hello）
 * @param {(link) => void} [options.onClose] 反向链路断开回调（适配器据此摘掉死链路）
 * @param {boolean} [options.allowPublic] 允许监听非回环地址（未配 token 时默认强制 127.0.0.1）
 * @param {number} [options.maxLinks] 并发反向连接上限
 * @param {(info) => void} [options.onListening]
 * @param {(message: string) => void} [options.onError]
 */
export function startReverseServer(options) {
  const { listen, path = '', authorize, allowPublic = false, maxLinks = 4, onText, onReady = () => {}, onClose = () => {}, onListening = () => {}, onError = () => {} } = options;
  const addr = resolveListenAddress(listen, allowPublic);
  const host = addr.host;
  const port = Number(addr.port);
  if (!Number.isFinite(port)) { onError('--listen 端口无效：' + listen); return null; }
  if (addr.forcedLoopback === true) {
    onError('反向 WS 未配置 access_token：已强制只监听 127.0.0.1（要公网监听请先配置 token）');
  }

  const clients = new Set();
  const server = http.createServer((_req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('需要 WebSocket 升级');
  });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') { socket.destroy(); return; }
    const url = new URL(req.url ?? '/', 'http://' + (host === '0.0.0.0' ? '127.0.0.1' : host));
    if (path !== '' && url.pathname !== path) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (typeof authorize === 'function' && authorize(req, url) !== true) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // 先判并发上限再写 101：以前先 101 再 503，客户端已经以为握手成功，协议上不干净。
    if (clients.size >= Math.max(1, Number(maxLinks) || 4)) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
      + 'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n',
    );
    // upgrade 事件给的 socket 在 Node 类型里是 Duplex，实际是 net.Socket（有 setNoDelay）。
    /** @type {import('node:net').Socket} */ (socket).setNoDelay(true);
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
    // 半开连接必须主动收：upgrade 得到的 socket 是 allowHalfOpen，对端只发 FIN 时只有 'end' 没有 'close'，
    // 于是 clients 里的名额永远不释放——4 次半关就能把 4 条并发名额占满，正常客户端此后全拿 503。
    socket.on('end', () => { try { socket.destroy(); } catch { /* ignore */ } });

    const link = {
      label: 'reverse ' + String(req.socket.remoteAddress) + ':' + String(req.socket.remotePort),
      ready: true,
      // 返回 write 的真实结果：对端已断时 write 会返回 false，调用方据此换链路（以前恒 return true，静默丢消息）。
      send(text) { try { return socket.write(encodeTextFrame(text)) !== false; } catch { return false; } },
      close() { try { socket.destroy(); } catch { /* ignore */ } },
      request: req,
      url,
    };
    let buffer = Buffer.alloc(0);
    const teardown = () => { try { socket.destroy(); } catch { /* ignore */ } };
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_BUFFER_BYTES) {
        onError('反向 WS 单连接缓冲超过 ' + MAX_BUFFER_BYTES + ' 字节，已断开');
        socket.destroy();
        return;
      }
      const decoded = decodeFrames(buffer);
      if (decoded.oversize === true) {
        onError('反向 WS 收到超限的帧，已断开');
        socket.destroy();
        return;
      }
      buffer = decoded.rest;
      for (const message of decoded.messages) {
        if (message.type === 'close') { socket.end(); continue; }
        if (message.type === 'ping') { try { socket.write(encodeFrame(0xa, message.payload)); } catch { /* ignore */ } continue; }
        if (message.type === 'text') onText(link, message.payload.toString('utf8'));
      }
    });
    socket.on('close', () => {
      // 反向链路以前是只加不摘：NapCat 重连后 links 里留着已销毁的旧链路，active() 又按插入序取第一条，
      // 于是所有发送都打进死 socket（每条卡满 15s 超时）。这里必须置 ready=false 并让适配器摘掉它。
      link.ready = false;
      try { onClose(link); } catch (error) { /* 回调出错不影响清理 */ }
      teardown();
    });
    socket.on('error', teardown);
    onReady(link);
  });

  server.on('error', (error) => onError('反向 WS 服务启动失败：' + String(error && error.message ? error.message : error)));
  server.listen(port, host, () => {
    const bound = server.address();
    const actualPort = bound !== null && typeof bound === 'object' ? bound.port : port;
    onListening({ host, port: actualPort });
  });
  return server;
}

/** 反向连接的鉴权（OneBot 语义：Authorization: Bearer <token> 或 ?access_token=）。 */
export function bearerOrQueryToken(token) {
  return (req, url) => {
    if (!token) return true;
    const header = String(req.headers.authorization ?? '');
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (tokenEquals(token, bearer) === true) return true;
    return tokenEquals(token, url.searchParams.get('access_token') ?? '') === true;
  };
}