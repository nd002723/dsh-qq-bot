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
  createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, extname, isAbsolute, resolve } from 'node:path';
// 通用图像工具住在 lib/shared（与表情包业务无关，可被识图/生图等复用）：
//   imagemeta.js —— 扩展名 ↔ mediaType、按真实内容嗅探格式
//   gif.js       —— GIF 解码 / 首帧转 PNG
//   png.js       —— 手写 PNG 编码器
import { IMAGE_EXTS, MIME_BY_EXT, isImageExt, mediaTypeOf, sniffImage } from '../shared/imagemeta.js';
import { decodeGifFrame, gifFirstFrameToPng } from '../shared/gif.js';
import { encodePng } from '../shared/png.js';

// 这些纯函数/编解码件对外仍从本模块导出：表情包是它们的主要使用方，
// 测试与调用方也按这个路径取，不必各自去 import lib/shared。
export { IMAGE_EXTS, MIME_BY_EXT, isImageExt, mediaTypeOf, sniffImage, decodeGifFrame, gifFirstFrameToPng, encodePng };

/** 索引文件名（写在表情包目录根部）。 */
export const INDEX_FILE = 'index.json';
/** 索引格式版本。 */
export const INDEX_VERSION = 1;
/** 目录递归上限：系列一般只有一层，留几层给人自由发挥。 */
const MAX_DEPTH = 6;
/** 单文件上限 10MB：表情包不该这么大，超了跳过（避免把视频/压缩包误当图）。 */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** 打标失败后的自动重试冷却（毫秒）：避免每次工具调用都去撞同一张坏图。 */
const FAIL_RETRY_MS = 10 * 60 * 1000;

/** 视觉模型要输出的格式（解析在 parseTagReply）。 */
const TAG_PROMPT = '请用简体中文回答，只输出两行，不要输出其他内容：'
  + '第一行以【标签】开头，给出 3-6 个逗号分隔的中文短标签（从画面内容、情绪、适合的群聊用途三个维度）；'
  + '第二行以【描述】开头，给一句中文描述（画面内容 + 情绪 + 适合在什么场合用这张表情包）。';

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
  function resolveModel() {
    const s = conf();
    const cfg = getConfig();
    const vision = (cfg !== null && cfg !== undefined && cfg.vision !== undefined && cfg.vision !== null) ? cfg.vision : {};
    const pair = (provider, model) => {
      const p = String(provider === undefined || provider === null ? '' : provider).trim();
      const m = String(model === undefined || model === null ? '' : model).trim();
      return (p !== '' && m !== '') ? { provider: p, model: m } : null;
    };
    return pair(s.provider, s.model) || pair(vision.provider, vision.model);
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
    const parsed = parseTagReply(text);
    if (parsed.tags.length === 0 && parsed.desc === '') {
      return { ok: false, error: '模型没有给出可用标签（原文：' + (text === '' ? '空' : text.slice(0, 80)) + '）' };
    }
    item.tags = parsed.tags;
    item.desc = parsed.desc;
    item.taggedAt = Date.now();
    item.tagModel = model.provider + '/' + model.model;
    if (payload.converted === true) item.tagNote = payload.note;
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const messages = [{
        role: 'user',
        content: [
          { type: 'text', text: TAG_PROMPT },
          { type: 'image', attachment: ref },
        ],
      }];
      let out = '';
      for await (const chunk of llm.stream({ provider: model.provider, model: model.model, messages, maxTokens: 400, signal: controller.signal })) {
        if (chunk !== null && chunk !== undefined && chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text;
      }
      return out.trim();
    } finally {
      clearTimeout(timer);
    }
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
        errors.push('未配置打标模型：在设置里的「表情包」卡片填 provider/model（或先配好图片视觉）');
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
    ensureFresh,
    sync,
    startRebuild,
    status,
    search,
    pick,
    indexFileOf: (dir) => join(dir === undefined ? resolveDir() : dir, INDEX_FILE),
  };
}
