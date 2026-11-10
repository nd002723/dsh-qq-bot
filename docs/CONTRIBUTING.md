# 贡献指南

欢迎参与 dsh-qq-bot。本项目自 0.8.0 起转入社区化维护：fork、issue、PR 都欢迎，
活跃贡献者会被邀请进协作者名单。

## 环境

- Node >= 22.6
- DSH >= 0.2.0-rc.2（0.2.1 系列 rc.2 / rc.3 已实测；见 README「DSH 0.2 兼容」）
- 协议端：NapCat / Lagrange（OneBot 11）、OneBot 12 实现端、Koishi（Satori）、Milky 协议端，或 QQ 开放平台机器人（见 README「三、协议与连接方式」）

## 本地开发

```bash
git clone https://github.com/arrow1031-dev/dsh-qq-bot.git
cd dsh-qq-bot
npm install
node test/run-all.mjs
```

所有测试都用本地假协议端，不需要真 QQ：OneBot 11 用 `test/mock-onebot.mjs`，其余协议各自的 `test/test-adapter-*.mjs` 自带假服务端。

## 分支与 PR

- `main` 保持可发布；功能与修复走 `feat/xxx`、`fix/xxx` 分支，PR 目标 `main`。
- PR 描述写清：改了什么、影响哪些路径、怎么验证的。
- 合并前 CI 与 `node test/run-all.mjs` 必须全绿。

## 提交信息

`type(scope): 一句话`，type 取 `feat` / `fix` / `docs` / `refactor` / `test` / `chore`。
示例：`feat(tools): 新增 qq_translate 工具`。

## 代码约定

1. **工具注册**：一律走 `lib/tools/index.js` 的 `registerTool(ctx, make)`。
   DSH 0.2 的 Cordis Guard 不允许直接读 `ctx.tools`，必须先 `ctx.get('tools')`，
   未就绪时用 `ctx.inject(['tools'], ...)` 动态挂载。绕过它会静默丢掉工具。
2. **配置默认值**：写进对应工具/阀门目录的 `*-conf.json`（不属于任何工具、阀门的放进
   `lib/config.js` 的 `CORE_DEFAULTS`），`DEFAULTS` 由这两份组装——改默认值只改 JSON。
   schema 加在 `lib/config.js` 的 `Config`，运行期可热改的字段标 `.volatile()`。
3. **设置页字段**：写进对应工具的 `*-set.json`；不属于任何工具、阀门的放
   `lib/settings-core-set.json`，标签页骨架在 `lib/settings-page-set.json`。
   客户端（`lib/client/settings.js`）只是渲染器——`FIELDS` 在加载时由模板填充，
   不要再往客户端里手写字段定义。
4. **测试与类型**：新增行为在 `test/` 补用例，并挂到 `test/run-all.mjs`；提交前跑
   `npm test`（全量套件）与 `npm run typecheck`（JSDoc + `checkJs`，源码仍是 `.js`/`.mjs`，不引入构建）。
5. **新协议**：读 `lib/transport/bridge/CONTRACT.md`，在 `lib/transport/adapters/` 下加一个 stdin/stdout 适配器，再到 `lib/transport/index.js` 的 `ADAPTER_ENTRIES` 与 `lib/config.js` 的 `protocols` 登记；适配器必须零 npm 依赖，并自带上限为一条的协议端假服务端测试。
6. **文档**：面向用户的行为变化写进 `CHANGELOG.md`；结构变化同步 `ARCHITECTURE.md`；新协议写进 README 的协议表。
   `CHANGELOG.md` 的「未发布」段只写**这一版最终交付的样子**：同一版本号只保留一节，开发过程中的
   反复调整合并成一条，不要保留「先改成 A、后来又改回 B」「实装到本机才发现又修了一版」这类中间态叙事——
   修 bug 就直接写修好之后的行为，别把中间过程抄进发布说明。

## 版本与发布

维护者合并后在 `main` 打 tag（`vX.Y.Z`）并发 Release。安装方式跟随 `main`，不再锁死某个 tag。
自动化：`.github/workflows/release.yml` 在 push 到 `main` 且改动包含 `package.json` 时跑全量测试并发布，Release 正文取「首次引入该版本号的提交信息」；`ci.yml` 对每次 push / PR 跑 `npm test`。

## 成为协作者

持续贡献（2 个以上被合并的 PR）后，维护者会邀请你成为 collaborator（write 权限：可在本仓库推分支、管 issue/PR；
个人仓库不提供 maintain 角色，改仓库设置仍只有维护者能做）。也可以在 Discussions 里自荐。

## CHANGELOG 写法（硬约定）

发布说明是给用户看的，不是开发过程的流水账。动笔前先读一遍目标版本那一节，再按下面五条自查：

1. **一个版本一节**：同一版本号在 `CHANGELOG.md` 里只能有一个 `##` 小节。后续调整直接改那一节，不要再追加新节。
2. **只写最终形态**：每条描述都必须对得上「现在代码在做什么」。不写「先做成 A，后来又改成 B」「上线后发现又修了一版」
   「这一条曾被回退、现已恢复」这类过程；被推翻的方案直接不提。
3. **一个改动一条**：同一件事在多处反复调整的合并成一条；同一句里不要既交代旧行为又交代新行为。
4. **发版前整版重读**：按上一个 tag 做完整 diff（见上一节），然后从头到尾读一遍那一节，逐条问「这条现在还成立吗」，
   不成立的改掉或删掉。
5. **一句话自查**：读者只看这一节，会不会以为有什么东西先坏了又被修好？会，就改写成最终态。

