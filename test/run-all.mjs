/**
 * 汇总 runner：依次跑完 test/ 下登记的全部套件，单个失败不中断，末尾汇总。
 * 用法：node test/run-all.mjs（package.json 的 test 脚本指向这里）
 *
 * 卫生约定：会起子进程/真实定时器的套件（adapter、plugin、admin、proactive-round）偶尔
 * 会因为机器抖动超时；失败一律**重试一次**，重试通过会显式标注「重试通过」——不静默吞掉，
 * 也不让一次抖动把整条 CI 判红。连续两次失败才算真失败。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readdirSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const suites = [
  'test-adapter.mjs', 'test-adapter-reverse.mjs', 'test-adapter-reconnect.mjs', 'test-action-priority.mjs', 'test-tool-output.mjs', 'test-plugin.mjs', 'test-client.mjs',
  'test-admin.mjs', 'test-http.mjs', 'test-config.mjs', 'test-websearch.mjs', 'test-imagegen.mjs', 'test-sticker.mjs', 'test-session-id.mjs', 'test-session-archive.mjs', 'test-compat.mjs', 'test-history.mjs', 'test-proactive.mjs', 'test-proactive-round.mjs', 'test-owner-settings.mjs',
  'test-totp.mjs', 'test-totp-cli.mjs', 'test-qr.mjs', 'test-flow-auth.mjs', 'test-flow-store.mjs', 'test-flow-commands.mjs', 'test-flow-gate.mjs', 'test-flow-wiring.mjs', 'test-interim.mjs',
  'test-security.mjs', 'test-guard-proxy.mjs', 'test-gate-guard.mjs', 'test-chunk.mjs', 'test-msgid-cache.mjs', 'test-qq-bind.mjs', 'test-stream-bridge.mjs', 'test-model-router.mjs',
  'test-adapter-onebot12.mjs', 'test-adapter-milky.mjs', 'test-adapter-satori.mjs', 'test-adapter-qq-official.mjs',
  'test-valve-assembly.mjs', 'test-group-actions.mjs', 'test-qr-consistency.mjs', 'test-flow-resume.mjs', 'test-update-check.mjs',
];

// 单套间超时：卡死的套间以前会让整个 CI 一起挂到 workflow 上限，看不出是谁卡住。
const SUITE_TIMEOUT_MS = 180000;

function runSuite(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, 'test', file)], { cwd: root, stdio: 'inherit' });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch (error) { /* 已退出 */ } }, SUITE_TIMEOUT_MS);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ file, ok: code === 0 && timedOut !== true, code: code ?? -1, timedOut });
    });
    child.on('error', (err) => { clearTimeout(timer); resolve({ file, ok: false, code: -1, err: String(err) }); });
  });
}

// 清单与目录双向核对：新增/改名 test 文件忘了登记会「永远不跑且全绿」（清单写死就是这个后果）。
const onDisk = readdirSync(join(root, 'test')).filter((f) => /^test-.*\.mjs$/.test(f)).sort();
const missingOnDisk = suites.filter((f) => onDisk.includes(f) !== true);
const notRegistered = onDisk.filter((f) => suites.includes(f) !== true);
const drift = missingOnDisk.length > 0 || notRegistered.length > 0;
if (drift === true) {
  console.log('清单与目录不一致：');
  if (missingOnDisk.length > 0) console.log('  清单里有但目录没有：' + missingOnDisk.join(', '));
  if (notRegistered.length > 0) console.log('  目录里有但清单没登记：' + notRegistered.join(', '));
}

const results = [];
for (const s of suites) {
  const first = await runSuite(s);
  if (first.ok === true) { results.push(first); continue; }
  console.log('\n⚠️ ' + s + ' 第一次失败（code=' + String(first.code) + (first.timedOut === true ? '，超时' : '') + '），重试一次…');
  const retry = await runSuite(s);
  results.push(retry.ok === true ? Object.assign({}, retry, { retried: true }) : first);
}

console.log('\n===== 汇总 =====');
let okCount = 0;
for (const r of results) {
  console.log((r.ok ? "  [PASS] " : "  [FAIL] ") + r.file
    + (r.retried === true ? "（重试通过）" : "")
    + (r.timedOut === true ? "（超时 " + String(SUITE_TIMEOUT_MS / 1000) + "s 被杀）" : "")
    + (r.code === -1 ? "（无法启动" + (r.err ? "：" + r.err : "") + "）" : ""));
  if (r.ok) okCount += 1;
}
console.log(okCount + '/' + results.length + ' 套件通过');
if (drift === true) console.log('⚠️ 套件清单与 test/ 目录不一致（见上），可能有套件没跑到');
process.exit(okCount === results.length && drift !== true ? 0 : 1);
