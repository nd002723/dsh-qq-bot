# 架构与改动指南

给**要 fork 下来自己动手改**的人看。

目标：让你在 15 分钟内知道「要改的东西在哪」「为什么这么写」「别踩哪些坑」。
函数名与常量名都和源码一致，可以直接搜。

---

## 0. 一分钟总览

```
QQ 客户端
   │ QQ NT 协议
   ▼
NapCat / OneDisc / Lagrange …          ← 独立项目，本项目不包含
   │ OneBot 11：正向 WS / 反向 WS + HTTP API
   ▼
lib/onebot-adapter.mjs                 ← 独立子进程；只懂协议，不懂业务
   │ stdin/stdout，换行分隔 JSON
   ▼
lib/index.js（Cordis 插件，Host 侧）    ← 业务全在这
   │  ├─ sessionController → DSH Agent → 模型
   │  └─ lib/client.js（浏览器）→ 设置页
   ▼
DSH Agent
```

**两条贯穿全局的设计红线：**

1. **适配器只管协议，插件只管业务。** 想换 IM / 换协议，只改适配器；想改行为、权限、回复策略，只改插件。
2. **越权一律 fail-closed。** 权限判不出来就拒绝；工具闸装不上就拒绝驱动。没有「默认放行」的分支。

---

## 1. 文件职责地图

| 文件 | 职责 | 你大概多久会动它 |
| --- | --- | --- |
| `lib/onebot-adapter.mjs` | OneBot 11 传输层。正向/反向 WS、HTTP API、帧编解码、重连、发送限速 | 换协议或加协议动作时 |
| `lib/index.js` | 全部业务：配置、权限、指令、回复、工具、子进程监管 | 改行为，**最常动** |
| `lib/client.js` | 浏览器侧：设置面板的一个选项卡 | 加/改设置项时 |
| `cordis.patch.yml` | bundle 补丁，把插件插进 profile 组合树 | 几乎不动 |
| `test/mock-onebot.mjs` | 零依赖 OneBot 11 模拟器（手写 RFC 6455 帧编解码） | 要模拟新动作/新事件时 |
| `test/test-*.mjs` | 5 个测试套件，共 124 项 | 每次改动后 |
| `examples/dynamic-package-host.js` | 同一套逻辑的「动态 Package」形态，不装包即可在运行中的 DSH 里跑 | 想快速试改时 |

**只有 `lib/` 和 `cordis.patch.yml` 会进 npm 包**（见 `package.json` 的 `files`）。测试与示例只在仓库里。

---

## 2. 一条消息的完整旅程

### 2.1 普通聊天消息（走模型）

| 步骤 | 位置 | 做什么 |
| --- | --- | --- |
| 1 | `onebot-adapter.mjs` → `onLinkMessage` | 收到 WS 帧，判断是事件还是 action 回执 |
| 2 | `dispatchMessage` | 归一化：`normalizeMessage` 把 CQ 字符串或消息段数组压成 `{text, images, replyTo}` |
| 3 | 同上 | `emit({type:'message', …})` 写 stdout |
| 4 | `lib/index.js` → `spawnAdapter` 里的 `proc.stdout.on('data')` | 按行切 JSON |
| 5 | `onAdapterFrame` | 分发到 `acceptMessage` |
| 6 | `acceptMessage` | 自过滤 → **群指令优先**（`handleAdminCommand`）→ 白名单 → @ 门 → 前缀 → 取 `sessionRoute` → 取 `getEntry` → 记 `entry.speaker`（`resolveAuthority`）→ 入队 |
| 7 | `runTurn`（串行队列内） | 设 `entry.dshAllowed`；`agent.followup(msg)` → `agent.whenIdle()` |
| 8 | `extractReply(agent)` | 从会话日志里取最新一条有文本的 assistant 消息 |
| 9 | `sendReply` → `chunkText` | 分片后写适配器 stdin |
| 10 | 适配器 `enqueueSend` → `pumpSends` → `callHttpApi` | 退化为 `send_group_msg` / `send_private_msg` |

**为什么要串行队列**（`entry.queue`）：同一个 QQ 会话的回合必须一条一条来，否则
`whenIdle()` 会等错回合、`entry.dshAllowed` 会互相覆盖。看第 7 步的注释。

### 2.2 管理指令（**不经过模型**）

`acceptMessage` 第 6 步里，`handleAdminCommand` 在任何模型相关逻辑之前就拦截掉了：

```
handleAdminCommand
  ├─ admin.enabled？
  ├─ 前缀在首位？          ← 必须 text 首字符（前面只允许空白）
  ├─ 动词已知？            ← 未知动词 return false，照常交给模型
  ├─ token 数在 [min,max]？ ← 见 COMMAND_ARITY，多余内容直接判用法错误
  ├─ resolveAuthority → hasPerm(COMMAND_PERMISSION[verb])？
  ├─ planAdminCommand → {action,params} | {local} | {error}
  └─ runGroupAction → callAdapterAction → 回执
```

---

## 3. 关键数据结构

### 3.1 配置：一个 schema，三层来源

DSH ≥ 0.1.7 的写法：插件**导出 schemastery 的 `Config`**，DSH 拿它当设置表单，把
「composition 行配置 → profile 的 `cordis.patch.yml` → schema 默认值」合并求值后，
把**求值结果**作为 `apply(ctx, config)` 的第二个参数交给插件。

```js
export const Config = Schema.object({
  mode: Schema.union([Schema.const('forward'), Schema.const('reverse')]).default('forward').volatile(),
  onebot: Schema.object({ wsUrl: Schema.string().default('ws://127.0.0.1:3001').volatile(), /* … */ }),
  // …
});
```

三条必须记住的规则：

1. **可编辑字段必须标 `.volatile()`**。`settings` 的 `volatileForm()` 只投影 volatile 字段；
   一个 volatile 字段都没有时 `describe()` 直接跳过这个条目——**设置页里根本不会出现它**。
   `write()` 也会对非 volatile 路径抛 `Config field "x" is not volatile`。
2. **volatile 字段在运行时是引用**，不是值：`config.onebot.wsUrl.get()`。`lib/index.js` 里的
   `plainConfig()` 把整棵配置还原成普通对象，再和 `DEFAULTS` 合并。
3. **volatile-only 变更不会重挂插件**。`cordis-plugin-loader` 只就地更新运行中 fiber 的配置引用，
   然后发 `loader/volatile-update`。所以插件自己监听该事件刷新 `CONFIG`，并决定何时重启适配器。

> ⚠️ `adapterPath` / `nodePath` / `restart` / `reply.firstTurnHint` 故意**不标 volatile**：
> 它们不进设置页，改动走「整体重挂插件」这条更稳的路径。

`CONFIG` 是个 `let`，由 `resolveConfig()` 整体刷新——所以你能在任意函数里直接读 `CONFIG.xxx`
而永远拿到最新值，不必到处传参。`workspace` / `adapterPath` 这类值用 `currentWorkspace()` /
`currentAdapterPath()` 现取，避免快照过期。

### 3.2 会话条目 `state.convos`

key 形如 `group-33333`、`private-22222`（或分流时的 `group-33333@guest`），value：

```js
{
  key, sessionId, agent,          // § getEntry
  turns, generation,              // generation 用于 interrupt 作废排队任务
  queue,                          // 串行队列（Promise 链）
  ready,                          // 建会话的 Promise（防并发重复建）
  speaker: { userId, groupId, tier, owner, sources },  // 最近一条消息的说话人
  groupId,
  dshAllowed, liftGuard, guardUnavailable,             // § 访客工具闸
}
```

### 3.3 权限 `resolveAuthority` 的返回值

```js
{ tier, owner, userId, groupId, perms: Set, sources: [ '拥有者' | '本群管理员' | '动态授权[...]' | … ] }
```

`tier` 取值：`owner` / `super` / `group-admin` / `granted` / `guest`。
`sources` 是给人看的来源说明，`/whoami`、`/perms` 就是把它打出来。

### 3.4 适配器 ↔ 插件 的 stdio 协议

**上行（stdout，适配器 → 插件）**

| type | 关键字段 |
| --- | --- |
| `hello` | mode / wsUrl / listen / httpUrl / pid |
| `listening` | host / port（仅反向模式） |
| `status` | connected / reason / links / mode |
| `message` | message_type / group_id / user_id / self_id / **text** / images / **reply_to** / sender / message |
| `notice` | notice_type / sub_type / user_id / group_id / **operator_id** / **target_id** / **duration** / card / file / message_id / **raw** |
| `request` | request_type / sub_type / user_id / group_id / comment / flag / raw |
| `send_result` | ok / message_id / error / echo |
| `action_result` | action / echo / ok / retcode / **data** / error |
| `log` / `error` / `pong` / `heartbeat` | — |

**下行（stdin，插件 → 适配器）**

| type | 说明 |
| --- | --- |
| `send` | `{message_type, target_id, text}` 或 `{…, message:[段数组]}`；走发送队列（限速） |
| `action` | `{action, params, echo}` 任意 OneBot 动作；**不走发送队列**，结果带 `data` 回来 |
| `ping` / `shutdown` | — |

> 加协议动作时，**优先用 `action` 通道**——它是通用的，不需要改适配器。

---

## 4. 设计决策与「为什么」（含踩过的坑）

| 决策 | 为什么 | 踩过的坑 |
| --- | --- | --- |
| 适配器单独跑子进程 | DSH 动态插件沙箱里没有 `fetch`/`WebSocket`/`require`/`setTimeout`，全被拦成报错 | — |
| 用 `sessionController.create()` + `resolveAgent()` 建会话 | **直接 `agentLoop.create()` 不装模型路由**（agentOptions 为空、没挂 preset），第一次模型请求必然失败 | 第一版就是这么写的，回复永远是空的 |
| 回复用 `whenIdle()` + `deriveMessages()` | 回合串行，结束后日志里最新一条有文本的 assistant 消息就是本轮回复。比订阅作用域流式事件简单也更稳 | — |
| `notice`/`request` 整包带上 `raw` | 群管理需要 `operator_id`（谁操作的）、`duration`（禁言多久）、`target_id`，只给扁平字段会漏 | 第一版丢了这些字段，事件没法用 |
| 访客工具闸用 `tools.guard` | 注册在 `agent.ctx` 上只作用于该 agent；**每次执行才求值**，所以配一个可变标志位就够，不需要按消息增删 | 拆会话会破坏对话一致性；`restrict` 是静态过滤器，按消息增删会造成工具面抖动、多记 `request/header`、白费 token |
| 工具闸用**白名单** | `run_code`（PTC 保留传输）「不在全局层」，黑名单很容易漏 | — |
| 标志位在 `runTurn` 内设置 | 在接收入口设会被排队的两条消息（先拥有者后访客）互相覆盖，导致用错权限 | — |
| 指令严格匹配 | 防止聊天里夹带 `/mute …` 被误执行 | — |
| `reply` 段不写进正文 | 写 `[回复]` 会让「回复某条消息 + `/recall`」的正文以 `[回复]` 开头，**斜杠就不在首位**，指令永远匹配不上 | 这是实测出来的 bug |
| 设置改成 `Config` + `.volatile()` | 0.1.7 的 `settings` 直接读插件条目的 `Config` schema，`settings.register` 已删除 | 不标 `.volatile()` 的字段不进表单、也存不下去；没有 volatile 字段则整个条目不出现 |
| 设置命名空间 = **profile 条目 id** | `describe()` 用 `entry.options.id` 当 `ns` | 0.1.6 的自定义命名空间（`qq-bot`）在 0.1.7 上找不到任何东西；客户端因此改成 `dsh-qq-bot` 并带回退匹配 |
| `access_token` 标为 schema 的 `secret` | 值不下发到浏览器；界面渲染成只写输入框 | 只写字段读回来是 `undefined` 而输入框是 `''`，按普通 diff 会提交空值**把 token 清空**，所以客户端有专门护栏 |
| 客户端 bundle 手写 | 只要 `require('react')`，格式是 `window.__ModuleLoader__.load({id,factory})`，**不需要打包器** | — |
| `dsh.client.inject` 只声明 `@deepseek-ai/dsh-client-ui-settings` | 该包声明 `settings.section` 插槽；运行时 `inject` 还必须带上 `remote` 与 `remote.settings` —— `dsh-client-ui-settings` 明确要求每个使用方自己声明它们 | 不声明就拿不到设置 Remote，选项卡会一直显示「拿不到设置服务」 |

---

## 5. 分步改动指南（重点）

### 5.1 加一条 QQ 侧指令

以 `/warn @某人 原因` 为例，**只改 `lib/index.js`**，四处：

1. `COMMAND_ARITY` 加 `warn: [3, Infinity]`（token 数范围）
2. `ADMIN_USAGE` 加说明文字（`/help` 会自动带上）
3. `COMMAND_PERMISSION` 加 `warn: 'mute'`（复用已有权限，或先在 `PERMISSION_LIST` 加新权限）
4. `planAdminCommand` 里加分支：

```js
if (verb === 'warn') {
  const target = pickTarget(parts, 1);
  const reason = parts.slice(2).join(' ').trim();
  if (target === null || reason === '') return { error: '用法：' + ADMIN_USAGE.warn };
  return {
    action: 'send_group_msg',                                   // 任意 OneBot 动作
    params: { group_id: toId(groupId), message: [{ type: 'text', data: { text: '⚠️ ' + target + '：' + reason } }] },
    describe: '警告 ' + target + '（' + reason + '）',
  };
}
```

完事。`handleAdminCommand` 会自动处理鉴权、严格匹配、dry-run、回执。
**不需要动适配器**——`action` 通道是通用的。

### 5.2 加一个 Agent 工具动作

以给 `qqgroup` 加 `set-title` 为例，在 `lib/index.js` 里：

1. `TOOL_PERMISSION` 加 `'set-title': 'settings'`
2. `plans` 对象加一项：

```js
'set-title': () => ((groupId === null || uid === null) ? null : {
  action: 'set_group_special_title',
  params: { group_id: toId(groupId), user_id: toId(uid), special_title: args.text ?? '' },
}),
```

3. 工具的 `description` 里补上这个 action 名（模型是照着它选的）

### 5.3 加一个任意 OneBot 动作

只要对端支持，`callAdapterAction('some_action', {…})` 直接就能用，**两端都不用改**。

### 5.4 改权限模型

- 加权限种类：`PERMISSION_LIST` + `PERMISSION_LABEL`
- 改三路来源的判定：`resolveAuthority(userId, groupId)` 里的「路由 1/2/3」
- 加永久授权之类只有拥有者能做的事：看 `planAdminCommand` 的 `grant` 分支怎么用 `authority.owner`
- 群范围限制：`manageableGroups()` / `groupInScope()`

> 记住：**群维度**的权限（动态授权、群管理员）都必须带上 `groupId`，否则会跨群泄漏。

### 5.5 加一个设置项

**三处都要改**，少一处就看不到或存不下去：

1. `lib/index.js` 的 `DEFAULTS` 加默认值（离线兜底）
2. `lib/index.js` 的 `Config` schema 加同名同路径的字段，**并标 `.volatile()`**（决定设置页能不能出现、能不能保存）
3. `lib/client.js` 的 `FIELDS` 加一行：

```js
{ path: ['reply', 'foo'], label: '显示名', kind: 'bool', hint: '说明文字' },
```

`kind` 可选：`bool` / `text` / `password` / `number` / `select`（要配 `options`）/ `list`（逗号分隔数组）。
保存时会按字段算 diff，用 `mutate` 的路径操作下发，带 `revision` 做乐观并发。

> 客户端改动后要**刷新浏览器页面**才生效；Host 改动要**重启 `dsh web`**（volatile 字段之外的改动会重挂插件）。
>
> `test-plugin.mjs` 里有一条契约断言：它会从 `lib/client.js` 抠出所有 `FIELDS` 的 path，
> 逐条确认在 `Config` 里都是 volatile。新增设置项忘了第 2 步就会在那里挂掉。

### 5.6 换掉 OneBot，接别的协议

只需要新写一个适配器，保持 stdio 协议（§3.4）不变，然后改 `CONFIG.adapterPath` 指向它。
`lib/index.js` 一行都不用动。

---

## 6. 调试手册

### 6.1 单独跑适配器（不碰 DSH）

```sh
# 终端 A：起一个假 OneBot（端口正好是 NapCat 默认值）
node test/mock-onebot.mjs --http-port 3000 --ws-port 3001

# 终端 B：手动跑适配器，直接看 stdio 帧
node lib/onebot-adapter.mjs --ws ws://127.0.0.1:3001 --http http://127.0.0.1:3000 --heartbeat-ms 0
# 然后手打一行 JSON 回车，例如：
# {"type":"send","message_type":"group","target_id":"33333","text":"hi"}
# {"type":"action","action":"get_group_list","params":{}}
```

### 6.2 看每一帧

- **插件配置**：把 `logAdapterFrames` 设成 true → 每帧 JSON 都打进 DSH Host stdout，前缀 `[dsh-qq-bot]`
- **适配器自查**：所有上行帧都有 `type`，先看 `status` 的 `connected` 与 `reason`
- **反向模式**：适配器会发 `listening` 帧带上真实端口，拿它去 NapCat 里填

### 6.3 常见故障 → 先看哪里

| 现象 | 先看 |
| --- | --- |
| 一直「未连接」 | 适配器的 `status.reason`；正向模式看 `onebot.wsUrl` 是否真有服务在监听；反向模式确认 NapCat 指向了 `listening` 报的那个端口 |
| 连上了但没消息 | 对端 OneBot 版本要选 **v11**；只开 HTTP 不够，必须开 WS |
| 群里 @ 了不回 | `group.requireAt` / `group.allow`；`logAdapterFrames` 看 `self_id` 是否和消息里的 `self_id` 一致（**别把自己的 QQ 号设成机器人号**，会被自过滤掉） |
| 回复是「（本轮没有产生文字回复：…）」 | 括号里就是从会话日志读出的 `turn/end` 原因（`lastTurnReason`），据此定位模型/额度/工具报错 |
| 指令没反应 | 前缀是否在**消息首位**；`ADMIN_VERBS` 里有没有这个词；token 数是否超了 `COMMAND_ARITY` |
| 指令被拒 | 回复里会写明**身份与来源**和**缺哪项权限**，照着补 `auth.owners` / `auth.superAdmins` / 动态授权 |
| 访客用不了工具 | 那是**设计如此**（`auth.guestDshTools` 默认 false）；日志里会有「访客工具闸拦截：<工具名>」 |
| 设置页里没有这个插件 | 条目 id 与客户端 `NS` 不一致（客户端会报「设置里找不到条目」），或者 `Config` 里一个 volatile 字段都没有 —— 后者会让条目被 `volatileForm()` 直接过滤掉（见 §3.1） |
| 保存设置报错 | 字段没标 `.volatile()`（`Config field "x" is not volatile`），或另一个编辑器改过配置导致 `revision` 过期（`SETTINGS_CONFLICT`） |

### 6.4 加测试

每个测试套件都是「零依赖 + 自带假对端」，照抄现成的骨架即可：

- 加协议行为 → `test-adapter.mjs`（配 `mock-onebot.mjs`）
- 加业务行为 → `test-admin.mjs`（有假 ctx、假 agent、真适配器）
- 加设置项 → `test-client.mjs`（模拟 `__ModuleLoader__` + 最小 React，会真渲染一次）

`test/mock-onebot.mjs` 想模拟新动作时，往 `groupActions` 里加一个处理器就行，会自带记录（测试用 `mock.actions` 断言）。

---

## 7. 术语表

| 词 | 含义 |
| --- | --- |
| **OneBot 11** | 聊天机器人应用层协议标准。本项目实现对它的**客户端**侧 |
| **正向 WS** | 本项目主动连对端（同机/同容器最简单） |
| **反向 WS** | 对端主动连本项目（跨容器/跨网络更好用） |
| **CQ 码** | OneBot 的旧式内联标记，如 `[CQ:at,qq=123]`；适配器会把字符串与消息段数组统一归一化 |
| **`self_id`** | 机器人自己的 QQ 号，用来识别 @ 与过滤自己发的消息 |
| **`operator_id`** | 「谁执行了这个操作」（禁言/踢人事件里的操作者） |
| **`reply_to`** | 被引用消息的 id，`/recall` 靠它工作 |
| **`ctx.subprocess`** | DSH 服务：拉起并监管子进程 |
| **`ctx.sessionController`** | DSH 服务：创建/取出会话 Agent 的**官方组装路径** |
| **`ctx.timeout`** | DSH 的定时器（需 `inject: ['timer']`） |
| **`tools.guard`** | DSH 工具执行前的单调闸：返回字符串即拒绝 |
| **`Config`** | 插件导出的 schemastery schema；DSH ≥ 0.1.7 用它承载设置表单 |
| **`.volatile()`** | 标记「可热改」的字段。只有 volatile 字段能进设置页、能被保存 |
| **`loader/volatile-update`** | volatile 字段被改动后 `cordis-plugin-loader` 发出的事件（就地更新，不重挂插件）；插件据此刷新配置 |
| **profile 条目 id** | 设置命名空间就是它（本插件默认 `dsh-qq-bot`），写在 profile 的 `cordis.patch.yml` 里 |
| **tier** | 说话人的身份档位：owner / super / group-admin / granted / guest |

---

## 8. 已知的坑 / 不要做的事

1. **别用 `agentLoop.create()` 建会话。** 用 `sessionController`（原因见 §4）。
2. **别把动态工具注册写成静态 `import`。** 用动态 `import('@deepseek-ai/dsh-tools')` + try/catch，缺了也只是少一个工具而不是整包加载失败。
3. **别在接收入口设 `entry.dshAllowed`。** 必须在 `runTurn` 里（串行队列内）。
4. **别用黑名单做工具闸。** 用白名单。
5. **别把群维度的权限存成不带 `groupId` 的键。** 会跨群泄漏。
6. **别改包内的 `cordis.patch.yml` 当配置用**——升级会被覆盖。用户配置写 profile 的 `cordis.patch.yml`。
7. **改了代码要打成新版本号文件名再 `dsh plugin add`**：pnpm 按 tarball 完整性缓存，同名会被判成 lockfile 最新而跳过。
8. **别把 `dist/*.tgz` 提交进 git**（已在 `.gitignore` 里）；发布时挂到 GitHub Release。
9. **别再用 `ctx.settings.register()`** —— DSH 0.1.7 已移除（`settings-file` 包被删）。设置一律走插件自己的 `Config` schema。
10. **别忘 `.volatile()`**：可编辑字段不标 volatile，条目不进设置页、保存被拒；`test-plugin.mjs` 的契约断言会兜住这一点。

---

## 9. 项目坐标

- 作者：[@arrow1031](https://github.com/arrow1031)
- 个人网站：<https://sputnikzaychik.icu> · QQ 群：[1091766276](https://qun.qq.com/universal-share/share?ac=1&authKey=z%2FlfWodgOvkDnUTzUZ3%2BNoYGInkfTKCyMfmxO8uyGa%2Bx%2BKmF4ILvUvzqSb6mEJoE&busi_data=eyJncm91cENvZGUiOiIxMDkxNzY2Mjc2IiwidG9rZW4iOiJuY0Z3eEkzeUJWUkROYUNwWnNhblY3VlQrWWh1NURVbDZlUDRZNHZKSFlGWEJnOFRhazB6VUVaV0ZoMzVZVjg2IiwidWluIjoiMzE5NTQzODg2In0%3D&data=qPi85PPH3R-8HaJ9_U2u0zi7KCjzwplsRb-xisY3XAiBsWzopanij924BvV0sfj_cspqyTWemKx0YnNIHTjjGQ&svctype=4&tempid=h5_group_info)
- 致谢：[NapCat](https://napneko.github.io/)（灵感 / OneBot v11 接口 / 文档）· [梁圣](https://www.deepseek.com/)（忠！橙！）
- 许可：[MIT](LICENSE)
- **维护状态：不承诺更新，有问题请 fork 自行修改**（见 README 的「维护状态」一节）
- 生成方式与验证情况：[AI-DISCLOSURE.md](AI-DISCLOSURE.md)
