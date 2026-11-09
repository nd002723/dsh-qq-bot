#!/usr/bin/env node
/**
 * 气泡拆分自测：`node test-bubbles.mjs`
 *
 * 守的是「该拆的拆、不该拆的一个都不动」：两句短话要分成两个气泡，
 * 长回答 / 代码块 / 表格 / 列表 / 多行段落一律保持原样 —— 拆错了比不拆更难看。
 */
import { splitBubbles } from '../lib/message/bubbles.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail === '' ? '' : ' — ' + detail)); }
}

console.log('1. 不该拆的');
check('空字符串原样', JSON.stringify(splitBubbles('')) === JSON.stringify(['']));
check('单个短句原样', JSON.stringify(splitBubbles('在呢')) === JSON.stringify(['在呢']));
check('单换行不拆（不是分段）', JSON.stringify(splitBubbles('早啊\n我醒了')) === JSON.stringify(['早啊\n我醒了']));
check('四段以上不拆', JSON.stringify(splitBubbles('一\n\n二\n\n三\n\n四')) === JSON.stringify(['一\n\n二\n\n三\n\n四']));

console.log('\n2. 该拆的');
check('两句短话 → 两个气泡',
  JSON.stringify(splitBubbles('早啊\n\n眼睛还没睁开呢')) === JSON.stringify(['早啊', '眼睛还没睁开呢']));
check('三段短话 → 三个气泡',
  JSON.stringify(splitBubbles('一\n\n二\n\n三')) === JSON.stringify(['一', '二', '三']));
check('首尾空白会被修掉',
  JSON.stringify(splitBubbles('  早啊  \n\n  我醒了  ')) === JSON.stringify(['早啊', '我醒了']));
check('连续多个空行仍按一次分段',
  JSON.stringify(splitBubbles('早啊\n\n\n\n我醒了')) === JSON.stringify(['早啊', '我醒了']));

console.log('\n3. 排版内容不拆');
check('代码块不拆', JSON.stringify(splitBubbles('```js\nconsole.log(1)\n```')) === JSON.stringify(['```js\nconsole.log(1)\n```']));
check('表格不拆', JSON.stringify(splitBubbles('| a | b |\n| - | - |')) === JSON.stringify(['| a | b |\n| - | - |']));
check('列表不拆', JSON.stringify(splitBubbles('- 一\n- 二')) === JSON.stringify(['- 一\n- 二']));
check('标题不拆', JSON.stringify(splitBubbles('# 标题\n\n正文')) === JSON.stringify(['# 标题\n\n正文']));
check('引用不拆', JSON.stringify(splitBubbles('> 引用\n\n正文')) === JSON.stringify(['> 引用\n\n正文']));

console.log('\n4. 长度闸门');
{
  const long = '这是很长的一句'.repeat(12); // 84 字
  check('单段超过 80 字不拆', splitBubbles(long + '\n\n' + long).length === 1);
  check('短句仍在阈值内会拆', splitBubbles('短句一\n\n短句二', { maxPartChars: 10 }).length === 2);
  check('maxParts 可调', splitBubbles('一\n\n二\n\n三', { maxParts: 2 }).length === 1);
}

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail > 0) process.exitCode = 1;
