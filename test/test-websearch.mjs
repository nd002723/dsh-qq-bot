/** 单元测试：lib/websearch.js —— parseWebSearchResponse 结构化解析 */
import { parseWebSearchResponse } from '../lib/websearch.js';

const results = [];
let failures = 0;
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok));
  if (ok) console.log('  [PASS] ' + name);
  else { failures += 1; console.log('  [FAIL] ' + name + (detail ? ' — ' + detail : '')); }
};

console.log('1. parseWebSearchResponse 结构化解析');
const baseBody = {
  content: [
    { type: 'text', text: '答案', citations: [{ url: 'https://a.example.com/x', cited_text: '甲摘要' }] },
    { type: 'web_search_tool_result', content: [
      { type: 'web_search_result', url: 'https://a.example.com/x', title: '甲', page_age: '2026-01-01' },
      { type: 'web_search_result', url: 'https://b.example.com/y', title: '乙' },
    ] },
  ],
};
check('解析出 url/title/snippet/publishedAt', (() => { const s = parseWebSearchResponse(baseBody); return s.length === 2 && s[0].url === 'https://a.example.com/x' && s[0].title === '甲' && s[0].snippet === '甲摘要' && s[0].publishedAt === '2026-01-01' && s[1].url === 'https://b.example.com/y' && s[1].title === '乙'; })());
check('同一 URL 去重（只保留首条）', (() => { const s = parseWebSearchResponse({ content: [ { type: 'web_search_tool_result', content: [ { type: 'web_search_result', url: 'https://a.example.com/x', title: '甲' }, { type: 'web_search_result', url: 'https://a.example.com/x', title: '甲2' } ] } ] }); return s.length === 1 && s[0].title === '甲'; })());
check('孤儿引用不造 snippet（citation 无对应 result 则忽略）', (() => { const s = parseWebSearchResponse({ content: [ { type: 'text', text: 'x', citations: [{ url: 'https://orphan.example.com/', cited_text: '孤儿摘要' }] }, { type: 'web_search_tool_result', content: [ { type: 'web_search_result', url: 'https://a.example.com/', title: 'A' } ] } ] }); return s.length === 1 && s[0].snippet === undefined; })());
check('无 web_search_tool_result 块时抛错', (() => { try { parseWebSearchResponse({ content: [{ type: 'text', text: 'x' }] }); return false; } catch { return true; } })());
check('result 无 title 只给 url + snippet（来自引用文本）', (() => { const s = parseWebSearchResponse({ content: [ { type: 'text', text: 'x', citations: [{ url: 'https://c.example.com/', cited_text: '丙摘要' }] }, { type: 'web_search_tool_result', content: [ { type: 'web_search_result', url: 'https://c.example.com/' } ] } ] }); return s.length === 1 && s[0].url === 'https://c.example.com/' && s[0].snippet === '丙摘要' && s[0].title === undefined; })());

const passed = results.filter(Boolean).length;
console.log('\n' + passed + '/' + results.length + ' 项通过');
if (failures > 0) { console.log('WebSearch 自测失败'); process.exit(1); }
console.log('WebSearch 自测通过');
process.exit(0);
