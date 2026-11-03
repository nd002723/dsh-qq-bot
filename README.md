# dsh-qq-bot —— 把 QQ 接到 DSH

<p align="center"><img src="assets/banner.svg" alt="dsh-qq-bot：把 QQ 接到 DSH Agent（五种协议 / 群聊私聊 / 动态码工具授权 / 记忆人设）" width="100%"></p>

[![CI](https://github.com/arrow1031-dev/dsh-qq-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/arrow1031-dev/dsh-qq-bot/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40sputnikzaychik%2Fdsh-qq-bot?label=npm)](https://www.npmjs.com/package/@sputnikzaychik/dsh-qq-bot)
[![npm downloads](https://img.shields.io/npm/dm/%40sputnikzaychik%2Fdsh-qq-bot?label=%E4%B8%8B%E8%BD%BD)](https://www.npmjs.com/package/@sputnikzaychik/dsh-qq-bot)
[![tests](https://img.shields.io/badge/tests-1775%20passing-brightgreen)](docs/DEVELOPMENT.md)
[![node](https://img.shields.io/badge/node-%E2%89%A522.6-339933)](https://nodejs.org/)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

把一个 QQ 机器人接进 DSH：QQ 消息进来 → 交给 DSH Agent → 回复发回 QQ。

- **一套插件接五种协议**：OneBot 11（默认）/ OneBot 12 / Satori / Milky / QQ 官方机器人，换协议只是设置里的一个下拉。
- **每个群、每个人都有独立的 DSH 会话**，会落盘、能像普通会话一样在 Web UI 里打开继续聊。
- **只有一条运行时依赖**：`@deepseek-ai/schemastery`（DSH 配置 schema 的约定，必须与宿主同版本）；其余全部走 Node 22 内置的 `WebSocket` / `fetch`，适配器是零依赖子进程。

> **版本 0.12.9** · 要求 **DSH ≥ 0.2.0-rc.2**（0.2.1 系列实测通过）
> **设置入口**：首页侧边栏 → **插件 → 已安装 → dsh-qq-bot**。不再是「设置 → QQ 机器人」，**现有配置无需迁移**。
> npm 包名 `@sputnikzaychik/dsh-qq-bot` · [CHANGELOG](CHANGELOG.md) · [AI 生成声明](docs/AI-DISCLOSURE.md) · MIT

## 它能做什么

| 能力 | 说明 |
| --- | --- |
| 收发消息 | 群聊（默认要 @）与私聊；回复 bot 也算 @；长回复按换行切成多条 ≤1200 字 |
| 五种协议 | OneBot 11/12、Satori、Milky、QQ 官方机器人，见[协议与连接方式](#协议与连接方式) |
| 群管理 | 禁言、踢人、撤回、改名片 / 群名、设管理员、全员禁言；指令与工具共用一套权限 |
| 联网与媒体 | `qq_websearch` 多引擎搜索、`qq_webfetch` 抓网页（可走代理）、`qq_imgsearch` 图片反搜、`qq_draw` 生图直接发群 |
| 看图 | 收到的图片用视觉模型识别后并入回答；群内近期图片由 AI 按需自取（不硬塞上下文） |
| 表情包 | 本地目录即图库（子目录 = 系列），`index.json` 索引 + AI 自动打标；AI 用 `qq_sticker` 按标签挑一张发到当前会话，见[表情包图库](#表情包图库可选) |
| 主动发言（可选） | 到点看一眼群里聊什么，自己决定要不要接话；判断与发言可分用两个模型 |
| 流程授权（可选） | 子代理 / 队友 / 工作流 / 第三方抓取（`moli_fetch`）被拦下时，私聊回一次 6 位动态码才放行；改「哪些工具要码」的名单、或开关流程授权本身，也要一次码（设置页「高级 → 闸门区」，填码解锁、保存即消费） |
| 人格 | 每个 QQ 会话可套自定义人格，或指定专属 agent preset |

## 快速开始

### 1. 起一个 OneBot 11 协议端（推荐 NapCat）

NapCat 官方 Docker 镜像（支持 amd64 / arm64）：

```sh
docker run -d --name napcat --restart=always \
  -e NAPCAT_GID=$(id -g) -e NAPCAT_UID=$(id -u) \
  -p 3000:3000 -p 3001:3001 -p 6099:6099 \
  mlikiowa/napcat-docker:latest
```

- WebUI：`http://<主机IP>:6099/webui`，手机 QQ 扫码登录；登录 token 默认在 `docker logs napcat` 里。
- 容器内 `/app/napcat/config` 与 `/app/.config/QQ` 建议挂卷，免得重启要重新扫码。
- NapCat 的「网络配置」里开 **OneBot 11**：**HTTP 服务器 3000**（发消息）+ **正向 WebSocket 3001**（收事件）。端口默认就和本插件一致，不用改。

### 2. 安装插件

```sh
# 从 npm 装（推荐）
dsh plugin --profile web add @sputnikzaychik/dsh-qq-bot

# 跟随仓库 main（想用最新、未发版的内容）
dsh plugin --profile web add github:arrow1031-dev/dsh-qq-bot

# 升级已有安装
dsh plugin --profile web update
```

`--profile` 换成你实际在用的：桌面版是 `--profile desktop`，`dsh web` 部署一般是 `--profile web`。
也可以在界面里装：**插件 → 添加插件**，填上面那行包名。

装完**重启 DSH**（桌面版重启应用 / CLI 重启 `dsh web`）。`lib/client/settings.js` 是浏览器侧代码，重启后还要**刷新页面**。

### 3. 在 QQ 里试

- **群聊**：默认要 **@机器人**；**回复（引用）bot 的消息**也算 @，带图照常识图。
- **私聊**：默认直接回。
- **中间发言**（默认开）：长回合里模型先说的那几句（「我先查一下」）单独发一条、不引用也不 @；
  最终结论仍按规则引用你的消息。一个回合最多 4 条、两条间隔 2.5 秒，设置页可调，填 0 即关。
- **会话名固定**为 `群聊_<群号>` / `私聊_<QQ号>`，不让模型自动起标题（可在设置里关）。

### 4. 打开设置面板

**插件 → 已安装 → dsh-qq-bot**，面板分四档：**连接** / **基本**（准入与名单、发言与管理）/ **能力**（识图与绘图、搜索与抓取、对话与人格）/ **高级**。
改完点保存：连接项（模式 / 地址 / token）会自动重启适配器，其它项下一条消息生效。

- 白名单是逗号分隔的文本框；布尔是勾选框；provider / model 都是下拉。
- `access_token` 是**只写**字段：已设置时显示「已设置；留空则保持不变」，只有输入新值才覆盖。
- 连接状态不在面板里显示，在对话里让 Agent 调 `qqbot`（`action=status`）看。

## 协议与连接方式

| protocol | 协议端 | 传输 | 备注 |
| --- | --- | --- | --- |
| `onebot11`（默认） | NapCat / go-cqhttp / Lagrange | 正向/反向 WS + HTTP | 与 0.9 的配置完全兼容 |
| `onebot12` | OneBot 12 实现端 | 正向/反向 WS + HTTP | @ 是 `mention`、图片只有 `file_id` |
| `satori` | Koishi（Satori 服务端） | WS `/v1/events` + HTTP RPC | 消息体是类 XHTML 元素串 |
| `milky` | NapCat / Yogurt / Lagrange.Milky | `/event` WS + `/api` HTTP | 无 echo；消息 id 是 `message_seq` |
| `qq-official` | QQ 开放平台机器人 | Webhook 或 WS 网关 | AppID/AppSecret 鉴权；无群管理动作 |

**OneBot 11/12 的两种连接模式**

| 场景 | 用哪个 | 配置 |
| --- | --- | --- |
| 协议端与 DSH 同机 / 同容器 | **正向 WS**（默认） | `mode: forward`，我们连 `ws://127.0.0.1:3001` |
| 协议端在别的容器 / 只能它连出来 | **反向 WS** | `mode: reverse`，协议端填 `ws://<DSH主机IP>:6199/` |

反向 WS 默认监听 `0.0.0.0:6199`（**只有配了 `onebot.accessToken` 才会真的对外监听**：没有 token 时强制退回 `127.0.0.1`，避免一个无鉴权的 WS 口暴露在局域网上）。
鉴权：请求头 `Authorization: Bearer <token>` 或 URL 上的 `?access_token=<token>` 都接受。
其它协议的连接参数（`protocols.onebot12` / `protocols.satori` / `protocols.milky` / `protocols.qqOfficial`）在设置页同名分组里。

**能力边界**：`qq-official` 没有踢人/禁言/改名片这类群管理动作，`qqgroup` 会明确回「不支持」；`onebot12` 的图片段只有 `file_id`，要做视觉识别建议用 OneBot 11。

## 配置

### 方式一：设置面板（推荐）

见上文「4. 打开设置面板」。几个要点：

- **工作区自动管理**：插件读取 DSH 默认工作区位置（`<系统 Documents>/deepseek-harness`），在同级建 `QQ_msg` 并注册为 Web UI 侧栏的「QQ 消息」分组，新 QQ 会话自动归入。带图消息的原图缓存在 `QQ_msg/qq-images/<会话id>/`，会话结算后删除。
- **升级后失效的旧配置会被自动清掉**：插件启动时和每次保存后会比对 schema，把本版本已不存在的键摘掉再写回（只动自己那一段，删掉的键连同旧值打进日志）。
- **设置命名空间 = 条目 id**（默认 `dsh-qq-bot`）；条目被改名时客户端会回退匹配「以 qq-bot 结尾」的那个。

### 方式二：改 profile 的 `cordis.patch.yml`

**不要改包内的 `cordis.patch.yml`**（升级会覆盖）。写进你自己的 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`，按 id 定向覆盖：

```yaml
- id: dsh-qq-bot
  name: '@sputnikzaychik/dsh-qq-bot'   # 装 npm 包时用带作用域的包名；装 git 版也写它
  config:
    protocol: onebot11
    mode: forward
    onebot:
      wsUrl: 'ws://127.0.0.1:3001'
      httpUrl: 'http://127.0.0.1:3000'
      accessToken: ''
    group:
      enabled: true
      requireAt: true
      allow: []            # 群号白名单，空 = 所有群
    private:
      enabled: true
      allow: []            # 用户号白名单，空 = 所有人
    auth:
      owners: ['你的QQ号']  # 拥有者：全权限 + 永久授权
    reply:
      maxChars: 1200
      interim: true        # 中间发言
```

完整字段清单（含主动发言、流程授权、生图、图片反搜、moli 渲染等全部配置项）见 [DEVELOPMENT.md](docs/DEVELOPMENT.md#完整配置参考)。

## 权限与指令

权限是**三路并行取并集**，任一路给到即拥有（`/whoami`、`/perms` 会如实列出来源）：

| 路径 | 谁 | 能做什么 |
| --- | --- | --- |
| `auth.owners` | 拥有者 | 全部权限 + **永久授权** + 可走独立的拥有者会话。**必填**：留空时插件不驱动任何会话（fail-closed），私聊会回一句配置指引 |
| `auth.superAdmins` | 后台设定的高级管理员 | 群管理权限（不能永久授权） |
| 动态授权 | 被临时授权的人 | 仅被授予的项，**仅限本群**、带时限 |
| 本群身份 | 该群的管理员 / 群主 | 群管理权限（可用 `admin.requireGroupAdmin` 关掉） |

**指令**（不需要 @，但前缀必须在消息首位）：

| 指令 | 权限 | 作用 |
| --- | --- | --- |
| `/help` `/whoami` | — | 指令表 / 我的身份与权限来源 |
| `/perms [@某人]` `/members` `/info` | query | 权限来源 / 成员列表 / 群信息 |
| `/grant @某人 权限[,权限] [分钟\|forever]` `/revoke` `/grants` | grant | 本群动态授权（永久授权只有拥有者能给） |
| `/mute` `/unmute` `/kick` `/recall` | mute / kick / recall | 禁言、解禁、踢人、撤回（回复某条再发 `/recall` 可省 id） |
| `/banall on\|off` `/card` `/admin` `/rename` | settings | 全员禁言 / 名片 / 管理员 / 群名 |

**第一次装好必须先填 `auth.owners`**：留空时插件不驱动任何会话（只在你私聊它时回一句「还没配置拥有者」），这是为了避免「装上即对外开放」——默认白名单为空表示「不额外限制」，不先填拥有者，任何人都能拿它跑模型额度、当抓网页的跳板。填好之后再：打开 `admin.dryRun` 在群里试几条指令 → 关掉 dryRun，再按需加 `superAdmins`。
非拥有者默认不能用 DSH 内部工具（白名单 `auth.guestToolAllow` 之外一律拦），确实要放开再改 `auth.guestDshTools`。

## Agent 能用的工具

插件向 DSH 注册 10 个工具（访客只看到白名单里的）：

| 工具 | 用途 |
| --- | --- |
| `qqbot` | 连接状态 / 主动发消息（可带一张本地图片）/ 中断回合 |
| `qqgroup` | 群管理：成员、群信息、禁言、踢人、撤回、名片、群名、管理员、戳一戳 |
| `qq_websearch` | 联网搜索（多引擎组合，走配置的代理） |
| `qq_webfetch` | 抓网页原文，内网地址一律拒绝；可切 Moli 无头浏览器渲染 SPA |
| `qq_imgsearch` | 图片反搜（公网 URL 或本地上传），支持 `kind=comic` 漫画模式 |
| `qq_history` | 读聊天记录（当前群/私聊直读，跨群按权限），窗口内图片自动识别 |
| `qq_draw` | 按描述生图并直接发到当前会话 |
| `qq_sticker` | 表情包图库：按标签/系列找图并发表情；`rebuild` 重建索引（仅拥有者） |
| `qqconfig` | **仅拥有者私聊**：在 QQ 里改白名单 / 发言参数等设置（两步确认） |
| `qqauth` | **仅拥有者私聊**：流程授权的申请与状态查询 |

两条路径分工不同：`qq_webfetch` 的 Moli 渲染分支（含访客可用）由**内网拒绝 + 本地校验代理**保证安全；dsh-moli 的原装工具 `moli_fetch` 不在里面，它只设**一道**验证墙——默认进 `flowAuth.gatedTools`，开关打开后拥有者私聊调用要过一次 6 位动态码。

细节（每个工具的参数、引擎顺序、失败策略）见 [DEVELOPMENT.md](docs/DEVELOPMENT.md#工具细节)。

## 表情包图库（可选）

**目录就是图库**，插件不搬运任何文件：

```
QQ_msg/sticker/                 ← 默认目录（sticker.dir 可改成任意路径）
├── index.json                  ← 索引：每张图的 sha1 + 系列 + 标签 + 描述
├── 猫猫/                        ← 一个子目录 = 一个系列（可以多层）
│   ├── 无语.jpg
│   └── 鼓掌.jpg
└── 模糊.jpg                     ← 直接放根部的图算「未分系列」
```

打开设置页「能力 → 表情包」，卡片里是：

- **启用开关**（`sticker.enabled`）与**目录**（留空 = `QQ_msg/sticker`；相对路径按 `QQ_msg` 解析）；
- **AI 自动标记**（`sticker.autoTag`）：首次使用、或文件内容有变动时，先按哈希比对找出变动的图，**只给这些图**重新打标（标签 + 描述）；没变动的图一个 token 都不吃；
- **GIF 兼容模式**（`sticker.gifCompat`，默认关）：关着的时候动图**原样**交给模型（多数能看图的模型自己会取首帧）；如果哪个模型不认 `image/gif`，打开它就在本地解出第一帧转 PNG 再发；
- **打标 provider / 模型**：留空则跟随「识图与绘图」里的视觉模型（必须是能看图的模型）；
- 状态区：张数、系列、已标记 / 待标记、索引更新时间、后台打标进度；
- 两个按钮：**扫描并打标**（重建 + 补打标签）、**只重建索引**（只算哈希，不调模型）。

卡片只在**启用后**展开这些东西；没启用时整卡收起，只留开关和一行提示，不占设置页的版面。

单张图上限 **10 MB**（`sticker` 组内部的 `MAX_FILE_BYTES`），超大文件跳过不算进索引。

增量规则（也是省 token 的关键）：

1. 先比 `size + mtime` —— 完全没变就不读内容；
2. 可疑或新增的文件才计算 sha1 —— **哈希相同就当作没变**（只 `touch` 过不会重打标）；
3. **改名 / 换系列 / 复制一份**：路径变了但内容没变，按 sha1 把旧标签认领回来（日志与卡片状态里的「认领」计数），不会因为整理一次目录就把打标结果作废；
4. 只有哈希真的变了（或确实没见过的图）才清空旧标签、重新交给视觉模型。

AI 侧：`qq_sticker` 支持 `list`（看系列与数量）、`search`（按标签/描述/系列找图，返回 id）、`send`（把选中的一张发进当前会话）；`rebuild` 会扫盘并可能调模型，**只给拥有者**。工具第一次被调用时会自动建索引（只算哈希，打标放后台），所以不会把一次回复拖成长任务。

访客默认**能**用 `qq_sticker`（`auth.guestToolAllow` 默认含它）：群里其他人让 bot 发表情也行，
`send` 只会发到当前会话；重建索引仍然只认拥有者。不想给访客就去掉这一项。

删掉 `index.json` 或把它改坏都不会炸：下次扫描当作「没有索引」重建（坏文件里的旧标签会丢）。

发出去的频率有闸门：`sticker.chance`（默认 0.3）控制「模型自己想配图时真发的概率」，`maxPerHour`（默认 6）是每群每小时上限，`dupTTLHours`（默认 24）管同图去重。你明确要一张表情包时不受概率和去重限制（每小时上限仍然生效）。

## 常见问题

| 现象 | 检查 |
| --- | --- |
| 日志一直「OneBot 未连接」 | NapCat 的「正向 WebSocket」是否开在 `onebot.wsUrl`；reverse 模式下 NapCat 是否指向 `ws://<DSH>:6199/`；防火墙；token 是否一致 |
| 能连上但收不到消息 | OneBot 版本要选 **v11**；不能只开 HTTP，必须开正向或反向 WS |
| 群里 @ 了也不回 | `group.enabled`、`group.allow` 白名单、`self_id` 是否一致（`logAdapterFrames: true` 看原始帧） |
| 回「（本轮没有产生文字回复：…）」 | 括号里是 `turn/end` 的原因，据此定位（模型路由、额度、工具报错） |
| 回「（发得太快了：一分钟内最多 N 条…）」 | 入站限流：同一会话里同一个人每分钟最多驱动 N 个回合（默认 20，设置页「每人每分钟最多几条」）。只有真正驱动回合的消息才计数，群里的闲聊不算 |
| 发送失败 | NapCat 的 HTTP 服务器（默认 3000）是否开着；`accessToken`；看日志里的「发送失败」 |
| 网页端整个插件报错 / 设置面板空白 | 0.12.1 的已知问题，升到 **0.12.2** 即可 |
| 日志在哪 | 插件前缀 `[dsh-qq-bot]`，适配器前缀 `[dsh-qq-bot]/adapter`，都打到 DSH Host 的 stdout |

> 本插件**不与 AstrBot 同时接**：AstrBot 也是 OneBot 的消费方，两边一起接会让同一条消息被两个大脑各回一次。对端只要是 OneBot 11 实现（NapCat / OneDisc / Lagrange）就行。

## 升级与卸载

```sh
dsh plugin --profile web update                                     # 升级
dsh plugin --profile web remove @sputnikzaychik/dsh-qq-bot          # 卸载
```

- 升级不丢配置：配置在 profile 的 `cordis.patch.yml` 里，不随包走。跨版本删掉的老字段会被自动清理。
- 升级后要**重启 DSH + 刷新页面**（适配器是子进程、客户端是浏览器 bundle）。
- 任一版本的功能变化见 [CHANGELOG.md](CHANGELOG.md)。

## 更多文档

除本 README 与 `CHANGELOG.md` 外，其余文档都在 [`docs/`](docs/) 下。

| 文档 | 内容 |
| --- | --- |
| [DEVELOPMENT.md](docs/DEVELOPMENT.md) | 本地开发与测试（48 套件 / 1775 项）、完整配置参考、工具细节、文件清单、设计取舍、发布流程、部署备注 |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | 分层图、模块职责、关键数据流、身份契约、已知边界 |
| [CHANGELOG.md](CHANGELOG.md) | 0.1.0 → 0.12.9 的完整演进 |
| [AI-DISCLOSURE.md](docs/AI-DISCLOSURE.md) | AI 生成方式、验证到什么程度、**尚未验证清单**（用前务必读） |
| [SECURITY.md](docs/SECURITY.md) | 安全模型与漏洞报告方式（别在公开 issue 里贴细节） |
| [CONTRIBUTING.md](docs/CONTRIBUTING.md) | 贡献流程与代码约定 |

## 许可与致谢

MIT，见 [LICENSE](LICENSE)。维护者 [@arrow1031](https://github.com/arrow1031)，核心贡献者 [@nd002723](https://github.com/nd002723)。

- [**NapCat**](https://napneko.github.io/) —— 提供灵感、OneBot v11 接口与文档。没有它把 NTQQ 的能力按 OneBot 规范暴露出来，这个项目根本无从起步。
- [**dsh-moli**](https://github.com/27painter/dsh-moli) —— 本地 Moli 无头浏览器引擎与参数面。`qq_webfetch` 的渲染抓取（SPA / JS 渲染页、markdown 输出）直接借它的引擎，本插件的 `moli` 配置项也照它的命令行语义复刻（`fetch` / `-t` / `-d markdown` / `--http-proxy` / `--insecure-disable-tls-host-verification` / URL 放在 `--` 之后）。
- [**@tencent-connect/dsh-qqbot**](https://github.com/tencent-connect/dsh-qqbot) —— 官方 QQ Bot 插件与扫码连接 SDK，部分能力参照其公开文档实现。
- **梁圣** —— 忠！橙！

问题、PR、Discussions 都在 [arrow1031-dev/dsh-qq-bot](https://github.com/arrow1031-dev/dsh-qq-bot)；QQ 群 1091766276（报错请带上 `[dsh-qq-bot]` 开头的日志与复现步骤）。


## 记忆探索：让 QQ 机器人真的记得住

> 这一节不是功能清单，也不是一键方案。下面是我们自己在服务器上试的一套「人设 + 长期记忆 + 语义检索 + 压缩不遗忘」的组合，写出来给愿意折腾的人对照。**本仓库不提供这套记忆栈的安装脚本**；每一层都是独立插件，自己装、自己配、坏了自己修。

### 三层结构

| 层 | 做什么 | 落地形态 |
| --- | --- | --- |
| 人设与长期记忆 | 人设卡注入系统提示；分层记忆（core + topics/*.md）；`memory_append/read/rewrite/search`、`soul_read/update` | `dsh-soul-md` 插件；记忆是明文 Markdown，落在 `$DSH_HOME/soul-md/memory/<人设卡>/` |
| 语义检索 | 记忆按段切块 → 向量化 → 余弦检索，能命中同义、不同措辞的说法 | 自建 sidecar（Node，见下）+ 一个薄插件注册 `memory_vsearch` / `memory_vindex` / `memory_vstatus` |
| 压缩不遗忘 | 接管压缩摘要器：五段式交接摘要；被压掉的原文按段归档，可回查 | `dsh-context-zip` 插件；`history_segments` / `history_read` / `history_search` / `history_find` |

### 为什么这样分

- 记忆管**跨会话**（你是谁、喜欢什么、关系如何），压缩归档管**本次会话的原文**（刚才那句到底怎么说的）。时间尺度不同，谁也别替代谁。
- 语义检索不存新事实，只给 soul-md 的 Markdown 做**只读索引**——文本永远是唯一事实源，索引坏了删掉重建即可。
- 压缩摘要负责「交接」，不负责「记住」；长期有效的决定需要在压缩后主动提炼进记忆，否则下一次压缩还会再丢一次。

### 一个最小可跑的语义索引（思路，不是安装包）

sidecar 只需要三件事：切块、embed、余弦。

```js
// 1) 切块：按标题/空行切，合并到 ~400–500 字符
// 2) 向量化：任意 OpenAI 兼容 /v1/embeddings
const res = await fetch(EMBED_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
  body: JSON.stringify({ model: 'BAAI/bge-m3', input: chunks }),
});
// 3) 存成 JSON：{ chunks: [{ topic, text, hash, vec }] }
// 4) 查询时 embed(query)，对 vec 做余弦，取 topK
```

我们的做法是让 sidecar 用 `fs.watch` 盯着 `$DSH_HOME/soul-md/memory/<卡片>/`，按内容 hash 只重嵌改过的片段；插件侧只暴露一个 HTTP 客户端。**向量库是派生物，不是事实源。**

### 把四件事串起来的提示词约定

真正让这套东西「像记得住」的不是向量，而是写进人设卡的几条规矩（我们的原文大意）：

1. 压缩后先看五段交接摘要（Goal / Decisions / Current state / Next steps / Anchors）。
2. 细节不凭记忆猜：`history_segments` 看段号，`history_read` 读原文，`history_search` / `history_find` 搜关键词。
3. 摘要里**长期有效**的（约定、偏好、关系变化、反复出现的决定）用 `memory_append` 写进记忆，一次最多两条；一次性细节留在历史里。
4. 重要条目可带「细节见本会话第 N 段」，同会话回查，跨会话用 `session_search`。
5. 人设/好感/习惯不重复进摘要；摘要只写这次的工作状态。
6. 写入后想立刻被语义搜到，再调一次 `memory_vindex`；平时 sidecar 自己重建。

### 坑与取舍（先看再动手）

- **不提供一键安装**：soul-md、context-zip 是第三方插件；向量 sidecar 与薄插件是我们自己写的，未随本仓库发布。三者可独立装，缺一层也能用，只是各少一块能力。
- **embedding 要花钱/要服务**：任何 OpenAI 兼容 `/v1/embeddings` 都行（我们用中转站的 BGE-M3，1024 维）；没有 embedding 服务时，`memory_search`（关键词）仍然可用。
- **记忆是明文**：`$DSH_HOME/soul-md/memory/` 下就是 Markdown，备份、审查、迁移都直接操作文件；别把密钥写进去。
- **提炼规则决定质量**：写入太勤会变成垃圾桶，写入太懒会失忆；我们的阈值是「长期有效 + 有依据」，一次最多两条。
- **context-zip 接管的是压缩行**：宿主升级后要重跑 `install.mjs --check` / 安装刷新重定向；桌面版的后端打包在 `app.asar` 里，安装器解析不到时需要自己从 asar 提一份。
- **上下文是有限预算**：记忆注入（`injectMaxChars`）、召回段、交接摘要都吃 token；两边都要「少而精」，否则互补变成双倍开销。

> 定位：这套是实验田，不是产品。觉得哪一层值得固化，欢迎单独开 PR 讨论——但别指望一条命令把四层都装好。
