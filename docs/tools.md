# 工具面

18 个 `lcm_*` 工具。会改数据的工具除非传 `apply: true`，否则只做 dry-run。

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
