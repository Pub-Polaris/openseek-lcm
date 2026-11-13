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
/lcm status · grep · expand · describe · resume · lineage
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
| [docs/tools.md](docs/tools.md) | The 18 `lcm_*` tools |
| [docs/differences.md](docs/differences.md) | Deliberate differences from opencode-lcm |
| [docs/mapping.md](docs/mapping.md) | OpenCode extension points → their Harness equivalents |
| [docs/verification.md](docs/verification.md) | The three suites, live readings, cleanup order |
| [docs/limitations.md](docs/limitations.md) | Known limitations |
| [docs/upstream-9713.md](docs/upstream-9713.md) | Reserved: one directory per conversation |

The `docs/` pages are Chinese only for now.

## Licence

MIT — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

Ported from **Isaac Grumberg**'s [opencode-lcm](https://github.com/Plutarch01/opencode-lcm) (MIT), the OpenCode implementation of [Lossless Context Memory](https://papers.voltropy.com/LCM). A community port; not affiliated with or endorsed by the DeepSeek Harness or OpenCode projects.
