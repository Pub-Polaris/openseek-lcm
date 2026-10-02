# AGENTS.md

## 项目概览

> **名称：** `openseek-lcm`
> **描述：** 为 DeepSeek Harness 提供无损上下文记忆（LCM）的 Host 插件：把较早的会话上下文归档到提示词之外，压缩时记录确定性指针，需要时按需取回。
> **技术栈：** Node ESM（零运行时依赖）· DSH Cordis Host 插件 API · `node:sqlite`（SQLite + FTS5）
> **仓库：** <https://github.com/Pub-Polaris/openseek-lcm>
> **上游：** 移植自 [`opencode-lcm`](https://github.com/Plutarch01/opencode-lcm)（MIT）· 本文档面向在这个仓库里工作的 agent。

---

## 任务执行铁律（优先级最高）

**以下规则具有最高执行优先级，所有任务必须严格遵循。**

### 规则 1：先完整，后测试

先完成全部功能，**再**统一测试。

- 功能开发阶段禁止穿插运行测试；局部未完成会让测试结果误导后续判断。
- 一个 sub-agent 的任务：**一次写完，只跑一次套件**。不要在写完前反复跑、也不要边写边跑。
- 模块之间保持可解耦性——每个模块有独立接口与清晰依赖边界，否则无法"先写完"。
- 全部完成后统一执行全量测试（三个套件各一次）。

### 规则 2：分区块串行，禁止并行

若功能分属不同区块（例如"存储布局改造"与"搜索路径修复"），**必须**完成一块再动下一块。

- 禁止同时启动多个区块的开发；并行改同一批文件会互相覆盖，且无法区分谁改坏了什么。
- 每次区块切换明确声明状态：`进行中 → 已完成 → 下一区块启动`。
- 写入范围重叠时必须串行，即使 sub-agent 之间主题不同。

### 规则 3：降低压测次数

- 套件**各跑一次**即可作为验收；不要为了"找 flake"连续跑几十次。
- 不稳定（flake）的测试要靠**读断言**定位根因，不能靠反复重跑碰运气——本项目就出现过"断言匹配人类可读消息文本、依赖 fixture 顺序"的 flake，读一眼就能看出，跑五十次也说不清。
- 需要证明稳定性时，先说明理由并征求确认。

### 规则 4：禁止用 shell 文本往返改文件

- 一律使用文件编辑工具改源码。**禁止** `Get-Content | Set-Content`、`>` 重定向、shell 字符串替换来改文本文件。
- 本项目真实发生过：一次 PowerShell 文本往返把测试文件的 UTF-8 全部变成乱码，只能靠记忆重建。
- 文件保持 **UTF-8 无 BOM、LF 行尾**。

### 规则 5：改代码必须重启 DSH

- Cordis 加载器会复用首次导入的模块代际：**改代码必须重启进程**才生效；改**配置**重载即可。
- 因此"改了没反应"首先怀疑未重启，而不是逻辑错误。

### 规则 6：任务开始前询问优先度

- 接到任务列表后、开始实质工作前，用多选提问框让用户确认优先度；未确认前不得启动任务。

---

## 项目结构

    dsh-plugin-lcm/
    ├── index.js            # Host 插件入口：捕获、pre-step 召回、工具与命令注册、生命周期
    ├── lib/
    │   ├── store.js        # 归档存储与查询（捕获、grep/expand/artifact、摘要树、恢复、指针）
    │   ├── db.js           # schema、迁移、FTS 表、openArchive
    │   ├── text.js         # n-gram 索引原语、查询构造、摘要/截断工具
    │   ├── messages.js     # 事件→消息归一化与捕获过滤
    │   ├── recall.js       # 召回决策：压缩指针、resume note、相似度召回（默认关闭）
    │   ├── ranking.js      # 候选重排（覆盖度、短语、角色、新旧）
    │   ├── maintenance.js  # 保留策略、blob GC、compact、doctor、快照
    │   ├── privacy.js      # 入库前的排除与脱敏
    │   ├── config.js       # 默认值与解析
    │   └── tools.js        # 18 个 lcm_* 工具与 /lcm 命令的接线
    ├── test/               # smoke / recall / plugin 三个零依赖套件
    ├── cordis.patch.yml    # bundle patch：插件行与全部默认配置
    └── README.md · README.en.md · README.ja.md

---

## 构建与测试命令

    # 无依赖，无需安装

    # 全量测试（Node >= 22.5，node:sqlite 必需）
    node test/smoke.mjs      # 归档管线、搜索、迁移、维护
    node test/recall.mjs     # 召回决策
    node test/plugin.mjs     # 用假 Cordis 宿主跑 apply()

提交前三个套件必须全绿。

---

## 已知未修问题

**只记录尚未修复的问题；已修复的不要写在这里（历史见 git log 与 PR）。**

1. **字符类覆盖不全 → 静默搜不到。** 只有 `[a-z0-9_]`、假名、CJK 基本区、兼容表意文字与谚文音节参与索引与子串扫描；emoji、全角拉丁/数字（`ＡＢＣ`、`１２３`）、半角片假名、CJK 扩展 B、谚文字母既不建索引也不可扫。查询它们会得到"没有找到"，与"确实不存在"无法区分，且不报错。
2. **活会话永不回收。** 只有**整会话**可被清理，且没有任何自动调度（compact / gc / retention 全靠手动调用）。归档会随使用单调增长。
3. **`retention.deletedSessionDays` 永不触发。** 两条会话保留规则都在查 `sessions.deleted = 1`，而**没有任何代码写入这一列**（只有快照导入会复制它）。`staleSessionDays` 默认禁用。因此文档里那套保留策略实际上不会因任何真实信号而生效。
4. **`lib/text.js` 的 `sanitizeFtsTokens` 与 `FTS5_RESERVED` 是死代码。** 因为查询表达式只发出带引号的短语，二者永远不会被用到。
5. **`orphanBlobDays: 0` 并不能"立刻回收本次才发现的那批孤儿"。** `gcBlobs` 在进入时就取好 cutoff，之后才给新观察到的孤儿打 `orphaned_at`，所以这一批要下一次调用才会被收。对"已经观察过一段时间的孤儿"宽限期语义是正确的，只有"本次第一次发现"的那一批会晚一轮。修法是把 cutoff 移到打戳之后，但那会改变现有测试的时序假设，故留作已知行为而非缺陷。

---

## 验收规范（本项目专用，来自真实事故）

- **schema 迁移之后必须跑一次 `/lcm compact apply`，否则空间不会回到磁盘。** 迁移只是把页释放进 freelist：实测迁移后文件 95.6 MiB、freelist 32.1 MiB；执行 compact（prune → VACUUM → checkpoint）后为 56.9 MiB、freelist 0。

- **涉及存储或 schema 的改动，必须用真实归档的副本验证，不能只用 fixture。** 用 `VACUUM INTO` 生成一致性副本（**只读**打开线上库），并且**用会打印的 logger**——空 logger 会把迁移失败吞成一行 `warn`，看起来像成功。
- **迁移测试的 fixture 必须按历史 schema 形状建表。** 用**当前** schema 建出来的 v3 库永远测不出 v3→v4 迁移的问题（本项目确实因此放行了一个静默失败的迁移：老库上 `content_text` 是 `NOT NULL`，SQLite 无法用 `ALTER TABLE` 去掉约束，于是整批回滚，而 `schema_version` 已被写成新值，导致**再也无法重试**）。
- **任何探针副本用完立即删除**，并确认没有落在仓库内：它们是用户的真实对话数据（本项目单次副本 100 MB 级）。
- 线上归档路径：`C:\Users\rksk1\.dsh\storages\dsh-plugin-lcm\lcm.db` —— **只读打开，绝不写**。

---

## 安全与边界

- **禁止提交**任何 `.db` / WAL / 快照 / 归档副本；`.gitignore` 已覆盖数据库文件，但 PR 前仍需自查。
- 快照导出仅允许写入 `storeDir` 内，除非显式 opt-in；导出前必须脱敏。
- 归档是**派生缓存**：任何删除都可从会话日志重建，因此宁可保守（不删）也不要赌。
- 隐私控制必须在**入库前**生效（`lib/privacy.js`），事后脱敏不算数。

---

**使用说明：** 本文件放在项目根目录，保持在 200 行以内；详细架构文档存放于 `docs/` 目录并通过链接引用。
