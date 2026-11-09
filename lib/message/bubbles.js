/**
 * 把一个回复拆成「多个气泡」。
 *
 * 背景：模型经常一次输出两段（中间空行），比如
 *     早啊
 *
 *     眼睛还没睁开呢
 * 以前整条发出去，QQ 就渲染成**一个气泡两行**。人要的是两句分开的气泡。
 *
 * 规则（保守优先，拆错比不拆更难看）：
 *   - 只有 2–3 段、每段都是单行短句（≤ maxPartChars）才拆；
 *   - 含代码块 / 表格 / 列表 / 标题的整条不拆 —— 那是排版，不是聊天；
 *   - 段落本身超过一行（内部还有换行）也不拆；
 *   - 空行之外的换行不当作分段（避免把一首诗拆散）。
 */
export function splitBubbles(text, options) {
  const opts = (options === undefined || options === null) ? {} : options;
  const maxPartChars = Math.max(10, Number(opts.maxPartChars) || 80);
  const maxParts = Math.max(2, Number(opts.maxParts) || 3);
  const raw = String(text === undefined || text === null ? '' : text).trim();
  if (raw === '') return [raw];
  if (raw.length > maxPartChars * maxParts) return [raw];
  // 代码块 / 表格 / 列表 / 标题：保持原样
  if (/```|~~~/.test(raw)) return [raw];
  if (/^\s*\|.*\|\s*$/m.test(raw)) return [raw];
  if (/^\s*(?:[-*+]|\d+[.)])\s+/m.test(raw)) return [raw];
  if (/^\s*#{1,6}\s+/m.test(raw)) return [raw];
  if (/^\s*>/m.test(raw)) return [raw];

  const parts = raw.split(/\n[ \t]*\n+/).map((part) => part.trim()).filter((part) => part !== '');
  if (parts.length < 2 || parts.length > maxParts) return [raw];
  for (const part of parts) {
    if (part.length > maxPartChars) return [raw];
    if (part.includes('\n')) return [raw];
  }
  return parts;
}
