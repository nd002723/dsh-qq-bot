#!/usr/bin/env node
/**
 * 闸门区改动的判定（GUI 填码解锁 → 保存即消费；不保存不应用）。
 *
 *   node test-gate-guard.mjs
 *
 * 守的安全边界：
 *   - 动态码关着、名单变化 → 不要码（关着时名单只是摆设）；
 *   - 动态码开着、名单变化 → 要码；
 *   - 动态码开关本身变化（开↔关）→ 要码（否则「先关、改名单、再开」能绕过名单保护）；
 *   - 没码 / 错码 / 没配 secret 一律拒绝（调用方回滚名单与开关并清码）；
 *   - 什么都没变 → 接受，但顺手把填进来的码清掉（码不落盘）。
 */
import { sameToolList, decideGateEdit } from '../lib/valve/tool/gate-guard.js';
import { generateSecret, totp } from '../lib/valve/security/totp.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail === '' ? '' : ' — ' + detail)); }
}

const secret = generateSecret(20);
const now = 1700000000000;
const prev = ['subagent', 'moli_fetch'];
const next = ['subagent', 'moli_fetch', 'workflow'];
const code = totp(secret, { timeMs: now });

console.log('1. 名单比较（顺序敏感）');
check('内容相同 → true', sameToolList(['a', 'b'], ['a', 'b']) === true);
check('顺序不同 → false', sameToolList(['a', 'b'], ['b', 'a']) === false);
check('长度不同 → false', sameToolList(['a'], ['a', 'b']) === false);

console.log('\n2. 动态码关着：改名单不需要码');
{
  const r = decideGateEdit({ previousEnabled: false, nextEnabled: false, previous: prev, next, code: '', secret, nowMs: now });
  check('接受改动', r.accept === true && r.changed === true && r.needsCode === false, JSON.stringify(r));
  check('没填码就不需要清码', r.clearCode === false, JSON.stringify(r));
}

console.log('\n3. 动态码开着：改名单没码 / 错码一律拒绝');
{
  const noCode = decideGateEdit({ previousEnabled: true, nextEnabled: true, previous: prev, next, code: '', secret, nowMs: now });
  check('没码 → 拒绝', noCode.accept === false && noCode.reason === 'no-code', JSON.stringify(noCode));
  const bad = decideGateEdit({ previousEnabled: true, nextEnabled: true, previous: prev, next, code: '000000', secret, nowMs: now });
  check('错码 → 拒绝并清码', bad.accept === false && bad.clearCode === true, JSON.stringify(bad));
  const noSecret = decideGateEdit({ previousEnabled: true, nextEnabled: true, previous: prev, next, code: code, secret: '', nowMs: now });
  check('没配 secret → 拒绝', noSecret.accept === false && noSecret.reason === 'no-secret', JSON.stringify(noSecret));
}

console.log('\n4. 动态码开着：对码（同一窗口）接受，并标记清码');
{
  const ok = decideGateEdit({ previousEnabled: true, nextEnabled: true, previous: prev, next, code, secret, nowMs: now });
  check('对码 → 接受', ok.accept === true && ok.changed === true && ok.reason === 'ok', JSON.stringify(ok));
  check('接受后要求清空码字段', ok.clearCode === true, JSON.stringify(ok));
}

console.log('\n5. 相邻窗口（±1）仍认，两格之前不认');
{
  const adjacent = totp(secret, { timeMs: now + 30000 });
  const r1 = decideGateEdit({ previousEnabled: true, nextEnabled: true, previous: prev, next, code: adjacent, secret, nowMs: now });
  check('+1 窗口的码也接受（时钟漂移容差）', r1.accept === true, JSON.stringify(r1));
  const stale = totp(secret, { timeMs: now + 90000 });
  const r2 = decideGateEdit({ previousEnabled: true, nextEnabled: true, previous: prev, next, code: stale, secret, nowMs: now });
  check('+3 窗口的码拒绝', r2.accept === false, JSON.stringify(r2));
}

console.log('\n6. 开关本身变化（开↔关）也要码');
{
  const offNoCode = decideGateEdit({ previousEnabled: true, nextEnabled: false, previous: prev, next: prev.slice(), code: '', secret, nowMs: now });
  check('关掉闸门没码 → 拒绝（不能比改名单更容易）', offNoCode.accept === false && offNoCode.reason === 'no-code', JSON.stringify(offNoCode));
  const offWithCode = decideGateEdit({ previousEnabled: true, nextEnabled: false, previous: prev, next: prev.slice(), code, secret, nowMs: now });
  check('关掉闸门带对码 → 接受', offWithCode.accept === true, JSON.stringify(offWithCode));
  const onNoCode = decideGateEdit({ previousEnabled: false, nextEnabled: true, previous: prev, next: prev.slice(), code: '', secret, nowMs: now });
  check('打开闸门没码 → 拒绝（否则可先开后放行名单）', onNoCode.accept === false, JSON.stringify(onNoCode));
  const onWithCode = decideGateEdit({ previousEnabled: false, nextEnabled: true, previous: prev, next: prev.slice(), code, secret, nowMs: now });
  check('打开闸门带对码 → 接受', onWithCode.accept === true, JSON.stringify(onWithCode));
}

console.log('\n7. 什么都没变：接受，但填进来的码要清掉');
{
  const same = decideGateEdit({ previousEnabled: true, nextEnabled: true, previous: prev, next: prev.slice(), code, secret, nowMs: now });
  check('不接受改动但也不报错', same.accept === true && same.changed === false && same.reason === 'unchanged', JSON.stringify(same));
  check('顺手清掉码', same.clearCode === true, JSON.stringify(same));
}

console.log('\n8. 换掉闸门自己的锁也要码，且必须用「变更前」那把锁验（2026-10-28 审计 A1）');
{
  const other = generateSecret(20);
  const baseSec = { totpSecret: secret, recoveryHashes: [], recoverySalt: '', maxAttempts: 5, lockoutMinutes: 5, grantTtlSeconds: 300 };
  const swapped = Object.assign({}, baseSec, { totpSecret: other });

  const noCode = decideGateEdit({ previousEnabled: true, nextEnabled: true, previous: prev, next: prev.slice(), previousSecurity: baseSec, nextSecurity: swapped, code: '', nowMs: now });
  check('只换 totpSecret、名单不动 → 仍然要码', noCode.accept === false && noCode.needsCode === true, JSON.stringify(noCode));

  const codeFromNew = totp(other, { timeMs: now });
  const newLock = decideGateEdit({ previousEnabled: true, nextEnabled: true, previous: prev, next: prev.slice(), previousSecurity: baseSec, nextSecurity: swapped, code: codeFromNew, nowMs: now });
  check('用「新」密钥算的码 → 拒绝（否则换锁者用自己那把就能过）', newLock.accept === false, JSON.stringify(newLock));

  const codeFromOld = totp(secret, { timeMs: now });
  const legit = decideGateEdit({ previousEnabled: true, nextEnabled: true, previous: prev, next: [], previousSecurity: baseSec, nextSecurity: swapped, code: codeFromOld, nowMs: now });
  check('用「旧」密钥算的码 → 接受（这才是合法换锁）', legit.accept === true, JSON.stringify(legit));

  // 恢复码 / 试错上限 / 授权时长同样是保护面：改了都要码。
  const weaken = Object.assign({}, baseSec, { maxAttempts: 1000000 });
  const weakenEdit = decideGateEdit({ previousEnabled: true, nextEnabled: true, previous: prev, next: prev.slice(), previousSecurity: baseSec, nextSecurity: weaken, code: '', nowMs: now });
  check('把 maxAttempts 调成天文数字 → 要码', weakenEdit.accept === false && weakenEdit.needsCode === true, JSON.stringify(weakenEdit));

  const addRecovery = Object.assign({}, baseSec, { recoveryHashes: ['HASH-1'], recoverySalt: 'S' });
  const recEdit = decideGateEdit({ previousEnabled: true, nextEnabled: true, previous: prev, next: prev.slice(), previousSecurity: baseSec, nextSecurity: addRecovery, code: '', nowMs: now });
  check('塞进自己的恢复码 → 要码', recEdit.accept === false && recEdit.needsCode === true, JSON.stringify(recEdit));

  const longerGrant = Object.assign({}, baseSec, { grantTtlSeconds: 31536000 });
  const ttlEdit = decideGateEdit({ previousEnabled: true, nextEnabled: true, previous: prev, next: prev.slice(), previousSecurity: baseSec, nextSecurity: longerGrant, code: '', nowMs: now });
  check('把 grantTtlSeconds 拉到一年 → 要码', ttlEdit.accept === false && ttlEdit.needsCode === true, JSON.stringify(ttlEdit));

  // 保护面完全没动时不该平白要码（别把正常改名单变成永远失败）。
  const untouched = decideGateEdit({ previousEnabled: true, nextEnabled: true, previous: prev, next: prev.slice(), previousSecurity: baseSec, nextSecurity: Object.assign({}, baseSec), code, nowMs: now });
  check('保护面没动 → 行为与以前一致', untouched.accept === true && untouched.reason === 'unchanged', JSON.stringify(untouched));
}

console.log('\n9. 闸门码不能重放（以前是纯无状态校验）');
{
  const gateState = { lastCounter: undefined, fails: 0, lockedUntil: 0 };
  const step1 = ['subagent'];
  const step2 = ['subagent', 'workflow'];
  const firstUse = decideGateEdit({ previousEnabled: true, nextEnabled: true, previous: prev, next: step1, code, secret, gateState, nowMs: now });
  check('第一次用这个码 → 接受', firstUse.accept === true, JSON.stringify(firstUse));
  const replay = decideGateEdit({ previousEnabled: true, nextEnabled: true, previous: step1, next: step2, code, secret, gateState, nowMs: now });
  check('同一个码再用来改第二次 → replayed', replay.accept === false && replay.reason === 'replayed', JSON.stringify(replay));
}

console.log('\n10. 闸门码连错要锁定（以前可以无限试）');
{
  const gateState = { lastCounter: undefined, fails: 0, lockedUntil: 0 };
  const wrong = '000000' === totp(secret, { timeMs: now }) ? '111111' : '000000';
  let last = null;
  for (let index = 0; index < 5; index += 1) {
    last = decideGateEdit({ previousEnabled: true, nextEnabled: true, previous: prev, next: [], code: wrong, secret, gateState, nowMs: now });
  }
  check('连错 5 次后进入锁定', (Number(gateState.lockedUntil) || 0) > now, JSON.stringify(gateState));
  const lockedOut = decideGateEdit({ previousEnabled: true, nextEnabled: true, previous: prev, next: [], code: totp(secret, { timeMs: now }), secret, gateState, nowMs: now });
  check('锁定期间用正确的码也拒（reason=locked）', lockedOut.accept === false && lockedOut.reason === 'locked', JSON.stringify(lockedOut));
  const later = now + 5 * 60000 + 1000;
  const unlocked = decideGateEdit({ previousEnabled: true, nextEnabled: true, previous: prev, next: [], code: totp(secret, { timeMs: later }), secret, gateState, nowMs: later });
  check('锁定到期后恢复', unlocked.accept === true, JSON.stringify(unlocked));
}

console.log('\n11. 锁定参数取「上一次被接受」的保护面，不能被本次提交的新配置放大');
{
  // 攻击面：改配置的人把 maxAttempts 抬到 1e9、lockout 设成 1 分钟，然后连错——
  // 若锁定读 nextSecurity 就永远不锁；读 previousSecurity 才守得住。
  const baseSec = { totpSecret: secret, recoveryHashes: [], recoverySalt: '', maxAttempts: 5, lockoutMinutes: 5, grantTtlSeconds: 30 };
  const huge = Object.assign({}, baseSec, { maxAttempts: 1000000000, lockoutMinutes: 1 });
  const gateState = { lastCounter: undefined, fails: 0, lockedUntil: 0 };
  const wrong = '000000' === totp(secret, { timeMs: now }) ? '111111' : '000000';
  let lockedAt = -1;
  for (let index = 0; index < 200; index += 1) {
    decideGateEdit({ previousEnabled: true, nextEnabled: true, previous: prev, next: [], previousSecurity: baseSec, nextSecurity: huge, code: wrong, gateState, nowMs: now });
    if ((Number(gateState.lockedUntil) || 0) > now) { lockedAt = index + 1; break; }
  }
  check('把 maxAttempts 抬到 1e9 也照样在第 5 次锁定（按旧配置算）', lockedAt === 5, 'lockedAt=' + lockedAt);
  check('锁定用的是旧 lockoutMinutes(5 分钟)', (Number(gateState.lockedUntil) || 0) === now + 5 * 60000, 'until=' + ((Number(gateState.lockedUntil) || 0) - now));
}
console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail > 0) process.exitCode = 1;
