/**
 * 汇总 runner：依次跑完 8 个测试套件，单个失败不中断，末尾汇总。
 * 用法：node test/run-all.mjs（package.json 的 test 脚本指向这里）
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const suites = [
  'test-adapter.mjs', 'test-adapter-reverse.mjs', 'test-plugin.mjs', 'test-client.mjs',
  'test-admin.mjs', 'test-http.mjs', 'test-config.mjs', 'test-websearch.mjs',
];

function runSuite(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, 'test', file)], { cwd: root, stdio: 'inherit' });
    child.on('exit', (code) => resolve({ file, ok: code === 0, code: code ?? -1 }));
    child.on('error', (err) => resolve({ file, ok: false, code: -1, err: String(err) }));
  });
}

const results = [];
for (const s of suites) results.push(await runSuite(s));

console.log('\n===== 汇总 =====');
let okCount = 0;
for (const r of results) {
  console.log((r.ok ? "  [PASS] " : "  [FAIL] ") + r.file + (r.code === -1 ? "（无法启动" + (r.err ? "：" + r.err : "") + "）" : ""));
  if (r.ok) okCount += 1;
}
console.log(okCount + '/' + results.length + ' 套件通过');
process.exit(okCount === results.length ? 0 : 1);
