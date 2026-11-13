# 验证

三个零依赖套件，不需要真实 profile。需要 Node ≥ 22.5（`node:sqlite`）；Host 自带的运行时 Node 同样可用。

```powershell
node test/smoke.mjs    # 60 项检查
node test/recall.mjs   # 17 项检查
node test/plugin.mjs   # 20 项检查
```

`test/smoke.mjs` 用合成的 Harness 形状会话事件，在一次性数据库上跑通整条归档管线。

覆盖：捕获与幂等重捕、artifact 外移与入库前脱敏、n-gram 检索原语（`explodeForIndex`、`buildFtsQuery`）、全部四个 scope、摘要树的确定性、纯 FTS 检索（证明走的是索引路径而非回退路径）、CJK 检索、短词扫描回退、摘要子树限定、渐进展开、自动召回边界、resume note、pin、blob 统计、doctor 修复、保留策略的 dry-run 与 apply 之别、压缩、快照往返、工具载荷排除、源码切换的守卫与拒绝，以及搜索索引在记录版本过期时的重建。

`test/recall.mjs` 覆盖那个"最不需要真实 Harness、却最需要测试"的决策：对已注入上下文的锚点选择、拒绝续跑批次、解析所属 Agent 的三种来源（包括会抛异常的 scope）、注入边界与标记、resume note 升级恰好被消费一次，以及合并计划时不丢失该步 decision 的其余部分。

`test/plugin.mjs` 是不重启而最接近实机运行的东西：它完全按加载器的方式导入 `index.js`，对一个小型假 Cordis 宿主执行 `apply()`，然后断言每个注册都发生在同步路径上、18 个工具都带可用 schema、系统提示是配置顺序上的一个非插值小节、分域监听器都以 `global: true` 订阅、实时 `session/event` 是被缓冲而非就地写入、一次工具调用会回填归档、真实的 `agent/pre-step` 分发会注入带标记的召回上下文并保留 decision 的其余部分，以及 `/lcm` 定义满足命令注册表契约（名称形状、非空描述、非空 input 提示、handler 为函数），包括注册表实际交付的 raw input 形态 —— 分隔空格包含在内。

## 线上归档读数（2026-11-14）

```
schema_version=4        fts_available=true      capture_failures=0
session_count=131       message_count=45022     summary_nodes=8858
artifacts=13467         artifact_blobs=13395    orphan_blobs=283
db_bytes=375 MiB        wal_bytes=21.8 MiB      total=396.8 MiB
```

## 清理归档的正确顺序

`lcm_doctor apply=true` 修派生层 → `lcm_pin_session` 固定必须保留的会话 → `lcm_retention_prune` 按阈值清掉陈旧会话 → `lcm_compact apply=true` 剪枝 + VACUUM。

一次实测（2026-10-08，旧归档）：按 2 天阈值清掉 12 个会话（−962 条消息、−283 个 artifact），随后 `lcm_compact apply=true` **一次回收 12.4 MiB**；清理前 42 个会话、12,527 条消息、104.9 MiB。

## 历史

- **schema v2 → v3 的检索索引迁移**在归档副本上测量：9,625 篇文档在激活期间用 1.7 秒重建索引，之后 `召回`、`诊断`、`召回诊断`、`归档` —— 每个都是两字中文词 —— 全部仅凭索引即命中（`allowScan: false`），而 `看下召回诊断` 的自动召回从 0 命中变成 3 命中。
- **实机检索**：`lcm_grep "trigram tokenizer"` 返回跨一条助手消息与两个外移 artifact 的排序结果；`lcm_expand` 在真实日志序列 1007–1144 上构建并遍历了一棵三层摘要树。
