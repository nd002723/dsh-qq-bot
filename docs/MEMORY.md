# 记忆探索：让 QQ 机器人真的记得住

> 这一节不是功能清单，也不是一键方案。下面是我们自己在服务器上试的一套「人设 + 长期记忆 + 语义检索 + 压缩不遗忘」的组合，写出来给愿意折腾的人对照。**本仓库不提供这套记忆栈的安装脚本**；每一层都是独立插件，自己装、自己配、坏了自己修。

## 三层结构

| 层 | 做什么 | 落地形态 |
| --- | --- | --- |
| 人设与长期记忆 | 人设卡注入系统提示；分层记忆（core + topics/*.md）；`memory_append/read/rewrite/search`、`soul_read/update` | `dsh-soul-md` 插件；记忆是明文 Markdown，落在 `$DSH_HOME/soul-md/memory/<人设卡>/` |
| 语义检索 | 记忆按段切块 → 向量化 → 余弦检索，能命中同义、不同措辞的说法 | 自建 sidecar（Node，见下）+ 一个薄插件注册 `memory_vsearch` / `memory_vindex` / `memory_vstatus` |
| 压缩不遗忘 | 接管压缩摘要器：五段式交接摘要；被压掉的原文按段归档，可回查 | `dsh-context-zip` 插件；`history_segments` / `history_read` / `history_search` / `history_find` |

## 为什么这样分

- 记忆管**跨会话**（你是谁、喜欢什么、关系如何），压缩归档管**本次会话的原文**（刚才那句到底怎么说的）。时间尺度不同，谁也别替代谁。
- 语义检索不存新事实，只给 soul-md 的 Markdown 做**只读索引**——文本永远是唯一事实源，索引坏了删掉重建即可。
- 压缩摘要负责「交接」，不负责「记住」；长期有效的决定需要在压缩后主动提炼进记忆，否则下一次压缩还会再丢一次。

## 一个最小可跑的语义索引（思路，不是安装包）

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

## 把四件事串起来的提示词约定

真正让这套东西「像记得住」的不是向量，而是写进人设卡的几条规矩（我们的原文大意）：

1. 压缩后先看五段交接摘要（Goal / Decisions / Current state / Next steps / Anchors）。
2. 细节不凭记忆猜：`history_segments` 看段号，`history_read` 读原文，`history_search` / `history_find` 搜关键词。
3. 摘要里**长期有效**的（约定、偏好、关系变化、反复出现的决定）用 `memory_append` 写进记忆，一次最多两条；一次性细节留在历史里。
4. 重要条目可带「细节见本会话第 N 段」，同会话回查，跨会话用 `session_search`。
5. 人设/好感/习惯不重复进摘要；摘要只写这次的工作状态。
6. 写入后想立刻被语义搜到，再调一次 `memory_vindex`；平时 sidecar 自己重建。

## 坑与取舍（先看再动手）

- **不提供一键安装**：soul-md、context-zip 是第三方插件；向量 sidecar 与薄插件是我们自己写的，未随本仓库发布。三者可独立装，缺一层也能用，只是各少一块能力。
- **embedding 要花钱/要服务**：任何 OpenAI 兼容 `/v1/embeddings` 都行（我们用中转站的 BGE-M3，1024 维）；没有 embedding 服务时，`memory_search`（关键词）仍然可用。
- **记忆是明文**：`$DSH_HOME/soul-md/memory/` 下就是 Markdown，备份、审查、迁移都直接操作文件；别把密钥写进去。
- **提炼规则决定质量**：写入太勤会变成垃圾桶，写入太懒会失忆；我们的阈值是「长期有效 + 有依据」，一次最多两条。
- **context-zip 接管的是压缩行**：宿主升级后要重跑 `install.mjs --check` / 安装刷新重定向；桌面版的后端打包在 `app.asar` 里，安装器解析不到时需要自己从 asar 提一份。
- **上下文是有限预算**：记忆注入（`injectMaxChars`）、召回段、交接摘要都吃 token；两边都要「少而精」，否则互补变成双倍开销。

> 定位：这套是实验田，不是产品。觉得哪一层值得固化，欢迎单独开 PR 讨论——但别指望一条命令把四层都装好。
