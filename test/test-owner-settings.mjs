// 拥有者设置通道（qqconfig）：身份闸门 / 白名单 / 值校验 / 两步确认 / 限流 / 命名空间识别。
import {
  SPECS, specFor, isDenied, validateValue, nestedPatch, matchNamespace, checkCaller,
  createOwnerSettings, TOKEN_TTL_MS,
} from '../lib/valve/security/owner-settings.js';

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail === undefined ? '' : ' -> ' + detail)); }
}

// ---------- 白名单 ----------
check('白名单包含 group.allow', specFor('group.allow') !== null && specFor('group.allow').kind === 'ids');
check('未知路径不在白名单', specFor('some.random') === null);
check('auth.owners 被拒', isDenied('auth.owners') === true);
check('onebot.accessToken 被拒', isDenied('onebot.accessToken') === true);
check('imageGen.apiKey 被拒', isDenied('imageGen.apiKey') === true);
check('proactive.apiKey 被拒', isDenied('proactive.apiKey') === true);
check('proactive.model 被拒（模型名不许改）', isDenied('proactive.model') === true);
check('proactive.enabled 允许', isDenied('proactive.enabled') === false);
check('表情包开关允许（主人能在 QQ 里关掉图库）',
  isDenied('sticker.enabled') === false && isDenied('sticker.autoTag') === false);
check('表情包目录 / 打标模型被拒（只给设置页）',
  isDenied('sticker.dir') === true && isDenied('sticker.provider') === true && isDenied('sticker.model') === true);
check('空路径被拒', isDenied('') === true);

// ---------- 值校验 ----------
check('布尔 true', validateValue(specFor('group.enabled'), true).ok === true);
check('布尔字符串 "false"', validateValue(specFor('group.enabled'), 'false').value === false);
check('布尔非法值', validateValue(specFor('group.enabled'), 'yes').ok === false);
check('整数 90', validateValue(specFor('proactive.intervalMinutes'), 90).value === 90);
check('整数字符串 "90"', validateValue(specFor('proactive.intervalMinutes'), '90').value === 90);
check('整数越界', validateValue(specFor('proactive.intervalMinutes'), 1).ok === false);
check('整数小数被拒', validateValue(specFor('proactive.intervalMinutes'), 1.5).ok === false);
check('QQ 号数组', JSON.stringify(validateValue(specFor('group.allow'), ['488136808', 526778762]).value) === JSON.stringify(['488136808', '526778762']));
check('QQ 号逗号串', JSON.stringify(validateValue(specFor('group.allow'), '488136808, 526778762').value) === JSON.stringify(['488136808', '526778762']));
check('QQ 号去重', validateValue(specFor('group.allow'), ['488136808', '488136808']).value.length === 1);
check('QQ 号非法', validateValue(specFor('group.allow'), ['abc']).ok === false);
check('QQ 号空数组可用', validateValue(specFor('group.allow'), []).value.length === 0);
check('免打扰时段', validateValue(specFor('proactive.quietHours'), ['23:00-08:00']).ok === true);
check('免打扰时段非法', validateValue(specFor('proactive.quietHours'), ['25:00-08:00']).ok === false);
check('文本超长被拒', validateValue(specFor('persona.name'), 'x'.repeat(30)).ok === false);
check('文本允许空串', validateValue(specFor('commandPrefix'), '').value === '');

// ---------- 补丁形状 ----------
check('nestedPatch 两层', JSON.stringify(nestedPatch('group.allow', ['1'])) === JSON.stringify({ group: { allow: ['1'] } }));
check('nestedPatch 一层', JSON.stringify(nestedPatch('commandPrefix', '/ai')) === JSON.stringify({ commandPrefix: '/ai' }));

// ---------- 命名空间识别 ----------
check('认出 qq-bot 命名空间', matchNamespace([{ ns: 'other' }, { ns: 'dsh-qq-bot', revision: 3 }]).ok === true
  && matchNamespace([{ ns: 'other' }, { ns: 'dsh-qq-bot', revision: 3 }]).descriptor.ns === 'dsh-qq-bot');
check('命名空间不唯一则拒绝', matchNamespace([{ ns: 'dsh-qq-bot' }, { ns: 'my-qq-bot' }]).ok === false);
check('找不到命名空间', matchNamespace([{ ns: 'other' }]).ok === false);
check('describe 非数组', matchNamespace(null).ok === false);

// ---------- 调用方闸门 ----------
const cfg = { auth: { owners: ['319543886'], ownerSettings: true } };
// 私聊判定读回合快照（turnSpeaker.groupId），所以夹具照真实结构写。
const privateEntry = { key: 'private-319543886', groupId: null, turnSpeaker: { userId: '319543886', groupId: null } };
const groupEntry = { key: 'group-488136808', groupId: '488136808', turnSpeaker: { userId: '319543886', groupId: '488136808' } };
const guestEntry = { key: 'group-488136808', groupId: '488136808', turnSpeaker: { userId: '10000', groupId: '488136808' } };
check('拥有者私聊放行', checkCaller(cfg, privateEntry).ok === true);
check('拥有者在群里也拒绝', checkCaller(cfg, groupEntry).code === 'not-private');
check('非拥有者拒绝', checkCaller(cfg, guestEntry).code === 'not-owner');
check('总开关关闭则拒绝', checkCaller({ auth: { owners: ['319543886'], ownerSettings: false } }, privateEntry).code === 'disabled');
check('没有会话上下文拒绝', checkCaller(cfg, null).code === 'no-conversation');
check('没有发言人拒绝', checkCaller(cfg, { key: 'private-1', groupId: null, speaker: null }).code === 'no-speaker');

// ---------- 端到端（假 settings 服务） ----------
function fakeSettings(initial) {
  const state = { value: JSON.parse(JSON.stringify(initial)), revision: 1, writes: [] };
  return {
    state,
    describe: () => [{ ns: 'dsh-qq-bot', revision: state.revision, value: state.value }],
    update: async (ns, patch, revision) => {
      if (revision !== state.revision) throw new Error('revision conflict');
      const merge = (base, extra) => {
        for (const key of Object.keys(extra)) {
          if (extra[key] !== null && typeof extra[key] === 'object' && !Array.isArray(extra[key])) {
            base[key] = merge(base[key] || {}, extra[key]);
          } else base[key] = extra[key];
        }
        return base;
      };
      state.value = merge(state.value, patch);
      state.revision += 1;
      state.writes.push({ ns, patch, revision });
    },
  };
}

const auditLines = [];
let clock = 1000;
const settings = fakeSettings({ group: { allow: ['1'] }, proactive: { enabled: false } });
const os = createOwnerSettings({
  getSettings: () => settings,
  getConfig: () => cfg,
  audit: (line) => { auditLines.push(line); },
  now: () => clock,
  random: () => 0.5,
});

const shown = await os.show('319543886');
check('show 列出白名单项', shown.ok === true && shown.settings.length === SPECS.length);
check('show 带 revision', shown.revision === 1);
const shownAllow = shown.settings.find((row) => row.path === 'group.allow');
check('show 取到当前值', JSON.stringify(shownAllow.value) === JSON.stringify(['1']));

const denied = await os.propose('319543886', 'auth.owners', ['666666']);
check('propose 拒绝敏感项', denied.ok === false && denied.code === 'denied');
const badValue = await os.propose('319543886', 'group.allow', ['not-a-qq']);
check('propose 拒绝非法值', badValue.ok === false && badValue.code === 'invalid');

const proposed = await os.propose('319543886', 'group.allow', ['488136808', '526778762']);
check('propose 成功并给 token', proposed.ok === true && typeof proposed.token === 'string' && proposed.token.length === 10);
check('propose 预览旧值新值', JSON.stringify(proposed.current) === JSON.stringify(['1'])
  && JSON.stringify(proposed.next) === JSON.stringify(['488136808', '526778762']));
check('propose 不落盘', settings.state.writes.length === 0);

const otherOwner = await os.apply('999999', proposed.token);
check('他人 token 被拒', otherOwner.ok === false && otherOwner.code === 'not-owner');

const applied = await os.apply('319543886', proposed.token);
check('apply 成功', applied.ok === true && applied.path === 'group.allow');
check('apply 写到 settings 服务', settings.state.writes.length === 1
  && JSON.stringify(settings.state.writes[0].patch) === JSON.stringify({ group: { allow: ['488136808', '526778762'] } }));
check('apply 后值已变', JSON.stringify(settings.state.value.group.allow) === JSON.stringify(['488136808', '526778762']));
check('apply 写审计', auditLines.length === 1 && auditLines[0].result === 'ok' && auditLines[0].owner === '319543886');

const replay = await os.apply('319543886', proposed.token);
check('token 一次性', replay.ok === false && replay.code === 'no-pending');

const proposed2 = await os.propose('319543886', 'proactive.enabled', true);
clock += TOKEN_TTL_MS + 1;
const expired = await os.apply('319543886', proposed2.token);
check('token 过期作废', expired.ok === false && expired.code === 'no-pending');

const proposed3 = await os.propose('319543886', 'proactive.enabled', true);
settings.state.revision += 1;   // 模拟同时被设置页改过
const stale = await os.apply('319543886', proposed3.token);
check('revision 变了则作废', stale.ok === false && stale.code === 'stale');

const cancelTarget = await os.propose('319543886', 'proactive.enabled', true);
check('cancel 可用', (await os.cancel('319543886', cancelTarget.token)).ok === true);
check('cancel 后 token 失效', (await os.apply('319543886', cancelTarget.token)).ok === false);

// 限流：cfg 里每小时 6 次（默认），已用 1 次，再连续 6 次应被拦
let limited = null;
for (let index = 0; index < 7; index += 1) {
  const item = await os.propose('319543886', 'proactive.enabled', index % 2 === 0);
  const result = await os.apply('319543886', item.token);
  if (result.ok !== true) { limited = result; break; }
}
check('超过每小时上限被拦', limited !== null && limited.code === 'rate-limited');
check('被拦也写审计', auditLines.some((line) => line.result === 'rate-limited'));

// 设置服务不可用：拒绝而不是手改文件
const noService = createOwnerSettings({ getSettings: () => undefined, getConfig: () => cfg, audit: () => {}, now: () => clock });
const noServiceResult = await noService.show('319543886');
check('设置服务缺失则拒绝', noServiceResult.ok === false && String(noServiceResult.error).includes('设置服务不可用'));

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
