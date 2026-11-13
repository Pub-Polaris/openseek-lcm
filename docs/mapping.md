# 从 OpenCode 到 Harness 的映射

`opencode-lcm` 建立在 OpenCode 的扩展点上，这里是每个扩展点在 Harness 里的对等物。

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
