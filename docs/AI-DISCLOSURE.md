# AI 生成内容说明 / AI-Generated Content Disclosure

## 简体中文

### 一句话结论

**本项目的全部代码与文档由 AI 编程代理生成**，人类负责提出需求、做设计决策、审查结果并验收。
没有任何一行第三方项目的源码被复制进来。

### 生成方式

- 生成环境：[DeepSeek Harness](https://github.com/deepseek-ai)（DSH）上的 AI 编程代理。
  0.8.0 起的合并、0.9.x 的生图 / 人设 / 跨对话能力、0.10.0 的多协议适配层，是在**真实部署的 DSH 0.2.1-rc.2**
  上通过 SSH 远程操作完成的（环境见下方「当前部署环境」）。
- 生成过程：人类用自然语言提出需求与约束 → AI 编写代码与测试 → AI 在真实运行环境中执行测试并修复
  → 人类审查、否决不合适的方案、追加约束 → 迭代。
- 人类做出的关键决策（可由提交历史与文档佐证）：
  - 技术路线选择 **NapCat + OneBot 11**，而不是自造 QQ 协议；
  - 否决"用执行级硬闸锁死非拥有者"的初版方案，改为**入口路由 + 权限模型**；
  - 要求**指令必须整条严格匹配**（斜杠在首位、无多余内容），防止聊天内容夹带指令样内容被误执行；
  - 要求**动态授权不可跨群**、**只有拥有者能永久授权**；
  - 最终选定 `tools.guard`（一次注册 + 可变标志位）作为访客工具闸，理由是 0 额外 token 且不破坏对话一致性。

### 当前部署环境（维护者真机）

| 项目 | 值 |
| --- | --- |
| 操作系统 | Debian GNU/Linux 13 (trixie)，内核 6.12.113 |
| Node.js | v22.23.4（CI 另跑 Node 24） |
| DSH | 0.2.1-rc.2（web profile，独立进程运行；**公网入口默认关闭**，需要时临时开窗口） |
| QQ 接入 | NapCat + OneBot 11 **正向 WebSocket**（插件反向连接，本机回环，不经公网） |
| 机器人账号 | 真实 QQ 号（OneBot `get_login_info` 可查），非模拟器 |
| LLM | 自定义 OpenAI 兼容中转（地址与 key **只存在于部署侧配置，不进仓库**） |
| 生图 | 自填 OpenAI 兼容 `/images/generations`（实测 `seedream-5.0-lite`，约 40 秒出图、单张约 3.6 MB） |
| 已验证工具 | `qqbot` / `qqconfig` / `qqgroup` / `qq_websearch` / `qq_webfetch` / `qq_imgsearch` / `qq_history` / `qq_draw` / `qqauth`（9 个全部注册成功） |

### 验证情况

- **自动化测试 44 个套件 / 1593 项全部通过**（`npm test` = `node test/run-all.mjs`；CI 在 Node 22 / 24 双版本上跑）：
  - 协议适配器 330 项：正向 WebSocket 19 ／ 反向 19（含半开回收）／ OneBot 12 30 ／ Satori 70 ／ Milky 83 ／ QQ 官方 109
  - Host 插件端到端 148 项（假 ctx + 真适配器 + Config 契约 + 配置热更新 + 废弃配置清理 + 默认准入 fail-closed + 入站限流 + 点名判定与白名单次序 + 路由鉴权闸门；能解析到 `@deepseek-ai/dsh-tools` 时会多跑 9 个工具注册断言）
  - 客户端设置页 132 项 ／ 中间发言 14 项 ／ 权限·群管理·访客工具闸 38 项
  - 安全回归 `test-security.mjs` 55 项（SSRF 公网判定与 F1 / IPv6 映射写法 / 6to4 与 Teredo 内嵌 IPv4 / 识图下载源码断言 / 跨群与撤回绑群）／ 历史消息鉴权 20 项
  - 内网校验代理 `test-guard-proxy.mjs` 53 项（拒绝路径 + 「本地监听器 accept 计数 = 0」的判别力断言 + 上游代理链路 + 403/502 语义分离 + CONNECT 目标归一 + 并发 start 去重 + 解析失败必须拒绝；离网可跑）
  - HTTP·代理隧道 30 项 ／ 配置合并 44 项 ／ 多引擎搜索解析 5 项 ／ 运行时兼容自检 14 项
  - 上游新版本提示 19 项（`test-update-check.mjs`：range 判断、同版本/更旧不提示、不兼容标记、失败静默、缓存与开关、registry 回退、失败只缓存 5 分钟）
  - 消息链路：分条 15 项 ／ 入站去重 13 项 ／ 流式桥接 18 项 ／ 模型路由 23 项
  - 生图引擎 22 项（URL 拼接、响应解析、500/429 重试、4xx 不重试、网络异常重试、task_id 轮询、关闭轮询、本地图片白名单解符号链接）
  - 会话 id 作用域回退 5 项（旧工作区会话不删、改用 `-ws<哈希>` 新 id）
  - 主动发言 84 项 ／ 主动发言回合端到端 35 项 ／ 拥有者设置通道 58 项 ／ 扫码绑定状态机 20 项
  - 阀门组装 27 项（STAGE 表 + 依赖顺序 + 冻结后的对外契约）
  - 适配器重连 11 项 ／ 会话归档 47 项 ／ 工具返回值清理 8 项 ／ 流程授权链路 271 项：TOTP 44 ／ 终端绑定 14 ／ 二维码 18 ／ 状态机 43 ／ 流程脚本存取 17 ／ 指令解析 49 ／ 闸门 16 ／ 接线 23 ／ 闸门码判定 30 ／ 续跑 17
- 测试对端是项目自带的**零依赖 OneBot 11 模拟器**（`test/mock-onebot.mjs`，手写 RFC 6455 帧编解码），
  **不需要真实 QQ 账号**即可回归。
- **真机验证**（上述部署环境，证据来自 DSH 端日志，可复现）：
  - `已注册 qqbot / qqconfig / qqgroup / qq_websearch / qq_webfetch / qq_imgsearch / qq_history / qq_draw / qqauth 工具` 9 个齐全；
  - `OneBot 已连接`（正向 WS 链路 + lifecycle connect）；
  - 群聊/私聊会话创建、消息收发、群管理指令、访客工具闸按预期工作；
  - 设置页字段（含列表字段逗号输入、生图与人设分组）在真实浏览器里读写正常；
  - 生图端到端：一次失败重试后成功（`attempts=3, 38s`），图片落盘并作为 QQ 图片段发出；
  - 配置热更新：改 `cordis.patch.yml` → 适配器重启 → 重连；
  - 跨工作区旧会话冲突：真实复现过 `session "..." belongs to "/root", not ".../QQ_msg"`，
    修复后改用 `-ws<哈希>` id 重建（见 CHANGELOG 0.9.2）。
- **0.2.1-rc.3 兼容复核**：在隔离 `DSH_HOME`（独立 profile，未连 NapCat）装 rc.3 + 本插件，
  启动日志 9 个工具注册齐全、适配器 ready、无报错；插件启动会自检并打印实际 DSH 版本与判定，
  判定范围来自 `lib/shared/compat.js` 的两个常量，不逐版本硬编码。
- 打包与组合校验：`dsh --profile web --dump-config` 接受插件行与 preset 行；
  解包到 profile 后 `@deepseek-ai/dsh-tools` 可解析；客户端清单通过 `dsh.client` 校验。
- 核对过的上游文档：[OneBot 11 鉴权规范](https://github.com/botuniverse/onebot-11)、
  [NapCat-Docker README](https://github.com/NapNeko/NapCat-Docker)、
  [AstrBot aiocqhttp 文档](https://docs.astrbot.app/platform/aiocqhttp.html)。

### 已知限制与**尚未验证**的部分（请务必阅读）

1. **多协议适配器只对「本地假协议端」验证过**：OneBot 12 / Satori / Milky / QQ 官方四个适配器各有独立测试套件，但尚未接真实实现端（OneBot 12 生态、Koishi、Milky 协议端、QQ 开放平台机器人）跑过端到端；上真实协议端时请先看 README「协议与连接方式」的能力边界。
2. **真实 QQ 只在维护者的单一账号 / 单机 Debian 13 上跑过**。其它 QQ 版本、其它 OneBot 实现
   （OneDisc / Lagrange 等）的字段细节、限流与风控未逐一验证；报错请附 `[dsh-qq-bot]` 日志。
3. **跨对话检索（session_search 系列）尚未在真实 QQ 会话里端到端跑过一遍**：它依赖 DSH 的
   `session-query-sqlite` 索引与「cwd 完全一致」授权，本地组合校验通过，真实检索结果待实测。
4. **平台覆盖**：Linux（Debian 13 / Node 22）是主要验证环境，CI 另覆盖 Node 24；Windows 在 0.6.1 时代
   实测过（Windows 11 + Node 24），0.8–0.10 未复测；macOS 未测试。Windows 上测试脚本里的
   `import(path.join(...))` 会报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`。

5. **设置契约按 DSH 0.1.7 实现**：0.1.7 移除了 `settings.register()`，改为读插件自己导出的
   `Config` schema（可编辑字段必须标 `.volatile()`）。上游若再次改动设置契约，设置页会先失效，
   收发消息不受影响。
6. **未实现自动治理**（关键词/刷屏自动撤回或禁言）。`notice` 事件目前只做透传与计数。
7. 回复段的处理只取了被引用消息的 id；合并转发、嵌套回复链未处理。
8. 群管理动作的实际效果（撤回是否成功、禁言时长是否被平台裁剪等）依赖具体 OneBot 实现，
   本项目只保证按协议发出请求并如实回报结果。

### 第三方与协议归属

特别感谢：

- [**NapCat**](https://napneko.github.io/) —— 提供灵感、OneBot v11 接口与文档。
- [**梁圣**](https://www.deepseek.com/) —— 忠！橙！


- **OneBot 11** 是开放协议标准，由社区（botuniverse）维护；本项目是对其的客户端实现，
  未复制其任何代码。
- **NapCat**、**AstrBot**、**LLOneBot**、**Lagrange** 等是各自独立的项目，本项目**不包含**它们的代码，
  仅在文档中作为可对接的实现被提及。
- **`@deepseek-ai/dsh-*`** 是 DSH 运行时，本项目以 **peerDependency** 方式使用，不打包、不分发。
- 本项目运行时唯一依赖 `@deepseek-ai/schemastery`（Config schema 用）；
  唯一可选的 `@deepseek-ai/dsh-tools` 仅用于注册一个动态工具，缺失时功能会自动降级。

### 项目初始成本

初始原型由**一次连续会话**完成（2026-09-20）：

| 项 | 数值 |
| --- | --- |
| 时间 | 约 **5 小时 10 分**（06:26 → 11:37，含人工确认与等待）|
| Token | 约 **110M** |
| 费用 | 约 **¥7.2** |

说明：会话中途切换过多个模型；时间由文件系统时间戳推算，非精确计时。
也就是说，这个项目的全部代码、测试与文档，**成本大概是一杯咖啡，以及一个无聊的下午**。

### 维护状态：社区化维护中（0.8.0 起不封版）

本仓库是 fork 自上游的**继续维护版**：修复 bug、适配 DSH 变更。
原作者的封版版本（0.6.x 及更早）请到上游 [arrow1031/dsh-qq-bot](https://github.com/arrow1031/dsh-qq-bot) 安装。

为了让动手快一点，仓库里有 [ARCHITECTURE.md](ARCHITECTURE.md)：文件职责地图、一条消息的完整旅程、
每个设计决策的原因、以及「想加一条指令 / 一个工具 / 一个设置项」的分步指南。

### 安全与免责

- 群管理包含**破坏性操作**（禁言、踢人、撤回、改群名）。项目内置了授权链与演练模式，
  但**最终责任在使用者**：请先打开 `admin.dryRun` 确认行为，再正式启用。
- 非拥有者默认**不允许使用 DSH 内部工具**（读写文件、执行命令等），这是执行级拦截而非提示词约束；
  但任何自动化系统都不应被当作绝对安全边界，请自行评估风险。
- 本项目按 MIT 许可"按原样"提供，不附带任何形式的担保。

### 许可与作者

[MIT](../LICENSE) · 原作者 [@arrow1031](https://github.com/arrow1031) · 维护 [@nd002723](https://github.com/nd002723) · 维护仓库 <https://github.com/nd002723/dsh-qq-bot>

---

## English

**Every line of code and documentation in this project was generated by an AI coding agent.**
A human directed the requirements, made the design decisions, reviewed the output, and accepted the result.
No source code from third-party projects was copied into this repository.

- **Generated with:** an AI coding agent running on DeepSeek Harness (DSH). The 0.8.0 merge and the
  0.9.x image-gen / persona / cross-conversation work and the 0.10.0 multi-protocol adapter layer
  were done against a **real DSH 0.2.1-rc.2 deployment**
  over SSH (environment below).

**Current deployment environment (maintainer's machine):**

| Item | Value |
| --- | --- |
| OS | Debian GNU/Linux 13 (trixie), kernel 6.12.113 |
| Node.js | v22.23.4 (CI also runs Node 24) |
| DSH | 0.2.1-rc.2 (web profile, standalone process; the **public entry is closed by default** and opened only for a manual time window) |
| QQ transport | NapCat + OneBot 11 **forward WebSocket** (the plugin connects outbound to a loopback address; nothing is exposed publicly) |
| Bot account | a real QQ account (via OneBot `get_login_info`), not a simulator |
| LLM / image APIs | self-hosted OpenAI-compatible relays; **endpoints and keys live only in deployment config and are never committed** |
| Tools verified | `qqbot` / `qqconfig` / `qqgroup` / `qq_websearch` / `qq_webfetch` / `qq_imgsearch` / `qq_history` / `qq_draw` / `qqauth` — all nine registered |

- **Verification:** the browser settings page was **manually confirmed on a real device**.
  **44 suites / 1593 automated checks pass** (`npm test` = `node test/run-all.mjs`; CI runs on Node 22 and 24),
  covering the forward/reverse WebSocket adapter, the Host plugin (fake `ctx` + real adapter + Config contract
  + config hot reload), the settings page, the permission/group-management subsystem, HTTP/proxy, multi-engine
  search parsing, the image-gen engine (retry / poll / response parsing) and the session-id workspace fallback.
  The QQ-side peer used in CI is a zero-dependency OneBot 11 simulator bundled in `test/`,
  so **no real QQ account is required** to reproduce the suite.
- **Observed on the real deployment** (evidence in DSH logs, reproducible): all nine tool registrations;
  `OneBot connected` over the forward WS link; group/private session creation and messaging; group-admin
  commands and the guest tool gate; settings read/write in a real browser; image generation end-to-end
  (one retry then success, `attempts=3, 38s`); config hot reload (adapter restart + reconnect);
  and the cross-workspace session conflict (`belongs to "/root", not ".../QQ_msg"`), fixed by re-creating
  the session under a workspace-scoped id while keeping the old session intact.
- **Upstream documentation consulted:** the OneBot 11 specification, the NapCat-Docker README,
  and the AstrBot aiocqhttp docs (links in the Chinese section above).

**Not verified — read before relying on this:**

1. Real QQ testing so far covers **one account on one Debian 13 host**. Other QQ builds and other OneBot
   implementations (OneDisc, Lagrange, …) were not exercised field-by-field; include `[dsh-qq-bot]` logs in reports.
2. **Cross-conversation retrieval (`session_search` and friends) has not yet been run end-to-end inside real QQ
   sessions.** It depends on the DSH `session-query-sqlite` index and its "identical cwd" authorization; the
   composition was validated locally, but real search results are still to be measured.
3. **Platform coverage:** Linux (Debian 13 / Node 22) is the primary environment and CI adds Node 24;
   Windows was measured in 0.6.1 (Windows 11 + Node 24) but **not re-tested in 0.8–0.10**; macOS is untested.

4. **The settings contract follows DSH 0.1.7**: `settings.register()` was removed, so the plugin exports a
   `Config` schema whose editable fields are marked `.volatile()`. If upstream reshapes that contract again,
   the settings page breaks first; messaging keeps working.
5. **Automatic moderation is not implemented.** `notice` events are passed through and counted only.
6. Reply handling captures only the referenced message id; merged forwards and nested reply chains are not handled.

**Third-party attribution:** OneBot 11 is an open protocol standard (botuniverse) — this project is an
independent client implementation and copies none of its code. NapCat, AstrBot, LLOneBot and Lagrange are
separate projects and are **not** bundled. `@deepseek-ai/dsh-*` packages are consumed as peer dependencies
and are not redistributed. The only runtime dependency is `@deepseek-ai/schemastery` (for the Config schema);
the adapter uses only Node 22's built-in `WebSocket` and `fetch`.

**Security:** group management includes destructive actions (mute, kick, recall, rename). Authorization
chains and a dry-run mode are built in, but **responsibility rests with the operator** — enable dry-run first.
This software is provided "as is" under the MIT license, without warranty of any kind.
