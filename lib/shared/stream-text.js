// 从 DSH 的 llm.stream 分块里取「正文文本」的公共逻辑。
//
// 三个调用点共用这一份实现：识图（gateway/vision.js 的 askVision）、
// 主动发言（gateway/proactive-surface.js 的 proactiveLlmModel）、
// 表情包打标（tools/sticker.js 的 askTagModel）。
//
// DSH 的分块约定：一个文本块会先逐片给 `text-delta`，最后再给一个 `block-end`
// 带着这一整块的完整文本；推理内容走 `reasoning-delta`。所以取正文必须三级**互斥**，
// 任一级命中就不再往后取——把 block-end 与 delta 相加会让同一段话出现两遍：
//   1. text-delta 逐片累加 —— 正常流式；
//   2. 一个 delta 都没收到时，用 block-end 的整块文本 —— 非流式回包；
//   3. 正文仍为空时才用 reasoning —— 推理型模型把内容写进思考时兜底。
/** @typedef {{ text: string, reasoning: string, blockText: string, finishReason: string, source: 'text' | 'block' | 'reasoning' | '' }} Collected */

/**
 * 消费一个 llm.stream 的异步迭代器，返回按上述优先级取好的文本。
 * 调用方拿到 `text` 直接用即可；`source` 说明是三条路里的哪一条出的内容（便于打日志）。
 * @param {AsyncIterable<any>} stream DSH 的 llm.stream(...) 返回值（分块结构由 DSH 定义，这里只按字段取）。
 * @returns {Promise<Collected>}
 */
export async function collectStreamText(stream) {
  let out = '';
  let reasoning = '';
  let blockText = '';
  let finishReason = '';
  for await (const chunk of stream) {
    if (chunk === null || chunk === undefined) continue;
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text;
    else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') reasoning += chunk.text;
    else if (chunk.type === 'block-end' && chunk.block !== undefined && chunk.block !== null
      && chunk.block.type === 'text' && typeof chunk.block.text === 'string') blockText = chunk.block.text;
    else if (chunk.type === 'finish' || chunk.type === 'done') {
      if (typeof chunk.reason === 'string') finishReason = chunk.reason;
      else if (typeof chunk.finishReason === 'string') finishReason = chunk.finishReason;
    }
  }
  let source = /** @type {'' | 'text' | 'block' | 'reasoning'} */ ('');
  if (out.trim() !== '') source = 'text';
  else if (blockText.trim() !== '') { out = blockText; source = 'block'; }
  else if (reasoning.trim() !== '') { out = reasoning; source = 'reasoning'; }
  return { text: out.trim(), reasoning: reasoning.trim(), blockText: blockText.trim(), finishReason, source };
}
