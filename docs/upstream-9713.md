# 预留：一个对话一个目录

对应上游 [deepseek-ai/deepseek-harness #9713](https://github.com/deepseek-ai/deepseek-harness/discussions/9713)。

我们在上游提了一条建议（[deepseek-ai/deepseek-harness #9713](https://github.com/deepseek-ai/deepseek-harness/discussions/9713)）：**让一个对话在共享工作区里拥有自己的子目录** —— 共享根放 `AGENTS.md` 和公共文件，每个对话只在自己那格里写。

它要是落地了，这个插件会受一点影响，所以适配代码先写好、**注释着放在那儿**，等上游定了再开：

> **在哪**：`lib/store.js` 里 `worktreeKeyOf()` 正下方那一大段 `RESERVED FOR: one directory per conversation`。

**为什么要改**：`worktree` scope 现在的含义是"cwd 相同的所有会话"。一旦每个对话都有独立 cwd，这个 scope 就只会剩下当前会话一个 —— 不报错，但 `session → worktree → all` 这级阶梯会**静默地塌掉**。改法是按"包含它的那个共享工作区根"来分桶。

**注意这两件事不是同一个动作。** 让"一份共享 `AGENTS.md` 覆盖所有对话"**今天就能做到**：`@deepseek-ai/dsh-agent-instructions` 的 `projectRootMarkers` 是可配置的（默认 `['.git']`），在 profile 的 `cordis.patch.yml` 里把 `agent-instructions` 那行设成 `["AGENTS.md"]` 即可。上游那半缺的是**自动给每个对话分配子目录** —— 那才需要 DSH 自己动。

**别提前开**：在今天的模型下（一个工作区 = 一个 cwd），按共享根分桶会把同一工作区里的所有会话**并成一个** `worktree` scope，正好和它的用途相反。注释里写了要动的三个调用点，以及为什么现在不能开。

---
