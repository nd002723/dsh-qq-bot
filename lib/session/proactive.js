// 主动发言（可选）：把「要不要接话、接什么」的判断做成纯逻辑，便于单测。
// 实际取历史、调模型、发消息都在 gateway/plugin.js；这里只负责：时间窗 / 消息清洗 / 摘要 / 提示词 / 决策解析 / 发言校验 / 频率闸。

export function parseClock(text) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(text === undefined || text === null ? '' : text));
  if (m === null) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mi) || h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}

export function nowMinutes(date) {
  const d = date === undefined || date === null ? new Date() : date;
  return d.getHours() * 60 + d.getMinutes();
}

/** 解析免打扰时段：['23:00-08:00', '12:00-13:30'] -> [{start,end}]，跨零点也支持。 */
export function parseQuietRanges(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    const m = /^\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*$/.exec(String(item === undefined || item === null ? '' : item));
    if (m === null) continue;
    const start = parseClock(m[1]);
    const end = parseClock(m[2]);
    if (start === null || end === null) continue;
    out.push({ start, end });
  }
  return out;
}

export function isQuiet(minutesNow, list) {
  const ranges = parseQuietRanges(list);
  for (const r of ranges) {
    if (r.start === r.end) continue;
    if (r.start < r.end) {
      if (minutesNow >= r.start && minutesNow < r.end) return true;
    } else if (minutesNow >= r.start || minutesNow < r.end) {
      return true;
    }
  }
  return false;
}

/** OneBot 消息段 -> 纯文本（图片/表情给占位符）。 */
export function summarizeSegments(segments) {
  if (!Array.isArray(segments)) return '';
  const parts = [];
  for (const seg of segments) {
    if (seg === null || typeof seg !== 'object') continue;
    const type = String(seg.type === undefined ? '' : seg.type).toLowerCase();
    const data = seg.data === undefined || seg.data === null ? {} : seg.data;
    if (type === 'text') parts.push(String(data.text === undefined ? '' : data.text));
    else if (type === 'at') parts.push('@' + String(data.qq === undefined ? '' : data.qq));
    else if (type === 'image') parts.push('[图片]');
    else if (type === 'face' || type === 'mface') parts.push('[表情]');
    else if (type === 'file') parts.push('[文件]');
    else if (type === 'forward') parts.push('[转发]');
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

export function normalizeMessages(raw, selfId) {
  const out = [];
  if (!Array.isArray(raw)) return out;
  const self = String(selfId === undefined || selfId === null ? '' : selfId);
  for (const m of raw) {
    if (m === null || typeof m !== 'object') continue;
    const sender = m.sender !== null && m.sender !== undefined && typeof m.sender === 'object' ? m.sender : {};
    const userId = String(m.user_id !== undefined && m.user_id !== null ? m.user_id : (sender.user_id === undefined ? '' : sender.user_id));
    const nickname = String(sender.card !== undefined && sender.card !== '' ? sender.card : (sender.nickname === undefined ? '' : sender.nickname));
    const text = summarizeSegments(m.message);
    if (text === '') continue;
    out.push({
      id: Number(m.message_id),
      time: Number(m.time) || 0,
      userId,
      nickname,
      text,
      isSelf: self !== '' && userId === self,
    });
  }
  // NapCat 的 get_group_msg_history 是「最新在前」（mock 里也一样），而 analyzeEvent / buildDigest /
  // buildPrompt 都按「旧→新」理解这份数组。这里统一纠正方向，时间相同就按 message_id 稳定排序。
  out.sort((a, b) => (a.time - b.time) || (((Number(a.id) || 0) - (Number(b.id) || 0))));
  return out;
}

/** 只保留比 sinceTime 更新的消息（严格大于）。 */
export function newerThan(messages, sinceTime) {
  const since = Number(sinceTime) || 0;
  return (Array.isArray(messages) ? messages : []).filter((m) => m.time > since);
}

export function buildDigest(messages, maxLines) {
  const limit = Math.max(1, Math.floor(Number(maxLines) || 20));
  const list = (Array.isArray(messages) ? messages : []).slice(-limit);
  const lines = [];
  for (const m of list) {
    const d = m.time > 0 ? new Date(m.time * 1000) : null;
    const hh = d === null ? '--:--' : String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    const who = m.nickname !== '' ? m.nickname : ('QQ' + m.userId);
    const text = String(m.text).replace(/\s+/g, ' ').slice(0, 160);
    lines.push('[' + hh + '] ' + who + '：' + text);
  }
  return lines.join('\n');
}

/** 模型给的表情包关键词：去换行 / 去标点尾巴，最多 24 字；「无 / none / null」当没给。 */
export function sanitizeStickerQuery(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).replace(/[\r\n]+/g, ' ').trim();
  if (text === '') return '';
  const lower = text.toLowerCase();
  if (['无', '没有', 'none', 'null', 'false', '0', '-'].includes(lower)) return '';
  return text.slice(0, 24);
}

/**
 * 主动发言发表情包的发送方式：随机选「图文合并成一条」或「先图后字两条」。
 * 两种观感不同，随机让群里不那么机械；random 注入便于测试。
 * @param {() => number} [random]
 * @returns {'together'|'separate'}
 */
export function pickStickerSendStyle(random) {
  const value = typeof random === 'function' ? Number(random()) : Math.random();
  return value < 0.5 ? 'together' : 'separate';
}

export function buildPrompt(input) {
  const data = input === undefined || input === null ? {} : input;
  const persona = typeof data.persona === 'string' ? data.persona.trim() : '';
  const interests = typeof data.interests === 'string' ? data.interests.trim() : '';
  const digest = typeof data.digest === 'string' ? data.digest : '';
  const maxChars = Math.max(20, Math.floor(Number(data.maxChars) || 120));
  const head = persona !== ''
    ? '你在 QQ 群里的设定：' + persona
    : '你是 QQ 群里的一个普通成员，有自己的脾气和兴趣。';
  const like = interests !== '' ? '\n你偏好的话题：' + interests : '';
  const age = Math.max(0, Math.floor(Number(data.eventAgeMinutes) || 0));
  const recent = Array.isArray(data.recentTopics) ? data.recentTopics.map((x) => String(x)).filter((x) => x !== '').slice(-3) : [];
  const freshness = age > 0 ? '\n注意：最新一条消息已经是 ' + age + ' 分钟前发的了。' : '';
  const noRepeat = recent.length > 0 ? '\n你最近已经聊过这些话题：' + recent.join('、') + '，不要再重复。' : '';
  // 表情包：只有调用方确认「图库可用」时才让模型给关键词，否则纯文本路径不浪费 token。
  const wantSticker = data.sticker === true;
  const stickerLine = wantSticker
    // 关键词要往「图库打得出来的词」上引：图库标签以情绪/反应/场景为主，
    // 具体物件、专有名词（辣、内存条、某个人名）命中率极低，直接导致 pick 返回 null。
    ? '\n如果你觉得这时候配一张表情包更合适，就在 sticker 里给 1-3 个常见的中文情绪、反应或场景词'
      + '（例如「无语」「开心」「卖萌」「累瘫」「摸鱼」「被夸」）；'
      + '优先用群里常说的通用词，不要写具体物件、专有名词或生僻组合；不想配就留空字符串。'
    : '';
  const stickerField = wantSticker ? ', "sticker": "表情包关键词或空字符串"' : '';
  return head + like + freshness + noRepeat + stickerLine + '\n'
    + '下面是群里最近的消息。看看有没有你愿意接一句的话题：只在真的感兴趣、接得上时才说话，没有就别说。\n'
    + '不要接：没营养的刷屏、吵架、敏感话题、广告、看不懂的梗、只针对某个人又没头没尾的话。\n'
    + '不要复述别人的话，不要 @ 人，不要发链接，不要提 AI。一条消息，口语，最多 ' + maxChars + ' 字。\n'
    + 'topic 只能来自上面聊天记录里出现过的事；不要虚构自己做过什么，没得接就 speak=false。\n'
    + '如果这件事已经有人（包括别的 AI）回应过，或者已经过去很久，就不要再说一遍——宁可不说。\n\n'
    + '最近消息（旧→新）：\n' + digest + '\n\n'
    + '只输出 JSON，不要解释：{"speak": true 或 false, "topic": "想接什么", "message": "要说的话"' + stickerField + '}';
}

function normalizeJsonText(raw) {
  return String(raw)
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\uFF1A/g, ':')
    .replace(/\uFF0C/g, ',')
    .replace(/,\s*([}\]])/g, '$1');
}

function jsonCandidates(text) {
  const out = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j += 1) {
      const ch = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) { out.push(text.slice(i, j + 1)); break; }
      }
    }
  }
  return out;
}

export function parseDecision(text) {
  const raw = String(text === undefined || text === null ? '' : text).trim();
  if (raw === '') return null;
  const stripped = raw.split(String.fromCharCode(96)).join('').trim();
  const sources = [stripped];
  const inner = stripped.slice(stripped.indexOf('{'), stripped.lastIndexOf('}') + 1);
  if (inner !== '' && inner !== stripped) sources.push(inner);
  for (const src of sources) {
    for (const candidate of jsonCandidates(src)) {
      let data = null;
      try { data = JSON.parse(normalizeJsonText(candidate)); } catch (error) { continue; }
      if (data === null || typeof data !== 'object') continue;
      const speakRaw = data.speak !== undefined ? data.speak
        : (data.join !== undefined ? data.join
          : (data.reply !== undefined ? data.reply : data.say));
      const hasKey = data.speak !== undefined || data.join !== undefined || data.reply !== undefined || data.say !== undefined
        || data.message !== undefined || data.text !== undefined || data.topic !== undefined;
      if (hasKey !== true) continue;
      const speak = speakRaw === true || speakRaw === 'true';
      const message = String(data.message !== undefined ? data.message : (data.text !== undefined ? data.text : (data.say !== undefined ? data.say : ''))).trim();
      const topic = String(data.topic !== undefined ? data.topic : '').trim().slice(0, 80);
      const why = String(data.why !== undefined ? data.why : (data.reason !== undefined ? data.reason : '')).trim().slice(0, 160);
      const sticker = sanitizeStickerQuery(data.sticker);
      return { speak, topic, message, why, sticker };
    }
  }
  return null;
}

// 结构性判据：整句不含任何 CJK 字符，基本可以断定是模型掉进了英文拒答模板。
// 只在显式要求（requireCjk）时启用——默认关，保证单段 / 既有部署行为不变。
// CJK 判据用 Unicode 属性转义：手写区间会漏掉 々（U+3005）与扩展 B 区（U+20000 起）。
const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
// 长度阈值写成常量而不是配置：正常 ASCII 短回应（666 / 233 / OK / lol / yyds）基本 ≤ 10，
// 整句英文拒绝语基本 ≥ 20，12 是安全中点。再开一个调参字段不值得。
const CJK_MIN_LENGTH = 12;
// 长度按码点计，不是 UTF-16 码元：emoji 和扩展 B 区生僻字在码元里各占两位，
// 用 text.length 会把「ok 👍👍👍👍👍」这种视觉 8 个字的短回应当成长句拦掉。
const charLength = (text) => Array.from(String(text)).length;

export function validateMessage(message, options) {
  const opts = options === undefined || options === null ? {} : options;
  const maxChars = Math.max(20, Math.floor(Number(opts.maxChars) || 120));
  const text = String(message === undefined || message === null ? '' : message).replace(/\s+\n/g, '\n').trim();
  if (text === '') return { ok: false, reason: '空内容' };
  if (charLength(text) > maxChars) return { ok: false, reason: '超过长度上限 ' + maxChars };
  if (/https?:\/\/|www\./i.test(text)) return { ok: false, reason: '含链接' };
  if (/@\d{5,}/.test(text)) return { ok: false, reason: '含 @' };
  if (/(作为|我是).{0,6}(ai|人工智能|语言模型|助手)/i.test(text)) return { ok: false, reason: '自称 AI' };
  if (/^[\s\p{P}\p{S}]+$/u.test(text)) return { ok: false, reason: '无实质内容' };
  const norm = text.toLowerCase().replace(/\s+/g, '').replace(/[，。！？、；：,.!?;:~～]/g, '');
  const recent = Array.isArray(opts.recentTexts) ? opts.recentTexts : [];
  for (const old of recent) {
    const o = String(old === undefined || old === null ? '' : old).toLowerCase().replace(/\s+/g, '').replace(/[，。！？、；：,.!?;:~～]/g, '');
    if (o !== '' && o === norm) return { ok: false, reason: '和上一条重复' };
  }
  // 排在最后：这是最笼统的判据，放前面会把「含链接」「无实质内容」这类更具体的原因吞掉，
  // verbose 日志里就看不出到底哪儿不对了。
  if (opts.requireCjk === true && charLength(text) > CJK_MIN_LENGTH && CJK_PATTERN.test(text) !== true) return { ok: false, reason: 'no-cjk' };
  return { ok: true, reason: '', text };
}

export function allowSend(input) {
  const data = input === undefined || input === null ? {} : input;
  const now = Number(data.now) || Date.now();
  const times = (Array.isArray(data.sentTimes) ? data.sentTimes : []).filter((t) => Number.isFinite(Number(t))).map(Number);
  const hour = Math.max(0, Math.floor(Number(data.maxPerHour) || 0));
  const day = Math.max(0, Math.floor(Number(data.maxPerDay) || 0));
  const gap = Math.max(0, Number(data.minGapMinutes) || 0) * 60000;
  const last = Number(data.lastSentAt) || 0;
  if (gap > 0 && last > 0 && now - last < gap) return { ok: false, reason: '距上次发言不足最小间隔' };
  const inHour = times.filter((t) => now - t < 3600000).length;
  if (hour > 0 && inHour >= hour) return { ok: false, reason: '每小时上限' };
  const inDay = times.filter((t) => now - t < 86400000).length;
  if (day > 0 && inDay >= day) return { ok: false, reason: '每天上限' };
  return { ok: true, reason: '' };
}

/**
 * 判断「现在这段对话还值不值得接话」。
 *
 * 规则都是确定性的，不靠模型判断——模型很容易对一件早就聊完的事再回一次：
 *   1. 最新一条如果是自己发的，说明这轮已经说过话；
 *   2. 最新一条距今超过 staleMinutes，视为事件已经过气（这段时间里人或别的 bot 大概率已经接过）；
 *   3. 最新一条太短又不像提问（"行" / "OK" / "我去修一下"），是应答而不是新话题，不插话；
 *   4. 事件起点取「同一发送者连续补话（间隔 ≤ 3 分钟）」的第一条，用来算事件年龄。
 */
export function analyzeEvent(messages, options) {
  const opts = options === undefined || options === null ? {} : options;
  const nowSec = Number(opts.nowSec) > 0 ? Number(opts.nowSec) : Math.floor(Date.now() / 1000);
  const staleMinutes = Math.max(1, Math.floor(Number(opts.staleMinutes) || 15));
  const minChars = Math.max(1, Math.floor(Number(opts.minChars) || 6));
  const list = (Array.isArray(messages) ? messages : []).filter((m) => m !== null && typeof m === 'object' && Number(m.time) > 0);
  if (list.length === 0) return { ok: false, reason: '没有消息', ageMinutes: 0, eventTime: 0 };
  const last = list[list.length - 1];
  const lastTime = Number(last.time);
  const ageMinutes = Math.max(0, Math.floor((nowSec - lastTime) / 60));
  if (last.isSelf === true) return { ok: false, reason: '最新一条是我自己发的', ageMinutes, eventTime: lastTime };
  if (ageMinutes > staleMinutes) {
    return { ok: false, reason: '最新消息已过去 ' + ageMinutes + ' 分钟（> ' + staleMinutes + ' 分钟，事件已经过气）', ageMinutes, eventTime: lastTime };
  }
  const text = String(last.text === undefined || last.text === null ? '' : last.text).trim();
  const asking = /[?？]\s*$/.test(text) || /(吗|呢|怎么|如何|什么|哪|多少|是不是|能不能)\s*[?？]?$/.test(text);
  // 上一句如果是同一个人 3 分钟内的发言，这条短句算是「补充说明」，不是应答别人。
  const prev = list.length >= 2 ? list[list.length - 2] : null;
  const continuation = prev !== null && prev.isSelf !== true && String(prev.userId) === String(last.userId) && (lastTime - Number(prev.time) <= 180);
  const replyish = text.length > 0 && text.length < minChars && asking !== true && continuation !== true;
  if (replyish === true) return { ok: false, reason: '最新一条像是应答（' + text + '），不插话', ageMinutes, eventTime: lastTime };
  // 事件起点：同一个人连着补话算同一件事
  let start = list.length - 1;
  while (start > 0) {
    const prev = list[start - 1];
    if (prev.isSelf === true || String(prev.userId) !== String(last.userId)) break;
    if (lastTime - Number(prev.time) > 180) break;
    start -= 1;
  }
  const head = list[start];
  // 场合判断：最近几条如果只有两个人在来回说，那是两个人的对话，别硬插进去。
  const pairWindow = Math.max(2, Math.floor(Number(opts.pairWindow) || 6));
  const humans = list.slice(-pairWindow).filter((m) => m.isSelf !== true);
  if (humans.length >= 4) {
    const senders = new Set(humans.map((m) => String(m.userId)));
    if (senders.size <= 2) {
      return { ok: false, reason: '最近 ' + humans.length + ' 条只有 ' + senders.size + ' 个人在说，像是他们的对话，不插话', ageMinutes, eventTime: Number(head.time) };
    }
  }
  return { ok: true, reason: '', ageMinutes, eventTime: Number(head.time) };
}

/** 话题归一化：去掉空白与标点、转小写，用于判断"这个话题是不是刚说过"。 */
export function topicKey(text) {
  return String(text === undefined || text === null ? '' : text)
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。！？、；：,.!?;:~～"'“”‘’（）()【】\[\]]/g, '')
    .slice(0, 40);
}

/** 同一话题是否在冷却时间内已经说过（避免换个说法把同一件事再回一遍）。 */
export function topicRepeated(key, topics, options) {
  const target = topicKey(key);
  if (target === '') return false;
  const opts = options === undefined || options === null ? {} : options;
  const now = Number(opts.now) || Date.now();
  const cooldownMs = Math.max(1, Number(opts.cooldownMinutes) || 120) * 60000;
  const list = Array.isArray(topics) ? topics : [];
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue;
    const at = Number(item.at) || 0;
    if (at > 0 && now - at > cooldownMs) continue;
    const old = topicKey(item.key);
    if (old === '') continue;
    if (old === target) return true;
    // 一长一短但互相包含，也当作同一话题（"老人家急诊住院" vs "住院"）；太短的 key 不参与包含判断，免得误伤。
    if (Math.min(old.length, target.length) >= 2 && (old.includes(target) || target.includes(old))) return true;
  }
  return false;
}

/**
 * 决定主动发言问哪个模型，返回 { provider, model, missing }。
 * 和识图一致：显式配置优先，留空就跟随该群会话的模型——调用统一走 DSH 内置的 ctx.llm.stream，
 * 不需要 API key，也不会另接一套 OpenAI 兼容端点。
 * missing 为空数组才表示可以真的调用。
 */
export function resolveModel(proactive, session) {
  const p = (proactive !== null && typeof proactive === 'object') ? proactive : {};
  const s = (session !== null && typeof session === 'object') ? session : {};
  const provider = String(p.provider || '').trim() || String(s.provider || '').trim();
  const model = String(p.model || '').trim() || String(s.model || '').trim();
  const missing = [];
  if (provider === '') missing.push('provider（proactive.provider，或让这个群先有过会话以便跟随会话模型）');
  if (model === '') missing.push('model（proactive.model，或让这个群先有过会话以便跟随会话模型）');
  return { provider, model, missing };
}

/**
 * 两段式（可选）的模型解析：判断与发言可以各用各的模型。
 *
 * 全部留空时与单段模式完全一致——判断阶段用 provider/model（或群会话模型），
 * 正文由判断阶段在同一次输出里给出。填了 speakProvider / speakModel 才启用两段式：
 * 判断阶段只负责出 JSON，正文交给发言模型单独写，能各取所长（便宜快的模型判断、
 * 文风更好的模型说话），也不会因为一个模型既要稳 JSON 又要有文采而两头不讨好。
 *
 * @param proactive - proactive 配置块
 * @param session - 群会话的模型选项（{provider, model}），没有会话时传 null
 * @returns {{judge: {provider: string, model: string, missing: string[]}, speak: {provider: string, model: string, missing: string[]}, twoStage: boolean}}
 */
/**
 * 主动发言的人格来源优先级（从高到低）：
 *   1. `proactive.persona`：设置页「主动发言 → 人设」，填了就是它；
 *   2. 宿主求值的 soul 人格段（dsh-soul-md 的 `soul:persona`，由宿主 assemble 求值）；
 *   3. `config.persona`（插件自己的「人格 → 身份设定」）——原有行为，垫底回退。
 * 三者都没有就返回空串，调用方不加人格段。
 *
 * @param input - {explicit, host, fallback}
 * @returns 第一个非空白值（已 trim）
 */
export function resolvePersonaText(input) {
  const data = input === null || input === undefined ? {} : input;
  const text = (value) => String(value === undefined || value === null ? '' : value).trim();
  const explicit = text(data.explicit);
  if (explicit !== '') return explicit;
  const host = text(data.host);
  if (host !== '') return host;
  return text(data.fallback);
}

export function resolveStageModels(proactive, session) {
  const p = (proactive !== null && typeof proactive === 'object') ? proactive : {};
  const pick = (first, fallback) => {
    const a = String(first === undefined || first === null ? '' : first).trim();
    if (a !== '') return a;
    return String(fallback === undefined || fallback === null ? '' : fallback).trim();
  };
  // 判断阶段沿用现有 provider / model：不再提供 judgeProvider / judgeModel——它们只是别名
  // （整组覆盖，不存在单独生效的场景），同一个模型两个入口只会增加心智负担。
  const judge = resolveModel(p, session);
  // 两段式要求 **provider 与 model 成对**：发言阶段 provider 留空 = 与判断阶段相同，
  // 这时发言模型由判断阶段决定，不接受单独配置（否则会出现「provider 是判断的、model 是别处的」错位）。
  const speakProviderText = String(p.speakProvider === undefined || p.speakProvider === null ? '' : p.speakProvider).trim();
  const speakModelText = String(p.speakModel === undefined || p.speakModel === null ? '' : p.speakModel).trim();
  const twoStage = speakProviderText !== '' && speakModelText !== '';
  const speakInput = twoStage
    ? { provider: speakProviderText, model: speakModelText }
    : { provider: judge.provider, model: judge.model };
  return { judge, speak: resolveModel(speakInput, session), twoStage };
}

/**
 * 发言阶段的提示词（两段式专用）：判断已经决定要接、接什么，这里只负责把正文写出来。
 *
 * @param input - {persona, digest, topic, maxChars}
 * @returns 发给模型的一段纯文本提示
 */
export function buildSpeakPrompt(input) {
  const data = (input !== null && typeof input === 'object') ? input : {};
  const persona = typeof data.persona === 'string' ? data.persona.trim() : '';
  const digest = typeof data.digest === 'string' ? data.digest : '';
  const topic = typeof data.topic === 'string' ? data.topic.trim() : '';
  const maxChars = Math.max(20, Math.floor(Number(data.maxChars) || 120));
  const head = persona !== '' ? ('你在 QQ 群里的设定：' + persona + '\n\n') : '';
  const focus = topic !== '' ? ('你想接的话题：' + topic + '\n') : '';
  return head
    + '下面是群里最近的公开聊天记录（旧→新）：\n' + digest + '\n\n'
    + focus
    + '写一句自然的群聊发言回应上面的话题，最多 ' + maxChars + ' 字。\n'
    + '不要复述别人的话，不要 @ 人，不要发链接，不要提 AI，不要解释自己，也不要输出 JSON 或任何格式标记。\n'
    + '只使用上面聊天记录里的信息，不要编造具体事实（你自己的经历、时间、地点、金额、别人的事）；没有可说的就泛泛接一句，别现编故事。\n'
    + '只输出这句话本身。';
}

/**
 * 两段式的发言阶段：最多试 attempts 次，接受第一次通过校验的正文；全都没通过时按 fallback 决定是否回退。
 *
 * 抽成独立函数是为了让这段胶水可测——此前只有生产实例肉眼验证过：
 * 「重试 2 次 → 全被拦 → 回退判断正文 → 判断正文也不可用则放弃」这条链最容易写错又最难发现。
 *
 * @param {{ call?: (index: number) => Promise<string>|string, validate?: (raw: any) => { ok: boolean, reason?: string, text?: string }, attempts?: number, fallback?: { enabled?: boolean, ok?: boolean, text?: string }, onBlocked?: (index: number, checked: any) => void, onFallback?: () => void }} [options]
 *   call(i)：第 i 次（0 起）取正文，返回模型原始文本；
 *   validate(raw)：校验器，返回 {ok, reason, text}；
 *   fallback：{enabled, ok, text} —— 判断阶段那句正文是否可用、是否允许回退；
 *   onBlocked(i, checked) / onFallback()：日志钩子。
 * @returns {Promise<{ text: string, used: 'speak'|'fallback'|'none', attempts: number }>} used 取 speak / fallback / none
 */
export async function runSpeakStage(options) {
  const o = (options !== undefined && options !== null && typeof options === 'object') ? options : {};
  const call = typeof o.call === 'function' ? o.call : async () => '';
  const validate = typeof o.validate === 'function' ? o.validate : () => ({ ok: false, reason: 'no-validator', text: '' });
  const attempts = Math.max(1, Math.floor(Number(o.attempts) || 1));
  const onBlocked = typeof o.onBlocked === 'function' ? o.onBlocked : () => {};
  const onFallback = typeof o.onFallback === 'function' ? o.onFallback : () => {};
  const fb = (o.fallback !== undefined && o.fallback !== null && typeof o.fallback === 'object') ? o.fallback : {};
  for (let i = 0; i < attempts; i += 1) {
    const raw = await call(i);
    const checked = validate(raw);
    if (checked !== null && typeof checked === 'object' && checked.ok === true) {
      return { text: String(checked.text), used: 'speak', attempts: i + 1 };
    }
    onBlocked(i, checked);
  }
  if (fb.enabled !== false && fb.ok === true && typeof fb.text === 'string' && fb.text !== '') {
    onFallback();
    return { text: fb.text, used: 'fallback', attempts };
  }
  return { text: '', used: 'none', attempts };
}
