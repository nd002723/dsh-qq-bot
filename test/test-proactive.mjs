// 主动发言：时间窗 / 消息清洗 / 摘要 / 提示词 / 决策解析 / 发言校验 / 频率闸。
import {
  parseClock, parseQuietRanges, isQuiet, summarizeSegments,
  normalizeMessages, newerThan, buildDigest, buildPrompt, parseDecision, runSpeakStage,
  validateMessage, allowSend, analyzeEvent, topicKey, topicRepeated, resolveStageModels, buildSpeakPrompt, resolveModel,
  resolvePersonaText, sanitizeStickerQuery, pickStickerSendStyle,
} from '../lib/session/proactive.js';

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail === undefined ? '' : ' -> ' + detail)); }
}

check('parseClock 23:00', parseClock('23:00') === 1380);
check('parseClock 非法', parseClock('25:00') === null && parseClock('x') === null);
check('parseQuietRanges 跨零点', JSON.stringify(parseQuietRanges(['23:00-08:00'])) === JSON.stringify([{ start: 1380, end: 480 }]));

check('免打扰：23:30 属于 23:00-08:00', isQuiet(23 * 60 + 30, ['23:00-08:00']) === true);
check('免打扰：07:59 属于', isQuiet(7 * 60 + 59, ['23:00-08:00']) === true);
check('免打扰：08:00 不属于', isQuiet(8 * 60, ['23:00-08:00']) === false);
check('免打扰：12:00 不属于', isQuiet(12 * 60, ['23:00-08:00']) === false);
check('免打扰：多段', isQuiet(13 * 60, ['12:00-13:30']) === true && isQuiet(14 * 60, ['12:00-13:30']) === false);

const segText = summarizeSegments([{ type: 'text', data: { text: '你好' } }, { type: 'at', data: { qq: '123' } }, { type: 'image', data: {} }]);
check('消息段摘要', segText.includes('你好') && segText.includes('@123') && segText.includes('[图片]'), segText);
const rawMsgs = [
  { message_id: 1, time: 1000, user_id: 22222, sender: { nickname: '小明', card: '' }, message: [{ type: 'text', data: { text: '第一条' } }] },
  { message_id: 2, time: 1001, user_id: 10000, sender: { nickname: 'bot', card: '' }, message: [{ type: 'text', data: { text: '自己的' } }] },
];
const msgs = normalizeMessages(rawMsgs, '10000');
check('normalizeMessages 映射字段', msgs.length === 2 && msgs[0].nickname === '小明' && msgs[0].userId === '22222' && msgs[0].time === 1000);
check('normalizeMessages 标记自己', msgs[1].isSelf === true && msgs[0].isSelf === false);
const newer = newerThan(msgs, 1000);
check('newerThan 只留更新的', newer.length === 1 && newer[0].id === 2);

const digest = buildDigest(msgs, 5);
check('buildDigest 含昵称与正文', digest.includes('小明') && digest.includes('第一条') && digest.split('\n').length === 2, digest);

const prompt = buildPrompt({ persona: '一只猫娘', interests: '游戏', digest: '[10:00] 小明：在吗', maxChars: 80 });
check('buildPrompt 含人设/偏好/摘要', prompt.includes('一只猫娘') && prompt.includes('游戏') && prompt.includes('在吗'));
check('buildPrompt 含 JSON 指令与长度', prompt.includes('speak') && prompt.includes('80'));
check('buildPrompt 约束话题来源（不许虚构经历）', prompt.includes('topic 只能来自') && prompt.includes('不要虚构自己做过什么'));

const d1 = parseDecision('{"speak":true,"topic":"游戏","message":"我也在"}');
check('parseDecision 正常 JSON', d1 !== null && d1.speak === true && d1.message === '我也在' && d1.topic === '游戏');
const fence = String.fromCharCode(96).repeat(3);
const d2 = parseDecision(fence + 'json\n{"speak":false}\n' + fence);
check('parseDecision 去掉代码块', d2 !== null && d2.speak === false);
check('parseDecision 非法返回 null', parseDecision('不是 JSON') === null);

// 历史消息方向：NapCat 是最新在前，归一化必须纠正成升序，否则事件闸/提示词全看错消息
const nowSec2 = Math.floor(Date.now() / 1000);
const rawNewestFirst = [
  { message_id: 3, time: nowSec2 - 60, user_id: 3, sender: { nickname: '丙' }, message: [{ type: 'text', data: { text: '你们几点到？' } }] },
  { message_id: 2, time: nowSec2 - 300, user_id: 2, sender: { nickname: '乙' }, message: [{ type: 'text', data: { text: '还早' } }] },
  { message_id: 1, time: nowSec2 - 600, user_id: 1, sender: { nickname: '甲' }, message: [{ type: 'text', data: { text: '下午打球吗' } }] },
];
const ordered = normalizeMessages(rawNewestFirst, null);
check('归一化把「最新在前」纠正为升序', ordered.length === 3 && ordered[0].time < ordered[1].time && ordered[2].time === nowSec2 - 60, JSON.stringify(ordered.map((m) => m.time)));
check('事件闸按最新一条算时效', Math.abs(analyzeEvent(ordered, { nowSec: nowSec2, staleMinutes: 15 }).ageMinutes - 1) <= 1);
check('摘要最后一行是最新消息', buildDigest(ordered, 3).trim().split(String.fromCharCode(10)).pop().includes('几点到'));
// 同秒连发：time 相同就只能靠 message_id 定先后；排序反了会把「最早那条」当成最新一条。
const sameSec = nowSec2 - 30;
const sameSecond = normalizeMessages([
  { message_id: 12, time: sameSec, user_id: 2, sender: { nickname: '乙' }, message: [{ type: 'text', data: { text: '行' } }] },
  { message_id: 11, time: sameSec, user_id: 1, sender: { nickname: '甲' }, message: [{ type: 'text', data: { text: '下午打球吗？' } }] },
], null);
check('同秒消息按 message_id 升序（id 小的先发）',
  sameSecond.length === 2 && Number(sameSecond[0].id) === 11 && Number(sameSecond[1].id) === 12,
  JSON.stringify(sameSecond.map((m) => m.id)));
check('同秒两条时认最后一条为最新（短应答 → 不接）',
  analyzeEvent(sameSecond, { nowSec: nowSec2, staleMinutes: 15 }).ok === false);
check('validateMessage 正常', validateMessage('这游戏我也在玩', { maxChars: 50 }).ok === true);
check('validateMessage 超长', validateMessage('很长'.repeat(60), { maxChars: 50 }).ok === false);
check('validateMessage 链接', validateMessage('看这个 https://x.com', { maxChars: 50 }).ok === false);
check('validateMessage @人', validateMessage('@123456 你说的对', { maxChars: 50 }).ok === false);
check('validateMessage 自称 AI', validateMessage('作为一个AI我觉得', { maxChars: 50 }).ok === false);
check('validateMessage 重复上一条', validateMessage('这游戏我也在玩', { maxChars: 50, recentTexts: ['这游戏我也在玩。'] }).ok === false);

// requireCjk：默认关（既有行为不变）；开启后「无 CJK 且长度 > 12」判不可用
// 注意：除了专门测边界的两条，其余正例都必须 > 12 字符——长度门槛在 CJK 判据里最前面，
// 短串会被短路掉、根本走不到字符集检测，写出来是「看着绿但什么都没验」。
const refusal = "Sorry, it looks like I can't chat about this.";
check('requireCjk 默认关：英文正文照旧放行', validateMessage(refusal, { maxChars: 200 }).ok === true);
check('requireCjk 开启：整句英文被判不可用', (() => { const r = validateMessage(refusal, { maxChars: 200, requireCjk: true }); return r.ok === false && r.reason === 'no-cjk'; })());
check('requireCjk 开启：中文放行（14 字，过长度门槛）', validateMessage('明天记得带伞，别又忘了带钥匙', { maxChars: 50, requireCjk: true }).ok === true);
check('requireCjk 开启：日文放行（14 字）', validateMessage('いいよ、またね、気をつけてね', { maxChars: 50, requireCjk: true }).ok === true);
check('requireCjk 开启：中英混排放行（13 字）', validateMessage('那就用 OK 呗，我先撤啦', { maxChars: 50, requireCjk: true }).ok === true);
check('requireCjk 开启：纯 々 串放行（真验到 U+3005）', validateMessage('々'.repeat(13), { maxChars: 50, requireCjk: true }).ok === true);
check('requireCjk 开启：扩展 B 区生僻字放行（真验到 u 标志）', validateMessage('𠀀'.repeat(13), { maxChars: 50, requireCjk: true }).ok === true);
check('requireCjk 开启：emoji 短回应按码点算长度，不误拦', validateMessage('ok 👍👍👍👍👍', { maxChars: 50, requireCjk: true }).ok === true);
// 判据顺序：no-cjk 必须排在最后，否则纯符号串会被报成 "no-cjk" 而不是 "无实质内容"。
check('requireCjk 开启：纯符号串仍报「无实质内容」（no-cjk 不吞具体原因）',
  validateMessage('！'.repeat(15), { maxChars: 50, requireCjk: true }).reason === '无实质内容');
check('requireCjk 开启：超长英文报长度而不是 no-cjk',
  validateMessage('a'.repeat(80), { maxChars: 50, requireCjk: true }).reason === '超过长度上限 50');
check('requireCjk 边界：12 字符整句英文放行（门槛左）', validateMessage('abcdefghijkl', { maxChars: 50, requireCjk: true }).ok === true);
check('requireCjk 边界：13 字符整句英文拦住（门槛右）', (() => { const r = validateMessage('abcdefghijklm', { maxChars: 50, requireCjk: true }); return r.ok === false && r.reason === 'no-cjk'; })());
// maxChars 也按码点：「ok + 58 个 👍」是 60 码点 / 118 码元，按码元算会被误判超长。
check('长度上限按码点：60 码点 / 118 码元在 maxChars=60 下放行',
  validateMessage('ok' + '👍'.repeat(58), { maxChars: 60 }).ok === true);
check('长度上限按码点：61 码点仍然拦住',
  validateMessage('ok' + '👍'.repeat(59), { maxChars: 60 }).reason === '超过长度上限 60');

const now = Date.now();
check('allowSend 正常放行', allowSend({ now, sentTimes: [], lastSentAt: 0, maxPerHour: 2, maxPerDay: 4, minGapMinutes: 10 }).ok === true);
check('allowSend 间隔不足', allowSend({ now, sentTimes: [now - 60000], lastSentAt: now - 60000, maxPerHour: 2, maxPerDay: 4, minGapMinutes: 10 }).ok === false);
check('allowSend 每小时上限', allowSend({ now, sentTimes: [now - 120000, now - 180000], lastSentAt: 0, maxPerHour: 2, maxPerDay: 10, minGapMinutes: 0 }).ok === false);
check('allowSend 每天上限', allowSend({ now, sentTimes: [now - 7200000, now - 7300000, now - 7400000], lastSentAt: 0, maxPerHour: 10, maxPerDay: 3, minGapMinutes: 0 }).ok === false);
// ---- 事件闸：过气的/只是应答的/自己刚说过的，都不接 ----
const nowSec = Math.floor(Date.now() / 1000);
const ev = (over) => analyzeEvent(over, { nowSec, staleMinutes: 15 });
check('事件闸：空列表不接', ev([]).ok === false);
check('事件闸：最新是我自己', ev([{ time: nowSec - 30, userId: '1', text: '我自己说的', isSelf: true }]).ok === false);
check('事件闸：事件已过气（30 分钟）', ev([{ time: nowSec - 1800, userId: '1', text: '老人进急诊住院了', isSelf: false }]).ok === false);
check('事件闸：短应答不插话', ev([{ time: nowSec - 30, userId: '1', text: '行', isSelf: false }]).ok === false);
check('事件闸：短提问可以接', ev([{ time: nowSec - 30, userId: '1', text: '严重吗？', isSelf: false }]).ok === true);
check('事件闸：正常新事件可接', ev([{ time: nowSec - 30, userId: '1', text: '今天开黑有人来吗', isSelf: false }]).ok === true);
const seg = ev([
  { time: nowSec - 200, userId: '1', text: '我老人进急诊住院了', isSelf: false },
  { time: nowSec - 120, userId: '1', text: '给陪护', isSelf: false },
]);
check('事件闸：同一人连续发言算同一事件（取第一条时间）', seg.ok === true && Math.abs((nowSec - 200) - seg.eventTime) <= 1);

// ---- 话题去重：同一件事换个说法也别再说一遍 ----
check('topicKey 归一化', topicKey('老人家急诊住院。') === topicKey('老人家 急诊住院'));
check('topicRepeated 命中冷却内', topicRepeated('住院', [{ at: Date.now() - 60000, key: '老人家住院' }], { now: Date.now(), cooldownMinutes: 120 }) === true);
check('topicRepeated 超过冷却不命中', topicRepeated('住院', [{ at: Date.now() - 3 * 3600 * 1000, key: '老人家住院' }], { now: Date.now(), cooldownMinutes: 120 }) === false);
check('topicRepeated 不同话题不命中', topicRepeated('今天开黑', [{ at: Date.now(), key: '老人家住院' }], { now: Date.now(), cooldownMinutes: 120 }) === false);
check('topicRepeated 空 key 不误判', topicRepeated('', [{ at: Date.now(), key: '住院' }], { now: Date.now(), cooldownMinutes: 120 }) === false);

// ---- 场合：两个人来回聊，不硬插 ----
const twoWay = ev([
  { time: nowSec - 50, userId: '1', text: '你上线了吗', isSelf: false },
  { time: nowSec - 40, userId: '2', text: '马上，等我两分钟', isSelf: false },
  { time: nowSec - 30, userId: '1', text: '好，我先开个房', isSelf: false },
  { time: nowSec - 20, userId: '2', text: '来了来了这就进房间', isSelf: false },
]);
check('事件闸：两人对话不插话', twoWay.ok === false && /只有 2 个人/.test(twoWay.reason));
const manyWay = ev([
  { time: nowSec - 50, userId: '1', text: '有人开黑吗', isSelf: false },
  { time: nowSec - 40, userId: '2', text: '我在', isSelf: false },
  { time: nowSec - 30, userId: '3', text: '我也来', isSelf: false },
  { time: nowSec - 20, userId: '4', text: '带我一个我来打辅助', isSelf: false },
]);
check('事件闸：多人场合可以接', manyWay.ok === true, JSON.stringify(manyWay));

// ---- 模型来源解析：和识图一致，留空跟随群会话模型 ----
const fromSession = resolveModel({}, { provider: 'uymu-ds', model: 'deepseek-v4-flash' });
check('来源解析：留空时跟随群会话模型',
  fromSession.provider === 'uymu-ds' && fromSession.model === 'deepseek-v4-flash' && fromSession.missing.length === 0,
  JSON.stringify(fromSession));

const noSession = resolveModel({}, null);
check('来源解析：无会话也没配置 -> 缺 provider 与 model', noSession.missing.length === 2, JSON.stringify(noSession.missing));

const explicit = resolveModel({ provider: 'p1', model: 'm1' }, { provider: 'p2', model: 'm2' });
check('来源解析：显式 provider/model 优先于会话模型', explicit.provider === 'p1' && explicit.model === 'm1');

const onlyProvider = resolveModel({ provider: 'p1' }, { provider: 'p2', model: 'm2' });
check('来源解析：只配 provider 时 model 仍跟随会话', onlyProvider.provider === 'p1' && onlyProvider.model === 'm2');

const onlyModel = resolveModel({ model: 'm1' }, { provider: 'p2', model: 'm2' });
check('来源解析：只配 model 时 provider 仍跟随会话', onlyModel.provider === 'p2' && onlyModel.model === 'm1');

const partial = resolveModel({ provider: 'p1' }, null);
check('来源解析：缺 model 要单独报出来',
  partial.missing.length === 1 && partial.missing[0].includes('model'), JSON.stringify(partial.missing));

const blanks = resolveModel({ provider: '  ', model: '  ' }, { provider: 'p2', model: 'm2' });
check('来源解析：空白字符串视为未配置', blanks.provider === 'p2' && blanks.model === 'm2');

// ---- 两段式：判断与发言可分用不同模型（全部留空 = 单段模式，行为不变）----
const single = resolveStageModels({ provider: 'p1', model: 'm1' }, null);
check('两段式：默认不启用', single.twoStage === false);
check('两段式：默认判断与发言同源', single.judge.provider === 'p1' && single.judge.model === 'm1' && single.speak.model === 'm1');
const noPair = resolveStageModels({ provider: 'p1', model: 'm1', speakModel: 'm2' }, null);
check('两段式：只给 speakModel、没给 speakProvider 时不启用', noPair.twoStage === false && noPair.speak.model === 'm1');
const both = resolveStageModels({ provider: 'p1', model: 'm1', speakProvider: 'p1', speakModel: 'm2' }, null);
check('两段式：provider + model 成对才启用', both.twoStage === true && both.speak.model === 'm2' && both.judge.model === 'm1');
check('两段式：发言 provider 显式指定', both.speak.provider === 'p1');
const providerOnly = resolveStageModels({ provider: 'p1', model: 'm1', speakProvider: 'p2' }, null);
check('两段式：只给 speakProvider、没给模型也不启用', providerOnly.twoStage === false && providerOnly.speak.provider === 'p1');
const split = resolveStageModels({ provider: 'jp', model: 'jm', speakProvider: 'sp', speakModel: 'sm' }, null);
check('两段式：判断沿用 provider/model、发言独立', split.judge.provider === 'jp' && split.judge.model === 'jm' && split.speak.provider === 'sp' && split.speak.model === 'sm');
const aliasCheck = resolveStageModels({ judgeProvider: 'x1', judgeModel: 'x2', provider: 'p1', model: 'm1' }, null);
check('两段式：judge* 已不再参与解析（判 read 只认 provider/model）', aliasCheck.judge.provider === 'p1' && aliasCheck.judge.model === 'm1');
const sessionStage = resolveStageModels({}, { provider: 'sp0', model: 'sm0' });
check('两段式：留空跟随群会话模型', sessionStage.judge.provider === 'sp0' && sessionStage.judge.model === 'sm0');
const missing = resolveStageModels({ speakModel: 'm2' }, null);
check('两段式：缺 provider 会报缺项', missing.judge.missing.length > 0 && missing.speak.missing.length > 0);
const speakPromptText = buildSpeakPrompt({ persona: '一只猫娘', digest: '[10:00] 甲：今天开黑吗', topic: '开黑', maxChars: 60 });
check('发言提示词：带人设/话题/字数', speakPromptText.includes('一只猫娘') && speakPromptText.includes('开黑') && speakPromptText.includes('60'));
check('发言提示词：要求只输出正文', speakPromptText.includes('只输出这句话本身') && speakPromptText.includes('不要输出 JSON'));
check('发言提示词：禁止编造具体事实', speakPromptText.includes('不要编造具体事实') && speakPromptText.includes('只使用上面聊天记录里的信息'));

// ---- 发言阶段胶水：重试 → 全被拦 → 回退 → 放弃 ----
const ok = (text) => ({ ok: true, reason: '', text });
const bad = (reason) => ({ ok: false, reason: reason || 'blocked', text: '' });
const seqStage = await runSpeakStage({
  call: async (i) => (i === 0 ? 'first' : 'second'),
  validate: (raw) => (raw === 'second' ? ok('第二次通过') : bad('too-long')),
  attempts: 2,
  fallback: { enabled: true, ok: true, text: '判断正文' },
});
check('发言阶段：第一次被拦、第二次通过就用第二次', seqStage.used === 'speak' && seqStage.text === '第二次通过' && seqStage.attempts === 2);
const allBlocked = await runSpeakStage({
  call: async () => 'x',
  validate: () => bad('too-long'),
  attempts: 2,
  fallback: { enabled: true, ok: true, text: '判断正文' },
});
check('发言阶段：两次都被拦则回退判断正文', allBlocked.used === 'fallback' && allBlocked.text === '判断正文' && allBlocked.attempts === 2);
const noFallback = await runSpeakStage({
  call: async () => 'x',
  validate: () => bad('too-long'),
  attempts: 2,
  fallback: { enabled: false, ok: true, text: '判断正文' },
});
check('发言阶段：关闭回退时不出声', noFallback.used === 'none' && noFallback.text === '');
let blockedCount = 0;
const badJudge = await runSpeakStage({
  call: async () => 'x',
  validate: () => bad('too-long'),
  attempts: 2,
  fallback: { enabled: true, ok: false, text: '' },
  onBlocked: () => { blockedCount += 1; },
});
check('发言阶段：判断正文不可用时不回退、且逐次记录被拦', badJudge.used === 'none' && badJudge.text === '' && blockedCount === 2);

// 人格来源优先级：手填 > 宿主求值的 soul 人格 > 插件自身 persona（垫底回退）
check('人格：手填优先于一切', resolvePersonaText({ explicit: '手填', host: '宿主人格', fallback: '老配置' }) === '手填');
check('人格：留空时用宿主求值的人格', resolvePersonaText({ explicit: '', host: '宿主人格', fallback: '老配置' }) === '宿主人格');
check('人格：宿主也没有时回退老配置', resolvePersonaText({ explicit: '  ', host: '', fallback: '老配置' }) === '老配置');
check('人格：三者都空返回空串', resolvePersonaText({ explicit: '', host: '   ', fallback: '' }) === '');
check('人格：入参缺省不炸', resolvePersonaText() === '' && resolvePersonaText(null) === '');
check('人格：空白会被 trim', resolvePersonaText({ explicit: '  猫咪  ', host: '', fallback: '' }) === '猫咪');

// 表情包关键词：清洗 + 发送方式随机
check('表情包关键词：普通词原样保留', sanitizeStickerQuery('无语') === '无语');
check('表情包关键词：去掉换行与两侧空白', sanitizeStickerQuery('  猫猫\n鼓掌 ') === '猫猫 鼓掌');
check('表情包关键词：无 / none / null 当作没给', sanitizeStickerQuery('无') === '' && sanitizeStickerQuery('none') === '' && sanitizeStickerQuery('NULL') === '');
check('表情包关键词：超长截到 24 字', sanitizeStickerQuery('猫'.repeat(40)).length === 24);
check('表情包关键词：非字符串不炸', sanitizeStickerQuery(undefined) === '' && sanitizeStickerQuery(null) === '');
check('发送方式：random<0.5 合并成一条', pickStickerSendStyle(() => 0.2) === 'together');
check('发送方式：random>=0.5 先图后字', pickStickerSendStyle(() => 0.8) === 'separate');

// 判断阶段提示词：只有图库可用时才要 sticker 字段
const promptNoSticker = buildPrompt({ digest: 'a：在吗', maxChars: 60 });
check('不带 sticker 时提示词里没有表情包字段', promptNoSticker.includes('sticker') === false, promptNoSticker.slice(-120));
const promptSticker = buildPrompt({ digest: 'a：在吗', maxChars: 60, sticker: true });
check('带 sticker 时要求给关键词且 JSON 里有该字段', promptSticker.includes('sticker') && promptSticker.includes('表情包关键词或空字符串'), promptSticker.slice(-160));
const decSticker = parseDecision('{"speak": true, "topic": "游戏", "message": "这也太难了", "sticker": "无语"}');
check('决策解析出表情包关键词', decSticker !== null && decSticker.sticker === '无语', JSON.stringify(decSticker));
const decNoSticker = parseDecision('{"speak": true, "topic": "游戏", "message": "这也太难了"}');
check('没给关键词时是空串', decNoSticker !== null && decNoSticker.sticker === '', JSON.stringify(decNoSticker));

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
