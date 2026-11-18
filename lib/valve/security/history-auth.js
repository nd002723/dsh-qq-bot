// 历史消息的会话定向与鉴权：纯逻辑，便于单测。
// 规则：
// - 当前会话：直接允许（AI 回答群/私聊里的问题时需要上下文）。
// - 跨会话：拥有者、高级管理员可读任意群/私聊；
//   群管理员只能读「自己是管理员/有授权」且「在可管理范围」的群；
//   其他私聊只有拥有者/高级管理员可读。

export function currentConversationOf(entry, frame) {
  const frameGroup = frame !== null && frame !== undefined && frame.group_id !== undefined && frame.group_id !== null ? String(frame.group_id) : '';
  const entryGroup = entry !== null && entry !== undefined && entry.groupId !== undefined && entry.groupId !== null ? String(entry.groupId) : '';
  const groupId = frameGroup !== '' ? frameGroup : entryGroup;
  if (groupId !== '') return { kind: 'group', id: groupId };
  const frameUser = frame !== null && frame !== undefined && frame.user_id !== undefined && frame.user_id !== null ? String(frame.user_id) : '';
  const entryUser = entry !== null && entry !== undefined && entry.userId !== undefined && entry.userId !== null ? String(entry.userId) : '';
  const peer = frameUser !== '' ? frameUser : entryUser;
  if (peer !== '') return { kind: 'private', id: peer };
  return null;
}

export function resolveHistoryTarget(input) {
  const data = input === undefined || input === null ? {} : input;
  const argGroup = typeof data.argGroup === 'string' ? data.argGroup.trim() : '';
  const argPeer = typeof data.argPeer === 'string' ? data.argPeer.trim() : '';
  const current = data.current === undefined ? null : data.current;
  if (argGroup !== '' && argPeer !== '') return { error: 'group_id 与 peer_id 只能二选一' };
  if (argGroup !== '') return { target: { kind: 'group', id: argGroup } };
  if (argPeer !== '') return { target: { kind: 'private', id: argPeer } };
  if (current === null) return { error: '无法确定当前会话，请显式传 group_id 或 peer_id' };
  return { target: current };
}

export function judgeHistoryAccess(input) {
  const data = input === undefined || input === null ? {} : input;
  const target = data.target === undefined ? null : data.target;
  const current = data.current === undefined ? null : data.current;
  const authority = data.authority === undefined ? null : data.authority;
  const targetAuthority = data.targetAuthority === undefined ? null : data.targetAuthority;
  if (target === null) return { allowed: false, scope: 'none', reason: '没有目标会话' };
  if (current !== null && target.kind === current.kind && String(target.id) === String(current.id)) {
    return { allowed: true, scope: 'current', reason: '当前会话' };
  }
  if (authority !== null && authority.owner === true) return { allowed: true, scope: 'cross', reason: '拥有者' };
  if (authority !== null && authority.tier === 'super') return { allowed: true, scope: 'cross', reason: '高级管理员' };
  if (target.kind === 'private') return { allowed: false, scope: 'private', reason: '其他私聊只有拥有者/高级管理员可读' };
  if (data.withinScope !== true) return { allowed: false, scope: 'group', reason: '目标群不在可管理范围' };
  const perms = targetAuthority !== null && targetAuthority.perms instanceof Set ? targetAuthority.perms : null;
  const admin = perms !== null && (perms.has('query') || perms.has('mute') || perms.has('settings'));
  if (admin) return { allowed: true, scope: 'group', reason: '目标群管理员/授权' };
  return { allowed: false, scope: 'group', reason: '需要目标群管理员，或拥有者/高级管理员' };
}

export function buildHistoryRequest(input) {
  const data = input === undefined || input === null ? {} : input;
  const target = data.target;
  const n = Math.floor(Number(data.count));
  const count = Number.isFinite(n) ? Math.max(1, Math.min(50, n)) : 20;
  const before = Math.floor(Number(data.beforeSeq));
  const paged = Number.isFinite(before);
  if (target === undefined || target === null) return { error: '缺少目标会话' };
  if (target.kind === 'group') {
    const params = { group_id: Number(target.id), count };
    if (paged) { params.message_seq = before; params.reverseOrder = true; }
    return { action: 'get_group_msg_history', params, paged, anchor: paged ? before : null };
  }
  const anchorId = Math.floor(Number(data.anchorId));
  const anchor = paged ? before : (Number.isFinite(anchorId) ? anchorId : null);
  if (anchor === null) return { error: '私聊历史需要一条已知消息作锚点：在当前私聊里直接调用，或传 before_seq' };
  return { action: 'get_friend_msg_history', params: { user_id: Number(target.id), count, message_seq: anchor, reverseOrder: true }, paged: true, anchor };
}

/** 部分实现带 reverseOrder 时返回升序；统一成新→旧，并按 message_id 去重。 */
export function normalizeHistory(messages, paged) {
  const list = Array.isArray(messages) ? messages.filter((m) => m !== null && typeof m === 'object') : [];
  const seen = new Set();
  const dedup = [];
  for (const m of list) {
    const id = m.message_id === undefined || m.message_id === null ? '' : String(m.message_id);
    if (id !== '') {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    dedup.push(m);
  }
  return paged === true ? dedup.slice().reverse() : dedup;
}
