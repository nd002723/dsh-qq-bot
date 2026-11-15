// 业务模块：会话条目与路由（getEntry/sessionRoute/entryForAgent）+ 被回复图片收集（collectReplyImageUrls）。
// 从 lib/index.js 拆出；依赖经 createSession(deps) 注入。

import { promises as fsPromises } from 'node:fs';
import { safeSessionId } from './workspace.js';
import { createHash } from 'node:crypto';

/**
 * 工作区限定的会话 id：当同名会话已绑在**别的工作区**（典型场景：0.7 时代 workspace=/root
 * 建的会话，升级后工作区变成 QQ_msg）时使用。只改新会话的 id，旧会话原样留着，向前兼容。
 */
export function scopedSessionId(sessionId, scopeKey) {
  const digest = createHash('sha1').update(String(scopeKey)).digest('hex').slice(0, 6);
  return String(sessionId) + '-ws' + digest;
}

/**
 * 会话被**真正删除**之后的接管 id（确定性派生：同一条 QQ 会话永远算出同一个）。
 *
 * 为什么需要它：删除会话时（zh_pro 的回收站语义）DSH 会把仍驻留内存的 live 会话塞进
 * 归档集合隐藏，但它已经从工作区账本里被摘掉了。插件下次拿 sessionRoute 算出的原 id
 * 去 create 时，宿主的 reusable 判定会为 false，于是 createMinted 出一个随机新 id；
 * 而插件下一条消息又会拿原 id 来要 —— 不把新 id 固定下来，就会每条消息新建一条会话。
 * 这里用「原 id + 固定 scope」派生：既避开被删掉的原 id，又保证每次幂等。
 */
export function revivedSessionId(sessionId) {
  const digest = createHash('sha1').update('revived:' + String(sessionId)).digest('hex').slice(0, 6);
  return String(sessionId) + '-r' + digest;
}

/** 会话池上限：每个条目常驻一个 agent + 若干工具遮蔽 effect，公开部署要有天花板。 */
const SESSION_POOL_MAX = 200;

export function createSession(deps) {
  const { getConfig, ctx, state, ensureQqMsgWorkspace, ensureSessionWorkspace, sessionWorkdir, callAdapterAction, describeError, isOwner, flowGate, archiveApi } = deps;
  const TAG = '[dsh-qq-bot]';
  const cfg = () => getConfig();

  /**
   * 归档召回（幂等、fail-soft）：这个 QQ 会话若被宿主归档了，先把它拉回可见。
   *
   * 为什么必须做、为什么必须在 create / followup 之前，见 session/session-archive.js
   * 头注释（宿主的 ArchivedSessionGate 会 reject 归档会话的每一步；create 的
   * reusable 判定也把归档会话排除）。开关关掉或没注入召回器时静默跳过。
   */
  async function recallArchived(sessionId) {
    const sessionCfg = cfg().session;
    if (sessionCfg !== undefined && sessionCfg !== null && sessionCfg.recallArchived === false) return;
    if (archiveApi === undefined || archiveApi === null || typeof archiveApi.recall !== 'function') return;
    try {
      await archiveApi.recall(sessionId, '触发消息');
    } catch (error) {
      // 召回器内部已是 fail-soft；这里再包一层 —— 无论发生什么都不该挡住收发。
      console.log(TAG + ' 归档召回异常（忽略）：' + describeError(error));
    }
  }

  function entryForAgent(agent) {
    if (agent === null || agent === undefined) return null;
    for (const pair of state.convos) if (pair[1].agent === agent) return pair[1];
    return null;
  }


  /**
   * 当前工作区对应的 scopeKey（与创建时算 scoped id 用的那个一致）。
   * 派生 id 是 (baseId, scopeKey) 的函数：scopeKey 一变，同一个 QQ 会话就该换一个新 id。
   */
  async function expectedScopeKey(sessionId) {
    const flowWorkspaceOn = (() => {
      try {
        const f = cfg().flowAuth;
        return f !== undefined && f !== null && f.enabled === true;
      } catch (error) { return false; }
    })();
    const ws = (flowWorkspaceOn === true && typeof ensureSessionWorkspace === 'function')
      ? await ensureSessionWorkspace(sessionId)
      : await ensureQqMsgWorkspace();
    return ws.id !== null ? ('workspace:' + String(ws.id)) : ('cwd:' + sessionWorkdir(sessionId));
  }

  function sessionRoute(frame) {
    const isGroup = frame.message_type === 'group';
    const chatId = isGroup ? frame.group_id : frame.user_id;
    const scope = (isGroup ? 'group-' : 'private-') + String(chatId);
    // 协议帧里的 id 是外部输入：统一净化后再拿去当会话 id / 目录名。
    const baseId = safeSessionId('qqbot-' + scope);
    const owner = isOwner(frame.user_id);
    const split = cfg().auth.ownerPreset !== '' || cfg().auth.guestPreset !== '';
    if (!split) {
      return { entryKey: scope, sessionId: baseId, preset: cfg().agentPreset, tier: owner ? 'owner' : 'guest' };
    }
    const tier = owner ? 'owner' : 'guest';
    return {
      entryKey: scope + '@' + tier,
      sessionId: baseId + (owner ? '' : '-guest'),
      preset: (owner ? cfg().auth.ownerPreset : cfg().auth.guestPreset) || cfg().agentPreset,
      tier,
    };
  }


  async function collectReplyImageUrls(frame) {
    if (frame.reply_to === null || frame.reply_to === undefined) return;
    try {
      const r = await callAdapterAction('get_msg', { message_id: Number(frame.reply_to) }, 8000);
      if (r.ok === true && r.data !== null && r.data !== undefined && Array.isArray(r.data.message)) {
        for (const seg of r.data.message) {
          if (seg === null || typeof seg !== 'object') continue;
          if (String(seg.type ?? '').toLowerCase() !== 'image') continue;
          const url = (seg.data && typeof seg.data.url === 'string') ? seg.data.url : '';
          if (url === '' || !/^https?:\/\//.test(url)) continue;
          if (!Array.isArray(frame.replyImageUrls)) frame.replyImageUrls = [];
          frame.replyImageUrls.push(url);
        }
      }
    } catch { /* 尽力而为 */ }
  }


  async function getEntry(entryKey, sessionId, preset, fixedTitle) {
    // —— 会话被真正删除后的接管 ——
    //
    // 删除会话的插件（dsh-session-manager 的 deleteSession）会 detachFromWorkspaces()
    // 摘掉账本槽位、unarchiveSession() 把 id 从归档集合摘掉、再 rm 掉整个会话目录，
    // 但**不会销毁内存里的 live agent**（上游 agents 服务没有卸载 API）。插件内存里的
    // entry 也还在。于是不识别出来的话，getEntry 会一直命中「已有条目」、永远不调 create，
    // 消息就被喂给一个日志目录已经被删掉的旧 agent。
    //
    // 判据只能是「条目在 + 任何工作区账本里都没有它」（单看账本还不够——从没建过的会话
    // 同样不在账本里，那种情况走正常新建，宿主的 observeSession 查不到会自动用原 id 建）。
    let existing = state.convos.get(entryKey);
    const revived = revivedSessionId(sessionId);
    // 跨工作区冲突后 entry.sessionId 会变成 scoped(baseId) 派生 id，而调用方下次传进来的
    // 仍是最初的 baseId。这类条目属于**同一个会话**，但必须先过一遍被删探测（见下）。
    const baseSessionIdOf = (item) => String(item !== undefined && item !== null && item.baseSessionId !== undefined && item.baseSessionId !== null
      ? item.baseSessionId
      : sessionId);
    const isScopedOfBase = (item) => {
      if (item === undefined || item === null) return false;
      const base = baseSessionIdOf(item);
      if (base === '' || String(item.sessionId) === base) return false;
      return String(item.sessionId).startsWith(base + '-ws');
    };
    if (existing !== undefined && existing.sessionId === revived) {
      // 之前已经因删除派生过 id：条目记着的就是判决，继续用它（派生是确定性的）。
      sessionId = revived;
    } else if (existing !== undefined
      && (existing.sessionId === sessionId || isScopedOfBase(existing))
      && archiveApi !== undefined && archiveApi !== null && typeof archiveApi.isDetached === 'function') {
      // 探测对象是**条目记着的那个 id**，不是本次入参：scoped 条目记的是派生 id，
      // 拿原始 id 去查账本会永远查不到，于是「被删了还在喂死 agent」。
      const candidate = String(existing.sessionId);
      let detached = false;
      try {
        detached = archiveApi.isDetached(candidate) === true;
      } catch (error) {
        // 探测失败按「正常会话」处理：误判重建比不重建更糟。
        console.log(TAG + ' 账本探测失败（按正常会话继续）：' + describeError(error));
      }
      if (detached === true) {
        const scoped = isScopedOfBase(existing);
        console.log(TAG + ' 会话 ' + candidate + ' 已不在工作区账本（被删除），改用 '
          + (scoped ? '原 id 重新派生' : revived) + ' 重建');
        // 丢掉旧条目；cancel 只是停当前回合，那个孤儿 agent 会留在宿主内存里直到重启
        // ——这是宿主侧的已知限制，插件这边只能做到不再引用它。
        state.convos.delete(entryKey);
        try { if (existing.agent !== null && existing.agent !== undefined && typeof existing.agent.cancel === 'function') existing.agent.cancel(); }
        catch { /* 已经结束 */ }
        existing = undefined;
        // scoped 条目：保持入参（原始 id），让下面的正常新建再走一次「冲突→派生」。
        // 这里若改成 revived(原始 id)，会把会话钉在一个不是本工作区的派生 id 上。
        if (scoped !== true) sessionId = revived;
      }
    }

    // 通过被删探测之后，scoped 条目就是这个会话本身：复用，绝不 cancel 重建。
    // 但工作区可能已经换了（换目录 / 换工作区 id），此时旧 scoped id 钉在旧工作区 ——
    // 派生是 (baseId, scopeKey) 的函数，scopeKey 变了就必须重新派生，否则产物归属会错。
    if (existing !== undefined && isScopedOfBase(existing)) {
      const recorded = (typeof existing.scopeKey === 'string') ? existing.scopeKey : '';
      if (recorded !== '') {
        let nowKey = '';
        try {
          nowKey = await expectedScopeKey(sessionId);
        } catch (error) {
          // 解析不出当前工作区就按「没变」处理：误判重建比钉在旧工作区更糟。
          console.log(TAG + ' 工作区解析失败（沿用现有 scoped 会话）：' + describeError(error));
        }
        if (nowKey !== '' && nowKey !== recorded) {
          console.log(TAG + ' 会话 ' + String(existing.sessionId) + ' 的工作区已变（' + recorded + ' → ' + nowKey + '），重新派生');
          state.convos.delete(entryKey);
          try { if (existing.agent !== null && existing.agent !== undefined && typeof existing.agent.cancel === 'function') existing.agent.cancel(); }
          catch { /* 已经结束 */ }
          existing = undefined;
        }
      }
    }
    if (existing !== undefined && isScopedOfBase(existing)) {
      existing.lastUsedAt = Date.now();
      await recallArchived(String(existing.sessionId));
      return existing.ready;
    }

    if (existing !== undefined && existing.sessionId === sessionId) {
      // 刷新活跃时间：池满时按这个字段淘汰最久未用的（见下面的 LRU 段）。
      existing.lastUsedAt = Date.now();
      // 已有条目同样要召回：agent 可能还活着，但归档判定是宿主**每次 pre-step 现读集合**，
      // 不解除的话这一回合会被直接 reject（QQ 侧表现为消息石沉大海）。
      await recallArchived(sessionId);
      return existing.ready;
    }
    // 条目绑的是别的 id（被删掉的旧 id）：丢掉它，别让消息继续喂给日志目录已不在的 agent。
    if (existing !== undefined) {
      state.convos.delete(entryKey);
      try { if (existing.agent !== null && existing.agent !== undefined && typeof existing.agent.cancel === 'function') existing.agent.cancel(); }
      catch { /* 已经结束 */ }
    }
    const entry = {
      key: entryKey, sessionId, agent: null, turns: 0, generation: 0, lastUsedAt: Date.now(),
      // 原始（未派生的）会话 id：冲突派生 / 删除接管后 entry.sessionId 会变，
      // 但要靠它判断「下次传进来的 id 是不是同一个会话的派生」，所以单独记一份。
      baseSessionId: sessionId,
      queue: Promise.resolve(), ready: null,
      // 本会话最近一条消息的说话人与身份（qqgroup 工具的鉴权依据）
      speaker: null, groupId: null,
      // 访客工具闸：注册一次，判据是这个可变标志位
      dshAllowed: false, guardUnavailable: false,
    };
    entry.ready = (async () => {
      // 归档召回放在 ready 链里（而不是 getEntry 开头）：上面 convos.get + 下面的 set
      // 必须在同一个 tick 内保持原子，否则两条并发消息会各自发现「没有条目」、
      // 各建一次会话。而召回又必须早于这里的 create —— 宿主的 reusable 判定
      // 把归档会话排除，晚一步就会另建一条会话、历史断在旧 id 上。
      await recallArchived(sessionId);
      // 官方组装路径：create 会幂等地创建/接管会话，resolveAgent 装上默认模型路由
      // 并挂载 Agent preset（人格 + 工具）。直接 agentLoop.create 不装模型路由，
      // 第一次模型请求必然失败。
      // 流程授权打开时，会话独占 QQ_msg/<sessionId>：产物投递要按会话归属文件，
      // 共用工作区根（QQ_msg）分不出哪个文件是这个会话写的——这正是上一轮的跨会话泄密来源。
      // 关着的时候仍走原来的共享分组，行为与 0.11 一致。
      const flowWorkspaceOn = (() => {
        const f = cfg().flowAuth;
        return f !== undefined && f !== null && f.enabled === true;
      })();
      const ws = (flowWorkspaceOn === true && typeof ensureSessionWorkspace === 'function')
        ? await ensureSessionWorkspace(sessionId)
        : await ensureQqMsgWorkspace();
      // 产物要按「真实工作目录」归属，不能按 sessionId 拼：工作区冲突时 entry.sessionId 会被改成
      // scoped，而工作区还挂在原来的路径上，两边一错位产物就永远扫不到。
      entry.flowWorkdir = (flowWorkspaceOn === true) ? ws.path : undefined;
      let request;
      if (ws.id !== null) {
        // 有 workspace 服务：传 workspaceId，DSH 会把会话挂到对应分组。
        request = { sessionId, workspaceId: ws.id };
      } else {
        // 回退：无 workspace 服务时用会话子目录当工作目录。
        const workdir = (ws.path !== undefined && ws.path !== null) ? ws.path : sessionWorkdir(sessionId);
        await fsPromises.mkdir(workdir, { recursive: true });
        request = { sessionId, cwd: workdir };
      }
      const effectivePreset = preset === undefined ? cfg().agentPreset : preset;
      if (effectivePreset !== '' && effectivePreset !== undefined && effectivePreset !== null) request.agentPreset = effectivePreset;
      let effectiveSessionId = sessionId;
      try {
        await ctx.sessionController.create(request);
      } catch (error) {
        const reason = describeError(error);
        if (reason.indexOf('belongs to') < 0) throw error;
        // 旧版本建的会话绑在别的工作区，DSH 不允许跨工作区复用同一个 id。
        // 不删旧会话（向前兼容），换一个工作区限定的 id 重开；旧历史原样保留。
        const scopeKey = ws.id !== null ? ('workspace:' + String(ws.id)) : ('cwd:' + sessionWorkdir(sessionId));
        const scoped = scopedSessionId(sessionId, scopeKey);
        console.log(TAG + ' 会话 ' + sessionId + ' 绑在其他工作区（' + reason + '），改用 ' + scoped + '；旧会话保留');
        entry.sessionId = scoped;
        // 记下派生时用的 scopeKey：下次进来要比较它是否变了（变则重派生）。
        entry.scopeKey = scopeKey;
        effectiveSessionId = scoped;
        await ctx.sessionController.create(Object.assign({}, request, { sessionId: scoped }));
      }
      const resolved = await ctx.sessionController.resolveAgent(effectiveSessionId);
      if (resolved === null || resolved === undefined || resolved.error !== undefined) {
        const detail = (resolved !== null && resolved !== undefined && resolved.error)
          ? (resolved.error.message ? resolved.error.message : String(resolved.error.code))
          : 'resolveAgent 没有返回 agent';
        throw new Error(detail);
      }
      entry.agent = resolved.agent;

      // 访客工具闸：只在建 agent 时注册一次。guard 是一个每次执行才求值的函数，
      // 判据放进闭包里的可变标志位 entry.dshAllowed，所以拥有者/访客交替说话时
      // 既不用增删限制，也不会造成工具面抖动（那会多记 request/header、白费 token）。
      const guestAllow = new Set(Array.isArray(cfg().auth.guestToolAllow) ? cfg().auth.guestToolAllow : []);
      try {
        // 0.2 起 Guard 也管着 agent 上下文里的 tools：直接 ctx.tools 会抛，get() 才安全；
        // 0.1.x（以及单测里的 mock ctx）只有属性形态，两种都试。
        let agentTools;
        try {
          agentTools = (typeof entry.agent.ctx.get === 'function') ? entry.agent.ctx.get('tools') : undefined;
        } catch (error) { agentTools = undefined; }
        if (agentTools === undefined || agentTools === null) {
          try { agentTools = entry.agent.ctx.tools; } catch (error) { agentTools = undefined; }
        }
        if (agentTools === undefined || agentTools === null || typeof agentTools.guard !== 'function') {
          throw new Error('agent 上下文未提供 tools 服务（DSH 0.2 起需用 ctx.get("tools") 获取）');
        }
        // 返回值是「卸下闸门」的 dispose：宿主卸载时会随 effect 一起清，这里不需要自己拿。
        agentTools.guard((exec) => {
          const toolName = (exec !== null && exec !== undefined && typeof exec.name === 'string') ? exec.name : '';
          // 流程授权闸门先于「拥有者放行」：拥有者用高危工具同样要过动态码。
          // 只在拥有者身上生效——访客本来就被下面的访客闸挡掉，不必再叠一层。
          // 只读本回合开始时固化的发言人：entry.speaker 会被后到的消息覆盖，读它等于让晚到的消息改判已有回合。
          const speaker = (entry.turnSpeaker !== undefined && entry.turnSpeaker !== null) ? entry.turnSpeaker : entry.speaker;
          const isOwnerSpeaker = speaker !== undefined && speaker !== null && speaker.owner === true;
          if (isOwnerSpeaker && flowGate !== undefined && flowGate !== null && flowGate.isGated(toolName)) {
            // 先记下「它想跑哪个工具」：随后的 qqauth 申请只能绑这个名字，
            // 用途文本（purpose）由模型自由发挥，不能作为绑定依据。
            if (typeof flowGate.noteBlocked === 'function') flowGate.noteBlocked(String(speaker.userId), toolName);
            // 授权只在「拥有者私聊」里生效：否则群里的同一个 owner 一句话就能把私聊刚发的码花掉，
            // 私聊那边续跑反而 no-grant（而且群消息本来就不该驱动编排工具）。
            if (ownerPrivateNow() !== true) {
              state.stats.flowBlocked += 1;
              console.log(TAG + ' 流程授权闸拦截：' + toolName + '（非拥有者私聊）');
              return '流程授权：这个工具只能在拥有者私聊里驱动（当前会话不允许）';
            }
            const qq = String(speaker.userId);
            const verdict = flowGate.check(qq, toolName);
            if (verdict.allow === true) {
              entry.flowArmedAt = Date.now();
              // 同名遮蔽的 wrapper 在 dispatch 之后才执行，如果它也去问一次闸门，一次调用就要两个码。
              // 这里记一笔「这次调用已经付过码」，wrapper 只认这笔账。
              if (entry.flowAllow === undefined || entry.flowAllow === null) entry.flowAllow = {};
              entry.flowAllow[toolName] = (Number(entry.flowAllow[toolName]) || 0) + 1;
              console.log(TAG + ' 流程授权通过：' + toolName + '（' + String(verdict.purpose || '') + '）');
              return undefined;
            }
            state.stats.flowBlocked += 1;
            console.log(TAG + ' 流程授权闸拦截：' + toolName + '（' + verdict.reason + '）');
            return flowGate.blockedText(verdict.reason);
          }
          if (entry.dshAllowed === true) return undefined;
          if (guestAllow.has(toolName)) return undefined;

          state.stats.guestBlocked += 1;
          console.log(TAG + ' 访客工具闸拦截：' + toolName);
          return '访客模式：不允许使用 DSH 内部工具 ' + toolName;
        });
      } catch (error) {
        entry.guardUnavailable = true;
        console.error(TAG + ' 无法安装访客工具闸，将拒绝驱动非拥有者：' + describeError(error));
      }

      // 高危编排工具：DSH 的全局注册在我们这些会话里由插件接管（同名遮蔽）。
      // 遮蔽在建会话时装一次，但闸门判据**每次执行时现读配置**：
      //   - 开关关着 → 直接交给原始工具（行为与 0.11 完全一致，群里/共享会话的拥有者照旧能用）；
      //   - 开关打开 + 拥有者私聊 → 要一次性动态码；
      //   - 开关打开 + 其它会话 → 拒绝（工具还在表里，但调用拿到的是可读的中文拒绝）。
      // 以前「开关只在建会话时算一次」，热切换会留半状态：开→关后群会话的工具仍被摘掉，
      // 关→开时老会话没有遮蔽、守卫又装不上就完全裸奔。现在两个方向都对称。
      const flowOnNow = () => {
        const f = cfg().flowAuth;
        return f !== undefined && f !== null && f.enabled === true;
      };
      const ownerPrivateNow = () => {
        // 判据必须用回合快照：perChatSession=false 时 entryKey 恒为 'shared'，解析 entryKey
        // 会让「拥有者私聊」永远为假（该配置下所有受闸工具都放不了行）。与 tools.js 的
        // ownerPrivateGate 同一口径：快照里 groupId 为空 = 私聊，owner 标记来自同一份配置。
        const speaker = (entry.turnSpeaker !== undefined && entry.turnSpeaker !== null) ? entry.turnSpeaker : entry.speaker;
        if (speaker === undefined || speaker === null) return false;
        if (speaker.owner !== true) return false;
        return speaker.groupId === null || speaker.groupId === undefined;
      };
      // 工具服务要在 try 外面声明：catch 里（遮蔽整体失败时）还要用它做兜底摘除。
      let toolsService; // eslint-disable-line prefer-const
      // 这四只是历史默认值，真正的名单以 flowAuth.gatedTools 为准（用户在设置页能改）；
      // 并集是为了「关掉开关时不重新接管、打开时立刻生效」——运行时再看 isGated。
      const FLOW_TOOL_FALLBACK = ['subagent', 'subagent_fork', 'spawn_teammate', 'workflow'];
      let hijackNames = FLOW_TOOL_FALLBACK.slice();
      try {
        const configuredGated = (flowGate !== undefined && flowGate !== null && typeof flowGate.names === 'function') ? flowGate.names() : [];
        hijackNames = Array.from(new Set(FLOW_TOOL_FALLBACK.concat(configuredGated)));
        // 上一个 try 里的 agentTools 是块级变量，这里必须重新取一次（否则整段会静默失败）。
        try {
          toolsService = (typeof entry.agent.ctx.get === 'function') ? entry.agent.ctx.get('tools') : entry.agent.ctx.tools;
        } catch (error) { toolsService = undefined; }
        if (toolsService === undefined || toolsService === null) throw new Error('agent 上下文未提供 tools 服务');
        // 摘除只作为「遮蔽失败」的兜底：一次摘除不可逆，所以只在开关打开时才做。
        const denyOne = (name) => {
          if (typeof toolsService.restrict !== 'function') return false;
          try {
            ctx.effect(() => toolsService.restrict({ deny: [name] }));
            return true;
          } catch (error) {
            console.log(TAG + ' 摘不掉 ' + name + '（宿主不认识这个工具名）：' + describeError(error));
            return false;
          }
        };
        const hijackOne = (name) => {
          let original;
          try { original = (typeof toolsService.get === 'function') ? toolsService.get(name) : undefined; }
          catch (error) { original = undefined; }
          if (original === undefined || original === null) {
            // 不在可见工具表里：多半是宿主 preset 没这个工具（正常）。开关开着才需要把它挡掉。
            if (flowOnNow() === true) denyOne(name);
            return;
          }
          const wrapped = Object.assign({}, original, {
            async execute(args, exec) {
              // 关着：原样交给原始工具，连身份都不看（0.11 行为）。
              if (flowOnNow() !== true) return original.execute(args, exec);
              // 接管与要码必须是同一份判据：以前这里不看 isGated，于是把 subagent 从
              // gatedTools 里删掉后 guard 放行、这一层仍照旧拦截（配置说了不算）。
              if (flowGate === undefined || flowGate === null || typeof flowGate.isGated !== 'function' || flowGate.isGated(name) !== true) {
                return original.execute(args, exec);
              }
              const speaker = (entry.turnSpeaker !== undefined && entry.turnSpeaker !== null) ? entry.turnSpeaker : entry.speaker;
              // guard 可能没装（tools 服务不可用时这一层兜底）：这里也把工具名记下来，
              // 保证之后的授权申请一定绑到「真正要跑的工具」。
              if (speaker !== undefined && speaker !== null && typeof flowGate.noteBlocked === 'function') {
                flowGate.noteBlocked(String(speaker.userId), name);
              }
              if (ownerPrivateNow() !== true) {
                throw new Error('流程授权：这个工具只能在拥有者私聊里驱动（当前会话不允许）');
              }
              if (speaker === undefined || speaker === null || speaker.owner !== true) {
                throw new Error('流程授权：这个工具只允许拥有者本人在私聊里驱动');
              }
              // 上一层 guard 付过码的，直接执行（否则一次调用要吃两个 grant，等于永远跑不起来）；
              // 只有在 guard 没装或没拦的时候才现问一次闸门。
              const prepaid = entry.flowAllow !== undefined && entry.flowAllow !== null
                && Number(entry.flowAllow[name]) > 0;
              if (prepaid === true) {
                entry.flowAllow[name] = Number(entry.flowAllow[name]) - 1;
              } else {
                const verdict = (flowGate === undefined || flowGate === null)
                  ? { allow: true }
                  : flowGate.check(String(speaker.userId), name);
                if (verdict.allow !== true) throw new Error(flowGate.blockedText(verdict.reason));
              }
              entry.flowArmedAt = Date.now();
              try {
                return await original.execute(args, exec);
              } catch (error) {
                // 调用失败不该留着「本轮有产物」的标记，否则会白打一次包、还可能把半成品投出去。
                entry.flowArmedAt = undefined;
                throw error;
              }
            },
          });
          try {
            ctx.effect(() => toolsService.register(wrapped));
          } catch (error) {
            // 遮蔽失败不能让原生版本继续裸奔：开关开着时退一步把这个名字从工具表里摘掉。
            console.log(TAG + ' 遮蔽 ' + name + ' 失败：' + describeError(error));
            if (flowOnNow() === true) denyOne(name);
          }
        };
        for (const name of hijackNames) hijackOne(name);
      } catch (error) {
        console.log(TAG + ' 接管编排工具失败：' + describeError(error));
        // 只有开关打开时摘除才有意义（关着时摘掉就等于破坏 0.11 行为）。
        if (flowOnNow() === true && toolsService !== undefined && toolsService !== null) {
          if (typeof toolsService.restrict === 'function') {
            try { ctx.effect(() => toolsService.restrict({ deny: hijackNames })); }
            catch (error2) { console.log(TAG + ' 摘除也失败，宿主行为未知：' + describeError(error2)); }
          }
        }
      }
      // 固定会话名（可选）：新建会话时钉死成 私聊_<QQ号> / 群聊_<群号>，避免 LLM 自动起标题。
      // rename 用 user 源标题，之后自动生成不会覆盖。只在首次建会话时执行一次。
      if (fixedTitle !== null && fixedTitle !== undefined && fixedTitle !== '' && entry.agent !== null && entry.agent.session !== undefined) {
        try {
          const titles = ctx.get('sessionTitle');
          if (titles !== undefined && titles !== null && typeof titles.rename === 'function') {
            titles.rename(entry.agent.session, fixedTitle);
          }
        } catch (error) {
          console.error(TAG + ' 固定会话名失败（忽略）：' + describeError(error));
        }
      }

      console.log(TAG + ' 会话 ' + sessionId + ' 已就绪（' + entryKey + '）');
      return entry;
    })().catch((error) => { state.convos.delete(entryKey); throw error; });
    state.convos.set(entryKey, entry);
    entry.lastUsedAt = Date.now();
    // 空闲淘汰：每个会话常驻一个 agent 和几份工具遮蔽 effect，公开部署被 N 个陌生人私聊
    // 就是 N 份常驻内存。只淘汰最久未用的、且当前没有回合在跑的条目。
    while (state.convos.size > SESSION_POOL_MAX) {
      let oldestKey = null;
      let oldest = null;
      for (const [key, item] of state.convos) {
        if (key === entryKey) continue;
        if (Number(item.pendingTurns || 0) > 0) continue;
        if (oldest === null || Number(item.lastUsedAt || 0) < Number(oldest.lastUsedAt || 0)) { oldestKey = key; oldest = item; }
      }
      if (oldestKey === null) break;
      state.convos.delete(oldestKey);
      try { if (oldest !== null && oldest.agent !== null && typeof oldest.agent.cancel === 'function') oldest.agent.cancel(); }
      catch { /* 已经结束 */ }
      console.log(TAG + ' 会话池已满，淘汰最久未用的会话：' + oldestKey);
    }
    return entry.ready;
  }


  return { sessionRoute, getEntry, entryForAgent, collectReplyImageUrls };
}
