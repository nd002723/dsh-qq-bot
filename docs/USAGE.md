# 使用细节

> 从 README 拆出来的操作细节：连接模式、权限与指令、表情包图库、排错手册。
> 主干说明见 [README](../README.md)，配置字段全集见 [DEVELOPMENT.md](DEVELOPMENT.md#3-完整配置参考)。

## 连接模式细节


| 场景 | 用哪个 | 配置 |
| --- | --- | --- |
| 协议端与 DSH 同机 / 同容器 | **正向 WS**（默认） | `mode: forward`，我们连 `ws://127.0.0.1:3001` |
| 协议端在别的容器 / 只能它连出来 | **反向 WS** | `mode: reverse`，协议端填 `ws://<DSH主机IP>:6199/` |

反向 WS 默认监听 `0.0.0.0:6199`，但**只有配了 `onebot.accessToken` 才会真的对外监听**：没有 token 时强制退回 `127.0.0.1`，
避免一个无鉴权的 WS 口暴露在局域网上。鉴权接受请求头 `Authorization: Bearer <token>` 或 URL 上的 `?access_token=<token>`。
其它协议的连接参数（`protocols.onebot12` / `protocols.satori` / `protocols.milky` / `protocols.qqOfficial`）在设置页同名分组里。


## 权限与指令

权限是**三路并行取并集**，任一路给到即拥有（`/whoami`、`/perms` 会如实列出来源）：

| 路径 | 谁 | 能做什么 |
| --- | --- | --- |
| `auth.owners` | 拥有者 | 全部权限 + **永久授权** + 可走独立的拥有者会话。**必填**（fail-closed） |
| `auth.superAdmins` | 后台设定的高级管理员 | 群管理权限（不能永久授权） |
| 动态授权 | 被临时授权的人 | 仅被授予的项，**仅限本群**、带时限 |
| 本群身份 | 该群的管理员 / 群主 | 群管理权限（可用 `admin.requireGroupAdmin` 关掉） |

非拥有者默认不能用 DSH 内部工具（`auth.guestToolAllow` 之外一律拦），确实要放开再改 `auth.guestDshTools`。

<details>
<summary>指令表（不需要 @，但前缀必须在消息首位）</summary>

| 指令 | 权限 | 作用 |
| --- | --- | --- |
| `/help` `/whoami` | — | 指令表 / 我的身份与权限来源 |
| `/perms [@某人]` `/members` `/info` | query | 权限来源 / 成员列表 / 群信息 |
| `/grant @某人 权限[,权限] [分钟\|forever]` `/revoke` `/grants` | grant | 本群动态授权（永久授权只有拥有者能给） |
| `/mute` `/unmute` `/kick` `/recall` | mute / kick / recall | 禁言、解禁、踢人、撤回（回复某条再发 `/recall` 可省 id） |
| `/banall on\|off` `/card` `/admin` `/rename` | settings | 全员禁言 / 名片 / 管理员 / 群名 |

</details>


## 表情包图库

**目录就是图库**，插件不搬运任何文件：子目录 = 系列，索引写在目录根部的 `index.json`（每张图的 sha1 + 系列 + 标签 + 描述）。
在设置面板「能力 → 表情包」里开关、选目录、配打标模型；卡片只在启用后展开。

<details>
<summary>目录结构、增量规则与发送闸门</summary>

```
QQ_msg/sticker/                 ← 默认目录（sticker.dir 可改成任意路径）
├── index.json                  ← 索引
├── 猫猫/                        ← 一个子目录 = 一个系列
│   ├── 无语.jpg
│   └── 鼓掌.jpg
└── 模糊.jpg                     ← 直接放根部的图算「未分系列」
```

**增量重建（省 token 的关键）**：先比 `size + mtime`，没变不读内容 → 可疑/新增才算 sha1，哈希相同视为没变 →
**改名 / 换系列 / 复制一份**按 sha1 认领旧标签（日志里记作「认领」）→ 只有哈希真变了才重新交给视觉模型。

**其它**：单张上限 10 MB；GIF 默认原样发给模型，`gifCompat` 打开则在本地解首帧转 PNG；坏掉的 `index.json` 当作「没有索引」自愈；
`rebuild` 会扫盘并可能调模型，只给拥有者；访客默认能用 `send`（只发当前会话），重建索引仍只认拥有者。

**发送闸门**：`sticker.chance`（默认 0.3，模型自己想配图时真发的概率）、`maxPerHour`（默认 6，每群每小时上限）、
`dupTTLHours`（默认 24，同图去重）。你明确要一张时不受概率与去重限制（每小时上限仍生效）。

</details>


## 排错手册

### 日志一直「OneBot 未连接」

NapCat 的「正向 WebSocket」是否开在 `onebot.wsUrl`；reverse 模式下 NapCat 是否指向 `ws://<DSH>:6199/`；防火墙；token 是否一致。

### 能连上但收不到消息

OneBot 版本要选 **v11**；不能只开 HTTP，必须开正向或反向 WS。

### 群里 @ 了也不回

`group.enabled`、`group.allow` 白名单、`self_id` 是否一致（`logAdapterFrames: true` 看原始帧）。

### 回「（本轮没有产生文字回复：…）」

括号里是 `turn/end` 的原因，据此定位（模型路由、额度、工具报错）。

### 回「（发得太快了：一分钟内最多 N 条…）」

入站限流：同一会话里同一个人每分钟最多驱动 N 个回合（默认 20，设置页「每人每分钟最多几条」）。只有真正驱动回合的消息才计数。

### 发送失败

NapCat 的 HTTP 服务器（默认 3000）是否开着；`accessToken`；看 DSH Host 日志里的「发送失败」。

### 网页端整个插件报错 / 设置面板空白

0.12.1 的已知问题，升到 **0.12.2** 及以上即可。

### 日志在哪

插件前缀 `[dsh-qq-bot]`，适配器前缀 `[dsh-qq-bot]/adapter`，都打到 DSH Host 的 stdout。

> 本插件**不与 AstrBot 同时接**：AstrBot 也是 OneBot 的消费方，两边一起接会让同一条消息被两个大脑各回一次。
> 对端只要是 OneBot 11 实现（NapCat / OneDisc / Lagrange）就行。


## 许可

见 [LICENSE](../LICENSE)。
