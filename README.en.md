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

Retrieval runs on an n-gram index where **width is the only policy**: three characters for ASCII words, two for every other letter and number, one for a symbol.

**There is no code-point table.** Which characters belong to which class is answered by the runtime's Unicode properties (`\p{L}`, `\p{N}`, `\p{M}`, `\p{Extended_Pictographic}`), which follow the ICU version shipped with Node. A new Han extension, or a script nobody has heard of yet, needs no change here.

That buys three things:

| | |
|---|---|
| Han Ext C–J, the compatibility supplement, Ext G/H/J | indexed (32,223 assigned characters used to be **unfindable**) |
| Greek and Cyrillic | indexed (they matched no class and were dropped wholesale) |
| New scripts (Jurchen, Seal, …) | indexed as soon as the runtime knows them |

The cost: **rebuild the index once after upgrading** (`/lcm doctor apply --reindex`), or existing rows keep the old format.

### Two fuses for silent failures

When the index goes wrong there is no error and no count changes -- only "no match". So `lcm_doctor` samples two comparisons:

| Metric | Meaning |
|---|---|
| `index_shape_drift rows=<n> sampled=<k>` | stored index content ≠ what the current rules produce -- either a writer bypassed `explodeForIndex` (`unicode61` sees a whole Chinese run as one token), or the rules changed while old rows stayed |
| `index_unknown_characters text=<n> sampled=<k>` | the text contains code points **this ICU does not define** (`\p{Cn}`) -- it is newer than the runtime |

Both are sampled (200 / 2000 rows). A full comparison measured 27 s; sampling measures 12 ms -- the same check, 2000× cheaper.

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
