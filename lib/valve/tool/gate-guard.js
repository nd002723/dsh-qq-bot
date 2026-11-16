/**
 * 闸门区改动的判定（GUI 里填码解锁 → 保存即消费；不保存就不应用）。
 *
 * 为什么放在纯函数里：这份名单决定「哪些工具必须过动态码」，判定必须能离网单测，
 * 不能埋在 settings 热更新回调里靠人肉点。
 *
 * 哪些改动要码：
 *   - 名单（gatedTools）变了，且动态码当前是开着的 → 要码；
 *   - 动态码开关本身变了（开 → 关，或 关 → 开）→ 要码。
 *     关掉闸门等于把整扇门拆了，不能比改名单更容易；打开闸门同样要一次码，
 *     否则拿到浏览器的人可以先关、改名单、再开，绕开名单保护。
 *   - **保护闸门的那些字段本身变了**（2026-10-28 审计 A1）→ 要码。
 *     这条以前是漏的：`totpSecret` / 恢复码 / `maxAttempts` / `lockoutMinutes` /
 *     `grantTtlSeconds` 都不在比较范围里，于是「换掉密钥」这一步连码都不会被问，
 *     而换完之后所有「改名单要码」的检查都变成「用攻击者的码验攻击者的锁」，
 *     一次原子保存就能把 gatedTools 清空。改锁必须比改名单更难，不能更容易。
 *   - 动态码没开、名单没变、保护字段没变 → 不要码。
 *
 * 验码用**变更前**那把密钥：换锁的人得先证明自己掌握旧锁。
 * 只有旧密钥为空（还没配过 / 已处于 fail-closed 的空密钥态）时才用新密钥验，
 * 那是首次配置的正常路径，此时没有任何东西可保护。
 *
 * 名单/开关没变：接受，但顺手把填进来的码清掉（码不落盘）。
 * 需要码却没码 / 码错 / 没配 secret / 被锁定 / 重放：拒绝——调用方负责回滚。
 */
import { totpVerify } from '../security/totp.js';

/** 闸门「保护面」：改动其中任何一项都要一次有效动态码。
 *
 * 这些字段合起来定义了「谁能开闸门」：密钥决定谁能算码，恢复码是备用钥匙，
 * maxAttempts / lockoutMinutes 决定在线暴力能不能试，grantTtlSeconds 决定一次
 * 授权能活多久。少保护任何一项，其余几项的强度都会被绕过。 */
export const GATE_SECURITY_FIELDS = [
  'totpSecret',
  'recoveryHashes',
  'recoverySalt',
  'maxAttempts',
  'lockoutMinutes',
  'grantTtlSeconds',
];

/** 闸门码连续输错多少次后锁、锁多久 —— **这是兜底常量，不是生产默认值**。
 *  实际生效值来自配置：`flowAuth.maxAttempts` / `flowAuth.lockoutMinutes`（见 decideGateEdit 里读 previousSecurity 那两行），
 *  生产默认是 5 次 / 15 分钟（`lib/valve/security/flow-auth-conf.json`）。
 *  下面这两个 5 只在配置里把对应字段设成 <= 0（等于「没配」）时才用得上。 */
const DEFAULT_GATE_MAX_ATTEMPTS = 5;
const DEFAULT_GATE_LOCKOUT_MINUTES = 5;

/** 两份工具名单是否一致（顺序敏感：用户看到的顺序就是保存下来的顺序）。 */
export function sameToolList(a, b) {
  const left = Array.isArray(a) ? a.map((item) => String(item)) : [];
  const right = Array.isArray(b) ? b.map((item) => String(item)) : [];
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * 把 flowAuth 配置压成可比较的保护面快照。
 * @param {any} source
 * @returns {{totpSecret: string, recoveryHashes: string[], recoverySalt: string,
 *            maxAttempts: number, lockoutMinutes: number, grantTtlSeconds: number}}
 */
export function securitySnapshot(source) {
  const s = (source !== null && typeof source === 'object') ? source : {};
  return {
    totpSecret: String(s.totpSecret === undefined || s.totpSecret === null ? '' : s.totpSecret).trim(),
    recoveryHashes: Array.isArray(s.recoveryHashes) ? s.recoveryHashes.map((item) => String(item)) : [],
    recoverySalt: String(s.recoverySalt === undefined || s.recoverySalt === null ? '' : s.recoverySalt),
    maxAttempts: Number(s.maxAttempts) || 0,
    lockoutMinutes: Number(s.lockoutMinutes) || 0,
    grantTtlSeconds: Number(s.grantTtlSeconds) || 0,
  };
}

/** 两份保护面快照是否完全一致。 */
export function sameSecurity(a, b) {
  const left = securitySnapshot(a);
  const right = securitySnapshot(b);
  for (const key of GATE_SECURITY_FIELDS) {
    if (key === 'recoveryHashes') {
      if (sameToolList(left.recoveryHashes, right.recoveryHashes) !== true) return false;
    } else if (left[key] !== right[key]) return false;
  }
  return true;
}

/**
 * @param {object} input
 * @param {boolean} input.previousEnabled 上一次被接受的 flowAuth.enabled
 * @param {boolean} input.nextEnabled     本次配置里的 flowAuth.enabled
 * @param {string[]} input.previous       上一次被接受的名单（内存基线）
 * @param {string[]} input.next           本次配置里的名单
 * @param {object} [input.previousSecurity] 上一次被接受的保护面快照（内存基线）
 * @param {object} [input.nextSecurity]     本次配置里的保护面
 * @param {string} input.code             用户在「闸门区」填的 6 位码
 * @param {string} [input.secret]         兼容旧调用：等同于 nextSecurity.totpSecret
 * @param {object} [input.gateState]      可变的闸门状态（{lastCounter, fails, lockedUntil}），用于重放与锁定
 * @param {number} [input.nowMs]          判定时间（测试注入）
 * @param {number} [input.window]         允许的窗口偏移，默认 **1**（±1 步长）。
 *                                        不要改成 0：闸门码是人手工填的，窗口 0 会让「第 29 秒
 *                                        读码、第 31 秒保存」失败；暴力风险由失败锁定承担
 * @returns {{accept: boolean, changed: boolean, needsCode: boolean, clearCode: boolean, reason: string}}
 */
export function decideGateEdit(input) {
  const opts = (input !== null && typeof input === 'object') ? input : {};
  const previousEnabled = opts.previousEnabled === true;
  const nextEnabled = opts.nextEnabled === true;
  const previous = Array.isArray(opts.previous) ? opts.previous.map((item) => String(item)) : [];
  const next = Array.isArray(opts.next) ? opts.next.map((item) => String(item)) : [];
  const code = String(opts.code === undefined || opts.code === null ? '' : opts.code).trim();

  // 旧调用只给 secret 时，把它当成「本次配置里的密钥」；保护面没给就按「没变」处理。
  const nextSecurity = securitySnapshot(
    opts.nextSecurity !== undefined && opts.nextSecurity !== null
      ? opts.nextSecurity
      : { totpSecret: opts.secret },
  );
  const previousSecurity = securitySnapshot(
    opts.previousSecurity !== undefined && opts.previousSecurity !== null
      ? opts.previousSecurity
      : nextSecurity,
  );

  const enabledChanged = previousEnabled !== nextEnabled;
  const listChanged = sameToolList(previous, next) === false;
  const securityChanged = sameSecurity(previousSecurity, nextSecurity) === false;
  const changed = enabledChanged || listChanged || securityChanged;
  if (changed === false) {
    return { accept: true, changed: false, needsCode: false, clearCode: code !== '', reason: 'unchanged' };
  }

  // 开 → 关、关 → 开：都要码（关掉闸门比改名单更狠，不能更容易）。
  // 保护面变了：任何时候都要码——那是锁本身，不是锁后面挡着的东西。
  // 名单改动：只有在闸门开着时才要码（关着的时候名单只是摆设）。
  const needsCode = enabledChanged === true || securityChanged === true || previousEnabled === true;
  if (needsCode !== true) {
    return { accept: true, changed: true, needsCode: false, clearCode: code !== '', reason: 'gate-off' };
  }

  // 验码用变更前那把锁：换密钥的人必须证明自己掌握旧密钥。
  const verifySecret = previousSecurity.totpSecret !== '' ? previousSecurity.totpSecret : nextSecurity.totpSecret;
  if (verifySecret === '') return { accept: false, changed: true, needsCode: true, clearCode: true, reason: 'no-secret' };
  if (code === '') return { accept: false, changed: true, needsCode: true, clearCode: false, reason: 'no-code' };

  const nowMs = Number.isFinite(opts.nowMs) ? Number(opts.nowMs) : Date.now();
  /** @type {{lastCounter?: number, fails?: number, lockedUntil?: number}} */
  const gateState = (opts.gateState !== null && typeof opts.gateState === 'object') ? opts.gateState : {};

  // 锁定：flow-auth 那条路 5 次就锁，这条以前一次都不记，6 位码退化成可无限试的纯校验。
  const lockedUntil = Number(gateState.lockedUntil) || 0;
  if (nowMs < lockedUntil) {
    return { accept: false, changed: true, needsCode: true, clearCode: false, reason: 'locked' };
  }

  // 窗口保留 ±1（与 flow-auth 的严格 window:0 不同，这是有意的）：
  // 闸门码是**人手工**在浏览器里填的，从读到码到点保存常要十几秒，窗口 0 会让
  // 「在第 29 秒读码、第 31 秒保存」直接失败。窗口放大带来的暴力风险改由下面的
  // 失败锁定 + 重放防护承担 —— 按生产默认 5 次 / 15 分钟算，单次命中率约 3×10⁻⁶，穷举要几百天。
  // （锁定参数取自配置，见 decideGateEdit；这里说的是默认值，不是兜底常量。）
  const window = Number.isInteger(opts.window) ? Number(opts.window) : 1;
  const verdict = totpVerify(verifySecret, code, { window, timeMs: nowMs });
  if (verdict.ok !== true) {
    // 锁定参数取**上一次被接受**的保护面，不是本次提交的新配置：
    // 用 nextSecurity 的话，改配置的人可以顺手把 maxAttempts 抬到 1e9、lockout 设成 1 分钟，
    // 于是连错多少次都不锁——「改锁比改名单更难」那道红线就被一次保存拆掉了。
    // 取 previousSecurity 后，要放宽锁定必须先过码（即先证明自己是合法操作者）。
    const maxAttempts = previousSecurity.maxAttempts > 0 ? previousSecurity.maxAttempts : DEFAULT_GATE_MAX_ATTEMPTS;
    const lockoutMinutes = previousSecurity.lockoutMinutes > 0 ? previousSecurity.lockoutMinutes : DEFAULT_GATE_LOCKOUT_MINUTES;
    const fails = (Number(gateState.fails) || 0) + 1;
    if (fails >= maxAttempts) {
      gateState.fails = 0;
      gateState.lockedUntil = nowMs + lockoutMinutes * 60000;
    } else {
      gateState.fails = fails;
    }
    return { accept: false, changed: true, needsCode: true, clearCode: true, reason: verdict.reason || 'bad-code' };
  }

  // 重放：同一个 counter 的成功码只能用一次（flow-auth 早就有这条，闸门码以前没有）。
  const lastCounter = Number(gateState.lastCounter);
  if (Number.isFinite(lastCounter) && verdict.counter <= lastCounter) {
    return { accept: false, changed: true, needsCode: true, clearCode: true, reason: 'replayed' };
  }
  gateState.lastCounter = verdict.counter;
  gateState.fails = 0;
  gateState.lockedUntil = 0;

  return { accept: true, changed: true, needsCode: true, clearCode: true, reason: 'ok' };
}
