# 完整配置

所有键都是可选的，缺省时回落到 `lib/config.js` 的 `DEFAULT_CONFIG`。README 只列最常用的几个，这里是全表。

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
| `resume.backfillEnabled` | `true` | 压缩后是否把被移除区间的尾部原文塞回上下文。 |
| `resume.backfillMessages` | `6` | 最多回填多少条被移除的消息（从最新的往前数）。 |
| `resume.backfillChars` | `1800` | 回填文本的字符上限。 |
| `resume.maxChars` | `3000` | 压缩后那一轮的注入总上限（指针＋回填＋备忘）。 |
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
