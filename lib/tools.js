// 业务模块：6 个动态工具注册（qqbot/qqgroup/qq_websearch/qq_webfetch/qq_imgsearch/qq_history）。
// 从 lib/index.js 拆出；依赖经 createTools(deps) 注入。registerTools() 动态 import defineTool 后逐工具注册。

export function createTools(deps) {
  const { getConfig, state, ctx, callAdapterAction, describeError, toId, entryForAgent, resolveAuthority, hasPerm, describeAuthority, groupInScope, permissionList, runWebSearch, fetchUrlViaProxy, meFindMoli, meMoliFetchText, runImageSearch, uploadToHost, imgSearchSoutubotFile, imgSearchTraceMoeFile, meIsAllowedImageFile, downloadImage, askVision, qqMsgRootSync, currentAdapterPath } = deps;
  const TAG = '[dsh-qq-bot]';
  const cfg = () => getConfig();


  /** unix 秒 → 'HH:MM'（尽力而为，失败返回空串）。 */
  function fmtTime(unix) {
    if (typeof unix !== 'number' || !Number.isFinite(unix)) return '';
    try { return new Date(unix * 1000).toTimeString().slice(0, 5); } catch { return ''; }
  }

  /** 一条历史消息转文本（文本/图片/表情/语音/@ 摘要）。 */
  function summarizeHistoryMessage(m) {
    const segs = Array.isArray(m.message) ? m.message : null;
    if (segs !== null) {
      let text = '';
      for (const seg of segs) {
        if (seg === null || typeof seg !== 'object') continue;
        const type = String(seg.type ?? '').toLowerCase();
        const data = seg.data ?? {};
        if (type === 'text') text += String(data.text ?? '');
        else if (type === 'image') text += '[图片]';
        else if (type === 'at') text += '@' + String(data.qq ?? '') + ' ';
        else if (type === 'face') text += '[表情]';
        else if (type === 'record') text += '[语音]';
        else if (type === 'reply') text += '[回复]';
      }
      return text;
    }
    return typeof m.raw_message === 'string' ? m.raw_message : '';
  }

  async function registerTools() {
    const { defineTool } = await import('@deepseek-ai/dsh-tools');

    const tool = defineTool({
      name: 'qqbot',
      description: '查看或操作本地 QQ Bot 桥接（OneBot 11 → NapCat）。'
        + 'action="status" 查看连接状态与所有 QQ 会话；action="send" 主动发一条 QQ 消息；'
        + 'action="interrupt" 中断某个（或全部）会话正在跑的回合。',
      parameters: {
        action: { type: 'string', description: 'status | send | interrupt' },
        message_type: { type: 'string', description: 'send 用：group 或 private' },
        target_id: { type: 'string', description: 'send 用：QQ 群号或用户号' },
        text: { type: 'string', description: 'send 用：消息正文' },
        conversation: { type: 'string', description: 'interrupt 用：会话键（group-123 / private-456）或 all' },
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
            mode: cfg().mode,
            onebot: { wsUrl: cfg().onebot.wsUrl, listen: cfg().onebot.listen, httpUrl: cfg().onebot.httpUrl },
            adapter: { path: currentAdapterPath(), pid: state.adapterPid, listenPort: state.listenPort, restarts: state.restarts },
            workspace: qqMsgRootSync(),
            policy: {
              groups: { enabled: cfg().group.enabled, requireAt: cfg().group.requireAt, allow: cfg().group.allow },
              private: { enabled: cfg().private.enabled, allow: cfg().private.allow },
              perChatSession: cfg().perChatSession,
            },
            stats: {
              inbound: state.stats.inbound, accepted: state.stats.accepted, skipped: state.stats.skipped,
              replies: state.stats.replies, chunksSent: state.stats.chunks, errors: state.stats.errors, guestBlocked: state.stats.guestBlocked,
            },
            conversations,
          };
        }

        if (action === 'send') {
          const messageType = args.message_type === 'group' ? 'group' : 'private';
          const targetId = (args.target_id === null || args.target_id === undefined) ? '' : String(args.target_id);
          const text = typeof args.text === 'string' ? args.text : '';
          if (targetId === '' || text === '') return { ok: false, error: 'send 需要 target_id 和 text' };
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
              catch (error) { console.error(TAG + ' 中断 ' + entry.key + ' 失败：' + describeError(error)); }
            }
            interrupted.push(entry.key);
          }
          return { ok: true, interrupted };
        }

        return { ok: false, error: '未知 action ' + JSON.stringify(action) };
      },
    });
    ctx.effect(() => ctx.tools.register(tool));
    console.log(TAG + ' 已注册 qqbot 工具');

    // 方案 A：让 Agent 自己调群管理。授权看「本会话最近一条消息是否来自白名单」，
    // 而不是让模型自己判断，避免群里的普通成员用一句话就驱动踢人。
    const groupTool = defineTool({
      name: 'qqgroup',
      description: 'QQ 群管理／查询（OneBot 11）。action 取值：group-list | group-info | member-list | member-info | '
        + 'mute | unmute | kick | whole-ban | set-card | set-admin | rename | recall | poke。'
        + '破坏性操作要求当前会话最近一条消息来自管理员白名单（或已打开 admin.allowConsole）。',
      parameters: {
        action: { type: 'string', description: '要执行的动作，见工具描述' },
        group_id: { type: 'string', description: '群号；留空则用当前会话所在的群' },
        user_id: { type: 'string', description: '目标成员 QQ 号' },
        duration: { type: 'number', description: '禁言秒数（mute；0 = 解禁，上限 43200）' },
        text: { type: 'string', description: 'set-card 的新名片 / rename 的新群名' },
        message_id: { type: 'number', description: 'recall 的消息 id' },
        enable: { type: 'boolean', description: 'whole-ban / set-admin 的开关' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        const admin = cfg().admin;
        if (admin.enabled !== true) return { ok: false, error: '管理功能未启用（admin.enabled=false）' };
        // 与 QQ 侧指令走同一套三路鉴权：静态名单 / 动态授权 / 本群身份。
        // 「说话人」来自本会话最近一条消息，所以群里普通成员无法靠一句话驱动管理动作。
        const entry = entryForAgent(exec.agent);
        const speaker = (entry === null || entry === undefined) ? null : entry.speaker;
        if (speaker === null || speaker === undefined) {
          if (admin.allowConsole !== true) {
            return { ok: false, error: '未授权：无法确定调用者身份（非 QQ 会话）；确需从控制台调用请打开 admin.allowConsole' };
          }
        }
        const authority = (speaker === null || speaker === undefined)
          ? { tier: 'owner', owner: true, userId: 'console', groupId: null, perms: new Set(permissionList), sources: ['控制台(allowConsole)'] }
          : await resolveAuthority(speaker.userId, speaker.groupId);

        const action = typeof args.action === 'string' ? args.action : '';
        const groupId = (args.group_id === undefined || args.group_id === null || String(args.group_id) === '')
          ? (entry !== null && entry.groupId !== null ? entry.groupId : null)
          : String(args.group_id);
        const uid = (args.user_id === undefined || args.user_id === null || String(args.user_id) === '') ? null : String(args.user_id);
        const dur = Math.min(Math.max(0, Math.round(Number(args.duration === undefined ? 600 : args.duration))), 43200);
        const want = args.enable !== false;

        const TOOL_PERMISSION = {
          'group-list': 'query', 'group-info': 'query', 'member-list': 'query', 'member-info': 'query',
          mute: 'mute', unmute: 'mute', kick: 'kick', recall: 'recall',
          'whole-ban': 'settings', 'set-card': 'settings', 'set-admin': 'settings', rename: 'settings',
          poke: 'query',
        };
        const needed = TOOL_PERMISSION[action];
        if (needed !== undefined && hasPerm(authority, needed) !== true) {
          return { ok: false, error: '缺少权限：' + needed + '｜' + describeAuthority(authority) };
        }

        const plans = {
          'group-list': () => ({ action: 'get_group_list', params: {} }),
          'group-info': () => (groupId === null ? null : { action: 'get_group_info', params: { group_id: toId(groupId) } }),
          'member-list': () => (groupId === null ? null : { action: 'get_group_member_list', params: { group_id: toId(groupId) } }),
          'member-info': () => ((groupId === null || uid === null) ? null : { action: 'get_group_member_info', params: { group_id: toId(groupId), user_id: toId(uid), no_cache: true } }),
          mute: () => ((groupId === null || uid === null) ? null : { action: 'set_group_ban', params: { group_id: toId(groupId), user_id: toId(uid), duration: dur } }),
          unmute: () => ((groupId === null || uid === null) ? null : { action: 'set_group_ban', params: { group_id: toId(groupId), user_id: toId(uid), duration: 0 } }),
          kick: () => ((groupId === null || uid === null) ? null : { action: 'set_group_kick', params: { group_id: toId(groupId), user_id: toId(uid), reject_add_request: false } }),
          'whole-ban': () => (groupId === null ? null : { action: 'set_group_whole_ban', params: { group_id: toId(groupId), enable: want } }),
          'set-card': () => ((groupId === null || uid === null || typeof args.text !== 'string' || args.text === '') ? null : { action: 'set_group_card', params: { group_id: toId(groupId), user_id: toId(uid), card: args.text } }),
          'set-admin': () => ((groupId === null || uid === null) ? null : { action: 'set_group_admin', params: { group_id: toId(groupId), user_id: toId(uid), enable: want } }),
          rename: () => ((groupId === null || typeof args.text !== 'string' || args.text === '') ? null : { action: 'set_group_name', params: { group_id: toId(groupId), group_name: args.text } }),
          recall: () => ((args.message_id === undefined || args.message_id === null) ? null : { action: 'delete_msg', params: { message_id: Number(args.message_id) } }),
          poke: () => ((groupId === null || uid === null) ? null : { action: 'send_group_poke', params: { group_id: toId(groupId), user_id: toId(uid) } }),
        };
        if (!Object.prototype.hasOwnProperty.call(plans, action)) {
          return { ok: false, error: '未知 action：' + JSON.stringify(action), available: Object.keys(plans) };
        }
        const plan = plans[action]();
        if (plan === null) return { ok: false, error: '缺少必要参数（group_id / user_id / text / message_id）' };
        if (groupId !== null && !groupInScope(groupId)) return { ok: false, error: '群 ' + groupId + ' 不在可管理范围内' };
        if (admin.dryRun === true) return { ok: true, dryRun: true, wouldRun: plan };

        state.stats.admin += 1;
        const result = await callAdapterAction(plan.action, plan.params);
        return {
          ok: result.ok === true,
          action: plan.action,
          error: result.ok === true ? null : String(result.error === undefined ? '未知错误' : result.error),
          data: result.data === undefined ? null : result.data,
        };
      },
    });
    ctx.effect(() => ctx.tools.register(groupTool));
    console.log(TAG + ' 已注册 qqgroup 工具');

    // 联网搜索包装：插件进程内直接调 DeepSeek web search（不依赖 agent 侧 run_code）。
    // 访客白名单默认含 qq_websearch，所以访客也能联网查证，而 DSH 底层工具仍被闸隔离。
    const wsTool = defineTool({
      name: 'qq_websearch',
      description: '联网搜索（DeepSeek web search）：按关键词搜索网页，返回带摘录的来源列表（url/title/snippet）。'
        + '适合查证人物/物品身份、时事、专有名词等；调用前把问题提炼成简洁关键词，必要时分多次搜。'
        + '抓取指定网页请用 qq_webfetch（本工具只负责搜索）。',
      parameters: {
        query: { type: 'string', description: '搜索关键词（提炼后的短语）' },
        max_uses: { type: 'number', description: '最多搜索轮数（1-10，默认 5）' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        const query = (args !== null && args !== undefined && typeof args.query === 'string') ? args.query.trim() : '';
        if (query === '') return { ok: false, error: 'qq_websearch 需要 query 关键词' };
        const maxUses = Number(args !== null && args !== undefined ? args.max_uses : NaN);
        // 偶发的传输/解码失败重试一次，仍失败再返回错误给模型。
        let lastError = '';
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const sources = await runWebSearch(query, cfg().webSearch ?? {}, Number.isFinite(maxUses) ? maxUses : undefined, ctx);
            if (sources.length === 0) return { ok: true, count: 0, sources: [], text: '（搜索无结果）' };
            const text = sources.map((s, i) => (i + 1) + '. ' + (s.title ? s.title : s.url)
              + '\n   ' + s.url + (s.snippet ? '\n   ' + s.snippet : '')).join('\n');
            return { ok: true, count: sources.length, sources, text };
          } catch (error) {
            lastError = describeError(error);
            if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }
        return { ok: false, error: lastError };
      },
    });
    ctx.effect(() => ctx.tools.register(wsTool));
    console.log(TAG + ' 已注册 qq_websearch 工具');

    // 网页抓取（qq_webfetch）：从 qq_websearch 拆出的 url 抓取，独立工具；受 webSearch.proxy 管控；
    // moli.enabled 时改用 Moli 无头浏览器渲染抓取（需已安装 moli 引擎，否则该开关无效）。
    const webFetchTool = defineTool({
      name: 'qq_webfetch',
      description: '抓取指定网页的原文/渲染文本（http/https，仅公网；受 webSearch.proxy 管控，留空直连、非空走 http 代理）。'
        + '配置 moli.enabled 时改用 Moli 无头浏览器渲染抓取（可抓 SPA/JS 渲染页，需已安装 moli 引擎）。',
      parameters: {
        url: { type: 'string', description: '要抓取的网页地址（http/https，仅公网）' },
        max_chars: { type: 'number', description: '最多返回字符数（默认 40000）' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        const url = (args !== null && args !== undefined && typeof args.url === 'string') ? args.url.trim() : '';
        if (url === '') return { ok: false, error: 'qq_webfetch 需要 url（要抓取的网页地址）' };
        const wsCfg = (cfg().webSearch !== null && cfg().webSearch !== undefined) ? cfg().webSearch : {};
        const moliCfg = (cfg().moli !== null && cfg().moli !== undefined) ? cfg().moli : {};
        let proxy = (typeof wsCfg.proxy === 'string') ? wsCfg.proxy.trim() : '';
        let cap = 40000;
        if (args !== null && args !== undefined) {
          const n = Math.floor(Number(args.max_chars));
          if (Number.isFinite(n) && n > 0) cap = n;
        }
        if (moliCfg.enabled === true) {
          // moli.proxy 优先，留空自动透传 webSearch.proxy。
          const mProxy = (typeof moliCfg.proxy === 'string') ? moliCfg.proxy.trim() : '';
          if (mProxy !== '') proxy = mProxy;
          if (meFindMoli(moliCfg.exePath) === undefined) {
            return { ok: false, url, moliUnavailable: true, error: 'Moli 引擎未安装（未找到 moli 可执行文件）：moli 开关无法启用，请安装 dsh-moli 或把 moli 放到 ~/.local/bin/moli' };
          }
          try {
            const got = await meMoliFetchText(url, proxy, 20000, moliCfg.exePath);
            let text = String(got ?? '');
            if (text.length > cap) text = text.slice(0, cap) + '\n…（内容过长已截断）';
            if (text === '') text = '（渲染抓取到空内容）';
            return { ok: true, url, via: 'moli 渲染', text };
          } catch (error) {
            return { ok: false, url, error: 'moli 渲染抓取失败：' + describeError(error) };
          }
        }
        try {
          const got = await fetchUrlViaProxy(url, proxy, 15000);
          let text = typeof got.text === 'string' ? got.text : '';
          if (text.length > cap) text = text.slice(0, cap) + '\n…（内容过长已截断）';
          if (text === '') text = '（抓取到空响应体）';
          return { ok: got.status >= 200 && got.status < 300, url, status: got.status, via: 'http', text };
        } catch (error) {
          return { ok: false, url, error: '抓取失败：' + describeError(error) };
        }
      },
    });
    ctx.effect(() => ctx.tools.register(webFetchTool));
    console.log(TAG + ' 已注册 qq_webfetch 工具');

    // 图片反搜：全部请求走 multiEngineRequest → 与 qq_websearch 同一套 webSearch.proxy 管控。
    const imgTool = defineTool({
      name: 'qq_imgsearch',
      description: '图片反搜（Reverse Image Search）：给定公网图片 URL 或本地图片文件，返回来源列表（url/title/snippet）。'
        + '本地文件会先上传图床（zixiaoyun/scdn/uguu 加权随机）拿公网 URL 再反搜；上传失败回退文件直传 TraceMoe。'
        + '引擎：TraceMoe/IQDB（直连）+ Yandex/Tineye/Copyseeker/SauceNAO（代理）。'
        + 'kind=comic 时优先 Soutubot（搜图Bot酱，本子/漫画局部）+ SauceNAO，通用引擎兜底。'
        + '全部请求受 webSearch.proxy 管控（留空直连、非空走 http 代理）。',
      parameters: {
        url: { type: 'string', description: '公网图片 URL（http/https，仅公网地址；与 file 二选一）' },
        file: { type: 'string', description: '本地图片文件路径（限 qq-images 目录内；与 url 二选一）' },
        max_results: { type: 'number', description: '最多返回结果数（1-10，默认 5）' },
        kind: { type: 'string', description: '搜索模式：auto（默认，通用引擎排序）/ comic（漫画/本子截图，优先 Soutubot+SauceNAO）' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        const imageUrl = (args !== null && args !== undefined && typeof args.url === 'string') ? args.url.trim() : '';
        const filePath = (args !== null && args !== undefined && typeof args.file === 'string') ? args.file.trim() : '';
        if (imageUrl === '' && filePath === '') return { ok: false, error: 'qq_imgsearch 需要 url（公网图片地址）或 file（本地图片路径）' };
        const wsCfg = (cfg().webSearch !== null && cfg().webSearch !== undefined) ? cfg().webSearch : {};
        const proxy = (typeof wsCfg.proxy === 'string') ? wsCfg.proxy.trim() : '';
        const imgCfg = (cfg().imgSearch !== null && cfg().imgSearch !== undefined) ? cfg().imgSearch : {};
        if (imgCfg.enabled === false) return { ok: false, error: 'imgSearch 已关闭（设置页可开启）' };
        let cap = 5;
        if (args !== null && args !== undefined) {
          const n = Math.floor(Number(args.max_results));
          if (Number.isFinite(n)) cap = Math.max(1, Math.min(10, n));
        }
        try {
          const opts = {
            saucenaoKey: cfg().imgSearch && typeof cfg().imgSearch.saucenaoKey === 'string' ? cfg().imgSearch.saucenaoKey.trim() : '',
            weightedShuffle: cfg().imgSearch && cfg().imgSearch.weightedShuffle === true,
            kind: typeof args.kind === 'string' ? args.kind.trim() : '',
          };
          let sources;
          let via = '';
          if (opts.kind === 'comic' && imageUrl === '' && filePath !== '') {
            // 漫画模式 + 本地文件：soutubot 直接传文件（不上图床），失败/无结果回退 TraceMoe 文件直传。
            if (!meIsAllowedImageFile(filePath)) return { ok: false, error: 'file 仅允许 qq-images 目录下的图片（拒绝：' + filePath + '）' };
            try {
              sources = await imgSearchSoutubotFile(filePath, cap, proxy);
              via = 'soutubot 直传文件';
            } catch (error) {
              via = 'soutubot 直传失败（' + (error instanceof Error ? error.message : String(error)) + '），回退 TraceMoe 文件直传';
            }
            if (!Array.isArray(sources) || sources.length === 0) sources = await imgSearchTraceMoeFile(filePath, cap, proxy);
          } else if (imageUrl !== '') {
            sources = await runImageSearch(imageUrl, cap, proxy, opts);
          } else {
            if (!meIsAllowedImageFile(filePath)) return { ok: false, error: 'file 仅允许 qq-images 目录下的图片（拒绝：' + filePath + '）' };
            let uploaded = null;
            let uploadError = '';
            try { uploaded = await uploadToHost(filePath, proxy); } catch (error) { uploadError = error instanceof Error ? error.message : String(error); }
            if (uploaded !== null) {
              via = '图床(' + uploaded.host + ') ' + uploaded.url;
              sources = await runImageSearch(uploaded.url, cap, proxy, opts);
            } else {
              via = '图床上传失败，回退文件直传 TraceMoe（' + uploadError + '）';
              sources = await imgSearchTraceMoeFile(filePath, cap, proxy);
            }
          }
          if (sources.length === 0) return { ok: true, count: 0, sources: [], via, text: '（未找到匹配来源）' };
          const text = sources.map((s, i) => (i + 1) + '. ' + (s.title ? s.title : s.url)
            + '\n   ' + s.url + (s.snippet ? '\n   ' + s.snippet : '')).join('\n');
          return { ok: true, count: sources.length, sources, via, text };
        } catch (error) {
          return { ok: false, error: describeError(error) };
        }
      },
    });
    ctx.effect(() => ctx.tools.register(imgTool));
    console.log(TAG + ' 已注册 qq_imgsearch 工具');
    // 聊天记录工具（qq_history）：AI 主动拉取群聊历史与图片（替代自动硬塞上下文）。
    // 图片识别窗口锚定「最新提及」那条消息（触发本条回复的 @bot/回复bot/命令前缀），
    // 往前 scopeMessages 条内的图片才识别，最多 imageLimit 张（最近的优先）；
    // 更早的 @ 不锚定、其附近图片不因「也是被提及」而识别，避免重复拉取/重复识图。
    const historyTool = defineTool({
      name: 'qq_history',
      description: '拉取当前群聊最近消息与图片（聊天记录工具）：返回结构化消息列表，含每条消息的时间/说话人/文本，'
        + '以及锚点窗口内图片的 URL + 识别描述。群聊里被 @ 或需要结合群内近期消息/图片作答时主动调用。'
        + '识别窗口固定锚定「触发本条回复的那条消息」往前最多 scopeMessages 条，最多 imageLimit 张图（最近的优先）；'
        + '更早的 @ 不会触发图片识别。',
      parameters: {
        group_id: { type: 'string', description: '群号（留空 = 当前群）' },
        user_id: { type: 'string', description: '只拉某个用户的发言（可选）' },
        count: { type: 'number', description: '拉取消息条数（默认 20，上限 50）' },
        with_images: { type: 'boolean', description: '是否识别锚点窗口内图片（默认 true）' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        // 会话/锚点来自执行上下文（entryForAgent 从 state.convos 反查），而不是闭包自由变量。
        const entry = entryForAgent(exec !== null && exec !== undefined ? exec.agent : null);
        if (entry === null || entry === undefined) return { ok: false, error: '无法确定当前 QQ 会话（qq_history 仅在 QQ 会话内可用）' };
        const grp = entry.groupId === null || entry.groupId === undefined ? null : String(entry.groupId);
        if (grp === null && (args === null || args === undefined || typeof args.group_id !== 'string' || args.group_id.trim() === '')) {
          return { ok: false, error: 'qq_history 需要 group_id（当前会话不是群聊，请显式传群号）' };
        }
        const groupId = (args !== null && args !== undefined && typeof args.group_id === 'string' && args.group_id.trim() !== '')
          ? args.group_id.trim() : grp;
        const filterUid = (args !== null && args !== undefined && typeof args.user_id === 'string') ? args.user_id.trim() : '';
        let count = 20;
        if (args !== null && args !== undefined) {
          const n = Math.floor(Number(args.count));
          if (Number.isFinite(n)) count = Math.max(1, Math.min(50, n));
        }
        const withImages = !(args !== null && args !== undefined && args.with_images === false);
        const histCfg = (cfg().history !== null && cfg().history !== undefined) ? cfg().history : {};
        const scopeMessages = Math.max(1, Math.floor(Number.isFinite(histCfg.scopeMessages) ? histCfg.scopeMessages : 5));
        const imageLimit = Math.max(1, Math.floor(Number.isFinite(histCfg.imageLimit) ? histCfg.imageLimit : 3));
        // 1) 拉历史（新→旧）
        let rawMessages = [];
        try {
          const result = await callAdapterAction('get_group_msg_history', { group_id: Number(groupId), count }, 8000);
          if (result.ok === true && result.data !== null && result.data !== undefined && Array.isArray(result.data.messages)) {
            rawMessages = result.data.messages;
          }
        } catch (error) {
          return { ok: false, group_id: groupId, error: '拉取群历史失败：' + describeError(error) };
        }
        if (rawMessages.length === 0) return { ok: true, group_id: groupId, count: 0, messages: [], scope: { scopeMessages, imageLimit } };
        // 2) 锚点：触发本条回复的那条消息（entry.currentFrame，acceptMessage 记录）
        const anchorFrame = (entry !== null && entry !== undefined && entry.currentFrame) || null;
        const anchorId = anchorFrame && anchorFrame.message_id !== null && anchorFrame.message_id !== undefined ? Number(anchorFrame.message_id) : null;
        const anchorTime = anchorFrame && typeof anchorFrame.time === 'number' ? anchorFrame.time : null;
        let anchorIndex = 0;
        if (anchorId !== null) {
          const found = rawMessages.findIndex((m) => m !== null && typeof m === 'object' && Number(m.message_id) === anchorId);
          if (found >= 0) anchorIndex = found;
        }
        if (anchorId === null || !rawMessages.some((m) => m !== null && typeof m === 'object' && Number(m.message_id) === anchorId)) {
          // 触发消息不在历史里（如超窗/被清）：退化为按时间找最接近的一条。
          if (anchorTime !== null) {
            let best = -1, bestDiff = Infinity;
            for (let i = 0; i < rawMessages.length; i += 1) {
              const m = rawMessages[i];
              if (m === null || typeof m !== 'object') continue;
              const t = typeof m.time === 'number' ? m.time : null;
              if (t === null) continue;
              const diff = Math.abs(t - anchorTime);
              if (diff < bestDiff) { bestDiff = diff; best = i; }
            }
            if (best >= 0) anchorIndex = best;
          }
        }
        const anchorMsg = rawMessages[anchorIndex];
        // 3) 窗口：[anchorIndex, anchorIndex + scopeMessages - 1]（新→旧，往旧方向；固定锚点，更早的 @ 不会扩窗）
        const windowStart = anchorIndex;
        const windowEnd = Math.min(rawMessages.length - 1, anchorIndex + scopeMessages - 1);
        // 4) 组装 messages + 收集窗口内图片（最近的优先；对象引用共享，识别后 description 自动回填）
        const messages = [];
        const windowImages = [];
        for (let i = 0; i < rawMessages.length; i += 1) {
          const m = rawMessages[i];
          if (m === null || typeof m !== 'object') continue;
          const senderId = (m.user_id !== undefined && m.user_id !== null) ? String(m.user_id)
            : (m.sender !== null && m.sender !== undefined && m.sender.user_id !== null && m.sender.user_id !== undefined ? String(m.sender.user_id) : '');
          if (filterUid !== '' && senderId !== filterUid) continue;
          const inWindow = i >= windowStart && i <= windowEnd;
          const images = [];
          if (withImages && inWindow && Array.isArray(m.message)) {
            for (const seg of m.message) {
              if (seg === null || typeof seg !== 'object') continue;
              if (String(seg.type ?? '').toLowerCase() !== 'image') continue;
              const url = (seg.data && typeof seg.data.url === 'string') ? seg.data.url : '';
              if (url === '' || !/^https?:\/\//.test(url)) continue;
              const img = { url };
              images.push(img);
              if (windowImages.length < imageLimit) windowImages.push(img);
            }
          }
          messages.push({
            time: fmtTime(m.time),
            user_id: senderId,
            nickname: (m.sender !== null && m.sender !== undefined && typeof m.sender === 'object' && typeof m.sender.nickname === 'string') ? m.sender.nickname : '',
            text: summarizeHistoryMessage(m),
            images,
          });
        }
        // 5) 窗口内图片识别（最近的优先，最多 imageLimit 张；失败只给 URL 不阻塞）
        const vision = (cfg().vision !== null && cfg().vision !== undefined) ? cfg().vision : {};
        if (vision.enabled === true && windowImages.length > 0) {
          const provider = (typeof vision.provider === 'string' && vision.provider !== '') ? vision.provider
            : (entry && entry.agent && entry.agent.options && typeof entry.agent.options.provider === 'string' ? entry.agent.options.provider : '');
          const model = (typeof vision.model === 'string' && vision.model !== '') ? vision.model
            : (entry && entry.agent && entry.agent.options && typeof entry.agent.options.model === 'string' ? entry.agent.options.model : '');
          const attachments = ctx.attachments;
          const timeoutMs = vision.downloadTimeoutMs ?? 10000;
          if (provider !== '' && model !== '' && attachments !== undefined && attachments !== null && typeof attachments.saveImage === 'function') {
            for (let k = 0; k < windowImages.length; k += 1) {
              const img = windowImages[k];
              try {
                const downloaded = await downloadImage(img.url, timeoutMs);
                if (downloaded === null) { img.description = '（图片下载失败）'; continue; }
                const ref = await attachments.saveImage({ data: downloaded.data, mediaType: downloaded.mediaType });
                const text = await askVision(provider, model, ref, k + 1);
                img.description = text !== '' ? text : '（图片识别无返回）';
              } catch (error) {
                console.log(TAG + ' qq_history 图片识别失败（给 URL 不阻塞）：' + describeError(error));
                img.description = '（图片识别失败）';
              }
            }
          } else if (provider === '' || model === '') {
            for (const img of windowImages) img.description = '（图片视觉未配置 provider/model，仅给 URL）';
          } else {
            for (const img of windowImages) img.description = '（图片视觉附件服务不可用，仅给 URL）';
          }
        }
        return {
          ok: true,
          group_id: groupId,
          count: messages.length,
          anchor: { message_id: anchorMsg && typeof anchorMsg.message_id !== 'undefined' ? anchorMsg.message_id : null, time: anchorMsg ? fmtTime(anchorMsg.time) : '' },
          scope: { scopeMessages, imageLimit },
          messages,
        };
      },
    });
    ctx.effect(() => ctx.tools.register(historyTool));
    console.log(TAG + ' 已注册 qq_history 工具');
  }

  return { registerTools };
}
