/**
 * 适配器与插件之间的 stdio 契约（换行分隔 JSON）。
 *
 * 出（适配器 -> 插件）：hello / status / message / notice / request / heartbeat /
 *                       listening / send_result / action_result / log / error / pong
 * 入（插件 -> 适配器）：send / action / stream / ping / shutdown
 *                      （stream 只有官方 v2 私聊实现，见 CONTRACT.md）
 *
 * 所有协议适配器都实现同一套帧，插件侧（lib/index.js）因此与协议无关。
 */
import process from 'node:process';

export function createEmitter() {
  const emit = (frame) => {
    try { process.stdout.write(JSON.stringify(frame) + '\n'); } catch { /* 父进程没了 */ }
  };
  return {
    emit,
    log: (text, level = 'info') => emit({ type: 'log', level, text: String(text) }),
    fail: (text) => emit({ type: 'error', text: String(text) }),
  };
}

const sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); if (t.unref) t.unref(); });

/**
 * 串行发送队列：协议侧只提供 send(action, params) -> Promise<result>，
 * 队列负责节流与 send_result 回报。
 * @param {object} options
 * @param {number} options.gapMs 两次发送之间的最小间隔
 * @param {(action: string, params: Record<string, any>) => Promise<Record<string, any>>} options.send
 * @param {(frame: Record<string, any>) => void} options.emit
 */
export function createSendQueue({ gapMs = 350, send, emit }) {
  const queue = [];
  let running = false;
  let lastAt = 0;

  async function pump() {
    running = true;
    try {
      while (queue.length > 0) {
        const job = queue.shift();
        const wait = gapMs - (Date.now() - lastAt);
        if (wait > 0) await sleep(wait);
        let result;
        try {
          result = await send(job.action, job.params);
        } catch (error) {
          result = { ok: false, error: String(error && error.message ? error.message : error) };
        }
        lastAt = Date.now();
        emit({
          type: 'send_result',
          ok: result.ok === true,
          echo: job.echo ?? null,
          message_id: result.messageId ?? null,
          error: result.ok === true ? null : (result.error ?? '未知错误'),
          retcode: result.retcode ?? null,
        });
      }
    } finally {
      running = false;
    }
  }

  return {
    enqueue(job) {
      queue.push(job);
      if (!running) void pump();
    },
  };
}

/**
 * 读 stdin 的命令循环。
 * @param {object} options
 * @param {(command: Record<string, any>) => void} options.onCommand 每条命令（send/action 由适配器处理）
 * @param {(code: number) => void} options.onShutdown
 * @param {(text: string) => void} options.onError
 * @param {() => void} options.onPing 收到 ping 命令（无参调用，参数从未传入）
 */
export function installStdin({ onCommand, onShutdown, onError, onPing }) {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line === '') continue;
      let command;
      try { command = JSON.parse(line); }
      catch { onError('JSON 解析失败：' + line.slice(0, 200)); continue; }
      if (command !== null && typeof command === 'object') {
        if (command.type === 'ping') { onPing(); continue; }
        if (command.type === 'shutdown') { onShutdown(0); return; }
      }
      try { onCommand(command); }
      catch (error) { onError(String(error && error.stack ? error.stack : error)); }
    }
  });
  process.stdin.on('end', () => onShutdown(0));
}

/** 进程级兜底：信号、未捕获异常。 */
export function installCrashHandlers({ onShutdown, onError }) {
  process.on('SIGTERM', () => onShutdown(0));
  process.on('SIGINT', () => onShutdown(0));
  process.on('uncaughtException', (error) => onError('未捕获异常：' + (error && error.stack ? error.stack : error)));
  process.on('unhandledRejection', (reason) => {
    // Node 类型把 reason 标成 unknown；运行期它是任意被 reject 的值（可能是 Error，也可能是字符串）。
    const rejection = /** @type {any} */ (reason);
    onError('未处理的 rejection：' + (rejection && rejection.stack ? rejection.stack : rejection));
  });
}

/** 出站响应体的读取上限：与 shared/http 的 MAX_FETCH_BYTES 同量级（8 MiB）。
 *  正常 OneBot/Satori/Milky API 响应都是几百字节到几十 KB，8 MiB 足够宽松。 */
const MAX_OUTBOUND_BYTES = 8 * 1024 * 1024;

/**
 * 有界读取响应体：超过 maxBytes 就停止读取并返回已读部分。
 *
 * 为什么不能直接 response.text()：它对响应体大小零上限，协议端（或中间人）返回 2GB 就能
 * 把宿主吃死。入站方向早就有 1 MiB 上限（milky 的 readBody、qq-official），出站方向漏了。
 */
async function readBoundedText(response, maxBytes) {
  const body = response.body;
  if (body === null || body === undefined || typeof body.getReader !== 'function') {
    // 没有流式 body（某些桩/旧实现）：退回 text()，但要截断。
    const full = await response.text();
    return full.length > maxBytes ? full.slice(0, maxBytes) : full;
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done === true) break;
      if (value !== undefined && value !== null) {
        chunks.push(value);
        total += value.length;
      }
      if (total >= maxBytes) { try { await reader.cancel(); } catch { /* 已经结束 */ } break; }
    }
  } catch (error) {
    // 读一半失败：把已读部分交出去（与入站 readBody 的语义一致），不抛。
  }
  const merged = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { merged.set(chunk, at); at += chunk.length; }
  return new TextDecoder().decode(merged).slice(0, maxBytes);
}

/** 带超时的 JSON POST（OneBot/Satori/Milky 的 HTTP API 都用它）。 */
export async function postJson(url, headers, body, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (timer.unref) timer.unref();
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
      body: JSON.stringify(body === undefined ? {} : body),
      signal: controller.signal,
    });
  } finally { clearTimeout(timer); }
  // 出站响应体也要有上限：入站方向（milky readBody / qq-official）早就有 1 MiB 上限，
  // 出站方向以前直接 response.text() —— 协议端返回 2GB 就能把宿主吃死。
  // 上限取 8 MiB（与 shared/http 的 MAX_FETCH_BYTES 同量级），正常 API 响应远小于它。
  const text = await readBoundedText(response, MAX_OUTBOUND_BYTES);
  let data = null;
  if (text.length > 0) { try { data = JSON.parse(text); } catch { data = null; } }
  return { status: response.status, ok: response.ok, text, data };
}
