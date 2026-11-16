# openseek-lcm

[中文](README.md) | **English** | [日本語](README.ja.md)

**Lossless context memory for DeepSeek Harness.** Older context is archived outside the prompt, folded into a searchable summary tree, and after a compaction the model is told exactly how to get the original text back.

The model does not become smarter. It just stops losing the details of a long session.

```
session log ──capture──▶ SQLite archive ──FTS5──▶ candidates ──JS re-rank──▶ pointer / lcm_* tools
(source of truth)        messages · summaries · artifacts
```

`schema v4` · `npm 0.2.2` · MIT

## What it does

- **Archive** — every message-bearing session event lands in local SQLite; oversized payloads move out to content-addressed artifacts. The archive is a derived cache: lose it and the session log rebuilds it.
- **Summary tree** — archived messages fold into deterministic parent/child nodes, so the model can drill from a summary down to the original.
- **Survives compaction** — the first turn after a compaction gets a bounded pointer (how many were removed, the seq range, how to fetch them back), a resume note, and the newest messages of the removed span **verbatim**.
- **Scoped retrieval** — this session / the branch tree / the same working directory / every archive. The last one is operator-only; the model cannot reach it by default.
- **Privacy and maintenance** — exclusion and redaction happen *before* anything is stored; retention, blob GC, `VACUUM`, a doctor and JSON snapshots, all dry-run first.

## Install

```
plugin_manager { action: install_bundle, target: "openseek-lcm" }
```

Or a specific branch: `github:Pub-Polaris/openseek-lcm#dev`.

**Restart DSH after installing** — the Cordis loader keeps the module generation it first imported. Configuration reloads; code does not.

No runtime dependency except `node:sqlite`.

## Which characters the index covers

Retrieval runs on an n-gram index: three characters for Latin, two for CJK, one for a symbol. **Which code points count as CJK is a hardcoded range table**, and that table is a Unicode snapshot -- it decays:

| Blocks | Assigned | Today |
|---|---|---|
| Ext A / basic / compatibility / Ext B | 80,776 | ✅ indexed |
| Ext C·D·E·F·I / compatibility supplement / Ext G·H·J | 32,223 | ❌ **not indexed at all** |
| Jurchen and Seal, new in Unicode 18.0 | 12,293 | ❌ **not indexed at all** |

The failure is silent: a query for those characters returns "no match", indistinguishable from "this never existed".

**That table is something we added.** The original implementation indexed `[a-z0-9_]` and nothing else, letting every other script fall back to a substring scan -- narrow, but nobody had to maintain it. Widening to non-Latin scripts meant copying a code-point table in, and now every Unicode release owes the project a manual reconciliation.

The better repair is to stop owning the table and let the runtime answer: `\p{Script=Han}` covers Ext A through J in one go -- eight more blocks than the table, automatically -- and `\p{Extended_Pictographic}` can replace the symbol table. Measured on 92.5k characters: 1.0 ms → 1.6 ms. The catch is that existing rows keep the old index format until `/lcm doctor apply --reindex`.

See [docs/limitations.md](docs/limitations.md).

## Configuration

`config: {}` works. The three you are most likely to touch:

| Key | Default | Meaning |
|---|---|---|
| `resume.backfillMessages` | `6` | How many removed messages come back verbatim after a compaction |
| `automaticRetrieval.enabled` | `false` | Similarity-based per-turn recall |
| `retention.staleSessionDays` | disabled | Age-based cleanup of stale sessions |

Every key, what the four scopes mean, and each tool's parameters: [docs/config.md](docs/config.md).

## `/lcm`

```
/lcm status · quick · grep · expand · describe · resume · lineage
/lcm pin | unpin · blobstats · gc · compact · doctor · retention
/lcm source [branch]       show / switch which copy of the plugin runs
```

Thresholds pass straight through (`--staleSessionDays`, `--deletedSessionDays`, `--orphanBlobDays`). Mutating subcommands are preview-only without `apply`.

## Which copy is running

The profile's dependency spec decides: `link:<checkout>` for a local checkout, `github:…#<branch>` for an installed copy. **Editing code only takes effect under `link:`.**

Two entry points: the settings page (**Plugins → openseek-lcm branches**, which also shows the version), and `/lcm source`. A switch needs a restart.

## Documentation

| | |
|---|---|
| [docs/config.md](docs/config.md) | Full configuration table |
| [docs/tools.md](docs/tools.md) | The 19 `lcm_*` tools |
| [docs/differences.md](docs/differences.md) | Deliberate differences from opencode-lcm |
| [docs/mapping.md](docs/mapping.md) | OpenCode extension points → their Harness equivalents |
| [docs/verification.md](docs/verification.md) | The three suites, live readings, cleanup order |
| [docs/limitations.md](docs/limitations.md) | Known limitations |
| [docs/upstream-9713.md](docs/upstream-9713.md) | Reserved: one directory per conversation |

The `docs/` pages are Chinese only for now.

## Licence

MIT — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

Ported from **Isaac Grumberg**'s [opencode-lcm](https://github.com/Plutarch01/opencode-lcm) (MIT), the OpenCode implementation of [Lossless Context Memory](https://papers.voltropy.com/LCM). A community port; not affiliated with or endorsed by the DeepSeek Harness or OpenCode projects.
