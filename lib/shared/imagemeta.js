// 图像元信息：扩展名 ↔ mediaType、按真实内容嗅探格式。
// 与「表情包」业务无关——凡是要判断/描述图片格式的地方（表情包打标、收图识图、生图回传）都可以用；
// 只用 Node 内置能力，不引任何图形库。
import { extname } from 'node:path';

/** 认作图片的扩展名。 */
export const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

/** 扩展名 → mediaType。 */
export const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

/** 扩展名是不是我们认的图片。 */
export function isImageExt(name) {
  return IMAGE_EXTS.has(extname(String(name === undefined || name === null ? '' : name)).toLowerCase());
}

/** 相对路径 → mediaType（给 attachments.saveImage 用）。 */
export function mediaTypeOf(relPath) {
  return MIME_BY_EXT[extname(String(relPath === undefined || relPath === null ? '' : relPath)).toLowerCase()] || 'image/jpeg';
}

/** 看真实内容（不信扩展名）：返回 jpeg / png / gif / webp / bmp / null。 */
export function sniffImage(buf) {
  if (buf === null || buf === undefined || buf.length < 12) return null;
  const b = buf;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return 'webp';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  return null;
}
