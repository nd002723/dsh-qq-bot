// GIF 解码（纯 JS，无依赖）：解第 N 帧 → RGBA 画布；首帧 → PNG。
// 覆盖调色板 / 透明索引 / 隔行 / 局部帧合成。只依赖 ./imagemeta.js（嗅探）与 ./png.js（编码）。
import { sniffImage } from './imagemeta.js';
import { encodePng } from './png.js';

/**
 * GIF 解码的帧数护栏。
 * 有的动图是「同一尺寸重画整帧」类型（没有局部更新框），此时解第 1 帧就够出画面；
 * 但也有一些 GIF 从逻辑屏幕之外起画、或帧尺寸与逻辑屏幕不一致，解出来的首帧是空的。
 * 遇到这种就继续往后解，最多试 MAX_GIF_FRAMES 帧，取第一个「有内容」的。
 */
const MAX_GIF_FRAMES = 8;

/**
 * GIF 第 1 帧 → PNG（纯 JS，无依赖）。
 * GIF 帧数据是 LZW 压缩的索引色，这里解出来再按调色板转 RGBA，最后手写 PNG。
 * 透明像素在表情包里很常见：透明索引当背景色 α=0 处理。
 */
export function gifFirstFrameToPng(buf) {
  try {
    if (sniffImage(buf) !== 'gif') return null;
    const canvas = decodeGifFrame(buf, 0);
    if (canvas !== null) return encodePng(canvas.width, canvas.height, canvas.rgba);
    // 首帧是空的（局部帧 / 起画点在屏幕外）：继续往后试几帧，取第一个有内容的。
    for (let i = 1; i < MAX_GIF_FRAMES; i += 1) {
      const next = decodeGifFrame(buf, i);
      if (next === null) break;
      if (next.ink > 0) return encodePng(next.width, next.height, next.rgba);
    }
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * 解 GIF 的第 index 帧（0 基）到一张与逻辑屏幕等大的 RGBA 画布。
 * 返回 null = 解析失败；ink = 这一帧画了多少个不透明像素（用来判断「解出来是空图」）。
 *
 * 只做「合成到黑底/透明底」的最小还原：GIF 的帧可以是屏幕的一个局部框（局部更新），
 * 单独看某一帧会是空白的，所以这里按真实语义把它画到逻辑屏幕对应位置。
 */
export function decodeGifFrame(buf, index) {
  if (sniffImage(buf) !== 'gif') return null;
  const want = Number.isInteger(index) && index >= 0 ? index : 0;
  let p = 6; // 跳过 "GIF87a"/"GIF89a"
  const width = buf[p] | (buf[p + 1] << 8);
  const height = buf[p + 2] | (buf[p + 3] << 8);
  if (width <= 0 || height <= 0) return null;
  const packed = buf[p + 4];
  p += 5;
  // 逻辑屏幕描述符末尾是「背景色索引 + 像素宽高比」各 1 字节，固定 2 字节，
  // 与它们的值无关（曾经误写成「值为 0 才前进」，结果整条流错位 2 字节）。
  p += 2;
  let globalTable = null;
  if ((packed & 0x80) !== 0) {
    const size = 1 << ((packed & 0x07) + 1);
    globalTable = readPalette(buf, p, size);
    p += size * 3;
  }
  // 没有全局色表不算致命：有些工具会写「全局表但每帧自带局部表」或干脆只有局部表。
  // 真正的判据在下面——取到的那一帧必须有个能用的调色板。
  let transparency = -1;
  let frameNo = -1;
  let target = null;
  // 逐块走流：扩展块（0x21）只关心图形控制块里的透明色，图像描述符（0x2C）才是帧。
  // 注意 p 必须由「读块」推进，不能靠「跳过」推进——跳过与读取一旦分家，两边的起点
  // 就会错开一个块边界（这里踩过一次：帧头解析对、码流却从子块长度字节开始读，结果 0 像素）。
  for (let guard = 0; guard < 200000; guard += 1) {
    if (p >= buf.length) break;
    const intro = buf[p];
    if (intro === 0x3b) break;
    if (intro === 0x21) {
      const label = buf[p + 1];
      p += 2;
      if (label === 0xf9) {
        const blockSize = buf[p];
        if (blockSize >= 4) {
          const flag = buf[p + 1];
          if ((flag & 0x01) !== 0) transparency = buf[p + 4];
        }
      }
      p = skipSubBlocks(buf, p);
      continue;
    }
    if (intro === 0x2c) {
      const fx = buf[p + 1] | (buf[p + 2] << 8);
      const fy = buf[p + 3] | (buf[p + 4] << 8);
      const fw = buf[p + 5] | (buf[p + 6] << 8);
      const fh = buf[p + 7] | (buf[p + 8] << 8);
      const fPacked = buf[p + 9];
      p += 10;
      let table = globalTable;
      if ((fPacked & 0x80) !== 0) {
        const size = 1 << ((fPacked & 0x07) + 1);
        table = readPalette(buf, p, size);
        p += size * 3;
      }
      const minCodeSize = buf[p];
      p += 1;
      const lzw = readSubBlocks(buf, p);
      p = skipSubBlocks(buf, p);
      frameNo += 1;
      if (frameNo < want) continue; // 不是我们要的帧：接着读下一块（p 已经被正确推进）
      target = { fx, fy, fw, fh, table, lzw, minCodeSize, interlaced: (fPacked & 0x40) !== 0, transparency };
      break;
    }
    break; // 认不出的字节：放弃
  }
  if (target === null) return null;
  const { fx, fy, fw, fh, table, lzw, minCodeSize, interlaced, transparency: trans } = target;
  if (table === null || table === undefined) return null; // 这一帧没有可用调色板
  if (fw <= 0 || fh <= 0 || lzw.length === 0) return null;
  // 码长 0 是坏帧（规范允许 2..11；老编码器偶尔写 1）。这里不抛，直接判这段数据不可用。
  if (minCodeSize < 1 || minCodeSize > 11) return null;
  const indices = lzwDecode(lzw, minCodeSize, fw * fh);
  if (indices === null) return null;
  if (interlaced === true) deinterlace(indices, fw, fh);
  const rgba = Buffer.alloc(width * height * 4, 0);
  let ink = 0;
  for (let y = 0; y < fh; y += 1) {
    const dy = fy + y;
    if (dy >= height) break;
    for (let x = 0; x < fw; x += 1) {
      const dx = fx + x;
      if (dx >= width) break;
      const idx = indices[y * fw + x];
      if (idx === trans) continue; // 透明：保持 α=0
      const o = (dy * width + dx) * 4;
      rgba[o] = table[idx * 3] || 0;
      rgba[o + 1] = table[idx * 3 + 1] || 0;
      rgba[o + 2] = table[idx * 3 + 2] || 0;
      rgba[o + 3] = 0xff;
      ink += 1;
    }
  }
  return { width, height, rgba, ink };
}

function readPalette(buf, start, size) {
  if (start + size * 3 > buf.length) return null;
  return buf.subarray(start, start + size * 3);
}

function readSubBlocks(buf, start) {
  const parts = [];
  let p = start;
  while (p < buf.length) {
    const size = buf[p];
    p += 1;
    if (size === 0) break;
    parts.push(buf.subarray(p, p + size));
    p += size;
  }
  return Buffer.concat(parts);
}

function skipSubBlocks(buf, start) {
  let p = start;
  while (p < buf.length) {
    const size = buf[p];
    p += 1;
    if (size === 0) break;
    p += size;
  }
  return p;
}

/**
 * GIF 的 LZW 解码（变长码 + 清表码），返回像素索引数组。
 * 只在真实需要时才走位流推进：码表满 4096 后不再增长，码长封顶 12 位。
 */
function lzwDecode(data, minCodeSize, pixelCount) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const out = new Uint8Array(pixelCount);
  const prefix = new Int32Array(4096);
  const suffix = new Int32Array(4096);
  const stack = new Uint8Array(4097);
  let codeSize = minCodeSize + 1;
  let available = clearCode + 2;
  let old = -1;
  let datum = 0;
  let bits = 0;
  let di = 0;
  let outPos = 0;
  for (let i = 0; i < clearCode; i += 1) { prefix[i] = 0; suffix[i] = i; }
  while (outPos < pixelCount) {
    while (bits < codeSize) {
      if (di >= data.length) return outPos > 0 ? out : null;
      datum |= data[di] << bits;
      di += 1;
      bits += 8;
    }
    const code = datum & ((1 << codeSize) - 1);
    datum >>>= codeSize;
    bits -= codeSize;
    if (code === clearCode) {
      codeSize = minCodeSize + 1;
      available = clearCode + 2;
      old = -1;
      continue;
    }
    if (code === endCode) break;
    if (old === -1) {
      if (code >= clearCode) return null;
      out[outPos] = suffix[code];
      outPos += 1;
      old = code;
      continue;
    }
    let c = code;
    let sp = 0;
    if (code >= available) {
      // KwKwK：上一串 + 它的首字符
      if (old < 0) return null;
      stack[sp] = suffix[old];
      sp += 1;
      c = prefix[old];
    }
    while (c >= clearCode) {
      if (sp >= 4096) return outPos > 0 ? out : null;
      stack[sp] = suffix[c];
      sp += 1;
      c = prefix[c];
    }
    stack[sp] = suffix[c];
    sp += 1;
    // 栈里是倒序的：从顶往下写就是正序
    while (sp > 0) {
      sp -= 1;
      if (outPos < pixelCount) { out[outPos] = stack[sp]; outPos += 1; }
    }
    if (available < 4096) {
      prefix[available] = old;
      suffix[available] = stack[sp];
      available += 1;
      // 码长在「已用满当前宽度」时加一（与规范一致：available 到达 2^codeSize）
      if (available === (1 << codeSize) && codeSize < 12) codeSize += 1;
      old = code;
    } else {
      old = code;
    }
  }
  return out;
}

/** 隔行存放的帧要按 0,8,16,24… 的顺序重排成逐行。 */
function deinterlace(indices, w, h) {
  const copy = Buffer.from(indices);
  const passes = [[0, 8], [4, 8], [2, 4], [1, 2]];
  let src = 0;
  for (const pass of passes) {
    const start = pass[0];
    const step = pass[1];
    for (let y = start; y < h; y += step) {
      copy.copy(indices, y * w, src * w, src * w + w);
      src += 1;
    }
  }
}
