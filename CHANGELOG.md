## 未发布 —— 主动发言：会话模型依赖 + 宿主人格（2026-11-03）

### 修复：每轮主动发言都报 `getSessionApi is not a function`

现象：主动发言每 15 分钟一轮，日志固定出现
`主动发言：取会话模型失败（getSessionApi is not a function）`，随后降级用判断模型的正文发言。

根因是**依赖键名写错**：`gateway/proactive-surface.js` 解构的是 `getSessionApi`，
而 `gateway/plugin.js` 传的键是 `sessionApi` —— 工厂拿到 `undefined`，调用即抛。
这个错误要等启动后第一次 tick 才暴露，所以启动日志和测试都没拦住。

- `plugin.js`：传 `getSessionApi: () => sessionApi`，与工厂解构的名字对齐。
- `proactive-surface.js`：构造时检查该依赖，缺了立刻在启动日志里说清楚
  （「取不到会话模型，会退回用判断模型的正文发言」），不再等 15 分钟后才冒一句 `is not a function`。

### 新增：主动发言的人设可以来自 dsh-soul-md

以前主动发言只能用插件自己的两个字段（`proactive.persona` / `config.persona.text`），
用 dsh-soul-md 的用户在群里聊天有人格、主动插话却没有人格。

现在人设按三级取：**`proactive.persona` → 宿主求值的 `soul:persona` 段 → `config.persona`**。

- 取法：插件调宿主 `ctx.systemPrompt.assemble({ agent })`，把该群会话的 agent 传进去，
  soul-md 按它自己的优先级（会话指定 → 工作区 → 默认卡）求值，我们只读 `soul:persona` 这一段的文本；
- 只取人格段，不取记忆段：短期上下文由群聊历史窗口提供，把几千字记忆塞进一句群聊发言没意义；
- 拿不到 `systemPrompt` 服务 / 没有该段 / 求值抛错 → 静默回退到原有行为，不影响主动发言；
- 取会话条目现在只取一次（`proactiveEntry`），模型选项与 agent 复用同一个。

### 新增：主动发言可以配表情包

判断阶段让模型多给一个可选字段 `sticker`（1–3 个中文关键词，从聊天内容里挑）；插件按关键词从图库挑一张，
**随机**选择「图文合并成一条」或「先图后字两条」。挑不到合适的图 / 读文件失败 / 写适配器失败，
一律退回只发文字——不会因为配图把发言搞丢。图库没开就不向模型要关键词。

普通对话则走**隐式引导**：不往会话提示词里加任何东西，只在 `qq_sticker` 的工具描述里写明
「合适的时候主动挑一张发出去，不用等用户开口要，一次最多一张」——工具 schema 本来每次都会下发，
等于零额外上下文。

### 测试

- 新增 `test/test-proactive-wiring.mjs`（16 项）：依赖接线静态对账（工厂解构的键名 = plugin 传的键名）、
  缺依赖要有可读告警、`soul:persona` 段只取人格、缺服务 / 求值抛错降级、agent 传给宿主；
- `test-proactive.mjs` 补 6 条人格优先级 + 表情包关键词 / 发送方式用例；全套 47 个套件 / 1735 项。

## 未发布 —— 动作帧不再排在大图后面（2026-11-03）

### 修复：发完大图马上读历史，`qq_history` 返回 0 条

现象：群里让 bot 连发几张表情包，紧接着问「刚才发了什么」，`qq_history` 返回 `ok: true` + `count: 0`，
像是这个群突然没有聊天记录；过一会儿（或发小图时）又正常。

根因是**适配器 stdin 是 FIFO 管道，图片帧一次整包写进去**（实测单帧 5.2 MB / 11.8 MB）：排在后面的
动作帧要等这几 MB 被适配器读完才会被处理，而 `qq_history` 只等 8 秒 → 动作超时。更糟的是工具把
「动作失败」静默吞成 `count: 0`，于是超时看起来就和「没有历史」一模一样。

改动：

- **写调度**（`lib/gateway/adapter-supervision.js`）：小帧（≤64 KB：动作 / 指令 / 文本 / ping）优先，
  **大帧（图片 base64）整帧一次写，只在帧与帧之间让位给小帧**，动作帧最多等当前这一帧。

  为什么不是「分片写、片间插小帧」：管道是**字节流**、适配器按行（`\n`）解析帧，一帧的字节中间
  插进别的帧会把整行 JSON 劈成两半（现象：适配器报「JSON 解析失败：<base64 垃圾>」，图片发坏）。
  所以插队只发生在帧边界。
- **空闲时小帧仍一片直写**：不给动作和指令加任何延迟（行为和以前一致）。
- **换代次**：适配器重启 / 退出时清空写队列并让旧泵退出，旧帧不会续写进新进程的流里。
- **`qq_history` 如实报错**：动作超时 / 适配器未返回 / 返回格式不对，都作为 `ok:false` 返回并带上原因，
  不再变成「0 条」。

测试：新增 `test-action-priority.mjs`（10 项：整帧原子写、帧边界插队、**帧完整性**、
空闲直写、动作往返、超时如实报错）；
`test-adapter-reconnect.mjs` 的假管道改成按真实语义 emit `drain`（分片写需要它）。

## 未发布 —— 发送背压与工具输出清理（2026-11-03）

### 修复：大图发送被背压误判成失败 + 工具返回带 undefined 字段

- 带 base64 图片的 `send` 帧超过适配器 stdin 管道缓冲时，`write()` 返回 false 被当成「适配器未连接」：
  实际数据已进缓冲、图也到了群里。现在同步写按「接受即成功」处理，并新增 `writeToAdapterAsync`
  （背压时等 drain，超时按已接受处理），qqbot send / qq_draw 的大帧改走它。
- 工具返回值可能带 `error: undefined` 等字段，过不了宿主的 lossless JSON 检查。现在注册前统一递归删除 undefined。
- 测试：`test-adapter-reconnect` 8 → 11（补背压），新增 `test-tool-output` 8 项；套件 43 → 44，总项 1582 → 1593。

## 未发布 —— 适配器静默掉线修复（2026-11-03）

### 修复：NapCat 重启后适配器再也不重连，机器人静默离线

现象：NapCat/QQ 重启（或对端静默断开）之后，适配器子进程还活着，但不再重连；
`ss` 里没有到 11471 的连接，日志停在 `closed(1006)`，systemd 也不会重启（进程没退出）。
线上 0.12.8 可稳定复现。

根因在 `connectForward`：

- 链路在 WebSocket **open 之前**就被加进 `linkSet`，状态/日志会出现假的「已连接」；
- 重连只在 `close` 事件里排一次；握手失败/挂起时如果只出 `error` 或什么都不出，就再也不会重试；
- 没有握手超时，TCP 通了但 101 不回时会永久挂着；
- 重连定时器被 `unref()`，事件循环只剩它时可能停摆。

修法：

- `connectForward` 改为 open 后才算链路；`open / error / close / 超时` 统一收口，每个连接只结算一次；
- 增加握手超时（默认 10s）与 `reconnect()`；任何非正常结束都会排重连，重连定时器不再 unref；
- 适配器心跳每拍给父进程发 `tick`；父进程每 30s 主动 `ping`，连续两次没有 `pong` 就发 `reconnect` 指令
  —— **只重连链路，不强制重启进程**；
- 测试：新增 `test-adapter-reconnect.mjs`（8 项：握手超时重试、open 前不算链路、断开后重连、reconnect）；
  同时补登之前漏计的 `test-session-archive.mjs`（47 项）。套件 41 → 43，总项 1527 → 1582。
## 未发布 —— 表情包图库（目录 + 哈希索引 + AI 自动打标）（2026-11-03）

> 版本号不单独 bump：`package.json` 仍是 **0.12.8**，与上面两节一起等下一次发版。

本节新增「表情包」能力：**目录就是图库**，插件不搬文件；子目录 = 系列，索引写在目录根部的
`index.json`，AI 用新工具 `qq_sticker` 按标签挑图发到当前会话。

### 新增

- **设置页「能力 → 表情包」卡片**（`lib/tools/sticker-set.json`，kind=`sticker`）：
  启用开关、目录（留空 = `QQ_msg/sticker`，相对路径按 `QQ_msg` 解析）、「AI 自动标记」开关、
  打标 provider / 模型（留空跟随「识图与绘图」的视觉配置）、每次最多打标张数、单张超时；
  卡片里还有运行状态（张数 / 系列 / 已标记 / 待标记 / 索引更新时间 / 后台进度）与
  「扫描并打标」「只重建索引」两个按钮。
- **`lib/tools/sticker.js`**：目录扫描（多层子目录 = 系列）、内容 sha1 索引、增量重建、
  AI 打标（`ctx.attachments.saveImage` → `ctx.llm.stream`，与识图同一条链路）、
  按标签 / 描述 / 文件名的多词搜索（命中越多越靠前）、发送目标判定（只发当前会话，不接受外部群号）。
- **`qq_sticker` 工具**：`list` / `search` / `send` / `rebuild`。首次被调用时自动建索引
  （只算哈希，打标丢后台，不拖慢回复）；`rebuild` 会调模型，所以只给拥有者
  （Web UI 需 `admin.allowConsole`）。
- **HTTP 路由**（`lib/gateway/routes-sticker.js`）：`GET /dsh-qq-bot/sticker` 读状态、
  `POST /dsh-qq-bot/sticker/rebuild`（`{mode:"tag"|"index"}`）起后台任务，卡片靠它显示进度。

### 后续调整（同一版本内）

- **卡片可折叠**：`sticker.enabled` 关着时，卡片只留标题条 + 开关 + 一行提示；启用后才展开目录、
  GIF 兼容模式、provider / 模型、上限与状态区。设置页不再被一堆用不上的字段占版面。
- **单文件上限 10 MB**：超过的直接跳过（不动 `index.json`），避免一张巨型图拖垮扫描。
- **GIF 兼容模式**（`sticker.gifCompat`，默认关）：默认把 GIF **原样**发给模型打标；
  打开后在本地解第一帧转 PNG（纯 JS 的 GIF LZW + 手写 PNG 编码，零依赖）再发。
  实测 146 张真实表情包 GIF 全部能解出首帧（其中 4 张其实是改了扩展名的 JPEG，按真实内容发）。

### 设计要点：为什么不会白烧 token

1. 先比 `size + mtime`：完全没变就不读文件内容；
2. 可疑 / 新增的才计算 sha1：**哈希相同就当作没变**（只 `touch` 过不重打标）；
3. **改名 / 换系列 / 复制一份**：路径变了但内容没变，按 sha1 认领旧标签与描述
   （`series` 按新路径重算，报告里记作「认领」），不会因为整理一次目录就把打标结果作废；
4. 只有哈希真变了、或确实是没见过的图，才清空旧标签重新交给视觉模型；
5. 一次最多打 `sticker.maxPerRun` 张，每打完一张就落盘，失败记 `tagFailedAt`
   （10 分钟内自动流程不再重试同一张坏图）。

`autoTag` 是总闸：关掉之后，首次使用与手点「扫描并打标」都只建索引、不调模型。

### 结构：图像编解码放在 `lib/shared/`

- **`lib/shared/imagemeta.js` / `gif.js` / `png.js`**：格式嗅探（按真实内容，不信扩展名）、
  GIF 解码、手写 PNG 编码。这三件与表情包业务无关，凡是要判断/描述图片格式的地方都可复用。
- **`lib/tools/sticker.js`** 只负责表情包这件事：索引、打标、搜索、挑图、发送目标判定；
  编解码按既有习惯从它再导出，测试与调用方直接可用。
- **`lib/gateway/routes-sticker.js`** 的工作区根由 `routes-glue.js` 从 `plugin.js` 注入，
  网关层路由文件不直接 `import ../session/`——与本层其它路由的依赖方向一致。

### 其它

- 坏掉的 `index.json` 不抛错：状态里标 `corrupt`，下次扫描当作「没有索引」重建。
- `test-sticker.mjs` 74 项（索引增量、touch 不重打标、改内容只重打一张、改名 / 换系列 / 复制按
  sha1 认领标签、坏索引自愈、搜索 / 挑图 / 发送目标、路由状态与重建、配置契约、GIF 首帧转码）；
  `test-config` / `test-client` / `test-plugin` 的套件数、二级标签数、工具数断言同步更新。

## 0.12.8 —— P3 结构重构 + 会话召回/重建修复（2026-10-30）

### 修复：会话被真正删除后，再发消息不会重建会话

现象：把某个 QQ 会话（比如 `群聊_299564047`）在 DSH 里**真正删除**（不是归档）之后，
群里再 @ 它就没反应了 —— 不会建新会话，消息像掉进黑洞。

根因不在插件自己，而是三件事叠在一起：

1. 两种删除器都**不销毁内存里的 live agent** —— 上游 `agents` 服务只有
   `create` / `resume` / `get` / `list`，**没有任何按 id 卸载 live agent 的公开 API**；
2. 两种删除器都会把会话槽位从工作区账本（`workspace.sessionIds`）里摘掉，
   但**归档集合的处理不一样**：
   - `dsh-session-manager` 的 `deleteSession`：`detachFromWorkspaces()` → **`unarchiveSession()`**
     （归档集合里不留 id）→ `rm` 整个会话目录；
   - zh_pro 的回收站：摘账本 → 把仍 live 的会话**塞进归档集合隐藏** → 移入回收站；
3. 插件内存里的 `state.convos` 条目也还在（agent 还活着，条目自然没人清）。

于是 `getEntry` 永远命中「已有条目」分支、**一辈子不会调 `sessionController.create`**，
消息就被喂给一个日志目录已经没了的旧 agent。

> 第一版修复拿「归档集合里有它」当判据，**生产上不生效**：session-manager 会先
> `unarchiveSession()` 把它摘掉，那个条件永远不成立。判据只能取两种删除器的**共同指纹**：
> **不在任何工作区账本**。

修复分两步：

- **新增探测** `isDetached(sessionId)`（`session/session-archive.js`）：这个 id 是否已经
  不在任何工作区账本里。读法上优先用 registry 实体的权威 `record.sessionIds`，退回公开的
  `sessionIds` getter —— 后者会被 canonical-cwd 索引过滤，索引过期时会隐藏真实成员。
  读不到工作区列表（老宿主没有 `list()`、registry 未启动）一律返回 false。
- **调用方叠加「插件已经有它的条目」**（`session/manager.js`）：光看账本不够 ——
  从没建过的会话同样不在账本里。所以判据是「**条目在 + 账本没了 = 被删了**」，
  命中就换确定性派生 id 重建（`revivedSessionId()`），并丢掉旧条目、`agent.cancel()` 停掉残留回合。

为什么不用宿主 `createMinted` 出来的新 id：`create` 对不可复用的 sessionId 会自己铸一个
`session-<uuid>`，但插件下一条消息又会拿 `sessionRoute` 算出的原 id 来要会话 ——
不把新 id 固定下来，就会**每条消息新建一条会话**。派生 id（`<原 id>-r<sha1 前 6 位>`）
是确定性的，同一条 QQ 会话每次算出来都一样；条目记着派生 id，之后的消息直接复用。

测试 `test/test-session-archive.mjs` 从 29 项加到 **47 项**，两种删除器的终态各跑一遍：
session-manager（账本摘掉、归档集合也清空）与 zh_pro（账本摘掉 + 归档集合里留 id），
都必须用派生 id 重建；另外覆盖「连续多条消息只重建一次」「全新会话不误判」
「普通归档不触发重建」「record 存在时不被 stale getter 误导」。

> 已知边界：那个被删除但仍驻留内存的孤儿 agent 收不掉 —— 宿主没有卸载 API。
> 插件这边只是不再引用它，它会一直占着内存到进程重启。

### 新增：自动召回已归档会话

QQ 会话在 DSH 侧被「归档」之后，新消息会**彻底石沉大海**——不发模型请求、不报错、日志只有一行
`blocked`。根因不在本插件，而在宿主的两处归档判定：

1. `dsh-api-session-controller` 的 `ArchivedSessionGate` 挂在 `agent/pre-step` 上，
   对归档会话（及其 subagent 后代）直接返回 `{ kind: 'reject' }` —— 回合以 blocked 结束，
   **一个模型请求都不发**；
2. 同一个包的 `SessionController.create` 里 `reusable` 判定是
   `!archivedSessionIds.includes(id) && …` —— 归档会话不被重用，插件拿着
   `qqbot-group-<群号>` 去 create 时宿主要么另建一条会话、要么直接报错，历史断在旧 id 上。

而上游只提供 `archiveSession`，插件侧本来没有解除的入口。本地 DSH 0.2.1-rc.3 的
`dsh-workspace` registry **有正式方法 `unarchiveSession(sessionId)`**（幂等、不做存在性
校验、内部串行队列 + 落盘），所以新增 `lib/session/session-archive.js` 直接调它，
不碰宿主任何内部字段。

语义刻意与「归档动作秒级弹回」区分开：**只在会话被消息真正触发时解除归档**。主人主动归档
的会话保持归档，不拦归档动作、也不跑定时巡检。

接线两处（`session/manager.js` 的 `getEntry`）：

- **新建分支**：召回放进 `entry.ready` 链的开头，**早于 `sessionController.create`**。
  放这里而不是 `getEntry` 开头，是因为 `convos.get` 与 `convos.set` 必须留在同一个 tick
  内保持原子——否则两条并发消息会各自发现「没有条目」、各建一次会话。
- **已有条目分支**：同样召回。agent 可能还活着，但归档判定是宿主**每次 pre-step 现读集合**，
  不解除的话这一回合照样被 reject。

全 fail-soft：`workspaceRegistry` 没挂载（headless）、尚未启动（`requireState` 抛
`workspace registry is not started yet`）、宿主没有该接口、`unarchiveSession` 本身失败
—— 一律只记日志，绝不挡住收发主链；同一错误 60 秒内只打一次。

配置项 `session.recallArchived`（默认开，设置 → 高级 → 会话与排错）。关闭后行为回到
0.12.7：归档的 QQ 会话收不到回复。

测试：新增 `test/test-session-archive.mjs`（29 项）。除了常规的「真调了 / 只在归档时调 /
失败不抛 / 老宿主兼容」，两条重点断言是：

- **`createSawArchived === false`** —— 断言 `create` 被调用那一刻该会话已不在归档集合里。
  只测「`unarchiveSession` 被调用过」是挡不住「调用顺序反了」的。
- **并发两条消息只建一次会话** —— 守的是「召回别把 get/set 的原子性拆开」这个坑。

### 修复：设置页「会话与排错」乱序 —— 排序口径改为按分区

「高级 · 会话与排错」里 ①②③ 是乱的：`① 自定义 preset → ③ 兜底 → ② 拥有者 → ② 非拥有者`。

根因是排序排的是**文件**：按 `priority` 升序把整份模板的字段连块塞进列表，文件级 priority
只能决定「这一块排在哪儿」，做不到跨模板交织——auth 的 ② 整块被甩到 core 的 ③ 后面。
顺带还有第二个毛病：同优先级时退回文件名排序，版面成了文件名的副产品。

现在改成**按字段排序**：先按「标签页 → 二级标签」分桶，桶内再按 priority 升序；
同一份模板内保持声明顺序。并新增**字段级 `priority`**（默认继承模板级），
需要跨模板交织的地方由字段自己声明。

- `auth.ownerPreset` / `auth.guestPreset` 显式 `150`，`agentPreset` 显式 `190`
  → 会话分区终于排成 ①(100) → ②(150) → ③(190)。
- 同一优先级现在是**正常**的：撞号的两份只要落在不同分区就互不干扰；
  真在同一分区又撞号才回退到文件名。
- 九份模板的 priority 统一重填成**分区内位次**：`100 / 200 / 300` 就是该分区第 1/2/3 位，
  不同分区复用同一个号（核心 / vision / webSearch 都是 100）。
  以后加内容只看自己那个分区，不必去全局序列里找空档，也就不会插个号把别人的顺序顶乱。
- 不写 priority 的模板默认 `1000`，落在全部内置之后（原来是 500，正好撞上 webSearch）。

顺带检查了其余分区，顺序都是对的（`access` 核心→auth、`vision` 识图→历史→生图、
`retrieval` 联网→图片反搜→moli、`flow` 产物→授权）。

测试：`test-config` 从 44 项加到 **50 项**，新增「会话分区跨模板交织」「①②③ 与标签序号一致」
「不同分区可同优先级」「同分区同优先级回退文件名」等断言。

### 修复：适配器完全起不来（`subprocess.spawn` 丢了 `this`）

P3 把适配器监管搬进 `gateway/adapter-supervision.js` 后，`plugin.js` 这样注入：

```js
spawn: subprocess.spawn,        // 裸函数，this 丢失
```

DSH 的 `subprocess.spawn` 是**服务对象上的方法**，内部要读 `this`（选容器模式）。
裸传之后 `this` 变成 `undefined`，一调用就抛
`Cannot read properties of undefined (reading 'selectContainmentMode')`。

后果是灾难性的但很安静：**子进程一个都起不来**，监管层每 30 秒退避重试一次，
日志里只有一行接一行同样的报错，QQ 侧全程无响应——而当时 41 套件全绿。

- 改成 `spawn: subprocess.spawn.bind(subprocess)`，并在这行写明为什么必须 bind。
- **加固三处测试桩**（`test-plugin` / `test-admin` / `test-proactive-round` 里的
  `subprocess`）：让假 `spawn` 也读 `this`，不满足就抛同一条 TypeError。
  原来的桩是完全不碰 `this` 的普通方法，于是「把方法裸传」这种接线错误在测试里根本看不见。
- 验证：撤掉 `.bind` → `test-plugin` 复现出**线上那条一模一样的报错**并判定失败
  （`等待超时：适配器连上假 OneBot`）、`test-proactive-round` 同样变红；恢复 → 41 套件全绿。

> 教训：搬移代码时把「方法引用」当值传出去，`this` 是悄悄丢的，类型检查和测试都拦不住，
> 只有桩**行为上依赖接收者**才测得出。这类桩「太宽松」比桩「没有」更危险。

### 换行符统一回 LF + 加 `.gitattributes`

P3 重构把 13 个文件（`gateway/plugin.js` + 11 个新模块 + `tools/index.js` + `test/test-security.mjs`）
整体写成了 CRLF。后果不是运行期的（Node 不在乎），而是**可维护性**的：`tools/index.js` 那 45 行
真实改动显示成 2247 行 diff，`git blame` 全线断掉，以后任何一次回移或三方合并都会整文件冲突。

- 13 个文件统一转回 LF；`git diff --ignore-cr-at-eol` 为空，即**纯换行符变化、零逻辑改动**。
- 新增 `.gitattributes`（`* text=auto eol=lf`）：比口头约定可靠，编辑器再存一次也翻不了车。

### 修复：`/auth` 授权后回合续不上（P3 2.4 带出来的回归）

`createTurnRuntime` 没把 `runTurn` 从工厂里导出，而插件注入的是
`getRunTurn: () => turnRuntime.runTurn` —— 取到 `undefined`，`auth-flow` 的
`resumeAfterAuth` 一调用就抛 `TypeError`，又被该链末尾的 `.catch` 吞成一行
「授权后续跑失败」。用户侧症状：动态码用掉了、提示也撤回了，但**被拦下的任务再也没继续**，
且没有任何面向用户的报错。

- 工厂补导出 `runTurn`（一个键的事），并在该行写明为什么它必须在这里导出。
- 新增 `test/test-flow-resume.mjs`（17 项）：3a 用真实工厂 + 真实接线取一次 `getRunTurn()`，
  3b 走完 `resumeAfterAuth` 全链（参数/carry-over/resume 清理/不记错），3c 反向把
  `getRunTurn` 退化成 `undefined`，断言这条链会**静默失败**（只 +1 errors、只打一行日志）——
  既证明测试抓得住同类回归，也把失败形状写下来。
- 第 2 节是**接线形状守卫**：读 `plugin.js` 里所有 `turnRuntime.xxx` 取用，逐个核对工厂确实导出了该键。
  这一节才是能提前拦住这类问题的那个——漏一个键不会报错，只会变成 `undefined(...)`。
- 验证：撤回修复 → 3 项红；恢复 → 17/17。全量 41 套件全绿。

### P3 结构重构：四项全部落地

按 #61 的方案与验收口径实施，拆成独立 PR 合并（#65 #66 #67 #69 #70 #71 #72 #73 #74 #75）：

- **2.1 群管理动作收归**：13 个动作收成 `api/group-actions.js` 一张表（动作 → 权限名 / 请求构造），工具侧与 `/` 指令侧共用同一份知识；`permission` 改为必填，缺字段或拼错在加载期报错，而不是等到线上敲那条指令才发现零权限检查直接执行。
- **2.2 二维码一致性**：客户端副本按方案 A 保留，新增 `test/test-qr-consistency.mjs`——把副本抽出来求值，与服务端逐位比对矩阵，副本漂移立即可见。
- **2.3A 默认值逐叶子比对**：比对下沉到叶子级并双向（含 `config.js` 里手写的核心分组）；它守的是「别把默认值硬编码回 schema」，JSON 与 schema 派生保持单源。2.3B（默认值彻底单源）按决策未纳入。
- **2.4 拆插件**：`gateway/plugin.js` 2395 → **812 行**，按阶段拆到 `turn-text` / `model-pick` / `proactive-surface` / `adapter-supervision` / `routes-glue` / `flow-delivery` / `inbound-limits` / `auth-flow` / `artifact-collect` / `vision` / `turn-runtime`，只搬不改、每阶段独立提交独立可运行；`plugin.js` 现在只剩装配、路由接线、闸门区与生命周期。
- **验收口径**：以「行为等价」为准（现有断言一条不改、全绿；对外契约不变），**不设行数目标**，行数只作记录。`MAX_VERSION` 按决策未纳入本次重构。

方案草案（#61 原文）已完成使命，不再入库。

### gateway/plugin.js 第三阶段（五）：回合运行时搬出（P3 2.4）

- `acceptMessage`、`buildPrompt`、`startInterimLoop`、`runTurn`、`extractReply`、`lastTurnReason` 与图片缓存清扫（`cleanupImageCache` / `sweepStaleImages` / `scheduleImageSweep`）搬到 `gateway/turn-runtime.js`（`createTurnRuntime`，只搬不改）；`sendReply` 仍留在插件里（它被别的接线层共用），由工厂注入。
- `plugin.js` 1259 → **812 行**（行数只记录，不设目标）；现在只剩装配、路由接线、闸门区与生命周期。
- `test-plugin` 122/122；本机全量 39/40（唯一失败仍是 Windows 符号链接权限的 `test-imagegen` EPERM）。

### gateway/plugin.js 第三阶段（四）：识图搬出（P3 2.4）

- `describeImages` / `downloadImage` / `askVision` 搬到 `gateway/vision.js`（`createVision`，只搬不改）；`test-security` 的源码形状断言同步指向新文件。
- `plugin.js` 1376 → 1259 行（行数只记录）；`test-plugin` 122/122、`test-security` 55/55 全绿。

### gateway/plugin.js 第三阶段（三）：产物收集搬出（P3 2.4）

- `listFreshFiles` / `runPacker` / `packFlowFiles` / `artifactDirs` 搬到 `gateway/artifact-collect.js`（`createArtifactCollect`，只搬不改）；仍是按 mtime 收会话目录、异步 zip/tar。
- `plugin.js` 1445 → 1379 行（行数只记录）；`test-plugin` 122/122、`test-flow-wiring` 23/23 全绿。

### gateway/plugin.js 第三阶段（二）：授权与流程搬出（P3 2.4）

- 主人私聊提示、动态码校验、`/auth` 与 `/flow` 指令、授权后把被拦回合续上，以及 `writeFlowAuthPatch`，搬到 `gateway/auth-flow.js`（`createAuthFlow`，只搬不改）；状态仍在插件 `state`，判定仍走 valve 的 `flowGate`。
- `plugin.js` 1708 → 1445 行（行数只记录）；`test-plugin` 122/122、`test-flow-auth` 43/43、`test-flow-commands` 49/49 全绿。

### gateway/plugin.js 第三阶段（一）：入站限制搬出（P3 2.4）

- 滑动窗口限流、队列深度、单条长度与限流提示去重搬到 `gateway/inbound-limits.js`（`createInboundLimits`，只搬不改）；窗口表随模块走，配置每次现取。
- `plugin.js` 1747 → 1708 行（行数只记录）；`test-plugin` 122/122、`test-security` 55/55 全绿。

### gateway/plugin.js 第二阶段（三）：适配器 / 路由 / 投递搬出（P3 2.4）

- 适配器监管 → `gateway/adapter-supervision.js`；扫码绑定 + 版本探测 + 路由挂载 → `gateway/routes-glue.js`；流程产物投递 → `gateway/flow-delivery.js`。全部依赖注入、只搬不改，运行状态仍在插件 `state`。
- 连同前两块，`plugin.js` 2291 → 1746 行（行数只记录）；`test-plugin` 122/122、三个协议适配器自测、`test-flow-wiring` 23/23 全绿。

### gateway/plugin.js 第二阶段（一）：主动发言表面层搬出（P3 2.4）

- `gateway/plugin.js` 的主动发言表面层（配置读取、排程、群级状态、tick 编排）搬到 `gateway/proactive-surface.js`（`createProactiveSurface`，依赖注入、只搬不改）；判定与提示词仍在 `session/proactive.js`。
- `plugin.js` 2291 → 2025 行（行数只记录）；行为不变：`test-proactive` 84/84、`test-proactive-round` 35/35、`test-plugin` 122/122。

### gateway/plugin.js 第一阶段：无状态块搬出（P3 2.4，只搬不改）

- `buildPersonaHint` / `dropConfigPaths` / `sanitizeDisplayName` / `summarizeTurnReason` / `idValue` 搬到 `lib/gateway/turn-text.js`；`/model` 的路由与指令搬到 `lib/gateway/model-pick.js`（依赖由插件注入，不持有全局状态）。
- 行为不变：现有断言一条不改全绿（`plugin.js` 2395 → 2291 行，行数只作参考，不设目标）；套件/项数不变：40 / 1510。

### 一致性测试：二维码副本 + 默认值叶子级（P3 2.2 / 2.3A）

- 新增 `test-qr-consistency.mjs`：把客户端 `QR_BUNDLE` 区块抽出来求值，与服务端 `lib/tools/qr.js` 对 11 组输入逐位比对版本/掩码/矩阵；删客户端副本任意关键行 → 测试变红（已实测）。
- `test-config` 的默认值比对下沉到**叶子级并覆盖核心分组**：`DEFAULTS` 与 `new Config({})` 双向逐叶子比对，嵌套与「只改 schema 一边」都能抓到（已实测）。
- `DEVELOPMENT` 补「新增配置项时改哪几处」清单；套件 39 → 40，总项 1503 → 1510。

### 群管理动作表收归（P3 2.1）

- 13 个群管理动作原来在四处各写一遍（工具描述、TOOL_PERMISSION、plans、指令映射）。新增 `lib/api/group-actions.js`：动作 → 权限名 / OneBot 请求构造只写这一份，工具与 `/` 指令都从表里取。
- `permission` 改成必填，缺字段或拼错在加载期报错；以前 `needed !== undefined &&` 让「加了动作忘加权限」静默变成零权限检查（现有 13 个动作都齐，所以没暴露）。
- 指令侧的权限名也从同一张表派生，不再手写第二份。
- 测试：新增 `test-group-actions.mjs`（27 项）；套件 38 → 39，总项 1476 → 1503。

四路子代理逐行审了 **2.6 万行代码里的注释**（transport 5077 / gateway+tools+api 6514 /
client+valve+session 6824 / test 9766），交上来 52 条毒注释 + 13 条无效注释 + 17 条存疑，
52 条毒注释与 13 条无效注释逐条回代码交叉验证，**零误报**，本次全部修掉。
17 条存疑里 3 条是测试缺陷（已修），其余 14 条是行为问题或依赖外部事实，**未纳入本次改动**。
审查顺带挖出四处真实缺陷（三处在产品代码、一处在测试），已一并修掉。
版本号仍是 0.12.7（等实际发布再标）。

### 1. 真缺陷（审注释审出来的 bug，不是注释本身）

| 问题 | 不修的后果 | 修法 |
| --- | --- | --- |
| `/model` 在**群聊里必崩**：`ADMIN_USAGE` 列了它（所以 `/help` 说有这么条指令），但 `COMMAND_ARITY` / `COMMAND_PERMISSION` 都没有 `model`，`arity[0]` 抛 `TypeError`，被 `acceptMessage(...).catch()` 吞成一行日志 | 用户在群里敲 `/model` **一条回复都收不到**，而 `/help` 明明列着它；`/model` 本该由下面那个带拥有者校验的专门处理器接管，却永远走不到 | 新增 `DELEGATED_VERBS`（`model` 不由指令层执行，直接 `return false` 让调用方继续）；另加 `assertCommandTables()` 在**挂载期**校验「`/help` 里每条指令都有 arity + permission」，同类漏项以后加载就炸，不会等线上有人敲 |
| `qqbot send` 的本地图片白名单**只做字符串前缀比较**，没解符号链接 | `qq-images/x.png -> /etc/passwd` 的路径字符串完全在白名单里，`readFileSync` 顺着链接读到目标，再把内容 base64 发进 QQ 会话——与 2026-10-28 在 `qq_imgsearch` 修掉的是同一个洞，这边还开着 | 抽出 `resolveSendImagePath()`：先 `realpathSync` 再比前缀，且**判定与读取用同一个返回值**；顺手把注释里那句「与 qq_imgsearch 同一套白名单语义」（当时是假的）改成真的 |
| OneBot 11 的 **CQ 字符串**消息路径不给 `mentions`（段数组路径给） | 插件拿不到 `mentions` 就退回「正文里出现 `@机器人QQ` 就算点名」的正则兜底——用户手打一串 @ 就能过 `requireAt`。只在 `post_format: string` 时触发，正好是 A1 那条修复漏掉的一半 | `normalizeMessage()` 的字符串分支用 `[CQ:at,qq=...]` 抽出 `mentions`，与段数组路径的 `atQqsOf` 同一口径（`all` 原样保留） |
| 测试里一条**恒真断言**：`check('群聊不支持流式（明确拒绝）', true)` | 这条从来没测过任何东西，流式帧真漏出来也不会红 | 改成 `frames.every((f) => f.type !== 'stream')` |

### 2. 注释修正（挑危害最大的几条）

- **`valve/tool/gate-guard.js` 的 JSDoc 把闸门窗口默认值写成 0**，代码是 1，而紧邻的注释专门论证 ±1 是故意的（窗口 0 会让人工填码在步长边界失败）。谁信 JSDoc 去「修回去」，就正好造出它警告的那个故障——这是整轮最危险的一条。
- `valve/network/policy.js` 说「所有出网动作都必须经过本模块」：`api/update-check.js` 等少数固定目标直接走全局 `fetch`。改成说清「本模块是判定的唯一来源，但不是唯一出口」。
- `gateway/route-auth.js` 头部仍教人 `ctx.get('client-connection')` 取鉴权服务——那是**插件名**，服务叫 `connection`，同文件正文早已纠正。照头部写就等于复活「静默降级成只做同源校验」那个 bug。
- `tools/index.js` 说 tools「对本插件是可选的」：`inject` 里已声明，缺了插件根本不挂载，那两条兜底分支是不可达代码。
- `gateway/plugin.js` 的频率提示说「只私聊回」，**下一行注释**自己写着「群里也回一句」。
- `config.js` 的默认值文件名示例（`websearch.json` / `valve/security/auth.json`）都不存在，实际是 `*-conf.json`；照文档建文件会被加载器静默忽略。
- 其余：`imgsearch.js`/`websearch.js` 的 `./http.js`（应为 `../shared/http.js`）、`commands.js` 的 `AUTH_FAIL_TEXT` 位置、`imgsearch.js` 的引擎清单漏 Soutubot、`Tineye` 被说成多步 token 流程（实为单次 POST）、`flow-auth.js` 的「任何拒绝路径都计入失败次数」（实际只有码错才累加）、`owner-settings.js` 的「白名单是唯一来源」（`DENY_PREFIXES` 是独立的第二层）、`settings.js` 的更新提示数据来源指向不存在的 `routes-update.js`，以及一批目录重构后遗留的旧模块名/旧行号。

### 3. 测试

新增 7 条断言（`/model` 委派 + 指令表自洽、CQ 字符串 `mentions` 两条、`qqbot send` 白名单三条），
删掉 1 条逐字重复的断言。全量 **38 套件 / 1464 项通过**，`tsc --noEmit` 无报错。

### 批次 —— 安全加固 + 行为修正 + 文档与死代码清理（2026-10-28）

六路子代理做了一轮对抗性审查（攻防演练 / 边界加固 / 文档审查 / 死代码审查 / 凭据泄露面 /
收归与拆分），提交上来的 20 条逐条交叉验证后**零误报**，按「先 P0 再 P1/P2、结构重构暂不动」
分两批落地。对外契约（包名、`main`/`exports`、配置键名、九个工具名）没变。

### 1. P0：安全边界

| 问题 | 不修的后果 | 修法 |
| --- | --- | --- |
| 内网校验代理在**直连模式**下把「解析不出地址」当成「安全」 | 判定层说「放行」，连接层退回按**主机名**盲连——判定与执行分叉，守卫等于没有 | `assertDialable()`：直连模式解析不出地址就 `policyRejection`（403），`connectTarget` 不再回退主机名；代理模式才交给上游解析并记日志 |
| `webSearch.saucenaoKey` 没标成密钥 | 明文渲染在设置页、明文存进 profile | `Config` 上加 `.role('secret')`，设置页字段改 `kind: password` + `secret: true`（「已设置；留空则保持不变」，一键还原默认跳过） |
| 群内点名判定用 `text.includes('@'+selfId)` | ① 正文里手打 `@机器人QQ` 就算点名，`requireAt` 形同虚设；② `@10001` 是 `@100012` 的前缀，正常 @ 别人会被误判成 @ 了我，`split/join` 剥前缀还会咬掉对方 QQ 号一位 | 适配器在帧里带 `mentions`（五套协议全覆盖），判定改看 `frame.mentions.includes(selfId)`；自定义适配器没给时退化成「@数字 + 数字边界」的保守匹配（宁可漏判不误判） |
| 群白名单判定排在管理指令之后 | 不在白名单的群里发 `/kick` 仍会先走管理指令那条路 | `allowlistOk()` 提到 `handleAdminCommand` 之前 |
| 闸门区只比较 `enabled` + `gatedTools` | 换掉 `totpSecret` 这一步连码都不问；换完之后所有「改名单要码」都变成「用攻击者的码验攻击者的锁」，一次原子保存就能清空名单 | 新增「保护面」比较：`totpSecret` / `recoveryHashes` / `recoverySalt` / `maxAttempts` / `lockoutMinutes` / `grantTtlSeconds` 任一变化都要码，且**必须用变更前那把密钥验**；拒绝时连保护面一起回滚 |
| 闸门码无状态 | 6 位码可以无限试，同一个码能反复用 | 加失败锁定（默认 5 次 / 5 分钟）+ 重放防护（同一 counter 只认一次）。窗口保留 ±1：闸门码是人手工填的，从读到码到点保存常要十几秒，窗口 0 会让「第 29 秒读码、第 31 秒保存」直接失败——暴力风险由锁定承担 |
| 恢复码路径完全不受限 | 谁都能反复提交错的恢复码，把 scrypt（16MB、同步、约 60ms）当免费 CPU 用，同时不断给动态码那条路续锁 | 恢复码用**独立**计数器与短锁定：两条路互不牵连（认证器丢了时恢复码仍是兜底），但各自都被夹住 |

### 2. P1：行为修正

- **QQ 官方协议上流程授权提示从来没发出去过**：`sendPrivateText` 只用 `send_private_msg` 这个 action，
  而官方适配器只支持 `recall` / `delete_msg`，于是永远回「不支持」，错误被吞成空串，
  `requestFlowAuth` 仍回 `{ok:true}`——主人等一条永远不来的码，模型以为「已申请」。改为 action 失败就退到
  `send` 帧（同一个能力，官方协议支持私聊），并让发送失败**真的失败**（`prompt-failed`，同时回滚刚登记的 pending）。
- **`/flow unbind` 永远失败**：`requestAuth(qq, 'unbind')` 不带显式工具名，而 `'unbind'` 既不是受闸工具、
  也不是刚被拦下的工具，一律回 `tool-unknown`——「认证器丢了又没恢复码」这条兜底路径根本走不通。
  改为插件内部给 `explicitTool='unbind'`（不经过模型），取用 grant 时带上同一个名字并**校验结果**
  （以前传 2 个参数必然 `wrong-tool`，返回值还被忽略）。
- **插件 HTTP 路由绕开 DSH 鉴权**：插件用 `webServer.register` 挂的具名路由在鉴权层之前处理
  （实测 `GET /` 回 401、`GET /dsh-qq-bot/settings` 回 200）。新增 `lib/gateway/route-auth.js`：
  过一遍 `client-connection` 的浏览器 cookie 校验（`browserAuth.isAuthenticated`）+ Origin/Referer 同源校验，
  未登录 401；拿不到该服务时降级放行并告警一次（那种环境里 DSH 自己也没鉴权，加一道只会把设置页锁死）。
  顺手补上 `/bind` 状态路由缺的方法校验（以前 `PUT` 也回状态）。
- **`qq_imgsearch` 的本地文件白名单挡不住符号链接**：`qq-images/x.png -> /etc/passwd` 的**路径字符串**
  完全在白名单目录下，`readFile` 却会顺着链接读到目标再上传图床。改为比较前先 `realpath`，失败（不存在/断链）一律不认。

### 3. P2：死代码与文档

- 删 `lib/message/index.js`（`assembleReply` / `ASSEMBLY_STEPS` 生产代码零调用，发送侧自己按同一顺序拼）；
  删 `gateway/index.js` 的死导入与死再导出、`transport` 的 `ADAPTER_FILES` 别名、
  `owner-settings.js` 的空 `DENY_PATHS` 与其死分支、7 个零引用阀门成员
  （`verifyToken` / `verifyRecovery` / `judgeHistory` / `checkOwnerCaller` / `pin` / `__setHooks` / `__hooks` / `decideEdit`）。
  安全阀文件头那句「这四个薄包装只有测试在调」也一并改掉——测试其实也没调。
- 文档纠错：`AI-DISCLOSURE` 的逐套件项数（QQ 官方 95→109、Host 插件 120→146、客户端 107→130、
  配置合并 24→35、内网校验代理 38→53、状态机 35→43、接线 20→23、生图 16→22）与英文段落的
  「19 suites / 774」；补上 7 个从来没进过清单的套件；工具数 8 → 9；
  `README` 的「零 npm 运行时依赖」改成「只有一条运行时依赖」；反向 WS 的 `0.0.0.0:6199`
  补上「必须先配 `onebot.accessToken`，否则强制收回回环」；`DEVELOPMENT` 的发布流程按工作流的真实幂等口径重写；
  `ARCHITECTURE` 的 `DENY_PATHS`（早已是空数组，真正的机制是 `DENY_PREFIXES` + `SPECS` 白名单）与
  `message/index.js` 条目。

### 4. 测试

**38 个套件 / 1476 项**（+51，其中 19 项是同一基线上游新增的 `test-update-check`）：`test-plugin` 132 → 148（点名判定 3 项 + 白名单次序 3 项 + 路由鉴权 9 项）、
`test-gate-guard` 18 → 30（保护面 6 项 / 重放 2 项 / 锁定 3 项 + 契约）、`test-flow-auth` 35 → 43
（显式工具通道 5 项 + 恢复码节流 3 项）、`test-guard-proxy` 47 → 53（直连解析失败必须拒绝）、
`test-imagegen` 16 → 22（符号链接逃逸）、`test-qq-bind` 19 → 20（PUT 405）、
`test-valve-assembly` 31 → 27（删掉随死代码一起消失的 4 项消息组装断言，契约断言改为「已删的薄包装不该再出现」）、
`test-config` 35 → 41（设置页分区顺序 3 项 + `priority` 三条护栏）。

### 5. 实装到本机之后又抓到的两处

纸上推演没问题、装上去才露馅的，记在这里免得下回重踩：

- **路由鉴权取服务取错了名字**：`ctx.get('client-connection')` 永远拿不到——`client-connection`
  是**插件名**，它 `provide` 的服务叫 `connection`（`HostConnectionService` 里 `super(ctx, "connection")`）。
  于是鉴权闸门每次都走进降级分支，日志还写着「这个 DSH 版本没有该服务」——而服务其实在。
  现在两个名字都试，取不到时的告警文案也改成「先看 `ctx.get('connection')` 是否可用」，
  不再把排查引向「版本没有这个服务」。
- **设置页字段顺序是文件名的副产品**：上一轮把 `FIELDS` 从客户端搬进 `-set.json` 时，组装顺序
  直接用了文件路径排序，于是「图片反搜」排在「moli 卡片」前面、moli 从分区收尾跑到中间，
  而 `vision` 也掉到了 `history` / `imageGen` 后面。改个文件名就换一次版面，还没人知道顺序谁定的。
  现在每份模板在头部声明 `priority`（升序，同值按文件路径兜底，不写默认 500），
  顺序成了模板自己的属性：联网 50 → 图片反搜 60 → moli 90 收尾，识图 40 → 历史 70 → 生图 80。
- **模板头补上 `tab` / `subtab`**：一份模板通常只管一个工具、整份都在同一标签页，
  于是把「落在哪一页」也提到文件头，单条字段写了就覆盖（`auth` 横跨「基础·准入」和
  「高级·会话」，仍逐条声明）。9 份内置模板里 7 份收成一行文件头，字段里那 60 多处重复的
  `"tab": "capability"` / `"subtab": "retrieval"` 全部删掉——组装结果与改之前**逐字段完全一致**
  （147 个字段的 path/tab/subtab/group/kind/label 做过快照比对）。
- **密钥字段的「已设置」从灰字变成状态徽章**：以前不管填没填都显示同一行灰字
  「已设置；留空则保持不变」，等于没填也说自己已设置。现在按 DSH 返回的
  `secrets[].set` 区分：填了是绿框绿字的「已设置」，没填是灰框虚线的「未设置」并提示
  「填写并保存后才会生效」。

---

### 批次 —— 设置页字段模板化 + TypeScript 类型检查（2026-10-28）

### 新版本探测：设置页提示（只提示，不自动升级）

- 新增 `lib/api/update-check.js`：服务端拉 npm registry 最新版，比较版本并判断其声明的
  `dsh.compatibility.dsh` 是否包含当前运行时；结果缓存 6 小时，网络/解析失败静默（设置页不出现提示）。
- 设置页顶部横幅：新版本状态随 `GET /dsh-qq-bot/settings` 的模板一起下发（不额外发请求），
  只在「确实更新且兼容」时显示；不兼容也会提示但仍带提示语，不提供一键升级（升级动作留给用户）。
- 开关：设置页「高级 → 会话与排错 → 探测新版本」，默认开；6 小时内最多拉一次 registry。
- 测试：`test-update-check.mjs` 19 项（range 判断、同版本/更旧不提示、不兼容标记、失败静默、缓存与开关、registry 回退、失败缓存 5 分钟）；
  套件 37 → 38，总项 1401 → 1420。
- 稳健性：registry 依次尝试 npmjs → npmmirror；失败只缓存 5 分钟（网络抖动不再让提示盲等 6 小时）。

承接上一轮的「默认值拆到各目录」，这一轮把**设置页字段本身**也搬出客户端 bundle，
并给整个仓库加上类型检查。对外契约（包名、`main`/`exports`、配置键名、九个工具名）没变，
新增一条只读路由 `GET /dsh-qq-bot/settings`。

### 1. 后缀区分两类 JSON：`-conf.json` / `-set.json`

同一套归属、同一个目录、不同后缀：

| 后缀 | 管什么 | 组装成 |
| --- | --- | --- |
| `*-conf.json` | 默认值（上一轮的 `websearch.json` 等全部改名） | `DEFAULTS` |
| `*-set.json` | 设置页字段：显示成什么样 | `SETTINGS_FIELDS` + `SETTINGS_TABS` |

```json
{ "group": "webSearch",
  "fields": [{ "path": ["webSearch", "maxUses"], "label": "每次搜索最多触发次数",
               "kind": "number", "tab": "capability", "subtab": "retrieval" }] }
```

`when` 是**声明式**的（`{ "protocol": "onebot12", "protocols.onebot12.mode": { "$ne": "reverse" } }`），
因为 JSON 放不了函数——22 个原本是闭包的条件全部改写成了数据。

不属于任何工具/阀门的字段在 `lib/settings-core-set.json`（与 `CORE_DEFAULTS` 对称），
标签页骨架在 `lib/settings-page-set.json`。

**客户端变成纯渲染器**：`lib/client/settings.js` 里那个 180 行的 `FIELDS` 数组、
四张分组映射表、以及 `MOLI_ADVANCED_FIELDS` 全部删除，改为加载时 `applyTemplate()` 填充。
加一个字段 = 改对应 `-set.json`，前端一行都不用动，也不用重新打包。

### 2. 三道加载期护栏

写错就在启动时炸掉，不留到运行期：

| 写错什么 | 不拦的后果 | 护栏 |
| --- | --- | --- |
| `path` 指向不存在的配置项 | 字段编辑不到真实配置；`staleConfigPaths` 还会把用户存的值当废弃键删掉 | `schemaHasPath()` 逐段走 `Config.dict` |
| `tab` / `subtab` 写错 | 字段掉进谁也点不到的页 | 与页面骨架比对 |
| `group` 重复 | 两份模板抢同一组 | 按 group 去重 |

两个例外标记：`virtual: true`（纯界面锚点，如扫码绑定，不对应配置项）、
`in: "moli-card"`（渲染在 moli 卡片内部，但保存/还原仍按普通字段处理）。

### 3. TypeScript：JSDoc + `checkJs`，不引入构建

`tsconfig.json` 用 `allowJs` + `checkJs` + `noEmit`：**源码仍是 `.js` / `.mjs`，类型写在 JSDoc 里**，
发布出去的还是原样源码，`engines.node` 仍是 `>=22.6`。

为什么不迁 `.ts`：DSH 是把本插件 import 进它自己的进程跑的，没法给那个进程加
`--experimental-strip-types`；全量迁 `.ts` 要么把 `engines.node` 抬到 `>=23.6`，
要么引入构建步骤——前者挡用户，后者违反「零构建」。

清理 42 条报错，全部是 JSDoc 漏声明或声明与运行时不符，**没有一条指向会坏掉的逻辑**。
期间修掉一个真 bug：`lib/tools/index.js` 的 `classifyMoliFailure` 用了 `describeError`
但只在 `apply(deps)` 里解构过，模块级调用必然 `ReferenceError`（moli 失败路径 100% 崩）。

`npm run typecheck` 已进 CI（Node 22 / 24 双版本都跑）。

### 4. 测试

37 个套件 / 1401 项（+16）：`test-client` 125 → 130（字段断言改到组装后的模板上，
另加一条「bundle 里不再写死字段定义」的迁移护栏）、`test-config` 32 → 35
（新增三条护栏断言：路径写错 / 标签页写错 / 没有后缀的 JSON 被忽略）、
`test-plugin` 124 → 132（新增模板路由段落：200 / 405 / 只回模板不回配置 / 注销）。

### 批次 —— 默认值拆到各目录的 JSON + 设置页三处改进（2026-10-28）

这一轮改的是「默认值住在哪」和设置页的可用性，对外契约（包名、`main`/`exports`、配置键名、九个
工具名、路由路径）没变。

### 工具/阀门的默认值搬进各自目录的同名 JSON

改造前 `lib/config.js` 里有两份默认值：`DEFAULTS` 字面量和 schema 的 `.default(...)`，改一个忘一个
是迟早的事。现在**谁拥有这组配置，默认值就放在谁的目录里**：

| 目录 | 归谁 |
| --- | --- |
| `lib/tools/*-conf.json` | 工具自己的参数（`websearch.js` ↔ `websearch-conf.json`） |
| `lib/valve/<阀门>/*-conf.json` | 阀门自己的参数（如 `valve/security/auth-conf.json`） |

**路径不写死**：`lib/config.js` 在加载时遍历这两个目录，每个 JSON 自己声明管哪个配置组：

```json
{ "group": "webSearch", "defaults": { "maxUses": 5 } }
```

加新工具只需要往目录里丢一个 JSON，不用回来改 `config.js`。文件名只用于报错定位，不参与映射
（`websearch.json` 管的是 `webSearch`，不用逼文件名迁就驼峰）。目前自动发现 8 组、59 个字段：
`vision` / `webSearch` / `imgSearch` / `imageGen` / `moli` / `history` / `auth` / `flowAuth`。

### 配置清洗改成依赖组装结果，并加了两道护栏

`staleConfigPaths`（启动时清理本版本已不存在的字段）本来就是拿 schema 判断「哪些键算废弃」，
现在 schema 的默认值也来自同一批 JSON，三者是一条链：**JSON → DEFAULTS → schema → 清理判定**。

两处容易出事的地方都堵上了：

- **group 写错一个字母**（`webSerach`）会让这组默认值变成 schema 不认识的键，而清理逻辑恰恰把
  schema 不认识的键当垃圾删——用户配置会被静默清掉。现在加载时就抛错，并指出是哪个文件。
- **重复 group**（两个文件都声明 `vision`）同样在加载时报错，不做「后写覆盖」这种猜测。

`test-config.mjs` 新增 8 项，其中两项是往临时副本里塞坏 JSON，断言它真的炸。

### 设置页：纯数字名单的校验加强

群号 / QQ 号类输入框（群号白名单、私聊白名单、拥有者、高级管理员、可管理群号、主动发言群号）
以前什么字符都能填，填错了要等到消息被静默丢弃才发现。现在：

- 输入时**硬过滤**：非数字、非分隔符的字符根本敲不进去（`123abc456` → `123456`）；
- **逐项校验** 5–12 位，不合规的项当场标红并说明原因，**保存被拦下**（不只是提示）；
- 保存时统一格式化成 `123456, 789012`；只差空格不算改动，不会产生无意义的写入。

判定在客户端做（服务端 schema 保持宽松，避免把历史配置里的异常值变成致命错误）。

### 设置页：一键还原默认（仅本页、不保存）

底栏新增「还原本页默认」：把**当前这一页看得见的字段**改回默认值，只动界面上的草稿，
点「保存」才真正写进配置——所以还原绕不过保存时的动态码校验，也不会出现「点一下按钮配置就变了」。

**密钥类字段一律不碰**。这些框的语义是「已设置；留空则保持不变」，读回来的值里本来就没有密钥；
若把默认值（空串）写进草稿，保存时会被当成「没填新值」跳过——旧密钥原样留着，用户却以为还原过，
这就是假还原。所以干脆跳过它们，并在提示里说清楚跳过了几项。

默认值走插件自己的路由 `GET /dsh-qq-bot/defaults`（与扫码绑定同源）：**只回默认值，不回当前配置**，
默认值是编译期常量、不含任何真实密钥，用户填过的地址与 token 不会出现在响应里。

### `agentPreset` 的默认值改成 `standard`

高级页第 ③ 项（兜底 preset）默认从「空 = 跟随部署默认」改成显式 `standard`。空值选项保留，
想回到部署默认仍然可以选。只影响新会话，①② 两项未动。

### 测试

37 个套件 / 1385 项（+24）：`test-client` 109 → 125（数字名单 6 项、还原默认 9 项，另加渲染桩
对函数组件的支持），`test-config` 24 → 32（自动发现与两道护栏）。

顺带修了客户端测试桩的两个失真：函数组件从不展开（包了一层的列表输入框在树里是空节点，
测不到）、`useRef` 每次渲染返回新对象（列表输入框永远拿不到新值）。

### 批次 —— 网络阀门拆成两个接口 + 门面措辞与分层说明（2026-10-28）

上一轮审查留下的两条「待决策」按主人意见处理：不重构，改措辞、写清楚；同时把网络阀门的对外
接口正式拆成两组。

### 网络阀门只暴露两个接口

以前门面是一大坨平铺成员（15 个），哪些是给插件用的、哪些是内部判定，全靠读注释。现在拆成两组：

- **`traffic`（网络流量管控）**：`fetchText` / `request` / `post` / `createGuardProxy`。所有出网动作
  从这里走，调用方只声明意图（`useProxy` / `timeoutMs` / `binary`），**拿不到代理串**。
- **`proxyStatus`（代理状态，只读）**：只有 `hasProxy` 一个成员。只回答「有没有配 HTTP 代理」，
  不含任何出网能力；插件/工具读它来决定自己的行为（某些搜索/反搜引擎只在走代理时可用），
  而不是自己去嗅探配置或代理串。刻意不再加 `describe()` 之类的便利方法——没人调的方法就是
  下一个「空门面」，要加先想清楚谁用。

策略判定（`isAllowedTarget` `assertHost` `resolve` `pin` `canonicalHost`）与测试注入
（`__setHooks` `uninstall`）不在两个接口内，仍平铺在门面上，并在注释里标明「阀门内部与测试用」。

调用点同步迁移：`qq_webfetch` → `net.traffic.fetchText`，识图引擎可用性 → `net.proxyStatus.hasProxy()`。
新增一条断言锁住接口形状（`traffic` 必须恰好是那四个成员、`proxyStatus` 必须恰好是 `hasProxy`
一个且不是异步出网方法），防止以后又被揉回一个大对象。

### 门面措辞改成实话

`valve/security/index.js` 文件头原写「身份、动态码、授权与审计的**唯一入口**」，但生产代码实际用的是
门面暴露的 `flowAuth` / `flowStore` 对象与 history-auth / owner-settings 的判定函数，那四个便捷方法
（`verifyToken` / `verifyRecovery` / `judgeHistory` / `checkOwnerCaller`）只有测试在调。
现改为「**集中判定处**」，并在文件头写明现状与「真要收成单一入口需要改哪些直接 import」。
`valve/tool/index.js` 同样处理（生产取门面暴露的 `gate` 对象，包装方法只有测试在调）。

### 分层倒置写进文档

新增 `docs/ARCHITECTURE.md` **5.5 已知的分层倒置（有意保留）**，逐条写清四处与分层图相反的
import 方向、为什么保留、真要理顺该怎么做：

- `shared/http.js` → `valve/network/policy.js`（传输层用阀门的纯判定函数）
- `valve/network/index.js` → `shared/http.js`（阀门调传输层发请求，设计本身）
  两条合起来是双向依赖，但不成环（`policy.js` 不回指 `http.js`），运行时无问题
- `transport/adapters/*` → `message/segments.mjs`（段归一只有一份；纯函数，无状态耦合）
- `tools/index.js` → `valve/network/guard-proxy.js`（moli 兜底，属既定例外）

判断标准也写进去了：这些倒置只跨「无状态纯函数」或「明确单向调用」，**没有形成状态环**；
哪天某条开始持有状态或回指上层，就必须当场拆开。

另新增 **5.6 门面的「薄包装」现状**，说明 security / tool 那两个门面的定位是「判定与状态集中在这一层」，
不是「所有调用都必须穿过这些包装方法」。

### 批次 —— 五路对抗性审查后的修正（2026-10-28）

对前两条提交做了五路独立审查（代理归属 / 阀门架构 / 目录完整性 / 测试有效性 / 文档一致性），
交叉认证后修掉以下问题。审查里两份结论被交叉认证推翻，记在这里避免以后重犯：

- 「把 resolver 删掉，37 个套件一个都不会挂」**不成立**：破坏实验实测 `test-valve-assembly` 会红 2 条
  （`currentProxy()` 的断言守住了阀门→传输层的接管链路）。
- 「测试数 1359 偏高 4%」**不成立**：文档 37 行逐项求和正好 1359；本机汇总只有 1161 是因为漏解析了
  三个只打印 `SELF-TEST PASSED` 的适配器套件（19+70+109=198）。

### 用户可见破损（重构漏改的直接后果）

- **11 处**文案还在教用户跑 `node lib/totp-cli.mjs`，文件早已搬到 `lib/valve/security/totp-cli.mjs`，
  照抄必 `MODULE_NOT_FOUND`，且没有 `bin`/npm script 兜底。涉及设置页提示、`qqauth` 工具报错、
  CLI 自身 usage、插件启动日志。已全部改为新路径。
- `lib/transport/bridge/CONTRACT.md`（写新适配器的权威指南）三处路径失效，其中第 97 行给出的
  `import ... from '../bridge/segments.mjs'` 照抄即报错（段归一层在 `lib/message/`）。已修。
- `lib/adapters/`、`lib/bridge/` 两个重构后留下的空目录已删。

### 测试真实性（这次最要紧的一条）

- **假阳性断言**：原「不传代理时按阀门策略走」用「内网目标被拒」当证据，但直连与代理两个分支
  都会 `assertPublicHost` 拒内网，该断言恒真、区分不了路径。改为「死代理 + 公网目标必须连不上代理」
  并断言直连钩子未被命中。
- **补上阀门门面自身的覆盖**：`net.traffic.fetchText` 是 `qq_webfetch` 的唯一出网入口，之前零测试——
  破坏实验证实「让阀门 fetchText 永远直连」时全套件无人报警。现补 3 条（配代理走代理 / 不配直连 /
  `useProxy:false` 强制直连），再跑同样的破坏实验会立刻红。
- **结构性断言的 allowlist 有洞**：原白名单含 `wsCfg`，导致它本要拦的那行
  `const proxy = wsCfg.proxy.trim()` 自己就能过。白名单收窄为「moli / guard-proxy」，
  并另测 `websearch.js`、`imgsearch.js` 整份不得出现代理串（`hasProxy()` 属合法用法，先剔除）。
- 断言改为 `try/finally` 还原阀门状态，避免中途抛错把代理残留给同套件后续断言。

### 契约与架构收口

- **关掉代理逃生舱**：`shared/http.js` 不再接受 `{ proxy: '…' }` 自带代理——代理串只能来自网络阀门
  安装的解析器，否则任何直接 import 传输层的模块都能绕开阀门策略与审计。要自定义代理，用
  `__setProxyResolver` 装桩。
- 修分层倒置：`valve/network/guard-proxy.js` 改为直接依赖 `valve/network/policy.js`（原来绕回
  `shared/http.js` 取判定函数）。
- `assemble.js` 补表自检：stage 重复会抛错、阀门没在 `ASSEMBLY_ORDER` 登记会抛错、
  `tool` 拿不到 `security` 时给可读错误而不是 `TypeError`。
- `qq_webfetch` 的代理串读取移进 moli 分支并改名 `moliUpstream`——非 moli 路径从此在源码层面
  完全不碰代理串；`net` 未注入时给可读报错而不是 `TypeError`。

### 文档与代码对齐

- `docs/ARCHITECTURE.md`：组装优先级表补一段「10/20/30 由 `assembleValves()` 真装配，40/50/60 只登记
  在 `ASSEMBLY_ORDER` 里、由 `gateway/plugin.js` 在 `apply()` 内按同一顺序创建」，不再暗示六层都由
  装配根管；删掉 `message/segments.mjs` 那个并不存在的 `seg` 导出；2.8 传输层补上 `CONTRACT.md` 行。
- `CHANGELOG` 里「12 个函数签名」更正为 **20 个**（`websearch.js` 8 + `imgsearch.js` 12）。
- 批量修掉注释里的旧路径（`lib/compat.js`、`lib/totp.js`、`lib/qr.js`、`lib/bind-routes.js`、
  `lib/bridge/CONTRACT.md` 等），共 11 个文件。

### 仍未处理（需要决策）

- security / tool 门面的便捷方法（`verifyToken`、`judgeHistory`、`checkCaller`、`isGated`…）在生产代码里
  零调用，实际用的是门面暴露的 `.flowAuth` / `.flowStore` / `.gate` 底层对象。门面文件头声称的
  「唯一入口」并不成立。
- `shared/http.js` ↔ `valve/network/` 双向依赖（策略层被 shared 引用、门面又引用 shared）；
  `transport/adapters/*` 反向依赖 `message/segments.mjs`。两处都与文档的分层声明相反。

### 批次 —— 代理收归网络阀门 + 文档收进 docs/（2026-10-28）

### 代理不再由工具自己决定（行为等价，归属改变）

- **问题**：上一轮把「目标能不能出站」的判定收进了网络阀门，但**用不用代理、用哪个代理**
  仍散在调用点——`qq_webfetch` / `qq_imgsearch` / `runWebSearch` 各自从 `webSearch.proxy`
  读一次字符串，再层层往下传。工具因此握有一条绕过出口管控的自由裁量权，且历史上已经
  漂移过（三处调用方三种语义）。
- **现在**：网络阀门在成型时（stage 10）用 `__setProxyResolver` 接管传输层的代理策略，
  `shared/http.js` 不再读配置。工具只声明**意图**：
  - `net.traffic.fetchText(url, { useProxy: true })` —— 走统一策略（配了代理就走，没配就直连）
  - `multiEngineRequest(…, { useProxy: false })` —— 明确要求直连
  - 不传 spec 的老调用 = 按阀门策略走；显式传字符串仍照用（只留给测试与特例）
- 连带收敛：**20 个**函数签名里的 `proxy` 形参全部删除（`websearch.js` 8 个 +
  `imgsearch.js` 12 个），另有 `runWebSearch` 内部不再读 `cfg.proxy`；`qq_imgsearch` 判断「哪些引擎可用」改为问
  `net.proxyStatus.hasProxy()`，不再自己嗅探代理串。
- **保持原样**（按需求）：识图下载与生图结果下载继续走 `publicFetch` 强制直连；
  `moli` 的 `moli.proxy` 覆盖/透传语义不动（那是用户显式配置，不归阀门管）。
- 顺带修依赖方向：`valve/network/guard-proxy.js` 原来从 `shared/http.js` 取判定函数
  （绕一圈 re-export），改为直接依赖 `valve/network/policy.js`——阀门内部不该反向依赖传输层。
- 测试：`test-valve-assembly` 新增 5 条，并加一条结构性断言锁住「工具源码里不再出现代理串」
  （moli 分支例外）。**关键是让断言真的能区分代理路径**：早期版本用「内网目标被拒」来证明
  「走了代理」，但直连与代理两个分支都会拒内网，那种断言永远为真——现在改成「死代理 + 公网
  目标，必须连不上代理」和「阀门 `fetchText` 配代理走代理 / 不配直连 / `useProxy:false` 直连」
  三条真断言。已用破坏实验验证：把解析器改成恒直连、或让阀门 `fetchText` 永远直连，套件立刻红。

### 文档收进 docs/

- 根目录只留 `README.md` 与 `CHANGELOG.md`；`ARCHITECTURE.md`、`DEVELOPMENT.md`、
  `CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`SECURITY.md`、`AI-DISCLOSURE.md` 移入 `docs/`。
- GitHub 对 `docs/` 下的 CONTRIBUTING / CODE_OF_CONDUCT / SECURITY 仍有原生识别，
  这几份的入口不会丢。
- `package.json` 的 `files` 用 `docs` 整目录替代逐份列举；README 与文档间互链同步更新。

### 批次 —— 目录重构：分层 + 三道阀门独立 + 组装优先级（2026-10-28）

纯结构调整，**行为不变**：重构前后 37 个测试套件全绿，插件对外契约（包名、入口路径、
配置 schema、工具名、路由路径）一个都没动。

### 目录按关注点分层

```
lib/
├── index.js        包入口薄壳（只转发，包入口路径是对外契约）
├── assemble.js     组装根（按 STAGE 表把阀门依次成型）
├── config.js       配置 schema
├── valve/          ★ 阀门层（独立、可单测、无插件内部依赖）
│   ├── network/    policy.js 判定 · index.js 门面 · guard-proxy.js 本地校验代理
│   ├── security/   totp · flow-auth · flow-store · history-auth · owner-settings
│   └── tool/       index.js 门面 · gate-guard.js
├── gateway/        plugin.js 主体 · index.js 路由挂载 · routes-bind · commands
├── message/        index.js 组装入口 · chunk · stream · interim · segments · msgid-cache
├── tools/          index.js 注册 · websearch · imgsearch · imagegen · moli · qr
├── session/        manager · model-router · workspace · proactive
├── api/            group-admin · qq-bind
├── transport/      index.js 注册表 · adapters/ · bridge/
├── shared/         http.js 传输机制 · compat.js
└── client/         settings.js 浏览器侧设置区
```

### 五个关注点各自收成一处

- **网关路由**：`gateway/index.js` 的 `ROUTE_MOUNTS` 表统一挂载（等 webServer 就绪、逆序注销、
  不可用静默降级），新增路由只加一条表项。
- **消息组装**：`message/index.js` 固定顺序「中间发言 → 正文分条 → 流式合并」，
  `assembleReply()` 是纯函数，三处各自发送造成的错位不再可能。
- **网络阀门**：判定（`valve/network/policy.js`）与传输（`shared/http.js`）分离——
  前者回答「能不能出站」，后者只负责「怎么出站」。回环地址永不进代理；域名不再被误判成本机。
- **安全阀**：`valve/security/index.js` 把 TOTP / 流程授权 / 历史鉴权 / 拥有者通道收进一个门面，
  红线集中写在文件头，避免「这个入口要码、那个入口不要」的裂缝。
- **工具阀**：`valve/tool/index.js` 只管「这个工具要不要卡、这张卡能不能用」，消费安全阀的
  grant、不持有密钥；改名单与关开关都要码的判定仍在 `gate-guard.js`。

### 组装优先级成型

`valve/index.js` 的 `STAGE` 表：network(10) → security(20) → tool(30) → message(40) →
gateway(50) → transport(60)。`assemble.js` 照着执行，依赖没成型就装配会直接抛错，
不会静默降级成「没有阀门」。启动日志打一行 `装配顺序 10:valve/network → …`，排障先看它。

### 测试与文档

- 新增 `test/test-valve-assembly.mjs`（25 项）：锁住三道阀门的契约字段、装配顺序、
  网络判定口径（编码变体 / 云元数据 / 本机保留名 / 域名不误判）、工具阀的一次性消费语义、
  消息组装顺序、传输层注册表。套件总数 36 → 37。
- `ARCHITECTURE.md` 重写「分层」与「模块清单」（按层列表 + 组装优先级表），
  `DEVELOPMENT.md` 文件清单同步，README 的客户端路径更新。
- `package.json` 的 `exports`：`./client` → `lib/client/settings.js`，
  `./adapter` → `lib/transport/onebot-adapter.mjs`（包名与入口 `lib/index.js` 不变）。

## 0.12.7 —— 稳定性与体验优化（2026-10-28）

### 原装抓取工具 moli_fetch 进默认 gatedTools（一道验证墙，不叠第二道）

- `moli_fetch` 是 dsh-moli 注册的原生工具（能跟随跳转、写文件、eval 页面 JS），我们不改它的
  实现，也不再在入口套一层公网校验/守卫代理——那是我们自己的渲染分支（`qq_webfetch` 的 moli
  路径）负责的事，访客继续用它、安全由内网拒绝 + 守卫代理保证。
- 原装工具只设**一道**墙：默认 `flowAuth.gatedTools` 加上 `moli_fetch`，开关打开后拥有者私聊
  调它要过一次 6 位动态码；没有第二层地址校验，内网地址也由拥有者用自己的码决定要不要抓。
- 名单仍与接管名单同一份（`flowGate.names()`），所以不需要新增任何遮蔽代码：flowAuth 的接管
  块本来就会按名单把 `moli_fetch` 包一层。
- 测试：`test-flow-wiring` 加 3 条断言（没码被拦且不调原工具 / 内网目标同样被拦 / 拿码后原样转交）。


### 守卫代理：判定即钉住地址（DNS rebinding TOCTOU）

- `resolveGuardTarget` 把判定阶段解析出的公网地址一并返回；CONNECT 直连与明文 HTTP 直连都用
  这个 IP 去连，不再让 `net.connect` / `http.request` 按主机名重新解析一次（明文请求保留原
  `Host` 头做虚拟主机路由；上游代理路径不动，目标主机名本来就交给代理侧解析）。
- 起因：0.12.6 的守卫代理是「先 `dns.lookup` 判公网、再按主机名连接」——两次解析之间的空窗里，
  TTL=0 的域名可以先答公网骗过判定、再答 `127.0.0.1` 打进内网，与 0.12.4 在 `publicFetch`
  里封掉的是同一类 TOCTOU。
- 测试：`test-guard-proxy` 加 4 条断言（判定返回钉住的地址 / 一个目标只解析一次 / 解析出内网
  拒绝 / 解析不了保留旧语义）。该套件行数记 38 → 47；实测改动前就是 43（既有漂移），
  多出的 5 与新增的 4 都在 PR 正文里说明，没有在本次一并重算所有套件。

### 设置页：preset 三个字段标注「如果你不知道你在做什么，最好别动这个」

- `agentPresetCustom` / `auth.ownerPreset` / `auth.guestPreset` 的 hint 统一加前缀「如果你不知道你在做什么，最好别动这个」，并写清正确用法：加装了不影响安全的第三方扩展插件、却没进任何 preset 的，在自建 preset
  的 `plugins` 里加插件行、再把 id 填到这里，而不是放宽访客白名单。
- 只改文案：字段位置（高级 → 会话与排错）、默认值、分流优先级都没变。


### 设置页新增「闸门区」：名单改动要一次动态码（填码解锁 → 保存即消费）

- 设置页「高级」拆出第三个二级标签「闸门区」：`flowAuth.gatedTools`（哪些工具必须过动态码）与
  `flowAuth.gateEditCode`（改名单用的 6 位码）放一起，不再和 TOTP 绑定/窗口参数混在流程授权里。
- 行为：动态码开着时名单**默认锁定**；填满 6 位码即解锁编辑，点「保存」才把码一起提交（服务端
  用 `decideGateEdit` 验一次 TOTP，±1 窗口）；保存成功即重新上锁并清空输入框，服务端也会把
  `gateEditCode` 写回空串——码不落盘。**不保存就不写入**；离开设置页，解锁状态与未保存的改动
  一并丢弃（都是组件内 state，没有持久化）。
- **开关本身也要码**：把「流程授权」从开切到关（或反过来）和改名单一样需要一次码——否则拿到浏览器
  的人可以「先关、改名单、再开」，名单保护就白设了；关掉闸门比改名单更狠，不能更容易。
- 服务端兜底：名单或开关变了但码不对（含没码、没配 secret），插件会把两者一起回滚到上一次接受的
  值并清空码字段，日志里写明原因——设置页刷新一下就能看到改动静默回退；不会静默接受。
- 测试：新增 `test-gate-guard.mjs`（18 项：名单比较、关着不需要码、没码/错码/无 secret 拒绝、
  对码接受、±1 窗口容差、开关变更要码、名单没变时顺手清码）；`test-client` 断言高级页三个二级标签并覆盖锁定文案。
- 套件 30 → 31，总项 1204 → 1224。只防「绕闸门的人」：填错码只会让改动弹回去，不额外加确认步骤。


### 回复分条：Markdown 感知切分

- 以前长回答只按换行硬切，会把代码块和 GFM 表格拦腰截断；现在 `lib/chunk.js` 把代码块与表格当原子块搬，
  优先在空行处断开，单行超长才按字符硬切；被强切的代码块在本段补收尾围栏、下一段补回语言标记。
- 实现按本仓库风格重写（纯函数、无第三方依赖、逐条断言），判据是「不把 Markdown 结构切坏」；`sendReply` 换用它。
- 测试：新增 `test-chunk.mjs`（15 项：短文本/长文本/代码块围栏平衡/表格不切行/超长行硬切/未闭合围栏）。
- 套件 31 → 32，总项 1224 → 1239。


### 入站去重（消息幂等）

- 新增 `lib/msgid-cache.js`：按 `message_id` 记最近见过的消息，有界（512 条）+ TTL（10 分钟），
  重复命中不延长窗口；`acceptMessage` 最前面判重，重投事件只计入 `skipped/duplicates`，不再起第二个回合。
- 触发场景：官方 WS 的 resume/重连会重放少量事件、webhook 可能重投；以前会对同一条消息回两次。

### 官方 Bot 扫码绑定（服务端 + 设置页卡片）

- 新增 `lib/qq-bind.js` + `lib/bind-routes.js`：`@tencent-connect/qqbot-connector` **动态 import**（装了就可用，
  没装退回手动填 AppID/AppSecret），走 SDK 的 `startQrConnect` 回调拿二维码 URL 与凭据；凭据经设置服务落盘，
  `appSecret` 只在回调里经过一次、不进任何 HTTP 响应。
- 路由挂在 DSH `webServer` 上（同源）：`GET /dsh-qq-bot/bind`、`POST /dsh-qq-bot/bind/refresh`；
  设置页「连接」里新增「扫码绑定（手机 QQ）」卡片：显示二维码、2 秒轮询状态、可刷新/重新扫码。
- 既有的 qq-official 适配器 **webhook / ws 两条路径都保留**，扫码只是把 AppID/AppSecret 填进去。


### 官方 API v2 富消息：markdown / keyboard / 输入中 / 按钮回传

- `qq-official` 适配器的 `send` 增加三个可选字段：`markdown`（走 msg_type=2，可带 `keyboard` 按钮）、
  `keyboard`（原样透传；只给 keyboard 时正文包成 markdown）、`typing`（msg_type=6 输入中，只尽力而为）。
  被动回复的 `msg_id` / 递增 `msg_seq` 对 markdown 与输入中同样生效。
- `INTERACTION_CREATE` 现在**同时**产出 `notice`（原有行为）与一条 `message` 帧（`sub_type: 'interaction'`，
  `text` 取按钮 `button_data`）——以前用户点按钮只有一条 notice，模型看不见，像石沉大海。
- 测试：`test-adapter-qq-official` 95 → 102 项（markdown/keyboard/msg_seq、msg_type=6、按钮点击回传与身份保留）。
- 套件 34 / 1271 → 1278 项。


### 官方 v2 私聊流式（特有能力，适配层就绪）

- 开放平台只对 C2C 私聊开放 `stream_messages`，所以按**特有能力**做：`qq-official` 适配器新增
  `stream` 命令（`input_mode=replace` + 同一 `msg_seq` + 递增 `index`，结束帧 `input_state=10`；
  首帧后复用平台返回的 `stream_msg_id`）。
- 新增 `lib/stream-bridge.js`：把增量合并成「当前全文」并按 600ms 节流推送，结束时必发 done；
  发送失败只记一行日志并停用该会话，不刷错误。计时器可注入，纯逻辑单测覆盖。
- 接线：`runTurn` 里按 `shouldStream()`（官方 v2 + 开关 + 私聊 + 有 `msg_id`）决定是否走流式；
  中间发言改为喂给桥（不再单独发消息），回合末补足剩余文本并发 done 帧；桥没发出任何帧时
  退化为普通 `sendReply`，保证用户至少拿到一条。开关在设置页「连接 → 私聊流式回复」，默认关。


### 模型选择：自动检测，优先用宿主自己的能力

- 新增 `lib/model-router.js`：按顺序探测 —— ① DSH 原生 `agentDefaultModel`（`currentSelection`/`saveSelection`，可写，
  改的是默认模型）；② DSH `llm`（`listProviders`/`listModels`，只读能列）；③ 都没有就落到**本地**
  per-chat 偏好文件（`QQ_msg/model-prefs.json`），并且如实说明「只记录、不会自动应用」。
- 新增拥有者指令 `/model`：查看当前模型/接口来源/provider 列表；`/model set <provider> <model>`；
  `/model models <provider>`。写不进去时不假装成功：返回 applied=false 并说明原因。
- 端到端模拟：`test-plugin` 新增两条场景——同一 `message_id` 重投只回一次；群里 `@机器人 /model`
  被截获、不进模型回合。
- 解析器 `parseModelCommand` 统一剥掉群里 @ 前缀与前后空格——第一版在群里被 @ 时文本是
  `"@123456  /model"`，`startsWith('/model')` 直接漏判、指令进了模型回合（已修）。
- `/help` 里补上 `/model` 一行。测试：`test-model-router.mjs` 17 项；套件 35 → 36，总项 1296 → 1313。


### 测试卫生：失败重试一次并显式标注

- `test/run-all.mjs`：任何套件第一次失败会**自动重试一次**；重试通过标注「（重试通过）」，
  连续两次失败才算失败。会起子进程/真实定时器的套件（adapter/plugin/admin/proactive-round）
  不再因为一次机器抖动把整条 CI 判红，也不会静默吞掉失败。
- 顺手把 runner 头部过时的「30 个套件」改成不写死数量。

## 0.12.6 —— 渲染抓取支持 JS 页面，安全与稳定性收口（2026-10-28）

> 主语料来自四条并行的只读复审（网络与外部输入 / 权限与凭据 / 并发与资源 / 死代码），
> 每条都回到代码里复核过之后才动手改。

### Moli 内网防护与渲染频率闸

- 新增 `lib/guard-proxy.js`：本地校验代理，只监听 `127.0.0.1`。moli 的全部 HTTP(S)/WebSocket
  流量（主文档、3xx 重定向、页面子资源、页面 JS 发起的 fetch）都经它出站，每条请求先过
  `guardTargetAllowed`——回环、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`（云元数据）、
  `100.64/10`、IPv6 `fe80/fc00/ff00`、内嵌 IPv4、`2002::/16`、Teredo `2001::/32` 一律 403。
  以前只在入口校验一次，页面自己跳去内网就没有第二道闸。用户配的代理作为它的上游。
  判定语义是「**确定是内网才拒**」：本机解析不了的域名放行、交给上游代理解析
  （收紧会误杀只有代理侧能解析的 CDN 域名，整页子资源被打掉）。
- 新增 `moli.rateLimitPerMin`（默认 5，`0` = 不限）：每个会话每分钟最多渲染几次。
  一次渲染要起一个无头浏览器，群里刷屏就是实打实的内存与 CPU 开销；普通抓取不受这条限制。
- 两项都在设置页 Moli 卡片的「高级设置」里，`moli.guardProxy` 默认开。
- **群聊访客已放开渲染**：`moliAllowed` 从「只认拥有者私聊」改成「拥有者私聊 或 QQ 会话里的访客（前提 `moli.guardProxy` 开着）」。关掉内网防护时访客立刻退回普通抓取；非 QQ 会话（Web UI / 任务板 / 子代理）仍不放行——模型循环里反复触发渲染比群成员手动点一下危险得多。
- 新增测试套件 `test-guard-proxy.mjs`（初版 18 项只测拒绝路径；判别力问题在下一节一并重写）。

### 四路审计之后的修复：假成功、并发闸、守卫语义

> 三条并行的只读审计（安全 / 正确性 / 测试与文档）+ 运行态回归，交叉验证后逐条落地。

- **修掉「假成功」**：moli 现在带 `--fail-with-body` 跑，目标或守卫回 4xx/5xx 时退出码 22，
  不再把守卫的 403 页当成页面正文交给模型（以前群里会把 `guard-proxy: blocked by ...` 当内容复述）。
  失败分四类文案：被内网防护拦下 / 上游代理不可达 / 目标 4xx-5xx / 没拿到内容。
- **守卫代理区分 403 与 502**：策略拒绝（确定是内网）回 403，连接类失败（上游拒绝、目标连不上、
  超时）回 502。以前两者响应体一字不差，moli、模型、日志三方都把「网络不通」读成「被安全闸拦了」，
  排查时会去关内网防护（安全降级）而不是查网络。
- **新增 `moli.allowGuest`**（默认开）：访客（群聊 / 别人的私聊）能不能触发渲染的独立开关，
  与「内网防护」互不替代——前者管给不给用，后者管用的时候有没有第二道闸。
- **新增 `moli.maxConcurrentRenders`**（默认 2）：跨会话的全局并发闸。每会话 5 次/分钟的闸挡不住
  「十个群各来一次」，而单次渲染实测峰值约 47 MB 常驻；超出的请求直接返回忙，不排队
  （排队会把等待时间算进 moli 自己的 `-t`，反而更容易超时）。
- **修 Teredo 判定取错字段**：客户端地址在最后两组（`g[6]`/`g[7]`），不是 `g[2]`（那是 Teredo
  服务器地址）；`2001:0:4136:e378:0:9cbf:80ff:fffe`（客户端 127.0.0.1）以前会被放行。
- **修直连分支的 30 秒空闲超时**：建连成功后没清 `socket.setTimeout`，静置 30 秒的隧道会被自己掐断
  （keep-alive 池、SSE、长时间无帧的 wss 都受影响）；上游分支本来清了，直连分支漏了。
- **修 `ensureGuardProxy` 并发重复建代理**：两个会话同时首渲染时各自看到实例为空、各起一个，
  后落定的覆盖模块变量、前一个连同监听端口一起泄漏；现在共享同一个启动中的 Promise。
- **CONNECT 目标归一**：`127.0.0.1.`（尾部点）以前骗过 `net.isIP`、被当「域名」解析后放行；
  `user@127.0.0.1:80`（userinfo）与 `127.0.0.1:80:90`（多冒号）以前整串交给 DNS/上游去猜。
  现在在 `parseHostPort` 里就先归一与拒绝——判定看的就是实际要连的那个名字。
- **守卫代理 `start()` 并发返回 0**：第二个并发调用看到 `server` 非空就直接返回 `boundPort`（此刻仍是 0），
  调用方拿 0 去连等于静默不工作；现在共享同一次 listen。
- **明文分支两端互相收尸**：浏览器中途断开时对目标的请求没被停掉，目标端报错时 `res` 会挂到超时。
- **不拖住进程退出**：守卫代理的 server 加 `unref()`，卸载或宿主收尾时不必依赖有人调 `stop()`。
- **socks5 上游不再静默降级**：只支持 `http://host:port`；配了认不出的代理会在日志里明说「本次改为直连」，
  而不是让人以为流量走了代理。
- **重写 `test-guard-proxy.mjs`（38 项）**：旧版只看状态码，而守卫把连接失败也回 403——
  把 `guardTargetAllowed` 改成「一律放行」后大部分用例照样绿，通过的理由根本不是策略拒绝。
  现在每个拒绝用例都配一个本地监听器数 accept，真的连过去就必红；另补上游代理链路（假上游 200/403）、
  403 与 502 的响应体断言。同一变异体现在 38 项里红 21 项。
- 测试总数：30 个套件 / **1197 项通过**。

### 安全与健壮性（第二轮：本轮落地）

- SSRF 补齐 6to4（`2002::/16`）与 Teredo（`2001::/32`）：这两种地址把 IPv4 编进第 2、3 组，
  `2002:7f00:1::` 就是 127.0.0.1；以前不拆开判，访客可以拿字面量绕过 `isNonPublicIp`。
- 代理隧道手拼报文前校验请求头不含 CR/LF：头值里一个换行就能凭空插一条头甚至插进请求体区，
  直连走 node:http 有内建校验，隧道这条路径没有。
- `qq_imgsearch` 的本地文件白名单加「当前会话」维度：以前只判「在 qq-images 之下」，
  而它是访客可用工具——一个群的成员能让 bot 把别的群/别人的私聊刚落的图上传图床并反搜。
  共用的 `qq-images/gen`（qq_draw 产物）单独放行。
- 生图响应体加 4MB 硬上限（`content-length` 预检 + 流式累计），超限直接判失败。
  以前 `await res.text()` 没有任何上限，`qq_draw` 又是模型可直接调的工具。
- 拥有者改设置的确认码改用 `crypto.randomBytes`：以前默认 `Math.random()`，V8 的
  xorshift128+ 在拿到少量输出后状态可还原，40 位「伪随机」等于把这一步打回猜数字。
- `qq_draw` 支持取消：`generateImage` 接受 `opts.signal`（与内部超时 `AbortSignal.any` 合流），
  工具把 `exec.signal` 传下去。以前一次生图要等满「180s × 4 次重试 + 轮询」，中途无法打断。

### 适配器

- OneBot 11 正向 WS 增加半开检测：心跳以前只发 `get_status`、从不看回执，对端静默掉线
  （不发明 FIN/RST）时 `close` 永远不触发，适配器会一直自报 connected。现在记「最后入站时间」，
  超过 3 个心跳周期没有任何数据就主动断开，交给现成的退避重连。
- Satori 连续 3 次 PING 收不到 PONG 以前只打一条 warn，链路既不会自己好也不会被换掉；
  现在直接断开重连。

### 文案与清理

- 设置页写明 `admin.allowConsole` 放行的是「一切非 QQ 会话」，模型驱动的子代理、任务板、
  工作流同样算在内；群/私聊白名单补一句「清空不等于谁都不许」。
- 删掉 `flowStore.save` / `verify`（零生产调用）：流程脚本由主人自己放进目录，
  插件既不写入也不执行；`test-flow-store` 改成直接落盘造 fixture，22 → 17 项。
- 删掉 `probeMoli` 里前端一处都不读的 `pluginKnown` / `engineConfiguredPath`；
  `DENY_PATHS` 的四项 `auth.*` 已被 `auth.` 前缀整段覆盖，清空避免「看起来有两道闸」；
  `qq_webfetch` 两条分支重复的截断逻辑收成一个函数。
- 全套 **29/29 套件 / 1154 项通过**。

### 安全

- `http.js` 的 `dechunkBuffer` 只接受正数 chunk-size 并强制单向推进：`-24` 会被 `parseInt`
  解成 -24，`pos` 往回退后同一段被反复解析——**同步死循环**，一条 11 字节的畸形响应就能卡死
  整个 DSH 宿主（`qq_webfetch` 默认在访客白名单里，访客可直接触发）。
- `qq_webfetch` 的 Moli 分支当时先收紧成只给拥有者私聊（后续加了内网校验代理与频率闸，已对 QQ 会话放开，见下面「Moli 内网防护与渲染频率闸」）：无头浏览器会跟随
  3xx、加载子资源、跑页面 JS，都不经过 `assertPublicHost` 的逐跳校验；配 `--http-proxy` 时
  入口域名还是代理侧解析的，本地校验的对象和真正建连的对象不是同一个字符串。
- 流程授权的 grant 现在必须绑定「真正要跑的工具」（guard 拦下时记下的工具名，或调用方显式
  给出），空的 `toolName` 一律拒绝。以前 `purpose` 恰好等于工具名才绑定，模型把用途写成
  别的话术就能拿一次授权去跑任意受闸工具。
- 「拥有者私聊」判据改用回合快照（`turnSpeaker.groupId`），不再解析 `entryKey`：
  `perChatSession=false` 时 `entryKey` 恒为 `'shared'`，该配置下高危工具全部放不了行。
- `qq_draw` 增加拥有者校验：以前只判「在 QQ 会话里 + `admin.allowConsole`」，主人一旦把它
  加进 `auth.guestToolAllow`，任何群成员都能烧生图额度并以 bot 身份外发图片。
- `/grant` 不许给自己授权、授出的权限必须自己已经拥有；`/revoke` 需要 `grant` 权限
  （`/grant` 本身就在同一张权限表里，以前是自我提权入口）。
- 适配器凭据（access token / AppSecret / BotSecret）改走环境变量，不再出现在
  `/proc/<pid>/cmdline` 与 `ps` 里；各适配器本来就有同名 env 兜底，命令行仍然优先。
- 恢复码不再被动态码的失败锁定连坐——认证器丢失或时钟漂移时它是唯一的兜底路径。
- `moli.insecureTls` 默认保持 `true`（与 0.12.5 行为一致，代理/网关做 TLS 拦截的网络里开箱可用），
  但设置页的提示写清了关掉之后会发生什么：自签名证书、中间人拦截、CRL 取不到都会让渲染抓取失败，
  而开着时中间人可以替换页面内容——两种代价都摆在用户面前，由他决定。

### 可用性与资源

- 换连接配置时等旧适配器真的退出再启动新的。以前只隔 250ms，旧进程还在 `graceMs` 里：
  forward 模式两个客户端同时在线（重复回合），reverse 模式新进程 `EADDRINUSE` 后进程存活
  但永远连不上——机器人永久离线，只能手动 reload。旧进程迟到的退出也不再覆盖新进程的
  `connected` 状态；适配器退出时立即结算在途动作，`qq_history`/`qqgroup` 不再干等 12 秒。
- `writeToAdapter` 返回真实写入结果。以前恒 `true`：管道已满或已销毁时 `proactive` 照记账、
  `qq_draw` 报 `sent:true`、`qqbot send` 报 `ok:true`，消息静默丢失却报告成功。
- 顺序锁 `release` 幂等 + 120 秒超时兜底：异常路径漏释放（`resolveAuthority` 那段 await 没包）
  不会让单个会话永久哑掉——表现是「一个人突然不说话了」。
- 图片缓存三条泄漏路径：识别失败分支返回已落盘路径、无回复分支也执行清理、新增每 6 小时按
  mtime 收尸（覆盖异常/中断的回合与 `qq-images/gen`）。
- 产物打包从 `execFileSync` 改成异步 `spawn`：打包期间不再停住整个 DSH 事件循环
  （Web UI 与其它会话一起卡，最坏 240 秒）。
- 适配器 stdout 缓冲加 1MB 上限（非行式数据不会把宿主撑到 OOM）；`cleanupStaleConfig` 补
  `catch`（以前是 unhandled rejection，Node 默认退出整个宿主）。
- 直连抓取加绝对 deadline（socket timeout 只是空闲超时，对端慢慢滴字节就能无限拖）；
  代理隧道响应头加 64KB 上限（以前收到头为止无上限，且每块都全量拼接）。
- 会话池加上限（200）并按最久未用淘汰；`state.stats` 的 `admin`/`actions`/`notices`/
  `flowBlocked` 重新出现在 `qqbot status` 里。
- 设置页 moli 卡片「高级设置」的五项参数（`exePath`/`proxy`/`defaultTimeoutMs`/`maxChars`/
  `insecureTls`）以前保存不了：保存只遍历顶层字段表，而它们在卡片内部的独立字段集里，
  改完点保存会提示「没有改动」。现在两套合并后再逐项比对。

### 测试

- `test-history` 23 → **20 项**：删掉零调用的 `conversationOf`（`currentConversationOf` 才是现役）。
- `test-flow-auth` / `test-flow-gate` / `test-flow-wiring` 按“授权必须绑定工具”的新语义调整，
  并补断言（绑定后只认那个工具、群会话夹具带上真实 `groupId`）。
- `test-plugin` 的 subprocess mock 透传 `env`（凭据不再进 argv）。
- 全套 **29/29 套件 / 1159 项通过**。

### 死代码清理（四条只读审计 + 交叉验证）

四条并行只读审计报出 79 条，逐条回到代码复核后清理死变量、不可达分支与多余导出，行为零变化：

- 去掉算完就扔的 `ext`/`mime`、`proactive` 返回值里无人读的 `replyish`、`admin` 授权记录里
  只写不读的 `permanent`（「永久」本就由 `expiresAt === null` 表达）、`owner-settings` 的
  `_pending`，以及被上一行完全覆盖的 `return`/`break`。
- `flow-auth` 的 TOTP 与恢复码两条路径各写了一份相同的 toolName 回退，抽成 `grantToolNameOf`。
- 去掉 `dropConfigPaths` / `resolveDocumentsDir` / `ME_TIMEOUT_MS` / `clipMiddle` /
  `MAX_PER_HOUR` / `MAX_PER_DAY` / `DENY_PREFIXES` 的多余 `export`，以及 bridge 的
  `reconnect` / `links` / `size()` 三个零调用接口。
- 修正与实现不符的注释：`flow-store.js` 头部描述着早已移除的「原子写入 / 显式覆盖」能力、
  `guard-proxy.js` 两块错位的文档注释、`websearch.js` 描述已不存在的函数、`imgsearch.js`
  说 tineye/copyseeker「留作后续」（其实已实现）、`config.js` 里会显示在设置页的作者草稿。
- `/flow rm` 撞上目录时返回的 `not-removed` 不在中文对照表里，会把英文原文甩给主人；补上。
- `test-client` 有一条断言误用上一轮快照（等于在验旧状态），改用重渲染后的新树。
- `test-guard-proxy` 38 → **43 项**；全套 **30/30 套件 / 1197 项通过**。

## 0.12.5 —— 非 QQ 会话越权收口 + 代理隧道统一 + 限流计费修正（2026-10-27）

### 入站限流只对真正驱动回合的消息计费（#22 后续）

- `takeTurnSlot` 从消息入口挪到入队前：以前群里的闲聊、图片消息、没点名的消息都会吃掉
  「每人每分钟 20 回合」的额度，活跃群里几十条闲聊之后，真正的 @ 就被静默丢掉
  （群里 `notifyThrottled` 直接 return，连提示都没有，消息等于人间蒸发）。
- 群里的频率提示改成回一句、按会话 60 秒去重：被限流的 @ 至少能看见「发得太快了」。

### WebHook 回调不可鉴别时只绑回环（#33 同类）

- QQ 官方适配器补上和 milky / 反向 WS 相同的兜底：`--allow-unsigned` 打开时回调没有签名、
  `user_id` 直接决定身份，此时 `--listen 0.0.0.0:port` 会强制收回到 `127.0.0.1`。
  （适配器启动本身强制要 secret，所以可达的宽松配置就是 `--allow-unsigned`。）

### 抓取层的类型归一（#13 #22 收尾）

- `publicFetch` 统一返回类型：`binary: true` 给 Buffer，否则给字符串。之前只有真实请求路径做了转换，
  `__setNetworkHooks` 注入的响应把 Buffer 原样透出，调用方得两套判断（测试就踩到了）。

### 代理隧道：三条路径收成一条，且都钉地址、都有上限

- `webSearchPost`（官方搜索）与 `multiEngineRequest`（多引擎）以前各有一份 CONNECT 实现：
  都不解析、不钉公网地址（DNS 重绑可把隧道导去内网），也都不设总超时——官方搜索那条的注释
  还写着"60 秒"，实际一个定时器都没有，代理挂住就永远不回。
- 现在三条路径共用 `proxyRequest()`：`resolvePublicAddresses` 先校验、把钉住的 IP 写进 CONNECT
  目标、SNI 保持原名，连接+读取共用一个 deadline，响应体按 `maxBytes` 截断并回 `truncated`。
  跳转仍由调用方逐跳重算（每一跳重新校验并重新钉地址）。
- 附带修掉测试侧的老问题：隧道场景下 `server.close()` 会被挂住（socket 与 CONNECT 请求都要
  destroy），`test-http` 的代理段现在能干净退出。

### 权限：非 QQ 会话不再是后门

- `qqbot` 工具的 `send` / `interrupt`：没有 QQ 会话（Web UI、任务板、子代理）时以前整段跳过
  拥有者判断，等于任何会话都能往任意群发消息、掐断任意会话的回合。现在与 `qqgroup` 同一条判据：
  默认拒绝，开了 `admin.allowConsole` 才放行；`status` 是只读，照旧可用。
- `qq_draw` 以前没有任何来源判断：Web UI 会话可以让它把图发到任意群/人。现在同样受
  `admin.allowConsole` 约束。
- `qq_history` 的"当前会话"改从回合快照取：`perChatSession=false` 时所有群共用一个 entry，
  以前按可变字段推当前群，跨群读会读错群。
- 流程授权（`flowAuth.gatedTools`）以前只决定"谁要码"，接管哪几个工具是另一份写死的名单：
  把 `subagent` 从配置里删掉，群里照样被拦（配置说了不算）。现在两边共用同一份名单。

### QQ 官方：BotSecret 与 self_id 真的传下去了

- 配置里的 `protocols.qqOfficial.botSecret` 以前只存在设置页：适配器进程收到的是 AppSecret，
  于是只配 BotSecret、正式环境用 BotSecret 校验签名的部署一律回调 401。现在以 `--bot-secret` 传下去
  （缺省回退 AppSecret，老配置行为不变），签名 seed 取 BotSecret，取 token 仍用 AppSecret。
- 新增 `protocols.qqOfficial.selfId`（webhook 模式没有 READY 事件，适配器拿不到自己的 QQ 号，
  @ 判定与自发消息过滤都会失效），以 `--self-id` 传下去。

### 设置页：Moli 引擎检测 + 参数复刻，访客不再直连 moli_fetch

- `moli` 段收成一个开关 + 一张卡片，并补回**参数面**：`exePath` / `proxy` /
  `defaultTimeoutMs` / `maxChars` / `insecureTls`，全部对齐 dsh-moli 1.1.20 的 Config。
  引擎就绪后卡片上出现「高级设置」折叠区，改完保存即生效。
- 检测口径从「插件装没装」改成「**引擎就绪没就绪**」：同时看插件清单与 dsh-moli 自己的设置
  命名空间（`engineState` / `engineVersion`）。dsh-moli 只用来装引擎，装好之后启不启用它都
  不影响本开关——引擎在就能用。
- `qq_webfetch` 的 moli 分支按 dsh-moli 的同一套参数调引擎：`-t` 紧跟 `fetch`（放末尾会被
  `--eval` 之类吞掉）、`--http-proxy`、`--insecure-disable-tls-host-verification`、URL 一律放在
  `--` 之后（v1.1.20 的防 flag 注入修复）、取消兜底 = 引擎超时 + 30 秒、输出按 `maxChars` 头尾省略。
- **访客白名单去掉 `moli_fetch`**：它是 dsh-moli 的原生工具，支持 `writeTo` 任意绝对路径写文件、
  `eval` 页面内执行 JS、`cookieFile`/`profileDir` 读本机 cookie、`proxy`/`insecureTls` 逐次覆盖，
  而且不校验内网地址——放进访客白名单等于把这些能力交给群里任何人。访客的渲染需求由
  `qq_webfetch` 的 moli 分支承担：同样的引擎、同样的参数，但入口只有 `url` / `max_chars`。
- 未装 / 未启用时的引导文案改了口径：dsh-moli 只是「装引擎的工具」，未装时直接给出仓库链接。

### 其它

- 反向 WS 的分片上限只管片数不管字节：63 片 × 每片 8 MB ≈ 500 MB 才判超限。现在累计字节
  超 `MAX_FRAME_BYTES` 立即判超限。
- `workspace.js safeSessionId` 自己拒掉 `.` / `..` / 含 `..` 的 id：识图临时目录在回合结束
  会被递归删除，以前只靠每个调用方记得加前缀。
- 清掉一批死代码：`describeErrorStatic`、`owner-settings.js` 本文件没人调的 `sameValue`、
  `bridge/ws.mjs` 的 `sleep` 导出、`bridge/segments.mjs` 的 `seg` 夹具与 `replyIdOf` 导出、
  `moli.js` 永远进不去的 `insecureTls` 分支、几处没用到的 import。
- `qq_imgsearch` 的 `imgSearch.maxResults` 以前只是设置页上的数字，实际固定按 5 取。

### 测试

- `test-security` 49 → **55 项**：补跳转链的回归（302 到 `169.254.169.254` 必须拒、公网跳转要跟随、
  跳转次数有上限）、请求头显式 `accept-encoding: identity`、`maxBytes` 透传与 `truncated` 标记。
- `test-plugin` 的抓取打桩改走 `http.js` 的 `__setNetworkHooks`：公共抓取已经改成
  node:http + 钉地址（#32），`globalThis.fetch` 打桩拦不住，多引擎搜索与图片反搜四条断言
  一直在跑真实网络（本机表现为"走了 DuckDuckGo 真实结果"或"解析不到地址"直接失败）。
- 新增回归：25 条群闲聊之后 @ 仍然有回复（闲聊不占回合额度）；QQ 官方
  `--allow-unsigned` 时只绑回环；非 QQ 会话调 `qqbot send/interrupt` 与 `qq_draw` 被拒且没有真的发出去；
  跨群撤回被拒（假 OneBot 的 `get_msg` 现在会回答消息属于哪个群，这条以前只能靠纯函数桩测）；
  多引擎首选 `html.duckduckgo.com` 端点确实被请求（打桩主机表漏了它，首选引擎一直被自己屏蔽掉）。
- 测试基建：`test/dsh-tools-link.mjs` 统一给 `@deepseek-ai/dsh-tools` 建临时链接，`test-admin`
  因此第一次跑起工具鉴权段（以前那段永远"跳过"）；"跳过"不再记成通过（`test-plugin` /
  `test-admin` 改成 `[SKIP]` 单列），`run-all` 加了单套件超时、套件清单与 `test/` 目录双向核对；
  `test-flow-wiring` 的汇总行不再恒印 `N/N`；`test-client` 去掉一条恒真断言，换成真的切到反向模式再断言字段跟着换。
- 裸克隆 / CI 下 `test-plugin` 会直接崩（非 QQ 会话来源闸那段没守 `@deepseek-ai/dsh-tools` 缺失，`tool.execute` 打到 `undefined`）：补上守卫并记 `[SKIP]`，`test/dsh-tools-link.mjs` 支持 `DSH_TOOLS_DISABLE=1` 复现裸克隆。
- `test-http` 23 → **30 项**（代理隧道：钉地址、跳转逐跳重算、体积上限、超时）。
- `test-adapter-qq-official` 92 → **95 项**（AppSecret 与 BotSecret 分开时签名取 BotSecret）。
- `test-client` 87 → **107 项**：Moli 卡片断言（收成一张卡、引擎就绪时开关可点、dsh-moli 停用也不影响、
  高级设置折叠区展开/收起五项参数、没装/引擎缺失时开关被禁用、没装时带仓库链接、已就绪时不带）。
- 全套 **29/29 套件 / 1159 项通过**。

## 0.12.4 —— 反向 WS 半开连接回收（验收新发现）

0.12.3 发完后，独立验收又抓到一条可用性问题，这一版只修这一条：反向 WS 对端只发 FIN（不做 WebSocket close 握手）时连接不回收，4 次半关就能占满 4 条并发名额，之后正常客户端全拿 503，而适配器仍自报 `connected:true`、`links:4`。

### 修复

- **半开连接立即回收**：`upgrade` 拿到的 socket 是 `allowHalfOpen`，对端 FIN 只触发 `end`、不触发 `close`，而 `clients.delete` / `onClose` 都挂在 `close` 上——名额于是永不释放（幽灵链路 `ready` 仍为 true，发送会打进半死连接）。补 `socket.on('end')` → `destroy()`，走正常 close 路径回收名额并把 `link.ready` 置 false。
- **回归断言**：`test-adapter-reverse.mjs` 新增第 4 段——4 条裸 TCP 握手后只发 FIN，断言 `links` 归零、新连接仍能 101（未修复时该段实测 2 条 FAIL：`links=4`、新连接被拒）。

## 0.12.3 —— 安全审计修复：SSRF、越权、资源耗尽、默认开放

一轮攻防审计（四路并行：授权/身份、注入/路径、网络/协议端，加我自己一轮）+ 两轮独立验收复测扫出来的，按「能打穿」排序修完：issue **#13–#27** 与验收中新发现的 **#33**，共 16 条。下面按防线分组，所有数字都能在 `test/` 里核到。

### 修复

- **协议帧 chat id 未校验 → 会话目录越界，识图临时目录还会被递归删除**（#17）：外部 id 只放行 `[A-Za-z0-9._-]{1,64}`，其余取 `sha1` 前 12 位（`safeSessionId`）；`sessionWorkdir` 与新增的 `imageCacheDir` 都走它；`rm` 之前再用 `isInside(QQ_msg/qq-images, dir)` 复核一次归属。
- **`qqgroup` 跨群越权**（#23）：动作目标群与说话人群不一致时，权限按**目标群**重算（`resolveTargetAuthority`）。之前默认 `manageGroups`/`group.allow` 为空让 `groupInScope` 对所有群为真，A 群管理员一句话能把 B 群全员禁言、踢人、改名。
- **私聊判定读会被后到消息覆盖的 `entry.groupId`**（#24）：`owner-settings.checkCaller` 与 `qqauth` 的私聊判定改读回合快照 `turnSpeaker.groupId`；`perChatSession=false` 时不再能借群回合冒充私聊。
- **`/recall` 不校验消息归属**（#25）：撤回前用 `get_msg` 核对 `group_id`，不是本群一律拒；`qqgroup` 的 recall 同规则。

### 出站抓取只允许公网（#13 #15 #20 #21 #14）

- **逐跳校验跳转**：`fetchUrlViaProxy` 之前只校验第一跳就 `redirect: 'follow'`，一个 302 就能把请求带到内网。现在统一走 `publicFetch`：每一跳都 `assertPublicHost`、最多 5 跳、响应体 8 MB 上限、显式 `accept-encoding: identity`（防压缩炸弹）。
- **`assertPublicHost` 校验全部 A/AAAA**：以前只取一条解析结果，多记录/rebinding 可绕过。
- **`multiEngineRequest` 直连分支补校验**（#20）：以前只有代理分支调 `assertPublicHost`，`qq_imgsearch` 的 Soutubot 直连分支可打内网。
- **识图下载走 `publicFetch`**（#15）：图片 URL 来自消息里的 CQ 码，以前直接 `fetch` + `arrayBuffer()` 整包读入，一条消息就能打内网或撑爆内存。**这一条曾被分支重建回退**（PR #31 在旧快照上重建时把 `downloadImage` 又改回了裸 `fetch`），已恢复，并加源码级断言锁住——`downloadImage` 是闭包没导出，运行期测不到。配套加了测试用网络钩子 `__setNetworkHooks`（只替换「解析」与「单次请求」，注入的地址照样过 `isNonPublicIp`，测试里另有一条断言锁这一点），因为 `publicFetch` 换成 `node:http` 直连后，测试里「把全局 `fetch` 换成桩」对它不再生效。
- **`qq_draw` 的 `result.url` 同样走 `publicFetch`**（#21）：生图接口返回的 url 也是外部输入。
- **Moli 渲染抓取入口校验**（#14）：先限 scheme、拒以 `-` 开头的 URL、再 `assertPublicHost`；参数前加 `--`；去掉硬编码的 `--insecure-disable-tls-host-verification`（要跳过证书校验得显式加，不默认）。

### 地址判定：先按 URL 归一，再判，且钉死解析结果（#13 #15 #20 #21 #14 的残留绕过）

验收复测发现上面「出站只允许公网」整条防线有一个**共用旁路**：判定拿到的字符串不是网络栈真正会去连的那一个。

- **WHATWG URL 会改写地址写法**：`http://[::ffff:127.0.0.1]/` 的 `hostname` 是 `[::ffff:7f00:1]`（16 组写成十六进制），`http://0177.0.0.1/` 是 `127.0.0.1`（八进制），`http://2130706433/` 也是 `127.0.0.1`（整数写法）。旧 `isNonPublicIp` 只匹配「`::ffff:` 后面紧跟点分 IPv4」这一种形式，于是 `[::ffff:7f00:1]`、`[::ffff:a00:1]`、`[::ffff:c0a8:101]`、`[::ffff:a9fe:a9fe]` 全被判成公网——回环、10/8、192.168/16、云元数据用这一种写法就能重新打回去，`publicFetch` / `multiEngineRequest` / 识图下载 / `qq_draw` / Moli 五条路一起失效。
- **现在只有一条事实来源**：新增 `canonicalHost`，所有地址先过 `new URL('http://' + host + '/')` 归一，再用 `node:net` 的 `isIP` 分类；`isNonPublicIp` 只认归一后的字面量（域名返回 true，交给 DNS 分支），IPv6 按 8 组 16 位整数判段，内嵌 IPv4 的四种形态（映射 `::ffff:0:0/96`、转换 `::ffff:0:0:0/96`、兼容 `::/96`、NAT64 `64:ff9b::/96`）取低 32 位按 IPv4 规则判。
- **解析一次，连的就是解析到的那个地址**：`resolvePublicAddresses` 返回已校验列表，`publicFetch` 把它塞进自定义 `lookup`（`pinnedLookup`）。以前「先 `dns.lookup` 校验、再让 `fetch` 自己再解析一次」是标准 TOCTOU：第一次给公网、第二次给 `127.0.0.1` 就能穿透。
- **`publicFetch` 改用 `node:http`/`node:https` 直连**（不再用全局 `fetch`）：要拿到 `lookup` 钩子只能这样；顺带把响应体改成边读边截（8 MB）、超时覆盖到读完、跳转仍是逐跳校验（最多 5 跳）。
- **`webSearchPost` 直连分支也走 `publicFetch`**：以前对搜索端点用 `fetch` + `resp.json()`，对端塞 gzip 炸弹就整包解压进内存。

### 反向 WS：默认只监听回环 + 帧/缓冲上限（#19 #16）

- **没配 `access_token` 时强制只监听 `127.0.0.1`**（`resolveListenAddress`）：反向端口上的帧能直接冒充任意 QQ 号——身份完全来自 `frame.user_id`。以前默认 `0.0.0.0:6199` + 空 token，等于「任何能连上端口的人 = 拥有者」。要公网监听必须先配 token。
- **单连接缓冲 / 单帧 / 分片数上限**（16 MB / 8 MB / 64 片）：以前可以声明一个巨大帧慢慢灌，把整条链路饿死并吃满内存（`Buffer.concat` 还是 O(n²)）。
- **并发链路上限 4 条**：`linkSet` 以前只加不删、`active()` 按插入序取第一条，先连者能抢走全部出站消息（含别的会话的私聊回复）。
- **token 比较改 `timingSafeEqual`**：空 token 依旧不放行（`tokenEquals('','')` 恒 false）。OneBot 12 适配器原来自己写了一套 `===` 比较（时序侧信道），改回共用 `bearerOrQueryToken`。
- **并发上限改在 101 之前判**：以前先回 `101 Switching Protocols` 再回 `503`，客户端已经以为握手成功，协议上不干净。
### 授权绑定工具 + 提示词层清洗（#18 #26）

- **grant 绑定申请时的工具**：用途恰好是 `flowAuth.gatedTools` 里某个工具名时，grant 记下工具名，`takeGrant` 只允许用同一个工具（以前「申请时写查天气、实际拿去跑 `workflow`」）；自由文本用途仍不绑定。验收复测补了一处 fail-closed：**取用时省略工具名也算不匹配**（以前的 `&& want !== ''` 让「不传工具名」成为绕过绑定的后门）。
- **`reset(qq)` 修复**：原来拿 qq 当 grantId 去 `grants.delete()`，永远删不掉。
- **过期 grant 回收**：`grant()` 时顺手清掉 `expiresAt <= now` 的条目，只申请不使用不会缓慢堆积。
- **`stripInvisible` 全量剥**：改用 `\p{Cf}` + Default_Ignorable 里非 Cf 的段，补上 U+2066–2069（双向隔离符）、U+061C、U+E0020（标签字符）等。以前在这些字符后面写 `/auth 123456` 能绕过拦截，把动态码整条喂进模型与会话历史。验收复测又补了一段：C0/C1 控制符（U+0000–U+0008、U+000E–U+001F、U+007F–U+009F）同样剥——`\u0000` 不是空白、`trim()` 去不掉，`'\u0000/auth 123456'` 一样能绕过；`\t \n \r` 保留不误伤多行文本。
- **身份头清洗**：昵称/群名片进提示词之前去掉 `\r\n[]` 并限长 32 字。访客把群名片改成 `x)]` + 换行 + 伪造身份，就能在上下文头里多出一行身份（工具层仍按 `turnSpeaker` 鉴权，但会误导模型）。

### Milky WebHook 回调口：没配 token 时强制回环 + 读体上限（#33）

独立验收发现 milky 适配器的 WebHook 模式（`--listen 0.0.0.0:6199`）在**没配 `access_token`** 时真的绑在 `0.0.0.0`：局域网内任何人 `POST /event` 都回 200 并被当成协议端事件派发，事件里的 `user_id` 直接决定身份——等于可以冒充任意 QQ 号说话。反向 WS 那条路早有 `resolveListenAddress` 兜底，WebHook 这条漏了。

- **复用 `resolveListenAddress`**：没 token 一律收回 `127.0.0.1`，日志明说「要公网监听请先配置 token」；
- **回调体 1 MiB 上限**：超限停止缓存并回 413（以前 `chunks.push` 无计数、无上限，一个不认识的客户端就能把内存灌满）。

### 默认准入改 fail-closed：没配拥有者就不驱动会话（#27）

市场维护者合并条目时指出：出厂 `auth.owners` / `private.allow` / `group.allow` 都是空数组，而代码把「空」当作「不额外限制」，于是装好即对外开放——任何人私聊或在群里 @ 一下就能驱动一个会话，消耗拥有者的模型额度，并把插件当成抓网页/打内网的跳板（当时 #13/#20 那两条 SSRF 还没修，风险叠加）。

- **`auth.owners` 为空 = 不驱动任何会话**：`acceptMessage` 在准入最前面判一次，为空就计入 `skipped` + 日志一行 warn（只 warn 一次），私聊回一句「还没配置拥有者……请到设置里填」；群里不回，不在群里刷配置指引。
- **语义不变的部分**：`private.allow` / `group.allow` 为空仍表示「不额外限制」，填了 owners 就能直接私聊/群聊使用，不需要再配白名单。
- **文档同步**：README 的「第一次装好必须先填 `auth.owners`」、配置表 `auth.owners` 行、设置页 hint 都改成「必填，留空不驱动会话」。
### 资源耗尽面：入站限流、队列深度、单条长度、回调重放（#22）

这一组同属「体积/频率」缺口，单看都不致命，叠起来就是「一条消息一个完整 LLM 回合」的成本面：访客默认能用抓取/搜索工具，闸门只看工具名不看频率；`entry.queue` 没有深度上限；消息正文不截断就拼进提示词。

- **入站限流**：新增 `limits.perMinute`（默认 20），按「会话 + 用户」滑动 60 秒窗口计数；超限只回一句「发得太快」提示（私聊才回，同一人一分钟最多提示一次，群里不刷屏），**不进 Agent**。
- **队列深度上限**：新增 `limits.queueMax`（默认 5），同一会话排队回合超限直接拒收，不让消息无限堆在内存里。
- **单条长度上限**：新增 `limits.maxChars`（默认 4000），超长正文截断并注明「原文 N 字，只处理前 M 字」。
- **QQ 官方 Webhook 回调重放**：签名只覆盖 `timestamp + body`，本身不保证新鲜度——抓到一条合法回调就能无限重放。现在①`X-Signature-Timestamp` 必须落在 ±5 分钟内（超出回 401），②事件 `id` 去重（重投仍回 ACK `{"op":12}`，但不重复派发）。
- 出站体积上限与 milky 回调体上限：上一轮 `publicFetch` 已做 8 MB + `identity`，本轮 milky 加 1 MiB。
### 测试

- 新增 `test/test-security.mjs`（**49 项**）：id 净化、越界复核、跨群重算、私聊快照、撤回绑群，加上出站公网判定与 F1 回归（`[::ffff:7f00:1]`、八进制/十六进制/短写/整数写法、`pinnedLookup` 只返回已校验地址、测试网络钩子不能绕过判定、识图下载必须走 `publicFetch` 的源码级断言）。
- `test/test-http.mjs`（**23 项**）：补 `canonicalHost` 归一结果断言，锁住「判定必须建立在 URL 归一后的写法上」。
- `test/mock-onebot.mjs` 的 `get_msg` 补 `group_id` 与 `retcode`，与真 NapCat 的返回对齐（之前假协议端不返回这两项，撤回校验测不出来）。
- 全套 **29 个套件 / 1087 项通过**（`test-plugin` 98、`test-adapter-milky` 83、`test-adapter-qq-official` 91 含回调重放断言、`test-security` 49、`test-http` 23；本表数字是裸克隆跑 `npm test` 的输出，装了 `@deepseek-ai/dsh-tools` 的环境里 `test-plugin` 会多跑工具注册段落）。
## 0.12.2 —— 修好「网页端加载失败」与「设置面板空白」

0.12.1 把包名改成 `@sputnikzaychik/dsh-qq-bot` 之后，插件里有两处身份还写死着旧名字，
装上就会表现为网页端不可用：

- 打开网页直接报 `Failed to load plugins … could not load "@sputnikzaychik/dsh-qq-bot"`；
- 即使能打开，插件详情页的配置区也是空白，设置项一个都看不到。

原因是 DSH 有两套身份：**客户端模块行**和**配置区插槽**都按 npm 包名派发，
而**设置命名空间**按 profile 条目 id 派发。插件把前两者也写成了条目 id，改名后就对不上。

### 修复

- `lib/client.js`：`__ModuleLoader__.load({ id })` 改用包名（原来写死 `'dsh-qq-bot'`）。
- `lib/client.js`：`plugins.bundle.config` 插槽的 key 改用包名（插件管理页按 `pkg.name` 渲染配置区）。
- 设置命名空间 `NS` 保持 `'dsh-qq-bot'` 不变——**升级不需要重填配置**，白名单、密钥、绑定都在。
- `lib/index.js`：清理已废弃配置字段时，同时认新包名与条目 id（`SELF_IDS` 精确匹配；
  刻意不用后缀正则，避免误伤 `my-qq-bot` 这类别的插件）。
- 测试：`test-client.mjs` 的包名原先写死成 `dsh-qq-bot`，改名后那条断言假通过；
  现在从 `package.json` 读，改名就会立刻失败。

### 兼容

装过 0.12.0 / 0.12.1 的，直接升到 0.12.2 即可；功能内容与 0.12.1 相同，这一版只修客户端加载。

## 0.12.1 —— 与 0.12.0 同一批内容，外加发布链路与文档的补齐

0.12.0 在清理 registry 残留时被 unpublish 过，npm 的政策是「用过的版本号永不复用」，
所以 0.12.x 的首个发布版本是 0.12.1。**功能内容与下面 0.12.0 两节完全一致，代码没有改动**；
这一版单独记的是发布链路和文档——它们属于这一批改动的一部分，不能只留在 PR 里。

### 发布链路

- **`release.yml` 补 `actions/setup-node`（node 24）**：runner 镜像自带的 npm 10.9.9 不认 OIDC，
  `npm publish --provenance` 在发起 OIDC 交换之前就报 `ENEEDAUTH`——这跟 `id-token: write` 无关，
  Trusted Publishing 要求 npm ≥ 11.5.1。补上之后本版首次以 OIDC 身份发布成功（npm 上发布者显示为
  GitHub Actions，provenance 进了 sigstore transparency log）。
- **新版本会先有元数据、后有 tarball**：publish 返回成功后 registry 上立刻能查到版本号，但 tarball
  仍 404 约 4 分钟（`npm notice Your package is being processed`），期间 `npm pack` / `npm install` 会 404。
  不是失败，等即可——别据此重发一个版本号。

### 文档

- README：当前版本 0.11.x → 0.12.x；两处「一键全量（27 套件）」→ 28；CHANGELOG 范围 → 0.12.1。
- ARCHITECTURE：标题版本、`tools.js` 8 → 9 个工具（补 `qqauth`）、套件数 27 → 28；新增 §3.6
  「编排工具闸门与产物投递」数据流（同名接管 → 私聊动态码落成 grant → 一次消费 → 按会话目录打包回传）；
  设计取舍补 5 行（同名接管 / 一次性授权 + 30 秒窗口 / 回合身份快照 / 产物按会话目录 / 中间发言顺序）。
- AI-DISCLOSURE：已验证工具补 `qqauth`（9 个）；配置合并项数 23 → 24。
- 去掉 README 与 AI-DISCLOSURE 的「1018 项」总项数：它与逐套件列表之和（1013）对不上，且随可选 peer
  是否存在而变化；改为只报套件数，逐项数留在各自那一行（那部分本机可核）。
- `ci.yml` 注释：26 个套件 → 28，补 `flow-wiring` / `interim`。

## 0.12.0 —— 私聊动态码授权（流程授权）与产物投递

一句话：可选的一把锁。打开后，子代理 / 队友 / 工作流这类「能自己干活」的工具，先要主人在私聊里回一条 6 位动态码，
才放行**一次**调用；这一轮跑完，把会话目录里新增的文件打包送回。默认关，关着的时候行为与 0.11 完全一样。

### 新增（全部可选）

- `flowAuth.enabled`（默认 **false**）：总开关。关着时既不接管编排工具，也不拦截 `/auth`、`/flow` 消息。
- `flowAuth.totpSecret`：标准 TOTP（RFC 6238，HMAC-SHA1 / 30 秒 / 6 位）。密钥在设置页「高级 → 流程授权 → 绑定二维码」就地生成、只展示一次，用任意认证器 App 扫码绑定；**密钥不经 QQ**，也不写日志。也可以跑 `node lib/totp-cli.mjs enroll` 在终端生成后粘贴。
- 新增第 9 个工具 `qqauth`（只在拥有者私聊可用）：`request` 申请一次授权、`status` 看开关与待授权状态。
- `/auth <6位动态码>`：只认拥有者私聊、消息首位；命中即拦截，动态码不进 Agent 回合、不落会话历史。通过后撤回自己那条请求，并把被拦下的那一轮续跑。
- `/flow` 指令族：`ls` / `use` / `off` / `rm` / `auth` / `reset` / `unbind`（流程脚本只是「下次跑什么」的任务书，插件不执行它）。
- 恢复码：终端 `node lib/totp-cli.mjs recovery` 生成 8 条一次性码（scrypt 哈希存配置，明文不进 QQ），手机丢了也能解绑。用掉后插件会把对应那条哈希从配置里删掉。
- 产物投递 `flow.*`：授权跑完这一轮，把「本会话目录里本轮新增/改动」的文件打包送回（默认私聊，`group:<群号>` 丢群，`none` 只回文字）。上限 `maxBytes` / `maxFiles`，隐藏文件默认跳过，符号链接一律不跟。
- 设置页「高级」下新增「流程授权」二级标签：开关、TOTP 密钥、绑定二维码、有效期、锁定策略、要授权的工具名、恢复码哈希与盐。

### 安全边界

- **一次一用**：一条授权只放行一次调用，默认 30 秒内有效；同一 30 秒窗口的动态码不能重放；连续错 5 次锁 15 分钟。
- **没有万能码、没有测试后门**：密钥缺失、短于 10 字节、格式不对、码不匹配，一律拒绝。
- **身份按回合快照**：闸门与工具层读的都是「这一回合开始时固化的发言人」，排队期间别人插话不会把访客的调用判成拥有者的。
- **产物按会话归属**：开关打开后，新会话独占 `QQ_msg/<会话id>` 当工作目录——共用工作区根时「谁写的新文件」是分不出来的，共用就必然串会话。

### 修复（本批合入前发现的问题）

- **一次调用原来要吃两个动态码**：守卫层与同名遮蔽层都会去问闸门，而一条授权只够一次消费，结果开关一打开、四个编排工具 100% 报「还没有授权」。现在守卫放行时记一笔账，遮蔽层直接认账，不再二次消费；调用失败也不再留下「本轮有产物」的标记。
- **关掉开关却仍在改工具面**：接管逻辑原先不看 `flowAuth.enabled`，群里/共享会话的拥有者会被摘掉编排工具。现在只在开关打开时接管，关着时与 0.11 完全一致。
- **产物恒为空**：原来只扫 `QQ_msg/<会话id>`，而这个目录只在没有 workspace 服务时才会被创建；正常部署里模型写在共用根下，扫不到。现在开关打开时给会话分配独立目录，扫得到、也不串会话。
- `tools.js` 里 qqgroup / qqauth / qq_draw 三处仍读会被后到消息覆盖的 `entry.speaker`，现在统一读回合快照。
- `/auth` 续跑没带发言人快照，共享会话里中间插一个访客回合会让续跑按访客身份跑；已补上。
- 动态码拦截能被前置零宽字符绕过（`\u200b/auth 123456` 会漏进模型），现在先剥不可见字符再判。
- 待授权申请没有过期时间（几小时前的申请仍能被一条新码兑现），现在按 TTL 清理；失败文案补上 `weak-secret` 的中文说明。
- 顺带修了测试：`dsh-tools` 在本地永远解析不到，导致工具注册断言长期被跳过（工具数从 7 漂到 9 也没人发现）；现在会尝试 DSH 安装目录，工具数断言按真机 9 个写，并新加 `test/test-flow-wiring.mjs` 守住「一次调用一个码」「关着不动工具面」「失败不留产物标记」。

### 新增（同批合入）

- **中间发言**（`reply.interim`，默认开）：回合没跑完时，模型先说的那几句（「我先查一下」「让我看看这条链接」）会**单独发一条，不引用也不 @ 任何人**；最终结论仍走正常回复（该引用就引用、该分片就分片）。判据是「这段文字后面还有消息」——最后一条 assistant 消息永远留给最终结算，所以不会出现「先念一遍结论、再正式回一遍」。一个回合最多 4 条、两条之间至少 2.5 秒（`interimMaxPerTurn` / `interimMinGapMs`，设置页可调，填 0 关闭）。锚点丢失时宁可不说，也不把上一轮的话重播一遍。

### 第二轮复审查出的问题（同批修复）

- **开关热切换半状态**：接管原先只在建会话时判一次开关，`开→关` 后群会话的工具仍被摘掉、私聊仍是带闸门的 wrapper，`关→开` 后老会话又不遮蔽。现在包装器每次执行时现读配置：关着直接交给原生工具（与 0.11 完全一致），打开且不在拥有者私聊就拒绝。
- **零宽字符绕过**：原先只剥 4 个码点，软连字符、蒙古文元音分隔符、韩文填充符、变体选择符都能把 `/auth` 顶到行首之外整条送进模型；而且判定剥了、解析仍用原文，拦下来又静默蒸发。现在剥离收进 `parseAuthCommand` / `parseFlowCommand` 本身，字符集扩到不可见字符全集。
- **手写的流程脚本根本读不到**：文档让人把 `<名字>.js` 放进 `flows/`，但存储只认 `.json` 元数据，`/flow ls` 永远为空。现在 `.js` 就是本体，元数据可有可无（标题取首行注释；钉住的 sha 仍然会校验）。
- **反向 WS 重连后哑掉**：反向链路只加不摘，NapCat 重连后所有发送都打到已销毁的 socket（每条卡满 15 秒超时），`connected` 却还显示 true。现在断链即摘除并置 `ready=false`，`send()` 也返回真实写入结果。
- **参考图可穿越读任意文件**：`qq_draw` 的本地参考图校验是纯字符串前缀，`<QQ_msg>/qq-images/../../../../etc/hostname` 能通过，内容会被 base64 塞进外部生图请求。现在归一化后按目录边界判断。
- **访客能当任意发言机**：`qqbot` 默认在访客白名单里，工具本身又不鉴权，群成员一句提示注入就能让 bot 给任意 QQ/群发消息、`interrupt all` 掐掉主人正在跑的回合。现在 `qqbot` 只给拥有者，默认白名单里已移除。
- **排队顺序不保证**：`getEntry` 与「查群成员」都是 await，谁先完成谁先入队，连发两条会反着执行。现在同会话在消息到达时同步占位，处理顺序与到达顺序一致。
- **字符串 message_id 被 `Number()` 变成 NaN**：qq-official 的 `ROBOT1.0_…` 因此发不出引用回复（退化成有频控的主动消息），「回复 bot 视同 @」也失效。现在纯数字转数字、其余原样保留。
- **直连抓取没有超时**：`qq_webfetch` / `qq_websearch` 的直连分支超时没盖住读 body（`webSearchPost` 甚至完全没超时），端点慢速灌体会把整条会话队列堵死。现在统一用 `AbortSignal.timeout`。
- **设置页仍会覆盖线上密钥**：密钥是 `role(secret)`，远程读会被脱敏成空串，页面据此判「还没有可用密钥」并给出「生成密钥」按钮——点一下保存就覆盖正在生效的密钥，所有认证器立刻全废。现在改用 `secrets[]` 里的标记判断「配过没有」，提示改成「已经配置好了，别点生成」。
- **授权能被群里那次尝试白吃掉**：私聊发的码，同一个主人在群里触发一次编排工具就会被消费掉（随后私聊续跑反而 no-grant）。现在闸门只在拥有者私聊里消费。
- **恢复码不看待授权申请的时效**：十分钟前的申请早就过期了，用恢复码照样兑现，而且可以连兑两次。现在与动态码走同一条时效检查。
- **多拥有者死锁**：授权提示固定发给 `owners[0]`，闸门却只认发起人的 qq，第二位拥有者永远等不到码。现在提示发给「发起申请的那位」。
- **`/flow rm` 可能假成功**：脚本位置变成目录时 `remove` 照样回 `ok`，主人以为删了其实还在；`save` 的两次 rename 断在中间会留下「元数据是新 sha、脚本是旧的」，那条流程从此永远 sha-mismatch。现在删除会复核、保存失败就回落到「没有元数据」。
- **产物被截断不说**：`maxFiles` 按文件名序取前 N 个，QQ 只说「3 个文件」。现在回执里写明「超出上限，只打包了 3/5 个」。
- 其它：消息入口补 `.catch`（否则一次抛出就是 unhandled rejection，Node 24 直接退进程）、`qq_history` 与提示词里的身份改读回合快照（否则访客能借主人身份读跨群历史）、设置页绑定区在「密钥已配未确认」时不再误报没有密钥。

### 兼容

- 默认全关：不装认证器、不打开开关的话，配置、日志、工具面、`/auth` 行为都与 0.11 一致；新增字段都有默认值，不需要迁移。
- 关闭状态下 `staleConfigPaths` 不会动这些字段；打开再关掉也不会残留待授权请求（`/flow reset` 同理）。


## 0.12.0（同批）—— 两段式发言、发送前兜底、废弃配置清理与几处稳健性修复

一句话：可选的两段式。判断阶段只要稳出 JSON（可以挑便宜快的模型），正文交给另一个模型写（可以挑文风更合适的），
不填就跟以前完全一样。

### 新增（全部可选）

- 判断阶段沿用现有 `proactive.provider` / `proactive.model`，**不新增 judge 字段**——它们只会是别名，同一个模型两个入口反而增加心智负担。
- 新增 `proactive.requireCjk`（默认关）：发送前兜底，**单段与两段模式都生效**——正文没有 CJK 字符且长度超过 12 时判不可用（原因 `no-cjk`，verbose 可见）。它不是「拒绝语识别」，判据是结构性的「中文群里整句英文」；中文群建议开，英文群务必关。长度阈值 12 是代码常量 `CJK_MIN_LENGTH`（按码点计，emoji 与生僻字不会被算成两个字）（正常 ASCII 短回应 ≤ 10、整句英文拒绝语 ≥ 20，12 是安全中点），CJK 判据用 Unicode 属性转义覆盖汉字 / 假名 / 谚文 / `々` / 扩展 B 区。
- `proactive.speakProvider` / `speakModel`：发言阶段用哪个 provider / 模型，留空表示**单段模式**（判断模型同时把话写出来，即原有行为）。
- `proactive.speakFallback`（默认开）：两段式下发言阶段失败（报错 / 空回复 / 正文被拦）时，回退用判断模型给的那句 `speak`；发言阶段最多试 2 次（1 次重试）。
- **提示词防编造约束**：判断阶段的 `topic` 只能来自聊天记录里出现过的事；发言阶段只用记录里的信息、不编造具体事实（自己的经历、时间、地点、金额、别人的事）。
  起因是生产实例上真发出去一条自编经历（详见 PR 描述）——约束能压低概率，不能消除。
- 设置页「能力 → 对话与人格 → 主动发言」新增 1 个 provider 下拉、1 个 model 下拉（跟随所选 provider）和两个开关（`requireCjk` / `speakFallback`）。
- 设置页的两项识图范围（「识图往回找几条消息」「这个范围内最多识别几张图」）从「对话与人格」挪到「识图与绘图」，标签改成大白话；键名不变，不需要迁移。
- 启动横幅的模型来源行在启用两段式时追加「两段式（判断 a/b / 发言 c/d）」；单段模式不追加，与原来一模一样。
- 发言阶段的「重试 → 全被拦 → 回退 → 判断正文也不可用则放弃」抽成 `runSpeakStage()` 并补单测；回退被跳过时（判断正文本身不合格）verbose 会说明原因。
- 两段式缺项的告警前移到第一次判断调用之前——配置填错不该先花一次调用的钱。
- `owner-settings` 的 `DENY_PREFIXES` 补上 `speakProvider` / `speakModel`（和 `proactive.model` 同级：等于换掉说话的人）。
- 成本写进文档：两段式每次接话正常是 2 次模型调用（判断 1 + 发言 1）；判断阶段自己最多试 3 次、发言阶段最多试 2 次，最坏 5 次。

### 修复

- **历史消息方向看反了**：NapCat 的 `get_group_msg_history` 返回的是「最新在前」，插件却按「旧→新」理解，于是事件闸的时效判断拿的是窗口里**最早**那条（新鲜话题可能被判过气、老话题也可能被当新鲜，「最新一条是我自己发的」「最新一条像应答」同样看错）、摘要给模型的是最旧那几条、提示词标签与实际方向相反。现在归一化时按时间升序（同一时间按消息 id 稳定排序），所有调用方自动跟上。
- `proactive.requireCjk` 进了 `owner-settings` 白名单，群主可以在 QQ 私聊里直接关掉这道兜底。
- **插件重挂时会把整个宿主带崩（主动发言开着就必中）**：每轮检查结束要排下一次，而那次 `ctx.timeout` 在插件卸载/重挂之后会抛 `INACTIVE`；timer 回调丢弃返回值，异常变成 unhandled rejection，Node 24 默认直接 `exit 1`。升级插件、改适配器路径、关 DSH 都会踩到。现在卸载中不再排下一轮，异常也不会漏出回调。
- **改一次连接配置就多起一个适配器**：旧进程的退出通知晚到，`handle` 已是 null，于是又排了一次重启；两个适配器连同一个 OneBot，入站消息被处理两遍（重复回合、重复回复）。现在会取消已排的重启、旧进程退出不再触发重启、见到已有进程就不起第二个；重启退避在连上之后清零。
- **废弃配置清理的两处隐患**：id 匹配改成精确相等（原来的后缀匹配会把 `my-qq-bot` 这类别人的插件当成自己，误删对方配置）；键名本身带点（如 `a.b`）时不再删错键；写回基座改用 profile 层，避免多层 patch 时把上层内容抄下来；删掉的键连同旧值一起进日志。
- **升级残留的废弃配置会自动清掉**：DSH 写设置是合并语义，schema 不认识的键没人删，会一直躺在 `cordis.patch.yml` 里（版本升级删掉的字段就是这样留下来的）。现在插件在启动时、以及每次保存设置后比对一次 schema，把整段不认识的键从自己那一行配置里摘掉再写回；只动本插件自己的段，别的插件一概不碰。真机实测清掉了 4 个，其中 2 个是本插件早期版本遗留的 `reply.quoteReply` / `reply.subagentReply`。清理是一次性的：写回对 loader 属于非 volatile 变更，会重挂一次插件（适配器断连重连），之后不会反复触发。

### 兼容

- 四个新字段都有默认值，`speakModel` 留空时走原来的单段路径，行为、日志、配置都不需要迁移。
- 判断阶段的温度（0.8）、超时、重试次数与原来一致；发言阶段温度 0.9，且与判断共用同一套 `validateMessage`（字数 / 链接 / @ / 重复），被拦只记 verbose 日志，不改变判断路径的重试。

### 测试

- `test/test-proactive.mjs` 从 49 项扩到 84 项：两段式分派、只配一半、空回复回退到判断正文、回退关闭后不出声、单段模式不受影响、两段提示词的防编造约束、发言阶段胶水（重试 / 回退 / 放弃）的四种组合、`requireCjk` 的默认关 / 长度门槛两侧 / 纯 `々` 串 / 扩展 B 区 / 整句英文拦截、历史消息方向（归一化升序 / 事件闸算时效 / 摘要末行是最新 / 同秒按消息 id 定先后）、长度上限也按码点、判据顺序（纯符号串仍报「无实质内容」）、emoji 短回应不被误拦。
- 新增 `test/test-proactive-round.mjs`（35 项）：主动发言回合的端到端验证——假 ctx + 真 `lib/index.js` + 假 OneBot，把插件注册的定时器回调抓出来手动触发，跑「判断 → 发言 → requireCjk 拦截 → 回退判断正文 → 发送」整条链。此前这段胶水只有生产实例上肉眼验证过。后来补了三个场景：关掉兜底后发言被拦就闭嘴、判断提示词里的摘要方向必须旧→新、以及「卸载竞态」——tick 回来时定时器服务已不可用，只能记一行日志。
- 全套 28 个套件 / 1018 项通过。

## 0.11.0 —— 设置页迁到插件面板 + 主动发言走会话模型

一句话：设置页不再挂在「设置 → QQ 机器人」，改为插件自己的配置面板（首页侧边栏 插件 → 已安装 → dsh-qq-bot），
字段按「连接 / 基本 / 能力 / 高级」四档归类，后两档再分二级标签。

### 设置页

- 注册到官方 `plugins.bundle.config`（keyed slot，`entryKey` 用包名），不再占用设置页顶层分区。
- 顶端四档标签：**连接**（排最前，默认打开）/ **基本** / **能力** / **高级**；改传输类字段（协议、连接方式、各协议地址）会自动重启适配器。
- 二级标签：**基本** → 准入与名单 / 发言与管理；**能力** → 识图与绘图 / 搜索与抓取 / 对话与人格。
  两组各自记住上次位置；未归类的字段在每个二级标签下都显示。
- 「保存」「重新读取」常驻底栏，切主标签或二级标签都不消失。
- 重叠项整理：四处 preset 集中到「高级」并标注 ①自定义 id → ②拥有者/访客分流 → ③兜底 的优先级；
  主动发言人设标明与全局人格的兜底关系；三处 API key 的回退链写清；
  视觉 provider/model 留空时提示「会话模型不一定支持图片」。
- 补齐三个此前没暴露的配置：`protocols.onebot12.mode`（接入方式，并据此显隐正向地址 / 反向监听）、
  `proactive.provider`、`proactive.timeoutMs`；`proactive.provider` / `proactive.model` 两项做成和识图一样的下拉。

### 主动发言

- 审查补齐：分流（owner/guest 不同 preset）配置下**不再冷启动建孤儿会话**——那种配置的会话键是
  `group-x@owner` / `group-x@guest`，主动发言判断不了该算哪一档，硬建只会留下收消息时用不到的空会话。
- 修掉删除自定义端点后遗留的过期文案（日志还提示去补 `baseUrl`、生图/搜索 key 的说明还宣称被主动发言复用）；
  `SECURITY.md` 的拒绝清单同步成 `proactive.model`。
- 任何 volatile 配置改动都会重跑调度，横幅日志改为内容变化时才打，缺项告警也随配置变化重新判断。
- 顺手修了 README 里上游带来的 `不会 \`\` 人`（应为「不会 `@` 人」）。

- **和识图完全对齐：统一走 `ctx.llm.stream()`，不再自建 OpenAI 兼容端点。**
  原来必须自己配 `baseUrl` + `model` + `apiKey` 才能说话，现在 `provider` / `model` 留空就**跟随该群会话的模型**，
  零密钥；群里还没有会话时按全局 agent preset 建同一条会话再取。
- 设置页里 `provider` / `model` 改成**下拉选择**（复用 DSH 同一份模型目录，model 跟随所选 provider），
  与识图的交互一致；删掉 `baseUrl` / `apiKey` / `apiKeyEnv` 三个字段。
- 修掉「界面显示已开启、实际一句不发」：`proactiveConsiderGroup` 里原有一道
  「缺 `baseUrl` 或 `model` 就直接 return」的前置闸，配合 `imageGen` 兜底，配置一空就整轮跳过。
  现在由 `resolveModel` 判断，启动日志打印「模型来源=跟随群会话模型 / 指定模型 x/y」，真缺项会明确告警。
- 移除 `imageGen` 端点兜底：生图接口不是聊天接口，语义本就不对。

### 要求

- **DSH ≥ 0.2.0-rc.2**（`compat.js` 的 SUPPORT_FLOOR、`package.json` 的 `engines.dsh` 与 `dsh.compatibility` 三处一致）。

### 其它

- `DEFAULTS` 补上缺失的 `moli` / `session` 块，与 schema 默认值对齐（裸配置下不再取到 undefined）。
- 删掉旧标题留下的死样式 `heading`。
- CI 只改文档（`**.md` / `docs/**` / `LICENSE` 等）不再触发全量测试，并修了注释里过期的套件数。

### 测试

- `test/test-client.mjs` 从 32 项扩到 80 项：四档标签、二级标签、字段分组隔离、底栏常驻，
  外加一条**字段覆盖守卫**——schema 里可配置的字段若没出现在设置页就判失败（上游新增字段不会再被静默漏掉）。
- `test/test-proactive.mjs` 从 42 项扩到 49 项（来源解析：跟随会话 / 显式优先 / 只配一半 / 空白串 / 缺项报告）。
- 全套 18 个套件 / 683 项通过。

## 0.10.1 —— 主动发言不再对同一件事重复回复

一句话：修掉「主动发言时对一件已经聊完的事再回一次」的 bug，并给了可关的开关。

### 修复

- 新增**事件闸**（`proactive.eventGuard`，默认开）。原来只有「频率」和「和上一条文本一模一样」两道闸，
  所以一件早就有人接过的事，只要换个说法就会再回一遍。现在开跑前先判断这件事还该不该接：
  - 最新消息距今超过 `staleMinutes`（默认 15 分钟）→ 视为事件已过气，不接；
  - 最新一条是「行」「OK」这类短应答且不是提问 → 不插话（同一人 3 分钟内的补充说明不算应答）；
  - 最近 6 条只有两个人在来回说 → 视为两个人的对话，不硬插；
  - 同一话题在 `topicCooldownMinutes`（默认 120 分钟）内说过就不再重复，换说法（包含关系）也算同一件事。
- 去重记忆按群保存：最近 5 条发过的文本 + 最近 20 个话题 + 每条话题的时间，重启后重置。
- `lastSentAt` 改成发送时刻（原来是本轮开始时刻），最小间隔不再被上游延迟吃掉。

### 可选开关

- `proactive.eventGuard: false` 退回 0.10.0 的行为（只做频率与逐字去重）；设置页里是「事件去重（防重复回复）」。
- 阈值都可调：`staleMinutes`、`topicCooldownMinutes`。

### 测试

- `test/test-proactive.mjs` 从 28 项扩到 42 项（事件过气、短应答、两人对话、话题包含去重等）。
- 全套 18 个套件 / 628 项通过。
## 0.10.0 —— 多协议适配器（OneBot 11/12、Satori、Milky、QQ 官方）+ 拥有者设置通道

一句话：插件不再绑死 OneBot 11。同一套插件逻辑，换 `protocol` 就能接 OneBot 12、Satori（Koishi 生态）、
Milky 和 QQ 官方机器人开放平台；外加拥有者可以在 QQ 私聊里改自己的设置。

### 协议适配器（新）

- 适配器统一迁到 `lib/adapters/`，共享 `lib/bridge/`（手写 WebSocket、stdio 契约、消息段归一），
  仍然**零 npm 依赖**；`lib/onebot-adapter.mjs` 保留为兼容入口。
- 内部统一「中间表示」：一套消息段 + 一套 message 帧（见 `lib/bridge/CONTRACT.md`），
  各协议只做翻译，插件上层（会话、权限、历史、主动发言）完全协议无关。
- `protocol` 取值与传输：

  | 协议 | 适配器 | 传输 | 鉴权 |
  | --- | --- | --- | --- |
  | `onebot11`（默认） | adapters/onebot11.mjs | 正向/反向 WS + HTTP | access_token（Bearer / query） |
  | `onebot12` | adapters/onebot12.mjs | 正向/反向 WS + HTTP | access_token，反向 WS 需 Sec-WebSocket-Protocol |
  | `satori` | adapters/satori.mjs | WS /v1/events + HTTP RPC | Bearer + Satori-Platform / Satori-User-ID |
  | `milky` | adapters/milky.mjs | /event WS（或 SSE）+ /api | Bearer |
  | `qq-official` | adapters/qq-official.mjs | Webhook 或 WS 网关 | AppID/AppSecret → QQBot token，Webhook Ed25519 校验 |

- 新增 4 个适配器测试套件（onebot12 / milky / satori / qq-official），全部用本地假协议端，不连真实 QQ。

### 拥有者设置通道（qqconfig）

- 拥有者可以在 QQ 私聊里让机器人改自己的设置（不必手改 `cordis.patch.yml`）。
  防护分层：身份只取自当前会话发言人（必须命中 `auth.owners`）、只允许私聊、字段白名单
  （`auth.*` / `onebot.*` / 密钥 / 模型名硬拒绝）、值类型与范围校验、`propose`→`apply` 两步确认
  （token 300s、一次性、绑定拥有者+路径+值+配置修订号）、只走 DSH settings 服务落盘（不手改 YAML）、
  限流（每小时 6 / 每天 30）与审计日志 `QQ_msg/qqbot-config-audit.jsonl`。总开关 `auth.ownerSettings`。

### 其它

- `qqbot` 的 `send` 支持可选 `image`（本地图片绝对路径，只允许 `<QQ_msg>/qq-images` 内）。
- 修 `qq_imgsearch` 的本地文件白名单 bug：0.9.5 的 `meIsAllowedImageFile` 调用了未导入的
  `qqMsgRootSync`，ReferenceError 被吞掉后永远返回 false。工作区根解析抽到 `lib/workspace.js`。
- 新增 `lib/owner-settings.js`、`lib/workspace.js`、`lib/bridge/*`、`lib/adapters/*`；
  测试套件 14 → 18。

## 0.9.5 —— 主动发言（可选，默认关）

- 新增可选能力：按间隔看群里最近的消息，由模型自己判断要不要接话、接什么话题；默认关闭，且必须显式列群号才生效。
- 可控点：检查间隔、新消息门槛、免打扰时段、每小时 / 每天上限、两次发言最小间隔、最大字数、话题偏好、人设、演练模式、逐次判断日志。
- 安全阀：模型返回 speak=false 就不说话；发言前校验长度 / 链接 / ` / 重复；只有 verbose 才打印判断细节。
- 判断走 OpenAI 兼容接口（baseUrl / model / apiKey，留空复用生图配置），不依赖 DSH 会话模型。
- 新增 `test/test-proactive.mjs`（28 项），全套件 13/13、290 项。
- 修一处内部命名冲突：主动发言用的 buildPrompt 与插件原有回合提示词构造同名，改为显式别名。

## 0.9.4 —— qq_history：私聊历史 + 分页 + 按权限跨会话

- **私聊也能取历史**：之前 qq_history 只支持群聊（私聊直接报错）。现在当前私聊会用触发消息当锚点调 `get_friend_msg_history`，私聊里也能主动翻记录；`peer_id` 可指定别的私聊（需权限）。
- **分页**：新增 `before_seq`（上一页最旧的 message_id），返回里带 `next_before` 作为下一页游标；群聊用 `message_seq + reverseOrder`，私聊同样按锚点往前翻。
- **跨会话按权限取**（`lib/history-auth.js`）：当前会话随意读；拥有者 / 高级管理员可读任意群和私聊；群管理员只能读「自己是管理员（或已授权）且群在可管理范围」的群；别人的私聊只有拥有者/高级管理员可读。越权返回明确原因，不静默给空。
- 消息统一归一化成「新→旧」并按 message_id 去重；返回增加 `target` / `access` 字段说明读的是谁、凭什么权限。
- 新增 `test/test-history.mjs`（23 项：会话定向 / 越权判定 / 请求构造 / 归一化），全套件 12/12、262 项。
- 已在真实 NapCat 4.18.19 上验证：`get_group_msg_history`（带 message_seq 翻页）与 `get_friend_msg_history`（锚点）均 retcode 0。

## 0.9.3 —— 运行时兼容自检（不写死 DSH 版本）

- 新增 `lib/compat.js`：读取当前实际加载的 DSH 版本（`DSH_VERSION` 环境变量 → 从 `process.argv[1]` 向上找
  `@deepseek-ai/dsh/package.json` → 模块解析兜底），与声明支持范围比较后给出结论。
- 启动日志多一行：`运行于 DSH x.y.z（在声明支持范围内 / 超出支持范围 / 未能识别）`；
  `qqbot` 工具 `action="status"` 的 `runtime` 字段返回 `{dsh, supportingRange, compatible, note}`。
- 支持范围只维护两个常量（`SUPPORT_FLOOR = 0.1.7-0`、`SUPPORT_CEILING = 0.3.0-0`），
  不再逐版本维护兼容表；识别失败或超范围只提示，不影响收发消息。
- 已在 DSH 0.2.1-rc.2（线上）与 0.2.1-rc.3（隔离 profile）实测：七条工具注册齐全、启动无报错；
  新增 `test/test-compat.mjs`（14 项），全套件 11/11。
- 消息链路零改动：升级只多一行日志与一个状态字段。

## 0.9.2 —— 跨对话检索 + 旧会话向前兼容

- **不再清理旧会话**：当持久化的会话绑在别的工作区（例如 0.7 时代 workspace=/root 建的会话，
  升级后工作区变成 QQ_msg）时，DSH 会拒绝跨工作区复用同一 id。现在改为**保留旧会话**、
  用一个「工作区限定」的新 id（如 qqbot-group-123-ws1a2b3c）重开，历史一条不删。
- **跨对话信息调用**：配合 DSH 的 `@deepseek-ai/dsh-tool-session-query` 使用，Agent 可以
  session_search / session_event_search / session_trace / session_event_read 检索同工作区下的其他会话
  （QQ 的每个群/私聊都是一条会话，cwd 相同即互相可查）。
- **qq_history 支持跨群**：传别的 group_id 就能读其它群的消息（只读）。
- 新增 test/test-session-id.mjs（5 项）校验 id 回退稳定性；全套件 10/10。

## 0.9.1

- 生图（`qq_draw`）与人格设置正式发布；接口地址 / key / 模型 / 重试与轮询、人格开关 / 名字 / 设定、
  自定义 preset id 全部在「设置 → QQ 机器人」里。
- **撤回并重发 0.9.0**：0.9.0 的文档示例里带了维护者个人的中转站地址、设置占位带了个人人格名，
  已从历史中移除该版本并重发为 0.9.1（功能一致，无任何个人痕迹）。
- 人格默认留空：默认不注入任何身份设定，只有自己填了才会生效（自己用的配置属于部署侧，不进仓库）。
- 贡献者：[@arrow1031](https://github.com/arrow1031)（0.9.x 生图与人格）、[@nd002723](https://github.com/nd002723)（0.8.0 并入的模块化重构与 qq_history / qq_websearch / qq_webfetch / qq_imgsearch）。
- 修合并遗留的 `qqbot` send 分支未注入 `writeToAdapter` 的问题。
- 新增 `lib/imagegen.js` 与 `test/test-imagegen.mjs`（16 项）；全套件 9/9、220 项。

## 0.9.0 —— 生图（qq_draw）与人格都进设置

- 新增工具 `qq_draw`：按描述画图并直接发到当前 QQ 会话；接口地址 / key / 模型 / 尺寸 / 重试与轮询全在「设置 → QQ 机器人」里填，插件不内置任何 key。
- 生图容错：`429 / 5xx / 网络错 / 空结果` 自动重试（`maxAttempts` / `retryIntervalMs`）；`4xx` 直接报错；供应商返回 `task_id` 时继续轮询（`pollIntervalMs` / `maxPolls`，依次尝试三种轮询路径）。
- 参考图：`reference` 支持公网 URL 或 `qq-images` 下的本地图，用来保持同一人物形象（做「自拍」）。
- 人格进设置：新增 `persona`（开关 / 名字 / 设定），每个新会话第一轮附一次身份设定；新增 `agentPresetCustom`，自建 preset id 直接接管整档人格与工具面。
- 修掉合并时留下的隐患：`qqbot` 工具 `send` 分支引用了未注入的 `writeToAdapter`（发送必然失败），现已正式注入工具层。
- 新增 `lib/imagegen.js`（不依赖 Cordis，可单测）与 `test/test-imagegen.mjs`（16 项：URL 拼接、响应解析、重试、轮询）；全套件 9/9、220 项。

## 0.8.2

文档纠正到当前状态（无代码改动）：

- README 头部改为「本仓库即维护主干、已解除封版、0.8.x 要求 DSH >= 0.1.7」
- 架构图与文件清单更新为 0.8 的模块化结构（config / session / tools / admin / http / websearch / imgsearch / moli）
- 已验证表格与自测章节换成实测条数：8 个套件、204 项（adapter 19 / reverse 12 / plugin 76 / client 32 / admin 32 / http 17 / config 11 / websearch 5）
- 「维护状态」由「fork 自上游的继续维护版 / 原版已封版」改为「社区化维护中、不封版、跟随 main」
- 修复 CONTRIBUTING / SECURITY / PR 模板里的占位符残留，社区段补上 Discussions / 行为准则链接

## 0.8.1

- 修复：设置页「列表类字段」（群号白名单、私聊白名单、拥有者、可管理的群等）输入框吞掉逗号，
  只能填一个值。改为本地 draft 文本编辑，支持逗号 / 中文逗号 / 顿号 / 分号 / 空白分隔，失焦归一化。

## 0.8.0 — 合并下游分支（模块化 + qq_history / qq_websearch / qq_webfetch / qq_img）

首次把下游开发者分支（nd002723/dsh-qq-bot，0.6.3 → 0.6.11）并入主干，并把 0.7.0 的
DSH 0.2 服务访问契约移植到模块化代码上。

- 结构：单体 lib/index.js 拆分为 lib/{config,http,websearch,imgsearch,moli,admin,session,tools}.js
- 工具：新增 qq_websearch（多引擎组合搜索）、qq_webfetch（独立抓取）、qq_img（图片搜索/上传）、qq_history（AI 自取聊天记录）
- 工作区：QQ_msg 工作区自动创建，会话自动归入分组；群聊回复/引用机器人视同 @；被回复的图片识图
- 健壮性：本轮运行失败不再重发上一轮回复；失败提示总是作为回复发出（只输出状态码）
- 兼容：工具注册与访客工具闸改为 ctx.get('tools') / ctx.inject(['tools'])（DSH 0.2 契约），
  并保留 0.1.x 属性形态兜底
- 测试：node test/run-all.mjs（含 config/http/websearch/plugin 套件）
- 社区化：完全解除封版（安装跟随 main，不再锁 tag）；启用 Discussions；
  新增 CONTRIBUTING / CODE_OF_CONDUCT / SECURITY / issue 与 PR 模板 / CODEOWNERS；
  邀请下游开发者 @nd002723 为协作者

# 更新日志

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## 0.6.8

模块化重构 + qq_history：聊天上下文改为 AI 主动自取（不再硬塞），业务代码按模块拆分。

- **模块化重构**：`lib/index.js`（原 3346 行单文件）拆成模块——保留 napcat 通信与子进程监管（`lib/onebot-adapter.mjs`），抽出网络查询通道（`lib/http.js` 通用 HTTP 传输 / `lib/websearch.js` 联网搜索 / `lib/imgsearch.js` 图片反搜）、dsh-moli 联动（`lib/moli.js`）、配置契约（`lib/config.js`：`DEFAULTS` + `Config` + `plainConfig`/`mergeConfig`）；业务再拆三块——`lib/admin.js`（权限三路鉴权 + 群管理指令 `handleAdminCommand`/`planAdminCommand`/`runGroupAction`）、`lib/session.js`（会话条目与路由 `getEntry`/`sessionRoute`/`entryForAgent` + 被回复图片收集）、`lib/tools.js`（6 工具动态注册）；`lib/index.js` 只留 napcat 通信 + 装配与生命周期（1906 → 845 行）。所有外部请求仍走 `webSearch.proxy` 管控（留空直连、非空走 CONNECT 隧道、非公网 IP 拒绝）。
- **qq_history（新工具，AI 自取聊天记录）**：不再自动把群内「最近相关发言」硬塞进会话——`acceptMessage` 里的 `fetchReplyContext`/`replyTargetQQs` 已删除，需要历史上下文时由 Agent **主动调 `qq_history`** 拉取（prompt 有引导）。
  - 返回结构化消息列表：`{ok, group_id, messages:[{time, user_id, nickname, text, images:[{url, description}]}]}`，参数 `group_id`（默认当前群）/ `user_id`（可选筛人）/ `count`（默认 20，上限 50）/ `with_images`（默认开）。
  - **识别窗口锚定「最新提及」**：只对触发本条回复的那条消息（@ bot / 回复 bot / 命令前缀）**往前 `scopeMessages` 条**内的图片做识别（默认 5），最多 `imageLimit` 张（默认 3，最近的优先）；更早的 @ 不锚定、其附近图片不因「也是被提及」而识别，避免重复拉取/重复识图。
  - 窗口内图片用现有视觉链路（下载 + `askVision`）识别，返回 URL + 描述；识别失败只给 URL 不阻塞。修复：工具 execute 不再闭包未定义的 `entry`（原会 ReferenceError），改由执行上下文 `exec.agent` 经 `entryForAgent` 反查当前会话。
- **被回复消息的图片仍走视觉识别**：`collectReplyImageUrls` 保留「用 `get_msg` 拉被回复消息、收集图片并入识图」的能力（回复引用流程不受影响），但不再把被回复消息文本塞进上下文。
- **访客白名单**：默认加入 `qq_history`。
- **新配置段 `history`**：`scopeMessages`（识别窗口条数，默认 5）/ `imageLimit`（窗口内最多识图张数，默认 3），设置页可改。
- **测试**：`npm test` 全绿（adapter 12 / plugin 88 / client 32 / admin 36）；新增 4f 段（工具注册 / 白名单 / 结构化拉取 / 窗口锚定 / 限张），旧「自动塞上下文」断言全部翻转为「不再自动携带」。

## 0.6.7

继续维护版：qq_websearch 的 url 抓取拆成独立工具 qq_webfetch，新增 dsh-moli 接管。

- **qq_webfetch（新独立工具）**：从 qq_websearch 拆出 url 抓取，平级注册；受 `webSearch.proxy` 管控（留空直连、非空走 HTTP CONNECT 隧道 + TLS），抓取前校验目标为公网 IP（内网/回环/私有地址一律拒绝）。
- **dsh-moli 接管（qq_webfetch）**：设置页新增 `moli` 段（默认关）——开启后 qq_webfetch 改用 Moli 无头浏览器渲染抓取（可抓 SPA/JS 渲染页）；HTTP 代理自动透传 `webSearch.proxy`（可被 `moli.proxy` 覆盖）；未检测到 moli 引擎时开关无效，工具返回 `moliUnavailable` 明确报错。
- **访客白名单**：默认加入 `qq_webfetch`。

## 0.6.6

继续维护版：群聊「回复机器人」视同 @ 处理，bot 被点名时改用 QQ 引用回复，命令前缀视同点名；点名但无正文也处理。

- **回复（引用）bot 消息视同 @ 处理**：群聊里没 @ 机器人、但回复（引用）了 bot 的消息，照常进入 Agent 旅程；开关 `reply.botReply`（设置页「回复」区，默认开启）。判定方式：调 NapCat `get_msg` 查被引用消息的发送者是否为 bot 自己。
- **追加最近相关发言上下文**：回复 bot 触发时，调 NapCat `get_group_msg_history` 筛出**该对话者 + bot** 的最近最多 **5 条**发言，按时间正序并入 Agent 输入（`【HH:MM】对话者/bot：内容`）。
- **「回复别人 + 正文 @bot」**：同样触发（引用回复 + 拉上下文）；上下文把**被回复者 / 被 @ 对象**的发言也并入，扩充到 **8 条**。
- **「回复 bot + 正文 @别人」**：这条可能不是对 bot 说的——消息照常进模型，但**不强制引用回复**，交给 bot 自行判断是否继续回复。
- **QQ 引用回复（回复消息流程）**：bot 被点名（@ bot / 回复 bot / 命令前缀 / 管理指令）时的响应，统一**引用触发消息**发送（CQ `reply` 段）；`requireAt` 关闭后的普通闲聊不引用，避免每条群消息都变引用回复。
- **命令前缀视同点名**：设置了 `commandPrefix`（如 `/ai`）时，命中前缀的消息豁免 requireAt（不需要 @），并走引用回复——与群管理指令同理。
- **点名但无正文也响应**：bot 被点名（@ bot / 回复 bot / 命令前缀）时，即使消息没有正文（纯回复、纯 @、回复别人 + @bot 但没打字），照常进入 Agent 旅程——给 Agent 占位正文「（本条消息无正文，仅点名了 bot）」，结合上下文主动回应；普通空消息（未点名）仍跳过。
- **被回复消息始终并入上下文**：被回复（引用）的那条消息用 `get_msg` 按 id 单独拉取，不受最近历史窗口限制；上下文**最低保证 2 条**（被回复消息 + 发言人本条），不硬补其它群友。
- **被回复消息的图片也走视觉识别**：`get_msg` 拉被回复消息时一并收集里面的图片 URL，与本条消息的图合并交给插件原有的识图功能（`describeImages`）识别，识别文本并入 Agent 输入。
- **修复**：`requireAt` 关闭（群=全部）时，回复 bot 的消息此前不识别（不引用、不拉上下文）——现已修复，只要 `reply.botReply` 开启且消息带了被引用消息就查。
- **多引擎组合搜索（qq_websearch）**：`webSearch.multiEngine`（默认开，设置页有开关）——Tavily（配 `TAVILY_API_KEY` 才启用）→ DuckDuckGo（html→lite）→ Yandex / Bing / Wikipedia 并发兜底，全部请求受 `webSearch.proxy` 管控（留空直连、非空走 CONNECT 隧道）；关闭则落回官方 DeepSeek web_search。完全独立实现，不依赖任何其它插件。
- **测试**：`npm test` **161 项全绿**（test-plugin 81 项，新增无正文 / 窗口外被回复消息 / 最低 2 条兜底 / 被回复图片识别 / 多引擎搜索五组用例；admin 36 项）。

## 0.6.5

继续维护版：联网抓取走代理、固定会话名、访客白名单瘦身、设置页重排。

- **`qq_websearch` 新增 url 抓取模式**：`{url}` 直接抓指定网页原文（http/https，仅公网），返回 `{ok, url, status, text}`；与搜索共用 `webSearch.proxy`——非空时经 HTTP CONNECT 隧道 + TLS（含境内/境外分流），留空直连。抓取前校验目标为公网 IP，内网/回环/私有地址一律拒绝（防经代理扫内网）。
- **固定新建会话名**：`session.fixedName`（默认开启），新会话显示名钉死为 `群聊_<群号>` / `私聊_<QQ号>`，替代 LLM 自动起标题（用 DSH `sessionTitle.rename` 的 user 源标题，自动生成不会覆盖）；已建会话保持原名。
- **访客默认白名单瘦身**：移除 `web_fetch`，访客联网统一走 `qq_websearch`（搜索 + url 抓取，都经代理）；DSH 自带的 `web_fetch` 仅拥有者可用。
- **设置页重排**：字段按功能分 7 块（接入与范围 → 身份与权限 → 群管理 → 会话 → 回复 → 图片视觉 → 联网搜索），QQ 号类字段集中；`cordis.patch.yml` 键序同步排版（纯排版，值不变）。
- **测试**：`npm test` **144 项全绿**（test-plugin 45 项）。

## 0.6.4

继续维护版：访客联网搜索，工具面设置更顺手。

- **联网搜索工具 `qq_websearch`**：访客白名单搜索（DeepSeek web_search），`webSearch` 配置段可选代理 / 端点 / key 环境变量名 / 触发上限；key 自动走 DSH 凭据服务，`process.env` 兜底。
- **访客默认白名单**：扩为 `qqbot, qqgroup, qq_websearch, web_fetch`（`web_fetch` 只抓公网，内网 IP 由 DSH 拒绝）。
- **Agent preset 下拉**：设置页改为下拉选择（部署默认 / standard / ptc / minimal / cordis），只影响新会话；人格分离字段空位自动回落 `agentPreset`。
- **修复**：`inject` 补 `'tools'`，解决生产环境工具注册失败（`cannot get property "tools" without inject`）。
- **测试**：`npm test` **147 项全绿**。

## 0.6.3

继续维护版（fork 自 [arrow1031/dsh-qq-bot](https://github.com/arrow1031/dsh-qq-bot)）：工作区自动管理，会话自动归入分组。

- **工作区自动管理**：移除 `workspace` 配置项；自动读取 DSH 官方默认 Workspace 位置（`<系统 Documents>/deepseek-harness`），在其同级目录创建 `QQ_msg` 并注册为 DSH workspace——Web UI 侧栏的「QQ 消息」分组，**新会话自动归入该分组**（通过 Cordis `ctx.reflect.get('workspaceRegistry')` 免注入读服务，缺失时自动回退）。
- **图片缓存结算清理**：带图消息的原图缓存到 `QQ_msg/qq-images/<会话id>/`，会话结算后自动删除，会话与工作区保留。
- **测试**：`npm test` **133 项全绿**（test-plugin 38 项，含分组断言）。

## 0.6.2

继续维护版：图片视觉增强、图片缓存导出。

- **图片视觉**：`vision` 配置新增 provider / model 下拉选择（从 DSH 自定义 providers 选，协议 / baseURL / apiKey 沿用）；模型不支持图片时给可读报错并引导切换。
- **图片缓存导出**：带图消息的原图缓存到 `<QQ_msg>/qq-images/<会话id>/`，会话结算后自动删除；消息附上识图结果与图片路径，并提示 Agent 结合用户发言作答、需确认身份时提炼关键词联网查证，勿凭空猜测。
- **插件标准**：package.json 补 `engines.dsh` 版本范围与 `dsh.runtime: host`。
- **测试**：`npm test` **133 项全绿**（test-plugin 38 项）。

## 0.6.1

**适配 DSH 0.1.7：设置契约重做**。0.1.7 移除了 `ctx.settings.register()`，0.6.0 在 0.1.7 上会
注册失败（设置页整个消失）。除设置相关外，收发消息的链路没有变化。

- **根因**：0.1.7 删掉了 `packages/settings/settings-file`（独立的 `settings.yaml` 文档），
  并把 `settings` 服务重写成「直接读 profile 里每个插件条目的 Config schema」。因此
  **`ctx.settings.register(ns, schema, { base })` 不再存在**：设置表单改由**插件自己导出的
  Cordis `Config` schema** 承载，界面上的改动写回 profile 的 `cordis.patch.yml`。
- **Host**：新增 `export const Config`（schemastery）；所有出现在设置页里的字段标 `.volatile()`
  （`settings` 只允许 volatile 字段被编辑）；删掉 `settings.register` 调用；配置改从 Cordis
  求值后的 `config` 参数读取 —— volatile 字段是引用，要 `.get()`。
- **热更新语义变了**：0.1.7 里 volatile 字段变化**不会重挂插件**，`cordis-plugin-loader`
  只就地更新运行中 fiber 的引用并发 `loader/volatile-update`。所以改为监听该事件刷新配置；
  连接方式（模式 / 地址 / token）变化时才重启适配器，与旧行为一致。
- **客户端**：设置命名空间从自定义的 `qq-bot` 改为 **profile 条目 id `dsh-qq-bot`**
  （条目被改名时回退到「以 qq-bot 结尾」的唯一匹配）；按 0.1.7 的要求在 `inject` 里声明
  `remote` 与 `remote.settings`。
- **设置页归属**：用 `settings.configure({ auto: false }, ctx.fiber)` 声明「本插件的设置页由
  自带的『QQ 机器人』选项卡负责」，避免 DSH 再按 schema 自动生成一个重复页面。
- **依赖**：新增运行时依赖 `@deepseek-ai/schemastery@^3.18.4`（`Config` 必需；
  3.18.2 及更早没有 `.volatile()`）。
- **Windows 修复**（0.6.0 只在 Linux 验证过）：
  - 测试里 `import(path.join(...))` 在 Windows 上报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`，
    改用 `pathToFileURL()`；
  - `PROFILE_MODULES` 不再写死 `/home/dsh/.dsh/profiles/node_modules`，可用
    `DSH_PROFILE_MODULES` 覆盖；
  - 测试清理临时软链时不再对 junction 用 `fs.rmSync(recursive)`（会把目标目录删空），
    改用 `rmdirSync` / `unlinkSync`。
- 测试：**124 项全绿**。新增契约断言：`client.js` 里每个表单字段都必须是 volatile、
  `volatileForm(Config)` 非空、`accessToken` 是 secret、内部字段不进设置页；
  以及热更新断言（volatile 就地更新 → 重启适配器；非连接类改动不重启）。

## 0.6.0

- **访客工具闸**：非拥有者的消息驱动 Agent 时，禁用 DSH 内部工具（bash / 读写 / 子代理 / …）。
  实现为 `tools.guard`，只在建会话时注册一次，判据是可变标志位——因此不注入提示词、
  不改工具表、不记 `request/header`，**0 额外 token**，且保持单会话单历史。
- 采用**白名单**而非黑名单（`auth.guestToolAllow`，默认 `qqbot,qqgroup`），
  使 `run_code` 这类"不在全局层"的 PTC 保留传输也自动被挡。
- 会话分流（`ownerPreset` / `guestPreset`）**降级为可选的人格分离**，默认关闭；
  文档与设置页明确标注它不再是安全边界。
- 设置页新增「允许非拥有者使用 DSH 内部工具」「访客仍可用的工具白名单」。

## 0.5.0

- **权限模型重做**，改为三路并行取并集：
  1. 静态名单：`auth.owners`（拥有者，含永久授权）、`auth.superAdmins`（后台设定的高级管理员）
  2. 动态授权：群维度、可带时限，由拥有者或本群管理员授予，**不可跨群生效**
  3. 本群身份：`get_group_member_info` 查到 admin / owner
- 新增 `/whoami`、`/perms`、`/grant`、`/revoke`、`/grants`；权限来源会如实列出。
- **指令严格匹配**：前缀必须在消息首位；动词必须完全匹配；token 数必须落在
  该指令声明的 `[min,max]` 内，多余内容判为用法错误且不执行——防止聊天内容夹带
  指令样内容被误执行。
- Agent 工具 `qqgroup` 改用同一套鉴权，"说话人"取自本会话最近一条消息。
- **reply 透传**：适配器解析 `[CQ:reply,id=…]` 并输出 `reply_to`，
  `/recall` 因此支持"回复某条消息即可撤回"；同时 reply 段不再污染正文
  （否则正文以 `[回复]` 开头，斜杠就不在首位了）。

## 0.4.0

- 新增群管理：QQ 侧指令（`/mute`、`/kick`、`/banall`、`/card`、`/admin`、`/recall`、
  `/rename`、`/members`、`/info`、`/help`）+ Agent 工具 `qqgroup`。
- 适配器新增**通用 action 通道**，任意 OneBot 11 动作都可透传，无需为每个动作改代码。
- `notice` / `request` 事件改为**全字段透传**（此前丢了 `operator_id`、`duration`、
  `target_id`、`card` 等群管理必需字段）。
- 引入「演练模式」`admin.dryRun`：只回复将执行什么，不真执行。

## 0.3.2

- **修复** `registration.schema.toJSON is not a function`：设置命名空间的 schema
  必须同时是可调用的解析函数和可 JSON 化的对象。
- `access_token` 改为**只写字段**：不上发到浏览器，留空即不修改（避免保存时被清空）。
- **修复**保存成功后按钮卡在「保存中…」（`setSaving(false)` 漏在成功分支）。

## 0.3.1

- 文档补充升级注意事项：`dsh plugin add` 走 pnpm，按 tarball 完整性缓存，
  改代码必须打成**新版本号文件名**再装，否则会被判成 lockfile 最新而跳过。

## 0.3.0

- 新增**客户端半边**：在 DSH「设置」里贡献「QQ 机器人」选项卡，配置项全部可视化修改。
- 手写客户端 bundle（`window.__ModuleLoader__.load`），只 `require('react')`，无需打包器。
- 配置分两层：composition 行配置是 base 层，设置面板改的是用户层。

## 0.2.0

- 首个可安装的插件包：`dsh plugin --profile web add` 即自动注册为 profile 层。
- OneBot 11 适配器（零 npm 依赖，用 Node 22 内置 `WebSocket` / `fetch`）：
  正向 WebSocket 收事件 + HTTP API 发消息，自带指数退避重连与发送限速。
- 每个 QQ 会话对应一个 DSH Agent，会话落盘并出现在 Web UI。
- 群聊默认要求 @机器人，私聊直接回，长回复按换行分片。

## 0.1.0

- 未发布的原型：以「动态 Cordis Package」形式在运行的 DSH 进程里验证了完整链路
  （`examples/dynamic-package-host.js` 保留了这一形态）。
