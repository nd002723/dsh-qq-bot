// 宿主求值的「人设」文本：从 DSH 的 systemPrompt 服务里，读出**已经求值过**的 soul 人格段。
//
// 为什么走这条路：dsh-soul-md 把人设注册成 `systemPrompt` 的一个段落（name = `soul:persona`），
// 每次组装系统提示词时由它自己求值——卡片优先级（会话指定 → 按工作区 → 默认卡）、模板插值
// 全在它内部完成。主动发言走的是插件内直接调 llm.stream，不经过系统提示词组装，所以拿不到人格；
// 与其在插件里重写一遍 soul-md 的解析规则，不如让宿主求值、这里只取结果。
//
// 只取 `soul:persona` 这一段：
//   - 不取 `soul:memory`（记忆）/ `deployment:persona*`（宿主人设）等其它段——主动发言要的是
//     「说话像谁」，短期上下文已经由群聊历史窗口（qq_history 那套）提供，记忆段几千字纯浪费；
//   - 段名写死是**有意的**：宿主没有「取人设」的通用服务，各插件段名不一，这里只对接 soul-md。

/** 只认这一段（与 dsh-soul-md 注册的名字一致）。 */
export const HOST_PERSONA_SECTION = 'soul:persona';

/**
 * 从组装结果里取出 `soul:persona` 的求值文本。
 * @param {any} assembly systemPrompt.assemble() 的返回值
 * @returns {string} 该段的文本；没有 / 不是字符串 / 空白 → ''
 */
export function pickPersonaText(assembly) {
  const sections = assembly !== null && assembly !== undefined && Array.isArray(assembly.sections) ? assembly.sections : [];
  for (const section of sections) {
    if (section === null || section === undefined || section.name !== HOST_PERSONA_SECTION) continue;
    return typeof section.text === 'string' ? section.text.trim() : '';
  }
  return '';
}

/**
 * @param {object} deps
 * @param {() => any} [deps.getSystemPrompt] 取 DSH `systemPrompt` 服务（拿不到返回 undefined）
 * @param {(line: string) => void} [deps.log] 诊断日志
 * @returns {(agent?: any) => Promise<string>} 读不到 / 没有该段 / 求值报错 一律返回 ''
 */
export function createHostPersonaReader(deps) {
  const source = deps === undefined || deps === null ? {} : deps;
  const log = typeof source.log === 'function' ? source.log : () => {};

  return async function readHostPersona(agent) {
    let service;
    try {
      service = typeof source.getSystemPrompt === 'function' ? source.getSystemPrompt() : undefined;
    } catch (error) {
      service = undefined;
    }
    if (service === undefined || service === null || typeof service.assemble !== 'function') return '';
    let assembly;
    try {
      // 把 agent 交给宿主：soul-md 会据此按「会话指定 → 工作区 → 默认卡」挑卡片。
      assembly = await service.assemble({ agent: agent === undefined ? null : agent });
    } catch (error) {
      log('主动发言：宿主系统提示词求值失败，人格段跳过（' + String(error && error.message ? error.message : error) + '）');
      return '';
    }
    return pickPersonaText(assembly);
  };
}
