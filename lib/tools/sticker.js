/**
 * sticker.js —— 表情包图库：目录即库 + 内容哈希索引 + AI 自动打标 + 按标签挑图。
 *
 * 库的形状（不搬运文件，用户直接在磁盘上管理）：
 *   <dir>/index.json      —— 索引：每张图的 sha1、系列、标签、描述（AI 打标的结果）
 *   <dir>/<系列>/<图>      —— 子目录 = 表情包系列（允许多层，最外层目录名当系列）
 *   <dir>/<图>            —— 直接放在根部的图算「未分系列」
 *
 * 增量重建（本模块的核心约定）：
 *   1. 先比 size + mtimeMs —— 一点没变就不算哈希，一个字节都不读；
 *   2. 可疑/新增的文件才算 sha1 —— **哈希相同就当作没变**（touch 过、改过 mtime 都不重打标）；
 *   3. 只有哈希真的变了（或新文件）才清空标签、重新交给视觉模型打标。
 *   于是「首次使用 / 文件内容有变动」才重建索引，没变动的图永远不吃 token。
 *
 * 打标用 DSH 的 llm 服务（复用已注册的 provider，不新增 baseURL/apiKey）：
 *   provider/model 取 sticker.provider/model，留空则跟随 vision.provider/model。
 *   图片经 ctx.attachments.saveImage 转成附件引用，和识图（gateway/vision.js）同一条路。
 *
 * 本文件只管「表情包」这件事：索引、打标、搜索、挑图、发送目标判定。
 * 图像编解码（GIF 解码 / PNG 编码 / 格式嗅探）是通用能力，住在 lib/shared/，见下方 import。
 *
 * 并发与上限：
 *   - 同一目录的 sync 单飞（并发调用共享同一个 Promise）；
 *   - 打标是后台任务（startRebuild），每次最多 maxPerRun 张，每打完一张就落盘；
 *   - 失败过的图记 tagFailedAt，10 分钟内自动流程不再重试（手动重建不受限）。
 */
import { createHash } from 'node:crypto';
import {
  createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, extname, isAbsolute, resolve } from 'node:path';
// 通用图像工具住在 lib/shared（与表情包业务无关，可被识图/生图等复用）：
//   imagemeta.js —— 扩展名 ↔ mediaType、按真实内容嗅探格式
//   gif.js       —— GIF 解码 / 首帧转 PNG
//   png.js       —— 手写 PNG 编码器
import { IMAGE_EXTS, MIME_BY_EXT, isImageExt, mediaTypeOf, sniffImage } from '../shared/imagemeta.js';
import { decodeGifFrame, gifFirstFrameToPng } from '../shared/gif.js';
import { collectStreamText } from '../shared/stream-text.js';
import { encodePng } from '../shared/png.js';
// 收图下载走 publicFetch（公网校验 + 逐跳校验 + 上限），与识图同一条安全通道。
import { publicFetch } from '../shared/http.js';

// 这些纯函数/编解码件对外仍从本模块导出：表情包是它们的主要使用方，
// 测试与调用方也按这个路径取，不必各自去 import lib/shared。
export { IMAGE_EXTS, MIME_BY_EXT, isImageExt, mediaTypeOf, sniffImage, decodeGifFrame, gifFirstFrameToPng, encodePng };

/** 索引文件名（写在表情包目录根部）。 */
export const INDEX_FILE = 'index.json';
/** 索引格式版本。 */
export const INDEX_VERSION = 1;
/** 目录递归上限：系列一般只有一层，留几层给人自由发挥。 */
const MAX_DEPTH = 6;
/** 单文件上限的硬顶 10MB：再大就不该算表情包了（视频/压缩包混进来也没意义）。 */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** 收图默认上限 2MB（设置页可调，0.1–10）。 */
const DEFAULT_COLLECT_MAX_MB = 2;
/**
 * 收图**下限** 90KB：比这更小的图一律不收。
 *
 * 实测（2026-11-10）：一张 199x207 / 8KB 的 jpg 让打标模型稳定空返回——
 * 连打 4 次全空，而同批 635KB / 2MB / 4.9MB 的图都能正常出标签。
 * 体积过小的图往往信息量太少（纯色块、极小图标、缩略图），模型干脆不吐字；
 * 与其入库后再反复重试烧额度，不如在下载阶段就丢掉。
 * 这个下限是**硬编码**的：它是「什么算一张图」的判定底线，不适合开放给用户调。
 */
const MIN_COLLECT_BYTES = 90 * 1024;

/** 打标失败后的自动重试冷却（毫秒）：避免每次工具调用都去撞同一张坏图。 */
const FAIL_RETRY_MS = 10 * 60 * 1000;

/** 视觉模型要输出的格式（解析在 parseTagReply）。 */
const TAG_PROMPT = '请用简体中文回答，只输出两行，不要输出其他内容：'
  // 标签要能当检索词用：光有「卖萌」「蓝发女仆」这类抽象词，模型按具体情境（辣、加班、下雨）就搜不到，
  // 所以这里明确要求覆盖「情绪 / 具体场景动作 / 画面主体」三类，并要求用群聊里常见的说法。
  + '第一行以【标签】开头，给出 4-6 个逗号分隔的中文短标签，尽量覆盖三类：'
  + '① 情绪或反应（如 开心、无语、委屈、得意、累瘫）；'
  + '② 具体场景或动作（如 吃饭、睡觉、加班、摸鱼、被夸、考试、下雨、喝奶茶）；'
  + '③ 画面主体（如 蓝发女仆、猫猫、饭团）。'
  + '标签用群聊里常见的说法，别写「人物」「图片」这种太泛的词，也别写专有名词；'
  + '第二行以【描述】开头，给一句中文描述（画面内容 + 情绪 + 适合在什么场合用这张表情包），描述里同样带上具体场景词。';

/** 太泛的词当标签没有检索价值，解析时丢掉。 */
const GENERIC_TAGS = new Set([
  '人物', '物品', '画面', '图片', '图像', '场景', '内容', '插画', '动漫', '二次元',
  '背景', '角色', '风格', '表情包', '表情', '梗图', '可爱', '好看',
]);

// ------------------------------------------------------------ 纯函数（可直接单测）

/**
 * 打标要发给模型的那一份数据。
 *
 * 模型只吃静态图，所以：
 *   - jpg/png/webp/bmp：原样返回（不重编码，画质与 token 都不变）；
 *   - gif：解第 1 帧（含透明 / 隔行 / 调色板），重编码成 PNG；
 *   - 扩展名是 .gif 但内容是 JPEG/PNG（网上抓的表情包常这样改后缀）：按真实内容处理；
 *   - 解不出来（很少见的 GIF87a 变体）：兜底按 image/jpeg 原样发，让模型自己说不行。
 */
export function visionPayload(buf, relPath, options) {
  const opts = (options === null || options === undefined) ? {} : options;
  const ext = extname(String(relPath === undefined || relPath === null ? '' : relPath)).toLowerCase();
  const sniff = sniffImage(buf);
  // 只认真实内容：扩展名写 .gif、内容却是 JPEG 的那种，按内容发（有的图库会把 GIF 转成静态图还留原名）。
  const isGif = sniff === 'gif';
  if (isGif) {
    // 默认「原样发送」：把原始字节和它在磁盘上的真实类型交给模型，不擅自重编码。
    // 兼容模式（sticker.gifCompat）才在本地解首帧转 PNG —— 给那些不吃 image/gif 的模型用。
    if (opts.gifCompat === true) {
      const png = gifFirstFrameToPng(buf);
      if (png !== null) return { data: png, mediaType: 'image/png', converted: true, note: '兼容模式：GIF → 首帧 PNG' };
      return { data: buf, mediaType: 'image/gif', converted: false, note: '兼容模式解帧失败，按原样发送' };
    }
    if (sniff !== null && sniff !== 'gif') {
      // 扩展名撒谎的「假 GIF」：内容是什么就按什么发
      return { data: buf, mediaType: MIME_BY_EXT['.' + sniff] || 'image/jpeg', converted: false, note: '' };
    }
    return { data: buf, mediaType: 'image/gif', converted: false, note: '' };
  }
  // 认得真实类型就按真实类型发（.gif 里装 JPEG 的「假动图」很常见），认不出才退回扩展名。
  const byContent = sniff === null ? null : MIME_BY_EXT['.' + sniff];
  return { data: buf, mediaType: byContent || MIME_BY_EXT[ext] || 'image/jpeg', converted: false, note: '' };
}

/** 相对路径的系列名：最外层目录；根部的文件 = ''（未分系列）。 */
export function seriesOfRel(relPath) {
  const parts = String(relPath === undefined || relPath === null ? '' : relPath).split('/').filter(Boolean);
  return parts.length > 1 ? parts[0] : '';
}

/** 一条记录是否已经打标（有标签或描述即算）。 */
export function hasStickerTags(item) {
  if (item === null || item === undefined) return false;
  const tags = Array.isArray(item.tags) ? item.tags : [];
  const desc = typeof item.desc === 'string' ? item.desc.trim() : '';
  return tags.length > 0 || desc !== '';
}

/**
 * 递归列出目录里的图片（相对路径，一律用 '/' 分隔，方便写进索引）。
 * 跳过：隐藏文件/目录、index.json、非图片扩展名。结果按路径排序，保证索引稳定。
 */
export function listImageFiles(root, options) {
  const maxDepth = (options !== undefined && options !== null && typeof options.maxDepth === 'number') ? options.maxDepth : MAX_DEPTH;
  const out = [];
  const walk = (dir, depth, prefix) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch (error) { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0)));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const rel = prefix === '' ? entry.name : prefix + '/' + entry.name;
      if (entry.isDirectory()) {
        if (depth < maxDepth) walk(join(dir, entry.name), depth + 1, rel);
        continue;
      }
      if (entry.isFile() !== true) continue;
      if (entry.name === INDEX_FILE) continue;
      if (isImageExt(entry.name) !== true) continue;
      out.push(rel);
    }
  };
  walk(root, 1, '');
  return out;
}

/** 文件内容 sha1（流式读：大图不整包进内存）。 */
export function hashFile(absPath) {
  return new Promise((done, fail) => {
    const hash = createHash('sha1');
    const stream = createReadStream(absPath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', (error) => fail(error));
    stream.on('end', () => done(hash.digest('hex')));
  });
}

/** 系列汇总：[{ name, count }]，未分系列的计数在 name = '' 上。 */
export function seriesSummary(items) {
  const counts = new Map();
  for (const item of items) {
    const name = seriesOfRel(item.file);
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return Array.from(counts, ([name, count]) => ({ name, count }))
    .sort((a, b) => (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0)));
}

/** 清洗一个候选标签：去序号、去引号、限长。 */
function cleanTag(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw)
    .replace(/^\s*\d+\s*[.、)）]\s*/, '')
    .replace(/^[「『"'\s]+|[」』"'\s]+$/g, '')
    .trim();
  if (text === '' || text.length > 12) return '';
  if (GENERIC_TAGS.has(text)) return '';
  return text;
}

/**
 * 一行 → 标签数组。两种写法都认：
 *   '1. 开心 2. 鼓掌'（编号列表）   '开心,鼓掌'（逗号列表）
 * 返回 0/1 个标签的行不算标签行（那是描述），交给调用方当下一条描述。
 */
function lineToTags(line) {
  const body = String(line === undefined || line === null ? '' : line).trim();
  if (body === '') return [];
  let parts;
  if (/\d+\s*[.、)）]/.test(body) === true) {
    parts = body.split(/\s*\d+\s*[.、)）]\s*/);
  } else if (/[,，、;；]/.test(body) === true) {
    parts = body.split(/[,，、;；]+/);
  } else {
    return [];
  }
  const tags = [];
  for (const part of parts) {
    const tag = cleanTag(part);
    if (tag !== '' && tags.includes(tag) !== true) tags.push(tag);
    if (tags.length >= 8) break;
  }
  return tags.length >= 2 ? tags : [];
}

/**
 * 解析视觉模型的两行输出。容忍各种小偏差：
 *   - 行首带不带【】、冒号全角半角、编号列表；
 *   - 没按格式输出时，第一行像标签列表就当标签，正文当描述；
 *   - 标签行缺失且第一行是句子时，从句子里的逗号词兜底（至少两个才收）。
 */
export function parseTagReply(text) {
  const raw = String(text === undefined || text === null ? '' : text).trim();
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const tags = [];
  const consumed = new Set();
  let desc = '';
  let hasTagLine = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^【标签】|^标签\s*[:：]?/u.test(line) === true) {
      hasTagLine = true;
      consumed.add(i);
      const body = line.replace(/^【标签】|^标签\s*[:：]?/u, '');
      for (const tag of lineToTags(body)) {
        if (tags.includes(tag) !== true) tags.push(tag);
        if (tags.length >= 8) break;
      }
      continue;
    }
    if (/^【描述】|^描述\s*[:：]?/u.test(line) === true) {
      consumed.add(i);
      const body = line.replace(/^【描述】|^描述\s*[:：]?/u, '').trim();
      if (body !== '' && desc === '') desc = body;
      continue;
    }
  }

  // 没有【标签】行：挑第一行「看起来就是一堆短词」的当标签（描述句不会被误吞）
  if (hasTagLine !== true && tags.length === 0) {
    for (let i = 0; i < lines.length; i += 1) {
      if (consumed.has(i) === true) continue;
      const candidate = lineToTags(lines[i]);
      if (candidate.length >= 2) {
        for (const tag of candidate) if (tags.includes(tag) !== true) tags.push(tag);
        consumed.add(i);
        break;
      }
    }
  }

  if (desc === '') {
    for (let i = 0; i < lines.length; i += 1) {
      if (consumed.has(i) === true) continue;
      desc = lines[i];
      break;
    }
  }
  if (desc === '' && tags.length > 0) desc = tags.join('、');
  return { tags: tags.slice(0, 8), desc: desc.slice(0, 300) };
}

/**
 * 当前会话该发到哪里：group-<群号> / private-<QQ号>；共享会话（perChatSession=false）
 * 退回用发言人的 groupId / userId。拿不到目标返回 null，绝不猜。
 */
export function resolveStickerTarget(entry) {
  if (entry === null || entry === undefined) return null;
  const speaker = (entry.turnSpeaker !== undefined && entry.turnSpeaker !== null) ? entry.turnSpeaker : entry.speaker;
  const key = String(entry.key === undefined || entry.key === null ? '' : entry.key);
  if (key.startsWith('group-') === true) {
    const groupId = (entry.groupId !== undefined && entry.groupId !== null && String(entry.groupId) !== '')
      ? String(entry.groupId)
      : (speaker && speaker.groupId !== undefined && speaker.groupId !== null && String(speaker.groupId) !== '' ? String(speaker.groupId) : key.slice(6));
    return groupId === '' ? null : { messageType: 'group', targetId: groupId };
  }
  if (key.startsWith('private-') === true) {
    const userId = key.slice(8);
    return userId === '' ? null : { messageType: 'private', targetId: userId };
  }
  const gid = (entry.groupId !== undefined && entry.groupId !== null) ? entry.groupId
    : (speaker && speaker.groupId !== undefined ? speaker.groupId : null);
  if (gid !== null && gid !== undefined && String(gid) !== '') return { messageType: 'group', targetId: String(gid) };
  const uid = speaker && speaker.userId !== undefined && speaker.userId !== null ? String(speaker.userId) : '';
  if (uid !== '') return { messageType: 'private', targetId: uid };
  return null;
}

// ------------------------------------------------------------ 索引读写

function emptyIndex() {
  return { version: INDEX_VERSION, updatedAt: 0, dir: '', series: [], items: [] };
}

function normalizeItem(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const file = typeof raw.file === 'string' ? raw.file.replace(/\\/g, '/').trim() : '';
  if (file === '' || file.includes('..') === true) return null;
  const tags = Array.isArray(raw.tags) ? raw.tags.filter((tag) => typeof tag === 'string' && tag.trim() !== '').map((tag) => tag.trim().slice(0, 12)) : [];
  return {
    file,
    series: typeof raw.series === 'string' ? raw.series : seriesOfRel(file),
    sha1: typeof raw.sha1 === 'string' ? raw.sha1 : '',
    size: Number(raw.size) || 0,
    mtimeMs: Number(raw.mtimeMs) || 0,
    tags,
    desc: typeof raw.desc === 'string' ? raw.desc : '',
    taggedAt: Number(raw.taggedAt) || 0,
    ...(typeof raw.tagModel === 'string' && raw.tagModel !== '' ? { tagModel: raw.tagModel } : {}),
    ...(typeof raw.tagNote === 'string' && raw.tagNote !== '' ? { tagNote: raw.tagNote } : {}),
    ...(Number(raw.tagFailedAt) > 0 ? { tagFailedAt: Number(raw.tagFailedAt), tagError: String(raw.tagError || '') } : {}),
    addedAt: Number(raw.addedAt) || 0,
  };
}

/**
 * 读索引。坏文件不抛：当作「没有索引」重新扫描（用户手改坏了也能自愈），
 * 但把 corrupt 标记带出去，状态接口能提示。
 */
export function loadIndexAt(dir) {
  const file = join(dir, INDEX_FILE);
  if (existsSync(file) !== true) return { exists: false, corrupt: false, index: emptyIndex() };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed.items) !== true) {
      return { exists: true, corrupt: true, index: emptyIndex() };
    }
    const items = [];
    for (const raw of parsed.items) {
      const item = normalizeItem(raw);
      if (item !== null) items.push(item);
    }
    return {
      exists: true,
      corrupt: false,
      index: {
        version: Number(parsed.version) || INDEX_VERSION,
        updatedAt: Number(parsed.updatedAt) || 0,
        dir: typeof parsed.dir === 'string' ? parsed.dir : '',
        series: Array.isArray(parsed.series) ? parsed.series : seriesSummary(items),
        items,
      },
    };
  } catch (error) {
    return { exists: true, corrupt: true, index: emptyIndex(), error: error instanceof Error ? error.message : String(error) };
  }
}

/** 原子落盘：先写 .tmp 再 rename，断电也不会留下半个 JSON。 */
export function writeIndexAt(dir, data) {
  const payload = JSON.stringify({
    version: INDEX_VERSION,
    updatedAt: data.updatedAt || Date.now(),
    dir,
    series: seriesSummary(data.items),
    items: data.items.map((item) => ({
      file: item.file,
      series: item.series,
      sha1: item.sha1,
      size: item.size,
      mtimeMs: item.mtimeMs,
      tags: Array.isArray(item.tags) ? item.tags : [],
      desc: typeof item.desc === 'string' ? item.desc : '',
      taggedAt: item.taggedAt || 0,
      ...(item.tagModel === undefined ? {} : { tagModel: item.tagModel }),
      ...(typeof item.tagNote === 'string' && item.tagNote !== '' ? { tagNote: item.tagNote } : {}),
      ...(item.tagFailedAt ? { tagFailedAt: item.tagFailedAt, tagError: item.tagError || '' } : {}),
      ...(item.addedAt ? { addedAt: item.addedAt } : {}),
    })),
  }, null, 2) + '\n';
  const tmp = join(dir, INDEX_FILE + '.tmp');
  writeFileSync(tmp, payload, 'utf8');
  renameSync(tmp, join(dir, INDEX_FILE));
}

/** 索引里没打标的条数（有标签或描述就算已打标）。 */
export function countUntagged(items) {
  let count = 0;
  for (const item of items) if (hasStickerTags(item) !== true) count += 1;
  return count;
}

// ------------------------------------------------------------ 图库实例

/**
 * @param {object} deps
 * @param {() => any} deps.getConfig       每次现取配置（热更新即时生效）
 * @param {() => string} deps.getRoot      QQ_msg 工作目录根
 * @param {any} deps.ctx                   DSH 上下文（llm / attachments）
 * @param {(e: unknown) => string} [deps.describeError]
 * @param {() => ({ provider?: string, model?: string } | null | undefined)} [deps.getDefaultModel]
 *        第三级回退：表情包与 vision 都没填模型时跟随会话模型（DSH 的 agentDefaultModel）。
 * @param {(line: string) => void} [deps.log]
 */
export function createStickerLibrary(deps) {
  const getConfig = deps.getConfig;
  const getRoot = deps.getRoot;
  const ctx = deps.ctx;
  const describeError = typeof deps.describeError === 'function' ? deps.describeError
    : (error) => (error instanceof Error ? error.message : String(error));
  const log = typeof deps.log === 'function' ? deps.log : () => {};

  /** 后台任务状态（给设置页卡片显示进度）。 */
  let job = null;
  /** 同一目录的 sync 单飞。 */
  let inflight = null;
  /** 索引读缓存（按 mtime 失效）。 */
  let cache = null;

  const conf = () => {
    const cfg = getConfig();
    return (cfg !== null && cfg !== undefined && cfg.sticker !== undefined && cfg.sticker !== null) ? cfg.sticker : {};
  };

  /**
   * 表情包目录：**默认不写死任何绝对路径**。
   *   留空     → <QQ_msg>/sticker（QQ_msg 每次现解析：Documents 目录 + deepseek-harness/QQ_msg，
   *              换机器 / 改 XDG 目录它自己就跟着走，不会把某台机器的路径带进索引）
   *   以 ~ 开头 → 按家目录展开
   *   相对路径 → 按 QQ_msg 解析
   *   绝对路径 → 原样用（主人在设置里手填的场景）
   * 返回值会写进 index.json 的 dir 字段，所以这里必须是「当前解析结果」，不能缓存。
   */
  function resolveDir() {
    const raw = String(conf().dir === undefined || conf().dir === null ? '' : conf().dir).trim();
    const root = getRoot();
    if (raw === '') return join(root, 'sticker');
    if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
      return resolve(homedir(), raw.slice(1).replace(/^[\\/]+/, ''));
    }
    return isAbsolute(raw) === true ? resolve(raw) : resolve(root, raw);
  }

  /**
   * 打标用哪个模型：表情包自己配齐了就用它，否则整对跟随图片视觉。
   * 必须是**成对**的 provider + model——只填一半时不去凑另一半，
   * 否则很容易出现「A 家的 provider + B 家的模型」这种必然失败的组合。
   */
  /** 收图大小上限（字节）：0.1–10MB，缺省 2MB。 */
  function collectMaxBytes() {
    const mb = Number(conf().collectMaxMb);
    const value = Number.isFinite(mb) === true && mb > 0 ? Math.min(mb, MAX_FILE_BYTES / (1024 * 1024)) : DEFAULT_COLLECT_MAX_MB;
    return Math.round(value * 1024 * 1024);
  }

  /** 被偷来的图一律落在这个系列里（issue #97：不跟用户自己的系列混）。 */
  const COLLECT_SERIES = 'get_stickers';

  /** 收图默认关：必须显式 `collect === true` 才开（配置缺项时也保持关闭，不会意外收图）。 */
  function collectEnabled() {
    return conf().enabled === true && conf().collect === true;
  }

  /**
   * 收图概率（0–1，缺省 0.3）：**每一张**表情包入库前先掷一次骰子。
   *
   * 为什么要这道闸：群里一旦开始斗图，每张表情包都收的话图库会被塞爆，
   * 而且每收一张都要跑一次打标（烧视觉额度）。概率闸让「喂养」变成细水长流：
   * 0.3 意味着大概每三张收一张，长期看足够积累，短期不会一晚上进来几十张。
   *   1   = 全收（想要什么都要）
   *   0   = 一张都不收（等价于关掉偷表情包，但保留其它收图条件）
   * 测试与确定性场景想跳过随机时，把配置设成 1。
   */
  function collectChance() {
    const raw = Number(conf().collectChance);
    if (Number.isFinite(raw) !== true) return 0.3;
    if (raw <= 0) return 0;
    if (raw >= 1) return 1;
    return raw;
  }

  /** 掷一次收图骰子；chance >= 1 恒真，<= 0 恒假。 */
  function passesCollectChance() {
    const chance = collectChance();
    if (chance >= 1) return true;
    if (chance <= 0) return false;
    return Math.random() < chance;
  }

  /** get_stickers 系列的条数上限：0 = 不限（缺省 100）。 */
  function collectMaxCount() {
    const raw = Number(conf().collectMaxCount);
    if (Number.isFinite(raw) !== true) return 100;
    return Math.max(0, Math.trunc(raw));
  }

  /** 超上限时自动删最早收的：默认关，必须显式 `=== true`。 */
  function collectAutoTrim() {
    return conf().collectAutoTrim === true;
  }

  /**
   * 把 get_stickers 系列裁到上限以内（从「收得最早」的开始删）。
   *
   * 只动自动收来的图：`file` 以 `get_stickers/` 开头才算，用户自己整理的其它系列一张不碰。
   * 「最早」按 addedAt（入库时间戳）排，没有 addedAt 的老条目按 0 处理（视为最旧，先删）。
   * 删文件 + 同步索引，返回 { removed, error } —— 失败只报不抛（这条链路后台跑）。
   */
  function trimCollected(dir, items) {
    const cap = collectMaxCount();
    if (cap <= 0) return { removed: 0, error: '' };
    const mine = items.filter((item) => String(item.file).startsWith(COLLECT_SERIES + '/') === true);
    if (mine.length <= cap) return { removed: 0, error: '' };
    const sorted = mine.slice().sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
    const doomed = sorted.slice(0, mine.length - cap);
    const doomedFiles = new Set(doomed.map((item) => item.file));
    let removed = 0;
    for (const item of doomed) {
      try {
        unlinkSync(join(dir, ...String(item.file).split('/')));
        removed += 1;
      } catch { /* 文件已经不在：下面照样从索引里摘掉 */ }
    }
    // 从索引里摘掉（就地改 items，调用方随后会 writeIndexAt）
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (doomedFiles.has(items[i].file) === true) items.splice(i, 1);
    }
    invalidateCache();
    if (removed > 0) log('[sticker] 收图超上限（' + cap + '）：删掉最早收的 ' + removed + ' 张');
    return { removed, error: '' };
  }

  /**
   * 打标用哪个模型，三级回退：
   *   1. sticker.provider/model（表情包卡片自己填的）；
   *   2. vision.provider/model（图片视觉卡片填的，老约定「留空跟随视觉」）；
   *   3. 两者都留空 = 跟随会话模型（DSH 的 agentDefaultModel）。
   * 第 3 级是补上的：识图那边「留空 = 复用会话模型」之后，用户把 vision 清空是很自然的配置，
   * 这时打标若还只认字面值，就会以「未配置视觉模型」整批跳过——功能看着像坏了。
   */
  function resolveModel() {
    const s = conf();
    const cfg = getConfig();
    const vision = (cfg !== null && cfg !== undefined && cfg.vision !== undefined && cfg.vision !== null) ? cfg.vision : {};
    const pair = (provider, model) => {
      const p = String(provider === undefined || provider === null ? '' : provider).trim();
      const m = String(model === undefined || model === null ? '' : model).trim();
      return (p !== '' && m !== '') ? { provider: p, model: m } : null;
    };
    const explicit = pair(s.provider, s.model) || pair(vision.provider, vision.model);
    if (explicit !== null) return explicit;
    return getDefaultModel();
  }

  /** 会话模型（DSH 的 agentDefaultModel）。取不到就返回 null，不抛。 */
  function getDefaultModel() {
    const getService = typeof deps.getDefaultModel === 'function' ? deps.getDefaultModel : null;
    if (getService !== null) {
      try {
        const value = getService();
        if (value !== null && value !== undefined) {
          const provider = String(value.provider === undefined || value.provider === null ? '' : value.provider).trim();
          const model = String(value.model === undefined || value.model === null ? '' : value.model).trim();
          if (provider !== '' && model !== '') return { provider, model };
        }
      } catch (error) {
        log('[sticker] 读取会话模型失败（忽略）：' + describeError(error));
      }
      return null;
    }
    return null;
  }

  function readIndexCached(dir) {
    const file = join(dir, INDEX_FILE);
    let stat;
    try { stat = statSync(file); } catch (error) {
      cache = null;
      return loadIndexAt(dir);
    }
    if (cache !== null && cache.dir === dir && cache.mtimeMs === stat.mtimeMs) return cache.loaded;
    const loaded = loadIndexAt(dir);
    cache = { dir, mtimeMs: stat.mtimeMs, loaded };
    return loaded;
  }

  function invalidateCache() { cache = null; }

  /** 索引是否与磁盘一致（只比 size + mtime，不读内容）。 */
  function indexLooksFresh(dir, index, files) {
    if (index === null || index === undefined || Number(index.updatedAt) <= 0) return false;
    const byFile = new Map();
    for (const item of index.items) byFile.set(item.file, item);
    if (byFile.size !== files.length) return false;
    for (const rel of files) {
      const item = byFile.get(rel);
      if (item === undefined) return false;
      let stat;
      try { stat = statSync(join(dir, ...rel.split('/'))); } catch (error) { return false; }
      if (item.size !== stat.size || item.mtimeMs !== stat.mtimeMs) return false;
    }
    return true;
  }

  function publicJob() {
    if (job === null) return null;
    const out = {
      running: job.running,
      mode: job.mode,
      total: job.total,
      done: job.done,
      tagged: job.tagged,
      failed: job.failed,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      error: job.error,
      note: job.note,
    };
    return out;
  }

  /** 打标一张：读文件 → 附件引用 → 视觉模型 → 解析两行输出。 */
  async function tagItem(dir, item, model) {
    const abs = join(dir, ...String(item.file).split('/'));
    let buf;
    try { buf = readFileSync(abs); } catch (error) { return { ok: false, error: describeError(error) }; }
    const attachments = ctx === undefined || ctx === null ? undefined : ctx.attachments;
    if (attachments === undefined || attachments === null || typeof attachments.saveImage !== 'function') {
      return { ok: false, error: '附件服务不可用（需要 DSH 的 attachments 插件启用）' };
    }
    // 模型只吃静态图：GIF 先解一帧转 PNG（item.file 的扩展名只当提示，真实内容说了算）。
    // 自动兜底：raw GIF 打标失败时，若这张图是 GIF 且当前没开兼容模式，**再解一次首帧重试**。
    // 原因：不少模型渠道吃 image/gif 会返回空文本（实测打标「原文：空」），而首帧 PNG 只有 5% 大小、
    // 几乎必然成功。这个兜底不需要用户先去设置页开「GIF 兼容模式」才知道该开。
    const payload = visionPayload(buf, item.file, { gifCompat: conf().gifCompat === true });
    if (payload.data.length === 0) return { ok: false, error: '这张图读不出内容（文件损坏？）' };
    let ref;
    try {
      ref = await attachments.saveImage({ data: new Uint8Array(payload.data), mediaType: payload.mediaType });
    } catch (error) {
      return { ok: false, error: '图片入库失败：' + describeError(error) };
    }
    let text;
    try { text = await askTagModel(model, ref); } catch (error) { return { ok: false, error: describeError(error) }; }
    let parsed = parseTagReply(text);
    let usedPayload = payload;
    // 兜底重试：raw GIF 这条链路拿到空文本 / 解不出标签，而这张图其实是 GIF →
    // 本地解首帧转 PNG 再试一次（不依赖用户先去开「GIF 兼容模式」）。
    if ((parsed.tags.length === 0 && parsed.desc === '') && payload.converted !== true && payload.mediaType === 'image/gif') {
      const fallback = visionPayload(buf, item.file, { gifCompat: true });
      if (fallback.converted === true && fallback.data.length > 0) {
        let ref2;
        try {
          ref2 = await attachments.saveImage({ data: new Uint8Array(fallback.data), mediaType: fallback.mediaType });
          text = await askTagModel(model, ref2);
          parsed = parseTagReply(text);
          usedPayload = fallback;
        } catch (error) {
          log('[sticker] GIF 首帧兜底打标失败（忽略）：' + describeError(error));
        }
      }
    }
    if (parsed.tags.length === 0 && parsed.desc === '') {
      // 空返回已经重试过一次（见 askTagModel），还空就大概率是模型/渠道不接受这种图。
      const hint = payload.mediaType === 'image/gif'
        ? '：这个打标模型可能不支持 image/gif，到设置页「能力 → 表情包」打开「GIF 兼容模式」再试'
        : '：换一个支持图片的打标模型，或稍后重试';
      return { ok: false, error: '模型没有给出可用标签（原文：' + (text === '' ? '空' : text.slice(0, 80)) + '）' + hint };
    }
    item.tags = parsed.tags;
    item.desc = parsed.desc;
    item.taggedAt = Date.now();
    item.tagModel = model.provider + '/' + model.model;
    if (usedPayload.converted === true) item.tagNote = usedPayload.note;
    delete item.tagFailedAt;
    delete item.tagError;
    return { ok: true };
  }

  /** 调视觉模型；超时用 AbortSignal 中断（模型侧收到取消，不会一直挂着）。 */
  async function askTagModel(model, ref) {
    const llm = ctx === undefined || ctx === null ? undefined : ctx.llm;
    if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
      throw new Error('llm 服务不可用（DSH 未提供 llm.stream）');
    }
    const timeoutMs = Math.max(5000, Number(conf().timeoutMs) || 60000);
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: TAG_PROMPT },
        { type: 'image', attachment: ref },
      ],
    }];
    // 重试一次：空返回在实测里是**偶发**的——同一条图第一次空、手动重试就正常。
    // 空返回不是「模型说这张图没内容」，而是上游这一拍没吐字，一次就判失败太脆。
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      try {
        // 推理型模型会先把内容写进 reasoning-delta，预算小了就被思考吃光、正文一个字不剩。
        // 预算给 2000，取文本的三级兜底（delta → block-end → reasoning，互斥）收在
        // shared/stream-text.js，与识图、主动发言共用同一份实现。
        const collected = await collectStreamText(llm.stream({
          provider: model.provider,
          model: model.model,
          messages,
          maxTokens: 2000,
          signal: controller.signal,
        }));
        // collected.source 说明内容是从哪条路取到的：'text'/'block' 是正文，'reasoning' 是兜底。
        // 兜底来的思考原文要先试着解析，解析不出标签就当空返回重试，别把思考噪音当标签。
        const reasoning = collected.reasoning;
        const finishReason = collected.finishReason;
        if (collected.source !== 'reasoning' && collected.text !== '') return collected.text;
        lastError = null;
        if (collected.source === 'reasoning') {
          const fromReasoning = parseTagReply(reasoning);
          if (fromReasoning.tags.length > 0 || fromReasoning.desc !== '') {
            log('[sticker] 打标正文为空，已从思考里取到标签（' + model.provider + '/' + model.model + '）');
            return reasoning;
          }
        }
        const text = '';
        log('[sticker] 打标空返回（第 ' + attempt + ' 次，' + model.provider + '/' + model.model + '）'
          + '：text=' + String(text.length) + ' 字 / reasoning=' + String(reasoning.length) + ' 字'
          + (finishReason === '' ? '' : ' finish=' + finishReason));
      } catch (error) {
        lastError = error;
        log('[sticker] 打标请求失败（第 ' + attempt + ' 次）：' + describeError(error));
      } finally {
        clearTimeout(timer);
      }
      // 重试前的短暂退避：**不要 unref**——unref 后事件循环没有别的任务时这个定时器永远不触发，
      // await 就悬在那里（实测把测试挂成 unsettled top-level await）。它只有 800ms，留着无妨。
      if (attempt < 2) await new Promise((done) => { setTimeout(done, 800); });
    }
    if (lastError !== null) throw lastError;
    return '';
  }

  async function runSync(options) {
    const opts = options === undefined || options === null ? {} : options;
    // autoTag 是总闸：关掉它之后，不管是首次使用还是手动「扫描并打标」都只建索引
    //（不然一个叫「AI 自动标记」的开关关着却还在烧 token，等于开关撒谎）。
    const wantTag = opts.tag === true && conf().autoTag !== false;
    const progress = typeof opts.progress === 'function' ? opts.progress : () => {};
    const dir = resolveDir();
    try { mkdirSync(dir, { recursive: true }); } catch (error) {
      throw new Error('表情包目录不可用：' + describeError(error));
    }
    const previous = loadIndexAt(dir);
    const files = listImageFiles(dir);
    const prevByFile = new Map();
    // 内容认领表：sha1 → 已打标的那条旧记录。
    // 用户在磁盘上整理目录（改名 / 换系列 / 把图挪进别的子目录）时路径会变，
    // 但图片内容没变——按 sha1 把旧标签认领回来，别让一次整理白烧一遍视觉调用。
    const prevBySha1 = new Map();
    for (const item of previous.index.items) {
      prevByFile.set(item.file, item);
      if (item.sha1 !== '' && prevBySha1.has(item.sha1) !== true && hasStickerTags(item) === true) {
        prevBySha1.set(item.sha1, item);
      }
    }

    const items = [];
    const stats = { files: files.length, added: 0, updated: 0, unchanged: 0, moved: 0, removed: 0, skipped: 0 };
    for (const rel of files) {
      const abs = join(dir, ...rel.split('/'));
      let stat;
      try { stat = statSync(abs); } catch (error) { stats.skipped += 1; continue; }
      if (stat.size === 0 || stat.size > MAX_FILE_BYTES) { stats.skipped += 1; continue; }
      // 收图上限单独一道闸：比它大的图不算「入库候选」，但**已在库**的老图不会因此被删
      //（下面移除统计只按文件是否存在，不看大小，所以调小上限不会把大图从索引里踢掉）。
      const old = prevByFile.get(rel);
      // 快速通道：大小与 mtime 都没变 → 内容没变，一个字节都不读
      if (old !== undefined && old.size === stat.size && old.mtimeMs === stat.mtimeMs && old.sha1 !== '') {
        items.push(old);
        stats.unchanged += 1;
        continue;
      }
      let sha1;
      try { sha1 = await hashFile(abs); } catch (error) { stats.skipped += 1; continue; }
      // 慢通道算完哈希还是要再比一次：mtime 变了但内容一样（touch / 重新导出）不算变动
      if (old !== undefined && old.sha1 === sha1) {
        items.push({ ...old, size: stat.size, mtimeMs: stat.mtimeMs });
        stats.unchanged += 1;
        continue;
      }
      // 新路径（改名 / 换系列 / 复制一份）且内容能对上某条已打标的旧记录 → 直接认领标签。
      // 只在「这个路径之前不存在」时认领：同路径换了内容仍然要重新打标（那才是真变动）。
      const adopted = old === undefined ? prevBySha1.get(sha1) : undefined;
      if (adopted !== undefined) {
        items.push({
          file: rel,
          series: seriesOfRel(rel),
          sha1,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          tags: Array.isArray(adopted.tags) ? adopted.tags.slice() : [],
          desc: adopted.desc || '',
          taggedAt: adopted.taggedAt || 0,
          ...(typeof adopted.tagModel === 'string' && adopted.tagModel !== '' ? { tagModel: adopted.tagModel } : {}),
          addedAt: adopted.addedAt || Date.now(),
        });
        stats.moved += 1;
        continue;
      }
      const item = {
        file: rel,
        series: seriesOfRel(rel),
        sha1,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        tags: [],
        desc: '',
        taggedAt: 0,
        addedAt: Date.now(),
      };
      items.push(item);
      if (old !== undefined) stats.updated += 1; else stats.added += 1;
    }
    const kept = new Set(items.map((item) => item.file));
    stats.removed = [...prevByFile.keys()].filter((file) => kept.has(file) !== true).length;

    const data = { version: INDEX_VERSION, updatedAt: Date.now(), items };
    writeIndexAt(dir, data);
    invalidateCache();

    let tagged = 0;
    let failed = 0;
    let needTagTotal = 0;
    const errors = [];
    if (wantTag === true) {
      const candidates = items.filter((item) => {
        if (hasStickerTags(item) === true) return false;
        const lastFail = Number(item.tagFailedAt) || 0;
        return lastFail === 0 || Date.now() - lastFail > FAIL_RETRY_MS;
      });
      needTagTotal = candidates.length;
      const model = resolveModel();
      if (candidates.length > 0 && model === null) {
        failed = candidates.length;
        errors.push('未配置打标模型：在设置里的「表情包」卡片填 provider/model（或先配好图片视觉；两者都留空则跟随会话模型，需要 DSH 的默认模型可用）');
        log('[sticker] 跳过自动打标：未配置视觉模型');
      } else if (candidates.length > 0) {
        const cap = Math.max(0, Number(conf().maxPerRun) || 0);
        const targets = cap > 0 ? candidates.slice(0, cap) : candidates;
        progress({ total: targets.length, done: 0, tagged: 0, failed: 0 });
        for (const item of targets) {
          const result = await tagItem(dir, item, model);
          if (result.ok === true) {
            tagged += 1;
          } else {
            failed += 1;
            item.tagFailedAt = Date.now();
            item.tagError = String(result.error || '').slice(0, 200);
            if (errors.length < 5) errors.push(item.file + '：' + result.error);
          }
          // 每张落盘：中途停/崩了，已打好的标签不会白费
          writeIndexAt(dir, { version: INDEX_VERSION, updatedAt: Date.now(), items });
          invalidateCache();
          progress({ total: targets.length, done: tagged + failed, tagged, failed });
        }
      }
    }

    const report = {
      ok: true,
      dir,
      ...stats,
      tagged,
      failed,
      needTag: needTagTotal,
      pending: countUntagged(items),
      series: seriesSummary(items),
      errors,
      updatedAt: Date.now(),
    };
    log('[sticker] 扫描 ' + dir + '：' + report.files + ' 张 / 新增 ' + report.added + ' / 变动 ' + report.updated
      + ' / 认领 ' + report.moved + ' / 未变 ' + report.unchanged + ' / 移除 ' + report.removed
      + (wantTag === true ? (' / 打标 ' + tagged + ' 失败 ' + failed) : ''));
    return report;
  }

  /** 扫描 + 索引（可带打标）；并发调用共享同一次扫描。 */
  function sync(options) {
    if (inflight !== null) return inflight;
    const task = runSync(options).finally(() => { inflight = null; });
    inflight = task;
    return task;
  }

  /**
   * 后台重建（设置页按钮 / 工具 rebuild 走这条）：立刻返回，进度看 status()。
   * 同一时刻只跑一个任务。
   */
  function startRebuild(options) {
    const wantTag = options === undefined || options === null || options.tag !== false;
    if (job !== null && job.running === true) return { started: false, job: publicJob() };
    job = {
      running: true,
      mode: wantTag === true ? 'tag' : 'index',
      total: 0,
      done: 0,
      tagged: 0,
      failed: 0,
      startedAt: Date.now(),
      finishedAt: 0,
      error: '',
      note: '',
    };
    const current = job;
    const progress = (value) => { if (job === current) Object.assign(job, value); };
    (async () => {
      try {
        const report = await sync({ tag: wantTag, progress });
        if (job === current) {
          job.note = '新增 ' + report.added + ' / 变动 ' + report.updated + ' / 认领 ' + report.moved
            + ' / 移除 ' + report.removed
            + (wantTag === true ? ('；打标 ' + report.tagged + '，失败 ' + report.failed) : '');
          if (report.errors.length > 0) job.error = report.errors[0];
        }
      } catch (error) {
        if (job === current) job.error = describeError(error);
      } finally {
        if (job === current) { current.running = false; current.finishedAt = Date.now(); }
      }
    })();
    return { started: true, job: publicJob() };
  }

  /**
   * 「首次使用 / 有变动」的入口：工具每次被调用前先过这里。
   * 只做**便宜的**哈希索引，打标丢到后台，绝不把一次工具调用拖成长任务。
   */
  async function ensureFresh() {
    if (conf().enabled !== true) return { ok: false, synced: false, error: '表情包功能未开启' };
    const dir = resolveDir();
    let files = [];
    try { files = existsSync(dir) === true ? listImageFiles(dir) : []; } catch (error) { files = []; }
    const loaded = readIndexCached(dir);
    const fresh = loaded.exists === true && loaded.corrupt !== true && indexLooksFresh(dir, loaded.index, files);
    let report = null;
    if (fresh !== true) report = await sync({ tag: false });
    // 还有没打标的（新图 / 上次没跑完 / 模型后来才配好）→ 后台接着打
    const current = readIndexCached(dir);
    if (conf().autoTag === true && countUntagged(current.index.items) > 0 && (job === null || job.running !== true)) {
      startRebuild({ tag: true });
    }
    return { ok: true, synced: fresh !== true, fresh, report };
  }

  /** 状态：读索引（便宜），不触发扫描。 */
  async function status() {
    const dir = resolveDir();
    const loaded = readIndexCached(dir);
    const items = loaded.index.items;
    return {
      enabled: conf().enabled === true,
      autoTag: conf().autoTag !== false,
      dir,
      indexFile: join(dir, INDEX_FILE),
      indexExists: loaded.exists === true,
      corrupt: loaded.corrupt === true,
      total: items.length,
      tagged: items.length - countUntagged(items),
      untagged: countUntagged(items),
      series: seriesSummary(items),
      updatedAt: Number(loaded.index.updatedAt) || 0,
      model: resolveModel(),
      job: publicJob(),
      busy: inflight !== null,
      maxPerRun: Math.max(0, Number(conf().maxPerRun) || 0),
    };
  }

  /** 按关键词/系列找图；多词任一命中即可，命中越多排越前。 */
  function search(options) {
    const opts = options === undefined || options === null ? {} : options;
    const dir = resolveDir();
    const loaded = readIndexCached(dir);
    const items = loaded.index.items;
    const series = String(opts.series === undefined || opts.series === null ? '' : opts.series).trim();
    const rawLimit = Number(opts.limit);
    const limit = Number.isFinite(rawLimit) === true ? Math.max(1, Math.min(20, Math.trunc(rawLimit))) : 8;
    const terms = String(opts.q === undefined || opts.q === null ? '' : opts.q).trim().toLowerCase()
      .split(/[\s,，、;；]+/).filter(Boolean);
    let pool = items;
    if (series !== '') {
      pool = pool.filter((item) => seriesOfRel(item.file) === series || seriesOfRel(item.file).startsWith(series + '/'));
    }
    if (terms.length > 0) {
      const scored = [];
      for (const item of pool) {
        const hay = [item.file, seriesOfRel(item.file), Array.isArray(item.tags) ? item.tags.join(' ') : '', item.desc || '']
          .join(' ').toLowerCase();
        let hits = 0;
        for (const term of terms) if (hay.includes(term) === true) hits += 1;
        if (hits > 0) scored.push({ item, hits });
      }
      scored.sort((a, b) => (b.hits - a.hits) || ((b.item.taggedAt || b.item.addedAt || 0) - (a.item.taggedAt || a.item.addedAt || 0)));
      pool = scored.map((entry) => entry.item);
    } else {
      pool = pool.slice().sort((a, b) => ((b.addedAt || 0) - (a.addedAt || 0)) || (a.file < b.file ? -1 : 1));
    }
    return pool.slice(0, limit).map((item) => ({
      id: item.file,
      file: item.file,
      series: seriesOfRel(item.file),
      tags: Array.isArray(item.tags) ? item.tags : [],
      desc: item.desc || '',
      taggedAt: item.taggedAt || 0,
      path: join(dir, ...item.file.split('/')),
    }));
  }

  /**
   * 偷表情包（issue #97）：把一条入站图片 URL 收进图库。
   *
   * 流程：大小闸 → 安全下载（publicFetch，公网校验 + 上限）→ 魔数校验 →
   *       sha1 去重（已在库就只刷新）→ 落盘到 get_stickers 系列 → 后台交给打标流程。
   *
   * 「是不是表情包」不靠模型判断：**按消息段自己带的信号**筛（见 lib/gateway/collection.js），
   * 这里只管「把给定 URL 收下来」，不参与分类。
   *
   * 返回 { status: 'new'|'dup'|'skip'|'error', id?, reason? }，**绝不抛**：
   * 入站主链不能因为收图失败而报错。
   */
  async function collect(url) {
    if (collectEnabled() !== true) return { status: 'skip', reason: '收图未开启' };
    // 概率闸在**下载之前**：不中就直接跳过，连流量都不花。
    if (passesCollectChance() !== true) {
      return { status: 'skip', reason: '概率闸未通过（collectChance=' + String(collectChance()) + '）' };
    }
    const text = String(url === undefined || url === null ? '' : url).trim();
    if (/^https?:\/\//.test(text) !== true) return { status: 'skip', reason: '不是 http(s) 图片地址' };
    const maxBytes = collectMaxBytes();
    let res;
    try {
      // 多要 1 字节：publicFetch 是「边读边截」，给多少截多少，截断后长度永远 == maxBytes，
      // 于是原来那句 `buf.length > maxBytes` 恒为 false —— 超限的图会被**静默截成残缺文件**写进库
      // （实测一张标称 10.92MB 的图被截成 2MiB 存了下来，还打标失败）。
      // 多要 1 字节 + 看 truncated 标记，才能真正分辨「刚好等于上限」与「超了上限」。
      res = await publicFetch(text, { binary: true, timeoutMs: 15000, maxBytes: maxBytes + 1 });
    } catch (error) {
      return { status: 'error', reason: describeError(error) };
    }
    if (res.status < 200 || res.status >= 300) return { status: 'error', reason: 'HTTP ' + String(res.status) };
    if (res.truncated === true) {
      return { status: 'skip', reason: '超过大小上限（' + (maxBytes / (1024 * 1024)).toFixed(1) + 'MB）' };
    }
    const buf = Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body || '');
    if (buf.length === 0) return { status: 'error', reason: '空响应' };
    if (buf.length > maxBytes) return { status: 'skip', reason: '超过大小上限（' + (maxBytes / (1024 * 1024)).toFixed(1) + 'MB）' };
    // 太小的图不收：这类图信息量太少，打标模型会稳定返回空（见 MIN_COLLECT_BYTES 的说明），
    // 入库只会反复重试烧额度。判定放在魔数校验之前——先按体积挡掉，省一次 sniff。
    if (buf.length < MIN_COLLECT_BYTES) {
      return { status: 'skip', reason: '太小（' + Math.round(buf.length / 1024) + 'KB < ' + Math.round(MIN_COLLECT_BYTES / 1024) + 'KB）：这类图打标模型多半返回空' };
    }
    // 只认真实图片：QQ 链路上偶尔会把非图片塞进 image 段
    const sniff = sniffImage(buf);
    if (sniff === null) return { status: 'skip', reason: '内容不是图片' };
    const dir = resolveDir();
    const loaded = readIndexCached(dir);
    const sha1 = createHash('sha1').update(buf).digest('hex');
    const existed = loaded.index.items.find((item) => item.sha1 === sha1);
    if (existed !== undefined) return { status: 'dup', id: existed.file, reason: '已在库' };
    // 文件名：内容哈希前 16 位 + 真实扩展名（不取原始文件名，避免中文/空格/怪字符进路径）
    const ext = '.' + (sniff === 'jpeg' ? 'jpg' : sniff);
    const rel = COLLECT_SERIES + '/' + sha1.slice(0, 16) + ext;
    const dest = join(dir, ...rel.split('/'));
    // 数量上限是**硬限制**：到顶且没开「自动删最早」时，这张就不收了（一张都不写盘）。
    // 之前上限只在 trimCollected() 里生效，而那个函数只在自动删打开时才被调用，
    // 于是「关掉自动删」等于把上限也一起关掉——实测上限设 2 却收进了 4 张。
    const capBefore = collectMaxCount();
    if (capBefore > 0) {
      const mineBefore = loaded.index.items.filter((item) => String(item.file).startsWith(COLLECT_SERIES + '/') === true);
      if (mineBefore.length >= capBefore && collectAutoTrim() !== true) {
        return {
          status: 'skip',
          reason: '已到数量上限（' + String(mineBefore.length) + '/' + String(capBefore) + ' 张）；'
            + '想继续收就调大上限，或打开「超上限自动删最早的」',
        };
      }
    }
    try {
      mkdirSync(join(dir, COLLECT_SERIES), { recursive: true });
      const tmp = dest + '.tmp-' + Date.now();
      writeFileSync(tmp, buf);
      renameSync(tmp, dest);
    } catch (error) {
      return { status: 'error', reason: '写盘失败：' + describeError(error) };
    }
    // 落盘后**立即**把条目写进索引，不能等后台 rebuild：
    //   dup 判定完全依赖索引里的 sha1。等后台扫描再写的话，紧邻的第二次收图
    //   （或者同一张图被连发两次）读到的还是旧索引，会再落一份重复文件。
    // 实测过：同图连收两次存成两个文件，就是这么来的。
    let trimmed = 0;
    try {
      const fresh = loadIndexAt(dir);
      const items = fresh.index.items;
      if (items.find((item) => item.sha1 === sha1) === undefined) {
        let stat = null;
        try { stat = statSync(dest); } catch { /* 刚写完却读不到：下面照样按 0 记 */ }
        items.push({
          file: rel,
          series: COLLECT_SERIES,
          sha1,
          size: stat === null ? buf.length : Number(stat.size) || buf.length,
          mtimeMs: stat === null ? Date.now() : Number(stat.mtimeMs) || Date.now(),
          tags: [],
          desc: '',
          taggedAt: 0,
          addedAt: Date.now(),
        });
        // 开了「自动删最早」：裁到上限（新条目已在 items 里，所以裁完正好留下上限那么多）。
        // 关着的情况上面已经拦掉了，走不到这里。
        if (collectAutoTrim() === true) trimmed = trimCollected(dir, items).removed;
        writeIndexAt(dir, { version: INDEX_VERSION, updatedAt: Date.now(), items });
      }
    } catch (error) {
      log('[sticker] 收图写索引失败（忽略）：' + describeError(error));
    }
    invalidateCache();
    // 后台扫一遍 + 打标（不阻塞入站）。新图此刻已在索引里，扫描会把它算成「未变」并单独打标。
    if (job === null || job.running !== true) startRebuild({ tag: true });
    return { status: 'new', id: rel, reason: '', trimmed };
  }

  /** 取一条（send 用）：id 优先，其次按关键词/系列取最匹配的一张。 */
  function pick(options) {
    const opts = options === undefined || options === null ? {} : options;
    const dir = resolveDir();
    const loaded = readIndexCached(dir);
    const wanted = String(opts.id === undefined || opts.id === null ? '' : opts.id).trim().replace(/\\/g, '/');
    if (wanted !== '') {
      const item = loaded.index.items.find((entry) => entry.file === wanted);
      if (item === undefined) return null;
      return { item, path: join(dir, ...item.file.split('/')) };
    }
    const hits = search({ q: opts.q, series: opts.series, limit: 1 });
    if (hits.length === 0) return null;
    const item = loaded.index.items.find((entry) => entry.file === hits[0].id);
    if (item === undefined) return null;
    return { item, path: hits[0].path };
  }

  return {
    resolveDir,
    resolveModel,
    collect,
    collectEnabled,
    collectChance,
    passesCollectChance,
    collectMaxBytes,
    MIN_COLLECT_BYTES,
    collectMaxCount,
    collectAutoTrim,
    trimCollected,
    COLLECT_SERIES,
    ensureFresh,
    sync,
    startRebuild,
    status,
    search,
    pick,
    indexFileOf: (dir) => join(dir === undefined ? resolveDir() : dir, INDEX_FILE),
  };
}
