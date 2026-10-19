// 业务模块：权限三路鉴权 + QQ 侧群管理指令（handleAdminCommand/planAdminCommand/runGroupAction）。
// 从 lib/index.js 拆出；依赖经 createAdmin(deps) 注入（CONFIG 走 getConfig() 每次现取，支持热更新）。

export function createAdmin(deps) {
  const { getConfig, callAdapterAction, sendReply, state } = deps;
  const TAG = '[dsh-qq-bot]';
  const cfg = () => getConfig();

  const toId = (value) => (/^\d+$/.test(String(value)) ? Number(value) : String(value));

  const PERMISSION_LIST = ['query', 'mute', 'kick', 'recall', 'settings', 'grant'];
  const PERMISSION_LABEL = {
    query: '查询群/成员',
    mute: '禁言/解禁',
    kick: '移出成员',
    recall: '撤回消息',
    settings: '群名/名片/管理员/全员禁言',
    grant: '给本群成员临时授权',
    permanent: '永久授权',
  };

  const sameId = (list, value) => Array.isArray(list) && list.some((item) => String(item) === String(value));
  const isOwner = (userId) => sameId(cfg().auth.owners, userId);
  const isSuperAdmin = (userId) => sameId(cfg().auth.superAdmins, userId);

  // 动态授权表：key = "群号|QQ" -> { groupId, userId, perms:Set, expiresAt, by, permanent }
  const grants = new Map();
  const grantKey = (groupId, userId) => String(groupId) + '|' + String(userId);

  function activeGrant(groupId, userId) {
    if (groupId === null || groupId === undefined) return null;
    const key = grantKey(groupId, userId);
    const record = grants.get(key);
    if (record === undefined) return null;
    if (record.expiresAt !== null && record.expiresAt <= Date.now()) { grants.delete(key); return null; }
    return record;
  }

  function grantRows() {
    const rows = [];
    for (const key of [...grants.keys()]) {
      const record = grants.get(key);
      if (record.expiresAt !== null && record.expiresAt <= Date.now()) { grants.delete(key); continue; }
      rows.push(record);
    }
    return rows;
  }

  function formatGrant(record) {
    const left = record.expiresAt === null ? '永久' : ('至 ' + new Date(record.expiresAt).toLocaleString('zh-CN', { hour12: false }));
    return String(record.userId) + '：' + [...record.perms].join('/') + '（' + left + '，by ' + String(record.by) + '）';
  }

  function manageableGroups() {
    const admin = cfg().admin;
    if (Array.isArray(admin.manageGroups) && admin.manageGroups.length > 0) return admin.manageGroups;
    if (Array.isArray(cfg().group.allow) && cfg().group.allow.length > 0) return cfg().group.allow;
    return null;
  }

  function groupInScope(groupId) {
    const scope = manageableGroups();
    if (scope === null) return true;
    return scope.some((id) => String(id) === String(groupId));
  }

  async function memberRole(groupId, userId) {
    const result = await callAdapterAction('get_group_member_info', {
      group_id: toId(groupId), user_id: toId(userId), no_cache: true,
    });
    if (result === null || result.ok !== true) return null;
    const data = result.data;
    if (data === null || typeof data !== 'object') return null;
    return typeof data.role === 'string' ? data.role : null;
  }

  /**
   * 三路并行求并集。群管理员与动态授权都是群维度的：换个群就不生效。
   * @returns {{tier:string, owner:boolean, userId:string, groupId:string|null, perms:Set<string>, sources:string[]}}
   */
  async function resolveAuthority(userId, groupId) {
    const authority = {
      tier: 'guest', owner: false,
      userId: String(userId),
      groupId: (groupId === null || groupId === undefined) ? null : String(groupId),
      perms: new Set(),
      sources: [],
    };

    // 路由 1：静态名单
    if (isOwner(authority.userId)) {
      authority.owner = true;
      authority.tier = 'owner';
      for (const perm of PERMISSION_LIST) authority.perms.add(perm);
      authority.perms.add('permanent');
      authority.sources.push('拥有者');
    } else if (isSuperAdmin(authority.userId)) {
      authority.tier = 'super';
      for (const perm of PERMISSION_LIST) authority.perms.add(perm);
      authority.sources.push('后台高级管理员');
    }

    // 路由 2：动态授权（只认本群）
    const grant = activeGrant(authority.groupId, authority.userId);
    if (grant !== null) {
      for (const perm of grant.perms) authority.perms.add(perm);
      authority.sources.push('动态授权[' + [...grant.perms].join('/') + ' '
        + (grant.expiresAt === null ? '永久' : ('至 ' + new Date(grant.expiresAt).toLocaleString('zh-CN', { hour12: false }))) + ']');
      if (authority.tier === 'guest') authority.tier = 'granted';
    }

    // 路由 3：本群身份
    if (authority.groupId !== null && cfg().admin.requireGroupAdmin === true) {
      const role = await memberRole(authority.groupId, authority.userId);
      if (role === 'admin' || role === 'owner') {
        for (const perm of PERMISSION_LIST) authority.perms.add(perm);
        authority.sources.push(role === 'owner' ? '本群群主' : '本群管理员');
        if (authority.tier === 'guest') authority.tier = 'group-admin';
      }
    }

    // 群范围闸：不在可管理范围就整体清空
    if (authority.groupId !== null && !groupInScope(authority.groupId)) {
      authority.perms.clear();
      authority.sources.push('（该群不在可管理范围）');
    }
    return authority;
  }

  const TIER_LABEL = { owner: '拥有者', super: '高级管理员', 'group-admin': '本群管理员', granted: '已授权', guest: '访客' };
  const hasPerm = (authority, perm) => authority !== null && authority !== undefined
    && (authority.owner === true || authority.perms.has(perm));

  function describeAuthority(authority) {
    const perms = [...authority.perms];
    return '身份：' + (TIER_LABEL[authority.tier] === undefined ? authority.tier : TIER_LABEL[authority.tier])
      + (authority.sources.length === 0 ? '' : '（' + authority.sources.join(' + ') + '）')
      + '\n权限：' + (perms.length === 0 ? '无' : perms.map((p) => (PERMISSION_LABEL[p] === undefined ? p : PERMISSION_LABEL[p])).join('、'));
  }


  const COMMAND_ARITY = {
    help: [1, 1], whoami: [1, 1], perms: [1, 2],
    mute: [2, 3], unmute: [2, 2], kick: [2, 2], banall: [2, 2],
    card: [3, Infinity], admin: [3, 3], recall: [1, 2], rename: [2, Infinity],
    members: [1, 1], info: [1, 1], grants: [1, 1],
    grant: [3, 4], revoke: [2, 3],
  };
  const ADMIN_USAGE = {
    help: '/help                     列出全部指令',
    whoami: '/whoami                  看我在此群的权限',
    perms: '/perms [@某人]            看某人在此群的权限（三路来源）',
    mute: '/mute @某人 [分钟=10]      禁言（0 = 解禁）',
    unmute: '/unmute @某人            解除禁言',
    kick: '/kick @某人               移出本群',
    banall: '/banall on|off           全员禁言开关',
    card: '/card @某人 新名片        改群名片',
    admin: '/admin @某人 on|off      设/撤管理员',
    recall: '/recall [消息id]         撤回（回复某条消息时可直接省略 id）',
    rename: '/rename 新群名           改群名',
    members: '/members                成员列表',
    info: '/info                   群信息',
    grant: '/grant @某人 权限[,权限] [分钟|forever]   临时授权（仅本群）',
    revoke: '/revoke @某人 [权限]     撤销授权',
    grants: '/grants                 列出本群的动态授权',
  };
  const ADMIN_VERBS = Object.keys(ADMIN_USAGE);

  /** 从 @123 或纯数字里取 QQ 号。 */
  function pickTarget(parts, index) {
    const token = parts[index];
    if (token === undefined) return null;
    const at = /@(\d+)/.exec(token);
    if (at !== null) return at[1];
    if (/^\d+$/.test(token)) return token;
    return null;
  }

  /**
   * 把一条指令解析成动作。返回：
   *   { action, params, describe, format? }  要执行的 OneBot 动作
   *   { local: true, reply }                本地处理（授权表增删改、查看）
   *   { error }                             参数有误
   *   null                                  用法错误
   */
  function planAdminCommand(verb, parts, frame, authority) {
    const groupId = frame.message_type === 'group' ? String(frame.group_id) : null;

    if (verb === 'help') {
      return { local: true, reply: '可用指令：\n' + ADMIN_VERBS.map((v) => ADMIN_USAGE[v]).join('\n') };
    }
    if (verb === 'whoami') {
      return { local: true, reply: describeAuthority(authority) };
    }
    if (verb === 'perms') {
      const target = parts[1] === undefined ? authority.userId : pickTarget(parts, 1);
      if (target === null) return { error: '用法：' + ADMIN_USAGE.perms };
      return { local: true, pendingAuthorityFor: target, reply: '' };
    }
    if (verb === 'grants') {
      const rows = grantRows().filter((r) => r.groupId === groupId);
      return { local: true, reply: rows.length === 0 ? '本群暂无动态授权。' : ('本群动态授权：\n' + rows.map(formatGrant).join('\n')) };
    }
    if (verb === 'grant') {
      const target = pickTarget(parts, 1);
      if (target === null) return { error: '用法：' + ADMIN_USAGE.grant };
      const perms = String(parts[2] ?? '').toLowerCase().split(/[,，/]+/).filter((p) => p !== '');
      if (perms.length === 0) return { error: '用法：' + ADMIN_USAGE.grant };
      const unknown = perms.filter((p) => PERMISSION_LIST.indexOf(p) < 0);
      if (unknown.length > 0) return { error: '权限名无效：' + unknown.join('、') + '；可用：' + PERMISSION_LIST.join('/') };
      const ttlText = String(parts[3] ?? '').toLowerCase();
      let permanent = false;
      let minutes = cfg().auth.grantTtlMinutes;
      if (ttlText === 'forever' || ttlText === '永久' || ttlText === '0') {
        if (authority.owner !== true) return { error: '只有拥有者可以永久授权' };
        permanent = true;
      } else if (ttlText !== '') {
        const parsed = Number(ttlText);
        if (!Number.isFinite(parsed) || parsed <= 0) return { error: '时限必须是分钟数或 forever' };
        minutes = parsed;
      }
      if (permanent !== true) {
        const cap = authority.owner === true ? 525600 : cfg().auth.grantMaxTtlMinutes;
        minutes = Math.min(Math.max(1, Math.round(minutes)), cap);
      }
      return {
        local: true,
        grantAction: { groupId, target, perms, permanent, minutes, by: authority.userId },
        reply: '',
      };
    }
    if (verb === 'revoke') {
      const target = pickTarget(parts, 1);
      if (target === null) return { error: '用法：' + ADMIN_USAGE.revoke };
      const perms = parts[2] === undefined ? null : String(parts[2]).toLowerCase().split(/[,，/]+/).filter((p) => p !== '');
      return { local: true, revokeAction: { groupId, target, perms }, reply: '' };
    }

    // ---- 下面是需要调 OneBot 动作的指令 ----
    if (verb === 'mute' || verb === 'unmute') {
      const target = pickTarget(parts, 1);
      if (target === null) return { error: '用法：' + ADMIN_USAGE.mute };
      const minutes = verb === 'unmute' ? 0 : (parts[2] === undefined ? 10 : Number(parts[2]));
      if (!Number.isFinite(minutes) || minutes < 0) return { error: '分钟数无效' };
      const seconds = Math.min(Math.round(minutes * 60), 43200);
      return {
        action: 'set_group_ban', params: { group_id: toId(groupId), user_id: toId(target), duration: seconds },
        describe: (seconds === 0 ? '解除 ' : '禁言 ') + target + (seconds === 0 ? '' : ' ' + String(minutes) + ' 分钟'),
      };
    }
    if (verb === 'kick') {
      const target = pickTarget(parts, 1);
      if (target === null) return { error: '用法：' + ADMIN_USAGE.kick };
      return { action: 'set_group_kick', params: { group_id: toId(groupId), user_id: toId(target), reject_add_request: false }, describe: '把 ' + target + ' 移出本群' };
    }
    if (verb === 'banall') {
      const flag = String(parts[1]).toLowerCase();
      if (flag !== 'on' && flag !== 'off') return { error: '用法：' + ADMIN_USAGE.banall };
      return { action: 'set_group_whole_ban', params: { group_id: toId(groupId), enable: flag === 'on' }, describe: flag === 'on' ? '开启全员禁言' : '关闭全员禁言' };
    }
    if (verb === 'card') {
      const target = pickTarget(parts, 1);
      const card = parts.slice(2).join(' ').trim();
      if (target === null || card === '') return { error: '用法：' + ADMIN_USAGE.card };
      return { action: 'set_group_card', params: { group_id: toId(groupId), user_id: toId(target), card }, describe: '把 ' + target + ' 的群名片改成「' + card + '」' };
    }
    if (verb === 'admin') {
      const target = pickTarget(parts, 1);
      const flag = String(parts[2]).toLowerCase();
      if (target === null || (flag !== 'on' && flag !== 'off')) return { error: '用法：' + ADMIN_USAGE.admin };
      return {
        action: 'set_group_admin', params: { group_id: toId(groupId), user_id: toId(target), enable: flag === 'on' },
        describe: (flag === 'on' ? '把 ' + target + ' 设为管理员' : '撤销 ' + target + ' 的管理员'),
      };
    }
    if (verb === 'recall') {
      let messageId = null;
      if (parts[1] !== undefined) {
        if (!/^\d+$/.test(parts[1])) return { error: '用法：' + ADMIN_USAGE.recall };
        messageId = Number(parts[1]);
      } else if (frame.reply_to !== null && frame.reply_to !== undefined) {
        messageId = Number(frame.reply_to);
      }
      if (messageId === null || !Number.isFinite(messageId)) return { error: '请给消息 id，或回复要撤回的那条消息再发 /recall' };
      return { action: 'delete_msg', params: { message_id: messageId }, describe: '撤回消息 ' + String(messageId) };
    }
    if (verb === 'rename') {
      const name = parts.slice(1).join(' ').trim();
      if (name === '') return { error: '用法：' + ADMIN_USAGE.rename };
      return { action: 'set_group_name', params: { group_id: toId(groupId), group_name: name }, describe: '把群名改成「' + name + '」' };
    }
    if (verb === 'members') {
      return {
        action: 'get_group_member_list', params: { group_id: toId(groupId) },
        describe: '读取成员列表',
        format: (data) => {
          const rows = Array.isArray(data) ? data : [];
          const lines = rows.slice(0, 30).map((m) => (m.card || m.nickname || '') + '(' + String(m.user_id) + ') [' + String(m.role) + ']');
          return '成员 ' + String(rows.length) + ' 人：\n' + lines.join('\n') + (rows.length > 30 ? '\n…（只列前 30）' : '');
        },
      };
    }
    if (verb === 'info') {
      return {
        action: 'get_group_info', params: { group_id: toId(groupId) },
        describe: '读取群信息',
        format: (data) => (data !== null && typeof data === 'object')
          ? '群名：' + String(data.group_name ?? '') + '｜群号：' + String(data.group_id ?? '')
            + '｜成员：' + String(data.member_count ?? '?') + '/' + String(data.max_member_count ?? '?')
          : '（无数据）',
      };
    }
    return null;
  }

  /** 每个指令需要哪一项权限。 */
  const COMMAND_PERMISSION = {
    mute: 'mute', unmute: 'mute', kick: 'kick', recall: 'recall',
    banall: 'settings', card: 'settings', admin: 'settings', rename: 'settings',
    members: 'query', info: 'query', perms: 'query',
    grant: 'grant', revoke: 'grant', grants: 'grant',
    help: null, whoami: null,
  };

  // 管理指令回复：视作触发 @（引用触发消息的 QQ 回复消息流程）。
  const adminReply = (aframe, atext) => sendReply(aframe, atext, true);

  /** 执行一个 OneBot 群管理动作并回执（支持 dry-run）。 */
  async function runGroupAction(frame, plan) {
    if (cfg().admin.dryRun === true) {
      adminReply(frame, '【演练，未执行】将执行 ' + String(plan.action) + '：' + plan.describe);
      return { ok: true, dryRun: true };
    }
    const result = await callAdapterAction(plan.action, plan.params);
    if (result.ok === true) {
      let extra = '';
      if (typeof plan.format === 'function') {
        try { extra = '\n' + plan.format(result.data); } catch (error) { extra = ''; }
      }
      adminReply(frame, '【已执行】' + plan.describe + extra);
      state.stats.admin += 1;
      return { ok: true, data: result.data };
    }
    adminReply(frame, '【失败】' + plan.describe + '：' + String(result.error === undefined ? '未知错误' : result.error));
    return { ok: false, error: result.error };
  }

  /**
   * QQ 侧指令（方案 B）。命中返回 true = 已处理，不再送给模型。
   *
   * 严格性（防「聊天内容夹带指令样内容」被误执行）：
   *   1. 前缀必须位于消息首位（前面只允许空白）；
   *   2. 动词必须完全匹配已知指令，未知动词照常交给模型；
   *   3. token 数量必须落在该指令的 [min,max] 内，多余内容判为用法错误、不执行；
   *   4. 权限不足直接拒绝，不做任何动作。
   * 刻意放在 requireAt 之前：发指令不该还需要 @ 机器人。
   */
  async function handleAdminCommand(frame, text) {
    const admin = cfg().admin;
    if (admin.enabled !== true) return false;
    const prefix = (typeof admin.prefix === 'string' && admin.prefix !== '') ? admin.prefix : '/';
    const trimmed = text.replace(/^[\s\u3000]+/, '');
    if (!trimmed.startsWith(prefix)) return false;
    const body = trimmed.slice(prefix.length).trim();
    if (body === '') return false;
    const parts = body.split(/\s+/);
    const verb = parts[0].toLowerCase();
    if (ADMIN_VERBS.indexOf(verb) < 0) return false;
    if (frame.message_type !== 'group') { adminReply(frame, '群指令只能在群里使用'); return true; }

    // 严格参数：多余内容判为用法错误
    const arity = COMMAND_ARITY[verb];
    if (parts.length < arity[0] || parts.length > arity[1]) {
      adminReply(frame, '用法：' + String(ADMIN_USAGE[verb]) + '\n（指令必须整条匹配，后面不能有其它内容）');
      return true;
    }

    const authority = await resolveAuthority(frame.user_id, frame.group_id);
    const needed = COMMAND_PERMISSION[verb];
    if (needed !== null && needed !== undefined && hasPerm(authority, needed) !== true) {
      console.log(TAG + ' 指令被拒（' + verb + ' by ' + String(frame.user_id) + '）：缺 ' + needed);
      adminReply(frame, '【拒绝】' + describeAuthority(authority) + '\n缺少权限：'
        + (PERMISSION_LABEL[needed] === undefined ? needed : PERMISSION_LABEL[needed]));
      return true;
    }

    const plan = planAdminCommand(verb, parts, frame, authority);
    if (plan === null) { adminReply(frame, '用法：' + String(ADMIN_USAGE[verb])); return true; }
    if (plan.error !== undefined) { adminReply(frame, plan.error); return true; }

    // 本地指令：授权表增删改与查看
    if (plan.local === true) {
      if (plan.pendingAuthorityFor !== undefined) {
        const targetAuthority = await resolveAuthority(plan.pendingAuthorityFor, frame.group_id);
        adminReply(frame, '@' + plan.pendingAuthorityFor + '\n' + describeAuthority(targetAuthority));
        return true;
      }
      if (plan.grantAction !== undefined) {
        const g = plan.grantAction;
        const existing = grants.get(grantKey(g.groupId, g.target));
        const merged = new Set(existing === undefined ? [] : existing.perms);
        for (const perm of g.perms) merged.add(perm);
        const record = {
          groupId: g.groupId, userId: String(g.target), perms: merged,
          expiresAt: g.permanent === true ? null : Date.now() + g.minutes * 60000,
          by: g.by, permanent: g.permanent === true,
        };
        grants.set(grantKey(g.groupId, g.target), record);
        adminReply(frame, '【已授权】' + formatGrant(record)
          + (g.permanent === true ? '' : '\n（仅在本群有效，' + String(g.minutes) + ' 分钟后自动失效）'));
        state.stats.admin += 1;
        return true;
      }
      if (plan.revokeAction !== undefined) {
        const r = plan.revokeAction;
        const key = grantKey(r.groupId, r.target);
        const existing = grants.get(key);
        if (existing === undefined) { adminReply(frame, '该成员在本群没有动态授权。'); return true; }
        if (r.perms === null) {
          grants.delete(key);
          adminReply(frame, '【已撤销】' + String(r.target) + ' 在本群的全部动态授权。');
        } else {
          for (const perm of r.perms) existing.perms.delete(perm);
          if (existing.perms.size === 0) grants.delete(key);
          adminReply(frame, '【已撤销】' + String(r.target) + ' 的 ' + r.perms.join('/') + ' 授权。');
        }
        state.stats.admin += 1;
        return true;
      }
      adminReply(frame, plan.reply);
      return true;
    }

    console.log(TAG + ' 指令 ' + verb + ' by ' + String(frame.user_id) + ' in ' + String(frame.group_id) + ' -> ' + String(plan.action));
    await runGroupAction(frame, plan);
    return true;
  }


  return { resolveAuthority, hasPerm, describeAuthority, handleAdminCommand, groupInScope, TIER_LABEL, PERMISSION_LIST, toId, isOwner };
}
