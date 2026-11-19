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
import { readdirSync, readFileSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const suites = [
  'test-adapter.mjs', 'test-adapter-reverse.mjs', 'test-adapter-reconnect.mjs', 'test-action-priority.mjs', 'test-tool-output.mjs', 'test-plugin.mjs', 'test-client.mjs',
  'test-admin.mjs', 'test-http.mjs', 'test-config.mjs', 'test-websearch.mjs', 'test-imagegen.mjs', 'test-sticker.mjs', 'test-sticker-gate.mjs', 'test-session-id.mjs', 'test-session-archive.mjs', 'test-compat.mjs', 'test-history.mjs', 'test-proactive.mjs', 'test-proactive-round.mjs', 'test-proactive-wiring.mjs', 'test-owner-settings.mjs',
  'test-totp.mjs', 'test-totp-cli.mjs', 'test-qr.mjs', 'test-flow-auth.mjs', 'test-flow-store.mjs', 'test-flow-commands.mjs', 'test-flow-gate.mjs', 'test-flow-wiring.mjs', 'test-interim.mjs',
  'test-security.mjs', 'test-guard-proxy.mjs', 'test-gate-guard.mjs', 'test-chunk.mjs', 'test-bubbles.mjs', 'test-msgid-cache.mjs', 'test-qq-bind.mjs', 'test-stream-bridge.mjs', 'test-model-router.mjs',
  'test-adapter-onebot12.mjs', 'test-adapter-milky.mjs', 'test-adapter-satori.mjs', 'test-adapter-qq-official.mjs',
  'test-valve-assembly.mjs', 'test-group-actions.mjs', 'test-qr-consistency.mjs', 'test-flow-resume.mjs', 'test-update-check.mjs',
];

// 单套间超时：卡死的套间以前会让整个 CI 一起挂到 workflow 上限，看不出是谁卡住。
const SUITE_TIMEOUT_MS = 180000;

/**
 * 每个套件的断言项数基线（由 /tmp/collect-baseline.mjs 一次性采集）。
 *
 * 为什么需要它：run-all 以前只查「有没有失败」，套件删掉断言（或者在它自己里面跳过一段）时，
 * 自报总数变小、没有 FAIL、退出码 0 —— CI 完全无声。b77809d 删掉 27 条断言就是这么溜过去的。
 *
 * 维护方式：**有意**增删断言时同步改这里的数字；数字变小而你没改过，说明测试被悄悄删了。
 *
 * 三个已知边界（别把它当万能网）：
 *   1. **只防「变少」，不防「从没写」**。某个修复没带回归测试时，这里永远是绿的。
 *      补法是流程：改 lib/ 的 PR 要求同时有 test/ 改动（CI 比对 diff 文件集）。
 *   2. **只比总数，不比身份**。删 3 条真断言 + 加 3 条 `check(x, true)` 净变化为 0，照样通过。
 *   3. **数字取环境下限**。test-plugin / test-admin 在裸克隆里会因缺 @deepseek-ai/dsh-tools
 *      标 [SKIP]、总数变少；基线取裸克隆值，否则开发机永远绿而 CI 永远红。
 *
 * 另外：初版基线采自 b77809d（那批「删掉正文校验链」提交）**之后**，没有逐条复核那 27 条
 * 被删断言里是否混着真断言。如果将来发现某个套件的基线偏低了，从这条备注追查。
 */
const SUITE_BASELINE = Object.freeze({
  'test-action-priority.mjs': 10,
  'test-adapter-milky.mjs': 83,
  'test-adapter-onebot12.mjs': 30,
  'test-adapter-qq-official.mjs': 109,
  'test-adapter-reconnect.mjs': 11,
  'test-adapter-reverse.mjs': 19,
  'test-adapter-satori.mjs': 70,
  'test-adapter.mjs': 24,
  // 本机实测 40；裸克隆会把 5 条标 [SKIP]，那部分由『自报总数 + 跳过数』的判据抵掉。
  'test-admin.mjs': 40,
  'test-bubbles.mjs': 16,
  'test-chunk.mjs': 15,
  'test-client.mjs': 175,
  'test-compat.mjs': 14,
  'test-config.mjs': 56,
  'test-flow-auth.mjs': 43,
  'test-flow-commands.mjs': 49,
  'test-flow-gate.mjs': 16,
  'test-flow-resume.mjs': 39,
  'test-flow-store.mjs': 17,
  'test-flow-wiring.mjs': 23,
  'test-gate-guard.mjs': 32,
  'test-group-actions.mjs': 27,
  'test-guard-proxy.mjs': 53,
  'test-history.mjs': 20,
  'test-http.mjs': 31,
  'test-imagegen.mjs': 30,
  'test-interim.mjs': 14,
  'test-model-router.mjs': 23,
  'test-msgid-cache.mjs': 13,
  'test-owner-settings.mjs': 60,
  // 本机实测 172；裸克隆 26 条 SKIP 由上面的跳过数抵掉。
  'test-plugin.mjs': 175,
  'test-proactive-round.mjs': 54,
  'test-proactive-wiring.mjs': 23,
  'test-proactive.mjs': 76,
  'test-qq-bind.mjs': 20,
  'test-qr-consistency.mjs': 7,
  'test-qr.mjs': 18,
  'test-security.mjs': 55,
  'test-session-archive.mjs': 57,
  'test-session-id.mjs': 5,
  'test-sticker-gate.mjs': 25,
  'test-sticker.mjs': 100,
  'test-stream-bridge.mjs': 18,
  'test-tool-output.mjs': 8,
  'test-totp-cli.mjs': 14,
  'test-totp.mjs': 43,
  'test-update-check.mjs': 19,
  'test-valve-assembly.mjs': 27,
  'test-websearch.mjs': 64,
});

/**
 * 裸克隆（缺 @deepseek-ai/dsh-tools）时，依赖宿主服务的断言会被标 [SKIP]、不计入通过。
 * 这里只列**受影响的套件**及其在该环境下的实测总数；其它套件两套数字相同，无需登记。
 *
 * 为什么单独一张表而不是「总数 + 跳过数」：`skip()` 一次调用守一整段，
 * test-plugin 的 6 次 skip() 对应 26 条 check —— 跳过数不能当额度用（见下面的判据注释）。
 */
const SUITE_BASELINE_SKIPPED = Object.freeze({
  'test-admin.mjs': 35,
  'test-plugin.mjs': 146,
});

/** 套件自报的「N 通过 / M 失败」：捕获输出解析，用来交叉校验退出码。 */
// 套件自报有两套写法，都得认：
//   A) `N 通过 / M 失败`（多数套件）
//   B) `P/T 项通过`（另一批，T 是总数，失败数 = T - P）
const SELF_REPORT_A = /(\d+)\s*通过\s*\/\s*(\d+)\s*失败/;
const SELF_REPORT_B = /(\d+)\s*\/\s*(\d+)\s*项通过/;
//   C) `P/T checks passed`（三个适配器套件，共 202 项）——漏认它，这 202 项就对 CI 失明：
//      把 test-adapter 的 process.exit(1) 删掉后套件打印 23/24 + FAILED 却 exit 0，汇总照样 PASS。
const SELF_REPORT_C = /(\d+)\s*\/\s*(\d+)\s*checks passed/i;

function runSuite(file) {
  return new Promise((resolve) => {
    // 输出改成透传 + 同时抓一份文本：只看退出码是有盲区的——
    // 套件忘了 process.exit / 忘了 process.exitCode 时，断言全挂退出码仍是 0，
    // 汇总照样记 PASS（test-update-check 就这样漏了整片回归）。
    // 所以这里额外解析套件自己打的「N 通过 / M 失败」，两者一起判。
    const child = spawn(process.execPath, [join(root, 'test', file)], { cwd: root });
    let captured = '';
    const tee = (stream, sink) => {
      stream.on('data', (chunk) => {
        const text = String(chunk);
        if (captured.length < 8 * 1024 * 1024) captured += text;
        sink.write(chunk);
      });
    };
    tee(child.stdout, process.stdout);
    tee(child.stderr, process.stderr);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch (error) { /* 已退出 */ } }, SUITE_TIMEOUT_MS);
    child.on('exit', (code) => {
      clearTimeout(timer);
      // 取最后一次匹配（中途小结也可能打这几句，结尾那条才是最终结论）
      let selfFail = null;
      let selfTotal = null;
      const allA = captured.match(/\d+\s*通过\s*\/\s*\d+\s*失败/g);
      const allB = captured.match(/\d+\s*\/\s*\d+\s*项通过/g);
      const allC = captured.match(/\d+\s*\/\s*\d+\s*checks passed/gi);
      if (allA !== null && allA.length > 0) {
        const m = SELF_REPORT_A.exec(allA[allA.length - 1]);
        if (m !== null) { selfFail = Number(m[2]); selfTotal = Number(m[1]) + Number(m[2]); }
      } else if (allB !== null && allB.length > 0) {
        const m = SELF_REPORT_B.exec(allB[allB.length - 1]);
        if (m !== null) { selfFail = Number(m[2]) - Number(m[1]); selfTotal = Number(m[2]); }
      } else if (allC !== null && allC.length > 0) {
        const m = SELF_REPORT_C.exec(allC[allC.length - 1]);
        if (m !== null) { selfFail = Number(m[2]) - Number(m[1]); selfTotal = Number(m[2]); }
      }
      // 自报失败数 > 0 也判失败：这是对「退出码忘了设」的兜底。
      const selfReportedFailure = selfFail !== null && selfFail > 0;
      // 三项套件根本没打汇总行时，selfFail 为 null —— 以前这种「沉默套件」直接放行。
      // 现在要求每个套件都必须自报一次，否则视为不可验证（宁可真红，不要假绿）。
      const silent = selfTotal === null;
      // 项数基线：套件自报的总数低于历史值，说明有断言被删/被注释掉了。
      // 以前 run-all 只查「有没有失败」，b77809d 删了 27 条断言在 CI 里完全无声。
      //
      // **两套基线，按环境选** —— 不能靠「总数 + 跳过数」抵额度。
      //
      // 为什么不能用跳过数抵：`skip()` 是**一次调用守一整段**。test-plugin 有 6 次 skip() 调用，
      // 但被跳过的是 26 条 check（本机 172 → 裸克隆 146）。所以「另有 6 项跳过」+ 146 = 152 仍然
      // 对不上 172 —— 拿它当额度会直接把 CI 判红（而且提示文案会说「有断言被删了」，误导 reviewer）。
      //
      // 也不能像上一版那样「基线取裸克隆下限」：本机跳过 0，下限当基线等于把额度放大，
      // 实测在 test-proactive-round 上真删 3 条断言仍判 PASS。
      //
      // 所以：本机用自己的基线，裸克隆（缺 @deepseek-ai/dsh-tools）用 SKIPPED 那套。
      // 环境判定用「套件自报里有没有跳过」——只有那两个套件在裸克隆里会打「另有 N 项跳过」。
      const hasSkips = /（另有\s*\d+\s*项跳过/.test(captured);
      const baseline = (hasSkips === true ? SUITE_BASELINE_SKIPPED[file] : SUITE_BASELINE[file]);
      const shrunk = (baseline !== undefined && selfTotal !== null && selfTotal < baseline)
        ? (baseline - selfTotal) : 0;
      resolve({
        file,
        ok: code === 0 && timedOut !== true && selfReportedFailure !== true && silent !== true && shrunk === 0,
        code: code ?? -1,
        timedOut,
        selfFail,
        selfTotal,
        silent,
        shrunk,
      });
    });
    child.on('error', (err) => { clearTimeout(timer); resolve({ file, ok: false, code: -1, err: String(err) }); });
  });
}

// 清单与目录双向核对：新增/改名 test 文件忘了登记会「永远不跑且全绿」（清单写死就是这个后果）。
const onDisk = readdirSync(join(root, 'test')).filter((f) => /^test-.*\.mjs$/.test(f)).sort();
const missingOnDisk = suites.filter((f) => onDisk.includes(f) !== true);
const notRegistered = onDisk.filter((f) => suites.includes(f) !== true);
const drift = missingOnDisk.length > 0 || notRegistered.length > 0;

// ───── 机制自身的两条约定（F3 的 DC-1：以前无守护，改坏了全套仍绿）─────
// ① 基线判据必须真的会判红 —— 把 shrunk 恒置 0 就等于把整个基线机制废掉，而没有任何测试会转红。
// ② 诊断出口只能暴露 state —— 回加 getSessionApi 会给出 getEntry 这种**会建会话**的写入口。
const selfSrc = readFileSync(join(root, 'test', 'run-all.mjs'), 'utf8');
const pluginSrc = readFileSync(join(root, 'lib', 'gateway', 'plugin.js'), 'utf8');
const conventionProblems = [];
if (selfSrc.indexOf('shrunk === 0') < 0) conventionProblems.push('基线判据里没有 shrunk === 0（机制被废掉了）');
if (selfSrc.indexOf('SUITE_BASELINE_SKIPPED') < 0) conventionProblems.push('缺少裸克隆专用基线 SUITE_BASELINE_SKIPPED');
// 诊断出口现在走 WeakMap 侧信道（`DIAGNOSTICS.set(ctx, { state })`），**不再靠 apply 的返回值**。
// 原因是 cordis 把 apply 的返回值当 effect 校验：普通对象会 `throw new TypeError("Invalid effect")`，
// 插件在生产装不上（而单测直接调 apply 不经 fiber.effect，于是全套绿、生产红）。
if (pluginSrc.indexOf('DIAGNOSTICS.set(ctx') < 0) conventionProblems.push('诊断出口不见了（应该 DIAGNOSTICS.set(ctx, …)）');
// apply 末尾不得出现 `return {…}` —— 那正是踩雷的写法。
if (/\n  return \{[^;]*\};\n\}/.test(pluginSrc) === true) conventionProblems.push('apply 又返回了普通对象（cordis 会抛 Invalid effect）');
// 侧信道里只能放 state：曾经给过 getConfig / getSessionApi，两个都不是只读的
// （getSessionApi().getEntry() 会建会话）。
const diagSetAt = pluginSrc.lastIndexOf('DIAGNOSTICS.set(ctx');
const diagStmt = diagSetAt < 0 ? '' : pluginSrc.slice(diagSetAt, diagSetAt + 120);
if (diagStmt.indexOf('getConfig') >= 0 || diagStmt.indexOf('getSessionApi') >= 0) conventionProblems.push('诊断出口里又出现了 getConfig / getSessionApi（不是只读）');
const conventionsOk = conventionProblems.length === 0;
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
    + (r.code === -1 ? "（无法启动" + (r.err ? "：" + r.err : "") + "）" : "")
    // 自报相关的两种失败原因要打出来，否则只看到一个 FAIL 不知道该改哪里。
    + (r.silent === true ? "（套件没有自报汇总行，判为不可验证）" : "")
    + (r.shrunk !== undefined && r.shrunk > 0
      ? "（自报项数比基线少 " + String(r.shrunk) + " 项：有断言被删了？基线 " + String(SUITE_BASELINE[r.file]) + "）"
      : "")
    + (r.selfFail !== null && r.selfFail !== undefined && r.selfFail > 0
      ? "（自报失败 " + String(r.selfFail) + " 项）" : ""));
  if (r.ok) okCount += 1;
}
console.log(okCount + '/' + results.length + ' 套件通过');
if (drift === true) console.log('⚠️ 套件清单与 test/ 目录不一致（见上），可能有套件没跑到');
if (conventionsOk !== true) for (const p of conventionProblems) console.log('⚠️ ' + p);
process.exit(okCount === results.length && drift !== true && conventionsOk === true ? 0 : 1);
