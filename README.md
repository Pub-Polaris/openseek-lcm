# openseek-lcm

**中文** | [English](README.en.md) | [日本語](README.ja.md)

**面向 DeepSeek Harness 的无损上下文记忆** —— 一个 Host 插件：把较早的会话上下文归档到当前提示词之外，折叠成一棵可检索的摘要树，并在压缩发生后的第一轮把回到原文的路径交给模型。

> **缘起？** 本项目移植自 [`opencode-lcm`](https://github.com/Plutarch01/opencode-lcm)（[npm](https://www.npmjs.com/package/opencode-lcm)，MIT，作者 Isaac Grumberg）—— 也就是 [Lossless Context Memory](https://papers.voltropy.com/LCM) 这一想法的 OpenCode 实现。归档模型、18 个工具面、scope 阶梯、排序权重，以及 dry-run 优先的维护命令，都与上游逐一对应；改动的是宿主适配层，以及一组针对 Harness 语义的修正，见[与 opencode-lcm 的有意差异](#与-opencode-lcm-的有意差异)。
>
> **它是怎么被写出来的？** 全部在 **DeepSeek Harness** 里、由 **DeepSeek V4.1 Flash**（`deepseek-v4.1-flash`）完成：架构、实现、三个测试套件，以及实机调试，都是 agent 在一个 Harness 会话里做的，对手是一个真实的六千条消息归档 —— 包括两字中文查询逼出来的检索索引重设计，以及下文记录的那个 WAL/VACUUM 顺序 bug。这个仓库里没有一行是在那个循环之外写的。
# **~~（依然0 Coding skill野人）~~**

> **当前状态（2026-10-06）**：已在真实档案上验证（schema v4；读数见[验证](#验证)）。**`lcm_retrieval_debug` 与 `/lcm debug` 已标记 Deprecated** —— 相似度召回默认关闭，压缩后的第一轮走的是确定性的压缩指针 + resume note。维护顺序与已实测的陷阱写在[已知限制](#已知限制)。

模型不会因此变聪明。它只是不再丢掉长会话里的细节。

```
   session log ──capture──▶ SQLite archive ──FTS5──▶ candidate retrieval
   (source of truth)        (messages,                  │
                             summaries,                  ▼
                             artifacts)         JS re-rank (coverage, phrase,
                                                recency, source kind)
                                                        │
                                    ┌───────────────────┴───────────────────┐
                                    ▼                                       ▼
                        agent/pre-step rewrite                  lcm_* tools for the model
                        (automatic recall)                       (grep / expand / artifact)
```

## 它做什么

- **归档** —— 每个会话中所有承载消息的事件都被捕获进本地 SQLite 归档；过大的载荷会被外移为去重后的 artifact。
- **摘要树** —— 已归档的消息被折叠成确定性的父子摘要节点，因此模型可以从摘要一路下钻到原文。
- **自动召回** —— 压缩发生后的第一轮注入一条有界的压缩指针：被移除的消息数、seq 区间、token 估算，以及回到原文的确切路径（`lcm_expand` 对区间内的摘要节点，或 `lcm_grep --scope session`），resume note 在同一条消息里紧随其后；基于相似度的逐轮召回则是可选附加项，默认关闭。
- **分域检索** —— 一次查询可以只覆盖本会话、整棵分支树、同一工作目录下的所有会话，或是有史以来归档的全部会话。第四档 `all` 属于操作者：面向人的 `/lcm` 命令始终接受它，而面向模型的 `lcm_grep` / `lcm_describe` 除非操作者设置 `allowScopeAll: true`，否则不会使用它 —— 一个 Harness home 横跨多个项目，模型否则会把其它项目的对话拉进当前上下文。
- **隐私控制** —— 工具输出排除、按路径排除捕获、以及破坏性正则脱敏，全部在*写入与建索引之前*生效。
- **保留与维护** —— dry-run 优先的保留策略清理、blob GC、WAL checkpoint + VACUUM、完整性体检，以及可移植的 JSON 快照。

## 从 OpenCode 到 Harness 的映射

`opencode-lcm` 建立在 OpenCode 的四个扩展点上，每一个在 Harness 里都有对等物：

| `opencode-lcm`（OpenCode） | 本插件（DeepSeek Harness） |
|---|---|
| `event` 钩子 —— 捕获每个会话事件 | `ctx.on('session/event', …, { global: true })`，外加经水位线守卫、通过 `ctx.sessionQuery.readSession()` 的历史回填 |
| `experimental.chat.messages.transform` | `agent/pre-step` 瀑布流 —— 向该步的 decision 追加一条注入消息（压缩指针，启用自动召回时才是召回上下文） |
| `experimental.chat.system.transform` | `ctx.systemPrompt.section({ name: 'lcm:hint', order: 9000 })` |
| `experimental.session.compacting` | 在出现 `compaction/*` 标记后的第一轮，随压缩指针一并投递 resume note |
| `tool` 钩子 —— 18 个 `lcm_*` 工具 | `ctx.tools.register()` —— 同样这 18 个工具 |
| 命令面（上游没有） | `ctx.commands.register()` —— 面向人的 `/lcm` 命令 |
| `.lcm/lcm.db`（SQLite + FTS5） | `<DSH_HOME>/storages/dsh-plugin-lcm/lcm.db`（经 `node:sqlite` 使用的 SQLite + FTS5） |

Harness 的会话日志本身就已经是一份无损的追加式记录，因此归档被严格当作**派生缓存**：万一漏掉一次捕获，下一次读取会发现水位线滞后并重放缺失的那一段前缀。这个插件不可能弄丢对话内容。

## 安装

本插件是一个普通的 Host bundle，除 `node:sqlite` 外没有任何运行时依赖 —— 而 `node:sqlite` 是 Harness 自己用于会话检索的模块。

```
plugin_manager { action: install_bundle, target: "D:\\src\\openseek-lcm" }
```

`target` 接受 pnpm 能安装的任何形式：本地目录（如上）、git URL、tarball，或 npm 包名。组合后的插件行名为 `@local/dsh-plugin-lcm`，那只是一个 bundle id，仓库名是 `openseek-lcm`。

> **Windows 路径注意。** 请从**盘符路径**安装。pnpm 会把 `\\server\share` 形式的目标改写成一条损坏的相对符号链接，随后激活失败并报 *"cannot resolve profile bundle"*。请改用映射过的盘符或本地路径。

安装或修改插件后需要重启 DeepSeek Harness Desktop：Cordis 加载器会保留它首次导入的模块代际。修改**配置**值靠重载即可生效；修改**代码**不行。

## 配置

在插件行的 `config` 里设置。所有键都是可选的，缺省时回落到默认值，因此 `config: {}` 也是合法的；带默认值的完整清单在 `lib/config.js` 的 `DEFAULT_CONFIG` 中，下表是便于阅读的摘要，而 [`cordis.patch.yml`](./cordis.patch.yml) 只列出多数部署实际会设置的键。

| 键 | 默认值 | 含义 |
|---|---|---|
| `storeDir` | `<DSH_HOME>/storages/dsh-plugin-lcm` | 归档目录（DSH 的插件数据区）。 |
| `capture.enabled` | `true` | 捕获总开关。 |
| `capture.includeToolResults` | `true` | 是否归档工具输出。 |
| `capture.maxTextCharsPerMessage` | `60000` | 单条消息计入索引文本的上限。 |
| `automaticRetrieval.enabled` | `false` | 是否启用基于相似度的逐轮召回（默认关闭）。确定性的压缩指针与 resume note 不依赖它。 |
| `automaticRetrieval.maxChars` | `900` | 注入的召回文本硬上限。 |
| `automaticRetrieval.minTokens` | `2` | 触发召回所需的最少查询词数。 |
| `automaticRetrieval.maxMessageHits` / `maxSummaryHits` / `maxArtifactHits` | `2` / `1` / `1` | 各类别的配额。 |
| `automaticRetrieval.scopeOrder` | `[session, root, worktree]` | 逐级放大的阶梯，从最便宜的 scope 开始。 |
| `automaticRetrieval.scopeBudgets` | `{session:16, root:12, worktree:8, all:6}` | 每个 scope 的候选预算。 |
| `automaticRetrieval.stop.targetHits` | `3` | 选够这么多命中即停止。 |
| `freshTailMessages` | `10` | 不参与召回的最新消息数（模型本来就看得见）。 |
| `summary.minMessagesForTransform` | `16` | 构建摘要树前所需的已归档消息数。 |
| `summary.levelSize` | `6` | 折叠进一个父节点的子节点数。 |
| `summary.summaryCharBudget` | `1500` | 单个摘要节点的字符预算。 |
| `systemHint` / `systemHintOrder` | `true` / `9000` | 告诉模型归档存在的提示词小节。 |
| `tools.enabled` | `true` | 是否注册 `lcm_*` 工具套件。 |
| `tools.expose` | — | 工具名白名单，用于削减每次请求的 schema token。 |
| `allowScopeAll` | `false` | 允许面向模型的工具使用跨项目的 `all` scope；面向人的 `/lcm` 命令不受影响。 |
| `retention.staleSessionDays` | 禁用 | 清理 N 天未触碰的会话。 |
| `retention.deletedSessionDays` | `30` | 会话被删除 N 天后清理。 |
| `retention.orphanBlobDays` | `14` | 无引用 blob 可被回收前的宽限期。 |
| `privacy.excludeToolPrefixes` | `[]` | 不归档来自这些前缀工具的载荷。 |
| `privacy.excludePathPatterns` | `[]` | 抑制/脱敏匹配的路径。 |
| `privacy.redactPatterns` | `[]` | 在存储前做破坏性替换。 |

## 工具

上游的 18 个工具全部提供，名称、参数与默认值一致。会改数据的工具除非传 `apply: true`，否则只做 dry-run。

| 工具 | 用途 |
|---|---|
| `lcm_status` | 归档与配置清单。 |
| `lcm_retrieval_debug` | **已弃用（Deprecated）**：上一次自动召回的诊断（分 scope、候选 vs 选中）。相似度召回默认关闭（`automaticRetrieval.enabled: false`），所以它通常只会答"还没跑过"；要看能挺过压缩的东西请用 `lcm_resume`。 |
| `lcm_resume` | 某个会话的持久 resume note。 |
| `lcm_grep` | 分域归档检索，支持 `offset` 翻页与 `summaryID` 子树限定。 |
| `lcm_describe` | 某个 scope 里存了什么。 |
| `lcm_lineage` | 会话的祖先链与直接子会话。 |
| `lcm_expand` | 遍历摘要节点；只有在摘要不够用时才 `includeRaw`。 |
| `lcm_artifact` | 读取被外移的载荷（接受无歧义的 id 前缀）。 |
| `lcm_pin_session` / `lcm_unpin_session` | 保护某个会话不被保留策略清理。 |
| `lcm_blob_stats` / `lcm_blob_gc` | 去重 blob 清单 / 孤儿回收。 |
| `lcm_compact` | 剪枝内部事件、VACUUM，然后 checkpoint WAL。 |
| `lcm_doctor` | 完整性检查；`apply: true` 时修复 FTS 与摘要状态。 |
| `lcm_retention_report` / `lcm_retention_prune` | 预览 / 执行保留策略。 |
| `lcm_export_snapshot` / `lcm_import_snapshot` | 可移植的 JSON 快照（`merge` 或 `replace`）。 |

每一个可见工具的 schema 都会附着在**每一次**请求上，所以这套工具每次调用都在花提示词 token。`tools.expose` 与 `tools.enabled` 就是为削减这笔开销而存在的。

## `/lcm` 命令

本插件其余的部分都面向模型。`/lcm` 是人直接从 composer 驱动的入口 —— 一条命令配子命令，因此命令面板里只多一个条目。它的输出展示给你，不会被注入对话。

```
/lcm status                               归档清单与配置
/lcm grep <query> [--scope s] [--limit n] 检索（s = session|root|worktree|all）
/lcm expand <nodeID|query> [raw]          逐级展开摘要节点
/lcm describe [scope]                     该 scope 里存了什么
/lcm resume                               能挺过压缩的那份备忘
/lcm lineage                              本会话的祖先与子会话
/lcm debug [Deprecated]                   上一次自动召回的诊断（默认关闭；看 resume）
/lcm pin [reason] | unpin                 保护本会话不被清理
/lcm blobstats [n]                        artifact blob 清单
/lcm gc [apply]                           预览或删除孤儿 blob
/lcm compact [apply]                      预览或回收数据库空间
/lcm doctor [apply]                       体检或修复摘要与索引
/lcm retention [apply]                    预览或执行保留策略
```

`--scope all` 仍然可用，因为它由操作者亲自输入；面向模型的 `lcm_grep` / `lcm_describe` 默认拒绝它，只有操作者设置 `allowScopeAll: true` 才会放行 —— 一个 Harness home 横跨多个项目，否则模型会把其它项目的对话拉进当前上下文。

与其它地方一致，会改数据的子命令除非显式传 `apply`，否则只做预览。该命令通过可选依赖注册，因此一个没有命令注册表的 profile 仍然保有归档、压缩指针和面向模型的工具。命令输出在设计上只给人看 —— 它渲染在 UI 里，永远不会变成模型消息。

## 与 opencode-lcm 的有意差异

这些都是对真实 Harness 语义的适配，不是遗漏。

1. **默认注入的是一条指针，而不是召回的上下文。** 压缩后端会持久记录它移除了什么 —— `compaction/summary` 事件携带 `shadowedRange {start,end}`、`shadowedSeqs` 与 `shadowedTokenCount` —— 所以不必去猜：压缩后的第一轮注入一条有界的压缩指针，给出被移除的消息数、seq 区间、token 估算，以及回到原文的确切路径（对区间内的摘要节点用 `lcm_expand`，或用 `lcm_grep --scope session`），resume note 在同一条消息里紧随其后。指针本身不携带归档内容，每次压缩只投递一次，且不依赖 `automaticRetrieval.enabled`：这是一次确定性的查找，不是一次检索。
   相似度召回是可选路径，启用后与从前完全一致。Harness 会把通过准入的 `user/message` 批次提交进会话日志，因此召回的注入消息（标记为 `source.kind = 'lcm-recall'`）是被持久化的，而不是一次临时的请求改写；代价是有限的日志增长，由每个新用户轮次的 `automaticRetrieval.maxChars` 封顶。续跑步不会认领新的提示词，因此永远不会被重复注入。锚点选择现在也只认操作者输入：一条消息只有在 `source.kind` 缺失或为 `'user'` 时才算操作者输入，其余（`lcm-recall`、`runtime-context`、`system-prompt`，以及其它插件打了标记的消息）一律按注入内容处理 —— Harness 把运行时上下文快照作为**单独一条** user 角色消息发出，而旧逻辑取的是最新的 user 角色消息，于是查询词变成了 harness 样板文本（实机测得十个英文样板词，操作者自己的中文贡献为零）。
2. **索引里存的是 n-gram，不是原文。** 上游依赖 FTS5 默认的 `unicode61` 分词器，它会把一整串汉字当作一个 token，于是 `无损上下文记忆` 用 `上下文` 搜不到。改用 `trigram` 分词器能修好这一点，却会让两字词失效 —— 而两字正是中文词的常态长度（召回、诊断、记忆、索引）。这里的做法是让 `explodeForIndex` 把文本改写成按文种定长的有序 n-gram（CJK 用 bigram，拉丁用 trigram），再用 `unicode61` 索引这些 gram，于是“这个子串是否出现”变成“这串 gram 是否相邻出现” —— 对拉丁子串和两字中文词同样成立。分词器声明为 `unicode61 tokenchars '_'`，因此 `store_path` 这类标识符的下划线得以保留。
3. **候选检索用 OR，精度交给排序。** `buildFtsQuery` 把每一段转成一个 gram 短语，裸词之间用 `OR` 连接（带引号的组用 `AND`），因为这个表达式只负责收集候选：由移植过来的 JavaScript 重排器依据 token 覆盖、短语命中、角色与新旧程度，**对原文**核对后决定顺序。把自然语言查询的每个词都 AND 起来，会否掉几乎所有相关消息。当索引完全无法作答时 —— 例如某个词短于其文种的 gram 长度 —— 自动召回会用一次有界的子串扫描重试。
   查询词在使用前还会被过滤。归档从未见过的词会被丢弃 —— 上游的 TF-IDF 排序会把这种词排到*最前*，因为一个哪儿都不出现的词看起来最稀有，结果把整个检索预算花在一个什么都匹配不到的查询上 —— 而“出现在超过 80% 文档中”的停用词规则，只在语料大到该比例有意义时才生效；当它会丢光所有词时，会回落到常见词，而不是回落到空查询。
4. **补上了 CJK 分词。** 上游的 `tokenizeQuery` 只认 `[a-z0-9_]+`，于是任何中文查询都塌成零个 token，检索被静默关闭。这里 CJK 段会贡献 bigram 参与打分，而索引存的正是同样的 bigram 宽度，因此两字中文查询由索引本身作答，而不是靠扫描兜底。
5. **压缩后的 resume note 在压缩后的第一轮投递。** Harness 掌管压缩，并且没有提供向摘要输入里追加内容的钩子，所以这里不往压缩提示词里注入，而是在出现 `compaction/*` 标记后的第一轮，把备忘随压缩指针一起发出去。上游的效果 —— 重要上下文挺过收缩，同时不覆盖压缩提示词 —— 得以保留。
6. **`worktree` 指“同一工作目录”。** Harness 没有 git worktree 的概念，因此 `worktree` scope 就是所有 `cwd` 相同的会话。`root` 则是由每个会话头部的 `parentSession` 链推出的分支树。
7. **一条消息一行，而不是 messages + parts。** Harness 的消息把 `content: ContentBlock[]` 内联携带，因此归档为每条消息存一行，外加用于超大块的 `artifacts`；摘要节点以日志 `seq` 为范围，而不是数组下标。
8. **归档放在 DSH 的插件数据区，而不是 `.lcm`。** 上游把数据库存在 `<project>/.lcm/lcm.db`。那个约定属于 opencode，而共享 home 下一个裸的 `lcm` 目录很容易和它混淆，所以本插件默认使用 `<DSH_HOME>/storages/dsh-plugin-lcm/` —— 位于 DSH 自己的配置树内，与其它按插件划分的存储域（`session_projcache`、`maidsh_memory`）并列。`storeDir` 可以直接覆盖它；归档是派生数据，随时可以从会话日志重建。
9. **压缩顺序是 剪枝 → VACUUM → checkpoint。** 这是 bug 修复，不是移植取舍。`VACUUM` 会把整库**经由 WAL** 重写一遍，所以先 checkpoint 会让回收出来的页留在 WAL 里：操作报出一个很小的 `reclaimed`，而 WAL 涨了将近一个数据库那么多。在开发用的归档上，第一版顺序报的是 `reclaimed=7.6 MiB`，同时把 WAL 从 48.7 MB 推到 89.9 MB；顺序修正后同一次操作回收了约 97.7 MiB。
10. **没有移植：** 上游的二进制预览提供者（`fingerprint`、`byte-peek`、`image-dimensions`、`pdf-metadata`、`zip-metadata`、`previewBytePeek`），以及 `lcm_import_snapshot` 的 `worktreeMode`。Harness 的工具结果是带类型的 content block，其中的图片与文件已经是渲染成短占位符的附件引用，而且没有可重映射的 worktree 身份。

## 验证

三个套件无需真实 profile 即可验证本插件。它们需要 Node ≥ 22.5 以提供 `node:sqlite`；Host 自带的运行时 Node 同样可用。

```powershell
node test/smoke.mjs
node test/recall.mjs
node test/plugin.mjs
```

`test/smoke.mjs` 用合成的 Harness 形状会话事件，在一次性数据库上跑通整条归档管线（~~30 项检查~~ 53 项检查）。

它覆盖：捕获与幂等重捕、artifact 外移与入库前脱敏、n-gram 检索原语（`explodeForIndex`、`buildFtsQuery`）、全部四个 scope、摘要树的确定性、纯 FTS 检索（证明走的是索引路径而非回退路径）、CJK 检索、短词扫描回退、摘要子树限定、渐进展开、自动召回边界、resume note、pin、blob 统计、doctor 修复、保留策略的 dry-run 与 apply 之别、压缩、快照往返，以及工具载荷排除。

`test/recall.mjs` 覆盖的是“最不需要真实 Harness、却最需要测试”的那个决策：对已注入上下文的锚点选择、拒绝续跑批次、解析所属 Agent 的三种来源（包括会抛异常的 scope）、注入边界与标记、resume note 升级恰好被消费一次，以及合并计划时不丢失该步 decision 的其余部分（~~11 项检查~~ 17 项检查）。

`test/plugin.mjs` 是不重启而最接近实机运行的东西：它完全按加载器的方式导入 `index.js`，对一个小型假 Cordis 宿主执行 `apply()`，然后断言：每个注册都发生在同步路径上、18 个工具都带可用 schema、系统提示是配置顺序上的一个非插值小节、分域监听器都以 `global: true` 订阅、实时 `session/event` 是被缓冲而非就地写入、一次工具调用会回填归档、真实的 `agent/pre-step` 分发会注入带标记的召回上下文并保留 decision 的其余部分，以及 `/lcm` 定义满足命令注册表契约（名称形状、非空描述、非空 input 提示、handler 为函数），包括注册表实际交付的 raw input 形态 —— 分隔空格包含在内（~~16 项检查~~ 20 项检查）。

开发 profile 上的实机状态（2026-10-06，**最近一次维护之后的读数**）：

```
schema_version=4        fts_available=true      capture_failures=0
session_count=30        message_count=11565     summary_nodes=2299
artifacts=3472          artifact_blobs=3608     orphan_blobs=183
db_bytes=106.2 MB       wal_bytes=0
```

那次维护的顺序，也就是"清理归档"的正确顺序：`lcm_doctor apply=true` 修派生层 → `lcm_pin_session` 固定必须保留的会话 → `lcm_retention_prune` 按 2 天阈值清掉 12 个陈旧会话（−962 条消息、−283 个 artifact）→ `lcm_compact apply=true` 剪枝 + VACUUM，**一次回收 12.4 MiB**。清理前是 42 个会话、12,527 条消息、**104.9 MiB**。

~~此前的读数（2026-10-02）：schema_version=4、message_count=6923、summary_nodes=1368、artifacts=2582、artifact_blobs=2589、shared_blobs=13、orphan_blobs=36、db_bytes=64.8 MiB、wal_bytes=7.4 MiB。~~ 更早的 schema_version=3 读数（91.7 MiB）已随 schema 4 迁移与压缩一并作废。

schema v2 → v3 的检索索引迁移是在该归档的一份副本上测量的：9,625 篇文档在激活期间用 1.7 秒重建索引，之后 `召回`、`诊断`、`召回诊断` 和 `归档` —— 每一个都是两字中文词 —— 全部仅凭索引即命中（`allowScan: false`），而 `看下召回诊断` 的自动召回从之前的 0 命中变成 3 命中。

`lcm_grep "trigram tokenizer"` 返回了跨越一条助手消息与两个外移 artifact 的排序结果；`lcm_expand` 在真实日志序列 1007–1144 上构建并遍历了一棵三层的摘要树。

## 已知限制

- **归档体积是实打实的。** ~~6,376 条消息产出约 92 MB。~~ 现在 6,923 条消息对应 64.8 MiB 的数据库（另有 7.4 MiB 的 WAL）：schema 4 让每个 artifact 正文只在按内容寻址的 blob 里存一份，索引里只放预览；而把释放的页真正还回磁盘要靠 `lcm_compact apply=true`。大规模捕获之后请运行它，并用 `lcm_retention_report` 观察增长。
- **摘要节点是摘要，不是替代品。** 一个 1,500 字符的根节点无法表示成千上万条消息；这棵树的意义在于导航到原文，这也是为什么 `lcm_expand includeRaw=true` 始终是最后手段。
- **工具 schema 每次请求都在花提示词 token**，只要 `tools.enabled` 为真。
- **改代码必须完整重启应用。** 重载 profile 会复用缓存的模块代际，所以改完插件看起来毫无效果，直到进程重启。
- **需要 `node:sqlite`。** 该模块在本 Harness 构建中可用（随附的 `dsh-session-query-sqlite` 用的就是它）；在没有它的构建上，插件会报告归档错误并降级，而不是让对话失败。
- **相似度召回默认关闭，相关的两个入口据此降级。** `automaticRetrieval.enabled: false` 时不会有任何自动召回，所以 `lcm_retrieval_debug` 与 `/lcm debug` **已弃用**（只会答"还没跑过"）。它们的遥测还是一张**内存表**，即便开启也只描述当前进程，重启即丢。
- **保留策略在默认配置下什么都不清。** `retention.staleSessionDays` 默认**禁用**，而 `/lcm retention apply` 只按配置执行、**无法传阈值** ⇒ 它是空操作。能一次性清理的是工具 `lcm_retention_prune`（可传 `staleSessionDays` / `orphanBlobDays`）。
- **按年龄清理之前必须先 pin。** 陈旧与否看归档里的 `updated`，而**当前会话的根会话不再被更新** ⇒ 不先 `lcm_pin_session` 就会砍掉自己所在分支树的根，跨会话召回随即失效。
- **blob GC 的宽限期只认配置。** `lcm_blob_gc` 忽略 `orphanBlobDays` 覆盖参数（传 0 是空操作：给新孤儿盖章并开始计时，此后的调用才可能删）；要立刻回收请用 `lcm_retention_prune`。且每一类每次上限 50 条，清几百个需反复调用。
- **体积的大头是消息行与 FTS 索引，不是 blob。** 实测 3,700 个 blob 合计约 14 MB，而库约 100 MB；把空间真正还回磁盘靠 `lcm_compact apply=true` 的 VACUUM（实测一次回收 12 MB 量级）。

## 致谢与许可

MIT —— 见 [LICENSE](./LICENSE)。

设计移植自 **Isaac Grumberg** 的 [`opencode-lcm`](https://github.com/Plutarch01/opencode-lcm)（MIT），即 Lossless Context Memory 的 OpenCode 实现。上游的版权声明连同该技术所出自的论文一并保留在 [NOTICE](./NOTICE) 中。

这是社区移植，与 DeepSeek Harness 项目及 OpenCode 项目均无隶属关系，也未获其背书。
