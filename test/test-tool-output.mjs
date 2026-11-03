#!/usr/bin/env node
/** 工具返回值清理：undefined 不能出现在 lossless JSON 输出里。 */
import { sanitizeToolValue } from '../lib/tools/index.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail === '' ? '' : ' — ' + detail)); }
}

const cleaned = sanitizeToolValue({
  ok: true,
  error: undefined,
  sent: false,
  nested: { a: undefined, b: 1, c: null },
  list: [undefined, 1, { x: undefined, y: 2 }],
  text: 'hi',
});
check('顶层 undefined 字段被删除', Object.prototype.hasOwnProperty.call(cleaned, 'error') === false);
check('嵌套 undefined 字段被删除', Object.prototype.hasOwnProperty.call(cleaned.nested, 'a') === false && cleaned.nested.b === 1);
check('null 保留', cleaned.nested.c === null);
check('数组里的 undefined 被剔除', cleaned.list.length === 2 && cleaned.list[0] === 1);
check('数组内对象的 undefined 被删除', Object.prototype.hasOwnProperty.call(cleaned.list[1], 'x') === false && cleaned.list[1].y === 2);
check('普通值原样保留', cleaned.ok === true && cleaned.sent === false && cleaned.text === 'hi');
check('非对象入参原样返回', sanitizeToolValue(undefined) === undefined && sanitizeToolValue('x') === 'x' && sanitizeToolValue(null) === null);
check('不修改入参', (() => { const src = { a: undefined, b: 1 }; sanitizeToolValue(src); return Object.prototype.hasOwnProperty.call(src, 'a'); })());

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail > 0) process.exitCode = 1;
