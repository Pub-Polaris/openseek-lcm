# 已知限制

按影响从大到小。

- **归档体积是实打实的。** 线上归档当前 45,022 条消息 → 数据库 375 MiB + WAL 21.8 MiB（合计 396.8 MiB）：schema 4 让每个 artifact 正文只在按内容寻址的 blob 里存一份，索引里只放预览；而把释放的页真正还回磁盘要靠 `lcm_compact apply=true`。大规模捕获之后请运行它，并用 `lcm_retention_report` 观察增长。
- **摘要节点是摘要，不是替代品。** 一个 1,500 字符的根节点无法表示成千上万条消息；这棵树的意义在于导航到原文，这也是为什么 `lcm_expand includeRaw=true` 始终是最后手段。
- **工具 schema 每次请求都在花提示词 token**，只要 `tools.enabled` 为真。
- **改代码必须完整重启应用。** 重载 profile 会复用缓存的模块代际，所以改完插件看起来毫无效果，直到进程重启。
- **需要 `node:sqlite`。** 该模块在本 Harness 构建中可用（随附的 `dsh-session-query-sqlite` 用的就是它）；在没有它的构建上，插件会报告归档错误并降级，而不是让对话失败。
- **相似度召回默认关闭，相关的两个入口据此降级。** `automaticRetrieval.enabled: false` 时不会有任何自动召回，所以 `lcm_retrieval_debug` 与 `/lcm debug` **已弃用**（只会答"还没跑过"）。它们的遥测还是一张**内存表**，即便开启也只描述当前进程，重启即丢。
- **保留策略在默认配置下什么都不清。** `retention.staleSessionDays` 默认**禁用**，所以不传阈值的 `/lcm retention apply` 依然是空操作。阈值现在可以直接传给命令（`--staleSessionDays` / `--deletedSessionDays` / `--orphanBlobDays`），工具 `lcm_retention_prune` 同样接受它们。
- **按年龄清理之前必须先 pin。** 陈旧与否看归档里的 `updated`，而**当前会话的根会话不再被更新** ⇒ 不先 `lcm_pin_session` 就会砍掉自己所在分支树的根，跨会话召回随即失效。
- **blob GC 的宽限期语义。** `lcm_blob_gc` 与 `/lcm gc` 都接受 `orphanBlobDays`（传 `0` 表示不留宽限期）。但**本次首次被观察到**的那批孤儿只会被打上 `orphaned_at` 时间戳，要下一次调用才可回收；已经观察过一段时间的孤儿不受此限。且每一类每次上限 50 条，清几百个需反复调用。
- **体积的大头是消息行与 FTS 索引，不是 blob。** 实测 3,700 个 blob 合计约 14 MB，而库约 100 MB；把空间真正还回磁盘靠 `lcm_compact apply=true` 的 VACUUM（实测一次回收 12 MB 量级）。
