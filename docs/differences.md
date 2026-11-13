# 与 opencode-lcm 的有意差异

这些是对真实 Harness 语义的适配，不是遗漏。

这些都是对真实 Harness 语义的适配，不是遗漏。

1. **默认注入的是一条指针，而不是召回的上下文。** 压缩后端会持久记录它移除了什么 —— `compaction/summary` 事件携带 `shadowedRange {start,end}`、`shadowedSeqs` 与 `shadowedTokenCount` —— 所以不必去猜：压缩后的第一轮注入一条有界的压缩指针，给出被移除的消息数、seq 区间、token 估算，以及回到原文的确切路径（对区间内的摘要节点用 `lcm_expand`，或用 `lcm_grep --scope session`），resume note 在同一条消息里紧随其后。**被移除区间的尾部原文也会原样带回来** —— 按 `shadowedRange` 取该区间里最新的 `resume.backfillMessages` 条消息（默认 6 条，`resume.backfillChars` 默认 1800 字封顶）：指针只负责指路，这一段才让模型能接着把话说完。指针本身不携带归档内容，每次压缩只投递一次，且不依赖 `automaticRetrieval.enabled`：这是一次确定性的查找，不是一次检索。
   相似度召回是可选路径，启用后与从前完全一致。Harness 会把通过准入的 `user/message` 批次提交进会话日志，因此召回的注入消息（标记为 `source.kind = 'lcm-recall'`）是被持久化的，而不是一次临时的请求改写；代价是有限的日志增长，由每个新用户轮次的 `automaticRetrieval.maxChars` 封顶。续跑步不会认领新的提示词，因此永远不会被重复注入。锚点选择现在也只认操作者输入：一条消息只有在 `source.kind` 缺失或为 `'user'` 时才算操作者输入，其余（`lcm-recall`、`runtime-context`、`system-prompt`，以及其它插件打了标记的消息）一律按注入内容处理 —— Harness 把运行时上下文快照作为**单独一条** user 角色消息发出，而旧逻辑取的是最新的 user 角色消息，于是查询词变成了 harness 样板文本（实机测得十个英文样板词，操作者自己的中文贡献为零）。
2. **索引里存的是 n-gram，不是原文。** 上游依赖 FTS5 默认的 `unicode61` 分词器，它会把一整串汉字当作一个 token，于是 `无损上下文记忆` 用 `上下文` 搜不到。改用 `trigram` 分词器能修好这一点，却会让两字词失效 —— 而两字正是中文词的常态长度（召回、诊断、记忆、索引）。这里的做法是让 `explodeForIndex` 把文本改写成按文种定长的有序 n-gram（CJK 用 bigram，拉丁用 trigram），再用 `unicode61` 索引这些 gram，于是“这个子串是否出现”变成“这串 gram 是否相邻出现” —— 对拉丁子串和两字中文词同样成立。分词器声明为 `unicode61 tokenchars '_'`，因此 `store_path` 这类标识符的下划线得以保留。
3. **候选检索用 OR，精度交给排序。** `buildFtsQuery` 把每一段转成一个 gram 短语，裸词之间用 `OR` 连接（带引号的组用 `AND`），因为这个表达式只负责收集候选：由移植过来的 JavaScript 重排器依据 token 覆盖、短语命中、角色与新旧程度，**对原文**核对后决定顺序。把自然语言查询的每个词都 AND 起来，会否掉几乎所有相关消息。当索引完全无法作答时 —— 例如某个词短于其文种的 gram 长度 —— 自动召回会用一次有界的子串扫描重试。
   查询词在使用前还会被过滤。归档从未见过的词会被丢弃 —— 上游的 TF-IDF 排序会把这种词排到*最前*，因为一个哪儿都不出现的词看起来最稀有，结果把整个检索预算花在一个什么都匹配不到的查询上 —— 而“出现在超过 80% 文档中”的停用词规则，只在语料大到该比例有意义时才生效；当它会丢光所有词时，会回落到常见词，而不是回落到空查询。
4. **补上了 CJK 分词。** 上游的 `tokenizeQuery` 只认 `[a-z0-9_]+`，于是任何中文查询都塌成零个 token，检索被静默关闭。这里 CJK 段会贡献 bigram 参与打分，而索引存的正是同样的 bigram 宽度，因此两字中文查询由索引本身作答，而不是靠扫描兜底。
5. **压缩后的 resume note 在压缩后的第一轮投递。** Harness 掌管压缩，并且没有提供向摘要输入里追加内容的钩子，所以这里不往压缩提示词里注入，而是在出现 `compaction/*` 标记后的第一轮，把备忘随压缩指针一起发出去。上游的效果 —— 重要上下文挺过收缩，同时不覆盖压缩提示词 —— 得以保留。**note 报的是最近操作者问了什么**（会话标题 + 最近三轮 user 消息 + 归档数与最新一条），不再摘摘要根节点的文本：摘要树每层折叠只保留**开头**的整句（见 `compressText`），所以根节点文本永远是会话的开头，用它做 resume 只会把人带回很久以前。
6. **`worktree` 指“同一工作目录”。** Harness 没有 git worktree 的概念，因此 `worktree` scope 就是所有 `cwd` 相同的会话。`root` 则是由每个会话头部的 `parentSession` 链推出的分支树。
7. **一条消息一行，而不是 messages + parts。** Harness 的消息把 `content: ContentBlock[]` 内联携带，因此归档为每条消息存一行，外加用于超大块的 `artifacts`；摘要节点以日志 `seq` 为范围，而不是数组下标。
8. **归档放在 DSH 的插件数据区，而不是 `.lcm`。** 上游把数据库存在 `<project>/.lcm/lcm.db`。那个约定属于 opencode，而共享 home 下一个裸的 `lcm` 目录很容易和它混淆，所以本插件默认使用 `<DSH_HOME>/storages/dsh-plugin-lcm/` —— 位于 DSH 自己的配置树内，与其它按插件划分的存储域（`session_projcache`、`maidsh_memory`）并列。`storeDir` 可以直接覆盖它；归档是派生数据，随时可以从会话日志重建。
9. **压缩顺序是 剪枝 → VACUUM → checkpoint。** 这是 bug 修复，不是移植取舍。`VACUUM` 会把整库**经由 WAL** 重写一遍，所以先 checkpoint 会让回收出来的页留在 WAL 里：操作报出一个很小的 `reclaimed`，而 WAL 涨了将近一个数据库那么多。在开发用的归档上，第一版顺序报的是 `reclaimed=7.6 MiB`，同时把 WAL 从 48.7 MB 推到 89.9 MB；顺序修正后同一次操作回收了约 97.7 MiB。
10. **没有移植：** 上游的二进制预览提供者（`fingerprint`、`byte-peek`、`image-dimensions`、`pdf-metadata`、`zip-metadata`、`previewBytePeek`），以及 `lcm_import_snapshot` 的 `worktreeMode`。Harness 的工具结果是带类型的 content block，其中的图片与文件已经是渲染成短占位符的附件引用，而且没有可重映射的 worktree 身份。
