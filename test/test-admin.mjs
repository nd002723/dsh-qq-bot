#!/usr/bin/env node
/**
 * 权限与群管理专项测试（三路并行 + 动态授权 + 严格指令匹配）。
 *
 *   node test-admin.mjs
 *
 * 身份设定（写进假 OneBot 的成员表）：
 *   66666 = 拥有者（静态名单）
 *   22222 = 后台设定的高级管理员，但群内只是普通成员
 *   44444 = 本群管理员
 *   33333 = 普通成员（后面被动态授权）
 *   55555 = 无任何身份
 */

import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import process from 'node:process';
import { startMockOneBot } from './mock-onebot.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.join(here, '..');

let failures = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  if (!ok) failures += 1;
  console.log('  [' + (ok ? 'PASS' : 'FAIL') + '] ' + name + (ok || detail === '' ? '' : ' — ' + detail));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('等待超时：' + label);
    await sleep(60);
  }
}

// 装到 DSH profile 之后，@deepseek-ai/* 由 DSH 运行时解析。这里允许用
// DSH_PROFILE_MODULES 显式指向 profile 的 node_modules 来复现那种布局；
// 找不到就跳过依赖宿主服务的断言，裸克隆照样能跑。
const PROFILE_MODULES = process.env.DSH_PROFILE_MODULES
  ?? path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'profiles', 'node_modules');
const linkPath = path.join(PKG_ROOT, 'node_modules');
let createdLink = false;
if (!fs.existsSync(linkPath) && fs.existsSync(PROFILE_MODULES)) {
  fs.symlinkSync(PROFILE_MODULES, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  createdLink = true;
}
// 插件现在静态 import @deepseek-ai/schemastery（Config schema 必需）。
try { await import.meta.resolve('@deepseek-ai/schemastery'); }
catch {
  console.log('缺少 @deepseek-ai/schemastery —— 请先在本目录执行 npm install / pnpm install。');
  process.exit(2);
}

const mock = await startMockOneBot({ quiet: true });
mock.setMemberRole('66666', 'owner');
mock.setMemberRole('22222', 'member');
mock.setMemberRole('33333', 'member');
mock.setMemberRole('44444', 'admin');
mock.setMemberRole('55555', 'member');
console.log('假 OneBot：http=' + mock.httpUrl + ' ws=' + mock.wsUrl);

const disposers = [];
const registeredTools = [];
const agents = new Map();

function fakeAgent(sessionId) {
  const messages = [];
  let pending = [];
  let busy = false;
  const agent = {
    id: sessionId, guards: [],
    ctx: { tools: { guard(fn) { agent.guards.push(fn); return () => { const i = agent.guards.indexOf(fn); if (i >= 0) agent.guards.splice(i, 1); }; } } },
    status: 'idle',
    session: {
      get seq() { return messages.length; },
      deriveMessages: () => messages.slice(),
      snapshotEvents: () => [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }],
    },
    followup(message) {
      busy = true; agent.status = 'running';
      messages.push({ id: message.id, role: 'user', content: message.content });
      setTimeout(() => {
        messages.push({ id: 'a' + messages.length, role: 'assistant', content: [{ type: 'text', text: 'REPLY' }] });
        busy = false; agent.status = 'idle';
        const waiters = pending; pending = [];
        for (const w of waiters) w();
      }, 20);
    },
    async whenIdle() { if (!busy) return; await new Promise((r) => pending.push(r)); },
    cancel() { busy = false; },
  };
  return agent;
}

const ctx = {
  fiber: { marker: 'plugin-fiber' },
  // DSH ≥ 0.1.7：插件用 inject(['settings']) + settings.configure() 声明设置页归属
  inject(names, callback) {
    if (Array.isArray(names) && names.includes('settings')) {
      callback({
        effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return () => {}; },
        settings: { configure() { return () => {}; } },
      });
    }
    return () => {};
  },
  // 配置热更新通道（本套测试不验证重启行为，只需接口存在）
  on() { return () => {}; },
  get: () => undefined,
  subprocess: {
    async resolveExecutable() { return process.execPath; },
    spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      const done = new Promise((resolve) => child.on('close', (exitCode, signal) => resolve({ exitCode, signal })));
      return {
        stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, done,
        terminate() { try { child.kill('SIGTERM'); } catch { /* ignore */ } },
        waitForExit: () => done.then(() => true),
      };
    },
  },
  sessionController: {
    async create(request) { return { sessionId: request.sessionId }; },
    async resolveAgent(sessionId) {
      if (!agents.has(sessionId)) agents.set(sessionId, fakeAgent(sessionId));
      return { agent: agents.get(sessionId) };
    },
  },
  timeout(cb, delay) { const t = setTimeout(cb, delay); return () => clearTimeout(t); },
  effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return () => {}; },
  tools: { register(tool) { registeredTools.push(tool); return () => {}; } },
};

/** 发一条群消息（可选带 reply 段），返回新出现的回复文本 */
async function say(groupId, userId, text, options = {}) {
  const before = mock.sent.length;
  const message = options.replyTo === undefined
    ? undefined
    : [{ type: 'reply', data: { id: String(options.replyTo) } }, { type: 'text', data: { text } }];
  await fetch(mock.httpUrl + '/__inject', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message_type: 'group', group_id: groupId, user_id: userId, nickname: 'U' + userId, text, message }),
  });
  return waitFor(() => (mock.sent.length > before ? mock.sent[mock.sent.length - 1].message[0].data.text : null),
    options.timeoutMs === undefined ? 20000 : options.timeoutMs, '回复 ' + JSON.stringify(text));
}
const actionsOf = (name) => mock.actions.filter((a) => a.action === name);
// 只统计会改变群状态的动作：get_group_member_info 是鉴权查询，不算
const MUTATING = ['set_group_ban', 'set_group_kick', 'set_group_whole_ban', 'set_group_card', 'set_group_admin', 'set_group_name', 'delete_msg', 'send_group_poke', 'set_group_leave'];
const mutations = () => mock.actions.filter((a) => MUTATING.indexOf(a.action) >= 0).length;
const denied = (r) => r.startsWith('【拒绝】');
const done = (r) => r.startsWith('【已执行】');

try {
  const mod = await import(pathToFileURL(path.join(PKG_ROOT, 'lib', 'index.js')).href);
  await mod.apply(ctx, {
    onebot: { wsUrl: mock.wsUrl, httpUrl: mock.httpUrl },
    group: { enabled: true, allow: [], requireAt: false },
    reply: { ackAfterMs: 0 },
    auth: { owners: ['66666'], superAdmins: ['22222'], ownerPreset: '', guestPreset: '', grantTtlMinutes: 60, grantMaxTtlMinutes: 1440 },
    admin: { enabled: true, manageGroups: [], requireGroupAdmin: true, prefix: '/', dryRun: false, allowConsole: false },
  });
  await waitFor(() => mock.clientCount() === 1, 10000, '适配器连接');

  console.log('\n1. 三路并行：静态名单 / 本群身份');
  let r = await say(33333, 55555, '/mute @33333 10');
  check('无任何身份 -> 拒绝且说明缺权限', denied(r) && r.includes('缺少权限'), r.replace(/\n/g, ' | '));
  check('拒绝时没有动作', actionsOf('set_group_ban').length === 0);

  r = await say(33333, 44444, '/mute @33333 10');
  check('本群管理员 -> 通过', done(r), r);
  check('参数正确', actionsOf('set_group_ban').length === 1
    && actionsOf('set_group_ban')[0].params.duration === 600, JSON.stringify(actionsOf('set_group_ban')[0] && actionsOf('set_group_ban')[0].params));

  r = await say(33333, 22222, '/mute @55555 5');
  check('后台高级管理员（群内只是普通成员）-> 通过（并行生效）', done(r), r);
  check('第二次 set_group_ban 参数正确', actionsOf('set_group_ban').length === 2
    && actionsOf('set_group_ban')[1].params.user_id === 55555 && actionsOf('set_group_ban')[1].params.duration === 300);

  console.log('\n2. 动态授权（群维度 + 临时）');
  r = await say(33333, 44444, '/grant @33333 mute 30');
  check('本群管理员可对群内成员临时授权', r.startsWith('【已授权】') && r.includes('仅在本群有效'), r);
  r = await say(33333, 33333, '/mute @55555 3');
  check('被授权者可以执行 mute', done(r), r);
  r = await say(33333, 33333, '/kick @55555');
  check('未被授予的权限仍然拒绝', denied(r) && r.includes('缺少权限'), r.replace(/\n/g, ' | '));
  check('没有产生 set_group_kick', actionsOf('set_group_kick').length === 0);

  r = await say(44444, 33333, '/mute @55555 3');
  check('动态授权不可跨群（换群后失效）', denied(r), r.replace(/\n/g, ' | '));

  r = await say(33333, 44444, '/grant @33333 kick forever');
  check('非拥有者不能永久授权', denied(r) || r.includes('只有拥有者'), r.replace(/\n/g, ' | '));

  r = await say(33333, 66666, '/grant @33333 kick forever');
  check('拥有者可永久授权', r.startsWith('【已授权】') && r.includes('永久'), r);
  r = await say(33333, 33333, '/kick @55555');
  check('永久授权后可以踢人', done(r), r);
  check('set_group_kick 参数正确', actionsOf('set_group_kick').length === 1
    && actionsOf('set_group_kick')[0].params.user_id === 55555, JSON.stringify(actionsOf('set_group_kick')[0] && actionsOf('set_group_kick')[0].params));

  console.log('\n3. 权限来源可见');
  r = await say(33333, 33333, '/whoami');
  check('/whoami 列出身份与来源', r.includes('身份：已授权') || r.includes('动态授权'), r.replace(/\n/g, ' | '));
  r = await say(33333, 66666, '/perms @33333');
  check('/perms 显示动态授权这一路来源', r.includes('动态授权') && r.includes('禁言'), r.replace(/\n/g, ' | '));
  r = await say(33333, 66666, '/perms @44444');
  check('/perms 显示本群管理员这一路来源', r.includes('本群管理员'), r.replace(/\n/g, ' | '));
  r = await say(33333, 66666, '/perms @22222');
  check('/perms 显示后台高级管理员这一路来源', r.includes('后台高级管理员'), r.replace(/\n/g, ' | '));
  r = await say(33333, 66666, '/grants');
  check('/grants 列出本群授权', r.includes('33333') && r.includes('mute'), r.replace(/\n/g, ' | '));

  console.log('\n4. 严格指令匹配（防夹带）');
  const beforeExtra = mutations();
  r = await say(33333, 44444, '/mute @55555 10 这是多余内容');
  check('多余 token -> 用法错误、不执行', r.startsWith('用法：') && mutations() === beforeExtra, r.replace(/\n/g, ' | '));
  r = await say(33333, 44444, '你好 /mute @55555 10');
  check('斜杠不在首位 -> 不当作指令（交给模型）', r === 'REPLY', r);
  const beforeUnknown = mutations();
  r = await say(33333, 44444, '/notacommand 你好');
  check('未知指令 -> 交给模型', r === 'REPLY' && mutations() === beforeUnknown, r);

  console.log('\n5. /recall 靠 reply 透传');
  const beforeRecall = actionsOf('delete_msg').length;
  r = await say(33333, 44444, '/recall', { replyTo: 98765 });
  check('回复某条消息即可撤回（无需手写 id）', done(r) && r.includes('98765'), r);
  const recalls = actionsOf('delete_msg');
  check('delete_msg 用了被引用消息的 id', recalls.length === beforeRecall + 1
    && recalls[recalls.length - 1].params.message_id === 98765, JSON.stringify(recalls[recalls.length - 1].params));

  console.log('\n6. Agent 工具走同一套鉴权');
  const groupTool = registeredTools.find((t) => t.name === 'qqgroup');
  if (groupTool === undefined) {
    check('（跳过）工具路径需要 @deepseek-ai/dsh-tools', true);
  } else {
    check('注册了 qqgroup 工具', true);
  }
  if (groupTool !== undefined) {
    await say(33333, 55555, '你好');                      // 让无身份用户成为 33333 群的说话人
    const unauth = await groupTool.execute({ action: 'mute', user_id: '77777', duration: 60 }, { agent: agents.get('qqbot-group-33333') });
    check('无身份说话人 -> 工具拒绝', unauth.ok === false && String(unauth.error).includes('缺少权限'), JSON.stringify(unauth).slice(0, 120));

    await say(33333, 66666, '你好');                      // 拥有者成为说话人
    const beforeTool = mock.actions.length;   // 这里要的是数组索引，不是计数
    const okRes = await groupTool.execute({ action: 'mute', user_id: '77777', duration: 120 }, { agent: agents.get('qqbot-group-33333') });
    check('拥有者说话 -> 工具通过', okRes.ok === true, JSON.stringify(okRes).slice(0, 120));
    const newBan = mock.actions.slice(beforeTool).find((a) => a.action === 'set_group_ban');
    check('工具默认用当前群且参数正确', newBan !== undefined && newBan.params.group_id === 33333
      && newBan.params.user_id === 77777 && newBan.params.duration === 120, JSON.stringify(newBan && newBan.params));

    const badAction = await groupTool.execute({ action: 'nope' }, { agent: agents.get('qqbot-group-33333') });
    check('未知 action -> 报错并列出可用值', badAction.ok === false && Array.isArray(badAction.available), JSON.stringify(badAction).slice(0, 80));
  }

  console.log('\n7. 访客工具闸（tools.guard，执行级硬闸）');
  const gateAgent = agents.get('qqbot-group-33333');
  check('闸已注册到该会话的 agent（只注册一次）',
    Boolean(gateAgent) && Array.isArray(gateAgent.guards) && gateAgent.guards.length === 1,
    String(gateAgent && gateAgent.guards && gateAgent.guards.length));
  const gate = gateAgent.guards[0];

  await say(33333, 66666, '你好');            // 拥有者发言 -> dshAllowed=true
  check('拥有者回合：DSH 工具放行', gate({ name: 'bash' }) === undefined);
  await say(33333, 55555, '你好');            // 访客发言 -> dshAllowed=false
  const blocked = gate({ name: 'bash' });
  check('访客回合：DSH 工具被拦（返回拒绝原因）', typeof blocked === 'string' && blocked.includes('访客模式'), String(blocked));
  check('访客回合：qqgroup 仍放行（自带鉴权）', gate({ name: 'qqgroup' }) === undefined);
  check('访客回合：run_code（PTC 保留传输）也被拦', typeof gate({ name: 'run_code' }) === 'string', String(gate({ name: 'run_code' })));
  check('访客回合：write/edit 等一律被拦', typeof gate({ name: 'write' }) === 'string' && typeof gate({ name: 'edit' }) === 'string');
} catch (error) {
  failures += 1;
  console.log('\n错误：' + (error && error.stack ? error.stack : String(error)));
} finally {
  for (const d of disposers) { try { d(); } catch { /* ignore */ } }
  await sleep(300);
  await mock.close();
  if (createdLink) {
    // 只删链接本身：对 junction 用 rmSync(recursive) 会把目标目录删空。
    try { if (process.platform === 'win32') fs.rmdirSync(linkPath); else fs.unlinkSync(linkPath); } catch { /* ignore */ }
  }
}

const passed = results.filter(Boolean).length;
console.log('\n' + passed + '/' + results.length + ' 项通过');
if (failures > 0) { console.log('权限自测失败'); process.exit(1); }
console.log('权限自测通过');
process.exit(0);
