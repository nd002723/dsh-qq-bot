// 配置契约模块：DEFAULTS 默认值 + Config schema（volatile 设置契约）+ 配置合并工具。
// 被 index.js 用作插件配置来源；设置页(client.js)按 volatile 字段渲染表单。
// Config 契约与 DSH ≥0.1.7 的设置契约：可编辑字段必须标 .volatile()，
// volatile 字段运行时是引用（config.xxx.get()），由 plainConfig 还原成普通对象。
import Schema from '@deepseek-ai/schemastery';

const DEFAULTS = {
  // 留空 = 用包内自带的 lib/onebot-adapter.mjs
  adapterPath: '',
  // 留空 = 启动时用 subprocess.resolveExecutable('node') 解析
  nodePath: '',

  // 'forward'：我们连 NapCat（同机/同容器最简单）
  // 'reverse'：NapCat 连我们（跨容器/跨网络更好用）
  mode: 'forward',
  onebot: {
    wsUrl: 'ws://127.0.0.1:3001',      // mode=forward
    listen: '0.0.0.0:6199',            // mode=reverse
    httpUrl: 'http://127.0.0.1:3000',  // 留空则改用 WS action 发消息
    accessToken: '',
  },

  // 群聊：默认只在被 @ 时响应；allow 为空数组 = 所有群
  group: { enabled: true, allow: [], requireAt: true },
  // 私聊：allow 为空数组 = 所有人
  private: { enabled: true, allow: [] },

  // 例如 '/ai'；空字符串 = 不限制
  commandPrefix: '',

  reply: {
    maxChars: 1200,
    ackAfterMs: 8000,
    ackText: '正在处理，请稍候…',
    firstTurnHint: '（提示：这是一次 QQ 聊天。请用简体中文、简洁自然的口语作答；'
      + '不要输出 Markdown 表格，代码块保持简短。）',
    contextHeader: true,
    // 群聊：被回复（引用）了机器人消息时，视同 @ 处理并响应；
    // 且会拉取最近相关发言（该用户与 bot）作为上下文。
    botReply: true,
  },

  // 群管理。方案 A = Agent 工具（qqgroup），方案 B = QQ 侧管理员指令。
  // 安全默认：operators 为空 => 谁都不能做管理操作，必须显式授权。
  // 权限：三路并行取并集（静态名单 / 动态授权 / 本群身份），另加拥有者的路由特权。
  auth: {
    owners: [],               // 拥有者 QQ 号：全部权限 + 永久授权 + 可走独立的拥有者会话
    superAdmins: [],          // 后台设定的高级管理员：群管理权限（不可永久授权）
    ownerPreset: '',          // 拥有者会话用的 agent preset（留空则不分流）
    guestPreset: '',          // 非拥有者会话用的 agent preset（留空则与拥有者共用）
    grantTtlMinutes: 60,      // 群管理员动态授权的默认时长（分钟）
    grantMaxTtlMinutes: 1440, // 群管理员单次可授的最长时长（分钟）
    // 非拥有者的工具闸：默认禁止访客使用 DSH 内部工具（bash/读写/子代理/…）。
    // 用白名单而不是黑名单——例如 run_code（PTC 保留传输）不在名单里就自动被挡。
    guestToolAllow: ['qqbot', 'qqgroup', 'qq_websearch', 'qq_webfetch', 'qq_imgsearch', 'qq_history', 'moli_fetch'],  // 访客仍可用工具（qqbot/qqgroup 自带鉴权；qq_websearch 联网搜索、qq_webfetch 抓原文、moli_fetch 渲染抓取，均经 webSearch.proxy）
    guestDshTools: false,     // 若确实想让访客也能用 DSH 工具，改成 true
  },
  admin: {
    enabled: true,
    manageGroups: [],        // 可管理的群号；空 = 回退用 group.allow（再空 = 不限制到群）
    requireGroupAdmin: true, // 是否承认「本群管理员」这一路权限
    prefix: '/',            // QQ 侧指令前缀（必须位于消息首位）
    dryRun: false,           // true = 只回复「将执行什么」，不真执行
    allowConsole: false,     // 是否允许非 QQ 来源（如 Web UI 会话）调用管理工具
  },

  perChatSession: true,
  agentPreset: '',
  restart: { baseMs: 1000, maxMs: 30000 },
  logAdapterFrames: false,

  // 图片视觉：QQ 收到图片时，下载图片并用 DSH 已配置的视觉模型做图片理解，
  // 把识别结果并入 Agent 的输入。不新增 baseURL/apiKeyEnv——模型、协议、
  // baseURL、API key 全部沿用 DSH 里原本填写的自定义 providers（如你的自定义 provider）。
  // provider/model 都留空 = 用会话当前模型；模型不支持图片时给出可读报错，
  // 引导用户到插件设置里切换支持视觉的模型（如 deepseek-v4-flash-vision-exp）。
  // 注意：deepseek-v4-flash-0731 实测不真正支持图片（返回空/假装看图），
  // 请在 DSH 的 llm-pi-ai providers 里把视觉模型声明为 input: [text, image]。
  vision: {
    enabled: true,            // 关闭则图片保持 [图片] 占位符
    provider: '',             // 视觉 provider 路由（留空 = 会话模型）
    model: '',                // 视觉模型 id（留空 = 会话模型）
    maxImages: 3,             // 单条消息最多送入的图片数
    downloadTimeoutMs: 10000, // 图片下载超时（毫秒）
  },

  // 联网搜索（qq_websearch 工具）：复用 DSH 的 DeepSeek web search（Anthropic Messages 格式）。
  // proxy 只作用于搜索请求（默认直连）；留空 = 直连官方端点。
  webSearch: {
    baseUrl: '',   // 搜索 API 端点（留空 = https://api.deepseek.com/anthropic/v1）
    apiKeyEnv: '', // API key 环境变量名（留空 = DEEPSEEK_BALANCE_API_KEY）
    proxy: '',     // 自定义 HTTP 代理 http://host:port（留空 = 直连；仅用于搜索请求）
    maxUses: 5,    // 每次搜索最多触发次数
    // 多引擎组合搜索（默认开）：Tavily（配 TAVILY_API_KEY 才启用）→ DuckDuckGo →
    // Yandex / Bing / Wikipedia 兜底，全部请求受上方 proxy 管控；关闭则落回官方
    // DeepSeek web_search（deepseek-official）。本插件独立实现，不依赖任何其它插件。
    multiEngine: true,
  },
  // 图片反搜（qq_imgsearch 工具）：TraceMoe + IQDB，全部请求受上方 webSearch.proxy 管控。
  imgSearch: {
    enabled: true,  // 设置页开关；关闭后 qq_imgsearch 返回「已关闭」
    maxResults: 5, // 每次最多返回结果数
    saucenaoKey: '', // SauceNAO API key（saucenao.com 注册可得）；留空则不启用 SauceNAO
    weightedShuffle: false, // 有代理时按体量权重随机重排引擎顺序（避免固定引擎一直打头）
  },

  // qq_history 工具（AI 自取聊天记录与图片）：识别窗口锚定「最新提及」那条消息，
  // 往前 scopeMessages 条内的图片才识别（更早的 @ 不锚定、不重复识图）；
  // 单次最多 imageLimit 张（最近的优先）。
  history: {
    scopeMessages: 5,  // 识别窗口：触发消息往前最多多少条消息
    imageLimit: 3,     // 窗口内最多识别多少张图片（最近的优先）
  },
};

// -------------------------------------------------------------- 配置契约
// 只有 volatile 字段能被「设置」页改（settings 服务会校验 isVolatilePath），
// 所以凡是出现在设置界面里的字段都必须标 .volatile()。adapterPath / nodePath /
// restart / reply.firstTurnHint 不在界面上，故意保持普通字段：改它们会走
// 「整体重挂插件」这条更稳的路径。
export const Config = Schema.object({
  adapterPath: Schema.string().default('').description('OneBot 适配器脚本路径（留空 = 用包内自带）'),
  nodePath: Schema.string().default('').description('node 可执行文件（留空 = 自动解析）'),

  mode: Schema.union([Schema.const('forward'), Schema.const('reverse')]).default('forward').volatile()
    .description('连接方式：forward = DSH 连 NapCat；reverse = NapCat 连 DSH'),
  onebot: Schema.object({
    wsUrl: Schema.string().default('ws://127.0.0.1:3001').volatile().description('正向 WebSocket 地址'),
    listen: Schema.string().default('0.0.0.0:6199').volatile().description('反向 WebSocket 监听地址'),
    httpUrl: Schema.string().default('http://127.0.0.1:3000').volatile().description('HTTP API 地址（留空 = 改用 WS action 发送）'),
    accessToken: Schema.string().default('').role('secret').volatile().description('NapCat 的 access_token（只写字段）'),
  }),

  group: Schema.object({
    enabled: Schema.boolean().default(true).volatile().description('启用群聊'),
    allow: Schema.array(Schema.string()).default([]).volatile().description('群号白名单（空 = 所有群）'),
    requireAt: Schema.boolean().default(true).volatile().description('群里必须 @ 机器人才回复'),
  }),
  private: Schema.object({
    enabled: Schema.boolean().default(true).volatile().description('启用私聊'),
    allow: Schema.array(Schema.string()).default([]).volatile().description('私聊白名单（空 = 所有人）'),
  }),

  commandPrefix: Schema.string().default('').volatile().description('命令前缀（空 = 不限制）'),

  reply: Schema.object({
    maxChars: Schema.number().default(1200).volatile().description('单条消息最大字数'),
    ackAfterMs: Schema.number().default(8000).volatile().description('慢回复提示阈值（毫秒，0 = 关闭）'),
    ackText: Schema.string().default('正在处理，请稍候…').volatile().description('慢回复提示文案'),
    firstTurnHint: Schema.string().default(DEFAULTS.reply.firstTurnHint).description('首轮提示词'),
    contextHeader: Schema.boolean().default(true).volatile().description('消息附带来源前缀'),
    botReply: Schema.boolean().default(true).volatile()
      .description('被回复（引用）机器人消息时视同 @ 处理并响应（含最近相关发言上下文）'),
  }),

  auth: Schema.object({
    owners: Schema.array(Schema.string()).default([]).volatile().description('拥有者 QQ 号'),
    superAdmins: Schema.array(Schema.string()).default([]).volatile().description('高级管理员 QQ 号'),
    ownerPreset: Schema.string().default('').volatile().description('拥有者会话的 agent preset（空 = 不分流）'),
    guestPreset: Schema.string().default('').volatile().description('非拥有者会话的 agent preset（空 = 与拥有者共用）'),
    grantTtlMinutes: Schema.number().default(60).volatile().description('动态授权默认时长（分钟）'),
    grantMaxTtlMinutes: Schema.number().default(1440).volatile().description('群管理员单次可授最长时长（分钟）'),
    guestToolAllow: Schema.array(Schema.string()).default(['qqbot', 'qqgroup', 'qq_websearch', 'qq_webfetch', 'qq_imgsearch', 'qq_history', 'moli_fetch']).volatile().description('访客仍可用的工具白名单（默认 qqbot/qqgroup/qq_websearch/qq_webfetch/qq_imgsearch/moli_fetch）'),
    guestDshTools: Schema.boolean().default(false).volatile().description('允许非拥有者使用 DSH 内部工具'),
  }),

  moli: Schema.object({
    enabled: Schema.boolean().default(false).volatile()
      .description('启用 Moli 渲染抓取：qq_websearch 的 url 抓取改用 Moli 无头浏览器渲染（可抓 SPA/JS 渲染页；需已安装 moli，否则本开关无效）'),
    proxy: Schema.string().default('').volatile()
      .description('HTTP 代理（留空 = 自动透传 webSearch.proxy）'),
    exePath: Schema.string().default('').volatile()
      .description('moli 可执行文件路径（留空 = 自动探测 ~/.local/bin/moli 与 PATH）'),
  }),

  admin: Schema.object({
    enabled: Schema.boolean().default(true).volatile().description('启用群管理（指令 + qqgroup 工具）'),
    manageGroups: Schema.array(Schema.string()).default([]).volatile().description('可管理的群号（空 = 回退群号白名单）'),
    requireGroupAdmin: Schema.boolean().default(true).volatile().description('承认「本群管理员」这一路权限'),
    prefix: Schema.string().default('/').volatile().description('指令前缀（必须在消息首位）'),
    dryRun: Schema.boolean().default(false).volatile().description('演练模式：只回复将执行什么'),
    allowConsole: Schema.boolean().default(false).volatile().description('允许非 QQ 来源调用管理工具'),
  }),

  perChatSession: Schema.boolean().default(true).volatile().description('每个 QQ 会话一个独立 DSH 会话'),
  agentPreset: Schema.string().default('').volatile().description('Agent preset（空 = 部署默认）'),
  logAdapterFrames: Schema.boolean().default(false).volatile().description('日志打印适配器每一帧（排错）'),

  vision: Schema.object({
    enabled: Schema.boolean().default(true).volatile().description('图片视觉：QQ 收到图片时用视觉模型识别并并入回复'),
    provider: Schema.string().default('').volatile().description('视觉 provider 路由（留空 = 会话模型；复用 DSH 自定义 providers）'),
    model: Schema.string().default('').volatile().description('视觉模型 id（留空 = 会话模型；如 deepseek-v4-flash-vision-exp）'),
    maxImages: Schema.number().default(3).volatile().description('单条消息最多送入的图片数'),
    downloadTimeoutMs: Schema.number().default(10000).volatile().description('图片下载超时（毫秒）'),
  }),

  webSearch: Schema.object({
    baseUrl: Schema.string().default('').volatile().description('搜索 API 端点（留空 = https://api.deepseek.com/anthropic/v1）'),
    apiKeyEnv: Schema.string().default('').volatile().description('搜索 API key 的环境变量名（留空 = DEEPSEEK_BALANCE_API_KEY）'),
    proxy: Schema.string().default('').volatile().description('自定义 HTTP 代理 http://host:port（留空 = 直连；仅作用于搜索请求）'),
    maxUses: Schema.number().default(5).volatile().description('每次搜索最多触发次数'),
    multiEngine: Schema.boolean().default(true).volatile().description('多引擎组合搜索（Tavily → DuckDuckGo → Yandex/Bing/Wikipedia，全部走 webSearch.proxy）；关闭则落回官方 DeepSeek web_search'),
  }),

  imgSearch: Schema.object({
    enabled: Schema.boolean().default(true).volatile().description('图片反搜（qq_imgsearch：TraceMoe/IQDB/Yandex/Copyseeker/Tineye/SauceNAO，请求受 webSearch.proxy 管控）；关闭后工具返回「已关闭」'),
    maxResults: Schema.number().default(5).volatile().description('每次图片反搜最多返回结果数'),
    saucenaoKey: Schema.string().default('').volatile().description('SauceNAO API key（saucenao.com 注册可得）；留空不启用 SauceNAO'),
    weightedShuffle: Schema.boolean().default(false).volatile().description('有代理时按体量权重随机重排引擎顺序（Yandex/Tineye/Copyseeker 权重高）'),
  }).description('图片反搜'),

  history: Schema.object({
    scopeMessages: Schema.number().default(5).volatile().description('qq_history 图片识别窗口：触发消息往前最多多少条消息（默认 5）'),
    imageLimit: Schema.number().default(3).volatile().description('qq_history 窗口内最多识别多少张图片，最近的优先（默认 3）'),
  }).description('聊天记录工具（qq_history）'),

  session: Schema.object({
    fixedName: Schema.boolean().default(true).volatile().description('固定新建会话名为 私聊_<QQ号> / 群聊_<群号>（替代 LLM 自动起标题）'),
  }).description('会话命名'),

  restart: Schema.object({
    baseMs: Schema.number().default(1000),
    maxMs: Schema.number().default(30000),
  }),
}).description('把 QQ 接到 DSH Agent（NapCat / OneBot 11）');

// cordis 的配置引用标记（cosmokit 的共享 symbol），用于把 volatile 字段还原成普通值。
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');
const isVolatileRef = (value) => typeof value === 'object' && value !== null && VOLATILE_WRITE in value;

/** 把（可能含 volatile 引用的）已解析配置还原成普通对象。 */
function plainConfig(value) {
  if (isVolatileRef(value)) return plainConfig(value.get());
  if (Array.isArray(value)) return value.map(plainConfig);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = plainConfig(value[key]);
    return out;
  }
  return value;
}

/** 只递归合并普通对象；数组/标量直接覆盖 */
function mergeConfig(base, override) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  if (override === null || typeof override !== 'object' || Array.isArray(override)) return override === undefined ? out : override;
  for (const key of Object.keys(override)) {
    const value = override[key];
    if (value === undefined) continue;
    const current = out[key];
    if (current !== null && typeof current === 'object' && !Array.isArray(current)
      && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = mergeConfig(current, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

const describeError = (error) => (error === null || error === undefined) ? String(error)
  : (typeof error === 'string' ? error : (typeof error.message === 'string' ? error.message : String(error)));
const describeErrorStatic = describeError;

export { DEFAULTS, plainConfig, mergeConfig, describeError };
