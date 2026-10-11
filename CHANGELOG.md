# 更新日志

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)。

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
