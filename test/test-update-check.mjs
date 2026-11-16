#!/usr/bin/env node
/**
 * 新版本探测自测：`node test-update-check.mjs`
 *
 * 守的是：只在「确实更新 + 兼容当前 DSH」时提示；同版本/更旧/不兼容/网络失败都不提示；
 * 6 小时内只查一次；关闭开关后完全不查。
 */
import { createUpdateChecker, satisfies } from '../lib/api/update-check.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail === '' ? '' : ' — ' + detail)); }
}

const manifest = (version, range) => ({ version, dsh: { compatibility: { dsh: range } } });

console.log('1. range 判断（>=a <b / ^ / 精确 / *）');
{
  check('>= 下限之外', satisfies('0.2.0-rc.2', '>=0.2.0-rc.2 <0.3.0') === true);
  check('>= < 上限之外', satisfies('0.3.0', '>=0.2.0-rc.2 <0.3.0') === false);
  check('^ 主版本内', satisfies('0.12.8', '^0.12.0') === true);
  check('^ 主版本外', satisfies('0.13.0', '^0.12.0') === false);
  check('精确匹配', satisfies('1.2.3', '1.2.3') === true);
  check('* 恒真', satisfies('9.9.9', '*') === true);
}

console.log('2. 有更新且兼容 → hasUpdate=true / compatible=true');
{
  const checker = createUpdateChecker({
    currentVersion: '0.12.7',
    dshVersion: '0.2.1-rc.2',
    fetchJson: async () => manifest('0.12.8', '>=0.2.0-rc.2 <0.3.0'),
    now: () => 1000,
  });
  const info = await checker.check();
  check('标记有新版本', info.hasUpdate === true && info.latest === '0.12.8', JSON.stringify(info));
  check('兼容当前 DSH', info.compatible === true, JSON.stringify(info));
}

console.log('3. 同版本 / 更旧：不提示');
{
  const same = await createUpdateChecker({ currentVersion: '0.12.7', dshVersion: '0.2.1-rc.2', fetchJson: async () => manifest('0.12.7', '') , now: () => 1 }).check();
  check('同版本 hasUpdate=false', same.hasUpdate === false, JSON.stringify(same));
  const older = await createUpdateChecker({ currentVersion: '0.12.7', dshVersion: '0.2.1-rc.2', fetchJson: async () => manifest('0.12.3', ''), now: () => 1 }).check();
  check('更旧版本 hasUpdate=false', older.hasUpdate === false, JSON.stringify(older));
}

console.log('4. 更新但声明的 DSH 范围不匹配：提示里带「不兼容」');
{
  const info = await createUpdateChecker({
    currentVersion: '0.12.7',
    dshVersion: '0.2.1-rc.2',
    fetchJson: async () => manifest('0.13.0', '>=0.3.0'),
    now: () => 1,
  }).check();
  check('hasUpdate=true 但 compatible=false', info.hasUpdate === true && info.compatible === false, JSON.stringify(info));
}

console.log('5. 网络/解析失败：不抛错、不提示');
{
  const info = await createUpdateChecker({
    currentVersion: '0.12.7',
    dshVersion: '0.2.1-rc.2',
    fetchJson: async () => { throw new Error('ETIMEDOUT'); },
    now: () => 1,
  }).check();
  check('error 有值且 hasUpdate=false', typeof info.error === 'string' && info.hasUpdate === false, JSON.stringify(info));
}

console.log('6. 缓存：TTL 内只拉一次；开关关闭不拉');
{
  let calls = 0;
  let now = 0;
  const checker = createUpdateChecker({
    currentVersion: '0.12.7',
    dshVersion: '0.2.1-rc.2',
    fetchJson: async () => { calls += 1; return manifest('0.12.8', ''); },
    now: () => now,
    ttlMs: 60000,
  });
  await checker.check();
  await checker.check();
  check('TTL 内只调用一次', calls === 1, 'calls=' + calls);
  now = 61000;
  await checker.check();
  check('过期后再查一次', calls === 2, 'calls=' + calls);
  let offCalls = 0;
  const off = createUpdateChecker({ currentVersion: '0.12.7', dshVersion: '0.2.1-rc.2', fetchJson: async () => { offCalls += 1; return manifest('0.12.8', ''); }, enabled: () => false, now: () => 0 });
  const info = await off.check();
  check('关闭后不请求且 enabled=false', info.enabled === false && offCalls === 0, JSON.stringify(info));
}


console.log('7. registry 回退：首选失败自动换下一个');
{
  const calls = [];
  const checker = createUpdateChecker({
    currentVersion: '0.12.7',
    dshVersion: '0.2.1-rc.2',
    registry: ['https://a.invalid/x', 'https://b.invalid/x'],
    fetchJson: async (url) => { calls.push(url); if (url.includes('a.invalid')) throw new Error('ENOTFOUND'); return manifest('0.12.8', '>=0.2.0-rc.2 <0.3.0'); },
    now: () => 0,
  });
  const info = await checker.check();
  check('第一个失败后回退到第二个', calls.length === 2 && info.hasUpdate === true, JSON.stringify({ calls, info }));
  check('记录命中的 registry', String(info.registry || '').includes('b.invalid'), String(info.registry));
}

console.log('8. 失败缓存只有 5 分钟（网络抖动不该盲等 6 小时）');
{
  let calls = 0;
  let now = 0;
  const checker = createUpdateChecker({
    currentVersion: '0.12.7',
    dshVersion: '0.2.1-rc.2',
    fetchJson: async () => { calls += 1; throw new Error('ETIMEDOUT'); },
    now: () => now,
    ttlMs: 6 * 60 * 60 * 1000,
  });
  await checker.check();
  now = 4 * 60 * 1000;
  await checker.check();
  // 默认两个 registry：每次真正探测会各试一次，所以 calls 以 2 递增。
  check('失败后 4 分钟仍在 5 分钟错误缓存内（不重试）', calls === 2, 'calls=' + calls);
  now = 6 * 60 * 1000;
  await checker.check();
  check('超过 5 分钟后重新探测（两个 registry 各一次）', calls === 4, 'calls=' + calls);
}

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
// 必须给退出码：run-all 只看退出码，没有它的话断言全挂也照样记 PASS，
// 这一套件的任何回归都不会变红（连带 CI 对整片行为失明）。
if (fail > 0) process.exitCode = 1;
