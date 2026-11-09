// 适配器监管：启动参数、子进程生命周期、stdin 写帧、动作请求/超时、重启退避。
// 从 gateway/plugin.js 搬出（P3 2.4 第二阶段，只搬不改）：状态仍放在插件的 state 里，
// 依赖（配置/状态/ctx/子进程/帧回调）全部注入，模块自己不留全局。
export function createAdapterSupervision(deps) {
  const { TAG, getConfig, getState, ctx, describeError, nodePath, getAdapterPath, spawn, qqMsgRoot, onFrame } = deps;
  let handle = null;
  let stdoutBuffer = '';
  const stdoutDecoder = new TextDecoder();
  const stderrDecoder = new TextDecoder();

  // ---------------------------------------------------------------- stdin 写调度
  // 管道是 FIFO：先前一次把 11MB 的图片帧整包塞进去，后面排队的动作帧（qq_history / qqgroup）
  // 要等它被适配器全部读完，于是「发完大图马上读历史」就会动作超时、被当成「没有历史」。
  // 现在把写入分成两类，**按帧调度**：
  //   - 小帧（动作 / 指令 / 文本 / ping，≤ SMALL_FRAME_LIMIT）：优先；
  //   - 大帧（图片 base64）：整帧写完再写下一帧，帧与帧之间把小帧插进去。
  // 关键约束：管道是**字节流**，适配器按行（\n）解析帧，所以一帧的字节绝不能被切开 ——
  // 曾经按 64KB 分片写、片间插小帧，结果小帧被塞进大帧 JSON 中间，整行变成非法 JSON
  // （现场症状：适配器报「JSON 解析失败：<base64 垃圾>」，发出去的大图坏掉）。
  // 因此这里只在**帧边界**插队：动作帧最多等当前这一帧写完，绝不会等整条队列。
  const SMALL_FRAME_LIMIT = 64 * 1024;
  /** 单次 write 等 drain 的上限：超时按「已进缓冲」处理，绝不把写队列永久挂住。 */
  const WRITE_STALL_MS = 8000;
  /** 待写的小帧（FIFO；恒在大帧之前）。 */
  let smallFrames = [];
  /** 待写的大帧任务：{ payload, settle? }（整帧一次写，不切片）。 */
  let bulkJobs = [];
  let pumping = false;
  /** 写调度代次：进程重启时 +1，让旧管道的泵在下一轮退出，不往新进程里续写。 */
  let writerGen = 0;

  /** 当前可写的 stdin（适配器不在就返回 null）。 */
  function stdinSink() {
    if (handle === null) return null;
    const sink = handle.stdin;
    if (sink === null || sink === undefined || typeof sink.write !== 'function') return null;
    return sink;
  }

  /** 帧序列化；失败返回 null（调用方按写失败处理）。 */
  function serializeFrame(frame) {
    try { return JSON.stringify(frame) + '\n'; } catch (error) { return null; }
  }

  /**
   * 写一片。resolve(true) = 这片已被接收（进内核缓冲也算），false = 写失败。
   * 背压时等一次 drain 再继续——这正是「大帧不整包塞管道」的关键。
   */
  function writeChunk(sink, text) {
    return new Promise((resolve) => {
      let timer = null;
      let settled = false;
      const finish = (ok) => {
        if (settled === true) return;
        settled = true;
        sink.removeListener('drain', onDrain);
        sink.removeListener('error', onError);
        if (timer !== null) clearTimeout(timer);
        resolve(ok);
      };
      const onDrain = () => finish(true);
      const onError = () => finish(false);
      let flushed;
      try {
        flushed = sink.write(text);
      } catch (error) {
        getState().stats.errors += 1;
        console.error(TAG + ' 写适配器 stdin 失败：' + describeError(error));
        resolve(false);
        return;
      }
      if (flushed !== false) { resolve(true); return; }
      console.log(TAG + ' 适配器 stdin 背压：帧已进缓冲（' + String(text.length) + ' 字节），等适配器读取');
      sink.once('drain', onDrain);
      sink.once('error', onError);
      timer = setTimeout(() => {
        console.log(TAG + ' 适配器 stdin 背压等待超时（' + String(WRITE_STALL_MS) + 'ms），帧仍在缓冲中，按已接受处理');
        finish(true);
      }, WRITE_STALL_MS);
      if (timer.unref) timer.unref();
    });
  }

  /** 清空队列（重启 / 退出 / 写失败）：大帧任务结算成 false，小帧只能丢。 */
  function drainWriter(reason) {
    const dropped = smallFrames.length;
    const jobs = bulkJobs;
    smallFrames = [];
    bulkJobs = [];
    for (const job of jobs) {
      if (typeof job.settle === 'function') {
        try { job.settle(false); } catch { /* 已结算 */ }
      }
    }
    if (dropped > 0) console.error(TAG + ' 适配器不可用，丢弃未写出的小帧 ' + String(dropped) + ' 个：' + reason);
  }

  /** 丢弃在途写入并开启新一代（进程换了，旧泵不能往新管道续写）。 */
  function resetWriter(reason) {
    writerGen += 1;
    pumping = false;
    drainWriter(reason);
  }

  /** 写调度循环：小帧永远优先；大帧一片一片写。 */
  async function pumpWriter() {
    if (pumping === true) return;
    const gen = writerGen;
    pumping = true;
    try {
      for (;;) {
        if (gen !== writerGen) return;
        const sink = stdinSink();
        if (sink === null) { drainWriter('适配器不可用'); return; }
        if (smallFrames.length > 0) {
          const ok = await writeChunk(sink, smallFrames.shift());
          if (ok !== true) { drainWriter('写入失败'); return; }
          continue;
        }
        const job = bulkJobs[0];
        if (job === undefined) return;
        // 整帧一次写完（哪怕 11MB）：切成片会把小帧的字节插进这行 JSON 里，整帧就废了
        const ok = await writeChunk(sink, job.payload);
        if (ok !== true) { drainWriter('写入失败'); return; }
        bulkJobs.shift();
        if (typeof job.settle === 'function') {
          try { job.settle(true); } catch { /* 已结算 */ }
        }
        // 回到循环顶部：这一帧写完，先看有没有小帧在等（动作帧最多等一帧）
      }
    } finally {
      if (gen === writerGen) {
        pumping = false;
        if (smallFrames.length > 0 || bulkJobs.length > 0) void pumpWriter();
      }
    }
  }

  /** 管道空闲时直接写小帧（不给动作 / 指令加任何延迟）；否则交给调度器。 */
  function idleSmallWrite(payload) {
    const sink = stdinSink();
    if (sink === null) return false;
    if (pumping === true || smallFrames.length > 0 || bulkJobs.length > 0) return null;
    try {
      const flushed = sink.write(payload);
      if (flushed === false) console.log(TAG + ' 适配器 stdin 背压：帧已进缓冲（' + String(payload.length) + ' 字节），等适配器读取');
      return true;
    } catch (error) {
      getState().stats.errors += 1;
      console.error(TAG + ' 写适配器 stdin 失败：' + describeError(error));
      return false;
    }
  }

// 主动探测：定期向适配器 stdin 发 ping，靠 pong 判断它还活着。
// 探测不到就发 reconnect 只重连链路——不杀进程（强制重启会打断正常回合）。
const PROBE_MS = 30000;
let probeTimer = null;
let lastProbeAt = 0;
let lastPongAt = 0;
let missedProbes = 0;

/** 主动探测循环：两次没 pong 就发 reconnect（不是重启）。 */
function startProbe() {
  stopProbe();
  lastPongAt = Date.now();
  lastProbeAt = 0;
  missedProbes = 0;
  probeTimer = setInterval(() => {
    if (handle === null) return;
    const now = Date.now();
    if (lastProbeAt > 0 && lastPongAt < lastProbeAt) {
      missedProbes += 1;
      console.error(TAG + ' 适配器主动探测无响应（连续 ' + String(missedProbes) + ' 次）');
    } else {
      missedProbes = 0;
    }
    if (missedProbes >= 2) {
      missedProbes = 0;
      console.error(TAG + ' 适配器连续两次无响应，发送 reconnect 指令（不重启进程）');
      writeToAdapter({ type: 'reconnect' });
    }
    lastProbeAt = now;
    writeToAdapter({ type: 'ping', echo: 'probe-' + String(now) });
  }, PROBE_MS);
  if (probeTimer.unref) probeTimer.unref();
}

function stopProbe() {
  if (probeTimer !== null) { clearInterval(probeTimer); probeTimer = null; }
}

  /**
   * 组装适配器启动参数。各协议适配器共用 --ws / --listen / --http 这组通用开关，
   * 协议特有的再追加（satori 的 --platform/--self-id、qq-official 的 --appid/--path…）。
   *
   * 凭据（access token / AppSecret / BotSecret）**只走环境变量**：argv 在 /proc/<pid>/cmdline
   * 和 ps 里对同机任何用户可见，env 才需要同用户或 root。各适配器都有同名 env 兜底
   * （argv 优先级更高，所以这里干脆不传）。
   */
  /** 密钥字段可能不存在（schema 把空串归一成 undefined）：只有「非空字符串」才当配了值。
   *  裸 `!== ''` 会把 undefined 误判成有值，进而把字符串 "undefined" 塞进适配器 env。 */
  const hasSecret = (value) => typeof value === 'string' && value !== '';

  function adapterLaunch() {
    const args = [nodePath, getAdapterPath()];
    const env = {};
    const protocol = String(getConfig().protocol ?? 'onebot11');
    if (protocol === 'onebot11' || protocol === 'onebot12') {
      const block = protocol === 'onebot11' ? getConfig().onebot : getConfig().protocols.onebot12;
      const mode = protocol === 'onebot11' ? getConfig().mode : block.mode;
      if (mode === 'reverse') args.push('--listen', String(block.listen));
      else args.push('--ws', String(block.wsUrl));
      if (block.httpUrl !== '') args.push('--http', String(block.httpUrl));
      if (hasSecret(block.accessToken) === true) env[protocol === 'onebot11' ? 'ONEBOT_ACCESS_TOKEN' : 'ONEBOT12_ACCESS_TOKEN'] = block.accessToken;
      return { argv: args, env };
    }
    if (protocol === 'satori') {
      const block = getConfig().protocols.satori;
      if (block.wsUrl !== '') args.push('--ws', String(block.wsUrl));
      if (block.httpUrl !== '') args.push('--http', String(block.httpUrl));
      if (hasSecret(block.token) === true) env.SATORI_TOKEN = block.token;
      if (block.platform !== '') args.push('--platform', String(block.platform));
      if (block.selfId !== '') args.push('--self-id', String(block.selfId));
      return { argv: args, env };
    }
    if (protocol === 'milky') {
      const block = getConfig().protocols.milky;
      if (block.wsUrl !== '') args.push('--ws', String(block.wsUrl));
      if (block.httpUrl !== '') args.push('--http', String(block.httpUrl));
      if (hasSecret(block.accessToken) === true) env.MILKY_ACCESS_TOKEN = block.accessToken;
      return { argv: args, env };
    }
    if (protocol === 'qq-official') {
      const block = getConfig().protocols.qqOfficial;
      args.push('--mode', String(block.mode));
      if (block.appId !== '') args.push('--appid', String(block.appId));
      // 两种 secret 别混：AppSecret 是取 access_token 的，BotSecret 才是回调签名（Ed25519 seed）用的。
      // 都走 env；BotSecret 缺省时适配器会回退到 AppSecret，所以只在真的配了才传。
      if (hasSecret(block.appSecret) === true) env.QQ_BOT_SECRET = block.appSecret;
      if (hasSecret(block.botSecret) === true) env.QQ_BOT_BOTSECRET = block.botSecret;
      // self_id 在 webhook 模式下没有 READY 事件可学，不传的话群聊「要 @ 才响应」会退化成
      // 「正文里有任意一个 @ 就响应」（@ 别人也算），白烧回合。
      if (typeof block.selfId === 'string' && block.selfId !== '') args.push('--self-id', String(block.selfId));
      args.push('--listen', String(block.listen));
      if (block.path !== '') args.push('--path', String(block.path));
      return { argv: args, env };
    }
    // 未知协议：按 OneBot 11 的默认参数启动，保证不至于完全起不来
    if (getConfig().mode === 'reverse') args.push('--listen', String(getConfig().onebot.listen));
    else args.push('--ws', String(getConfig().onebot.wsUrl));
    return { argv: args, env };
  }

  /**
   * 写一帧（不等待真正写出）：小帧空闲时直写，忙时插队；大帧交给调度器分片。
   * 返回值语义与旧版一致：true = 已被接受（进缓冲也算），false = 适配器不可用 / 序列化失败。
   */
  function writeToAdapter(frame) {
    const sink = stdinSink();
    if (sink === null) return false;
    const payload = serializeFrame(frame);
    if (payload === null) {
      getState().stats.errors += 1;
      console.error(TAG + ' 帧无法序列化（含循环引用？）');
      return false;
    }
    if (payload.length <= SMALL_FRAME_LIMIT) {
      const direct = idleSmallWrite(payload);
      if (direct !== null) return direct;
      smallFrames.push(payload); // 管道正忙着大帧：插到队首，下一片之前先发它
      void pumpWriter();
      return true;
    }
    bulkJobs.push({ payload, settle: null });
    void pumpWriter();
    return true;
  }

  /**
   * 大帧（图片 base64）专用：等这一帧真正写完（或超时按已接受）。
   * 小帧走同一条通道，按「已接受」立即返回——它们本来就不会把管道塞满。
   */
  function writeToAdapterAsync(frame, timeoutMs = 8000) {
    const sink = stdinSink();
    if (sink === null) return Promise.resolve(false);
    const payload = serializeFrame(frame);
    if (payload === null) return Promise.resolve(false);
    if (payload.length <= SMALL_FRAME_LIMIT) {
      const direct = idleSmallWrite(payload);
      if (direct !== null) return Promise.resolve(direct);
      smallFrames.push(payload);
      void pumpWriter();
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      let timer = null;
      let settled = false;
      const settle = (ok) => {
        if (settled === true) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        resolve(ok);
      };
      timer = setTimeout(() => {
        console.log(TAG + ' 适配器 stdin 背压等待超时（' + String(timeoutMs) + 'ms），帧仍在缓冲中，按已接受处理');
        settle(true);
      }, timeoutMs);
      if (timer.unref) timer.unref();
      bulkJobs.push({ payload, settle });
      void pumpWriter();
    });
  }

    /**
     * 通过适配器执行平台动作（OneBot 风格命名，由适配器翻译），并等待带 echo 的 action_result。
     * 群管理、查询都走这里；超时会给出明确错误而不是挂死。
     */
    function callAdapterAction(action, params, timeoutMs) {
      return new Promise((resolve) => {
        if (handle === null) { resolve({ ok: false, error: '适配器未运行' }); return; }
        const echo = 'act-' + (++getState().actionSeq) + '-' + Date.now();
        const cancel = ctx.timeout(() => {
          if (getState().pending.delete(echo)) resolve({ ok: false, error: '动作超时：' + action });
        }, (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : 12000);
        getState().pending.set(echo, (result) => {
          if (typeof cancel === 'function') cancel();
          resolve(result);
        });
        const written = writeToAdapter({ type: 'action', action, params, echo });
        if (written !== true) {
          getState().pending.delete(echo);
          if (typeof cancel === 'function') cancel();
          resolve({ ok: false, error: '无法把动作写到适配器' });
        }
      });
    }

  function scheduleRestart() {
    if (getState().stopping) return;
    if (getState().restartPending === true) return; // 已经排了一个，别叠第二个
    getState().restarts += 1;
    const delay = Math.min(getConfig().restart.baseMs * Math.pow(2, Math.min(getState().restarts, 5)), getConfig().restart.maxMs);
    console.error(TAG + ' 适配器将在 ' + delay + 'ms 后重启');
    getState().restartPending = true;
    try {
      const cancel = ctx.timeout(() => { getState().restartPending = false; getState().restartCancel = null; spawnAdapter(); }, delay);
      getState().restartCancel = typeof cancel === 'function' ? cancel : null;
    } catch (error) {
      getState().restartPending = false;
      console.error(TAG + ' 无法安排重启：' + describeError(error));
    }
  }

  function cancelRestart() {
    if (getState().restartPending !== true) return;
    getState().restartPending = false;
    const cancel = getState().restartCancel;
    getState().restartCancel = null;
    if (typeof cancel === 'function') { try { cancel(); } catch { /* 已经触发过 */ } }
  }

  function spawnAdapter() {
    if (getState().stopping) return;
    // 已有进程在跑就别再起一个：旧进程的 done 晚到时会照排重启，不挡住就是两个
    // 适配器同连一个 OneBot，入站消息被处理两遍（重复回合、重复回复）。
    if (handle !== null) return;
    // 新管道：旧代次在途的写入不能再往这里续（否则一半旧帧会插进新进程的流里）
    resetWriter('适配器启动');
    let proc;
    try {
      const launch = adapterLaunch();
      proc = spawn({
        argv: launch.argv,
        cwd: qqMsgRoot(),
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 3000,
        ...(Object.keys(launch.env).length > 0 ? { env: launch.env } : {}),
      });
    } catch (error) {
      getState().stats.errors += 1;
      console.error(TAG + ' 启动适配器失败：' + describeError(error));
      scheduleRestart();
      return;
    }
    handle = proc;
    stdoutBuffer = '';
    startProbe();
    console.log(TAG + ' 适配器已启动（' + getConfig().mode + ' 模式）');

    if (proc.stdout !== null && proc.stdout !== undefined) {
      proc.stdout.on('data', (chunk) => {
        stdoutBuffer += stdoutDecoder.decode(chunk, { stream: true });
        let index;
        while ((index = stdoutBuffer.indexOf('\n')) >= 0) {
          const line = stdoutBuffer.slice(0, index).trim();
          stdoutBuffer = stdoutBuffer.slice(index + 1);
          if (line === '') continue;
          let frame;
          try { frame = JSON.parse(line); }
          catch { console.error(TAG + ' 适配器输出了非 JSON：' + line.slice(0, 240)); continue; }
          if (frame.type === 'pong') lastPongAt = Date.now();
          try { onFrame(frame); }
          catch (error) { getState().stats.errors += 1; console.error(TAG + ' 帧处理失败：' + describeError(error)); }
        }
        // 防御性上限：正常适配器每帧都以 \n 结尾，缓冲区不会留东西。
        // 万一有实现把非行式数据写进 stdout，这条能避免宿主进程被撑到 OOM。
        if (stdoutBuffer.length > 1024 * 1024) {
          console.error(TAG + ' 适配器 stdout 缓冲超过 1MB 仍无换行，丢弃该段');
          stdoutBuffer = '';
        }
      });
    } else {
      console.error(TAG + ' 适配器 stdout 不可用，收不到 QQ 消息');
    }

    if (proc.stderr !== null && proc.stderr !== undefined) {
      proc.stderr.on('data', (chunk) => {
        const text = stderrDecoder.decode(chunk, { stream: true }).trim();
        if (text !== '') console.error(TAG + '/adapter ' + text);
      });
    }

    const onSettled = (label) => {
      // 只有「当前进程」的退出才改状态或排重启：热更新时旧进程的 done 迟到，
      // 以前会把新进程刚打上的 connected/statusReason 清成「未连接」。
      if (handle !== proc) {
        console.error(TAG + ' 旧适配器已退出（' + label + '）');
        return;
      }
      handle = null;
      stopProbe();
      resetWriter('适配器已退出（' + label + '）');
      getState().connected = false;
      getState().statusReason = label;
      console.error(TAG + ' 适配器已退出（' + label + '）');
      // 在途动作等不到 action_result 了：立刻结算成失败，否则 qq_history/qqgroup 要干等 12 秒动作超时。
      for (const [echo, settle] of getState().pending) {
        try { settle({ ok: false, error: '适配器已退出（' + label + '）' }); } catch { /* 已结算 */ }
        getState().pending.delete(echo);
      }
      scheduleRestart();
    };
    proc.done.then(
      (outcome) => onSettled('退出码 ' + String(outcome === null || outcome === undefined ? '?' : outcome.exitCode)),
      (error) => onSettled('失败：' + describeError(error)),
    );
  }

  /** 停掉当前适配器；返回的 promise 在进程真的退出（或 graceMs 到期被强杀）后落地。 */
  function stopAdapter() {
    cancelRestart();
    stopProbe();
    if (handle === null) return Promise.resolve();
    const proc = handle;
    // shutdown 帧绕过写调度直接写：紧接着就要 handle=null，排队的话可能被丢弃
    try {
      const payload = serializeFrame({ type: 'shutdown' });
      if (payload !== null && proc.stdin !== null && proc.stdin !== undefined && typeof proc.stdin.write === 'function') {
        proc.stdin.write(payload);
      }
    } catch { /* 正在退出 */ }
    handle = null;
    resetWriter('适配器已停止');
    getState().connected = false;
    try {
      // terminate() 的 promise 最多等 graceMs；宿主要的是「旧进程已经不在」，
      // 否则热更新会在 250ms 后拉起第二个适配器（双连接 → 重复回合，
      // 反向模式还会 EADDRINUSE 卡成永久离线）。
      return Promise.resolve(proc.terminate()).then(() => undefined, () => undefined);
    } catch (error) {
      console.error(TAG + ' 终止适配器失败：' + describeError(error));
      return Promise.resolve();
    }
  }

  return { adapterLaunch, writeToAdapter, writeToAdapterAsync, callAdapterAction, scheduleRestart, cancelRestart, spawnAdapter, stopAdapter };
}
