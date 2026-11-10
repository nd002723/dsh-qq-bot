// 回合运行时：入站消息的主流程（限流、鉴权、识图、模型回合、回复）与图片缓存清扫。
// 从 gateway/plugin.js 搬出（P3 2.4 第三阶段，只搬不改）：状态仍在插件 state，
// 其余依赖（会话/工具/权限/flowGate/适配器写帧）全部注入。
import { promises as fsPromises } from 'node:fs';
import { join } from 'node:path';
import { chunkMarkdown } from '../message/chunk.js';
import { imageCacheDir, isInside } from '../session/workspace.js';
import { shouldStream } from '../message/stream.js';
import { pickInterim } from '../message/interim.js';
import { imageMetaOf, isStickerLike } from '../message/segments.mjs';

export function createTurnRuntime(deps) {
  const {
    TAG, getConfig, getState, ctx, describeError, sendReply, writeToAdapter, callAdapterAction,
    adminApi, sessionApi, toolsApi, flowGate, valves, acquireOrder, takeTurnSlot, notifyThrottled,
    inboundMaxChars, inboundQueueMax, handleAuthMessage, handleFlowCommand, requestFlowAuth, ownerQq,
    describeImages, deliverFlowArtifacts, handleModelCommand, parseModelCommand, flowInterceptKind,
    stripInvisible, buildPersonaHint, sanitizeDisplayName, summarizeTurnReason, idValue, streamBridge, allowlistOk, qqMsgRootSync, uid, warnOwnerMissingOnce, isReplyToSelf,
    sticker,
  } = deps;
  /**
   * 把这条消息里「像表情包」的图丢给图库收集器。
   *
   * 三条刻意的取舍：
   *   1. **fire-and-forget**：下载/落盘/打标全在后台，入站主链 0 等待（收图不该拖慢回复）；
   *   2. 只收元数据判定像表情包的（isStickerLike），普通照片一张都不收；
   *   3. 单条消息最多收 3 张，且失败只记日志、绝不抛（入站主链不能因为收图报错）。
   */
  const STICKER_COLLECT_MAX_PER_MSG = 3;
  function stickerMetaOf(frame) {
    if (frame !== null && frame !== undefined && Array.isArray(frame.image_meta) && frame.image_meta.length > 0) {
      return frame.image_meta;
    }
    // 老适配器/自定义适配器没给 image_meta：退回从 image_urls 拼一份（判定会全部落空，
    // 于是只按 .gif 收——这比「把所有图都收进来」安全得多）。
    const urls = (frame !== null && frame !== undefined && Array.isArray(frame.image_urls)) ? frame.image_urls : [];
    return urls.map((url) => ({ url, file: '', summary: '', subType: null, ext: /(\.\w{2,5})\b/.exec(String(url).split('?')[0])?.[1]?.toLowerCase() ?? '' }));
  }
  let stickerCollectInflight = 0;
  function scheduleStickerCollect(frame) {
    const store = sticker;
    if (store === undefined || store === null || typeof store.collect !== 'function') return;
    try {
      if (typeof store.collectEnabled === 'function' && store.collectEnabled() !== true) return;
    } catch { return; }
    let metas;
    try { metas = stickerMetaOf(frame); } catch { return; }
    const picks = metas.filter((meta) => isStickerLike(meta) === true).slice(0, STICKER_COLLECT_MAX_PER_MSG);
    if (picks.length === 0) {
      // 有图但一张都没通过元数据判定：记一行，否则排查时根本看不出「收到了图但按规则不收」。
      if (metas.length > 0) {
        console.log(TAG + ' 偷表情包跳过：这条消息的 ' + String(metas.length) + ' 张图按元数据都不像表情包'
          + '（' + metas.map((m) => 'sub=' + String(m.subType) + '/ext=' + (m.ext || '?')).join('、') + '）');
      }
      return;
    }
    for (const meta of picks) {
      if (stickerCollectInflight >= 3) break;   // 图片轰炸时不把连接打满
      stickerCollectInflight += 1;
      void store.collect(meta.url).then((result) => {
        stickerCollectInflight -= 1;
        if (result === null || result === undefined) return;
        // 四种结果都记一行：以前只打 new / error，dup 与 skip 完全静默——
        // 排查「为什么这张图没进库」时日志里什么都没有，只能靠猜。
        if (result.status === 'new') {
          console.log(TAG + ' 偷表情包：#' + String(result.id || '') + ' 已入库'
            + (Number(result.trimmed) > 0 ? ('（超上限，删掉最早收的 ' + String(result.trimmed) + ' 张）') : ''));
        } else if (result.status === 'dup') {
          console.log(TAG + ' 偷表情包：已在库（#' + String(result.id || '') + '），跳过');
        } else if (result.status === 'skip') {
          console.log(TAG + ' 偷表情包跳过：' + String(result.reason || '未知原因'));
        } else if (result.status === 'error') {
          console.log(TAG + ' 偷表情包失败（忽略）：' + String(result.reason || ''));
        }
      }, (error) => {
        stickerCollectInflight -= 1;
        console.log(TAG + ' 偷表情包失败（忽略）：' + describeError(error));
      });
    }
  }

  async function acceptMessage(frame) {
    // 去重放在最前面：走完准入再判重，重投消息会先被计入 skipped 并可能触发回复提示。
    const frameId = (frame.message_id === undefined || frame.message_id === null) ? '' : String(frame.message_id).trim();
    if (frameId !== '' && getState().msgIds.hit(frameId) === true) {
      getState().stats.skipped += 1;
      getState().stats.duplicates += 1;
      return;
    }
    const isGroup = frame.message_type === 'group';
    const policy = isGroup ? getConfig().group : getConfig().private;
    const chatId = isGroup ? frame.group_id : frame.user_id;

    if (policy.enabled !== true) { getState().stats.skipped += 1; return; }
    const selfId = frame.self_id === null || frame.self_id === undefined ? null : String(frame.self_id);
    if (selfId !== null && String(frame.user_id) === selfId) { getState().stats.skipped += 1; return; }

    // 默认准入是 fail-closed（#27）：没有拥有者就**不驱动任何会话**。
    // 以前 owners 为空只是「没人有额外权限」，而白名单为空又表示「不限」，于是装好即对外开放——
    // 任何人私聊或在群里 @ 一下就能消耗拥有者的额度，并把插件当成打内网/搜网页的跳板。
    if (ownerQq() === '') {
      getState().stats.skipped += 1;
      warnOwnerMissingOnce();
      // 只在私聊里回配置指引：群里回一句就等于把配置口暴露给所有人看，还容易被当成噪声。
      if (isGroup !== true) {
        sendReply(frame, '还没配置拥有者，我不会驱动会话。请到「插件 → 已安装 → @sputnikzaychik/dsh-qq-bot → 基本 → 拥有者账号」填上你自己的账号后重试（OneBot 协议填 QQ 号，QQ 官方协议填 OpenID）。');
      }
      return;
    }

    // 白名单必须排在**所有**处理之前（2026-10-28 审计 A2）。
    // 以前它排在群管理指令和 /model 之后，于是 group.allow 收紧到单群之后，
    // 其它群里的 /help、/whoami 仍然会拿到回复——白名单实际只挡住了「进 Agent 回合」，
    // 没挡住「在群里说话」。默认准入是 fail-closed，这里也照同一个口径。
    if (!allowlistOk(policy.allow, chatId)) { getState().stats.skipped += 1; return; }

    // ============================================ 偷表情包（issue #97）
    // 位置很关键：必须排在 requireAt 闸门**之前**——没 @ 机器人的群消息根本走不到下面，
    // 而群里绝大多数表情包都是「没 @ 任何人」的随手发（参考实现踩过这个坑：挂在
    // next() 之后等于永远不触发）。
    // 同时排在白名单之后：不在允许群里的图一张都不收（否则等于给人当免费图床）。
    // 判定只看消息段元数据（sub_type / summary / .gif），不调模型、不看画面。
    scheduleStickerCollect(frame);

    // 群管理指令优先：不要求 @ 机器人，也不会送给模型。
    if (isGroup) {
      const handled = await adminApi.handleAdminCommand(frame, typeof frame.text === 'string' ? frame.text : '');
      if (handled === true) return;
    }
    // /model：模型查看与切换（拥有者专用）。
    // 群里被 @ 时文本前面会带 "@qq "，指令前也可能有空格——统一交给 parseModelCommand 剥。
    if (adminApi.isOwner(frame.user_id) === true) {
      const parsedModel = parseModelCommand(stripInvisible(frame.text), String(getConfig().admin.prefix || '/'));
      if (parsedModel !== null) {
        const chatKey = isGroup === true ? 'g' + String(frame.group_id) : 'p' + String(frame.user_id);
        sendReply(frame, await handleModelCommand(parsedModel.rest, chatKey), true);
        return;
      }
    }
    // 私聊二次授权：/auth 动态码 + /flow 流程脚本管理。只认「拥有者 + 私聊 + 消息首位」，
    // 命中即在此结束：不进 Agent 回合，动态码不落会话（不会被历史或日志带出去）。
    const flowInterceptOn = getConfig().flowAuth !== undefined && getConfig().flowAuth !== null && getConfig().flowAuth.enabled === true;
    // 判定与解析必须用同一份文本：只剥一次，否则零宽串会被「拦下来但解析失败」，消息人间蒸发。
    const flowText = stripInvisible(frame.text);
    const flowKind = flowInterceptOn === true
      ? flowInterceptKind({ isGroup, isOwner: adminApi.isOwner(frame.user_id), text: flowText })
      : null;
    if (flowKind === 'auth') { await handleAuthMessage(frame, flowText); return; }
    if (flowKind === 'flow') { await handleFlowCommand(frame, flowText); return; }


    let text = typeof frame.text === 'string' ? frame.text : '';

    // 命令前缀（如 /ai）：命中视同点名（bot 被调用），豁免 requireAt；
    // 与群管理指令同理，也走「QQ 回复消息流程」引用回复。
    let prefixHit = false;
    if (getConfig().commandPrefix !== '') {
      if (!text.startsWith(getConfig().commandPrefix)) { getState().stats.skipped += 1; return; }
      text = text.slice(getConfig().commandPrefix.length).trim();
      prefixHit = true;
    }

    // 被回复（引用）了 bot 消息：视同 @ 处理（群聊 + 开关开启时）。
    // 查询被引用消息的发送者是否 bot 自己；查不到按非 bot 处理。
    // 前缀指令已豁免 @，无需再查。
    let repliedToBot = false;
    // 只要开关开启且消息带了被引用消息，就查发送者是否 bot 自己；
    // 不依赖 requireAt——requireAt 关闭（群=全部）时回复了 bot 同样要识别并引用回复。
    if (!prefixHit && isGroup && getConfig().reply.botReply === true
      && frame.reply_to !== null && frame.reply_to !== undefined) {
      repliedToBot = await isReplyToSelf(frame);
    }

    // bot 是否被点名（@ 了 bot / 回复了 bot / 前缀指令）：被点名才用「QQ 回复消息流程」引用回复。
    let botMentioned = repliedToBot || prefixHit;
    let mentionHit = false;
    if (isGroup && policy.requireAt === true && !prefixHit) {
      // 判定只认「at 段」，不认正文（2026-10-28 审计 A1）：
      //   1) 用户在正文里手打 '@机器人QQ' 会命中旧的 includes 判定，requireAt 形同虚设；
      //   2) '@10001' 是 '@100012' 的前缀，正常 @ 别人会被误判成 @ 了我，
      //      而旧代码 split('@10001').join(' ') 剥前缀时还会把对方 QQ 号咬掉一位。
      // 适配器都带 frame.mentions；自定义适配器没给时退化成「@数字 + 数字边界」的保守匹配，
      // 宁可漏判（要求 @）也不误判（把别人的 @ 算成我的）。
      const mentions = Array.isArray(frame.mentions) ? frame.mentions.map((qq) => String(qq)) : null;
      const mention = selfId === null ? null : '@' + selfId;
      const mentionPattern = mention === null ? null : mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?!\\d)';
      const atMe = (mentions !== null && selfId !== null)
        ? mentions.includes(selfId)
        : (mentionPattern === null ? text.includes('@') : new RegExp(mentionPattern).test(text));
      if (atMe === true) {
        if (mentionPattern !== null) text = text.replace(new RegExp(mentionPattern, 'g'), ' ').trim();
        botMentioned = true;
        mentionHit = true;
      } else if (!repliedToBot) { getState().stats.skipped += 1; return; }
    }

    // 例外：回复了 bot 但正文 @ 的是别人（剥离 @bot 后仍有 @）——
    // 这条可能不是对 bot 说的，不强制引用回复，交给 bot 自行判断是否继续回复。
    if (repliedToBot && !mentionHit && /@/.test(text)) botMentioned = false;

    // 不再主动拉取聊天上下文塞进会话（fetchReplyContext/replyTargetQQs 已移除）：
    // 需要群内近期消息/图片时，由 AI 主动调 qq_history 工具自取。
    // 只保留「被回复消息的图片」收集，供 describeImages 一并识别（回复引用流程不受影响）。
    if (frame.reply_to !== null && frame.reply_to !== undefined
      && (repliedToBot || mentionHit)) {
      try { await sessionApi.collectReplyImageUrls(frame); }
      catch (error) { console.log(TAG + ' 收集被回复图片失败（忽略）：' + describeError(error)); }
    }

    // 无正文：bot 被点名（@ / 回复 bot / 命令前缀）时也给一个占位正文让它回应（如纯回复/纯 @）；
    // 否则（普通空消息）照旧跳过。
    if (text === '' && !(typeof frame.images === 'number' && frame.images > 0)) {
      if (!botMentioned) { getState().stats.skipped += 1; return; }
      text = '（本条消息无正文，仅点名了 bot）';
    }
    // 单条长度上限（#22）：超长正文不进提示词，否则一条几百 KB 的消息就能顶掉整轮上下文。
    const inboundCap = inboundMaxChars();
    if (text.length > inboundCap) {
      text = text.slice(0, inboundCap) + '\n…（消息过长，已截断：原文 ' + text.length + ' 字，只处理前 ' + inboundCap + ' 字）';
    }
    getState().stats.accepted += 1;

    // 入口路由：按「拥有者 / 非拥有者」决定走哪条会话与 preset；
    // 两个 preset 都不配就共用一条会话（行为与以前一致）。
    const route = sessionApi.sessionRoute(frame);
    const entryKey = getConfig().perChatSession ? route.entryKey : 'shared';
    const sessionId = getConfig().perChatSession ? route.sessionId : 'qqbot-shared';
    const preset = getConfig().perChatSession ? route.preset : getConfig().agentPreset;

    const fixedTitle = (getConfig().session !== null && getConfig().session !== undefined && getConfig().session.fixedName === true)
      ? (frame.message_type === 'group' ? '群聊_' : '私聊_') + String(frame.message_type === 'group' ? frame.group_id : frame.user_id)
      : null;
    // 从这里开始的处理必须按到达顺序进行（建会话、查群成员鉴权都是 await）。
    const releaseOrder = acquireOrder(entryKey);
    let entry;
    try { entry = await sessionApi.getEntry(entryKey, sessionId, preset, fixedTitle); }
    catch (error) {
      getState().stats.errors += 1;
      console.error(TAG + ' 为 ' + entryKey + ' 建会话失败：' + describeError(error));
      sendReply(frame, '（内部错误：无法创建对话会话）');
      releaseOrder();
      return;
    }

    // 记录本条消息的说话人与身份：qqgroup 工具的鉴权依据（三路并行）。
    const speakerAuthority = await adminApi.resolveAuthority(frame.user_id, isGroup ? chatId : null);
    entry.groupId = isGroup ? String(chatId) : null;
    // 记录本条触发消息，qq_history 工具以此锚定图片识别窗口（最新提及）。
    entry.currentFrame = frame;
    entry.speaker = {
      userId: String(frame.user_id),
      groupId: entry.groupId,
      tier: speakerAuthority.tier,
      owner: speakerAuthority.owner === true,
      sources: speakerAuthority.sources,
    };

    // 本回合是否允许使用 DSH 内部工具：只有拥有者（或显式放开 guestDshTools）才行。
    const allowDsh = speakerAuthority.owner === true || getConfig().auth.guestDshTools === true;

    // 入站限流（#22）：同一个人在同一会话里每分钟最多驱动 N 个回合。
    // 必须等「这条消息确定会驱动回合」之后再计费：放在入口处会把群里的闲聊、
    // 图片消息和没点名的消息全算进去，活跃群里几十条闲聊就能把额度刷光，
    // 之后真正的 @ 反而被静默丢掉（群里不回复，只加 skipped 计数）。
    if (takeTurnSlot((isGroup === true ? 'g' : 'p') + String(chatId) + ':' + String(frame.user_id)) !== true) {
      getState().stats.skipped += 1;
      notifyThrottled(frame, isGroup);
      releaseOrder();
      return;
    }

    const generation = entry.generation;
    // 入队时就把发言人钉住：排队期间新消息不会改动这一回合的身份判定。
    const turnSpeaker = { userId: String(frame.user_id), groupId: entry.groupId, tier: speakerAuthority.tier, owner: speakerAuthority.owner === true, sources: speakerAuthority.sources };
    // 队列深度上限（#22）：排太多就直接拒收，不让消息无限堆在内存里（每条都要跑一个完整回合）。
    const queueMax = inboundQueueMax();
    const pendingTurns = Number(entry.pendingTurns === undefined ? 0 : entry.pendingTurns) + 1;
    if (pendingTurns > queueMax) {
      getState().stats.skipped += 1;
      sendReply(frame, '（这条先不处理：同一会话排队的回合太多了，等前面的回答完再发）');
      releaseOrder();
      return;
    }
    entry.pendingTurns = pendingTurns;
    entry.queue = entry.queue
      .then(() => runTurn(entry, frame, text, generation, allowDsh, botMentioned, turnSpeaker))
      .then(() => deliverFlowArtifacts(entry, frame))
      .catch((error) => {
        getState().stats.errors += 1;
        console.error(TAG + ' ' + entryKey + ' 回合失败：' + describeError(error));
      })
      .then(() => { entry.pendingTurns = Math.max(0, Number(entry.pendingTurns || 1) - 1); });
    // 已挂上会话队列：顺序由 entry.queue 保证，这里释放顺序锁。
    releaseOrder();
  }

  /**
   * 识别 QQ 消息里的图片：下载图片，用 DSH 已配置的视觉模型（从自定义 providers
   * 里选，协议/baseURL/apiKey 全部沿用 DSH 原本填写的）做图片理解，返回识别文本。
   * 返回 { error, text }：error 非空 = 不应继续（可读报错提示）；text 非空 = 识别结果。
   */

  /**
   * 把正文里的 [图片] 占位符按**出现顺序**换成 [图片<文件名>]，下标即「本条消息里的第几张图」。
   *
   * 为什么要在正文里标：一次发多张图时，模型只有 [图片] [图片] 这种没有身份的同形占位符，
   * 分不清「谁发的哪张」；文件名是内容 sha1（与落盘文件同名），既能对上号，也不会因
   * 时间戳抖动而变。下载失败的图保持原样 [图片]；占位符比图少时（例如纯图消息被替换成
   * 「（发来了一张图片）」）剩下的文件名追加在末尾，不丢信息。
   */
  function labelImagePlaceholders(text, names) {
    if (!Array.isArray(names) || names.length === 0) return text;
    const marker = '[图片]';
    let out = '';
    let cursor = 0;
    let idx = 0;
    for (;;) {
      const at = text.indexOf(marker, cursor);
      if (at < 0) break;
      out += text.slice(cursor, at);
      const name = idx < names.length ? names[idx] : '';
      out += (typeof name === 'string' && name !== '') ? '[图片<' + name + '>]' : marker;
      idx += 1;
      cursor = at + marker.length;
    }
    out += text.slice(cursor);
    const rest = names.slice(idx).filter((n) => typeof n === 'string' && n !== '');
    if (rest.length > 0) out += '\n' + rest.map((n) => '[图片<' + n + '>]').join(' ');
    return out;
  }

  /** 昵称/群名片 → 一行安全文本（去 \r\n 与方括号、压空白、限长）。 */
  function buildPrompt(frame, text, entry) {
    const sender = frame.sender;
    // 昵称/群名片是外部输入，进提示词前必须清洗：换行与方括号能让访客伪造出第二行身份头。
    const who = sanitizeDisplayName(sender === null || sender === undefined ? '' : (sender.card || sender.nickname));
    const body = text === '' ? '（发来了一张图片）' : text;
    if (getConfig().reply.contextHeader !== true) return body;
    const where = frame.message_type === 'group' ? 'QQ群 ' + String(frame.group_id) : 'QQ私聊';
    // 把说话人身份带给 Agent：非拥有者的请求是否该执行，由 Agent 结合权限判断。
    let tag = '';
    // 身份标签同样读本回合的快照：排队串台时 entry.speaker 可能已经是别人的了。
    const speakerSnap = (entry !== null && entry !== undefined)
      ? ((entry.turnSpeaker !== undefined && entry.turnSpeaker !== null) ? entry.turnSpeaker : entry.speaker)
      : null;
    if (speakerSnap !== null && speakerSnap !== undefined) {
      const tier = adminApi.TIER_LABEL[speakerSnap.tier] === undefined ? speakerSnap.tier : adminApi.TIER_LABEL[speakerSnap.tier];
      const src = Array.isArray(speakerSnap.sources) && speakerSnap.sources.length > 0 ? '｜' + speakerSnap.sources.join('+') : '';
      tag = ' · 身份:' + tier + src;
    }
    let head = '[' + where + ' · ' + who + '(' + String(frame.user_id) + ')' + tag + ']';
    return head + ' ' + body;
  }

  /**
   * 中间发言循环：每过一会儿看一眼会话日志，把「说完但后面还有内容」的 assistant 段落发一条。
   * 最后一条 assistant 消息不在这里发（那是最终结算的正文），所以不会出现「先说一遍再正式回一遍」。
   * 返回停止函数；回合结束（whenIdle）时务必调用，否则会继续说下去。
   */
  function startInterimLoop(entry, frame, afterId, onInterim) {
    const conf = getConfig().reply || {};
    const maxPerTurn = Math.max(0, Math.floor(Number(conf.interimMaxPerTurn) || 0));
    if (conf.interim !== true || maxPerTurn === 0) return () => {};
    const gapMs = Math.max(500, Math.floor(Number(conf.interimMinGapMs) || 2500));
    const spoken = new Set();
    let sent = 0;
    let stopped = false;
    let cancel = null;
    const schedule = () => {
      if (stopped === true || sent >= maxPerTurn) return;
      try { cancel = ctx.timeout(tick, gapMs); } catch (error) { cancel = null; }
    };
    const tick = () => {
      cancel = null;
      if (stopped === true) return;
      const agent = entry.agent;
      const session = (agent === null || agent === undefined) ? null : agent.session;
      if (session === null || session === undefined || typeof session.deriveMessages !== 'function') { schedule(); return; }
      let messages = [];
      try { messages = session.deriveMessages(); } catch (error) { messages = []; }
      const picks = pickInterim(messages, afterId);
      for (const item of picks) {
        // 这里的 sent < maxPerTurn 由 schedule() 保证，不需要再判一次。
        if (spoken.has(item.id)) continue;
        spoken.add(item.id);
        sent += 1;
        // 不传 withQuote：中间发言不引用、也不 @ 任何人。
        // 流式模式下（官方 v2 私聊）交给桥累积，不单独再发一条。
        if (typeof onInterim === 'function') onInterim(item.text);
        else sendReply(frame, item.text);
        console.log(TAG + ' 中间发言（' + String(item.text.length) + ' 字）：' + item.text.slice(0, 40).replace(/\s+/g, ' '));
        break;      // 一次最多发一条，间隔交给下一轮定时器
      }
      schedule();
    };
    schedule();
    return () => {
      stopped = true;
      if (typeof cancel === 'function') { try { cancel(); } catch (error) { /* 已经触发过了 */ } }
    };
  }

  async function runTurn(entry, frame, text, generation, allowDsh, quoteReply, turnSpeaker) {
    // 发言人快照：排队期间的其它消息会覆盖 entry.speaker，闸门必须看本回合的。
    if (turnSpeaker !== undefined && turnSpeaker !== null) entry.turnSpeaker = turnSpeaker;
    // 上一轮可能留下没被消费的「已付码」记账（例如守卫放行后工具自己没跑成），新回合一律清空。
    entry.flowAllow = undefined;
    if (entry.generation !== generation) return;   // 已被 interrupt 作废

    // 必须在串行回合内部设置：如果在接收入口设，排队的两条消息（先拥有者后访客）
    // 会互相覆盖，导致后一个回合用错权限。
    entry.dshAllowed = allowDsh === true;
    if (entry.guardUnavailable === true && allowDsh !== true) {
      sendReply(frame, '（本会话无法安装工具隔离，已拒绝这次驱动）');
      return;
    }

    entry.turns += 1;

    const body = buildPrompt(frame, text, entry);
    // 人格（persona）与首轮提示都只在会话第一轮追加一次：零额外 token。
    const firstHints = [];
    const personaHint = buildPersonaHint(getConfig().persona);
    if (personaHint !== '') firstHints.push(personaHint);
    if (getConfig().reply.firstTurnHint !== '') firstHints.push(getConfig().reply.firstTurnHint);
    const userText = entry.turns === 1 && firstHints.length > 0
      ? body + '\n\n' + firstHints.join('\n\n')
      : body;

    const content = [{ type: 'text', text: userText }];
    const vision = await describeImages(frame, entry);
    if (vision.error !== '') {
      // 模型不支持图片 / 图片下载失败：给用户可读报错，引导去插件设置切换模型
      sendReply(frame, vision.error);
      return;
    }
    // 两条路径共用同一段排版：
    //   * 本条消息里的每个 [图片] 占位符按顺序换成 [图片<文件名>]（内容 sha1，与落盘文件同名），
    //     模型才分得清「这条消息里第几张图」；
    //   * 被回复消息的图片属于别的消息（可能是别人发的），单列一段，不占正文占位符；
    //   * 图片文件路径照旧列出，供 qq_imgsearch 之类的工具按路径反搜。
    const ownNames = Array.isArray(vision.ownNames) ? vision.ownNames : [];
    const replyNames = Array.isArray(vision.replyNames) ? vision.replyNames : [];
    const labeled = labelImagePlaceholders(userText, ownNames);
    const replyText = replyNames.length > 0
      ? '\n\n[被回复消息的图片] ' + replyNames.join('\n')
      : '';
    const imgPaths = Array.isArray(vision.paths) && vision.paths.length > 0
      ? '\n\n[图片文件] ' + vision.paths.join('\n')
      : '';
    // 图片描述统一归到消息底部：正文里只留 [图片<文件名>] 标记，描述集中在 [图片描述] 段，
    // 用文件名对号入座——不往聊天正文里掺描述，正文读起来还是人说的话。
    const descItems = Array.isArray(vision.descriptions) ? vision.descriptions : [];
    const descText = descItems.length > 0
      ? '\n\n[图片描述]\n' + descItems.map((item) => (item.isOwn === true ? '' : '（被回复消息）')
        + '<' + item.name + '> ' + item.text).join('\n\n')
      : '';
    if (Array.isArray(vision.imageBlocks) && vision.imageBlocks.length > 0) {
      // 「留空复用会话模型」路径：图片作为附件随这条 user 消息一起提交，会话模型自己看图。
      content[0] = { type: 'text', text: labeled + replyText + imgPaths + descText
        + '\n\n（本条消息的图片已作为附件随消息提交，直接看图作答；需确认身份时自行提炼关键词调用 qq_websearch / qq_imgsearch 查找（漫画用 kind=comic），尽量勿凭空猜测。）' };
      for (const block of vision.imageBlocks) content.push(block);
    } else if (vision.text !== '' || descText !== '') {
      // 显式识图模型路径：正文只带 [图片<文件名>] 标记，描述统一放底部 [图片描述] 段。
      content[0] = { type: 'text', text: labeled + replyText + imgPaths + descText
        + '\n\n（本条消息含图片。请结合用户发言作答；自行提炼关键词调用qq_websearch qq_imgsearch进行查找（漫画用 kind=comic），尽量勿凭空猜测。）' };
    }
    const message = {
      id: uid('qqmsg'),
      role: 'user',
      content,
      source: { kind: 'user' },
    };

    let acked = false;
    let cancelAck = null;
    if (getConfig().reply.ackAfterMs > 0 && getConfig().reply.ackText !== '') {
      try {
        cancelAck = ctx.timeout(() => { acked = true; sendReply(frame, getConfig().reply.ackText); }, getConfig().reply.ackAfterMs);
      } catch { /* 定时器不可用就跳过 */ }
    }

    // 流式：只有「官方 v2 + 私聊 + 有被动回复 msg_id + 开关打开」才走；其它协议保持原来的分段回复。
    const streamOn = shouldStream({
      protocol: getConfig().protocol,
      streaming: getConfig().protocols.qqOfficial !== undefined && getConfig().protocols.qqOfficial !== null && getConfig().protocols.qqOfficial.streaming === true,
      isGroup: frame.message_type === 'group',
      messageId: frame.message_id,
    });
    const streamKey = streamOn === true ? ('o:' + String(frame.user_id) + ':' + String(frame.message_id)) : null;
    let streamedText = '';
    const onInterim = streamKey === null ? null : (fragment) => {
      streamedText += String(fragment);
      streamBridge.push(streamKey, null, String(fragment));
    };
    if (streamKey !== null) {
      streamBridge.push(streamKey, { messageType: 'private', targetId: String(frame.user_id), msgId: String(frame.message_id) }, '');
    }
    // 中间发言：回合没跑完时，模型先说的那几句单独发出去（不引用、不 @）。
    const stopInterim = startInterimLoop(entry, frame, message.id, onInterim);
    try {
      entry.agent.followup(message);
      await entry.agent.whenIdle();
    } finally {
      stopInterim();
      if (typeof cancelAck === 'function') cancelAck();
    }

    const reply = extractReply(entry.agent, message.id);
    if (reply === '') {
      // 失败提示总是作为正式回复发出（即使 ack 已发过「正在处理」也不吞掉结论）
      sendReply(frame, '（本轮没有产生文字回复：' + lastTurnReason(entry.agent) + '）');
      // 这一支以前直接 return，跳过了下面的缓存清理：失败的回合一定留图。
      await cleanupImageCache(entry);
      return;
    }
    if (streamKey !== null) {
      // 最后一帧用 done 收尾：把中间没发到的剩余文本补进去（官方流式是全量替换）。
      const rest = streamedText !== '' && reply.startsWith(streamedText) ? reply.slice(streamedText.length) : (streamedText === '' ? reply : reply);
      if (rest !== '') streamBridge.push(streamKey, null, rest);
      const ended = await streamBridge.end(streamKey);
      if (ended === null || ended.ok !== true) {
        // 桥没发出任何帧（例如官方接口拒绝）：退化为普通发送，保证用户至少拿到一条。
        sendReply(frame, reply, quoteReply === true);
      }
    } else {
      sendReply(frame, reply, quoteReply === true);
    }
    getState().stats.replies += 1;

    // 会话结算：删除本会话缓存的图片目录（<QQ_msg>/qq-images/<会话id>/），
    // 图片仅用于本轮识图与联网查证，结算后不留残留；会话与工作区保留。
    await cleanupImageCache(entry);
  }

  /**
   * 删掉本会话的图片缓存目录。异常/中断的回合走不到这里，靠启动后的定期 sweep 兜底
   * （见 sweepStaleImages），这里只负责「正常收尾时立刻清掉」。
   */
  async function cleanupImageCache(entry) {
    const imgRoot = imageCacheDir(entry !== null && entry !== undefined && entry.sessionId ? entry.sessionId : 'default');
    try {
      // 路径已由 safeSessionId 净化；删除前再复核一次归属，绝不递归删 QQ_msg 之外的东西。
      if (isInside(join(qqMsgRootSync(), 'qq-images'), imgRoot) !== true) {
        console.log(TAG + ' 图片缓存目录越界，拒绝删除：' + imgRoot);
        return;
      }
      await fsPromises.rm(imgRoot, { recursive: true, force: true });
    } catch (cleanErr) {
      console.log(TAG + ' 图片缓存清理失败：' + describeError(cleanErr));
    }
  }

  const IMAGE_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
  const IMAGE_SWEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

  /**
   * 图片缓存的兜底收尸：回合抛异常、被取消、或者 qq_draw 的 gen 目录，都不会走
   * cleanupImageCache。这里按 mtime 清掉 24 小时以上的东西——正常回合结束就删了，
   * 剩下的按定义都是漏网的。只动 <QQ_msg>/qq-images 之下，不做递归越界。
   */
  async function sweepStaleImages() {
    const root = join(qqMsgRootSync(), 'qq-images');
    const now = Date.now();
    let entries;
    try { entries = await fsPromises.readdir(root, { withFileTypes: true }); } catch { return; }
    let removed = 0;
    for (const ent of entries) {
      const abs = join(root, ent.name);
      try {
        const st = await fsPromises.stat(abs);
        if (now - st.mtimeMs <= IMAGE_SWEEP_MAX_AGE_MS) continue;
        if (ent.isDirectory()) await fsPromises.rm(abs, { recursive: true, force: true });
        else await fsPromises.rm(abs, { force: true });
        removed += 1;
      } catch { /* 正在被写真删不掉，下一轮再说 */ }
    }
    if (removed > 0) console.log(TAG + ' 清理过期图片缓存 ' + removed + ' 项');
  }

  function scheduleImageSweep() {
    const tick = () => {
      void sweepStaleImages().catch((error) => {
        console.log(TAG + ' 图片缓存清理失败：' + describeError(error));
      });
      try { ctx.timeout(tick, IMAGE_SWEEP_INTERVAL_MS); } catch { /* 插件已卸载 */ }
    };
    try { ctx.timeout(tick, 8000); } catch { /* 定时器不可用就跳过 */ }
  }

  /** 只取 afterId（本条用户消息 id）之后新增的 assistant 文本；本轮无回复返回 ''，绝不回退重发上一轮内容 */
  function extractReply(agent, afterId) {
    const session = (agent === null || agent === undefined) ? null : agent.session;
    if (session === null || session === undefined || typeof session.deriveMessages !== 'function') return '';
    const messages = session.deriveMessages();
    if (!Array.isArray(messages)) return '';
    let start = 0;
    if (afterId !== undefined && afterId !== null) {
      const at = messages.findIndex((m) => m !== null && typeof m === 'object' && m.id === afterId);
      if (at < 0) return '';      // 锚点不在日志里：宁可不回，也不回退到上一轮内容
      start = at + 1;
    }
    for (let index = messages.length - 1; index >= start; index -= 1) {
      const message = messages[index];
      if (message === null || typeof message !== 'object' || message.role !== 'assistant') continue;
      if (!Array.isArray(message.content)) continue;
      let text = '';
      for (const block of message.content) {
        if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') text += block.text;
      }
      if (text.trim() !== '') return text.trim();
    }
    return '';
  }

  /** 把 turn/end reason 清洗成一句话：只保留失败号（400/503/429…），隐藏 request id 等敏感内容 */
  function lastTurnReason(agent) {
    try {
      const session = agent.session;
      const events = session.snapshotEvents(0, session.seq);
      for (let index = events.length - 1; index >= 0; index -= 1) {
        if (events[index].type === 'turn/end') return summarizeTurnReason(events[index].data.reason);
      }
      return '本回合未结束（' + String(events.length) + ' 个事件）';
    } catch (error) {
      return '读取日志失败：' + describeError(error);
    }
  }

  /** 协议 id 归一：纯数字转 number，其余（qq-official 的 ROBOT1.0_… 之类）原样保留字符串。 */


  // runTurn 必须导出：auth-flow 的「授权后续跑」经 getRunTurn() 调它（接在 plugin.js 的
  // `getRunTurn: () => turnRuntime.runTurn`）。漏掉这一个键不会报错，只会被那边的 .catch
  // 吞成一行「授权后续跑失败」——用户侧表现为动态码用掉了、被拦下的任务再也没继续。
  return { acceptMessage, scheduleImageSweep, runTurn };
}
