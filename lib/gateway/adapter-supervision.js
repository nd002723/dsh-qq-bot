// 适配器监管：启动参数、子进程生命周期、stdin 写帧、动作请求/超时、重启退避。
// 从 gateway/plugin.js 搬出（P3 2.4 第二阶段，只搬不改）：状态仍放在插件的 state 里，
// 依赖（配置/状态/ctx/子进程/帧回调）全部注入，模块自己不留全局。
export function createAdapterSupervision(deps) {
  const { TAG, getConfig, getState, ctx, describeError, nodePath, getAdapterPath, spawn, qqMsgRoot, onFrame } = deps;
  let handle = null;
  let stdoutBuffer = '';
  const stdoutDecoder = new TextDecoder();
  const stderrDecoder = new TextDecoder();
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
      if (block.accessToken !== '') env[protocol === 'onebot11' ? 'ONEBOT_ACCESS_TOKEN' : 'ONEBOT12_ACCESS_TOKEN'] = String(block.accessToken);
      return { argv: args, env };
    }
    if (protocol === 'satori') {
      const block = getConfig().protocols.satori;
      if (block.wsUrl !== '') args.push('--ws', String(block.wsUrl));
      if (block.httpUrl !== '') args.push('--http', String(block.httpUrl));
      if (block.token !== '') env.SATORI_TOKEN = String(block.token);
      if (block.platform !== '') args.push('--platform', String(block.platform));
      if (block.selfId !== '') args.push('--self-id', String(block.selfId));
      return { argv: args, env };
    }
    if (protocol === 'milky') {
      const block = getConfig().protocols.milky;
      if (block.wsUrl !== '') args.push('--ws', String(block.wsUrl));
      if (block.httpUrl !== '') args.push('--http', String(block.httpUrl));
      if (block.accessToken !== '') env.MILKY_ACCESS_TOKEN = String(block.accessToken);
      return { argv: args, env };
    }
    if (protocol === 'qq-official') {
      const block = getConfig().protocols.qqOfficial;
      args.push('--mode', String(block.mode));
      if (block.appId !== '') args.push('--appid', String(block.appId));
      // 两种 secret 别混：AppSecret 是取 access_token 的，BotSecret 才是回调签名（Ed25519 seed）用的。
      // 都走 env；BotSecret 缺省时适配器会回退到 AppSecret，所以只在真的配了才传。
      if (block.appSecret !== '') env.QQ_BOT_SECRET = String(block.appSecret);
      if (block.botSecret !== '') env.QQ_BOT_BOTSECRET = String(block.botSecret);
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

  function writeToAdapter(frame) {
    if (handle === null) return false;
    const sink = handle.stdin;
    if (sink === null || sink === undefined || typeof sink.write !== 'function') return false;
    try {
      // write() 返回 false = 对端读得慢或管道已满（数据进了缓冲，但不算「已经送到」）。
      // 以前恒返回 true，proactive 会照记账、qq_draw 会报 sent:true、qqbot send 报 ok:true，
      // 适配器刚好崩溃的那几十毫秒里消息静默丢失却报告成功。
      const flushed = sink.write(JSON.stringify(frame) + '\n');
      return flushed !== false;
    } catch (error) {
      getState().stats.errors += 1;
      console.error(TAG + ' 写适配器 stdin 失败：' + describeError(error));
      return false;
    }
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
    try { writeToAdapter({ type: 'shutdown' }); } catch { /* 正在退出 */ }
    handle = null;
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

  return { adapterLaunch, writeToAdapter, callAdapterAction, scheduleRestart, cancelRestart, spawnAdapter, stopAdapter };
}
