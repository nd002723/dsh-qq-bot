// 主动发言的表面层：配置读取、排程、群级状态与一次 tick 的编排。
// 从 gateway/plugin.js 搬出（P3 2.4 第二阶段，只搬不改）：判定与提示词构建仍在
// session/proactive.js；这里只负责「什么时候看、看哪个群、看完怎么发」。
import {
  nowMinutes as proactiveNowMinutes, isQuiet as proactiveIsQuiet, normalizeMessages as proactiveNormalizeMessages,
  newerThan as proactiveNewerThan, buildDigest as proactiveBuildDigest, buildPrompt as proactiveBuildPrompt,
  parseDecision as proactiveParseDecision, validateMessage as proactiveValidateMessage, allowSend as proactiveAllowSend,
  analyzeEvent as proactiveAnalyzeEvent, topicKey as proactiveTopicKey, topicRepeated as proactiveTopicRepeated,
  resolveStageModels as proactiveResolveStageModels, buildSpeakPrompt as proactiveBuildSpeakPrompt,
  runSpeakStage as proactiveRunSpeakStage, resolvePersonaText as proactiveResolvePersonaText,
} from '../session/proactive.js';

export function createProactiveSurface(deps) {
  const { TAG, getConfig, getState, ctx, describeError, callAdapterAction, getSessionApi, writeToAdapter, getHostPersona, sendStickerWithText, stickerAvailable } = deps;
  // 依赖名对不上时（历史上就写错过一次：调用方传了 sessionApi），别等到 15 分钟后第一次主动发言
  // 才在日志里冒一句「is not a function」——启动时就说清楚，功能会降级但不影响收发消息。
  if (typeof getSessionApi !== 'function') {
    console.error(TAG + ' 主动发言缺 getSessionApi 依赖：取不到会话模型，会退回用判断模型的正文发言');
  }
  // 只在「开关打开 + 显式列群 + 不在免打扰 + 新消息够多 + 频率没超」时才让模型看一次；
  // 要不要接、接什么话题全由模型判断，插话内容再过一遍长度/链接/@/重复校验。
  function proactiveConfig() {
    const p = getConfig().proactive;
    return (p === null || p === undefined) ? {} : p;
  }

  function proactiveGroupList() {
    const p = proactiveConfig();
    const list = Array.isArray(p.groups) ? p.groups : [];
    const out = [];
    for (const item of list) {
      const id = String(item === undefined || item === null ? '' : item).trim();
      if (id !== '' && out.indexOf(id) < 0) out.push(id);
    }
    return out;
  }

  function stopProactive() {
    if (getState().proactive.timer !== null) {
      try { getState().proactive.timer(); } catch (error) { /* 已经触发过 */ }
      getState().proactive.timer = null;
    }
  }

  function scheduleProactive() {
    stopProactive();
    // 配置可能刚被改过（热更新会重跑这里），缺项告警重新判断，不要因为旧的 warned 而哑掉。
    getState().proactive.warned = '';
    const p = proactiveConfig();
    if (p.enabled !== true) { getState().proactive.banner = ''; return; }
    const groups = proactiveGroupList();
    if (groups.length === 0) {
      console.log(TAG + ' 主动发言已开启但没配置群号（proactive.groups），跳过');
      return;
    }
    const minutes = Math.max(5, Number(p.intervalMinutes) > 0 ? Number(p.intervalMinutes) : 60);
    const base = minutes * 60000;
    const loop = async () => {
      try { await runProactiveTick(); }
      catch (error) { console.log(TAG + ' 主动发言检查失败（忽略）：' + describeError(error)); }
      // 这一轮 tick 可能在 await 期间跨过了插件卸载/重挂：那时 ctx.timeout 会抛
      // "cannot get required service in inactive context"，而 timer 回调丢弃返回值，
      // 抛出来就是 unhandled rejection —— Node 24 默认直接 exit 1，整个宿主陪葬。
      if (getState().stopping === true) return;
      const jitter = Math.floor(base * 0.2 * Math.random());
      try { getState().proactive.timer = ctx.timeout(loop, base + jitter); }
      catch (error) { console.log(TAG + ' 主动发言不再排下一轮（插件已卸载）：' + describeError(error)); }
    };
    getState().proactive.timer = ctx.timeout(loop, Math.floor(base * 0.5));
    const stage = proactiveResolveStageModels(p, null);
    const label = (s) => (s.provider !== '' && s.model !== '') ? (s.provider + '/' + s.model) : '群会话模型';
    const source = stage.judge;
    const sourceLabel = (source.provider !== '' && source.model !== '')
      ? ('指定模型 ' + source.provider + '/' + source.model)
      : '跟随群会话模型';
    const stageLabel = stage.twoStage === true
      ? ('，两段式（判断 ' + label(stage.judge) + ' / 发言 ' + label(stage.speak) + '）')
      : '';
    // 任何 volatile 字段改动都会重跑这里，横幅只在内容真的变了时才打，避免刷屏。
    const banner = '每 ' + minutes + ' 分钟看一次，群=' + groups.join(',')
      + '，首次检查约 ' + Math.round(minutes / 2) + ' 分钟后，模型来源=' + sourceLabel + stageLabel;
    if (banner !== getState().proactive.banner) {
      getState().proactive.banner = banner;
      console.log(TAG + ' 主动发言已开启：' + banner);
    }
  }

  function proactiveGroupState(groupId) {
    let s = getState().proactive.groups.get(groupId);
    if (s === undefined) {
      s = { lastSeenTime: 0, lastSentAt: 0, lastSentText: '', sentTimes: [], lastDecision: '', topics: [], sentTexts: [] };
      getState().proactive.groups.set(groupId, s);
    }
    return s;
  }

  async function runProactiveTick() {
    const p = proactiveConfig();
    if (p.enabled !== true) return;
    if (getState().connected !== true) return;
    if (proactiveIsQuiet(proactiveNowMinutes(new Date()), p.quietHours)) return;
    for (const groupId of proactiveGroupList()) {
      try { await proactiveConsiderGroup(groupId, p); }
      catch (error) { console.log(TAG + ' 主动发言（群 ' + groupId + '）失败（忽略）：' + describeError(error)); }
    }
  }

  async function proactiveSelfId() {
    if (getState().proactive.selfId !== null) return getState().proactive.selfId;
    try {
      const info = await callAdapterAction('get_login_info', {}, 8000);
      if (info.ok === true && info.data !== null && info.data !== undefined && info.data.user_id !== undefined) {
        getState().proactive.selfId = String(info.data.user_id);
      }
    } catch (error) { /* 取不到就按未知处理 */ }
    return getState().proactive.selfId;
  }

  // 配置不全时只告警一次，避免每轮刷屏；改完配置重启会重新判断。
  function warnProactiveIncomplete(missing) {
    const signature = missing.join('|');
    if (getState().proactive.warned === signature) return;
    getState().proactive.warned = signature;
    console.log(TAG + ' 主动发言不会真的发言：缺少 ' + missing.join('、')
      + '。可在插件设置「能力 → 对话与人格 → 主动发言」里用下拉选一个 provider/模型，留空则跟随群会话模型。');
  }

  /**
   * 取「这个群当前用的模型」：已有会话直接用；还没有会话就按全局 preset 建同一条会话
   * （主动发言要发话时本来也会用到它，所以不算额外开销）。
   * 这样即使刚重启、群里还没人说话，也能跟随会话模型而不是直接失败。
   */
  /** 一个会话条目对应的模型选项（没装模型路由时返回 null）。 */
  const optionsOfEntry = (entry) => (entry !== null && entry !== undefined && entry.agent !== null && entry.agent !== undefined
    && entry.agent.options !== null && entry.agent.options !== undefined) ? entry.agent.options : null;

  /**
   * 取该群对应的**会话条目**（不只是模型选项）：人格求值也要用它里面的 agent，
   * 这样 soul-md 才能按「会话指定 → 工作区 → 默认卡」挑对人设。
   */
  async function proactiveEntry(groupId) {
    const scopeKey = 'group-' + String(groupId);
    // 1) 非分流配置下的主会话；2) 分流配置下 owner / guest 两条
    const candidates = [getState().convos.get(scopeKey), getState().convos.get(scopeKey + '@owner'), getState().convos.get(scopeKey + '@guest')];
    for (const entry of candidates) {
      if (optionsOfEntry(entry) !== null) return entry;
    }
    // 3) 冷启动：按和收消息时一样的入口建（不分流时就是这样）
    // 分流模式下会话键是 group-x@owner / group-x@guest，这里判断不了该算哪一档，
    // 硬建只会留下一条收消息时永远用不到的孤儿会话——直接放弃，交给告警提示去指定模型。
    const split = String(getConfig().auth.ownerPreset || '').trim() !== '' || String(getConfig().auth.guestPreset || '').trim() !== '';
    if (split) return null;
    try {
      const entryKey = getConfig().perChatSession ? scopeKey : 'shared';
      const sessionId = getConfig().perChatSession ? 'qqbot-' + scopeKey : 'qqbot-shared';
      const fixedTitle = (getConfig().session !== null && getConfig().session !== undefined && getConfig().session.fixedName === true)
        ? '群聊_' + String(groupId) : null;
      return await getSessionApi().getEntry(entryKey, sessionId, getConfig().agentPreset, fixedTitle);
    } catch (error) {
      console.log(TAG + ' 主动发言：取会话模型失败（' + describeError(error) + '）');
      return null;
    }
  }


  async function proactiveCallModel(source, prompt, p, temperature) {
    if (source.missing.length > 0) { warnProactiveIncomplete(source.missing); return ''; }
    if (p.verbose === true) {
      console.log(TAG + ' 主动发言请求：' + source.provider + '/' + source.model
        + ' prompt=' + prompt.length + ' 字 head=' + JSON.stringify(String(prompt).slice(0, 80)));
    }
    return proactiveLlmModel(source, prompt, p, temperature);
  }

  /** DSH 内置 llm 服务（走已注册 provider，认证由 DSH 负责，不需要 key）。 */
  async function proactiveLlmModel(source, prompt, p, temperature) {
    const llm = ctx.llm;
    if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
      console.log(TAG + ' 主动发言：DSH llm 服务不可用（ctx.llm.stream 缺失），请确认 DSH 的 llm 插件已启用');
      return '';
    }
    const timeout = Math.max(5000, Math.floor(Number(p.timeoutMs) || 60000));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }];
    let out = '';
    try {
      const temp = Number.isFinite(temperature) ? temperature : 0.8;
      for await (const chunk of llm.stream({ provider: source.provider, model: source.model, messages, maxTokens: 500, temperature: temp, signal: controller.signal })) {
        if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text;
      }
    } catch (error) {
      console.log(TAG + ' 主动发言模型调用失败（' + source.provider + '/' + source.model + '）：' + describeError(error));
      return '';
    } finally {
      clearTimeout(timer);
    }
    if (out.trim() === '') console.log(TAG + ' 主动发言模型空返回（' + source.provider + '/' + source.model + '）');
    return out.trim();
  }

  async function proactiveConsiderGroup(groupId, p) {
    const st = proactiveGroupState(groupId);
    const verbose = p.verbose === true;
    const now = Date.now();
    const gate = proactiveAllowSend({ now, sentTimes: st.sentTimes, lastSentAt: st.lastSentAt, maxPerHour: p.maxPerHour, maxPerDay: p.maxPerDay, minGapMinutes: p.minGapMinutes });
    if (gate.ok !== true) { if (verbose) console.log(TAG + ' 主动发言跳过（' + groupId + '）：' + gate.reason); return; }
    const windowSize = Math.max(5, Math.min(100, Math.floor(Number(p.windowMessages) || 30)));
    const result = await callAdapterAction('get_group_msg_history', { group_id: Number(groupId), count: windowSize }, 8000);
    if (result.ok !== true) { if (verbose) console.log(TAG + ' 主动发言取历史失败（' + groupId + '）'); return; }
    const raw = result.data !== null && result.data !== undefined && Array.isArray(result.data.messages) ? result.data.messages : [];
    const selfId = await proactiveSelfId();
    const messages = proactiveNormalizeMessages(raw, selfId === null ? '' : selfId);
    const fresh = proactiveNewerThan(messages, st.lastSeenTime).filter((m) => m.isSelf !== true);
    for (const m of messages) { if (m.time > st.lastSeenTime) st.lastSeenTime = m.time; }
    const minNew = Math.max(1, Math.floor(Number(p.minNewMessages) || 6));
    if (fresh.length < minNew) { if (verbose) console.log(TAG + ' 主动发言跳过（' + groupId + '）：新消息 ' + fresh.length + ' < ' + minNew); return; }
    // 事件闸（可关）：过气的、只是应答一句的、自己刚说过的，都不接——避免对同一件事重复回复。
    const eventGuard = p.eventGuard !== false;
    let event = { ok: true, reason: '', ageMinutes: 0, eventTime: 0 };
    if (eventGuard === true) {
      event = proactiveAnalyzeEvent(messages, { nowSec: Math.floor(Date.now() / 1000), staleMinutes: p.staleMinutes });
      if (event.ok !== true) { if (verbose) console.log(TAG + ' 主动发言跳过（' + groupId + '）：' + event.reason); return; }
    }
    // 模型来源由 proactiveCallModel 内部统一判断（留空就跟随群会话模型，不需要 key）。
    const personaText = String(p.persona === undefined || p.persona === null ? '' : p.persona).trim();
    const basePersona = getConfig().persona !== null && getConfig().persona !== undefined && String(getConfig().persona.text || '').trim() !== ''
      ? (String(getConfig().persona.name || '').trim() !== '' ? String(getConfig().persona.name).trim() + '：' : '') + String(getConfig().persona.text).trim()
      : '';
    // 人格优先级：手填的主动发言人设 → 宿主求值的 soul 人格段（dsh-soul-md）→ 插件自己的 persona（原有回退）。
    // 会话条目只取一次：既用来算模型选项，也把 agent 交给宿主做人格求值。
    const entry = await proactiveEntry(groupId);
    let hostPersona = '';
    if (personaText === '' && typeof getHostPersona === 'function') {
      try {
        hostPersona = String(await getHostPersona(entry === null || entry === undefined ? null : entry.agent)).trim();
      } catch (error) {
        hostPersona = '';
      }
    }
    const persona = proactiveResolvePersonaText({ explicit: personaText, host: hostPersona, fallback: basePersona });
    // 图库可用时才让模型给表情包关键词（否则纯文本路径不浪费 token）
    const wantsSticker = typeof stickerAvailable === 'function' && stickerAvailable() === true && typeof sendStickerWithText === 'function';
    const prompt = proactiveBuildPrompt({
      persona,
      sticker: wantsSticker,
      interests: p.interests,
      digest: proactiveBuildDigest(fresh, Math.min(40, windowSize)),
      maxChars: p.maxChars,
      // 把事件年龄与「别重复」的要求交给模型，配合上面的确定性事件闸一起用。
      eventAgeMinutes: event.ageMinutes,
      recentTopics: st.topics.map((item) => item.key).filter((key) => String(key).length > 0).slice(-3),
    });
    // 判断/发言可以各用各的模型；speakModel 没配时就是单段模式，行为与之前完全一致。
    const stageModels = proactiveResolveStageModels(p, optionsOfEntry(entry));
    // 两段式缺项在这里就拦住：等判断那次调用花完钱才发现配置填错没有意义。
    if (stageModels.twoStage === true && stageModels.speak.missing.length > 0) { warnProactiveIncomplete(stageModels.speak.missing); return; }
    let answer = '';
    let decision = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      answer = await proactiveCallModel(stageModels.judge, prompt, p, 0.8);
      decision = answer === '' ? null : proactiveParseDecision(answer);
      if (decision !== null) break;
      if (verbose) console.log(TAG + ' 主动发言：第 ' + String(attempt + 1) + ' 次无有效决策' + (answer === '' ? '' : '（原文：' + answer.slice(0, 120) + '）'));
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    if (decision === null) { if (verbose) console.log(TAG + ' 主动发言：放弃本轮'); return; }
    st.lastDecision = decision.topic + (decision.why === '' ? '' : '｜' + decision.why);
    if (decision.speak !== true) { if (verbose) console.log(TAG + ' 主动发言（' + groupId + '）：决定不接话｜' + st.lastDecision); return; }
    const maxChars = Math.max(20, Math.floor(Number(p.maxChars) || 120));
    const recentTexts = (Array.isArray(st.sentTexts) && st.sentTexts.length > 0 ? st.sentTexts : [st.lastSentText]);
    // 单段模式也过同一道兜底：开关默认关，透传不改变任何现有部署的行为。
    let verdict = proactiveValidateMessage(decision.message, { maxChars, recentTexts, requireCjk: p.requireCjk === true });
    // 两段式（可选）：判断只出 JSON，正文交给发言模型写；写不出来时才回退到判断模型给的那句。
    if (stageModels.twoStage === true) {
      const speakPrompt = proactiveBuildSpeakPrompt({
        persona,
        digest: proactiveBuildDigest(fresh, Math.min(40, windowSize)),
        topic: decision.topic,
        maxChars,
      });
      const stage = await proactiveRunSpeakStage({
        call: () => proactiveCallModel(stageModels.speak, speakPrompt, p, 0.9),
        // requireCjk 是发送前兜底（默认关）：无 CJK 且长度 > 12 判不可用，专治模型掉回英文拒答模板。
        validate: (raw) => proactiveValidateMessage(raw, { maxChars, recentTexts, requireCjk: p.requireCjk === true }),
        attempts: 2,
        // 判断阶段的 message 在这里只为回退保留：精简 judge 提示词时不能把它删掉，否则回退会静默失效。
        fallback: { enabled: p.speakFallback !== false, ok: verdict.ok === true, text: verdict.text },
        onBlocked: (index, checked) => { if (verbose) console.log(TAG + ' 主动发言：发言阶段第 ' + String(index + 1) + ' 次被拦（' + checked.reason + '）'); },
        onFallback: () => { if (verbose) console.log(TAG + ' 主动发言：发言阶段没有产出，回退用判断模型给的正文'); },
      });
      if (stage.text === '') {
        if (verbose) {
          const why = (p.speakFallback !== false && verdict.ok !== true) ? '（判断正文本身不可用：' + verdict.reason + '，无处可退）' : '';
          console.log(TAG + ' 主动发言（' + groupId + '）：两段式没有可发的正文' + why);
        }
        return;
      }
      verdict = { ok: true, reason: '', text: stage.text };
    }
    if (verdict.ok !== true) { if (verbose) console.log(TAG + ' 主动发言（' + groupId + '）：内容被拦（' + verdict.reason + '）'); return; }
    // 话题闸：冷却时间内说过同一件事（哪怕换了说法）就不再重复。
    const topicKey = proactiveTopicKey(decision.topic !== '' ? decision.topic : verdict.text);
    if (eventGuard === true && proactiveTopicRepeated(topicKey, st.topics, { now: Date.now(), cooldownMinutes: p.topicCooldownMinutes }) === true) {
      console.log(TAG + ' 主动发言跳过（' + groupId + '）：话题「' + topicKey + '」在冷却时间内已经说过');
      return;
    }
    if (p.dryRun === true) {
      const stickerNote = wantsSticker === true && decision.sticker !== '' ? '（本想配表情包关键词「' + decision.sticker + '」）' : '';
      console.log(TAG + ' 主动发言（演练，不发送）→ 群 ' + groupId + '：' + verdict.text + stickerNote);
      return;
    }
    // 文字 + 表情包：挑了图就让插件侧决定「合并一条」还是「先图后字」；挑不到图就只发文字。
    let sent = null;
    const stickerQuery = wantsSticker === true && typeof decision.sticker === 'string' ? decision.sticker : '';
    if (stickerQuery !== '') {
      let withSticker = false;
      try {
        withSticker = (await sendStickerWithText({ groupId, query: stickerQuery, text: verdict.text })) === true;
      } catch (error) {
        withSticker = false;
        if (verbose) console.log(TAG + ' 主动发言（' + groupId + '）：发表情包失败，退回纯文字（' + describeError(error) + '）');
      }
      if (withSticker === true) sent = true;
      else if (verbose) console.log(TAG + ' 主动发言（' + groupId + '）：没挑到合适表情包，只发文字');
    }
    if (sent !== true) sent = writeToAdapter({ type: 'send', message_type: 'group', target_id: groupId, text: verdict.text });
    if (sent !== true) { if (verbose) console.log(TAG + ' 主动发言（' + groupId + '）：适配器不可用'); return; }
    const sentAt = Date.now();
    st.lastSentAt = sentAt;
    st.lastSentText = verdict.text;
    st.sentTexts = (Array.isArray(st.sentTexts) ? st.sentTexts : []).concat([verdict.text]).slice(-5);
    st.topics = (Array.isArray(st.topics) ? st.topics : []).concat([{ at: sentAt, key: topicKey }]).slice(-20);
    st.sentTimes.push(sentAt);
    st.sentTimes = st.sentTimes.filter((t) => sentAt - t < 86400000);
    console.log(TAG + ' 主动发言 → 群 ' + groupId + (decision.topic === '' ? '' : '（' + decision.topic + '）') + '：' + verdict.text);
  }

  return { scheduleProactive, stopProactive };
}
