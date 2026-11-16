// 白名单目录内的路径判定：**必须 realpath 后再比边界**，纯字符串前缀挡不住符号链接。
//
// 为什么单独立一个文件：这条判据在四处出现过（qq_draw 参考图、qq_imgsearch 上传、
// qqbot 发表情包图、qq_sticker 读盘），每处各写一遍，最后走向分化：
//   · index.js 的 resolveSendImagePath 走 realpath（对）；
//   · sticker 的读盘路径只做字符串拼接（错，实测能借目录内软链读到白名单外文件）；
//   · imagegen 的 referenceToDataUrl 先比前缀再 realpath（两段式，中间有窗口）。
// 判据只能有一份，否则下次还是「修了这处漏那处」。
import { realpathSync } from 'node:fs';
import { resolve as pathResolve, sep as pathSep } from 'node:path';

/** realpath 的容错版：解析失败（不存在 / 断链 / 权限）返回空串，由调用方当作「不在白名单」。 */
function realOf(value) {
  try { return realpathSync(value); } catch (error) { return ''; }
}

/** realpath 的异步版（供 async 调用方避免阻塞事件循环）。 */
async function realOfAsync(value, fsPromises) {
  try { return await fsPromises.realpath(value); } catch (error) { return ''; }
}

/**
 * 把一个路径解析到白名单目录内，成功返回 **realpath 之后** 的绝对路径，失败返回空串。
 *
 * 语义（四处共用同一套）：
 *   · rootDir 自身也 realpath（白名单目录本身可能就是软链）；
 *   · target 先 pathResolve 再由 realpath 解链；
 *   · 解析后必须等于 root 或在 root 之下（按路径分隔符比边界，不能用裸字符串 startsWith，
 *     否则 `/a/bc` 会被当成 `/a/b` 的子路径）；
 *   · 任何一步解不出（不存在 / 断链）一律拒绝——「读不到」与「不在白名单」对调用方是同一件事。
 *
 * 调用方拿到的就是这个 real 路径，**读盘必须用它**，不能再用原始入参：
 * 否则 realpath 就成了一次纯校验（TOCTOU：校验时是 A，读时链接已被换成 B）。
 */
export function resolveInsideDir(target, rootDir) {
  const root = (rootDir === undefined || rootDir === null || String(rootDir) === '') ? '' : String(rootDir);
  if (root === '') return '';
  const realRoot = realOf(pathResolve(root));
  if (realRoot === '') return '';
  const text = (target === undefined || target === null) ? '' : String(target);
  if (text === '') return '';
  let abs = '';
  try { abs = pathResolve(text); } catch (error) { return ''; }
  const realTarget = realOf(abs);
  if (realTarget === '') return '';
  if (realTarget === realRoot) return realTarget;
  return realTarget.startsWith(realRoot + pathSep) ? realTarget : '';
}

/** resolveInsideDir 的异步版（语义完全相同；参数里的 fsPromises 便于注入与测试）。 */
export async function resolveInsideDirAsync(target, rootDir, fsPromises) {
  const root = (rootDir === undefined || rootDir === null || String(rootDir) === '') ? '' : String(rootDir);
  if (root === '') return '';
  const realRoot = await realOfAsync(pathResolve(root), fsPromises);
  if (realRoot === '') return '';
  const text = (target === undefined || target === null) ? '' : String(target);
  if (text === '') return '';
  const realTarget = await realOfAsync(pathResolve(text), fsPromises);
  if (realTarget === '') return '';
  if (realTarget === realRoot) return realTarget;
  return realTarget.startsWith(realRoot + pathSep) ? realTarget : '';
}

/** 白名单目录下**多个**根之一（如 qq-images 与其 gen 子目录）：命中任一根即返回 real 路径。 */
export function resolveInsideAnyDir(target, rootDirs) {
  const list = Array.isArray(rootDirs) ? rootDirs : [];
  for (const root of list) {
    const hit = resolveInsideDir(target, root);
    if (hit !== '') return hit;
  }
  return '';
}