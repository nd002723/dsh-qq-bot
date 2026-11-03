#!/usr/bin/env node
/**
 * 表情包闸门自测：`node test/test-sticker-gate.mjs`
 *
 * 守的是「别每轮对话都配一张图」这件事：
 *   1. 概率闸门：chance=0 只有 force 能发；chance=1 恒发；random 可注入，结果确定；
 *   2. 每群每小时上限：force 也受它限制（防刷屏）；
 *   3. 同图去重：TTL 内同一张不再发，但 force 可以强行发（用户点名要这张）；
 *   4. 按群隔离：A 群发满了不影响 B 群；
 *   5. 记录与裁剪：record 后计数生效，reset 清空。
 */
import { createStickerGate, STICKER_GATE_DEFAULTS } from '../lib/tools/sticker-gate.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail === '' ? '' : ' — ' + detail)); }
}

/** 可控时钟 + 可控随机 */
function makeGate(config, options = {}) {
  let nowMs = options.now === undefined ? Date.now() : options.now;
  const rolls = Array.isArray(options.rolls) ? options.rolls.slice() : [];
  return {
    gate: createStickerGate({
      getConfig: () => config,
      now: () => nowMs,
      random: () => (rolls.length > 0 ? rolls.shift() : Number(options.roll === undefined ? 0 : options.roll)),
      log: () => {},
    }),
    advance: (ms) => { nowMs += ms; },
  };
}

console.log('1. 概率闸门');
{
  const off = makeGate({ chance: 0, maxPerHour: 0, dupTTLHours: 0 }, { roll: 0 });
  check('chance=0：主动配图被拒', off.gate.decide({ groupId: 'g1', id: 'a.gif' }).allowed === false);
  check('chance=0：force 仍可发', off.gate.decide({ groupId: 'g1', id: 'a.gif', force: true }).allowed === true);

  const always = makeGate({ chance: 1, maxPerHour: 0, dupTTLHours: 0 }, { roll: 0.99 });
  check('chance=1：恒放行', always.gate.decide({ groupId: 'g1', id: 'a.gif' }).allowed === true);

  const half = makeGate({ chance: 0.5, maxPerHour: 0, dupTTLHours: 0 }, { rolls: [0.1, 0.9] });
  check('chance=0.5：roll 0.1 放行', half.gate.decide({ groupId: 'g1' }).allowed === true);
  check('chance=0.5：roll 0.9 拒绝', half.gate.decide({ groupId: 'g1' }).allowed === false);

  const dflt = makeGate({}, { roll: 0.99 });
  check('缺配置时走默认 chance=' + STICKER_GATE_DEFAULTS.chance + ' 并拒绝', dflt.gate.decide({ groupId: 'g1' }).allowed === false);
}

console.log('\n2. 每群每小时上限');
{
  const { gate, advance } = makeGate({ chance: 1, maxPerHour: 2, dupTTLHours: 0 });
  check('第 1 张放行', gate.decide({ groupId: 'g1', id: 'a.gif' }).allowed === true);
  gate.record({ groupId: 'g1', id: 'a.gif' });
  check('第 2 张放行', gate.decide({ groupId: 'g1', id: 'b.gif' }).allowed === true);
  gate.record({ groupId: 'g1', id: 'b.gif' });
  check('第 3 张被上限挡住', gate.decide({ groupId: 'g1', id: 'c.gif' }).allowed === false);
  check('force 也挡（防刷屏）', gate.decide({ groupId: 'g1', id: 'c.gif', force: true }).allowed === false);
  check('别的群不受影响', gate.decide({ groupId: 'g2', id: 'c.gif' }).allowed === true);
  advance(3600 * 1000 + 1000);
  check('过一小时后恢复', gate.decide({ groupId: 'g1', id: 'c.gif' }).allowed === true);
}

console.log('\n3. 同图去重');
{
  const { gate, advance } = makeGate({ chance: 1, maxPerHour: 0, dupTTLHours: 24 });
  check('首次发这张放行', gate.decide({ groupId: 'g1', id: 'same.gif' }).allowed === true);
  gate.record({ groupId: 'g1', id: 'same.gif' });
  check('TTL 内同图被拒', gate.decide({ groupId: 'g1', id: 'same.gif' }).allowed === false);
  check('force 可强行发同一张', gate.decide({ groupId: 'g1', id: 'same.gif', force: true }).allowed === true);
  check('换一张图放行', gate.decide({ groupId: 'g1', id: 'other.gif' }).allowed === true);
  advance(24 * 3600 * 1000 + 1000);
  check('过 TTL 后同图恢复', gate.decide({ groupId: 'g1', id: 'same.gif' }).allowed === true);
}

console.log('\n4. 记录与清理');
{
  const { gate } = makeGate({ chance: 1, maxPerHour: 0, dupTTLHours: 0 });
  gate.record({ groupId: 'g1', id: 'a.gif' });
  gate.record({ groupId: 'g1', id: 'b.gif' });
  check('record 后可读快照', gate.snapshot('g1').length === 2, JSON.stringify(gate.snapshot('g1')));
  gate.reset();
  check('reset 清空', gate.snapshot('g1').length === 0);
  check('空 groupId 不记', (() => { gate.record({ groupId: '', id: 'x' }); return gate.snapshot('').length === 0; })());
  check('没有 groupId 时直接拒绝', gate.decide({ id: 'a.gif' }).allowed === false);
}

console.log('\n5. 整表清扫：沉默群的尾巴不会一直留着');
{
  // dupTTL=1h：keepMs = max(1h, 1h) = 1h
  const { gate, advance } = makeGate({ chance: 1, maxPerHour: 0, dupTTLHours: 1 });
  gate.record({ groupId: 'old', id: 'a.gif' });
  check('记录后能在快照里看到', gate.snapshot('old').length === 1);
  advance(60 * 60 * 1000 + 5 * 60 * 1000); // 过窗 + 超过清扫节流
  gate.record({ groupId: 'fresh', id: 'b.gif' }); // 这次 record 触发全表清扫
  check('过窗的群被整键清掉', gate.snapshot('old').length === 0, JSON.stringify(gate.snapshot('old')));
  check('刚记录的群还在', gate.snapshot('fresh').length === 1);
  check('仍在窗口内的群不受清扫影响', (() => {
    const t = makeGate({ chance: 1, maxPerHour: 0, dupTTLHours: 24 });
    t.gate.record({ groupId: 'a', id: 'x.gif' });
    t.advance(10 * 60 * 1000); // 10 分钟，远没到窗口
    t.gate.record({ groupId: 'b', id: 'y.gif' });
    return t.gate.snapshot('a').length === 1 && t.gate.snapshot('b').length === 1;
  })());
}

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
