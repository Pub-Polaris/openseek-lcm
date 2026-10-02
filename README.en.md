# openseek-lcm

[中文](README.md) | **English** | [日本語](README.ja.md)

**Lossless Context Memory for DeepSeek Harness** — a Host plugin that archives older session
context outside the active prompt, folds it into a searchable tree of summaries, and
automatically recalls the parts the current turn needs.

> **Origin.** This is a port of [`opencode-lcm`](https://github.com/Plutarch01/opencode-lcm)
> ([npm](https://www.npmjs.com/package/opencode-lcm), MIT, by Isaac Grumberg) — the OpenCode
> implementation of the [Lossless Context Memory](https://papers.voltropy.com/LCM) idea. The
> archive model, the 18-tool surface, the scope ladder, the ranking weights and the
> dry-run-first maintenance commands are kept one-for-one with upstream. What changed is the
> host adapter and a set of Harness-specific corrections, listed under
> [Deliberate differences](#deliberate-differences-from-opencode-lcm).
>
> **How it was built.** Entirely inside **DeepSeek Harness** running **DeepSeek V4.1 Flash**
> (`deepseek-v4.1-flash`). The architecture, the implementation, the three test suites and the
> live debugging were all done by the agent in a Harness session, against a real 6,000-message
> archive — including the search-index redesign that two-character Chinese queries forced, and
> the WAL/VACUUM ordering bug described below. Nothing here was written outside that loop.

The model does not become smarter. It stops losing the details of a long session.

```
   session log ──capture──▶ SQLite archive ──FTS5──▶ candidate retrieval
   (source of truth)        (messages,                  │
                             summaries,                  ▼
                             artifacts)         JS re-rank (coverage, phrase,
                                                recency, source kind)
                                                        │
                                    ┌───────────────────┴───────────────────┐
                                    ▼                                       ▼
                        agent/pre-step rewrite                  lcm_* tools for the model
                        (automatic recall)                       (grep / expand / artifact)
```

## What it does

- **Archive** — every message-bearing event of every session is captured into a local SQLite
  archive, with oversized payloads moved out into deduplicated artifacts.
- **Summary tree** — archived messages are folded into deterministic parent/child summary
  nodes, so the model can walk from a digest down to raw text.
- **Automatic recall** — the pending user message becomes a search query; the best archived
  hits are appended to that step, bounded by `automaticRetrieval.maxChars`.
- **Scoped search** — one query can span just this session, its whole branch tree, every
  session in the same working directory, or every session ever archived.
- **Privacy controls** — tool-output exclusion, path-based capture exclusion, and destructive
  regex redaction, all applied *before* anything is stored or indexed.
- **Retention and housekeeping** — dry-run-first retention pruning, blob GC, WAL
  checkpoint + VACUUM, an integrity doctor, and portable JSON snapshots.

## Mapping from OpenCode to Harness

`opencode-lcm` is built on four OpenCode extension points. Each has a Harness counterpart:

| `opencode-lcm` (OpenCode) | this plugin (DeepSeek Harness) |
|---|---|
| `event` hook — capture every session event | `ctx.on('session/event', …, { global: true })`, plus watermark-guarded backfill through `ctx.sessionQuery.readSession()` |
| `experimental.chat.messages.transform` | `agent/pre-step` waterfall — appends one recalled-context message to the step's decision |
| `experimental.chat.system.transform` | `ctx.systemPrompt.section({ name: 'lcm:hint', order: 9000 })` |
| `experimental.session.compacting` | the resume note is delivered through automatic recall on the first turn after a `compaction/*` marker |
| `tool` hook — 18 `lcm_*` tools | `ctx.tools.register()` — the same 18 tools |
| `command` surface (none upstream) | `ctx.commands.register()` — the human-facing `/lcm` command |
| `.lcm/lcm.db` (SQLite + FTS5) | `<DSH_HOME>/storages/dsh-plugin-lcm/lcm.db` (SQLite + FTS5 via `node:sqlite`) |

The Harness session log is already a lossless append-only record, so the archive is treated
strictly as a **derived cache**: if a capture is ever missed, the next read notices the
watermark lag and replays the missing prefix. Nothing in this plugin can lose conversation
content.

## Installation

The plugin is a plain Host bundle with no runtime dependencies beyond `node:sqlite`, which the
Harness itself already uses for session search.

```
plugin_manager { action: install_bundle, target: "D:\\src\\openseek-lcm" }
```

`target` accepts anything pnpm can install — a local directory (as above), a git URL, a tarball,
or an npm name. The composed row is named `@local/dsh-plugin-lcm`; that is only a bundle id, and
the repository is `openseek-lcm`.

> **Windows path caveat.** Install from a **drive-letter** path. pnpm rewrites a `\\server\share`
> target into a broken relative symlink, and activation then fails with
> *"cannot resolve profile bundle"*. Use a mapped drive letter or a local path.

A restart of DeepSeek Harness Desktop is required after installing or changing the plugin: the
Cordis loader keeps the module generation it first imported. Editing a *config* value is picked
up by a reload; editing **code** is not.

## Configuration

Set values in the plugin row's `config` (see [`cordis.patch.yml`](./cordis.patch.yml), which
carries every key with its default and a short comment). All keys are optional; a missing key
falls back to the default, so an empty `config: {}` is valid.

| Key | Default | Meaning |
|---|---|---|
| `storeDir` | `<DSH_HOME>/storages/dsh-plugin-lcm` | Archive directory (DSH plugin-data area). |
| `capture.enabled` | `true` | Master capture switch. |
| `capture.includeToolResults` | `true` | Archive tool outputs. |
| `capture.maxTextCharsPerMessage` | `60000` | Per-message cap on indexed text. |
| `automaticRetrieval.enabled` | `true` | Automatic recall on each new user turn. |
| `automaticRetrieval.maxChars` | `900` | Hard cap on injected recall text. |
| `automaticRetrieval.minTokens` | `2` | Minimum query tokens before recall runs. |
| `automaticRetrieval.maxMessageHits` / `maxSummaryHits` / `maxArtifactHits` | `2` / `1` / `1` | Per-kind quotas. |
| `automaticRetrieval.scopeOrder` | `[session, root, worktree]` | Escalation ladder, cheapest first. |
| `automaticRetrieval.scopeBudgets` | `{session:16, root:12, worktree:8, all:6}` | Candidate budget per scope. |
| `automaticRetrieval.stop.targetHits` | `3` | Stop once this many hits are selected. |
| `freshTailMessages` | `10` | Newest messages kept out of recall (the model already sees them). |
| `summary.minMessagesForTransform` | `16` | Archived messages required before a summary tree is built. |
| `summary.levelSize` | `6` | Children folded into one parent. |
| `summary.summaryCharBudget` | `1500` | Character budget per summary node. |
| `systemHint` / `systemHintOrder` | `true` / `9000` | The prompt section that tells the model the archive exists. |
| `tools.enabled` | `true` | Register the `lcm_*` suite. |
| `tools.expose` | — | Allow-list of tool names, to cut per-request schema tokens. |
| `retention.staleSessionDays` | disabled | Prune sessions untouched for N days. |
| `retention.deletedSessionDays` | `30` | Prune deleted sessions after N days. |
| `retention.orphanBlobDays` | `14` | Grace period before an unreferenced blob is collectable. |
| `privacy.excludeToolPrefixes` | `[]` | Do not archive payloads from tools with these prefixes. |
| `privacy.excludePathPatterns` | `[]` | Suppress/redact matching paths. |
| `privacy.redactPatterns` | `[]` | Destructively replace matches before storage. |

## Tools

All 18 upstream tools are provided with the same names, arguments and defaults. Mutating tools
are dry-run unless `apply: true`.

| Tool | Purpose |
|---|---|
| `lcm_status` | Archive and configuration inventory. |
| `lcm_retrieval_debug` | Diagnostics of the last automatic recall (per scope, raw vs selected). |
| `lcm_resume` | The durable resume note for a session. |
| `lcm_grep` | Scoped archive search, with `offset` pagination and `summaryID` subtree restriction. |
| `lcm_describe` | What the archive holds for a scope. |
| `lcm_lineage` | Ancestry and direct children of a session. |
| `lcm_expand` | Walk summary nodes; `includeRaw` only when summaries are insufficient. |
| `lcm_artifact` | Read an externalized payload (accepts an unambiguous id prefix). |
| `lcm_pin_session` / `lcm_unpin_session` | Protect a session from retention. |
| `lcm_blob_stats` / `lcm_blob_gc` | Deduplicated blob inventory / orphan collection. |
| `lcm_compact` | Prune internal events, VACUUM, then checkpoint the WAL. |
| `lcm_doctor` | Integrity inspection; repairs FTS and summary state with `apply: true`. |
| `lcm_retention_report` / `lcm_retention_prune` | Preview / apply the retention policy. |
| `lcm_export_snapshot` / `lcm_import_snapshot` | Portable JSON snapshots (`merge` or `replace`). |

Every visible tool schema is attached to **every** request, so the suite costs prompt tokens on
each call. `tools.expose` and `tools.enabled` exist to trim that cost.

## The `/lcm` command

Everything else this plugin exposes is model-facing. `/lcm` is the surface a person drives
directly from the composer — one command with subcommands, so it adds a single entry to the
command palette. Its output is shown to you and is not injected into the conversation.

```
/lcm status                               archive inventory and configuration
/lcm grep <query> [--scope s] [--limit n] search (s = session|root|worktree|all)
/lcm expand <nodeID|query> [raw]          progressively expand summary nodes
/lcm describe [scope]                     what the archive holds
/lcm resume                               the note that survives a compaction
/lcm lineage                              this session ancestry and children
/lcm debug                                diagnostics of the last automatic recall
/lcm pin [reason] | unpin                 protect this session from retention
/lcm blobstats [n]                        artifact blob inventory
/lcm gc [apply]                           preview or delete orphaned blobs
/lcm compact [apply]                      preview or reclaim database space
/lcm doctor [apply]                       inspect or repair summaries and indexes
/lcm retention [apply]                    preview or apply the retention policy
```

As everywhere else, the mutating subcommands are preview-only unless you pass `apply`.
The command is registered through an optional dependency, so a profile without the command
registry keeps the archive, the automatic recall and the model-facing tools. Command output is
human-only by design — it is rendered in the UI and never becomes a model message.

## Deliberate differences from opencode-lcm

These are adaptations to real Harness semantics, not omissions.

1. **Recalled context is durable.** The Harness commits the accepted `user/message` batch to the
   session log, so a recall injection (tagged `source.kind = 'lcm-recall'`) is persisted rather
   than being a transient request rewrite. This makes replay and resume deterministic; the cost
   is bounded log growth, capped by `automaticRetrieval.maxChars` per new user turn. Continuation
   steps claim no new prompt and are never re-injected.
2. **The index stores n-grams, not raw text.** Upstream relies on FTS5's default `unicode61`
   tokenizer, which treats a whole run of Han characters as one token, so `无损上下文记忆` is
   unsearchable by `上下文`. Switching to the `trigram` tokenizer fixes that and then fails on
   two-character words — which is the normal length of a Chinese word (召回, 诊断, 记忆, 索引).
   Instead, `explodeForIndex` rewrites text into ordered n-grams sized per script (bigrams for
   CJK, trigrams for Latin) and the tables index that with `unicode61`, so "does this substring
   occur?" becomes "does this gram sequence occur adjacently?" — which holds for Latin
   substrings and two-character Chinese words alike. The tokenizer is declared as
   `unicode61 tokenchars '_'` so identifiers such as `store_path` keep their underscores.
3. **Candidate retrieval is OR, precision comes from ranking.** `buildFtsQuery` turns each run
   into a gram phrase and combines bare terms with `OR` (quoted groups with `AND`), because this
   expression only gathers candidates: the ported JavaScript re-ranker decides order using token
   coverage, phrase hits, role and recency, checked against the *original* text. ANDing every term
   of a natural-language query would reject nearly every relevant message. When the index cannot
   answer at all — a term shorter than its script gram, for instance — automatic retrieval retries
   once with a bounded substring scan.
   Query terms are also filtered before use. A term the archive has never seen is dropped —
   upstream's TF-IDF order ranks such a term *first*, because a word that appears nowhere looks
   maximally rare, which spends the whole retrieval budget on a query that can match nothing — and
   the "appears in more than 80% of documents" stop-word rule is applied only once the corpus is
   large enough for that ratio to be meaningful, falling back to the common terms rather than to no
   query at all when it would otherwise discard every one of them.
4. **CJK tokenization was added.** Upstream's `tokenizeQuery` recognizes only `[a-z0-9_]+`, so
   every Chinese query collapses to zero tokens and silently disables retrieval. Here CJK runs
   contribute bigrams for scoring, and the same bigram width is what the index stores, so a
   two-character Chinese query is answerable by the index itself rather than by a scan.
5. **The compaction resume note is delivered through recall.** The Harness owns compaction and
   offers no hook to append to the summarization input, so instead of injecting into the
   compaction prompt the note is emitted for the first turn after a `compaction/*` marker. The
   upstream outcome — important context survives the shrink without overriding the compaction
   prompt — is preserved.
6. **`worktree` means "same working directory".** The Harness has no git-worktree concept, so
   the `worktree` scope is every session whose `cwd` matches. `root` is the branch tree derived
   from each session header's `parentSession` chain.
7. **One row per message, not messages + parts.** Harness messages carry
   `content: ContentBlock[]` inline, so the archive stores a single row per message plus
   `artifacts` for oversized blocks; summary nodes range over log `seq` rather than array indices.
8. **The archive lives in DSH's plugin-data area, not in `.lcm`.** Upstream stores its
   database at `<project>/.lcm/lcm.db`. That convention belongs to opencode, and a bare
   `lcm` directory under a shared home is easy to confuse with it, so this plugin defaults to
   `<DSH_HOME>/storages/dsh-plugin-lcm/` — inside DSH's own configuration tree, alongside the
   other per-plugin storage domains (`session_projcache`, `maidsh_memory`). `storeDir` overrides
   it outright; the archive is derived data and can always be rebuilt from the session logs.
9. **Compaction order is prune → VACUUM → checkpoint.** This is a bug fix, not a port decision.
   `VACUUM` rewrites the whole database *through the WAL*, so checkpointing before it leaves the
   reclaimed pages sitting in the WAL: the operation reports a small `reclaimed` value while the
   WAL grows by the size of the database. On the development archive the first run reported
   `reclaimed=7.6 MiB` and pushed the WAL from 48.7 MB to 89.9 MB; with the order corrected the
   same operation reclaimed ~97.7 MiB.
10. **Not ported:** upstream's binary preview providers (`fingerprint`, `byte-peek`,
    `image-dimensions`, `pdf-metadata`, `zip-metadata`, `previewBytePeek`) and
    `lcm_import_snapshot`'s `worktreeMode`. Harness tool results arrive as typed content blocks in
    which images and files are already attachment references rendered as short placeholders, and
    there is no worktree identity to remap.

## Verification

Three suites verify this plugin without a live profile. They need Node ≥ 22.5 for `node:sqlite`;
the Host's own runtime Node works too.

```powershell
node test/smoke.mjs
node test/recall.mjs
node test/plugin.mjs
```

`test/smoke.mjs` drives the whole archive pipeline against a throwaway database with synthetic
Harness-shaped session events (30 checks).

It covers capture and idempotent re-capture, artifact externalization and pre-storage redaction,
the n-gram search primitives (`explodeForIndex`, `buildFtsQuery`), all four scopes, summary-tree
determinism, FTS-only search (proving the index path rather than
the fallback), CJK search, short-query scan fallback, summary-subtree restriction, progressive
expansion, automatic recall bounds, resume notes, pins, blob stats, doctor repair, retention
dry-run vs apply, compaction, snapshot round-trip, and tool-payload exclusion.

`test/recall.mjs` covers the decision that needs a live Harness the least and a test the most:
anchor selection against injected context, declining a continuation batch, the three sources the
owning Agent is resolved from (including a scope that throws), injection bounds and tagging,
resume-note escalation being consumed exactly once, and merging a plan without losing the rest of
the step decision (11 checks).

`test/plugin.mjs` is the closest thing to a live run without a restart: it imports `index.js`
exactly as the loader would and runs `apply()` against a minimal fake Cordis host, then asserts
that every registration happened on the synchronous path, that all 18 tools carry usable
schemas, that the system hint is one non-interpolating section at the configured order, that the
scoped listeners subscribe with `global: true`, that a live `session/event` is buffered rather
than written inline, that a tool call backfills the archive, that a real `agent/pre-step`
dispatch injects tagged recalled context while preserving the rest of the decision, and that the
`/lcm` definition satisfies the command-registry contract (name shape, non-empty description,
non-empty input hint, handler function) including the raw-input shape the registry actually
delivers — the separating space included (16 checks).

Live state on the development profile (2026-10-02, 6 sessions):

```
schema_version=3        fts_available=true      capture_failures=0
message_count=6376      summary_nodes=1270       artifacts=2240
artifact_blobs=2251     shared_blobs=11          orphan_blobs=0
db_bytes=91.7 MiB       wal_bytes=4.4 MiB
```

The schema v2 -> v3 search-index migration was measured against a copy of that live archive:
9,625 documents were reindexed in 1.7 s during activation, after which `召回`, `诊断`,
`召回诊断` and `归档` — every one of them a two-character Chinese term — all matched through
the index alone (`allowScan: false`), and automatic retrieval for `看下召回诊断` returned 3
hits where it previously returned none.

`lcm_grep "trigram tokenizer"` returned ranked hits spanning an assistant message and two
externalized artifacts; `lcm_expand` built and walked a 3-level summary tree over real log
sequence 1007–1144.

## Limitations

- **Archive size is real.** 6,376 messages produced ~92 MB. Run `lcm_compact apply=true` after
  large captures, and use `lcm_retention_report` to review growth.
- **Summary nodes are digests, not substitutes.** A 1,500-character root cannot represent
  thousands of messages; the tree exists to navigate down to raw text, which is why
  `lcm_expand includeRaw=true` remains the last resort.
- **Tool schemas cost prompt tokens on every request** while `tools.enabled` is true.
- **Code changes need a full application restart.** Reloading the profile reuses the cached
  module generation, so a plugin edit appears to do nothing until the process is restarted.
- `node:sqlite` is required. It is available in this Harness build (the shipped
  `dsh-session-query-sqlite` package uses the same module); on a build without it the plugin
  reports the archive error and degrades instead of failing the conversation.

## Acknowledgements and licence

MIT — see [LICENSE](./LICENSE).

The design is ported from [`opencode-lcm`](https://github.com/Plutarch01/opencode-lcm) by
**Isaac Grumberg** (MIT), the OpenCode implementation of Lossless Context Memory. Upstream's
copyright notice is retained in [NOTICE](./NOTICE), together with the paper the technique comes
from.

This is a community port. It is not affiliated with or endorsed by the DeepSeek Harness or
OpenCode projects.
