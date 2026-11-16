/**
 * 会话归档召回自测：被 DSH「归档」的 QQ 会话，在消息触发时必须先解除归档。
 *
 * 为什么这条非测不可：宿主的 ArchivedSessionGate 挂在 agent/pre-step 上，对归档会话
 * 直接 reject —— 回合以 blocked 结束、一个模型请求都不发；而 SessionController.create
 * 的 reusable 判定也把归档会话排除。不召回 = QQ 侧消息石沉大海且没有任何报错。
 *
 * 所以断言盯的是三件事：
 *   ① unarchiveSession 真的被调用（且只在确实归档时）；
 *   ② 调用发生在 sessionController.create **之前**（晚了 reusable 就会另建会话）；
 *   ③ 召回失败/宿主没有该接口时，收发主链一点不受影响。
 *
 * 用法：node test/test-session-archive.mjs
 */
import { createSessionArchive } from '../lib/session/session-archive.js';
import { createSession, revivedSessionId } from '../lib/session/manager.js';

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('  [PASS] ' + name); }
  else { fail += 1; console.log('  [FAIL] ' + name + (detail === undefined ? '' : '：' + detail)); }
}

/** 静音包裹：createSession 的建会话日志太多，只让 check 的结果露出来。 */
async function quiet(fn) {
  const savedLog = console.log;
  const savedError = console.error;
  console.log = () => {};
  console.error = () => {};
  try { return await fn(); }
  finally { console.log = savedLog; console.error = savedError; }
}

/**
 * 假 registry。`workspaces` 是工作区账本（`list()` 的形状：每项带 sessionIds getter），
 * 用来区分「归档」与「真正删除」——真宿主里后者会同时把账本槽位摘掉。
 */
function fakeRegistry(archived, workspaces) {
  const state = {
    archived: archived.slice(),
    unarchiveCalls: [],
    workspaces: (workspaces === undefined ? [] : workspaces).map((w) => ({ id: String(w.id), sessionIds: w.sessionIds.slice() })),
  };
  const registry = {
    get archivedSessionIds() { return state.archived.slice(); },
    list() {
      return state.workspaces.map((w) => ({
        id: w.id,
        get sessionIds() { return w.sessionIds.slice(); },
      }));
    },
    async unarchiveSession(sessionId) {
      state.unarchiveCalls.push(String(sessionId));
      state.archived = state.archived.filter((id) => id !== String(sessionId));
    },
  };
  return { registry, state };
}

function ctxOf(registry) {
  return { reflect: { get: (name) => (name === 'workspaceRegistry' ? registry : undefined) } };
}

// ───────────────────────────── 召回器单元 ─────────────────────────────

{
  const { registry, state } = fakeRegistry(['qqbot-group-1']);
  const api = createSessionArchive({ ctx: ctxOf(registry) });
  const recalled = await api.recall('qqbot-group-1', '测试');
  check('已归档的会话被召回', recalled === true);
  check('调用一次 unarchiveSession', state.unarchiveCalls.length === 1 && state.unarchiveCalls[0] === 'qqbot-group-1');
  check('召回后不在归档集合里', !state.archived.includes('qqbot-group-1'));
  check('stats.recalled 计数', api.stats.recalled === 1 && api.stats.lastRecalledId === 'qqbot-group-1');
}

{
  const { registry, state } = fakeRegistry([]);
  const api = createSessionArchive({ ctx: ctxOf(registry) });
  const recalled = await api.recall('qqbot-group-2');
  check('未归档时不召回', recalled === false);
  check('未归档时不调用 unarchiveSession（不白写盘）', state.unarchiveCalls.length === 0);
}

{
  // 第二次调用时已经不在归档集合里了：宿主本身就是幂等的，这里要求不给它添乱。
  const { registry, state } = fakeRegistry(['qqbot-x']);
  const api = createSessionArchive({ ctx: ctxOf(registry) });
  await api.recall('qqbot-x');
  const again = await api.recall('qqbot-x');
  check('重复召回第二次直接跳过', again === false && state.unarchiveCalls.length === 1);
}

{
  const api = createSessionArchive({ ctx: {} });
  const recalled = await api.recall('qqbot-y');
  check('没有 workspaceRegistry（headless）不抛', recalled === false);
  check('headless 记为 unavailable 而非失败', api.stats.unavailable === 1 && api.stats.failed === 0);
}

{
  // 回落 ctx.get：reflect 取不到时仍要能找到服务。
  const { registry, state } = fakeRegistry(['qqbot-z']);
  const ctx = { reflect: { get: () => undefined }, get: (name) => (name === 'workspaceRegistry' ? registry : undefined) };
  const api = createSessionArchive({ ctx });
  const recalled = await api.recall('qqbot-z');
  check('reflect 取不到时回落 ctx.get', recalled === true && state.unarchiveCalls.length === 1);
}

{
  // 宿主 registry 还没启动：archivedSessionIds 的 getter 抛 "workspace registry is not started yet"。
  const registry = {
    get archivedSessionIds() { throw new Error('workspace registry is not started yet'); },
    async unarchiveSession() { throw new Error('不该走到这里'); },
  };
  const api = createSessionArchive({ ctx: ctxOf(registry) });
  let threw = false;
  let recalled;
  try { recalled = await api.recall('qqbot-early'); } catch { threw = true; }
  check('registry 未启动时不抛', threw === false && recalled === false);
  check('registry 未启动记为 unavailable', api.stats.unavailable === 1 && api.stats.failed === 0);
}

{
  const registry = {
    get archivedSessionIds() { return ['qqbot-bad']; },
    async unarchiveSession() { throw new Error('磁盘写失败'); },
  };
  const api = createSessionArchive({ ctx: ctxOf(registry) });
  let threw = false;
  let recalled;
  try { recalled = await api.recall('qqbot-bad'); } catch { threw = true; }
  check('unarchiveSession 抛错时不向外抛', threw === false && recalled === false);
  check('失败计数与错误文本', api.stats.failed === 1 && api.stats.lastError === '磁盘写失败');
}

{
  const { registry } = fakeRegistry(['qqbot-p']);
  const api = createSessionArchive({ ctx: ctxOf(registry) });
  check('isArchived 命中', api.isArchived('qqbot-p') === true);
  check('isArchived 未命中', api.isArchived('qqbot-q') === false);
  const none = createSessionArchive({ ctx: undefined });
  check('没有 registry 时 isArchived 恒 false', none.isArchived('qqbot-p') === false);
}

// ──────────────── isDetached：会话是否已不在任何工作区账本 ────────────────

{
  // 账本里还在 → 没被删（手动归档也是这种形态：归档不动账本槽位）。
  const { registry } = fakeRegistry(['qqbot-a'], [{ id: 'ws-1', sessionIds: ['qqbot-a', 'qqbot-b'] }]);
  const api = createSessionArchive({ ctx: ctxOf(registry) });
  check('在账本里 → isDetached=false', api.isDetached('qqbot-a') === false);
  check('不在账本里 → isDetached=true（要不要重建由调用方结合条目判断）', api.isDetached('qqbot-c') === true);
}

{
  // dsh-session-manager 删除后的形态：账本槽位摘掉（归档集合里也不再留 id）。
  const { registry } = fakeRegistry([], [{ id: 'ws-1', sessionIds: ['qqbot-other'] }]);
  const api = createSessionArchive({ ctx: ctxOf(registry) });
  check('删除后（账本已摘、归档也无）→ isDetached=true', api.isDetached('qqbot-del') === true);
}

{
  // 权威 record 优先：getter 因索引 stale 隐藏了真实成员，也不能误判成删除。
  const registry = {
    get archivedSessionIds() { return []; },
    list() { return [{ id: 'ws-1', record: { sessionIds: ['qqbot-stale'] }, get sessionIds() { return []; } }]; },
  };
  const api = createSessionArchive({ ctx: ctxOf(registry) });
  check('record 里有 → 不误判（getter 只是过滤视图）', api.isDetached('qqbot-stale') === false);
}

{
  // 老宿主没有 list()：读不到账本就绝不判删除。
  const registry = { get archivedSessionIds() { return ['qqbot-x']; } };
  const api = createSessionArchive({ ctx: ctxOf(registry) });
  check('读不到工作区列表时不判删除', api.isDetached('qqbot-x') === false);
}

{
  const registry = {
    get archivedSessionIds() { throw new Error('workspace registry is not started yet'); },
    list() { throw new Error('workspace registry is not started yet'); },
  };
  const api = createSessionArchive({ ctx: ctxOf(registry) });
  let threw = false;
  let detached;
  try { detached = api.isDetached('qqbot-y'); } catch { threw = true; }
  check('registry 未启动时 isDetached 不抛', threw === false && detached === false);
}

{
  const a = revivedSessionId('qqbot-group-1');
  const b = revivedSessionId('qqbot-group-1');
  const c = revivedSessionId('qqbot-group-2');
  check('revivedSessionId 确定性（同会话同 id）', a === b);
  check('不同会话派生不同 id', a !== c);
  check('派生 id 与原 id 不同', a !== 'qqbot-group-1');
  check('派生 id 保持原前缀', a.indexOf('qqbot-group-1') === 0, a);
}

{
  // 老宿主：没有 unarchiveSession 方法。要求静默跳过、不抛（向后兼容）。
  const registry = { get archivedSessionIds() { return ['qqbot-old']; } };
  const api = createSessionArchive({ ctx: ctxOf(registry) });
  let threw = false;
  let recalled;
  try { recalled = await api.recall('qqbot-old'); } catch { threw = true; }
  check('宿主无 unarchiveSession 时不抛', threw === false && recalled === false);
}

// ───────────────────────── 与 getEntry 的接线 ─────────────────────────

/**
 * 拼一个能跑 getEntry 的最小世界：假 sessionController + 假 tools 服务 + 可控归档集合。
 * createSawArchived 记录「create 被调用那一刻该会话是否还在归档里」——这是本文件的核心断言。
 */
function makeWorld(opts) {
  const o = opts || {};
  const archived = Array.isArray(o.archived) ? o.archived.slice() : [];
  // 工作区账本里的 sessionIds。缺省=空账本（配合 archived 就能构造「已删除」场景）。
  const ledger = Array.isArray(o.ledger) ? o.ledger.slice() : [];
  const unarchiveCalls = [];
  const createCalls = [];
  const world = { createSawArchived: null };
  // 会话条目表：测试要能读到 entry.scopeKey / sessionId 这些「创建侧记下了什么」。
  const convos = new Map();
  const registry = {
    get archivedSessionIds() { return archived.slice(); },
    list() {
      return [{ id: 'ws-1', get sessionIds() { return ledger.slice(); } }];
    },
    async unarchiveSession(sessionId) {
      unarchiveCalls.push(String(sessionId));
      const idx = archived.indexOf(String(sessionId));
      if (idx >= 0) archived.splice(idx, 1);
    },
  };
  const archiveApi = createSessionArchive({ ctx: ctxOf(registry) });
  // 假的 tools 服务：够 createSession 装访客闸与编排工具接管用。
  const toolsService = {
    guard() { return () => {}; },
    get() { return undefined; },
    register() {},
    restrict() {},
  };
  const ctx = {
    reflect: { get: (name) => (name === 'workspaceRegistry' ? registry : undefined) },
    get: () => undefined,
    effect() {},
    timeout() { return 0; },
    sessionController: {
      async create(request) {
        createCalls.push(request);
        world.createSawArchived = archived.includes(String(request.sessionId));
        // 真实 DSH 建完会话会把它登记进所属工作区账本；不模拟这步，isDetached 会对刚建的会话恒 true。
        if (ledger.map(String).includes(String(request.sessionId)) !== true) ledger.push(String(request.sessionId));
        // 模拟宿主拒绝跨工作区复用同一个 id（DSH 的真实行为）。
        if (typeof o.rejectFirstCreateOf === "function" && o.rejectFirstCreateOf(String(request.sessionId)) === true) {
          throw new Error("session belongs to another workspace");
        }
      },
      async resolveAgent(sessionId) {
        return { agent: { id: sessionId, session: {}, ctx: { get: () => toolsService } } };
      },
    },
  };
  const cfg = () => ({
    auth: { ownerPreset: '', guestPreset: '', guestToolAllow: [] },
    agentPreset: 'standard',
    session: { fixedName: true, recallArchived: o.recallArchived !== false },
    flowAuth: { enabled: o.flowEnabled === true },
    perChatSession: true,
  });
  const session = createSession({
    getConfig: cfg,
    ctx,
    state: { convos, stats: {} },
    ensureQqMsgWorkspace: async () => ({ id: 'ws-1', path: '/tmp/qqmsg' }),
    ensureSessionWorkspace: async () => ({ id: null, path: '/tmp/qqmsg/s1' }),
    sessionWorkdir: () => '/tmp/qqmsg/s1',
    callAdapterAction: async () => ({ ok: false }),
    describeError: (error) => String((error && error.message) || error),
    isOwner: () => true,
    flowGate: null,
    archiveApi,
  });
  return { session, archived, ledger, unarchiveCalls, createCalls, world, convos };
}

{
  const w = makeWorld({ archived: ['qqbot-group-9'], ledger: ['qqbot-group-9'] });
  await quiet(() => w.session.getEntry('group-9', 'qqbot-group-9', 'standard', null));
  check('归档会话在 create 之前已被召回', w.world.createSawArchived === false);
  check('召回恰好一次', w.unarchiveCalls.length === 1 && w.unarchiveCalls[0] === 'qqbot-group-9');
  check('会话照常建出来', w.createCalls.length === 1);
}

{
  const w = makeWorld({ archived: [], ledger: [] });
  await quiet(() => w.session.getEntry('group-10', 'qqbot-group-10', 'standard', null));
  check('未归档的会话不触发召回', w.unarchiveCalls.length === 0);
  check('未归档的会话照常建', w.createCalls.length === 1);
}

{
  // 已有条目（agent 还活着）也可能被归档：这一步是新消息能不能继续跑的关键。
  const w = makeWorld({ archived: [], ledger: ['qqbot-group-11'] });
  await quiet(() => w.session.getEntry('group-11', 'qqbot-group-11', 'standard', null));
  w.archived.push('qqbot-group-11');   // 模拟主人在 DSH 侧手动归档
  await quiet(() => w.session.getEntry('group-11', 'qqbot-group-11', 'standard', null));
  check('已有条目被归档后，下一条消息把它召回', w.unarchiveCalls.length === 1);
  check('已有条目不会重复建会话', w.createCalls.length === 1);
}

{
  // 开关关闭：一切都照旧（不召回），但不能崩。
  const w = makeWorld({ archived: ['qqbot-group-12'], ledger: ['qqbot-group-12'], recallArchived: false });
  await quiet(() => w.session.getEntry('group-12', 'qqbot-group-12', 'standard', null));
  check('开关关闭时不召回', w.unarchiveCalls.length === 0);
  check('开关关闭时仍能建会话', w.createCalls.length === 1);
}

{
  // 竞态回归：两条并发消息到达同一会话，只能建一次会话。
  // 召回必须放进 ready 链里——若放在 getEntry 开头 await，get/set 之间出现空档，
  // 两条消息会各自发现「没有条目」、各建一次。
  const w = makeWorld({ archived: ['qqbot-group-13'], ledger: ['qqbot-group-13'] });
  await quiet(() => Promise.all([
    w.session.getEntry('group-13', 'qqbot-group-13', 'standard', null),
    w.session.getEntry('group-13', 'qqbot-group-13', 'standard', null),
  ]));
  check('并发两条消息只建一次会话', w.createCalls.length === 1);
}

{
  // 老宿主（没有 unarchiveSession）也不能挡住消息。
  const archived = ['qqbot-group-14'];
  const ctx = { reflect: { get: () => ({ get archivedSessionIds() { return archived.slice(); } }) }, get: () => undefined, effect() {}, timeout() { return 0; } };
  let created = 0;
  ctx.sessionController = {
    async create() { created += 1; },
    async resolveAgent(id) { return { agent: { id, session: {}, ctx: { get: () => ({ guard: () => () => {}, get: () => undefined, register() {}, restrict() {} }) } } }; },
  };
  const archiveApi = createSessionArchive({ ctx });
  const session = createSession({
    getConfig: () => ({
      auth: { ownerPreset: '', guestPreset: '', guestToolAllow: [] },
      agentPreset: 'standard', session: { fixedName: true, recallArchived: true },
      flowAuth: { enabled: false }, perChatSession: true,
    }),
    ctx,
    state: { convos: new Map(), stats: {} },
    ensureQqMsgWorkspace: async () => ({ id: 'ws-1', path: '/tmp/qqmsg' }),
    ensureSessionWorkspace: async () => ({ id: null, path: '/tmp/qqmsg/s1' }),
    sessionWorkdir: () => '/tmp/qqmsg/s1',
    callAdapterAction: async () => ({ ok: false }),
    describeError: (error) => String((error && error.message) || error),
    isOwner: () => true,
    flowGate: null,
    archiveApi,
  });
  await quiet(() => session.getEntry('group-14', 'qqbot-group-14', 'standard', null));
  check('老宿主上召回静默跳过、会话照建', created === 1);
}

// ─────────────────── 会话被真正删除后的重建（两种删除器） ───────────────────

{
  // ① dsh-session-manager 的终态：detachFromWorkspaces（摘账本）+ unarchiveSession
  //    （归档集合也清掉）+ rm 目录。所以在归档集合里**找不到**它 —— 旧判据正是死在这里。
  const w = makeWorld({ archived: [], ledger: ['qqbot-mgr'] });
  await quiet(() => w.session.getEntry('mgr', 'qqbot-mgr', 'standard', null));   // 先正常建一次
  w.ledger.length = 0;                                                          // 模拟删除：账本摘掉
  await quiet(() => w.session.getEntry('mgr', 'qqbot-mgr', 'standard', null));   // 删除后再来一条
  const expected = revivedSessionId('qqbot-mgr');
  check('session-manager 删除后 → 用派生 id 重建', w.createCalls.length === 2 && w.createCalls[1].sessionId === expected, JSON.stringify(w.createCalls[1]));
  check('重建用的 id 与原 id 不同', expected !== 'qqbot-mgr');
}

{
  // ② zh_pro 回收站的终态：摘账本 + 把仍 live 的会话塞进归档集合隐藏 + 移入回收站。
  //    也就是「归档集合里有 + 账本里没有」。
  const w = makeWorld({ archived: [], ledger: ['qqbot-zh'] });
  await quiet(() => w.session.getEntry('zh', 'qqbot-zh', 'standard', null));
  w.ledger.length = 0;                        // 摘账本
  w.archived.push('qqbot-zh');                // 塞进归档集合隐藏
  await quiet(() => w.session.getEntry('zh', 'qqbot-zh', 'standard', null));
  check('zh_pro 删除后 → 同样用派生 id 重建', w.createCalls.length === 2 && w.createCalls[1].sessionId === revivedSessionId('qqbot-zh'), JSON.stringify(w.createCalls[1]));
}

{
  // ③ 重建后连续多条消息：派生 id 确定性，必须复用条目，不能每条消息新建会话。
  const w = makeWorld({ archived: [], ledger: ['qqbot-del2'] });
  await quiet(() => w.session.getEntry('del2', 'qqbot-del2', 'standard', null));
  w.ledger.length = 0;
  await quiet(() => w.session.getEntry('del2', 'qqbot-del2', 'standard', null));   // 触发重建
  await quiet(() => w.session.getEntry('del2', 'qqbot-del2', 'standard', null));   // 再来一条
  await quiet(() => w.session.getEntry('del2', 'qqbot-del2', 'standard', null));   // 再来一条
  check('重建后连续多条消息都复用同一条会话', w.createCalls.length === 2, String(w.createCalls.length));
  check('重建后的会话 id 保持派生值', w.createCalls[1].sessionId === revivedSessionId('qqbot-del2'));
}

{
  // ④ 从没建过的会话（账本里也没有）：不能误判成删除，必须用原 id 建。
  const w = makeWorld({ archived: [], ledger: [] });
  await quiet(() => w.session.getEntry('fresh', 'qqbot-fresh', 'standard', null));
  check('全新会话用原 id 建（不派生成 -r）', w.createCalls.length === 1 && w.createCalls[0].sessionId === 'qqbot-fresh', JSON.stringify(w.createCalls[0]));
}

{
  // ⑤ 普通归档（账本槽位还在）：只召回，绝不能误判成删除。
  const w = makeWorld({ archived: ['qqbot-arch'], ledger: ['qqbot-arch'] });
  await quiet(() => w.session.getEntry('arch', 'qqbot-arch', 'standard', null));
  check('普通归档不触发重建（仍用原 id）', w.createCalls.length === 1 && w.createCalls[0].sessionId === 'qqbot-arch', JSON.stringify(w.createCalls[0]));
  check('普通归档仍会召回', w.unarchiveCalls.length === 1);
}

// ───────────────── 跨工作区冲突：派生 id 必须被认回来，不能每条消息重建 ─────────────────
{
  // DSH 拒绝「同一 id 跨工作区复用」，插件会派生 scoped id 重开；但下一次调用传进来的仍是
  // 原始 id。以前这条走到「绑的是别的 id」分支 → cancel + 重建，每条消息都重来一遍。
  const firstOnly = () => {
    let rejected = false;
    return (id) => { if (rejected === true) return false; rejected = true; return true; };
  };
  const world = makeWorld({ archived: [], ledger: [], rejectFirstCreateOf: firstOnly() });
  await quiet(() => world.session.getEntry("group-99", "qqbot-group-99", "standard", null));
  const firstId = world.createCalls[0] === undefined ? "" : String(world.createCalls[0].sessionId);
  const secondId = world.createCalls[1] === undefined ? "" : String(world.createCalls[1].sessionId);
  check("冲突后派生出一个 scoped id", secondId.startsWith("qqbot-group-99-ws"), secondId);
  const before = world.createCalls.length;
  await quiet(() => world.session.getEntry("group-99", "qqbot-group-99", "standard", null));
  check("下一条消息复用派生 id，不再重建会话", world.createCalls.length === before, "calls=" + world.createCalls.length);
  check("首次仍用原始 id 建", firstId === "qqbot-group-99", firstId);
}
// ──────────────── scoped 条目的被删探测与工作区变化（N-01/N-02 回归） ────────────────
{
  // 回归点：认亲分支以前抢在 isDetached 探测之前 return，派生会话被删后仍喂给死 agent。
  //
  // 关键构造：原始 id **必须留在账本里**（现实中它属于另一个工作区，所以一直在那个账本里），
  // 只摘掉派生 id。这样两种写法才有区分度——查原始 id 会得到「还在」（误判安全），
  // 查派生 id 才得到「被删」。先前版本把账本整个清空，两种写法都判被删，测试抓不住 bug。
  const firstOnly = () => {
    let rejected = false;
    return (id) => { if (rejected === true) return false; rejected = true; return true; };
  };
  const world = makeWorld({ archived: [], ledger: ['qqbot-group-95'], rejectFirstCreateOf: firstOnly() });
  await quiet(() => world.session.getEntry('group-95', 'qqbot-group-95', 'standard', null));
  const scopedId = String(world.createCalls[1].sessionId);
  // 模拟「派生会话被删」：只摘掉它，原始 id 仍留在（别人的）账本里
  const at = world.ledger.indexOf(scopedId);
  if (at >= 0) world.ledger.splice(at, 1);
  check('构造前提：原始 id 仍在账本里、派生 id 已被摘掉',
    world.ledger.includes('qqbot-group-95') && world.ledger.includes(scopedId) !== true,
    world.ledger.join(','));
  const before = world.createCalls.length;
  await quiet(() => world.session.getEntry('group-95', 'qqbot-group-95', 'standard', null));
  check('派生会话被删后要重建，不能继续喂死 agent', world.createCalls.length > before, 'calls=' + world.createCalls.length);
  check('重建时没有沿用已删的派生 id', String(world.createCalls[world.createCalls.length - 1].sessionId) !== scopedId);
}
// ──────────── scopeKey 语义：会话身份只看工作区，不随 flowAuth 开关变化 ────────────
{
  // T-02 的回归点：expectedScopeKey 曾把 flowAuth 开关算进会话身份，
  // 于是设置页拨一下开关就会 delete 条目 + cancel 在跑的回合 + 换一个新会话 id，
  // 而且回拨也重建（key 在两个值间来回永不相等）。旧代码同场景不重建 → 这是回归。
  //
  // 为什么这条测试有判别力：把 flowAuth 算回 scopeKey（旧写法）会让下面两条断言双双转红，
  // 因为它只改 cfg() 的返回值就能让 key 变化，不需要真的重建会话。
  const baseCfg = {
    auth: { ownerPreset: '', guestPreset: '', guestToolAllow: [] },
    agentPreset: 'standard',
    session: { fixedName: true, recallArchived: true },
    flowAuth: { enabled: false },
    perChatSession: true,
  };
  let flowOn = false;
  const world = makeWorld({ archived: [], ledger: [] });
  // 这块要观察 entry.scopeKey，用自己的条目表（makeWorld 里那个是给 world 用的）。
  const toggleConvos = new Map();
  const toggled = createSession({
    getConfig: () => Object.assign({}, baseCfg, { flowAuth: { enabled: flowOn } }),
    ctx: world.ctx,
    state: { convos: toggleConvos, stats: {} },
    ensureQqMsgWorkspace: async () => ({ id: 'ws-root', path: '/tmp/qqmsg' }),
    ensureSessionWorkspace: async () => ({ id: 'ws-sess', path: '/tmp/qqmsg/s1' }),
    sessionWorkdir: () => '/tmp/qqmsg/s1',
    callAdapterAction: async () => ({ ok: false }),
    describeError: (e) => String((e && e.message) || e),
    isOwner: () => true,
    flowGate: null,
    archiveApi: world.archiveApi,
  });
  flowOn = false;
  const keyOff = await toggled.expectedScopeKey();
  flowOn = true;
  const keyOn = await toggled.expectedScopeKey();
  check('flowAuth 关闭与开启时 scopeKey 完全相同（开关不属于会话身份）',
    keyOff === keyOn, keyOff + ' vs ' + keyOn);
  // 更强的判据：**创建侧记下的 scopeKey 必须与 expectedScopeKey() 算出来的一致**。
  // 之前「只验两次调用相等」的断言判别力为零 —— 抓不到「创建侧没同步改」那种半修（D1 报过：
  // 只改 expectedScopeKey、不改 :274 的派生来源，两边永远不等 → 每条消息都 cancel 重建）。
  // 冲突派生要用**新构造**的世界：rejectFirstCreateOf 是构造参数，事后赋值不生效。
  const cw = makeWorld({
    archived: [],
    ledger: [],
    flowEnabled: true,
    rejectFirstCreateOf: (function () {
      let rejected = false;
      return function () { if (rejected === true) return false; rejected = true; return true; };
    })(),
  });
  await quiet(() => cw.session.getEntry('group-96', 'qqbot-group-96', 'standard', null));
  const created = cw.convos.get('group-96');
  check('冲突派生后条目记下了 scopeKey', created !== undefined && typeof created.scopeKey === 'string',
    created === undefined ? '(无条目)' : String(created.scopeKey));
  if (created !== undefined && typeof created.scopeKey === 'string') {
    const nowKey = await cw.session.expectedScopeKey();
    // 判据必须是**严格相等**：这条要抓的是「创建侧与 expectedScopeKey 用了不同来源」那种半修。
    // 只判「不含 flow 字样」太弱 —— 变异验证时两种错误来源都能满足它。
    check('创建侧记的 scopeKey 与 expectedScopeKey() 严格相等',
      created.scopeKey === nowKey,
      'recorded=' + created.scopeKey + ' now=' + nowKey);
  }
  flowOn = false;
  const keyBack = await toggled.expectedScopeKey();
  check('再拨回来仍是同一个 key（不会在值之间来回跳）',
    keyBack === keyOff, keyBack);
}
console.log('\n' + pass + '/' + (pass + fail) + ' 项通过');
if (fail > 0) { console.log('会话归档召回自测失败'); process.exit(1); }
console.log('会话归档召回自测通过');
