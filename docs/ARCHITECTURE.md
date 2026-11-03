# 架构（0.12.8）

把 QQ 消息桥给 DSH Agent：五种聊天协议各有一个**独立子进程适配器**，插件内核只认一套 stdio 帧和一套统一消息段（OneBot 11 风格）。帧的权威定义只有一处：[lib/transport/bridge/CONTRACT.md](../lib/transport/bridge/CONTRACT.md)。

## 1. 分层

目录按「关注点」分层，每层只依赖它下面那层；阀门（valve）是三道独立的判定关口，
由组装根按优先级装起来。改一处不用翻两千行闭包。

```
QQ 用户
   │
   ▼
QQ 客户端 / 平台（QQ NT、QQ 开放平台、Discord/飞书…）
   │ 各家原生协议
   ▼
协议端（不在本仓库，qq-official 例外：适配器直连腾讯 API 2）：NapCat · OneBot 12 实现端 · Koishi(Satori) · Milky 协议端
   │ 5 种协议之一：onebot11 / onebot12 / satori / milky / qq-official
   ▼
lib/transport/            传输层：独立子进程适配器，零 npm 依赖 —— 只懂协议
   ├─ adapters/*.mjs      五种协议各一个（共用 bridge/ 的 WS/stdio/段工具）
   ├─ bridge/             WS 传输 · stdio 帧工具 · 帧契约（CONTRACT.md）
   └─ index.js            协议名 -> 适配器路径的注册表
   │ stdin/stdout，换行分隔 JSON
   ▼
lib/gateway/              网关层：路由与分发 —— 入站帧 → 会话 → 出站
   ├─ plugin.js           Cordis 插件主体（apply / 生命周期 / 帧分发）
   ├─ index.js            HTTP 路由统一挂载（ROUTE_MOUNTS 表）
   ├─ route-auth.js       路由鉴权闸门（DSH 登录 cookie + 同源校验）
   ├─ routes-bind.js      扫码绑定的两条具名路由
   └─ commands.js         /auth · /flow 指令解析
   │
   ├─ lib/valve/          ★ 阀门层（独立、可单测、无插件内部依赖）
   │   ├─ network/        网络阀门：能不能出站（公网判定 / 内网黑名单 / 钉地址 / 代理语义 / 本地校验代理）
   │   ├─ security/       安全阀：你是谁、这张授权卡真不真（TOTP / 流程授权 / 历史鉴权 / 拥有者通道）
   │   └─ tool/           工具阀：这个工具要不要卡、这张卡能不能用（名单 / 拦截 / 改闸门要码）
   │
   ├─ lib/message/        消息组装：分条 / 流式 / 中间发言 / 段构造 / 入站去重
   ├─ lib/tools/          9 个 Agent 工具 + 联网与媒体实现
   ├─ lib/session/        会话与路由、模型选择、工作区、主动发言
   ├─ lib/api/            群管理指令、官方 Bot 扫码绑定
   └─ lib/shared/         公共基础设施（HTTP 传输、兼容自检）
   │ ctx.sessionController（官方组装路径）
   ▼
DSH Agent（默认每个 QQ 会话一个）
```

浏览器侧是另一条独立的边：`lib/client/settings.js` 是插件详情页里的配置区（`plugins.bundle.config` 插槽），只经 DSH 设置服务读写配置，不参与消息链路。

### 组装优先级（谁先成型）

阀门之间**顺序不能乱**：工具阀消费安全阀发出的授权，安全阀的判定又必须在任何出网之前成立。
顺序写在一张表里（[lib/valve/index.js](../lib/valve/index.js) 的 `STAGE`），组装根
（[lib/assemble.js](../lib/assemble.js)）照着执行；调整优先级只改那张表，不用翻调用方。

**这张表分两段，别混着读**：stage 10/20/30 由 `assembleValves()` 真正装配（依赖没成型就抛错）；
40/50/60 只登记在 `ASSEMBLY_ORDER` 里、用于启动日志说明调用次序，**实际由 `gateway/plugin.js`
在 `apply()` 内部按同一顺序创建**（静态 import，不走装配根）。要让后三层也受装配根管控，
得把它们改造成阀门同款工厂——目前没做，别按「六层都由 assemble.js 装配」去理解代码。

| stage | 层 | 职责 | 依赖 |
| --- | --- | --- | --- |
| 10 | `valve/network` | 出网策略：公网判定 / 内网黑名单 / 钉地址 / 代理语义 | — |
| 20 | `valve/security` | 身份授权：动态码 / 流程授权 / 历史鉴权 / 拥有者通道 | — |
| 30 | `valve/tool` | 工具闸门：名单判定 / 调用拦截 / 改闸门要码 | `security` |
| 40 | `message` | 消息组装：分条 / 流式 / 中间发言 / 段构造 / 去重 | — |
| 50 | `gateway` | 网关路由：入站分发 / 出站投递 / 路由挂载 / 指令解析 | 上面全部 |
| 60 | `transport` | 协议适配：OneBot 11/12 / Satori / Milky / 官方 Bot | — |

数值越小越先成型，也越靠近请求入口（越早拦）。启动日志会打一行 `装配顺序 10:valve/network → …`，
排障时先看它。依赖没成型就装配会直接抛错（不会静默降级成「没有阀门」）。

### 身份契约（改包名时别踩）

同一个插件在 DSH 里有**三个身份**，各按各的 key 派发，混用会出现"面板打不开 / 配置区空白"：

| 身份 | 由谁决定 | 当前值 | 用错的表现 |
| --- | --- | --- | --- |
| 客户端模块 id（`__ModuleLoader__.load({ id })`） | **npm 包名** | `@sputnikzaychik/dsh-qq-bot` | 整个客户端插件不加载：`loaded without registering …` |
| 配置区插槽 key（`slots.register({ key })`） | **npm 包名**（插件页按 `pkg.name` 派发） | 同上 | 插件在、配置区空白 |
| 设置命名空间 `ns`（读写配置） | **profile 条目 id** | `dsh-qq-bot` | 读不到 / 写不进配置（改了这个，老配置也会丢） |

包名以 `package.json` 的 `name` 为准，`cordis.patch.yml` 的 `name` 必须与之一致（`id` 保持不变）。0.12.1 就是只改了包名、前两个 key 还写死旧名字，所以整版客户端不可用——0.12.2 修的就是这三者的关系。

两条贯穿全局的约束：

1. **适配器只管协议，插件只管业务。** 换协议 = 加一个 `lib/transport/adapters/<协议>.mjs` 并在 `lib/transport/index.js` 注册；插件内核零改动。
2. **越权 fail-closed。** 权限判不出来就按低权限；访客工具闸装不上就拒绝驱动非拥有者，没有「默认放行」分支。

## 2. 模块清单

按层列出。**改哪层就只动哪层**：阀门层不知道插件内部结构，网关层不直接发网络请求。

### 2.1 入口与组装

| 文件 | 职责 | 关键导出 |
| --- | --- | --- |
| `lib/index.js` | 包入口**薄壳**：只转发，不放逻辑（包入口路径是对外契约，重构内部目录时它不该变） | `Config` `name` `inject` `apply` `cleanupStaleConfig` |
| `lib/assemble.js` | **组装根**：按 STAGE 表把阀门依次成型，返回装配结果与顺序；`describeAssembly()` 给启动日志 | `assembleValves` `describeAssembly` `ASSEMBLY_ORDER` `STAGE` |
| `lib/config.js` | 配置契约：**扫描各目录的默认值 JSON** + schemastery schema + 合并/还原 + 废弃键识别 | `Config` `DEFAULTS` `DEFAULTS_SOURCES` `plainConfig` `mergeConfig` `staleConfigPaths` |

#### 2.1.1 默认值住在哪：各目录的 JSON，路径不写死

默认值不再全写在 `config.js` 里，而是**谁拥有这组配置，默认值就放在谁的目录**：

| 位置 | 归谁 | 例子 |
| --- | --- | --- |
| `lib/tools/*-conf.json` | 工具自己的参数 | `websearch.js` ↔ `websearch-conf.json`（管 `webSearch`） |
| `lib/valve/<阀门>/*-conf.json` | 阀门自己的参数 | `valve/security/auth-conf.json`（管 `auth`） |
| `lib/config.js` 里的 `CORE_DEFAULTS` | 不属于任何工具/阀门的 | 传输、消息、网关、会话、产物投递 |

`config.js` 在加载时**遍历**这两个目录，逐个读取，每个 JSON 自己声明管哪个配置组：

```json
{ "group": "webSearch", "defaults": { "maxUses": 5 } }
```

于是加新工具只需要往对应目录丢一个 JSON，不用回来改 `config.js`。文件名只用于报错定位，
不参与映射——`websearch-conf.json` 管 `webSearch`，不用逼文件名迁就驼峰。组装链是一条：

```
lib/**/*-conf.json  →  JSON_DEFAULTS  →  DEFAULTS(+CORE)  →  Config 的 .default()  →  staleConfigPaths 判定
```

schema 的默认值直接引用组装结果，所以「默认值」只有一处来源，改 JSON 就是改默认值。
两道加载期护栏：**group 重复**、**group 不在 schema 里**都直接抛错——后者尤其要紧，
因为废弃键清理正是拿 schema 判断哪些键该删，一个笔误就会把用户配置当垃圾清掉。

#### 2.1.2 设置页字段也住在同一个目录，靠后缀区分

默认值解决的是「值是多少」，设置页还要回答「怎么编辑它」。这部分以前写死在客户端 bundle
（`lib/client/settings.js` 里一个上百条的 `FIELDS` 数组），于是加一个字段就要改前端、重新打包。
现在它和默认值用**同一套归属、同一个目录、不同后缀**：

| 后缀 | 管什么 | 组装成 |
| --- | --- | --- |
| `*-conf.json` | 默认值 | `DEFAULTS` |
| `*-set.json` | 设置页字段（怎么显示） | `SETTINGS_FIELDS` + `SETTINGS_TABS` |

```json
{ "priority": 50,
  "group": "webSearch",
  "tab": "capability",
  "subtab": "retrieval",
  "fields": [{ "path": ["webSearch", "maxUses"], "label": "每次搜索最多触发次数",
               "kind": "number" }] }
```

文件头的 `tab` / `subtab` 是这份模板的字段**默认**落在哪个标签页，单条字段再写就覆盖它
（`auth-set.json` 横跨「基础·准入」和「高级·会话」，所以它不写文件头，逐条声明）。
一份模板通常只管一个工具，整份都在同一页——写一遍比每条重复一遍不容易写错；
字段想显式表示「这个标签页没有二级标签」，写 `"subtab": null`。

`priority` 决定这份模板的字段在**同一个标签页/二级标签内**排第几，升序，同值时按文件路径
兜底（保证确定性）。以前顺序是「按文件路径排序」的副产品：`imgsearch` 排在 `moli` 前面，
moli 卡片就卡在「能力 → 检索」分区中间，而它本该收尾——改个文件名就换一次版面，没人知道
顺序是谁定的。现在顺序由模板自己声明：

| 模板 | priority | 落在哪个分区 |
| --- | --- | --- |
| `settings-core-set.json` | 10 | 连接 / 基础 / 会话 / 对话 |
| `valve/security/auth-set.json` | 20 | 基础·准入、会话·会话 |
| `valve/security/flow-auth-set.json` | 30 | 高级·流程、高级·闸门 |
| `tools/vision-set.json` | 40 | 能力·视觉 |
| `tools/websearch-set.json` | 50 | 能力·检索 |
| `tools/imgsearch-set.json` | 60 | 能力·检索 |
| `tools/history-set.json` | 70 | 能力·视觉 |
| `tools/imagegen-set.json` | 80 | 能力·视觉 |
| `tools/moli-set.json` | 90 | 能力·检索（收尾） |

不写 `priority` 时默认 **500**：内置的都写了 10~90，将来第三方或临时加的文件落在这之后，
既不插队到连接页前面，也不会莫名掉到最后。写了但不是有限数字 → 加载期直接炸。

`path` 一律写绝对路径，不做「相对 group」的隐式约定。`when` 是**声明式**的
（`{ "protocol": "onebot12", "protocols.onebot12.mode": { "$ne": "reverse" } }`），
不是函数——JSON 里放不了函数，这也是它必须可声明的原因。

不属于任何工具/阀门的字段放在 `lib/settings-core-set.json`（与 `CORE_DEFAULTS` 对称，
这份不写 `group`，每条靠 `path[0]` 归组）；标签页骨架单独在 `lib/settings-page-set.json`。

组装链：

```
lib/**/*-set.json  →  SETTINGS_FIELDS  →  GET /dsh-qq-bot/settings  →  客户端渲染
```

客户端因此变成**纯渲染器**：`FIELDS` 只剩空数组，加载时用 `applyTemplate()` 填。
加一个字段 = 改对应 `-set.json`，`settings.js` 一行都不用动。

三道加载期护栏（和 group 护栏同一套思路：写错就炸，别等运行期）：

| 写错什么 | 后果（不拦的话） | 护栏 |
| --- | --- | --- |
| `path` 指向不存在的配置项 | 字段永远编辑不到真实配置；更糟的是 `staleConfigPaths` 会把用户存进去的值当废弃键删掉 | `schemaHasPath()` 逐段走 `Config.dict` |
| `tab` / `subtab` 写错 | 字段掉进谁也点不到的页 | 与 `settings-page-set.json` 的骨架比对 |
| `group` 重复 | 两份模板抢同一组，渲染顺序不确定 | 按 group 去重 |
| `priority` 不是有限数字 | 排序变成 `NaN` 比较，整页顺序不可预期 | 加载期校验 |
| 文件头和字段都没写 `tab` | 字段不知道去哪个标签页 | 加载期报错（带字段序号与文件名） |

两个例外标记：`virtual: true`（纯界面锚点，例如扫码绑定，不对应任何配置项，跳过路径校验）、
`in: "moli-card"`（渲染在 moli 卡片内部，不占外层位置，但保存/还原仍按普通字段处理）。

`schemaHasPath` 有个坑值得记：schemastery 的 `schema.dict[key]` 存的是 **Schema 构造器本身**
（`typeof` 是 `'function'`），只判 `typeof === 'object'` 会把每一层都判成不存在。

### 2.2 阀门层 `lib/valve/`

| 文件 | 职责 | 关键导出 |
| --- | --- | --- |
| `valve/index.js` | 阀门注册表：有哪几道阀门、成型顺序、依赖关系（**调优先级只改这里**） | `STAGE` `VALVES` `orderedValves` |
| `valve/network/index.js` | **网络阀门门面**，对外只有两个接口（见 2.2.1）：**流量管控** `traffic` 与**代理状态** `proxyStatus`。成型时用 `__setProxyResolver` 接管传输层的代理策略——**工具层拿不到代理串**，只能声明意图（`useProxy`） | `createNetworkValve` → `traffic` `proxyStatus`（另有策略判定与测试注入：`isAllowedTarget` `isLoopback` `assertHost` `resolve` `pin` `canonicalHost` `uninstall` `__setHooks`） |
| `valve/network/policy.js` | 网络阀门**策略层**（纯判定，不发请求）：地址先过 WHATWG URL 归一，再按 8 组/4 段整数判段；`pinnedLookup` 钉死已校验地址（防 DNS rebinding） | `canonicalHost` `isNonPublicIp` `resolvePublicAddresses` `assertPublicHost` `pinnedLookup` `__setNetworkHooks` |
| `valve/network/guard-proxy.js` | 本地校验代理：给无头浏览器兜底，逐条请求先过策略层，内网目标 403（重定向/子资源/DNS rebinding 都在这层拦） | `createGuardProxy` |
| `valve/security/index.js` | **安全阀门面**：身份、动态码、授权与审计的集中判定处；红线集中写在文件头。注意生产代码目前直接用门面暴露的 `flowAuth`/`flowStore` 对象（见 5.5） | `createSecurityValve` → `flowAuth` `flowStore` `enabled` `gatedTools` |
| `valve/security/totp.js` | 零依赖 TOTP/HOTP 与恢复码（RFC 4226/6238、base32 容错、scrypt 哈希、弱密钥拒绝） | `generateSecret` `hotp` `totp` `totpVerify` `generateBackupCodes` `hashBackupCode` `verifyBackupCode` `otpauthUri` |
| `valve/security/totp-cli.mjs` | 终端绑定：打印 base32 secret / otpauth URI / 终端二维码 / 恢复码（密钥不经 QQ） | —（命令行入口） |
| `valve/security/flow-auth.js` | 授权状态机 + 闸门：申请 / 验码 / grant / 一次性消费 / 连错锁定 / 审计 | `createFlowAuth` `createFlowGate` |
| `valve/security/flow-store.js` | 流程脚本只读视图：名字白名单、sha256、路径穿越防护 | `createFlowStore` `isValidFlowName` `sha256` |
| `valve/security/history-auth.js` | 历史消息的会话定向与鉴权（纯逻辑，三档权限） | `resolveHistoryTarget` `judgeHistoryAccess` `buildHistoryRequest` |
| `valve/security/owner-settings.js` | 拥有者设置通道：白名单、确认码、限流、审计 | `createOwnerSettings` `SPECS` `checkCaller` |
| `valve/tool/index.js` | **工具阀门面**：名单判定 + 调用拦截（一次授权只能用一次）+ 改闸门要码；消费安全阀的 grant，不持有密钥。生产代码取门面暴露的 `gate` 对象（见 5.5） | `createToolValve` → `isGated` `check` `remember` `forget` `names` `blockedText` `sameToolList` |
| `valve/tool/gate-guard.js` | 闸门区改动的判定：改名单 / 关开关都要码（关掉闸门不能比改名单更容易） | `decideGateEdit` `sameToolList` |

#### 2.2.1 网络阀门只暴露两个接口

门面刻意拆成两组，别再把它们揉回一个大对象——两组职责不同，用法也不同：

| 接口 | 成员 | 用途 |
| --- | --- | --- |
| **`traffic`**（流量管控） | `fetchText` `request` `post` `createGuardProxy` | 所有出网动作都从这里走。调用方只声明**意图**（`useProxy` / `timeoutMs` / `binary`），代理怎么取、超时多少、体积怎么截断由阀门决定；**调用方拿不到代理串**。 |
| **`proxyStatus`**（代理状态，只读） | `hasProxy` | 只回答「有没有配 HTTP 代理」，不含任何判定或出网能力。插件/工具读它来决定自己的行为（例如某些搜索/反搜引擎只在走代理时可用），**而不是自己去嗅探配置或代理串**。 |

其余成员（`isAllowedTarget` `assertHost` `resolve` `pin` 等策略判定，以及 `__setHooks` `uninstall` 测试注入）不属于这两个接口，是阀门内部与策略测试用的。

### 2.3 网关层 `lib/gateway/`

| 文件 | 职责 | 关键导出 |
| --- | --- | --- |
| `gateway/plugin.js` | Cordis 插件主体：适配器生命周期、帧分发、回合/回复/视觉、主动发言、配置热更新 | `apply` `name` `inject` `cleanupStaleConfig` |
| `gateway/turn-text.js` | 无状态回合文本工具：人格段、配置脱敏、昵称清洗、turn 失败原因归一、协议 id 归一（P3 2.4 第一阶段搬出） | `buildPersonaHint` `dropConfigPaths` `sanitizeDisplayName` `summarizeTurnReason` `idValue` |
| `gateway/model-pick.js` | 模型选择：构建 `modelRouter` + `/model` 指令；依赖（ctx.get / 前缀 / 日志）由插件注入 | `createModelPicker` |
| `gateway/proactive-surface.js` | 主动发言表面层：配置读取、排程、群级状态与 tick 编排；判定/提示词仍在 `session/proactive.js` | `createProactiveSurface` |
| `gateway/adapter-supervision.js` | 适配器监管：启动参数、子进程生命周期、stdin 写帧、动作请求/超时、重启退避；每 30s 主动 ping，两次无 pong 发 `reconnect`（不重启进程）；状态仍在插件 `state` | `createAdapterSupervision` |
| `gateway/routes-glue.js` | 扫码绑定 / 版本探测 / 路由挂载的接线层 | `createRouteGlue` |
| `gateway/flow-delivery.js` | 流程产物投递：按 `flow.deliver` 打包并上传（私聊 / 群 / none） | `createFlowDelivery` |
| `gateway/inbound-limits.js` | 入站限制：滑动窗口限流、队列深度、单条长度、限流提示去重 | `createInboundLimits` |
| `gateway/auth-flow.js` | 授权与流程：主人私聊提示、动态码校验、`/auth` `/flow` 指令、授权后续跑 | `createAuthFlow` |
| `gateway/artifact-collect.js` | 产物收集与打包：按 mtime 收会话目录新文件，异步 zip/tar | `createArtifactCollect` |
| `gateway/vision.js` | 识图：下载图片、调视觉模型描述、拼进上下文 | `createVision` |
| `gateway/turn-runtime.js` | 回合运行时：入站主流程（限流/鉴权/识图/模型回合/回复）与图片缓存清扫 | `createTurnRuntime` |
| `gateway/index.js` | **HTTP 路由统一挂载**：ROUTE_MOUNTS 表 + 等 webServer 就绪 + 逆序注销 + 失败降级 | `mountHttpRoutes` `mountRoutesWhenReady` |
| `gateway/route-auth.js` | **路由鉴权闸门**：插件具名路由在 DSH 鉴权层**之前**被处理（`GET /` 回 401，`GET /dsh-qq-bot/settings` 回 200），所以自己过一遍 `client-connection` 的浏览器 cookie 校验 + Origin/Referer 同源校验；拿不到该服务时降级放行（那种环境里 DSH 自己也没鉴权） | `createRouteGuard` |
| `gateway/routes-bind.js` | 扫码绑定的两条具名路由：只回状态与脱敏 appId，不碰密钥；`waiting` 期会给登录 URL，必须先过 `guard` | `registerBindRoutes` `BIND_STATE_PATH` `BIND_REFRESH_PATH` |
| `gateway/commands.js` | `/auth` `/flow` 文本解析、拦截判定、打包输入归一化、帮助文案 | `parseAuthCommand` `parseFlowCommand` `flowInterceptKind` `FLOW_HELP` |

### 2.4 消息组装层 `lib/message/`

| 文件 | 职责 | 关键导出 |
| --- | --- | --- |
| （无 `index.js`） | 这里**没有**入口聚合文件：`assembleReply()` 曾是「固定顺序 中间发言 → 正文分条 → 流式合并」的纯函数，但生产代码从不调用它（发送侧在 `gateway/plugin.js` 里自己按这个顺序拼），2026-10-28 审计后删除。要改顺序就改发送侧那一处，别再养一份影子实现。 | — |
| `message/chunk.js` | 回复分条：Markdown 感知切分（代码块/表格整块搬，超长才硬切） | `chunkMarkdown` |
| `message/stream.js` | 官方 v2 私聊流式桥（增量合并 / 节流 / done 收尾 / 失败停用），**特有能力** | `createStreamBridge` `shouldStream` |
| `message/interim.js` | 中间发言：把「已经说完、后面还有内容」的 assistant 文本挑出来先发 | `pickInterim` |
| `message/segments.mjs` | 统一消息段（text/at/image/reply/face/…）与摘要 | `segmentsToText` `countImages` `imageUrlsOf` `summarizeSegments` |
| `message/msgid-cache.js` | 入站去重：按 message_id 记最近见过的消息（有界 + TTL） | `createMsgIdCache` |

### 2.5 工具层 `lib/tools/`

| 文件 | 职责 | 关键导出 |
| --- | --- | --- |
| `tools/index.js` | 9 个 Agent 工具：`qqbot` `qqconfig` `qqgroup` `qq_websearch` `qq_webfetch` `qq_imgsearch` `qq_history` `qq_draw` `qqauth` | `createTools` → `registerTools` |
| `tools/websearch.js` | 联网搜索：DeepSeek 官方 web search + 多引擎组合（全部经网络阀门） | `runWebSearch` |
| `tools/imgsearch.js` | 图片反搜：TraceMoe / IQDB 等 + 图床上传 | `runImageSearch` `uploadToHost` |
| `tools/moli.js` | Moli 引擎封装：探测可执行文件 + 按 dsh-moli 1.1.20 同一套参数调 `moli fetch` | `meFindMoli` `meMoliFetchText` |
| `tools/imagegen.js` | 生图：OpenAI 兼容 `/images/generations`，含重试与任务轮询 | `generateImage` `parseImagePayload` |
| `tools/qr.js` | 自研二维码编码器（字节模式、纠错等级 M、版本 1..9），零依赖 | `encode` `chooseVersion` `toTerminal` |

### 2.6 会话层 `lib/session/`

| 文件 | 职责 | 关键导出 |
| --- | --- | --- |
| `session/manager.js` | 会话条目与路由、访客工具闸、被回复图片收集；被删除会话用 `revivedSessionId` 派生确定性 id 重建 | `createSession` → `sessionRoute` `getEntry` `entryForAgent` `collectReplyImageUrls` `scopedSessionId` `revivedSessionId` |
| `session/session-archive.js` | **归档召回 + 删除探测**：宿主「归档」集合里的 QQ 会话在被消息触发时拉回可见（`ArchivedSessionGate` 会 reject 归档会话的每一步、`create` 的 `reusable` 也排除它，不召回就是石沉大海）；`isDetached` 用「不在任何工作区账本」认出被**真正删除**的会话（dsh-session-manager 与 zh_pro 两种删除器都摘账本、但归档集合留不留 id 不同，所以判据取账本侧）。全 fail-soft | `createSessionArchive` → `recall` `isArchived` `isDetached` `stats` |
| `session/model-router.js` | 模型选择自动检测：DSH `agentDefaultModel`（可写）→ `llm`（只读）→ 本地 per-chat 偏好 | `createModelRouter` `createPrefsFile` |
| `session/workspace.js` | QQ_msg 工作区根解析（Documents 解析，与 DSH 默认工作区同级） | `qqMsgRootSync` `sessionWorkdir` |
| `session/proactive.js` | 主动发言纯逻辑：时间窗、消息清洗、提示词、决策解析、频率闸、两段式模型 | `parseClock` `buildPrompt` `parseDecision` `allowSend` `resolveStageModels` `runSpeakStage` |

### 2.7 平台接口层 `lib/api/`

| 文件 | 职责 | 关键导出 |
| --- | --- | --- |
| `api/group-admin.js` | 三路权限判定（静态名单/动态授权/本群身份）+ 群管理指令 | `createAdmin` → `resolveAuthority` `hasPerm` `handleAdminCommand` |
| `api/group-actions.js` | 群管理动作表：动作 → 权限名（必填）+ OneBot 请求构造；工具与指令共用 | `GROUP_ACTIONS` `GROUP_ACTION_NAMES` `PERMISSION_LIST` `assertGroupActions` |
| `api/qq-bind.js` | 官方 Bot 扫码绑定状态机：二维码回调、凭据回调、刷新/取消（SDK 动态 import） | `createQqBind` `loadOfficialConnect` |
| `api/update-check.js` | 新版本探测：拉 registry 最新版、判断是否更新且与当前 DSH 兼容；6 小时缓存、失败静默 | `createUpdateChecker` `satisfies` `readPackageVersion` |

### 2.8 传输层 `lib/transport/`

| 文件 | 职责 | 关键导出 |
| --- | --- | --- |
| `transport/index.js` | 协议名 -> 适配器路径的注册表（新增协议只改这里） | `resolveAdapterPath` `ADAPTER_ENTRIES` `supportedProtocols` |
| `transport/adapters/onebot11.mjs` | OneBot 11（NapCat 等）：正向/反向 WS + HTTP API | 脚本本体（默认协议） |
| `transport/adapters/onebot12.mjs` | OneBot 12：WS + `POST /`；字符串 id，`mention`/`reply` 段 | 脚本本体 |
| `transport/adapters/satori.mjs` | Satori：`WS /v1/events` + `POST /v1/{resource}.{method}` | 脚本本体 |
| `transport/adapters/milky.mjs` | Milky 1.3：`WS /event` + `POST /api/:api` | 脚本本体 |
| `transport/adapters/qq-official.mjs` | QQ 开放平台 API v2：WS 网关或 Webhook（Ed25519 签名） | 脚本本体 |
| `transport/onebot-adapter.mjs` | 兼容入口，仅一行 `import './adapters/onebot11.mjs'` | — |
| `transport/bridge/CONTRACT.md` | **写新适配器的权威指南**：stdio 帧定义、消息段归一、骨架代码 | —（文档） |
| `transport/bridge/ws.mjs` | 手写 RFC 6455：帧编解码、正向/反向 WS、链路集合、指数退避重连；握手超时 + open 后才算链路 + 任意失败都重试 | `connectForward` `startReverseServer` `createLinkSet` `decodeFrames` |
| `transport/bridge/stdio.mjs` | stdio 帧工具：发射器、发送队列（限速）、stdin 命令循环 | `createEmitter` `createSendQueue` `installStdin` `postJson` |

### 2.9 公共层 `lib/shared/`

| 文件 | 职责 | 关键导出 |
| --- | --- | --- |
| `shared/http.js` | HTTP **传输机制**：直连 / CONNECT 隧道、超时、体积上限、截断语义。判定在 `valve/network/policy.js`，用哪个代理由阀门安装的解析器决定（`__setProxyResolver`），这里只负责「怎么出站」 | `multiEngineRequest` `fetchUrlViaProxy` `webSearchPost` `publicFetch` `currentProxy` `__setProxyResolver` |
| `shared/compat.js` | DSH 版本兼容自检（范围只维护两个常量） | `SUPPORT_FLOOR` `SUPPORT_CEILING` `compatibilityInfo` |
| `shared/imagemeta.js` | 图像元信息：扩展名 ↔ mediaType、按真实内容嗅探格式。与业务无关，凡判断/描述图片格式的地方都可复用 | `IMAGE_EXTS` `MIME_BY_EXT` `isImageExt` `mediaTypeOf` `sniffImage` |
| `shared/gif.js` | GIF 解码（纯 JS）：调色板 / 透明索引 / 隔行 / 局部帧合成；解第 N 帧到 RGBA，或取首帧转 PNG | `decodeGifFrame` `gifFirstFrameToPng` |
| `shared/png.js` | 手写 PNG 编码器（RGBA / 8bit / 无滤波），只用 `zlib.deflateRawSync`，不引图形库 | `encodePng` |

### 2.10 浏览器侧

| 文件 | 职责 |
| --- | --- |
| `client/settings.js` | 插件详情页配置区（手写 `__ModuleLoader__` bundle，只依赖 react）。**模块 id 与插槽 key 都必须是 npm 包名**，设置命名空间 `NS` 仍是条目 id `dsh-qq-bot`（见「身份契约」） |

**扩展点**：加协议 → 新写 `lib/transport/adapters/<协议>.mjs` + 在 `lib/transport/index.js` 与 `lib/config.js` 各加一项；加 Agent 工具 → 改 `lib/tools/index.js`，要在设置页露出参数就再往 `lib/tools/` 丢一个 `{group, defaults}` 的 JSON（**不用改 `config.js`**，它会自己扫到）；加 HTTP 路由 → 只改 `lib/gateway/index.js` 的 `ROUTE_MOUNTS`（**处理器第一行必须过 `deps.guard`**，否则这条路由绕开鉴权）；调阀门优先级 → 只改 `lib/valve/index.js` 的 `STAGE`。

**测试与发布**：`test/run-all.mjs` 汇总 **37 个套件**（5 个协议各一套 + 阀门/组装/权限/设置/搜索/生图/历史/授权链路等），每个协议都自带零依赖假协议端（OneBot 11 的是 `test/mock-onebot.mjs`，其余在各自 `test-adapter-*.mjs` 内）；`npm test` 即跑全部。进 npm 包的只有 `lib/`、`cordis.patch.yml` 与根目录文档（见 `package.json` 的 `files`），`test/`、`examples/` 只在仓库里。

## 3. 关键数据流

### 3.1 入站消息（以群消息为例）

| # | 位置 | 做什么 |
| --- | --- | --- |
| 1 | `lib/transport/adapters/*` | 收协议事件，归一成 CONTRACT 的 `message` 帧写 stdout（文本、图片数/URL、`reply_to`、段数组、`self_id`） |
| 2 | `gateway/plugin.js onAdapterFrame` | 按行切 JSON，`message` 交给 `acceptMessage` |
| 3 | `acceptMessage` | 自过滤（`user_id === self_id`）→ **群管理指令优先**（`handleAdminCommand`，命中即结束，不进模型）→ 白名单 → `commandPrefix` → 是否点名（@bot / 回复 bot / 前缀）→ 收集被回复消息里的图片 |
| 4 | `session/manager.js sessionRoute/getEntry` | 按拥有者/访客取或建会话（`sessionController.create` + `resolveAgent`，只建一次）；**取或建之前先做归档召回**（`session-archive.js`，否则宿主的归档闸门会 reject 整回合）；记 `entry.speaker`（鉴权依据）与 `entry.currentFrame`（qq_history 的识图锚点） |
| 5 | `entry.queue`（串行） | `runTurn`：设 `entry.dshAllowed` → `describeImages`（下载 → `attachments.saveImage` → `llm` 视觉）→ `agent.followup` → `agent.whenIdle` |
| 6 | `extractReply / sendReply / chunkText` | 只取本条用户消息之后的新 assistant 文本，按 `reply.maxChars` 分片，写 `send` 帧 |

回合必须走 `entry.queue`：同会话并发会让 `whenIdle` 等错回合、`dshAllowed` 互相覆盖。

### 3.2 出站发送

| 步骤 | 位置 | 形态 |
| --- | --- | --- |
| 1 | 插件 | `{type:'send', message_type, target_id, text}` 或带 `message:[段]`；段数组优先，其次 `text`。可选 `reply_to`、`echo` |
| 2 | 适配器 | 进 `createSendQueue`（`gapMs` 节流，默认 350ms；Milky 规范频控默认 900ms） |
| 3 | 适配器 | 翻译成协议 API：`send_group_msg` / `message.create` / `send_message` / `send_group_message` / QQ 官方 msg_type |
| 4 | 适配器 | 回 `send_result{ok, echo, message_id, error}`；发送失败也回帧，不抛到顶层 |

引用回复只在群聊且 bot 被点名时附加（`reply_to`），分片每片都带。

### 3.3 动作调用（群管理、查历史、查被回复消息）

`callAdapterAction(action, params, timeoutMs)`（默认 12s）写一行 `{type:'action', action, params, echo}` → 适配器**映射成该协议的 API**（映射不了就回 `ok:false`）→ `action_result{action, echo, ok, data, error}` 按 `echo` 兑现 `state.pending` 里的 Promise；超时 resolve 成 `ok:false` 而不是挂死。

调用方：`qqgroup` 工具、`qq_history` 工具、主动发言取历史、`isReplyToSelf` 查 `get_msg`。

### 3.4 拥有者改设置（qqconfig 工具）

1. `checkCaller`：身份只取自当前会话的 `entry.speaker`，**只允许拥有者私聊**；工具参数里的 QQ 号一律不作数。
2. `show / propose / apply / cancel`：`propose` 只校验不写盘，返回一次性确认码（TTL 5 分钟，绑定 owner + path + value + revision）。
3. 白名单 `SPECS`（群/私聊开关、白名单、回复长度、主动发言…）；密钥、连接参数、`auth.owners` 等按 `DENY_PREFIXES` 整段前缀硬拒。**没列进 `SPECS` 的一律拒绝**（白名单是唯一来源，不是黑名单的补充）。
4. `apply` 前复核 `revision`（期间被别人改过就作废），再 `ctx.settings.update(ns, patch, revision)` —— schema 校验 + 原子写 + 热重载，本模块不写任何 YAML。
5. 限流（每小时 6 次 / 每天 30 次）+ 审计行追加到 `<QQ_msg>/qqbot-config-audit.jsonl`。

### 3.5 废弃配置自动清理（升级删字段之后）

1. 起点：DSH 写设置是**合并**语义（`settings.write()` 最后一步 `mergeLayers(strip(raw, form), next)`）——只替换 schema 认识的字段。
   版本升级删掉的键不会进入 `next`，于是永远留在 `cordis.patch.yml` 里；Schemastery 对未知键也不报错，它们既不生效也不会自己消失。
2. 触发：插件启动后（延时 1.2 秒）与每次保存设置（`loader/volatile-update`，延时 0.3 秒）各跑一次 `cleanupStaleConfig()`。
3. 识别：`configEditor.configuration()` 里按 id / name **精确匹配**本插件那一行，取 `override`（profile 层）交给
   `staleConfigPaths()`；它沿 schema 的 `dict` 下钻，schema 里没有的键按**最浅的一层**报出来（整段未知只报父键）。
   路径用键名数组表示，键名本身带点（`a.b`）也不会被拆成嵌套路径。
4. 写回：`configEditor.edit()` 是唯一能真正删键的入口（`settings.update / mutate` 都是合并，删不掉）。
   基座用 profile 层的 `override`，不用回调给的 `current`——`current` 是各层同 id 后行整段替换后的最终配置，
   拿它当基座会把上层 patch 抄进 profile 行。
5. 收尾：没有废弃键时一次盘都不写；删掉的键连同旧值打进日志。写回对 loader 属于非 volatile 变更，
   会重挂一次插件（适配器断连重连），一次性，不会自激。


### 3.6 编排工具闸门与产物投递（`flowAuth`，默认关）

| # | 位置 | 做什么 |
| --- | --- | --- |
| 1 | `session/manager.js` 接管块 | 开关打开时，在**本 agent 的 tools 作用域**里给 `subagent` / `subagent_fork` / `spawn_teammate` / `workflow` / `moli_fetch` 各注册一个同名遮蔽层（名单以 `flowAuth.gatedTools` 为准）：先问闸门，放行才把参数原样转给被遮蔽的实现；单个工具注册失败就退回 `tools.restrict({deny})` 收掉它 |
| 2 | `valve/security/flow-auth.js` | `requestAuth` 记一条待授权；私聊里 `/auth <6位码>` 命中即 `consumeToken`（30 秒窗口、同窗口不可重放、连错 5 次锁 15 分钟），落成一条 **grant** |
| 3 | `session/manager.js` guard | 工具真正执行前查闸门：一次 grant 只够一次消费；放行时记一笔账，同一回合里遮蔽层不再二次消费 |
| 4 | `entry.turnSpeaker` | 身份按**回合快照**固化——排队期间别人插话，不会把访客的调用判成拥有者的 |
| 5 | `session/workspace.js sessionWorkdir` | 开关打开时给会话独占 `QQ_msg/<会话id>`；这一轮跑完只扫这个目录里新增/改动的文件（隐藏文件跳过、符号链接不跟、`flow.maxBytes` / `flow.maxFiles` 截断） |
| 6 | `gateway/plugin.js deliverFlowArtifacts` | 按 `flow.deliver` 回传（默认私聊，`group:<群号>` 丢群，`none` 只回文字）；打包输入经 `artifactInputLines` 归一化，防 `zip -@` 把文件名当参数 |

中间发言（interim）走同一条发送队列：先发一条无引用的短句，本轮结束后的结论才带 `reply_to`，用户不必等整轮跑完才收到第一声。

## 4. 设计取舍

| 决策 | 为什么 |
| --- | --- |
| 适配器跑独立子进程 | DSH 动态插件沙箱不提供 `fetch`/`WebSocket`；子进程能用完整 `node:*`，适配器崩溃也不带垮插件（由 `scheduleRestart` 退避重启） |
| 零依赖手写 WS | 插件以单文件/包分发，不引 `ws`；`lib/transport/bridge/ws.mjs` 一处实现，五个适配器与测试共用 |
| 中间表示沿用 OneBot 11 风格段 | 0.9 及以前的插件内核已按它写；新协议只做双向翻译，内核零改动即可接五种协议 |
| 段数组优先、`text` 兜底 | 保留 `at`/`image`/`reply` 结构（引用回复、识图、群指令都要）；`text` 只给模型看，图片用 `[图片]` 占位 |
| 适配器与插件走 stdio 换行 JSON | 跨平台、不占端口、可以单独手跑适配器调试（手打一行 JSON）、`echo` 天然关联请求与响应 |
| 适配器只回结果不回异常 | 发送/动作失败统一回 `ok:false` + 可读 `error`，插件不感知协议细节 |
| 权限三路并行取并集 + fail-closed | 静态名单、群维度动态授权、本群身份互补；查不到就按最低权限 |
| 访客工具闸用白名单 + 每次执行求值 | 黑名单易漏（如 PTC 的 `run_code`）；按消息增删工具会让工具面抖动、多耗 token，故用可变标志位 |
| 发送走队列限速 | 平台有频控；每适配器自带 `--send-gap-ms`，默认 350ms（Milky 900ms） |
| `reply` 段不写进正文 | 写 `[回复]` 会让「引用 + `/mute`」的正文以 `[回复]` 开头，斜杠不在首位，群指令永远匹配不上 |
| 同名接管而非替换 | 高危工具本来就不该展示给一般对话 bot；在本 agent 的 tools 作用域里同名覆盖，DSH 正常会话的工具面完全不受影响，插件卸载后原样恢复 |
| 授权一次性消费 + 30 秒窗口 | 动态码会被截图/转发，所以只放行一次调用、只认当前 30 秒窗口（要求 NTP 对齐）；代价是每轮都要有人在私聊里回一条 |
| 回合身份快照 | 守卫读的是回合开始时的发言人；若读实时发言人，排队期间插话的访客就能被当成拥有者 |
| 产物只扫会话自己的目录 | 共用 `QQ_msg` 根时「谁写的新文件」分不出来，共用必然串会话，所以开关打开就独占一个会话目录 |
| 代理由阀门持有、工具只声明意图 | 工具能自己决定「不走代理」等于留了一条绕过出口管控的通道；代理串收到阀门一处，`webSearch.proxy` 改一次全局生效，也杜绝了「某个工具忘了传 proxy」的漂移（历史上三处调用方漂移成三种语义） |
| 中间发言先出声、结论再引用 | 长任务里用户先收到「在做」，最终答案才带引用；两者走同一发送队列，顺序不会乱 |

## 5. 已知边界

### 5.1 协议差异

| 协议 | 技术形态 | 消息体 | 主要缺口 |
| --- | --- | --- | --- |
| onebot11 | 正向/反向 WS + HTTP；`Bearer` / `?access_token=` | CQ 码字符串或段数组 | 动作集取决于实现端（NapCat 最全，其他实现参差） |
| onebot12 | WS + `POST /`（永远 HTTP 200，看 `retcode`）；`Bearer` + `Sec-WebSocket-Protocol` | 段数组（`mention`/`reply`，图片只有 `file_id`） | 段类型少，未映射段降级成 `[暂不支持的消息段]` |
| satori | **应用连 SDK**（SDK 是服务端，与 OneBot 相反）：`WS /v1/events`（opcode 握手 + 心跳）+ `POST /v1/{resource}.{method}`；`Bearer` + `Satori-Platform`/`Satori-User-ID` | `content` 元素串（如 `hi<at id="1"/>`） | 无群名片/管理员/戳一戳；`channel_id` 靠事件缓存或约定重建；`upload.create`（multipart）未实现 |
| milky | `WS /event` + `POST /api/:api`；`Bearer` 或 `?access_token=` | 段数组（`mention`/`mention_all`） | 响应没有 `echo`，只能看 `retcode`；临时会话撤回受限 |
| qq-official | WS 网关或 Webhook 回调（Ed25519 签名）；`QQBot` token 2 小时刷新 | 上行 `content` + `attachments` + `ark` | 无 `at` 段、无 ARK 发送；ID 是 OpenID 不能反查；发图要先换 `file_info`；主动消息强频控 |

### 5.2 插件实际消费的帧

插件只处理 `hello`、`listening`、`status`、`message`、`action_result`、`notice`（仅计数，无业务分支）、`send_result`、`log`、`error`。适配器还可以发 `request`、`heartbeat`、`pong`（CONTRACT 允许），但插件当前不消费——要加消费方，两边一起改。

### 5.3 不支持的能力怎么回答

- 动作：`action_result{ok:false, error:'…不支持…（原因）'}`，绝不静默成功；插件把 `error` 原样交给模型/用户。
- 消息段：目标协议表达不了的段（合并转发、卡片、`at` 等）降级成可读文本占位，不丢整条消息。
- 信息：拿不到就填 `null`（群名片、群角色、昵称），不编造。

### 5.4 其他

- 本仓库不含协议端（NapCat / Koishi / Milky 服务端 / QQ 开放平台）和 QQ 客户端。
- 一个适配器进程对应一份连接配置（OneBot 11 反向模式可接多条链路，取第一条就绪的）；多账号未内建。
- 消息帧与发送帧的形状是插件与适配器的唯一耦合点，改动必须同步五个适配器与 `test/`。
- 配置改动分两类：连接方式（`protocol`/`mode`/各协议连接参数）变化会重启适配器；其余 volatile 字段就地生效，下一轮消息即生效。

### 5.5 已知的分层倒置（**有意保留，不是待修的 bug**）

第 1 节那张分层图是「概念方向」，不是 import 方向的硬约束。下面四处与图相反，都跑得通，写在这里免得下一个人以为是漏改：

| 倒置 | 位置 | 为什么保留 |
| --- | --- | --- |
| **shared → valve** | `shared/http.js` import `valve/network/policy.js`（`canonicalHost` / `isNonPublicIp` / `assertPublicHost` / `pinnedLookup` / `__setNetworkHooks`） | 传输层每次发请求前都要过一遍「能不能出站」，这些判定函数是**纯函数**、无状态、不反向依赖 shared，拿过来直接用比复制一份或再抽一层更省。真要理顺，得把 `policy.js` 下沉到 `shared/`，同时 `valve/network/index.js` 再 import 回来——换来的是更纯的层次图，代价是一次大范围改动。**暂不划算。** |
| **valve → shared** | `valve/network/index.js` import `shared/http.js`（`fetchUrlViaProxy` / `publicFetch` / `multiEngineRequest` / `webSearchPost` / `__setProxyResolver`） | 这一条是**设计本身**：阀门管策略，传输层管怎么发，方向就是「阀门调传输」。它和上一条合起来构成 `shared/http.js` ↔ `valve/network/` 的**双向依赖**——单向看都合理，合起来不成环（`policy.js` 不回指 `http.js`），所以运行时不会出问题。 |
| **transport → message** | `transport/adapters/{onebot11,onebot12,milky,satori,qq-official}.mjs` 都 import `message/segments.mjs` | 适配器要把平台消息归一成**统一段**（`{type,data}`），归一逻辑只有一份、放在 `message/`。按 STAGE 顺序 transport(60) 在 message(40) 之后，方向确实反了；但 `segments.mjs` 是**无依赖的纯函数**，谁 import 都不产生状态耦合。真要理顺就把它下沉到 `shared/segments.mjs`。**暂不划算。** |
| **tools → valve 内部实现** | `tools/index.js` 直接 import `valve/network/guard-proxy.js` 的 `createGuardProxy`（moli 的兜底校验代理） | 这是 moli 自己的内网防护，属于「moli 语义不归阀门管」的既定例外（见 4. 设计取舍）。要收进 `traffic.createGuardProxy` 只需改一行，但那样 `ensureGuardProxy` 这个模块级单例就得跟着拿到阀门实例，改动面比收益大。 |

判断标准：**这些倒置都只跨「无状态纯函数」或「明确的单向调用」，没有形成状态环**。哪天其中一条开始持有状态或回指上层，就必须当场拆开，别再往这张表里加。

### 5.6 门面的「薄包装」现状

`valve/security` 与 `valve/tool` 的门面里有一批便捷方法（`verifyToken` `verifyRecovery` `judgeHistory` `checkOwnerCaller` / `isGated` `check` `remember` `forget` `blockedText` `noteBlocked`），它们是对门面已暴露的 `flowAuth` / `gate` 同名方法的**薄包装**，目前只有测试在调；生产代码直接用底层对象。闸门本身的判定（`decideGateEdit`）不在这些包装里：`gateway/plugin.js` 直接从 `gate-guard.js` import 它。

所以这两个阀门的定位是「**判定与状态集中在这一层**」，不是「所有调用都必须穿过这些包装方法」。要真正收成单一入口，得把 `tools/` 与 `gateway/` 里的直接 import 一并改过来——那是另一次重构，不是补丁。
