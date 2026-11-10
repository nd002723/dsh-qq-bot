/**
 * 统一「消息段」约定。
 *
 * 插件内部（以及适配器发给插件的 message 帧）用的是一套 OneBot 11 风格的段：
 *   { type: 'text',  data: { text: '...' } }
 *   { type: 'at',    data: { qq: '123' } }
 *   { type: 'image', data: { url: '...' | file: '...' } }
 *   { type: 'reply', data: { id: 123 } }
 *   { type: 'face' | 'record' | 'video' | 'file' | 'json' | 'xml' | 'forward' | 'poke', data: {...} }
 *
 * 这是兼容层的「中间表示」：各协议适配器把自家消息翻译成它，插件只认它。
 * 新增协议时，只要能产出这套段、并能把插件下发的段翻译回去，就算兼容完成。
 */

const LABELS = {
  face: '[表情]',
  record: '[语音]',
  video: '[视频]',
  json: '[卡片消息]',
  xml: '[卡片消息]',
  forward: '[合并转发]',
  poke: '[戳一戳]',
  mface: '[表情]',
};

/** 段数组 -> 纯文本（给模型看的），图片保留占位符。 */
export function segmentsToText(segments) {
  let text = '';
  if (!Array.isArray(segments)) return text;
  for (const seg of segments) {
    if (seg === null || typeof seg !== 'object') continue;
    const type = String(seg.type ?? '').toLowerCase();
    const data = seg.data ?? {};
    switch (type) {
      case 'text': text += String(data.text ?? ''); break;
      case 'at': {
        const qq = String(data.qq ?? '');
        text += qq === 'all' ? '@全体成员 ' : qq ? '@' + qq + ' ' : '';
        break;
      }
      case 'image': text += '[图片]'; break;
      case 'file': text += '[文件:' + String(data.name ?? data.file ?? '') + ']'; break;
      case 'reply': break;   // 引用不占正文，否则斜杠指令不在首位
      default: text += LABELS[type] ?? (typeof data.text === 'string' ? data.text : '');
    }
  }
  return text;
}

/**
 * 段数组里所有被 @ 的 QQ 号（'all' 原样保留）。
 *
 * 为什么单独给一份：正文里的 `@10001` 和「真的 @ 了 10001」在纯文本里分不开——
 * 用户手打一串 `@机器人QQ` 就能骗过「正文包含 @我」这种判定；而且 `@10001` 是
 * `@100012` 的前缀，正常 @ 别人会被误判成 @ 了我（2026-10-28 审计 A1）。
 * 所以准入判定只认这个列表，不认正文。
 */
export function atQqsOf(segments) {
  const out = [];
  if (!Array.isArray(segments)) return out;
  for (const seg of segments) {
    if (seg === null || typeof seg !== 'object') continue;
    if (String(seg.type ?? '').toLowerCase() !== 'at') continue;
    const qq = String((seg.data ?? {}).qq ?? '');
    if (qq !== '') out.push(qq);
  }
  return out;
}

export function countImages(segments) {
  if (!Array.isArray(segments)) return 0;
  let count = 0;
  for (const seg of segments) {
    if (seg !== null && typeof seg === 'object' && String(seg.type ?? '').toLowerCase() === 'image') count += 1;
  }
  return count;
}

/** 收集图片可访问地址（供视觉识别）。 */
export function imageUrlsOf(segments) {
  const urls = [];
  if (!Array.isArray(segments)) return urls;
  for (const seg of segments) {
    if (seg === null || typeof seg !== 'object') continue;
    if (String(seg.type ?? '').toLowerCase() !== 'image') continue;
    const data = seg.data ?? {};
    const url = typeof data.url === 'string' && data.url !== '' ? data.url
      : (typeof data.file === 'string' && data.file !== '' ? data.file : '');
    if (url !== '') urls.push(url);
  }
  return urls;
}

/**
 * 收集图片的「它是表情包还是普通图片」的信号（**不看图**，只用消息段自带的元数据）。
 *
 * 实测（NapCat / OneBot 11）：
 *   - 用户发的普通照片：sub_type=0, summary='' , 扩展名 .jpg
 *   - 收藏/商城表情：  sub_type=1 或 summary='[动画表情]'（两种协议端填法不同，都要认）
 *   - 自制 GIF 表情：  sub_type=0, summary='' , 扩展名 .gif
 * 所以判据只有三条，全是元数据：sub_type==1 / summary 含「动画表情」/ 扩展名 .gif。
 * 交给模型看图判类型既费 token 又会误判实拍图，不采用。
 *
 * @returns {Array<{url: string, file: string, summary: string, subType: number|null, ext: string}>}
 */
export function imageMetaOf(segments) {
  const out = [];
  if (!Array.isArray(segments)) return out;
  for (const seg of segments) {
    if (seg === null || typeof seg !== 'object') continue;
    if (String(seg.type ?? '').toLowerCase() !== 'image') continue;
    const data = seg.data ?? {};
    const url = typeof data.url === 'string' && data.url !== '' ? data.url
      : (typeof data.file === 'string' && data.file !== '' ? data.file : '');
    if (url === '') continue;
    const file = typeof data.file === 'string' ? data.file : '';
    const summary = typeof data.summary === 'string' ? data.summary : '';
    const rawSub = data.sub_type === undefined || data.sub_type === null ? '' : String(data.sub_type);
    const subType = rawSub === '' || Number.isNaN(Number(rawSub)) ? null : Number(rawSub);
    const extMatch = /(\.\w{2,5})\b/.exec(file === '' ? url.split('?')[0] : file);
    out.push({ url, file, summary, subType, ext: extMatch === null ? '' : extMatch[1].toLowerCase() });
  }
  return out;
}

/**
 * 这张图「像不像表情包」：**只看元数据，不看图**（与 imageMetaOf 配套）。
 *
 * 判据（来自实测）：
 *   - sub_type == 1            —— NapCat 对收藏/商城表情会给 1；
 *   - summary 含「动画表情」   —— 各协议端填法不同，文案这条兜底；
 *   - 扩展名 .gif              —— 自制 GIF 表情（普通实拍照不会是 GIF）。
 * 注意：这不是「模型判定」，不烧 token、也不看画面内容，纯元数据规则。
 */
export function isStickerLike(meta) {
  if (meta === null || meta === undefined) return false;
  if (Number(meta.subType) === 1) return true;
  if (/动画表情|表情/.test(String(meta.summary ?? ''))) return true;
  const ext = String(meta.ext ?? '').toLowerCase();
  return ext === '.gif';
}

/** 第一条 reply 段的被引用消息 id（没有则 null）。 */
function replyIdOf(segments) {
  if (!Array.isArray(segments)) return null;
  for (const seg of segments) {
    if (seg === null || typeof seg !== 'object') continue;
    if (String(seg.type ?? '').toLowerCase() !== 'reply') continue;
    const raw = seg.data?.id;
    if (raw === undefined || raw === null || raw === '') continue;
    // OneBot 11 的 message_id 是数字，OneBot 12 / Satori / 官方 API 是字符串：
    // 数字就转 number（兼容旧逻辑），否则原样返回字符串。
    const numeric = Number(raw);
    return Number.isFinite(numeric) && String(raw).trim() !== '' ? numeric : raw;
  }
  return null;
}

/** 归一化：把段数组变成 { text, images, imageUrls, replyTo, mentions }。
 *  mentions 是「真的 @ 了谁」的唯一可靠来源，准入判定用它而不是正文（见 atQqsOf）。 */
export function summarizeSegments(segments) {
  return {
    text: segmentsToText(segments),
    images: countImages(segments),
    imageUrls: imageUrlsOf(segments),
    imageMeta: imageMetaOf(segments),
    replyTo: replyIdOf(segments),
    mentions: atQqsOf(segments),
  };
}


