// 授权与流程：主人私聊提示、动态码校验、/auth 与 /flow 指令、授权后把被拦回合续上。
// 从 gateway/plugin.js 搬出（P3 2.4 第三阶段，只搬不改）：状态仍在插件 state，
// 判定在 valve 的 flowGate，落盘走注入的 writeFlowAuthPatch。
import { parseAuthCommand, parseFlowCommand, flowReasonZh, FLOW_HELP } from './commands.js';
// 命名空间匹配与 owner-settings 共用同一把尺子（正则 + 唯一性拒绝），避免两套判据漂移。
import { matchNamespace } from '../valve/security/owner-settings.js';

export function createAuthFlow(deps) {
  const { TAG, getConfig, getState, ctx, describeError, sendReply, callAdapterAction, flowGate, writeToAdapter, flowEnabled, flowAuth, getDeliverFlowArtifacts, getRunTurn, flowStore } = deps;
  /** 主人的 QQ 号：取 auth.owners 里第一个非空项；没有主人时授权无从谈起。 */
  function ownerQq() {
    const owners = Array.isArray(getConfig().auth.owners) ? getConfig().auth.owners : [];
    for (const item of owners) {
      const text = String(item === undefined || item === null ? '' : item).trim();
      if (text !== '') return text;
    }
    return '';
  }

  const AUTH_FAIL_TEXT = {
    disabled: '流程授权没有开启',
    'no-secret': '还没配置 TOTP 密钥（服务器上跑 node lib/valve/security/totp-cli.mjs enroll，把 secret 填进设置页）',
    'weak-secret': '密钥太短（少于 10 字节），请在设置页重新生成一个',
    'no-pending': '没有待授权的请求（先让机器人申请一次）',
    'bad-format': '动态码格式不对（6 位数字）',
    mismatch: '动态码不对',
    replayed: '这个动态码已经用过（同一个 30 秒窗口只能用一次）',
    locked: '错误次数太多，已临时锁定',
    'no-recovery': '没有配置恢复码',
    'tool-unknown': '这次申请没绑定到具体工具（内部错误，请重试）',
    'prompt-failed': '授权提示发不到你的私聊（协议端拒绝了私聊消息），已撤销本次申请',
  };

  /**
   * 往私聊发一条文本，返回 { ok, messageId }。
   *
   * 为什么不是只用 `send_private_msg`：QQ 官方 API 适配器只支持 recall / delete_msg
   * 这两个 action（qq-official.mjs 的 SUPPORTED_ACTIONS），`send_private_msg` 一律回
   * 「不支持」——于是流程授权提示在官方协议上从来没发出去过，而 requestFlowAuth 仍回
   * {ok:true}，主人等一条永远不来的码，模型却以为「已申请」（2026-10-28 审计 A3）。
   * 同一个能力用 `send` 帧是通的（官方协议的 send 支持私聊），所以 action 失败就退到帧。
   * 帧是单向的，拿不到 message_id——撤回提示变成「尽力而为」，这本来就是可选项。
   */
  async function sendPrivateText(qq, text) {
    const body = String(text);
    try {
      const result = await callAdapterAction('send_private_msg', {
        user_id: Number(qq),
        message: body,
      }, 8000);
      if (result.ok === true) {
        const id = (result.data !== null && result.data !== undefined
          && result.data.message_id !== undefined && result.data.message_id !== null)
          ? String(result.data.message_id) : '';
        return { ok: true, messageId: id };
      }
      console.log(TAG + ' send_private_msg 不可用（' + String(result.error || '未知原因') + '），改走 send 帧');
    } catch (error) {
      console.log(TAG + ' 私聊发送失败（改走 send 帧）：' + describeError(error));
    }
    // 退路：send 帧。没有 echo 回执，写入成功即视为已发出（与 sendReply 同一套语义）。
    const written = writeToAdapter({ type: 'send', message_type: 'private', target_id: String(qq), text: body });
    return { ok: written === true, messageId: '' };
  }

  /** 撤回机器人自己发的那条消息；失败只记日志（撤不回来也不影响授权结果）。 */
  async function recallMessage(messageId) {
    if (messageId === undefined || messageId === null || String(messageId) === '') return;
    try { await callAdapterAction('delete_msg', { message_id: Number(messageId) }, 8000); }
    catch (error) { console.log(TAG + ' 撤回授权提示失败（忽略）：' + describeError(error)); }
  }

  /** 发起一次授权申请：登记用途、往主人私聊发提示，并记住「授权通过后要续跑哪个回合」。 */
  async function requestFlowAuth(purpose, entry, frame) {
    if (flowEnabled() !== true) return { ok: false, reason: 'disabled' };
    // 提示要发给「发起这次申请的那位拥有者」：多拥有者时固定发第一个人，
    // 第二个 owner 就会一直等一条永远不来的码（闸门只认他自己的 qq）。
    const requester = (frame !== null && frame !== undefined && frame.user_id !== null && frame.user_id !== undefined)
      ? String(frame.user_id) : '';
    const owners = Array.isArray(getConfig().auth.owners) ? getConfig().auth.owners.map((id) => String(id)) : [];
    const qq = (requester !== '' && owners.indexOf(requester) >= 0) ? requester : ownerQq();
    if (qq === '') return { ok: false, reason: 'no-owner' };
    const label = String(purpose === undefined || purpose === null || String(purpose).trim() === ''
      ? '有一项操作要跑' : String(purpose).trim());
    const req = flowAuth.requestAuth(qq, label);
    if (req.ok !== true) return req;
    const ttlSeconds = Math.max(30, Math.floor(Number(req.ttlSeconds) || 30));
    const windowText = ttlSeconds >= 60 ? (Math.round(ttlSeconds / 60) + ' 分钟') : (ttlSeconds + ' 秒');
    const sent = await sendPrivateText(qq,
      '【流程授权】' + label + '\n'
      + '请直接回我一条：/auth 6位动态码\n'
      + '（' + windowText + '内有效，一次一用；验证通过后我撤回这条，你那条也记得撤回）');
    if (sent.ok !== true) {
      // 提示发不出去就别假装已申请：主人收不到码，这个回合等于白等。
      // 回滚刚登记的 pending，让模型能立刻看到「提示发送失败」而不是「已申请，等码」。
      flowAuth.reset(qq);
      return { ok: false, reason: 'prompt-failed' };
    }
    if (sent.messageId !== '') getState().flow.promptIds.set(qq, sent.messageId);
    getState().flow.resume = (entry === undefined || entry === null || frame === undefined || frame === null)
      ? null : {
        entry,
        frame,
        // 排队期间 entry.speaker 会被后到的消息覆盖，续跑必须沿用发起申请那一回合的身份。
        speaker: (entry.turnSpeaker !== undefined && entry.turnSpeaker !== null) ? entry.turnSpeaker : entry.speaker,
      };
    return { ok: true, ttlSeconds };
  }

  /** 把被拦下的回合接着跑：授权到手后模型重试那个工具即可，不用人再催一遍。 */
  function resumeAfterAuth() {
    const pending = getState().flow.resume;
    getState().flow.resume = null;
    if (pending === null || pending === undefined) return;
    const entry = pending.entry;
    const frame = pending.frame;
    if (entry === null || entry === undefined || frame === null || frame === undefined) return;
    const active = getState().flow.active === '' ? '' : '（活动流程：' + getState().flow.active + '）';
    const generation = entry.generation;
    entry.queue = entry.queue
      .then(() => getRunTurn()(entry, frame,
        '（主人已完成流程授权' + active + '：继续刚才被拦下的任务，直接重试那个工具，不要重复申请授权。）',
        generation, true, false, pending.speaker))
      .then(() => getDeliverFlowArtifacts()(entry, frame))
      .catch((error) => {
        getState().stats.errors += 1;
        console.error(TAG + ' 授权后续跑失败：' + describeError(error));
      });
  }

  /** /auth <6位>：只认主人私聊；通过后撤回提示、提醒撤回动态码，并把回合续上。 */
  async function handleAuthMessage(frame, text) {
    const cmd = parseAuthCommand(text);
    if (cmd === null) return false;
    if (flowEnabled() !== true) {
      sendReply(frame, '流程授权没有开启（设置页 → 高级 → 流程授权）。');
      return true;
    }
    if (cmd.token === '') {
      sendReply(frame, '用法：/auth 6位动态码（动态码来自认证器 App）');
      return true;
    }
    const qq = String(frame.user_id);
    // 恢复码形如 XXXXX-XXXXX（字母 + 2-7 字符集），动态码是纯 6 位数字——靠格式区分，不靠猜。
    const isRecovery = /^[A-Za-z2-7]{5}-[A-Za-z2-7]{5}$/.test(cmd.token);
    if (isRecovery && getState().flow.recoveryUsed.has(cmd.token.toUpperCase())) {
      sendReply(frame, '授权失败：这个恢复码已经用过了（一次性）');
      return true;
    }
    const result = isRecovery ? flowAuth.consumeRecoveryCode(qq, cmd.token) : flowAuth.consumeToken(qq, cmd.token);
    if (result.ok !== true) {
      sendReply(frame, '授权失败：' + (AUTH_FAIL_TEXT[result.reason] || result.reason));
      return true;
    }
    flowGate.remember(qq, result.grantId);
    if (isRecovery) {
      getState().flow.recoveryUsed.add(cmd.token.toUpperCase());
      // 真一次性：用掉的那条哈希从配置里剔掉（否则重启后又能用一次）。
      const hashes = Array.isArray(getConfig().flowAuth && getConfig().flowAuth.recoveryHashes) ? getConfig().flowAuth.recoveryHashes.slice() : [];
      const keep = hashes.filter((item, i) => i !== result.usedRecoveryIndex);
      if (keep.length !== hashes.length) {
        const patched = await writeFlowAuthPatch({ recoveryHashes: keep });
        if (patched.ok !== true) console.log(TAG + ' 恢复码哈希落盘失败（该码在重启前仍可用）：' + patched.error);
      }
    }
    const minutes = Math.max(1, Math.round((result.expiresAt - Date.now()) / 60000));
    const promptId = getState().flow.promptIds.get(qq);
    getState().flow.promptIds.delete(qq);
    await recallMessage(promptId);
    sendReply(frame, '已授权：' + result.purpose + '（' + minutes + ' 分钟内 1 次有效）\n'
      + '⚠️ 请撤回你刚发的那条动态码（我撤不了你的消息）。'
      + (isRecovery ? '\n恢复码已经用掉，对应的那条哈希我从设置里删了（万一写盘失败，才需要你去设置页手动删）。' : ''));
    resumeAfterAuth();
    return true;
  }

  /** /flow …：管理「流程脚本」（持久流的编排脚本），本身不执行任何工作。 */
  async function handleFlowCommand(frame, text) {
    const cmd = parseFlowCommand(text);
    if (cmd === null) return false;
    const action = cmd.action;
    const arg = cmd.arg;
    if (action === '' || action === 'help') { sendReply(frame, FLOW_HELP); return true; }
    if (action === 'ls' || action === 'list') {
      const flows = flowStore.list();
      if (flows.length === 0) { sendReply(frame, '还没有流程脚本（把 .js 放进 ' + flowStore.root + ' 就会出现在这里）。'); return true; }
      const lines = flows.map((item) => '· ' + item.name + (item.title === '' ? '' : '（' + item.title + '）')
        + ' ' + String(item.sha256).slice(0, 8));
      sendReply(frame, '流程脚本：\n' + lines.join('\n')
        + (getState().flow.active === '' ? '' : '\n活动流程：' + getState().flow.active));
      return true;
    }
    if (action === 'use' || action === 'switch') {
      if (arg === '') { sendReply(frame, '用法：/flow use <名字>'); return true; }
      const got = flowStore.read(arg);
      if (got.ok !== true) { sendReply(frame, '找不到可用流程：' + arg + '（' + flowReasonZh(got.reason) + '）'); return true; }
      getState().flow.active = got.name;
      sendReply(frame, '活动流程已切到：' + got.name + '（' + got.script.length + ' 字符，sha ' + got.sha256.slice(0, 8) + '）');
      return true;
    }
    if (action === 'off' || action === 'clear') {
      getState().flow.active = '';
      sendReply(frame, '已取消活动流程（后续不再带流程名）。');
      return true;
    }
    if (action === 'rm' || action === 'retire' || action === 'delete') {
      if (arg === '') { sendReply(frame, '用法：/flow rm <名字>'); return true; }
      const removed = flowStore.remove(arg);
      if (removed.ok !== true) { sendReply(frame, '删除失败：' + flowReasonZh(removed.reason)); return true; }
      if (getState().flow.active === arg) getState().flow.active = '';
      sendReply(frame, '已删除流程：' + arg);
      return true;
    }
    if (action === 'auth') {
      const result = await requestFlowAuth(arg === '' ? ('流程 ' + (getState().flow.active || '临时任务')) : arg, null, frame);
      if (result.ok !== true) sendReply(frame, '没法发起授权：' + (AUTH_FAIL_TEXT[result.reason] || result.reason));
      return true;
    }
    if (action === 'unbind') {
      // 解绑等于把闸门整个拆掉，所以不能一行命令就做：必须先在私聊里交一次动态码或恢复码。
      // 验码复用授权状态机（锁定 / 重放 / 一次性都继承），通过后清空密钥与绑定标记。
      const secret = String((getConfig().flowAuth === undefined || getConfig().flowAuth === null ? '' : getConfig().flowAuth.totpSecret) || '').trim();
      if (secret === '') { sendReply(frame, '当前没有绑定密钥（未绑定状态无需解绑）。'); return true; }
      if (arg === '') {
        sendReply(frame, '解绑要验证身份：/flow unbind <6位动态码>（或一次性的 XXXXX-XXXXX 恢复码）。\n'
          + '只发一条 /flow unbind 不会解绑——那样网页会话或拿到你手机的人就能把闸门拆掉。');
        return true;
      }
      const qq = String(frame.user_id);
      // 第三个参数是「显式工具名」：requestAuth 只认「刚被 guard 拦下的工具」或
      // 「purpose 恰好是受闸工具名」，而 'unbind' 两者都不是，于是以前永远回 tool-unknown，
      // 「认证器丢了又没恢复码」这条兜底路径根本走不通（2026-10-28 审计 B4）。
      // 这里由插件内部直接给出，不经过模型，和 guard 的 explicitTool 是同一条受信通道。
      const issued = flowAuth.requestAuth(qq, 'unbind', 'unbind');
      if (issued.ok !== true) { sendReply(frame, '解绑申请被拒：' + (AUTH_FAIL_TEXT[issued.reason] || issued.reason)); return true; }
      const isRecovery = /^[A-Za-z2-7]{5}-[A-Za-z2-7]{5}$/.test(arg);
      const verdict = isRecovery ? flowAuth.consumeRecoveryCode(qq, arg) : flowAuth.consumeToken(qq, arg);
      if (verdict.ok !== true) { sendReply(frame, '解绑失败：' + (AUTH_FAIL_TEXT[verdict.reason] || verdict.reason)); return true; }
      // 授权绑了工具名，取用时必须带上同一个名字；失败就停手（码已经消费掉，
      // 不能一边报错一边把闸门拆了）。
      const taken = flowAuth.takeGrant(verdict.grantId, qq, 'unbind');
      if (taken.ok !== true) { sendReply(frame, '解绑失败：授权凭据无法兑现（' + taken.reason + '）。'); return true; }
      const written = await writeFlowAuthPatch({ totpSecret: '', enrolledAt: 0, recoveryHashes: [], recoverySalt: '' });
      flowAuth.reset();
      flowGate.forget(qq);
      getState().flow.resume = null;
      getState().flow.promptIds.clear();
      sendReply(frame, written.ok === true
        ? '已解绑：密钥、绑定标记与恢复码已清空，闸门保持开启但没有可用密钥，所有授权请求都会失败——重新绑定请跑 node lib/valve/security/totp-cli.mjs enroll。'
        : '解绑已在内存生效，但落盘失败（' + written.error + '）：请到设置页手动清空 TOTP 密钥，否则重启后仍算已绑定。');
      return true;
    }
    if (action === 'reset') {
      flowAuth.reset();
      flowGate.forget(ownerQq());
      getState().flow.resume = null;
      getState().flow.promptIds.clear();
      sendReply(frame, '已清空所有待授权请求与未用授权。');
      return true;
    }
    sendReply(frame, '不认识的 /flow 指令。\n' + FLOW_HELP);
    return true;
  }

  /** 把 flowAuth 的若干字段写回 DSH 设置（走 settings 服务；失败返回可读原因）。 */
  async function writeFlowAuthPatch(patch) {
    let settings;
    try { settings = ctx.get('settings'); } catch (error) { settings = undefined; }
    if (settings === undefined || settings === null || typeof settings.describe !== 'function') {
      return { ok: false, error: '设置服务不可用' };
    }
    try {
      const listed = await settings.describe();
      const items = Array.isArray(listed) ? listed : (Array.isArray(listed.items) ? listed.items : []);
      // 命名空间匹配必须和 owner-settings 用同一把尺子（matchNamespace：`(^|[-_])qq-bot$` 正则
      // + 不唯一时拒绝）。以前这里是 endsWith('qq-bot') + find，两个问题：
      //   ① `endsWith` 会把 `evil-qq-bot`、`xxxqq-bot` 也认成本插件；
      //   ② `find` 在多插件共存时随便挑第一个 —— 于是 TOTP 密钥 / 恢复码哈希可能被写进别人的命名空间。
      const matched = matchNamespace(items);
      if (matched.ok !== true) return { ok: false, error: matched.error };
      const target = matched.descriptor;
      const payload = {};
      for (const key of Object.keys(patch)) payload[key] = patch[key];
      const wrapped = { flowAuth: payload };
      const service = settings;
      await service.update(target.ns, wrapped, target.revision);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  }


  return { ownerQq, sendPrivateText, recallMessage, requestFlowAuth, resumeAfterAuth, handleAuthMessage, handleFlowCommand, writeFlowAuthPatch };
}
