// 业务模块：会话条目与路由（getEntry/sessionRoute/entryForAgent）+ 被回复图片收集（collectReplyImageUrls）。
// 从 lib/index.js 拆出；依赖经 createSession(deps) 注入。

import { promises as fsPromises } from 'node:fs';

export function createSession(deps) {
  const { getConfig, ctx, state, ensureQqMsgWorkspace, sessionWorkdir, callAdapterAction, describeError, isOwner } = deps;
  const TAG = '[dsh-qq-bot]';
  const cfg = () => getConfig();

  function entryForAgent(agent) {
    if (agent === null || agent === undefined) return null;
    for (const pair of state.convos) if (pair[1].agent === agent) return pair[1];
    return null;
  }


  function sessionRoute(frame) {
    const isGroup = frame.message_type === 'group';
    const chatId = isGroup ? frame.group_id : frame.user_id;
    const scope = (isGroup ? 'group-' : 'private-') + String(chatId);
    const owner = isOwner(frame.user_id);
    const split = cfg().auth.ownerPreset !== '' || cfg().auth.guestPreset !== '';
    if (!split) {
      return { entryKey: scope, sessionId: 'qqbot-' + scope, preset: cfg().agentPreset, tier: owner ? 'owner' : 'guest' };
    }
    const tier = owner ? 'owner' : 'guest';
    return {
      entryKey: scope + '@' + tier,
      sessionId: 'qqbot-' + scope + (owner ? '' : '-guest'),
      preset: (owner ? cfg().auth.ownerPreset : cfg().auth.guestPreset) || cfg().agentPreset,
      tier,
    };
  }


  async function collectReplyImageUrls(frame) {
    if (frame.reply_to === null || frame.reply_to === undefined) return;
    try {
      const r = await callAdapterAction('get_msg', { message_id: Number(frame.reply_to) }, 8000);
      if (r.ok === true && r.data !== null && r.data !== undefined && Array.isArray(r.data.message)) {
        for (const seg of r.data.message) {
          if (seg === null || typeof seg !== 'object') continue;
          if (String(seg.type ?? '').toLowerCase() !== 'image') continue;
          const url = (seg.data && typeof seg.data.url === 'string') ? seg.data.url : '';
          if (url === '' || !/^https?:\/\//.test(url)) continue;
          if (!Array.isArray(frame.replyImageUrls)) frame.replyImageUrls = [];
          frame.replyImageUrls.push(url);
        }
      }
    } catch { /* 尽力而为 */ }
  }


  function getEntry(entryKey, sessionId, preset, fixedTitle) {
    const existing = state.convos.get(entryKey);
    if (existing !== undefined) return existing.ready;
    const entry = {
      key: entryKey, sessionId, agent: null, turns: 0, generation: 0,
      queue: Promise.resolve(), ready: null,
      // 本会话最近一条消息的说话人与身份（qqgroup 工具的鉴权依据）
      speaker: null, groupId: null,
      // 访客工具闸：注册一次，判据是这个可变标志位
      dshAllowed: false, liftGuard: null, guardUnavailable: false,
    };
    entry.ready = (async () => {
      // 官方组装路径：create 会幂等地创建/接管会话，resolveAgent 装上默认模型路由
      // 并挂载 Agent preset（人格 + 工具）。直接 agentLoop.create 不装模型路由，
      // 第一次模型请求必然失败。
      const ws = await ensureQqMsgWorkspace();
      let request;
      if (ws.id !== null) {
        // 有 workspace 服务：传 workspaceId，DSH 自动把会话挂到 QQ_msg 分组。
        request = { sessionId, workspaceId: ws.id };
      } else {
        // 回退：无 workspace 服务时用会话子目录当工作目录。
        const workdir = sessionWorkdir(sessionId);
        await fsPromises.mkdir(workdir, { recursive: true });
        request = { sessionId, cwd: workdir };
      }
      const effectivePreset = preset === undefined ? cfg().agentPreset : preset;
      if (effectivePreset !== '' && effectivePreset !== undefined && effectivePreset !== null) request.agentPreset = effectivePreset;
      await ctx.sessionController.create(request);
      const resolved = await ctx.sessionController.resolveAgent(sessionId);
      if (resolved === null || resolved === undefined || resolved.error !== undefined) {
        const detail = (resolved !== null && resolved !== undefined && resolved.error)
          ? (resolved.error.message ? resolved.error.message : String(resolved.error.code))
          : 'resolveAgent 没有返回 agent';
        throw new Error(detail);
      }
      entry.agent = resolved.agent;

      // 访客工具闸：只在建 agent 时注册一次。guard 是一个每次执行才求值的函数，
      // 判据放进闭包里的可变标志位 entry.dshAllowed，所以拥有者/访客交替说话时
      // 既不用增删限制，也不会造成工具面抖动（那会多记 request/header、白费 token）。
      const guestAllow = new Set(Array.isArray(cfg().auth.guestToolAllow) ? cfg().auth.guestToolAllow : []);
      try {
        entry.liftGuard = entry.agent.ctx.tools.guard((exec) => {
          if (entry.dshAllowed === true) return undefined;
          const toolName = (exec !== null && exec !== undefined && typeof exec.name === 'string') ? exec.name : '';
          if (guestAllow.has(toolName)) return undefined;
          state.stats.guestBlocked += 1;
          console.log(TAG + ' 访客工具闸拦截：' + toolName);
          return '访客模式：不允许使用 DSH 内部工具 ' + toolName;
        });
      } catch (error) {
        entry.guardUnavailable = true;
        console.error(TAG + ' 无法安装访客工具闸，将拒绝驱动非拥有者：' + describeError(error));
      }

      // 固定会话名（可选）：新建会话时钉死成 私聊_<QQ号> / 群聊_<群号>，避免 LLM 自动起标题。
      // rename 用 user 源标题，之后自动生成不会覆盖。只在首次建会话时执行一次。
      if (fixedTitle !== null && fixedTitle !== undefined && fixedTitle !== '' && entry.agent !== null && entry.agent.session !== undefined) {
        try {
          const titles = ctx.get('sessionTitle');
          if (titles !== undefined && titles !== null && typeof titles.rename === 'function') {
            titles.rename(entry.agent.session, fixedTitle);
          }
        } catch (error) {
          console.error(TAG + ' 固定会话名失败（忽略）：' + describeError(error));
        }
      }

      console.log(TAG + ' 会话 ' + sessionId + ' 已就绪（' + entryKey + '）');
      return entry;
    })().catch((error) => { state.convos.delete(entryKey); throw error; });
    state.convos.set(entryKey, entry);
    return entry.ready;
  }


  return { sessionRoute, getEntry, entryForAgent, collectReplyImageUrls };
}
