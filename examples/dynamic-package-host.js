/* ===========================================================================
 * DSH QQ Bot bridge — HOST half (the exact `code.host` body of the Package).
 *
 * Runs in the dynamic-package sandbox: plain JavaScript, no require / import /
 * fetch / timers. Every capability comes from the services declared in inject:
 *
 *   subprocess -> supervises the OneBot 11 adapter (onebot-adapter.mjs)
 *   sessionController -> one composed DSH Agent+Session per QQ conversation
 *   timer      -> patience notice + adapter restart backoff
 *
 *   QQ -> NapCat/AstrBot -OneBot11-> adapter -stdio JSON-> THIS PLUGIN
 *      -> agent.followup(msg) -> agent.whenIdle() -> session.deriveMessages()
 *      -> reply text -> adapter -> OneBot HTTP API -> QQ
 * ===========================================================================*/

// ------------------------------------------------------------- configuration
// A dynamic Package carries its configuration inline: edit CONFIG and re-run.
const CONFIG = {
  adapterPath: '/home/dsh/qq-bot/lib/onebot-adapter.mjs',
  nodeFallback: '/opt/node/bin/node',   // real path resolved from PATH at start
  workspace: '/home/dsh',               // cwd handed to each QQ agent session

  // NapCat defaults: forward WebSocket 3001, HTTP API 3000.
  onebot: { wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3000', accessToken: '' },

  // Groups: answer only when @-mentioned, and only in these groups ([] = all).
  group: { enabled: true, allow: [], requireAt: true },
  // Private chats: [] = everyone.
  private: { enabled: true, allow: [] },

  commandPrefix: '',                    // e.g. '/ai'; '' accepts everything

  reply: {
    maxChars: 1200,                     // long answers split at newline boundaries
    ackAfterMs: 8000,                   // "still working" notice; 0 disables
    ackText: '正在处理，请稍候…',
    firstTurnHint: '（提示：这是一次 QQ 聊天。请用简体中文、简洁自然的口语作答；'
      + '不要输出 Markdown 表格，代码块保持简短。）',
    contextHeader: true,                // prefix "[QQ群 123 · 小明(22222)]"
  },

  perChatSession: true,                 // one DSH session per QQ chat
  agentPreset: '',                      // '' = the deployment's default preset
  logAdapterFrames: false,              // very chatty; useful while wiring NapCat
};

const ADAPTER_ARGS = (() => {
  const args = ['--ws', CONFIG.onebot.wsUrl, '--http', CONFIG.onebot.httpUrl];
  if (CONFIG.onebot.accessToken !== '') args.push('--token', CONFIG.onebot.accessToken);
  return args;
})();

return {
  name: 'qq-bot-bridge',
  inject: ['subprocess', 'sessionController', 'timer'],

  async apply(ctx) {
    const subprocess = ctx.subprocess;
    const sessionController = ctx.sessionController;
    const TAG = '[qq-bot-bridge]';

    const describe = (error) => (error === null || error === undefined) ? String(error)
      : (typeof error === 'string' ? error : (typeof error.message === 'string' ? error.message : String(error)));

    let uidCounter = 0;
    const uid = (prefix) => prefix + '-' + Date.now().toString(36) + '-'
      + (uidCounter++).toString(36) + '-' + Math.random().toString(36).slice(2, 8);

    const state = {
      connected: false, statusReason: '', restarts: 0, stopping: false,
      convos: new Map(),
      stats: { inbound: 0, accepted: 0, skipped: 0, replies: 0, chunks: 0, errors: 0 },
    };

    // Resolve `node` up front: the subprocess provider runs with a scrubbed PATH.
    let nodePath = CONFIG.nodeFallback;
    try { nodePath = await subprocess.resolveExecutable('node'); }
    catch (error) { console.error(TAG + ' could not resolve "node"; using ' + nodePath); }

    // ------------------------------------------------------------ adapter link
    let handle = null;
    let stdoutBuffer = '';
    const stdoutDecoder = new TextDecoder();
    const stderrDecoder = new TextDecoder();

    function writeToAdapter(frame) {
      if (handle === null || handle === undefined) return false;
      const sink = handle.stdin;
      if (sink === null || sink === undefined || typeof sink.write !== 'function') return false;
      try { sink.write(JSON.stringify(frame) + '\n'); return true; }
      catch (error) {
        state.stats.errors += 1;
        console.error(TAG + ' adapter stdin write failed: ' + describe(error));
        return false;
      }
    }

    function scheduleRestart() {
      if (state.stopping) return;
      state.restarts += 1;
      const delay = Math.min(1000 * Math.pow(2, Math.min(state.restarts, 5)), 30000);
      console.error(TAG + ' restarting adapter in ' + delay + 'ms');
      try { ctx.timeout(() => { spawnAdapter(); }, delay); }
      catch (error) { console.error(TAG + ' could not schedule restart: ' + describe(error)); }
    }

    function spawnAdapter() {
      if (state.stopping) return;
      let proc;
      try {
        proc = subprocess.spawn({
          argv: [nodePath, CONFIG.adapterPath].concat(ADAPTER_ARGS),
          cwd: CONFIG.workspace,
          stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
          graceMs: 3000,
        });
      } catch (error) {
        state.stats.errors += 1;
        console.error(TAG + ' could not spawn the OneBot adapter: ' + describe(error));
        scheduleRestart();
        return;
      }
      handle = proc;
      stdoutBuffer = '';
      console.log(TAG + ' adapter started (' + nodePath + ' ' + CONFIG.adapterPath + ')');

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
            catch (error) { console.error(TAG + ' adapter emitted non-JSON output: ' + line.slice(0, 240)); continue; }
            try { onAdapterFrame(frame); }
            catch (error) { state.stats.errors += 1; console.error(TAG + ' frame handler failed: ' + describe(error)); }
          }
        });
      } else {
        console.error(TAG + ' adapter stdout unavailable; cannot receive QQ messages');
      }

      if (proc.stderr !== null && proc.stderr !== undefined) {
        proc.stderr.on('data', (chunk) => {
          const text = stderrDecoder.decode(chunk, { stream: true }).trim();
          if (text !== '') console.error(TAG + '/adapter ' + text);
        });
      }

      const onSettled = (label) => {
        if (handle === proc) handle = null;
        state.connected = false;
        state.statusReason = label;
        console.error(TAG + ' adapter exited (' + label + ')');
        scheduleRestart();
      };
      proc.done.then(
        (outcome) => onSettled('exit code ' + String(outcome === null || outcome === undefined ? '?' : outcome.exitCode)),
        (error) => onSettled('failure: ' + describe(error)),
      );
    }

    function stopAdapter() {
      if (handle === null || handle === undefined) return;
      const proc = handle;
      try { writeToAdapter({ type: 'shutdown' }); } catch (error) { /* going away */ }
      handle = null;
      state.connected = false;
      try { proc.terminate(); }
      catch (error) { console.error(TAG + ' adapter terminate failed: ' + describe(error)); }
    }

    // --------------------------------------------------------- inbound frames
    function onAdapterFrame(frame) {
      if (frame === null || typeof frame !== 'object') return;
      if (CONFIG.logAdapterFrames) console.log(TAG + ' <- ' + JSON.stringify(frame));

      if (frame.type === 'hello') {
        console.log(TAG + ' adapter ready (pid ' + String(frame.pid) + ')');
      } else if (frame.type === 'status') {
        state.connected = frame.connected === true;
        state.statusReason = typeof frame.reason === 'string' ? frame.reason : '';
        console.log(TAG + ' OneBot ' + (state.connected ? 'CONNECTED' : 'disconnected')
          + (state.statusReason === '' ? '' : ' — ' + state.statusReason));
      } else if (frame.type === 'message') {
        state.stats.inbound += 1;
        void acceptMessage(frame);
      } else if (frame.type === 'send_result') {
        if (frame.ok === true) state.stats.chunks += 1;
        else { state.stats.errors += 1; console.error(TAG + ' QQ send failed: ' + String(frame.error)); }
      } else if (frame.type === 'log') {
        console.log(TAG + '/adapter ' + String(frame.text));
      } else if (frame.type === 'error') {
        console.error(TAG + '/adapter ' + String(frame.text));
      }
    }

    const allowlistOk = (allow, id) => {
      if (!Array.isArray(allow) || allow.length === 0) return true;
      for (const entry of allow) if (String(entry) === String(id)) return true;
      return false;
    };

    /** Apply every policy gate, then queue the text for the conversation's agent. */
    async function acceptMessage(frame) {
      const isGroup = frame.message_type === 'group';
      const policy = isGroup ? CONFIG.group : CONFIG.private;
      const chatId = isGroup ? frame.group_id : frame.user_id;

      if (policy.enabled !== true) { state.stats.skipped += 1; return; }
      const selfId = frame.self_id === null || frame.self_id === undefined ? null : String(frame.self_id);
      if (selfId !== null && String(frame.user_id) === selfId) { state.stats.skipped += 1; return; }
      if (!allowlistOk(policy.allow, chatId)) { state.stats.skipped += 1; return; }

      let text = typeof frame.text === 'string' ? frame.text : '';

      if (isGroup && policy.requireAt === true) {
        const mention = selfId === null ? null : '@' + selfId;
        if (mention !== null) {
          if (!text.includes(mention)) { state.stats.skipped += 1; return; }
          text = text.split(mention).join(' ').trim();
        } else if (!text.includes('@')) { state.stats.skipped += 1; return; }
      }

      if (CONFIG.commandPrefix !== '') {
        if (!text.startsWith(CONFIG.commandPrefix)) { state.stats.skipped += 1; return; }
        text = text.slice(CONFIG.commandPrefix.length).trim();
      }

      if (text === '' && !(typeof frame.images === 'number' && frame.images > 0)) {
        state.stats.skipped += 1;
        return;
      }
      state.stats.accepted += 1;

      const scope = isGroup ? 'group-' + String(chatId) : 'private-' + String(chatId);
      const entryKey = CONFIG.perChatSession ? scope : 'shared';
      const sessionId = CONFIG.perChatSession ? 'qqbot-' + scope : 'qqbot-shared';

      let entry;
      try { entry = await getEntry(entryKey, sessionId); }
      catch (error) {
        state.stats.errors += 1;
        console.error(TAG + ' could not open a session for ' + entryKey + ': ' + describe(error));
        sendReply(frame, '（内部错误：无法创建对话会话）');
        return;
      }

      const generation = entry.generation;
      entry.queue = entry.queue
        .then(() => runTurn(entry, frame, text, generation))
        .catch((error) => {
          state.stats.errors += 1;
          console.error(TAG + ' turn failed for ' + entryKey + ': ' + describe(error));
        });
    }

    /** Create (exactly once) the agent that owns one QQ conversation. */
    function getEntry(entryKey, sessionId) {
      const existing = state.convos.get(entryKey);
      if (existing !== undefined) return existing.ready;
      const entry = { key: entryKey, sessionId, agent: null, turns: 0, generation: 0, queue: Promise.resolve(), ready: null };
      entry.ready = (async () => {
        // The supported composition path: creates or idempotently adopts the
        // Session, installs the default model route from agentDefaultModel, and
        // mounts the agent preset (persona + tools). Calling agentLoop.create
        // directly leaves the model route unset, so the first request fails.
        const request = { sessionId, cwd: CONFIG.workspace };
        if (CONFIG.agentPreset !== '') request.agentPreset = CONFIG.agentPreset;
        await sessionController.create(request);
        const resolved = await sessionController.resolveAgent(sessionId);
        if (resolved === null || resolved === undefined || resolved.error !== undefined) {
          const detail = (resolved !== null && resolved !== undefined && resolved.error)
            ? (resolved.error.message ? resolved.error.message : String(resolved.error.code))
            : 'resolveAgent returned no agent';
          throw new Error(detail);
        }
        entry.agent = resolved.agent;
        console.log(TAG + ' session ' + sessionId + ' is live for ' + entryKey);
        return entry;
      })().catch((error) => { state.convos.delete(entryKey); throw error; });
      state.convos.set(entryKey, entry);
      return entry.ready;
    }

    function buildPrompt(frame, text) {
      const sender = frame.sender;
      const who = (sender !== null && sender !== undefined)
        ? (sender.card ? String(sender.card) : (sender.nickname ? String(sender.nickname) : '未知用户'))
        : '未知用户';
      const body = text === '' ? '（发来了一张图片）' : text;
      if (CONFIG.reply.contextHeader !== true) return body;
      const where = frame.message_type === 'group' ? 'QQ群 ' + String(frame.group_id) : 'QQ私聊';
      return '[' + where + ' · ' + who + '(' + String(frame.user_id) + ')] ' + body;
    }

    async function runTurn(entry, frame, text, generation) {
      if (entry.generation !== generation) return;   // superseded by an interrupt
      entry.turns += 1;

      const body = buildPrompt(frame, text);
      const userText = entry.turns === 1 && CONFIG.reply.firstTurnHint !== ''
        ? body + '\n\n' + CONFIG.reply.firstTurnHint
        : body;

      // An ordinary identified user message; the agent loop snapshots and freezes
      // it when it appends the durable `user/message` event.
      const message = {
        id: uid('qqmsg'),
        role: 'user',
        content: [{ type: 'text', text: userText }],
        source: { kind: 'user' },
      };

      let acked = false;
      let cancelAck = null;
      if (CONFIG.reply.ackAfterMs > 0 && CONFIG.reply.ackText !== '') {
        try {
          cancelAck = ctx.timeout(() => { acked = true; sendReply(frame, CONFIG.reply.ackText); }, CONFIG.reply.ackAfterMs);
        } catch (error) { /* timer unavailable: skip the notice */ }
      }

      try {
        entry.agent.followup(message);
        await entry.agent.whenIdle();
      } finally {
        if (typeof cancelAck === 'function') cancelAck();
      }

      const reply = extractReply(entry.agent);
      if (reply === '') {
        if (!acked) sendReply(frame, '（本轮没有产生文字回复：' + lastTurnReason(entry.agent) + '）');
        return;
      }
      sendReply(frame, reply);
      state.stats.replies += 1;
    }

    /** Newest assistant text in the conversation's durable log. */
    function extractReply(agent) {
      const session = (agent === null || agent === undefined) ? null : agent.session;
      if (session === null || session === undefined || typeof session.deriveMessages !== 'function') return '';
      const messages = session.deriveMessages();
      if (!Array.isArray(messages)) return '';
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message === null || typeof message !== 'object' || message.role !== 'assistant') continue;
        if (!Array.isArray(message.content)) continue;
        let text = '';
        for (const block of message.content) {
          if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
            text += block.text;
          }
        }
        if (text.trim() !== '') return text.trim();
      }
      return '';
    }

    /** Diagnostic: why the newest turn closed, read from the durable log. */
    function lastTurnReason(agent) {
      try {
        const session = agent.session;
        const events = session.snapshotEvents(0, session.seq);
        for (let index = events.length - 1; index >= 0; index -= 1) {
          if (events[index].type === 'turn/end') return JSON.stringify(events[index].data.reason);
        }
        return 'no turn closed (' + String(events.length) + ' events)';
      } catch (error) {
        return 'digest failed: ' + describe(error);
      }
    }

    function chunkText(text, limit) {
      const max = (typeof limit === 'number' && limit > 0) ? limit : 1200;
      if (text.length <= max) return [text];
      const chunks = [];
      let rest = text;
      while (rest.length > max) {
        let cut = rest.lastIndexOf('\n', max);
        if (cut <= 0) cut = max;
        chunks.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).replace(/^\n+/, '');
      }
      if (rest.trim() !== '') chunks.push(rest.trim());
      return chunks;
    }

    function sendReply(frame, text) {
      const target = frame.message_type === 'group' ? frame.group_id : frame.user_id;
      if (target === null || target === undefined) return;
      for (const chunk of chunkText(String(text), CONFIG.reply.maxChars)) {
        writeToAdapter({
          type: 'send',
          message_type: frame.message_type === 'group' ? 'group' : 'private',
          target_id: String(target),
          text: chunk,
        });
      }
    }

    // ------------------------------------------------------ dynamic model tool
    try {
      const tool = harness.defineTool({
        name: 'qqbot',
        description: 'Inspect or drive the local QQ Bot bridge (OneBot 11 transport to NapCat/AstrBot). '
          + 'action "status" reports the connection and every live QQ conversation; "send" pushes one message '
          + 'to a QQ group or user; "interrupt" cancels the in-flight turn of a conversation (or all).',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', description: 'One of: status, send, interrupt.' },
            message_type: { type: 'string', description: 'For send: "group" or "private".' },
            target_id: { type: 'string', description: 'For send: the QQ group id or user id.' },
            text: { type: 'string', description: 'For send: the exact message text.' },
            conversation: { type: 'string', description: 'For interrupt: a conversation key (group-123 / private-456) or "all".' },
          },
          required: ['action'],
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        async execute(args) {
          const action = (args !== null && args !== undefined && typeof args.action === 'string') ? args.action : '';

          if (action === 'status') {
            const conversations = [];
            for (const pair of state.convos) {
              const entry = pair[1];
              conversations.push({
                conversation: entry.key,
                sessionId: entry.sessionId,
                turns: entry.turns,
                agentStatus: entry.agent === null ? 'creating' : String(entry.agent.status),
              });
            }
            return {
              ok: true,
              connected: state.connected,
              reason: state.statusReason,
              onebot: { wsUrl: CONFIG.onebot.wsUrl, httpUrl: CONFIG.onebot.httpUrl },
              adapter: { path: CONFIG.adapterPath, restarts: state.restarts },
              policy: {
                groups: { enabled: CONFIG.group.enabled, requireAt: CONFIG.group.requireAt, allow: CONFIG.group.allow },
                private: { enabled: CONFIG.private.enabled, allow: CONFIG.private.allow },
                perChatSession: CONFIG.perChatSession,
              },
              stats: {
                inbound: state.stats.inbound, accepted: state.stats.accepted, skipped: state.stats.skipped,
                replies: state.stats.replies, chunksSent: state.stats.chunks, errors: state.stats.errors,
              },
              conversations,
            };
          }

          if (action === 'send') {
            const messageType = args.message_type === 'group' ? 'group' : 'private';
            const targetId = (args.target_id === null || args.target_id === undefined) ? '' : String(args.target_id);
            const text = typeof args.text === 'string' ? args.text : '';
            if (targetId === '' || text === '') return { ok: false, error: 'send requires both target_id and text' };
            return {
              ok: writeToAdapter({ type: 'send', message_type: messageType, target_id: targetId, text }),
              message_type: messageType, target_id: targetId, connected: state.connected,
            };
          }

          if (action === 'interrupt') {
            const wanted = (typeof args.conversation === 'string' && args.conversation !== '') ? args.conversation : 'all';
            const interrupted = [];
            for (const pair of state.convos) {
              const entry = pair[1];
              if (wanted !== 'all' && entry.key !== wanted) continue;
              entry.generation += 1;
              if (entry.agent !== null && typeof entry.agent.cancel === 'function') {
                try { entry.agent.cancel({ kind: 'user' }); }
                catch (error) { console.error(TAG + ' cancel failed for ' + entry.key + ': ' + describe(error)); }
              }
              interrupted.push(entry.key);
            }
            return { ok: true, interrupted };
          }

          return { ok: false, error: 'unknown action ' + JSON.stringify(action) + '; expected status, send, or interrupt' };
        },
      });
      ctx.effect(() => harness.registerTool(ctx, tool));
      console.log(TAG + ' registered the "qqbot" tool');
    } catch (error) {
      console.error(TAG + ' could not register the qqbot tool: ' + describe(error));
    }

    // -------------------------------------------------------------- lifecycle
    ctx.effect(() => () => {
      state.stopping = true;
      stopAdapter();
      for (const pair of state.convos) {
        const entry = pair[1];
        if (entry.agent !== null && typeof entry.agent.cancel === 'function') {
          try { entry.agent.cancel({ kind: 'disposed' }); } catch (error) { /* teardown owns it */ }
        }
      }
      console.log(TAG + ' stopped');
    });

    console.log(TAG + ' starting: OneBot ws=' + CONFIG.onebot.wsUrl + ' http=' + CONFIG.onebot.httpUrl
      + ' | groups=' + (CONFIG.group.enabled ? (CONFIG.group.requireAt ? '@mention only' : 'all') : 'off')
      + ' | private=' + (CONFIG.private.enabled ? 'on' : 'off'));
    spawnAdapter();
  },
};
