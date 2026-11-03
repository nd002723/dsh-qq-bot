// 表情包「发不发」的闸门：概率 + 每群每小时上限 + 同图去重。
//
// 为什么需要：工具描述里教了模型「合适就主动配表情包」，但如果每轮对话都配一张，群里会变成刷图。
// 同类实现常见做法是「禁发群 / 群活跃度 / 窗口频率 / 每日预算 / 同图去重」这一排刹车；
// 这里取其核心（频率 + 去重），再补一个**概率**——因为「这轮要不要配图」本质是随机的观感问题，
// 用概率最直接。
//
// 规则（按顺序判定，命中即拒）：
//   1. force 之外先看概率：random() < chance 才放行（chance=1 恒放行，chance=0 只允许 force）；
//   2. 每群每小时上限（maxPerHour，0=不限）——force 也受这条限制，避免被用来刷屏；
//   3. 同图去重（dupTTLHours，0=关）——force 跳过（用户明确要某张时不该被去重挡住）。
//
// 状态只在内存里（进程重启清零）：这是「观感节流」，不是账本，没必要落盘。

/** 默认值（与 sticker-conf.json 保持一致）。 */
export const STICKER_GATE_DEFAULTS = { chance: 0.3, maxPerHour: 6, dupTTLHours: 24 };

/**
 * @param {object} deps
 * @param {() => any} deps.getConfig 取 sticker 配置块
 * @param {() => number} [deps.now] 时间源（测试注入）
 * @param {() => number} [deps.random] 随机源（测试注入）
 * @param {(line: string) => void} [deps.log] 诊断日志
 */
export function createStickerGate(deps) {
  const source = deps === undefined || deps === null ? {} : deps;
  const getConfig = typeof source.getConfig === 'function' ? source.getConfig : () => ({});
  const now = typeof source.now === 'function' ? source.now : () => Date.now();
  const random = typeof source.random === 'function' ? source.random : () => Math.random();
  const log = typeof source.log === 'function' ? source.log : () => {};

  /** groupId -> [{ at, id }]，按发送时间升序。 */
  const sentByGroup = new Map();

  function numberOr(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function conf() {
    const raw = getConfig();
    const c = raw !== null && raw !== undefined && typeof raw === 'object' ? raw : {};
    return {
      chance: Math.min(1, Math.max(0, numberOr(c.chance, STICKER_GATE_DEFAULTS.chance))),
      maxPerHour: Math.max(0, numberOr(c.maxPerHour, STICKER_GATE_DEFAULTS.maxPerHour)),
      dupTTLHours: Math.max(0, numberOr(c.dupTTLHours, STICKER_GATE_DEFAULTS.dupTTLHours)),
    };
  }

  /** 取该群最近的发送记录（顺带裁掉用不到的旧记录）。 */
  function historyOf(groupId) {
    const at = now();
    const keepMs = Math.max(3600 * 1000, conf().dupTTLHours * 3600 * 1000);
    const list = (sentByGroup.get(groupId) || []).filter((row) => at - row.at <= keepMs);
    if (list.length === 0) sentByGroup.delete(groupId);
    else sentByGroup.set(groupId, list);
    return list;
  }

  /** 上次整表清扫时间（节流用）与最小间隔。 */
  let lastSweepAt = 0;
  const SWEEP_MIN_MS = 60 * 1000;

  /**
   * 清扫整张表：把已经过了时间窗的群整键删掉。
   * 为什么需要：单群有 500 条硬上限，但「发过一次就再没人说话」的群会一直留一条尾巴——
   * 只有它下次再触发表情包判定时才会被裁掉。这里摊到每次发送顺手扫一遍，
   * 60 秒或群数超过 200 才真扫，避免每次发送都全表遍历。
   */
  function sweepStale(keepMs, at) {
    if (sentByGroup.size === 0) return;
    if (at - lastSweepAt < SWEEP_MIN_MS && sentByGroup.size < 200) return;
    lastSweepAt = at;
    for (const [key, list] of sentByGroup) {
      const kept = list.filter((row) => at - row.at <= keepMs);
      if (kept.length === 0) sentByGroup.delete(key);
      else if (kept.length !== list.length) sentByGroup.set(key, kept);
    }
  }

  /**
   * 判定这一张能不能发。
   * @param {{groupId: string, id?: string, force?: boolean}} input
   * @returns {{allowed: boolean, reason: string}}
   */
  function decide(input) {
    const data = input === undefined || input === null ? {} : input;
    const groupId = String(data.groupId === undefined || data.groupId === null ? '' : data.groupId);
    const id = String(data.id === undefined || data.id === null ? '' : data.id);
    const force = data.force === true;
    const c = conf();
    if (groupId === '') return { allowed: false, reason: '没有目标会话' };
    const history = historyOf(groupId);
    const at = now();

    if (force !== true && c.chance < 1) {
      const roll = random();
      if (roll >= c.chance) {
        return { allowed: false, reason: '概率闸门未通过（chance=' + String(c.chance) + '）；用户明确要求时可传 force=true' };
      }
    }

    if (c.maxPerHour > 0) {
      const used = history.filter((row) => at - row.at <= 3600 * 1000).length;
      if (used >= c.maxPerHour) {
        return { allowed: false, reason: '本群一小时内已发 ' + String(used) + ' 张（上限 ' + String(c.maxPerHour) + '）' };
      }
    }

    if (force !== true && c.dupTTLHours > 0 && id !== '') {
      const dupMs = c.dupTTLHours * 3600 * 1000;
      const repeat = history.find((row) => row.id === id && at - row.at <= dupMs);
      if (repeat !== undefined) {
        return { allowed: false, reason: '同图去重：这张 ' + String(c.dupTTLHours) + ' 小时内发过' };
      }
    }

    return { allowed: true, reason: '' };
  }

  /** 发送成功后记一笔（只有 decide 放行、且真的写出去之后才调）。 */
  function record(input) {
    const data = input === undefined || input === null ? {} : input;
    const groupId = String(data.groupId === undefined || data.groupId === null ? '' : data.groupId);
    if (groupId === '') return;
    const list = sentByGroup.get(groupId) || [];
    list.push({ at: now(), id: String(data.id === undefined || data.id === null ? '' : data.id) });
    sentByGroup.set(groupId, list);
    if (list.length > 500) sentByGroup.set(groupId, list.slice(-500));
    // 顺手清扫：把其他群过窗的记录删掉（节流见 sweepStale）
    const at = now();
    sweepStale(Math.max(3600 * 1000, conf().dupTTLHours * 3600 * 1000), at);
  }

  /** 测试用：清空记录。 */
  function reset() { sentByGroup.clear(); }

  /** 只读快照（测试 / 诊断）。 */
  function snapshot(groupId) {
    const key = String(groupId === undefined || groupId === null ? '' : groupId);
    return (sentByGroup.get(key) || []).map((row) => ({ at: row.at, id: row.id }));
  }

  return { decide, record, reset, snapshot, conf };
}

/**
 * 发送方式：随机「图文合并成一条」或「先图后字两条」。
 * @param {() => number} [random]
 * @returns {'together'|'separate'}
 */
export function pickStickerSendStyle(random) {
  const value = typeof random === 'function' ? Number(random()) : Math.random();
  return value < 0.5 ? 'together' : 'separate';
}
