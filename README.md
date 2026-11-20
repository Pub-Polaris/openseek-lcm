# openseek-lcm

**中文** | [English](README.en.md) | [日本語](README.ja.md)

**面向 DeepSeek Harness 的无损上下文记忆。** 把早期上下文归档到提示词之外，折叠成可检索的摘要树，并在压缩后的第一轮告诉模型怎么回到原文。

模型不会因此变聪明 —— 它只是不再丢掉长会话里的细节。

```
session log ──capture──▶ SQLite 归档 ──FTS5──▶ 候选检索 ──JS 重排──▶ 指针 / lcm_* 工具
（真源）                 messages · summaries · artifacts
```

`schema v4` · `npm 0.2.2` · MIT

## 它做什么

- **归档** —— 会话里每个承载消息的事件都进本地 SQLite；超大载荷外移成去重后的 artifact。归档是派生缓存，丢了能从会话日志重建。
- **摘要树** —— 已归档消息折叠成确定性的父子节点，可以从摘要一路下钻到原文。
- **压缩后不丢线** —— 压缩后的第一轮注入一条压缩指针（移除了多少、seq 区间、怎么取回）、一份 resume note，以及**被移除区间尾部若干条原文**。
- **分域检索** —— 本会话 / 分支树 / 同工作目录 / 全部归档。最后一档只给操作者，模型默认拿不到。
- **隐私与维护** —— 入库**之前**排除与脱敏；dry-run 优先的保留策略、blob GC、VACUUM、体检、JSON 快照。

## 安装

```
plugin_manager { action: install_bundle, target: "openseek-lcm" }
```

也可以装某个分支：`github:Pub-Polaris/openseek-lcm#dev`。

**装完要重启 DSH** —— Cordis 保留它首次导入的模块代际。改**配置**重载即可，改**代码**不行。

除 `node:sqlite` 外没有运行时依赖。

## 索引的文字覆盖

检索建立在 n-gram 索引上，**宽度是唯一的政策**：ASCII 词取 3 字，其余字母与数字取 2 字，符号取 1 字。

**没有码点表。** 哪些字符属于哪一类交给运行时的 Unicode 属性（`\p{L}`、`\p{N}`、`\p{M}`、`\p{Extended_Pictographic}`），跟着 Node 随附的 ICU 版本走。所以新一版 Unicode 加了汉字扩展、或是加了没人听说过的文字，这里都不需要改代码。

这一条换来的是三件事：

| | |
|---|---|
| 汉字扩展 C–J、兼容补充、G/H/J | 进索引（此前 32,223 个已分配字符**一个字都搜不到**） |
| 希腊文、西里尔文 | 进索引（此前它们不匹配任何一类，整段被丢弃） |
| 新文字（Jurchen/Seal 等） | 只要运行时认，就自动进 |

代价：**升级后必须重建一次索引**（`/lcm doctor apply --reindex`），否则存量行还是老规则写的。

### 两个静默失败的引信

索引出问题时**没有报错、没有计数变化**，只有"搜不到"。所以 `lcm_doctor` 会抽样比对两件事：

| 指标 | 含义 |
|---|---|
| `index_shape_drift rows=<n> sampled=<k>` | 存的索引内容 ≠ 当前规则算出来的内容 —— 要么写入路径绕过了 `explodeForIndex`（`unicode61` 会把整段中文当一个 token），要么规则变了而老行没重建 |
| `index_unknown_characters text=<n> sampled=<k>` | 正文里有**当前 ICU 不认识的码点**（`\p{Cn}`）—— 说明文本比运行时新 |

两项都是抽样（200 / 2000 行）。全量比对要 27 秒，抽样只要 12 毫秒：同样的检查，写法差 2000 倍。

详见 [docs/limitations.md](docs/limitations.md)。

## 配置

`config: {}` 就能用。最常动的三个：

| 键 | 默认 | 意思 |
|---|---|---|
| `resume.backfillMessages` | `6` | 压缩后原样带回多少条被移除的消息 |
| `automaticRetrieval.enabled` | `false` | 是否开基于相似度的逐轮召回 |
| `retention.staleSessionDays` | 禁用 | 按天数清理陈旧会话 |

全部键、四个 scope 的语义、每个工具的参数，见 [docs/config.md](docs/config.md)。

## `/lcm`

```
/lcm status · quick · grep · expand · describe · resume · lineage
/lcm pin | unpin · blobstats · gc · compact · doctor · retention
/lcm source [branch]       查看 / 切换插件跑的是哪份代码
```

阈值可以直传（`--staleSessionDays` / `--deletedSessionDays` / `--orphanBlobDays`）。会改数据的子命令不传 `apply` 只做预览。

## 版本来源

profile 里那一行的 spec 决定跑哪种代码：`link:<仓库>` 是本地检出，`github:…#<分支>` 是装下来的副本。**改代码只在 `link:` 下生效。**

入口两个：设置页「插件 → openseek-lcm版本分支」（含版本号），和 `/lcm source`。切换后要重启。

同一页还有维护按钮（体检 / 重建索引 / 回收孤儿 blob / 压缩 / 保留策略），左侧在**预览**与**执行**之间切换；预览永不写库。

## 文档

| | |
|---|---|
| [docs/config.md](docs/config.md) | 完整配置表 |
| [docs/tools.md](docs/tools.md) | 19 个 `lcm_*` 工具 |
| [docs/differences.md](docs/differences.md) | 与 opencode-lcm 的有意差异 |
| [docs/mapping.md](docs/mapping.md) | OpenCode 扩展点 → Harness 的对等物 |
| [docs/verification.md](docs/verification.md) | 三个套件、线上读数、清理顺序 |
| [docs/limitations.md](docs/limitations.md) | 已知限制 |
| [docs/upstream-9713.md](docs/upstream-9713.md) | 预留：一个对话一个目录 |

文档目前只有中文。

## 许可

MIT —— 见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。

设计移植自 **Isaac Grumberg** 的 [opencode-lcm](https://github.com/Plutarch01/opencode-lcm)（MIT），即 [Lossless Context Memory](https://papers.voltropy.com/LCM) 的 OpenCode 实现。社区移植，与 DeepSeek Harness 及 OpenCode 项目无隶属或背书关系。
