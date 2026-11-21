/**
 * 回合文本工具：提示词人格段、配置脱敏、昵称清洗、turn 失败原因归一、协议 id 归一。
 *
 * 从 gateway/plugin.js 搬出（P3 2.4 第一阶段）：这些只吃参数、不碰运行时状态，
 * 搬出去不改变任何行为，只为让 plugin.js 少背一段「和网关生命周期无关」的知识。
 */

/** 把设置里的「人格」渲染成一段身份设定；未启用或没填内容时返回空串。 */
export function buildPersonaHint(persona) {
  if (persona === null || persona === undefined || persona.enabled !== true) return '';
  const name = typeof persona.name === 'string' ? persona.name.trim() : '';
  const text = typeof persona.text === 'string' ? persona.text.trim() : '';
  if (name === '' && text === '') return '';
  return '（身份设定，请始终遵守：' + (name === '' ? '' : '你是' + name + '。') + text + '）';
}

/** 深拷贝一份配置，并把指定路径（键名数组）整段摘掉（不改入参）。 */
export function dropConfigPaths(raw, paths) {
  const clone = (value) => {
    if (Array.isArray(value)) return value.map(clone);
    if (value === null || typeof value !== 'object') return value;
    const next = {};
    for (const [key, child] of Object.entries(value)) next[key] = clone(child);
    return next;
  };
  const result = clone(raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw) ? {} : raw);
  for (const entry of paths) {
    // 只认键名数组：字符串会被当成单个键名，避免 "a.b" 被误解成嵌套路径。
    const parts = (Array.isArray(entry) ? entry : [entry]).map((part) => String(part)).filter((part) => part !== '');
    if (parts.length === 0) continue;
    let node = result;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const key = parts[index];
      if (node === null || typeof node !== 'object' || node[key] === undefined) { node = null; break; }
      node = node[key];
    }
    if (node !== null && typeof node === 'object') delete node[parts[parts.length - 1]];
  }
  return result;
}

/**
 * 提示词里「不能出现」的码点：它们能让一段外部文本另起一行、伪造出结构行。
 *
 * 只靠 \s 是不够的 —— 第三轮安全审查实测：U+2028/U+2029/U+000B/U+000C 属 JS 的 \s，
 * 会被压成空格；但 U+0085(NEL)、U+001C–U+001F、U+0008、U+200B 全部幸存，
 * 于是「补上 sanitizeDisplayName 就安全了」这个说法本身是错的。
 * 这里把「行分隔 / 段分隔 / 各种控制符 / 零宽字符 / 双向控制符」一次列全。
 */
const UNSAFE_CODEPOINTS = /[\u0000-\u001f\u007f\u0085\u00a0\u1680\u2000-\u200f\u202a-\u202e\u2028\u2029\u202f\u205f\u2060-\u206f\u3000\ufeff]/g;

/** 把不可见 / 可伪造结构的码点压成空格（昵称与引用正文共用）。 */
export function stripUnsafeCodepoints(value) {
  return String(value === undefined || value === null ? '' : value).replace(UNSAFE_CODEPOINTS, ' ');
}

/**
 * 昵称/群名片 → 一行安全文本。
 *
 * 除了 \r\n 与方括号，还要压掉所有能伪造结构的码点（见 UNSAFE_CODEPOINTS 的注释）。
 * 方括号也要压：身份头就是 [QQ群 … · 身份:拥有者] 这种形状，昵称里带方括号等于能造出第二行身份头。
 */
export function sanitizeDisplayName(value) {
  const text = stripUnsafeCodepoints(value)
    .replace(/[\[\]【】]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '') return '未知用户';
  return text.length > 32 ? text.slice(0, 32) + '…' : text;
}
/** 把 turn/end reason 清洗成一句话：只保留失败号（400/503/429…），隐藏 request id 等敏感内容 */
export function summarizeTurnReason(reason) {
  let code = '';
  try {
    if (reason !== null && typeof reason === 'object') {
      const err = reason.error;
      const msg = (err !== null && typeof err === 'object' && typeof err.message === 'string') ? err.message
        : (typeof err === 'string' ? err : '');
      const m = /^(\d{3})\s*:/.exec(msg);
      if (m !== null) code = m[1];
    } else if (typeof reason === 'string') {
      const m = /^(\d{3})\s*:/.exec(reason);
      if (m !== null) code = m[1];
    }
    return code !== '' ? code : '未知原因';
  } catch {
    return '未知原因';
  }
}

/** 协议 id 归一：纯数字转 number，其余（qq-official 的 ROBOT1.0_… 之类）原样保留字符串。 */
/**
 * 把 URL 打成可安全写进日志的样子：只保留 scheme + host + port + path。
 *
 * 为什么需要：USAGE.md 明确支持 \`ws://host:6199/?access_token=xxx\` 这种写法，
 * 于是「启动日志打 CONFIG.onebot.wsUrl」就等于把 token 写进 journalctl。
 * 代理串 \`http://user:pass@host:port\` 里的 userinfo 同理。
 * 任何进日志/错误消息的 URL 都先过这个函数。
 */
export function redactUrl(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (raw === '') return '';
  try {
    const url = new URL(raw);
    const auth = url.username !== '' || url.password !== '' ? '<auth>@' : '';
    const port = url.port === '' ? '' : ':' + url.port;
    const path = url.pathname === '' ? '' : url.pathname;
    return url.protocol + '//' + auth + url.hostname + port + path;
  } catch {
    // 解析不了就别原样输出（可能是个畸形串，里面仍可能带 token）
    return raw.length > 32 ? raw.slice(0, 32) + '…（无法解析，已截断）' : raw;
  }
}

export function idValue(value) {
  if (value === null || value === undefined) return undefined;
  const text = String(value);
  if (/^-?\d+$/.test(text) === true) {
    const num = Number(text);
    if (Number.isSafeInteger(num) === true) return num;
  }
  return text;
}
