<div align="center">

<img src="assets/banner.svg" alt="dsh-qq-bot：把 QQ 接到 DSH Agent" width="100%">

# dsh-qq-bot

**把 QQ 接进 DSH：消息进来交给 Agent，回复发回 QQ。**

[npm](https://www.npmjs.com/package/@sputnikzaychik/dsh-qq-bot) · [更新日志](CHANGELOG.md) · [反馈问题](https://github.com/arrow1031-dev/dsh-qq-bot/issues) · [AI 生成声明](docs/AI-DISCLOSURE.md)

[![release](https://img.shields.io/npm/v/@sputnikzaychik/dsh-qq-bot?style=flat-square&label=release&color=6f83ff)](https://www.npmjs.com/package/@sputnikzaychik/dsh-qq-bot)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.2.0--rc.2-8b5cf6?style=flat-square)](#版本支持政策)
[![tests](https://img.shields.io/badge/tests-1896%20passing-brightgreen?style=flat-square)](docs/DEVELOPMENT.md)
[![node](https://img.shields.io/badge/node-%E2%89%A522.6-339933?style=flat-square)](https://nodejs.org/)
[![license](https://img.shields.io/badge/license-MIT-536990?style=flat-square)](LICENSE)

</div>

每个群、每个私聊都是**独立的 DSH 会话**：会落盘，也能在 Web UI 里像普通会话那样打开继续聊。

- **一套插件接五种协议**：OneBot 11（默认）/ OneBot 12 / Satori / Milky / QQ 官方机器人，换协议只是设置里的一个下拉。
- **群管理与权限**：禁言、踢人、撤回、名片、群名、管理员、全员禁言；拥有者 / 高级管理员 / 动态授权 / 本群身份四路取并集。
- **Agent 有 10 个工具**：联网搜索、抓网页、图片反搜、生图、发表情包、读聊天记录、群管理、改设置。
- **只有一条运行时依赖**：`@deepseek-ai/schemastery`（须与宿主同版本）；其余走 Node 22 内置的 `WebSocket` / `fetch`，适配器是零依赖子进程。

[更新内容](#v0141-更新内容) · [版本支持](#版本支持政策) · [安装](#安装与更新) · [接上 QQ](#接上-qq) · [能力](#它能做什么) · [协议](#协议与连接方式) · [工具](#agent-能用的工具) · [常见问题](#常见问题)

## v0.14.1 更新内容

- **说话更有停顿**：两段话之间的间隔从 0–5 秒放宽到 **0.5–10 秒**（设置里「气泡之间最长延迟」滑杆上限同步提到 10 秒）。
  短回复有呼吸感，长回答自然拉开。
- **人设记得住了**：设置里写的人格、说话风格、看图要求，以前只在聊天开头起作用，聊久了模型就当没看见。
  现在每一条消息都会带上它们，且只在你和机器人的聊天里生效。设置页多出「输出风格提示」与「图片提示」两项，留空即不注入。
- **主动开口是一次真对话**：以前是在聊天记录里「补一条自己说过的话」，这种补法会让整段记录变成不合规的数据，
  下次加载会话时可能直接判坏。现在它真的开一轮对话再说话——下次 @ 它，它知道自己刚才讲过什么。
- **表情包不再靠模型看心情**：以前让模型自己估这轮该不该配图，结果聊技术时连着几轮一张都不配，
  你在设置里调的概率根本没起作用。现在每轮都问一次要不要发，发不发由「概率 / 每小时上限 / 同图去重」决定；
  被挡住了就正常回文字，不会反复换关键词重试。
- **网页抓取不再白抓**：没配代理时抓回来的内容读不到，任何链接都显示「成功」但正文是空的——
  而这个功能群友也能用，等于大家拿到一张空白页。
- **「发现新版本」横幅能显示了**：以前后台一直在检查更新，界面上那行提示却从来出不来。
- **改安全设置不再「假保存」**：以前改试错上限、锁定时长这类设置，界面显示已保存、再打开又变回原样。
  现在会明确要求输入动态码。
- **QQ 官方协议下的高级管理员能正常识别**：那边平台给的是另一种格式的账号 ID，以前会被过滤成纯数字再判成「不在名单」，
  结果所有群都不回复。
- **别人发一个几十字节的 GIF 就能拖垮机器人**（几十秒、1.6GB 内存）：现在每帧都先检查尺寸，坏图直接丢弃。
- **主动开口卡住有超时保护了**：新增「主动回合最长等待」（默认 3 分钟）。以前它卡住不会自己结束，
  你下一条消息会被静默丢掉、还回你一句「本轮没有产生文字回复」。
- **发图与表情包的路径检查统一**：以前其中一条只用字符串比较路径，图库目录里放一个指向外部的符号链接，
  就能把系统文件读出来发到群里。现在读文件和解符号链接用同一个结果。
- 其余：生图参考图拒绝符号链接外指；表情包不再因群号后缀发不出去、也不再串群；超大响应主动截断；
  个别网络分块解析死循环的问题也修了。
- 完整记录见 [CHANGELOG](CHANGELOG.md)。

## 版本支持政策

面向**相对稳定的 DSH RC 版本**适配与修复，**不单独维护 alpha**。

| 项目 | 当前说明 |
| --- | --- |
| 插件发行版 | `0.14.1`（npm 包 `@sputnikzaychik/dsh-qq-bot`） |
| DSH 版本 | **≥ `0.2.0-rc.2`**；`0.2.1` 系列（rc.2 / rc.3 / rc.5）实测通过 |
| Web | `dsh web` 部署用 `--profile web` |
| 桌面端 | DSH Desktop 用 `--profile desktop`，插件在应用内 **插件** 页面安装 |
| 升级 | 重启 DSH Web Host（或桌面应用），浏览器还要刷新页面 |
| Node | **≥ 22.6**（用到内置 `WebSocket` 与 `fetch`） |

## 安装与更新

```sh
# 从 npm 装（推荐）
dsh plugin --profile web add @sputnikzaychik/dsh-qq-bot

# 跟随仓库 main（想用最新、未发版的内容）
dsh plugin --profile web add github:arrow1031-dev/dsh-qq-bot

# 升级 / 卸载
dsh plugin --profile web update
dsh plugin --profile web remove @sputnikzaychik/dsh-qq-bot
```

`--profile` 换成你实际在用的：桌面版是 `--profile desktop`。也可以在界面里装：**插件 → 添加插件**，填上面那行包名。

装完**重启 DSH**；`lib/client/settings.js` 是浏览器侧代码，重启后还要**刷新页面**。升级不丢配置（配置在 profile 的
`cordis.patch.yml` 里，不随包走），跨版本删掉的老字段会在启动时自动清理。

<details>
<summary>让 Agent 帮你安装：复制这段提示词</summary>

```text
请为 DeepSeek Harness 的 web Profile 安装 dsh-qq-bot（包名 @sputnikzaychik/dsh-qq-bot）。
只执行下面两条命令，不要修改其他 Profile：
dsh plugin --profile web add @sputnikzaychik/dsh-qq-bot
dsh --profile web --dump-config
确认配置中出现 @sputnikzaychik/dsh-qq-bot 后告诉我结果。
不要关闭或重启正在运行的 DSH；提醒我手动重启 Web Host 并刷新页面。
```

</details>

## 接上 QQ

本仓库**不含协议端**：需要一个兼容协议端把 QQ 账号暴露成某种受支持的上行协议，插件再把消息接进 DSH。
选哪种由你决定，插件这边只认「协议 + 地址 + token」。

以默认的 OneBot 11 为例，协议端里要开两个入口：

| 用途 | 协议 | 插件里的字段 |
| --- | --- | --- |
| 发消息 | HTTP API | `onebot.httpUrl`（如 `http://127.0.0.1:3000`） |
| 收事件 | 正向 WebSocket | `onebot.wsUrl`（如 `ws://127.0.0.1:3001`） |

- 端口随便，填进设置即可；
- 协议端要鉴权时，把同一个 token 填进 `onebot.accessToken`；
- 走**反向** WebSocket 时，让协议端连 `ws://<DSH 主机>:6199/`，插件这边只负责监听。

**配置入口统一到首页侧边栏「插件 → 已安装 → QQ 机器人」，使用 DSH 官方插件详情页接口。**

面板分四档：**连接** / **基本**（准入与名单、发言与管理）/ **能力**（识图与绘图、搜索与抓取、对话与人格、表情包）/ **高级**。
改完点保存：连接项（模式 / 地址 / token）会自动重启适配器，其它项下一条消息生效。

- 白名单是逗号分隔的文本框；布尔是勾选框；provider / model 都是下拉。
- `access_token` 是**只写**字段：已设置时显示「已设置；留空则保持不变」，只有输入新值才覆盖。
- 连接状态不在面板里显示，在对话里让 Agent 调 `qqbot`（`action=status`）看。

> 第一次装好**必须先填 `auth.owners`**：留空时插件不驱动任何会话（fail-closed），只在私聊时回一句配置指引。
> 默认白名单为空表示「不额外限制」，不先填拥有者，任何人都能拿它跑模型额度。填好后再打开 `admin.dryRun`
> 在群里试几条指令，确认无误再关掉。

## 它能做什么

| 能力 | 说明 |
| --- | --- |
| 收发消息 | 群聊（默认要 @，引用 bot 的消息也算 @）与私聊；长回复按换行切成多条 ≤1200 字 |
| 五种协议 | OneBot 11/12、Satori、Milky、QQ 官方机器人，见[协议与连接方式](#协议与连接方式) |
| 群管理 | 禁言、踢人、撤回、改名片 / 群名、设管理员、全员禁言；指令与工具共用一套权限 |
| 联网与媒体 | `qq_websearch` 多引擎搜索、`qq_webfetch` 抓网页（可走代理 / Moli 渲染）、`qq_imgsearch` 反搜、`qq_draw` 生图发群 |
| 看图 | 识图模型留空（默认）时图片作为附件直接提交进会话，由会话模型自己看图，文本里标注图片文件名；显式填了识图模型则先识别再并入回答；群内近期图片由 AI 按需自取（不硬塞上下文） |
| 表情包 | 本地目录即图库（子目录 = 系列），`index.json` 索引 + AI 自动打标；`qq_sticker` 按标签挑一张发到当前会话 |
| 主动发言（可选） | 到点看一眼群里聊什么，自己决定要不要接话；判断与发言可分用两个模型，可复用 `dsh-soul-md` 的人格 |
| 流程授权（可选） | 子代理 / 队友 / 工作流 / 第三方抓取（`moli_fetch`）被拦下时，私聊回一次 6 位动态码才放行 |
| 人格 | 每个 QQ 会话可套自定义人格，或指定专属 agent preset |

**中间发言**（默认开）：长回合里模型先说的那几句（「我先查一下」）单独发一条、不引用也不 @；最终结论仍按规则引用你的消息。
一个回合最多 4 条、两条间隔 2.5 秒，设置页可调，填 0 即关。会话名固定为 `群聊_<群号>` / `私聊_<QQ号>`（可在设置里关）。

## 协议与连接方式

| protocol | 协议端 | 传输 | 备注 |
| --- | --- | --- | --- |
| `onebot11`（默认） | 任意 OneBot 11 实现端 | 正向/反向 WS + HTTP | 与 0.9 的配置完全兼容 |
| `onebot12` | OneBot 12 实现端 | 正向/反向 WS + HTTP | @ 是 `mention`、图片只有 `file_id` |
| `satori` | Koishi（Satori 服务端） | WS `/v1/events` + HTTP RPC | 消息体是类 XHTML 元素串 |
| `milky` | 任意实现 Milky 规范的协议端 | `/event` WS + `/api` HTTP | **已实测**（真实账号 + Milky 1.3 协议端：@ 触发、收群消息、发文本与引用回复）；无 echo，消息 id 是 `message_seq` |
| `qq-official` | QQ 开放平台机器人 | Webhook 或 WS 网关 | AppID/AppSecret 鉴权；无群管理动作 |

**能力边界**：`qq-official` 没有踢人/禁言/改名片这类动作（`qqgroup` 会明确回「不支持」）；`onebot12` 的图片段只有 `file_id`，
要做视觉识别建议用 OneBot 11。


反向 WS 的监听与鉴权细节、各协议连接参数见 [USAGE.md 连接模式细节](docs/USAGE.md#连接模式细节)。

</details>

## 配置

常规用法全在设置面板里（入口见[接上 QQ](#接上-qq)）。几个要点：

- **工作区自动管理**：插件在 DSH 默认工作区同级建 `QQ_msg` 并注册为 Web UI 侧栏的「QQ 消息」分组；带图消息的原图缓存在
  `QQ_msg/qq-images/<会话id>/`，会话结算后删除。
- **旧配置自动清理**：启动时与每次保存后比对 schema，把本版本已不存在的键摘掉再写回（只动自己那一段）。
- **设置命名空间 = 条目 id**（默认 `dsh-qq-bot`）；条目被改名时客户端会回退匹配「以 qq-bot 结尾」的那个。

直接改 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 也能配（**别改包内的那份**，升级会覆盖），
字段全集与 YAML 样例见 [DEVELOPMENT.md 完整配置参考](docs/DEVELOPMENT.md#3-完整配置参考)。

## 权限与指令

权限四路取并集：拥有者（`auth.owners`，全权限 + 永久授权）、高级管理员、本群动态授权、本群管理员/群主身份。
指令不需要 @，但前缀必须在消息首位（`/help` `/whoami` `/perms` `/grant` `/mute` `/kick` `/recall` …）。

> **第一次装好必须先填 `auth.owners`**：留空时插件不驱动任何会话（fail-closed）。

完整权限表、指令表与首次配置说明见 [USAGE.md 权限与指令](docs/USAGE.md#权限与指令)。

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
| `qq_sticker` | 表情包图库：按标签/系列找图并发表情（受概率 / 每小时上限 / 同图去重闸门约束） |
| `qqconfig` | **仅拥有者私聊**：在 QQ 里改白名单 / 发言参数等设置（两步确认） |
| `qqauth` | **仅拥有者私聊**：流程授权的申请与状态查询 |

两条路径分工不同：`qq_webfetch` 的 Moli 渲染分支（含访客可用）由**内网拒绝 + 本地校验代理**保证安全；dsh-moli 的原装工具
`moli_fetch` 不在里面，它只设**一道**验证墙——默认进 `flowAuth.gatedTools`，开关打开后拥有者私聊调用要过一次 6 位动态码。
技巧细节见 [DEVELOPMENT.md 工具细节](docs/DEVELOPMENT.md#4-工具细节)。

## 表情包图库（可选）

**目录就是图库**：子目录 = 系列，索引写在目录根部的 `index.json`。`qq_sticker` 能按标签挑图发到当前会话，
AI 自动打标只处理新增/内容变动的图；发送有闸门（概率 / 每群每小时上限 / 同图去重），不会每轮都刷图。

增量规则、GIF 兼容模式、闸门参数见 [USAGE.md 表情包图库](docs/USAGE.md#表情包图库)。

## 常见问题

- **一直「OneBot 未连接」**：协议端的「正向 WebSocket」是否开在 `onebot.wsUrl`；reverse 模式下是否指向 `ws://<DSH>:6199/`；token 是否一致。
- **能连上但收不到消息**：OneBot 版本要选 **v11**，且必须开正向或反向 WS（只开 HTTP 不够）。
- **群里 @ 了也不回**：`group.enabled`、`group.allow` 白名单、`self_id` 是否一致（`logAdapterFrames: true` 看原始帧）。
- **日志在哪**：插件前缀 `[dsh-qq-bot]`，适配器 `[dsh-qq-bot]/adapter`，都打到 DSH Host 的 stdout。

更多排错（限流提示、发送失败、设置面板空白、AstrBot 冲突）见 [USAGE.md 排错手册](docs/USAGE.md#排错手册)。

## 开发与构建

```sh
node test/run-all.mjs   # 全量自测（49 套件；套件失败会自动重试一次并标注）
npx tsc --noEmit        # 类型检查（JSDoc + checkJs，不引入构建产物）
```

贡献流程、代码约定与发布步骤见 [CONTRIBUTING.md](docs/CONTRIBUTING.md) 与 [DEVELOPMENT.md](docs/DEVELOPMENT.md)。
安全问题请按 [SECURITY.md](docs/SECURITY.md) 私下报告。

## 更多文档

| 文档 | 内容 |
| --- | --- |
| [DEVELOPMENT.md](docs/DEVELOPMENT.md) | 本地开发与测试（49 套件 / 1896 项）、完整配置参考、工具细节、文件清单、设计取舍、发布流程 |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | 分层图、模块职责、关键数据流、身份契约、已知边界 |
| [USAGE.md](docs/USAGE.md) | 连接模式细节、权限与指令表、表情包图库、排错手册 |
| [CHANGELOG.md](CHANGELOG.md) | 0.1.0 → 0.14.1 的完整演进 |
| [AI-DISCLOSURE.md](docs/AI-DISCLOSURE.md) | AI 生成方式、验证到什么程度、**尚未验证清单**（用前务必读） |
| [MEMORY.md](docs/MEMORY.md) | 「人设 + 长期记忆 + 语义检索 + 压缩不遗忘」的实践笔记（实验田，无安装脚本） |
| [SECURITY.md](docs/SECURITY.md) | 安全模型与漏洞报告方式（别在公开 issue 里贴细节） |
| [DECISIONS.md](docs/DECISIONS.md) | 取舍记录：哪些边界**故意不修**、为什么（改动前先看这里） |
| [CONTRIBUTING.md](docs/CONTRIBUTING.md) | 贡献流程与代码约定 |

## 许可与致谢

MIT，见 [LICENSE](LICENSE)。维护者 [@arrow1031](https://github.com/arrow1031)，核心贡献者 [@nd002723](https://github.com/nd002723)。

- [**OneBot 11 规范**](https://github.com/botuniverse/onebot-11) —— 消息段与动作集的事实标准，默认协议按它实现。
- [**dsh-moli**](https://github.com/27painter/dsh-moli) —— 本地无头浏览器引擎与参数面；`qq_webfetch` 的渲染抓取直接借它的引擎。
- [**@tencent-connect/dsh-qqbot**](https://github.com/tencent-connect/dsh-qqbot) —— 官方 QQ Bot 插件与扫码连接 SDK，部分能力参照其公开文档实现。
- **梁圣** —— 忠！橙！

问题、PR、Discussions 都在 [arrow1031-dev/dsh-qq-bot](https://github.com/arrow1031-dev/dsh-qq-bot)；QQ 群 1091766276
（报错请带上 `[dsh-qq-bot]` 开头的日志与复现步骤）。
