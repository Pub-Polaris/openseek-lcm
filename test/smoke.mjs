/**
 * End-to-end smoke test for the LCM archive store.
 *
 * Runs the whole pipeline against a throwaway database using synthetic Harness
 * session events, so a defect is caught here rather than inside a live profile.
 *
 * Run with the Harness runtime's Node (the one whose `node:sqlite` the Host
 * itself uses):
 *
 *   node test/smoke.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { resolveConfig, resolveHomeDir } from '../lib/config.js';
import { SCHEMA_VERSION, openArchive } from '../lib/db.js';
import { isInjectedSourceKind } from '../lib/messages.js';
import { compilePrivacy } from '../lib/privacy.js';
import { LcmStore } from '../lib/store.js';
import { buildTools } from '../lib/tools.js';
import { buildFtsQuery, explodeForIndex, gramsOf, hashContent, runsOf, unindexableRuns } from '../lib/text.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lcm-smoke-'));
let failures = 0;

function check(label, fn) {
  try {
    fn();
    process.stdout.write(`ok   ${label}\n`);
  } catch (error) {
    failures += 1;
    process.stdout.write(`FAIL ${label}\n     ${error?.message ?? error}\n`);
  }
}

/** A check whose body awaits a tool call. */
async function checkAsync(label, fn) {
  try {
    await fn();
    process.stdout.write(`ok   ${label}\n`);
  } catch (error) {
    failures += 1;
    process.stdout.write(`FAIL ${label}\n     ${error?.message ?? error}\n`);
  }
}

const logger = {
  info: () => {},
  warn: (m) => process.stdout.write(`warn ${m}\n`),
  debug: () => {},
  error: (m) => process.stdout.write(`err  ${m}\n`),
};

// ---------------------------------------------------------------- fixtures

const SESSION_ID = 'session-smoke-0001';
const header = {
  version: 4,
  id: SESSION_ID,
  createdAt: Date.now() - 86_400_000,
  cwd: 'C:\\work\\project',
  isSeeded: false,
  delegationDepth: 0,
};

const HUGE = 'tool-output-line-with-a-secret-sk-ABCDEF123456\n'.repeat(120);

/** Build a synthetic but Harness-shaped session log. */
function buildEvents() {
  const events = [];
  let seq = 0;
  const push = (type, data) => {
    events.push({ type, seq, time: header.createdAt + seq * 1000, data });
    seq += 1;
  };

  push('session/title', { title: 'Lossless context memory port' });
  push('turn/start', { turn: 1 });

  for (let turn = 1; turn <= 12; turn += 1) {
    push('user/message', {
      id: `msg-u-${turn}`,
      role: 'user',
      content: [{ type: 'text', text: `Turn ${turn}: please check the archive recall path and the 无损上下文记忆 summary tree.` }],
      source: { kind: 'user' },
    });
    push('assistant/message', {
      message: {
        id: `msg-a-${turn}`,
        role: 'assistant',
        content: [
          { type: 'text', text: `Working on turn ${turn}. The retriever ranks candidates with token coverage and recency.` },
          { type: 'tool-call', id: `call-${turn}`, name: 'pwsh', arguments: JSON.stringify({ command: `echo ${turn}` }) },
        ],
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      },
    });
    push('tool/call', {
      turn,
      step: 1,
      callId: `call-${turn}`,
      name: 'pwsh',
      arguments: JSON.stringify({ command: `echo ${turn}`, description: 'smoke' }),
    });
    push('tool/result', {
      message: {
        id: `msg-t-${turn}`,
        role: 'tool',
        toolCallId: `call-${turn}`,
        isError: false,
        content: [{ type: 'text', text: turn === 5 ? HUGE : `output for turn ${turn}` }],
        source: { kind: 'tool', callId: `call-${turn}` },
      },
    });
  }

  // A real DSH compaction payload. The backend records the exact span it
  // shadowed, which is what makes the pointer a lookup instead of a search.
  push('compaction/start', {});
  push('compaction/summary', {
    summary: 'condensed turns 1-8',
    shadowedRange: { start: 1, end: 20 },
    shadowedSeqs: Array.from({ length: 20 }, (_, index) => index + 1),
    shadowedTokenCount: 4321,
  });
  // Live archives store NULL for all three span fields on `compaction/end`, so
  // it must never be treated as a fallback source for the pointer.
  push('compaction/end', { shadowedRange: null, shadowedSeqs: null, shadowedTokenCount: null });
  push('turn/end', { turn: 12, reason: { kind: 'stop' } });
  return events;
}

/** A compaction row whose payload carries no span at all. */
const NO_SPAN_ID = 'session-smoke-0003';
const noSpanHeader = { ...header, id: NO_SPAN_ID };

/** A session whose only compaction rows are `start`/`end`, as live archives have. */
const COMPACT_ONLY_ID = 'session-smoke-0004';
const compactOnlyHeader = { ...header, id: COMPACT_ONLY_ID };

/** A second session in the same working directory, for scope tests. */
const SIBLING_ID = 'session-smoke-0002';
const siblingHeader = { ...header, id: SIBLING_ID, parentSession: 'session-smoke-parent' };
const parentHeader = { ...header, id: 'session-smoke-parent', cwd: header.cwd };

// -------------------------------------------------------------------- tests

// The Host process does not receive DSH_HOME, so a wrong fallback here would
// silently scatter archives into profile directories.
check('home directory resolution prefers env, then the profile layout, then ~/.dsh', () => {
  assert.equal(resolveHomeDir({ env: { DSH_HOME: 'D:\\harness-home' }, cwd: 'C:\\ignored' }), 'D:\\harness-home');
  assert.equal(
    resolveHomeDir({ env: {}, cwd: 'C:\\Users\\someone\\.dsh\\profiles\\desktop' }),
    'C:\\Users\\someone\\.dsh',
    'derives the home from the profile working directory',
  );
  assert.equal(
    resolveHomeDir({ env: {}, cwd: 'C:/Users/someone/.dsh/profiles/desktop' }),
    'C:/Users/someone/.dsh',
    'handles forward slashes',
  );
  assert.equal(
    resolveHomeDir({
      env: {},
      cwd: 'C:\\Users\\someone\\.dsh\\profiles\\desktop\\nested',
      home: () => 'C:\\Users\\someone',
    }),
    'C:\\Users\\someone\\.dsh',
    'a deeper directory is not mistaken for the profile root and falls through to the OS default',
  );
  assert.equal(resolveHomeDir({ env: {}, cwd: 'C:\\elsewhere', home: () => 'C:\\Users\\someone' }), 'C:\\Users\\someone\\.dsh');
});

check('storeDir defaults into the DSH plugin-data area and an explicit storeDir wins', () => {
  const automatic = resolveConfig({}, { homeDir: 'C:\\Users\\someone\\.dsh' }).storeDir;
  // It must stay inside the Harness home and be namespaced to this plugin, so it
  // cannot be confused with opencode-lcm's per-project .lcm store.
  assert.match(automatic, /^C:[\\/]Users[\\/]someone[\\/]\.dsh[\\/]/);
  assert.match(automatic, /[\\/]storages[\\/]dsh-plugin-lcm$/);
  assert.equal(resolveConfig({ storeDir: 'X:\\custom' }, { homeDir: 'C:\\Users\\someone\\.dsh' }).storeDir, 'X:\\custom');
  assert.equal(resolveConfig({}, {}).storeDir, undefined);
});

// The index is built from n-gram-exploded text. A regression in these primitives
// would silently disable search, so they are asserted directly.
check('explodeForIndex emits ordered per-script n-grams', () => {
  assert.equal(explodeForIndex('召回诊断'), '召回 回诊 诊断');
  assert.equal(explodeForIndex('上下文记忆'), '上下 下文 文记 记忆');
  assert.equal(explodeForIndex('retriever'), 'ret etr tri rie iev eve ver');
  assert.equal(explodeForIndex('ab'), 'ab', 'a run shorter than the gram width stays whole');
  assert.equal(
    explodeForIndex('store_path'),
    'sto tor ore re_ e_p _pa pat ath',
    'underscores continue a Latin run, which is why tokenchars keeps them in tokens',
  );
  assert.deepEqual(runsOf('Hello 世界 ok'), ['hello', '世界', 'ok']);
  assert.deepEqual(gramsOf('abcde', 3), ['abc', 'bcd', 'cde']);
  assert.deepEqual(gramsOf('召回', 2), ['召回']);
});

check('buildFtsQuery turns a two-character Chinese term into a matchable phrase', () => {
  assert.equal(buildFtsQuery('召回'), '("召回")');
  assert.equal(buildFtsQuery('上下文记忆'), '("上下 下文 文记 记忆")');
  assert.equal(buildFtsQuery('召回 诊断'), '("召回" OR "诊断")');
  assert.equal(buildFtsQuery('a'), undefined, 'a single Latin character is not a useful filter');
  assert.equal(buildFtsQuery(''), undefined);
});

check('similarity retrieval is off by default', () => {
  assert.equal(resolveConfig({}, {}).automaticRetrieval.enabled, false);
  assert.equal(resolveConfig({ automaticRetrieval: { enabled: true } }, {}).automaticRetrieval.enabled, true);
});

const config = resolveConfig(
  {
    storeDir: dir,
    privacy: { redactPatterns: ['sk-[A-Za-z0-9]+'] },
    // Similarity retrieval is off by default now; these checks assert the
    // retrieval machinery itself, so they opt in explicitly.
    automaticRetrieval: { enabled: true },
  },
  { homeDir: dir },
);
const store = new LcmStore({ config, logger });

check('store opens and creates its schema', () => {
  store.init();
  assert.equal(store.ready, true);
  assert.ok(fs.existsSync(store.dbPath), 'database file exists');
});

const events = buildEvents();

check('capture archives message-bearing events', () => {
  store.upsertSession(parentHeader);
  const result = store.capture(header, events);
  assert.ok(result.captured >= 36, `captured ${result.captured} messages`);
  const stats = store.stats();
  assert.equal(stats.messageCount, result.captured);
  assert.equal(store.sessionRow(SESSION_ID).title, 'Lossless context memory port');
  assert.ok(store.sessionRow(SESSION_ID).compacted_at > 0, 'compaction marker recorded');
});

check('capture is incremental and idempotent', () => {
  const again = store.capture(header, events);
  assert.equal(again.captured, 0, 'nothing re-captured');
  assert.ok(again.skipped >= 36);
});

// Archive one live message at a seq past the watermark, whichever fixtures came
// before it: `capture` ignores anything at or below the frontier, so a hardcoded
// seq would be silently skipped once another live capture had run.
let nextLiveSeq = 1000;
function captureLiveMessage(id, text) {
  nextLiveSeq += 1;
  return store.capture(header, [
    {
      type: 'user/message',
      seq: nextLiveSeq,
      time: Date.now(),
      data: { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
    },
  ]);
}

// The deterministic replacement for per-turn similarity search: the compaction
// backend already recorded the exact span it removed, so this is a lookup.
check('latestCompaction returns the recorded shadowed span', () => {
  const compactionSummarySeq = events.find((event) => event.type === 'compaction/summary').seq;
  const pointer = store.latestCompaction(SESSION_ID);
  assert.ok(pointer, 'no pointer for a session with a real compaction payload');
  assert.equal(pointer.summarySeq, compactionSummarySeq);
  assert.equal(pointer.startSeq, 1);
  assert.equal(pointer.endSeq, 20);
  assert.equal(pointer.count, 20, 'the shadowedSeqs list is the authoritative count');
  assert.equal(pointer.tokens, 4321);
  assert.ok(Array.isArray(pointer.entryNodes), 'entryNodes must always be an array');
  assert.ok(Object.isFrozen(pointer), 'the pointer is frozen');
});

check('latestCompaction declines payloads without a usable span', () => {
  store.capture(noSpanHeader, [{ type: 'compaction/summary', seq: 0, time: 1, data: { summary: 'no span here' } }]);
  assert.equal(store.latestCompaction(NO_SPAN_ID), undefined, 'a payload without a span yields no pointer');

  // Real archives record start/end with NULL span fields, so they are not a
  // fallback source and must not fabricate a pointer.
  store.capture(compactOnlyHeader, [
    { type: 'compaction/start', seq: 0, time: 1, data: { shadowedRange: null, shadowedSeqs: null, shadowedTokenCount: null } },
    { type: 'compaction/end', seq: 1, time: 2, data: { shadowedRange: null, shadowedSeqs: null, shadowedTokenCount: null } },
  ]);
  assert.equal(store.latestCompaction(COMPACT_ONLY_ID), undefined, 'start/end alone carry no recoverable span');

  assert.equal(store.latestCompaction('session-smoke-parent'), undefined, 'a session that never compacted');
  assert.equal(store.latestCompaction(undefined), undefined);
});

check('oversized payload is externalized and redacted', () => {
  const blob = store.get('SELECT COUNT(*) AS n FROM artifact_blobs')?.n ?? 0;
  assert.ok(blob >= 1, 'an artifact blob exists');
  // The body lives in the blob; the artifact row keeps only the preview, the
  // hash and the length. Reading it back through the join is the contract.
  const row = store.get(
    `SELECT a.artifact_id, a.preview_text, b.content_text AS blob_text
       FROM artifacts a
       LEFT JOIN artifact_blobs b ON b.content_hash = a.content_hash
      WHERE a.artifact_kind = 'text' LIMIT 1`,
  );
  assert.ok(row, 'artifact row exists');
  assert.ok(!row.blob_text.includes('sk-ABCDEF123456'), 'secret was redacted before storage');
  assert.ok(row.blob_text.includes('[REDACTED]'), 'redaction marker present');
});

/**
 * A store of its own for the capture-filter checks.
 *
 * `stats().messageCount` is the assertion, so the existing session must not be
 * touched: an injected message that *is* captured moves the count of whatever
 * archive the check runs against.
 */
function tempStore(name, overrides = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-lcm-${name}-`));
  const temp = new LcmStore({ config: resolveConfig({ storeDir: tempDir, ...overrides }, { homeDir: tempDir }), logger });
  temp.init();
  return { store: temp, dir: tempDir };
}

check('capture skips harness-injected and self-generated messages', () => {
  // The Harness commits every injected message as a durable `user/message`, so
  // archiving them verbatim made the plugin recall its own `lcm-recall` output and
  // stored the same `runtime-context` envelope dozens of times.
  const { store: filtered, dir: filteredDir } = tempStore('injected');
  try {
    assert.equal(isInjectedSourceKind({ source: { kind: 'lcm-recall' } }), true);
    assert.equal(isInjectedSourceKind({ source: { kind: 'runtime-context' } }), true);
    assert.equal(isInjectedSourceKind({ source: { kind: 'user' } }), false);
    assert.equal(isInjectedSourceKind({}), false, 'an unknown source is real input');
    // An unknown kind is captured: a future injector costs archive bytes, whereas
    // a blocklist that guessed wrong would silently lose a real turn.
    assert.equal(isInjectedSourceKind({ source: { kind: 'some-future-injector' } }), false);

    const before = filtered.stats().messageCount;
    let seq = 0;
    const push = (type, data) => ({ type, seq: seq++, time: Date.now(), data });
    filtered.capture(header, [
      push('user/message', {
        id: 'injected-recall',
        role: 'user',
        content: [{ type: 'text', text: 'this is the plugin replaying its own recalled context' }],
        source: { kind: 'lcm-recall' },
      }),
      push('user/message', {
        id: 'injected-context',
        role: 'user',
        content: [{ type: 'text', text: 'runtime envelope the harness injects on every step' }],
        source: { kind: 'runtime-context' },
      }),
      push('user/message', {
        id: 'injected-system-prompt',
        role: 'user',
        content: [{ type: 'text', text: 'system prompt body' }],
        source: { kind: 'system-prompt' },
      }),
    ]);
    assert.equal(filtered.stats().messageCount, before, 'an injected message was archived, so it can be recalled again');

    filtered.capture(header, [
      push('user/message', {
        id: 'real-turn',
        role: 'user',
        content: [{ type: 'text', text: 'genuine operator input' }],
        source: { kind: 'user' },
      }),
    ]);
    assert.equal(filtered.stats().messageCount, before + 1, 'a real user message must still be archived');
  } finally {
    filtered.close();
    fs.rmSync(filteredDir, { recursive: true, force: true });
  }
});

check('capture.includeSystemMessages decides whether system messages are archived', () => {
  // The flag was resolved from config and read nowhere, so it was dead config:
  // a system message was archived or dropped by accident, not by policy.
  const systemEvents = () => [
    {
      type: 'system/message',
      seq: 0,
      time: 1,
      data: {
        message: {
          id: 'sys-1',
          role: 'system',
          content: [{ type: 'text', text: 'a system message that policy decides on' }],
          source: { kind: 'system' },
        },
      },
    },
  ];

  const { store: excluding, dir: excludingDir } = tempStore('sys-excluded');
  try {
    excluding.capture(header, systemEvents());
    assert.equal(excluding.stats().messageCount, 0, 'the default must exclude system messages');
  } finally {
    excluding.close();
    fs.rmSync(excludingDir, { recursive: true, force: true });
  }

  const { store: including, dir: includingDir } = tempStore('sys-included', { capture: { includeSystemMessages: true } });
  try {
    including.capture(header, systemEvents());
    assert.equal(including.stats().messageCount, 1, 'includeSystemMessages=true must archive them');
  } finally {
    including.close();
    fs.rmSync(includingDir, { recursive: true, force: true });
  }
});

check('artifact content is stored in the blob alone and indexed from the preview', () => {
  // The oversized block above went through the production capture path, so this
  // measures the layout rather than a hand-written INSERT: the removed third copy
  // is the one the old schema wrote into `artifacts.content_text` *and* the one it
  // exploded into `artifact_fts.content`.
  const inline = store.stats().artifactInlineBodyChars;
  assert.equal(inline, 0, `${inline} artifact body characters are still stored inline in artifacts.content_text`);

  // No secret in this body: redaction would change the length, and the exact
  // body/blob equality below is the point of the check.
  const body = `PREVIEW-INDEXED-HEADER ${'a tail line that is deliberately beyond the preview budget. '.repeat(120)}`;
  captureLiveMessage('msg-live-artifact-layout', body);
  const artifactId = 'msg-live-artifact-layout:0';
  const row = store.get('SELECT artifact_id, preview_text, content_text, content_hash, char_count FROM artifacts WHERE artifact_id = ?', artifactId);
  assert.ok(row, 'the oversized block was not externalized into an artifact');
  assert.equal(row.content_text, null, 'the artifact row still carries its own copy of the body');
  assert.ok(row.preview_text.length < body.length, 'the preview must be a truncation of the body');
  assert.equal(row.char_count, body.length, 'the artifact still records the full length');

  // The body is not lost: it is reachable through the blob, keyed by the hash the
  // artifact records.
  const blob = store.get('SELECT content_text FROM artifact_blobs WHERE content_hash = ?', row.content_hash);
  assert.ok(blob, 'the artifact points at a blob that does not exist');
  assert.equal(blob.content_text, body, 'the body must be reachable through the content-addressed blob join');
  assert.match(store.artifact({ artifactId, sessionId: SESSION_ID }), /a tail line that is deliberately/, 'the body is not readable through lcm_artifact');

  // The index is built from the preview alone: a phrase from the leading text is
  // findable without a scan, and the rest of the body is not in the index.
  const indexed = store.get('SELECT content FROM artifact_fts WHERE artifact_id = ?', artifactId)?.content ?? '';
  assert.ok(indexed.length > 0, 'the artifact was not indexed at all');
  assert.ok(!indexed.includes('tail'), 'the body beyond the preview was exploded into artifact_fts');
  assert.ok(
    store.grep({ query: 'PREVIEW-INDEXED-HEADER', sessionId: SESSION_ID, allowScan: false }).some((hit) => hit.id === artifactId),
    'the artifact is not discoverable by a phrase from its preview without a scan',
  );
});

check('a compaction payload is stored as its span, not as the whole report', () => {
  // Live archives measured `compaction/summary` at 96% of all event bytes. Only
  // the span is ever read back, so the report body is not worth a database row.
  const { store: compaction, dir: compactionDir } = tempStore('payload');
  try {
    const summary = 's'.repeat(9000);
    const sequenceSpan = Array.from({ length: 40 }, (_, index) => index + 1);
    compaction.capture(header, [
      {
        type: 'compaction/summary',
        seq: 0,
        time: 5,
        data: {
          summary,
          shadowedRange: { start: 1, end: 40 },
          shadowedSeqs: sequenceSpan,
          shadowedTokenCount: 4321,
        },
      },
    ]);
    const payload = compaction.get("SELECT payload_json FROM events WHERE event_type = 'compaction/summary'")?.payload_json ?? '';
    assert.ok(payload.length < 600, `the stored payload is ${payload.length} chars; it looks untrimmed`);
    assert.ok(!payload.includes(summary), 'the compaction report body was retained');
    assert.ok(payload.includes('shadowedRange') && payload.includes('4321'), 'the span the pointer reads was dropped');
    assert.equal(compaction.latestCompaction(SESSION_ID)?.count, sequenceSpan.length, 'the pointer no longer reads the trimmed payload');
  } finally {
    compaction.close();
    fs.rmSync(compactionDir, { recursive: true, force: true });
  }
});

check('a later compaction event never moves the marker backwards', () => {
  // `compaction/summary` and `compaction/end` both stamp `compacted_at`, and two
  // of them can arrive with non-advancing times. Assignment let the older stamp
  // win and re-armed a note the model had already been shown.
  const { store: compaction, dir: compactionDir } = tempStore('marker');
  try {
    compaction.capture(header, [
      {
        type: 'compaction/summary',
        seq: 0,
        time: 500,
        data: { shadowedRange: { start: 1, end: 4 }, shadowedSeqs: [1, 2, 3, 4], shadowedTokenCount: 10 },
      },
      {
        type: 'compaction/end',
        seq: 1,
        time: 100,
        data: { shadowedRange: null, shadowedSeqs: null, shadowedTokenCount: null },
      },
    ]);
    assert.equal(compaction.sessionRow(SESSION_ID).compacted_at, 500, 'the older event moved the durable marker backwards');
  } finally {
    compaction.close();
    fs.rmSync(compactionDir, { recursive: true, force: true });
  }
});

check('scope resolution covers session, root, worktree, all', () => {
  store.capture(siblingHeader, [
    {
      type: 'user/message',
      seq: 0,
      time: Date.now(),
      data: { id: 'sib-u-1', role: 'user', content: [{ type: 'text', text: 'sibling session about the archive' }], source: { kind: 'user' } },
    },
  ]);
  assert.deepEqual(store.resolveScope('session', SESSION_ID), [SESSION_ID]);
  const worktree = store.resolveScope('worktree', SESSION_ID);
  assert.ok(worktree.includes(SESSION_ID) && worktree.includes(SIBLING_ID), `worktree=${worktree.join(',')}`);
  const root = store.resolveScope('root', SIBLING_ID);
  assert.ok(root.includes(SIBLING_ID), 'root scope contains the session itself');
  assert.ok(store.resolveScope('all', SESSION_ID).length >= 3, 'all scope sees every session');
});

check('summary tree is built deterministically and is idempotent', () => {
  const first = store.buildSummaries(SESSION_ID);
  assert.equal(first.rebuilt, true);
  assert.ok(first.nodes >= 2, `built ${first.nodes} nodes`);
  assert.ok(first.roots.length >= 1, 'at least one root');
  const second = store.buildSummaries(SESSION_ID);
  assert.equal(second.rebuilt, false, 'unchanged archive is not rebuilt');
  assert.deepEqual(second.roots, first.roots);
});

check('English search returns ranked hits through FTS alone', () => {
  // allowScan=false proves the FTS path answers; a silently broken index would
  // otherwise be masked by the substring fallback.
  assert.equal(store.ftsAvailable, true, 'FTS must still be available');
  const results = store.grep({ query: 'retriever ranks candidates', sessionId: SESSION_ID, allowScan: false });
  assert.ok(Array.isArray(results), `expected results, got ${JSON.stringify(results)}`);
  assert.ok(results.length > 0, 'at least one hit');
  assert.ok(results[0].snippet.length > 0, 'hit carries a snippet');
  // Ranking must prefer the assistant message that actually contains the phrase.
  assert.equal(results[0].type, 'assistant', `top hit was ${results[0].type}`);
});

check('CJK search works through the index', () => {
  const results = store.grep({ query: '上下文记忆', sessionId: SESSION_ID, allowScan: false });
  assert.ok(Array.isArray(results) && results.length > 0, `CJK query returned ${JSON.stringify(results).slice(0, 200)}`);
});

check('a two-character CJK query is served by the index, not by a scan', () => {
  // Regression guard: under the previous trigram index a two-character Chinese
  // word produced no FTS expression at all, so recall silently returned nothing
  // for very ordinary Chinese questions.
  const results = store.grep({ query: '记忆', sessionId: SESSION_ID, allowScan: false });
  assert.ok(
    Array.isArray(results) && results.length > 0,
    `2-char CJK query returned ${JSON.stringify(results).slice(0, 200)}`,
  );
});

check('a sub-gram Latin query still falls back to the substring scan', () => {
  // Two-character Latin fragments are below the Latin index gram, so the index
  // cannot answer them; the scan is the safety net.
  assert.deepEqual(store.grep({ query: 're', sessionId: SESSION_ID, allowScan: false }), []);
  const results = store.grep({ query: 're', sessionId: SESSION_ID, allowScan: true });
  assert.ok(Array.isArray(results) && results.length > 0, 'the scan recovered the match');
});

check('a single CJK character reaches the substring scan', () => {
  // The index holds bigrams, so a one-character Han query has no gram to match
  // when that character sits inside a longer run: buildFtsQuery builds a valid
  // phrase that can never fire. The scan is the only path that can answer it, and
  // it must also run when the index answers *other* terms of the same query.
  assert.deepEqual(unindexableRuns('上'), ['上'], 'the index cannot represent a single Han character');
  assert.deepEqual(unindexableRuns('上下文'), [], 'a two-character run is representable');
  assert.deepEqual(
    store.grep({ query: '上', sessionId: SESSION_ID, allowScan: false }),
    [],
    'the index alone cannot answer a single Han character inside a longer Han run',
  );
  const scanned = store.grep({ query: '上', sessionId: SESSION_ID, allowScan: true });
  assert.ok(Array.isArray(scanned) && scanned.length > 0, `grep(上) returned ${JSON.stringify(scanned)}`);
  assert.ok(scanned.some((hit) => hit.snippet.includes('上')), 'the hit must contain the character');

  // Now the mixed query, which is the case that used to short-circuit. `summary`
  // is indexed and answers other messages, so the index returns candidates -- and
  // the old guard, "scan only when the index returned nothing", therefore never
  // scanned, leaving 上 unfindable. `上` sits inside a longer Han run, so no MATCH
  // expression can reach that row at all: the candidate set is where the guarantee
  // lives, and it is asserted there rather than through ranking or the cap.
  const liveId = 'msg-live-unindexable-term';
  captureLiveMessage(liveId, 'On disk, the 无损上下文记忆 run and one other marker.');
  const mixedQuery = { query: 'summary 上', sessionIds: [SESSION_ID] };
  assert.deepEqual(
    store.gatherCandidates({ ...mixedQuery, allowScan: false }).filter((candidate) => candidate.id === liveId),
    [],
    'the index alone reached the message that carries 上 only inside a longer Han run',
  );
  assert.ok(
    store.gatherCandidates({ ...mixedQuery, allowScan: true }).some((candidate) => candidate.id === liveId),
    'the scan did not run for the unindexable term of a mixed query',
  );
  const mixed = store.grep({ query: 'summary 上', sessionId: SESSION_ID, limit: 50 });
  assert.ok(
    Array.isArray(mixed) && mixed.some((hit) => hit.id === liveId),
    `the mixed query did not surface the scan-only hit: ${JSON.stringify(mixed?.map?.((hit) => hit.id))}`,
  );
});

check('summary nodes are searchable through FTS', () => {
  const built = store.buildSummaries(SESSION_ID);
  assert.ok(built.roots.length > 0, 'summary tree has a root');

  // The summary corpus must be indexed by the same FTS machinery. Compare
  // against the stored table, not `built.nodes`: an unchanged archive is not
  // rebuilt, so `nodes` is 0 on a second call by design.
  const nodeCount = store.get('SELECT COUNT(*) AS n FROM summary_nodes')?.n ?? 0;
  const rowCount = store.get('SELECT COUNT(*) AS n FROM summary_fts')?.n ?? 0;
  assert.ok(nodeCount > 0, 'summary nodes were stored');
  assert.equal(rowCount, nodeCount, `summary_fts rows=${rowCount} summary_nodes=${nodeCount}`);
  // The index stores n-grams, so a match expression must be built rather than
  // written as a bare word -- exactly how every production query path does it.
  const matched = store.get('SELECT COUNT(*) AS n FROM summary_fts WHERE summary_fts MATCH ?', buildFtsQuery('retriever'))?.n ?? 0;
  assert.ok(matched > 0, 'summary_fts MATCH found nothing');

  // ...and a grep over the archive must be able to surface a summary node.
  const results = store.grep({ query: 'retriever ranks candidates', sessionId: SESSION_ID, limit: 20, allowScan: false });
  assert.ok(Array.isArray(results), `expected array, got ${JSON.stringify(results)}`);
  assert.ok(
    results.some((result) => result.type === 'summary'),
    `summary corpus was not searched: ${JSON.stringify(results.map((r) => r.type))}`,
  );
});

check('containedSummaryNodes offers only nodes fully inside the span', () => {
  store.buildSummaries(SESSION_ID);
  // The node covering a compacted span is always the session-wide root, so the
  // useful entry points are the ones fully contained in it.
  const leaf = store.get(
    'SELECT node_id, start_seq, end_seq FROM summary_nodes WHERE session_id = ? AND level = 0 ORDER BY start_seq LIMIT 1',
    SESSION_ID,
  );
  assert.ok(leaf, 'the fixture built a leaf summary node');
  const contained = store.containedSummaryNodes(SESSION_ID, leaf.start_seq, leaf.end_seq);
  assert.ok(contained.includes(leaf.node_id), `leaf ${leaf.node_id} was not offered: ${JSON.stringify(contained)}`);
  assert.ok(contained.length <= 2, `at most two entry points, got ${contained.length}`);
  assert.deepEqual(store.containedSummaryNodes(SESSION_ID, leaf.end_seq, leaf.start_seq), [], 'an inverted span has no entry points');
});

check('summary-scoped grep restricts to one node subtree', () => {
  const built = store.buildSummaries(SESSION_ID);
  const scoped = store.grep({ query: 'summary tree', sessionId: SESSION_ID, summaryId: built.roots[0], allowScan: true });
  assert.ok(Array.isArray(scoped), 'scoped grep answers');
  const allowed = new Set(store.descendantMessageIds(built.roots[0]));
  for (const hit of scoped) {
    if (hit.type === 'summary') continue;
    assert.ok(allowed.has(hit.id), `hit ${hit.id} escaped the summary subtree`);
  }

  // An artifact is restricted by its message id, not by its own id: without that,
  // an `artifact:*` row from outside the subtree always survives the filter. The
  // fixture artifact is inside the tree, so this attaches a fresh payload to a
  // live message the built tree provably does not cover.
  const outsideId = 'msg-live-artifact-scope';
  captureLiveMessage(outsideId, 'A live turn outside the built summary tree.');
  store.run(
    `INSERT INTO artifacts (artifact_id, session_id, message_id, block_index, artifact_kind, field_name, preview_text, content_text, content_hash, metadata_json, char_count, created_at)
     VALUES (?, ?, ?, 0, 'text', 'text', 'scope-probe-preview', 'scope-probe-body', NULL, '{}', 16, ?)`,
    'artifact-live-scope-probe',
    SESSION_ID,
    outsideId,
    Date.now(),
  );
  // Indexed the way `insertArtifact` indexes one, so the scoped search genuinely
  // considers this artifact rather than never seeing it at all.
  store.run(
    'INSERT INTO artifact_fts (session_id, artifact_id, message_id, artifact_kind, created_at, content) VALUES (?, ?, ?, ?, ?, ?)',
    SESSION_ID,
    'artifact-live-scope-probe',
    outsideId,
    'text',
    Date.now(),
    explodeForIndex('scope-probe-body'),
  );
  assert.ok(
    store.grep({ query: 'scope-probe-body', sessionId: SESSION_ID, limit: 20 }).some((hit) => hit.id === 'artifact-live-scope-probe'),
    'the probe artifact is not searchable, so this check would prove nothing',
  );
  assert.ok(!allowed.has(outsideId), 'the probe message must be outside the built subtree');
  assert.deepEqual(
    store
      .grep({ query: 'scope-probe-body', sessionId: SESSION_ID, summaryId: built.roots[0], limit: 20 })
      .filter((hit) => hit.id === 'artifact-live-scope-probe'),
    [],
    'an artifact outside the subtree survived a summary-scoped search',
  );

  // An unresolvable node must say so, not silently widen the search back to the
  // whole session.
  assert.equal(
    store.grep({ query: 'summary tree', sessionId: SESSION_ID, summaryId: 'lcm-nope', allowScan: true }),
    'No summary node matched "lcm-nope".',
  );
});

check('describe and lineage report structure', () => {
  const described = store.describe({ sessionId: SESSION_ID });
  assert.match(described, /messages=\d+/);
  assert.match(described, /summary_nodes=\d+/);
  const lineage = store.lineage(SIBLING_ID);
  assert.equal(lineage.found, true);
  assert.ok(lineage.ancestry.length >= 1, 'sibling has an ancestor');
});

check('expand walks summary nodes and can include raw messages', () => {
  const built = store.buildSummaries(SESSION_ID);
  const summaryOnly = store.expand({ sessionId: SESSION_ID, nodeId: built.roots[0], depth: 2 });
  assert.match(summaryOnly, /summary:/);
  assert.match(summaryOnly, /raw_messages=omitted/);

  const withRaw = store.expand({ sessionId: SESSION_ID, nodeId: built.roots[0], includeRaw: true, messageLimit: 3 });
  assert.match(withRaw, /raw_messages=3/);
  assert.match(withRaw, /\[seq \d+\]/);

  const byQuery = store.expand({ sessionId: SESSION_ID, query: 'archive recall path' });
  assert.ok(byQuery.length > 0, 'query-driven expansion answers');
});

check('artifact retrieval returns the externalized body', () => {
  const row = store.get('SELECT artifact_id FROM artifacts LIMIT 1');
  const text = store.artifact({ artifactId: row.artifact_id, sessionId: SESSION_ID });
  assert.match(text, /artifact=/);
  assert.ok(text.length > 100, 'body included');

  // A LIKE pattern is escaped: `%` is the whole table to SQL, so unescaped it
  // silently answered with some arbitrary newest artifact instead of reporting
  // that nothing matched.
  assert.equal(store.artifact({ artifactId: '%', sessionId: SESSION_ID }), 'No artifact matched "%".');

  // Two artifacts sharing a prefix are not a lookup: guessing one of them would
  // answer a different question than the caller asked.
  const shared = `artifact-ambiguity-${Date.now()}`;
  const insertArtifact = (artifactId) =>
    store.run(
      `INSERT INTO artifacts (artifact_id, session_id, message_id, block_index, artifact_kind, field_name, preview_text, content_text, content_hash, metadata_json, char_count, created_at)
       VALUES (?, ?, ?, 0, 'text', 'text', 'preview', 'body', NULL, '{}', 4, ?)`,
      artifactId,
      SESSION_ID,
      'msg-u-1',
      Date.now(),
    );
  insertArtifact(`${shared}-one`);
  insertArtifact(`${shared}-two`);
  assert.match(
    store.artifact({ artifactId: shared, sessionId: SESSION_ID }),
    /Ambiguous artifact id/,
    'a shared prefix must be reported, not resolved arbitrarily',
  );
  assert.match(
    store.artifact({ artifactId: `${shared}-one`, sessionId: SESSION_ID }),
    new RegExp(`artifact=${shared}-one`),
    'a full id still resolves',
  );
});

check('automatic retrieval renders a bounded recalled-context block', () => {
  const recall = store.automaticRetrieval({
    sessionId: SESSION_ID,
    query: 'what did we decide about the retriever ranking',
    freshMessageIds: new Set(),
    includeResume: true,
  });
  assert.ok(recall, 'retrieval returned a result');
  assert.match(recall.text, /Archived by dsh-lcm/);
  assert.ok(recall.text.length <= config.automaticRetrieval.maxChars, `length ${recall.text.length}`);
  assert.match(recall.text, /lcm: LCM prototype resume note/, 'resume note included when requested');
  assert.ok(recall.hits.length > 0, 'hits recorded');
  assert.match(store.retrievalDebugFor(SESSION_ID), /raw_results=/);
});

check('automatic retrieval declines a query with no usable tokens', () => {
  assert.equal(store.automaticRetrieval({ sessionId: SESSION_ID, query: 'a', freshMessageIds: new Set() }), undefined);
});

check('resume note is durable once written', () => {
  const note = store.deriveResumeNote(SESSION_ID);
  assert.ok(note && note.includes('LCM prototype resume note'));
  store.setResume(SESSION_ID, note);
  assert.match(store.resume(SESSION_ID), /updated_at=/);
});

check('pins protect a session', () => {
  assert.match(store.pinSession({ sessionId: SESSION_ID, reason: 'smoke test' }), /Pinned/);
  assert.equal(store.sessionRow(SESSION_ID).pinned, 1);
  assert.match(store.unpinSession({ sessionId: SESSION_ID }), /Unpinned/);
  assert.equal(store.sessionRow(SESSION_ID).pinned, 0);
});

check('deleteFts removes a row from any FTS table', () => {
  // The sibling FTS tables name their id column differently, so a hardcoded
  // `message_id` made every call for summary_fts or artifact_fts throw and be
  // swallowed -- a delete that silently deleted nothing.
  const before = store.get('SELECT COUNT(*) AS n FROM summary_fts')?.n ?? 0;
  store.run(
    'INSERT INTO summary_fts (session_id, node_id, level, created_at, content) VALUES (?, ?, 0, ?, ?)',
    SESSION_ID,
    'smoke-node-deleteFts',
    Date.now(),
    'de le te',
  );
  assert.equal((store.get('SELECT COUNT(*) AS n FROM summary_fts')?.n ?? 0), before + 1, 'the probe row was indexed');
  store.deleteFts('summary_fts', 'node_id', 'smoke-node-deleteFts');
  assert.equal((store.get('SELECT COUNT(*) AS n FROM summary_fts')?.n ?? 0), before, 'deleteFts left the row behind');
});

check('pagination is a continuation, not a re-ranking', () => {
  // Score and timestamp tie often in a synthetic archive, which is exactly when an
  // incomplete order shows up as page 2 repeating page 1.
  const query = 'retriever ranks candidates';
  const single = store.grep({ query, sessionId: SESSION_ID, limit: 50 }).map((hit) => hit.id);
  assert.ok(single.length >= 3, `the fixture needs several hits to page through, got ${single.length}`);
  const paged = [];
  for (let offset = 0; offset < single.length; offset += 1) {
    const page = store.grep({ query, sessionId: SESSION_ID, limit: 1, offset });
    if (page.length === 0) break;
    paged.push(page[0].id);
  }
  assert.equal(paged.length, single.length, 'paging stopped early');
  assert.equal(new Set(paged).size, paged.length, 'a page repeated a row');
  assert.deepEqual(paged, single, 'the concatenated pages are not the single-page order');
});

check('blob stats and doctor answer', () => {
  assert.match(store.blobStats({ limit: 5 }), /blobs=\d+/);
  const report = store.runDoctor({ limit: 5 });
  assert.match(report, /messages=\d+/);
  assert.match(store.runDoctor({ apply: true, limit: 5 }), /repairs_applied=\d+/);
});

check('doctor repairs, and a repaired archive reports no findings', () => {
  // A tombstone is the case that used to report `fts_drift` forever: its FTS row
  // is deleted on purpose and `writeSearchIndexRows` skips it, so a baseline that
  // counted tombstones could never be satisfied by any amount of repair.
  nextLiveSeq += 1;
  store.capture(header, [
    { type: 'feedback/message-delete', seq: nextLiveSeq, time: Date.now(), data: { messageId: 'msg-u-3' } },
  ]);
  assert.ok(store.messageCount() > 0);
  assert.ok(
    store.get('SELECT deleted_at FROM messages WHERE message_id = ?', 'msg-u-3')?.deleted_at > 0,
    'the fixture did not tombstone a message',
  );

  // A latched `ftsAvailable` is the repair case, not a reason to skip the repair.
  store.ftsAvailable = false;
  const first = store.runDoctor({ apply: true, limit: 5 });
  assert.match(first, /fts_rebuilt=/, `doctor did not rebuild the index:\n${first}`);
  assert.equal(store.ftsAvailable, true, 'the flag must be usable again after a rebuild');

  // ...and the second pass converges, which is the entire point of the report.
  const second = store.runDoctor({ apply: true, limit: 5 });
  assert.match(second, /findings=none/, `doctor did not converge:\n${second}`);
  assert.match(second, /repairs_applied=0\b/, `doctor claimed a repair it did not make:\n${second}`);
});

check('snapshot import is atomic, and blob gc never strands a reference', () => {
  // Replace mode deletes before it inserts. Run as two transactions, a failure in
  // between leaves the target session emptied and the snapshot unwritten -- the
  // archive loses data *and* the import did not happen. This runs before the
  // retention checks, which prune the source session out of the archive.
  const atomicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lcm-atomic-'));
  let target;
  try {
    // The source session carries artifacts, which is what the forced failure has
    // to interrupt: a snapshot of an artifact-free session would not exercise it.
    const snapshotFile = path.join(atomicDir, 'source-snapshot.json');
    // The snapshot belongs to the source archive in `dir`, while the target's
    // containing directory is `atomicDir`. Handing content to another archive is
    // exactly the act the containment check makes explicit.
    assert.match(
      store.exportSnapshot({ filePath: snapshotFile, sessionID: SESSION_ID, scope: 'session', allowOutsideStoreDir: true }),
      /artifacts=[1-9]/,
      'the atomicity fixture needs a snapshot that inserts artifacts',
    );

    target = new LcmStore({
      config: resolveConfig({ storeDir: atomicDir }, { homeDir: atomicDir }),
      logger,
    });
    target.init();
    target.capture(header, [
      {
        type: 'user/message',
        seq: 0,
        time: Date.now(),
        data: {
          id: 'atomic-local-1',
          role: 'user',
          content: [{ type: 'text', text: 'a local message that must survive a failed import' }],
          source: { kind: 'user' },
        },
      },
    ]);
    const before = target.stats().messageCount;
    assert.ok(before > 0, 'the target archive has content to lose');

    const realRun = target.run;
    target.run = function failingInsert(sql, ...params) {
      if (String(sql).includes('INSERT INTO artifacts')) throw new Error('forced import failure');
      return realRun.call(this, sql, ...params);
    };
    let threw;
    try {
      // The snapshot belongs to the *source* archive in `dir`, and the target's
      // containing directory is `atomicDir`: importing across archives is now the
      // explicit opt-in that the containment check requires.
      target.importSnapshot({ filePath: snapshotFile, mode: 'replace', allowOutsideStoreDir: true });
    } catch (error) {
      threw = error;
    }
    target.run = realRun;

    assert.ok(threw, 'the forced failure must propagate out of the import');
    assert.equal(target.stats().messageCount, before, 'a failed replace-import lost the local messages');
    assert.ok(
      target.get('SELECT text FROM messages WHERE message_id = ?', 'atomic-local-1')?.text,
      'the local message row is gone after the rollback',
    );

    // gcBlobs must never delete a blob an artifact still references; selecting the
    // orphan set outside the deleting transaction is what allows that race.
    target.run(
      'INSERT INTO artifact_blobs (content_hash, content_text, char_count, created_at, orphaned_at) VALUES (?, ?, ?, ?, NULL)',
      'smoke-orphan-hash',
      'an unreferenced blob',
      21,
      Date.now(),
    );
    // Every assertion below is on archive state, never on the wording or the count
    // in the report string: the grace-14 pass stamps *every* orphan in the archive,
    // so how many blobs a later pass collects depends on what earlier fixture steps
    // left behind, while which hashes survive is the thing gcBlobs is responsible
    // for.
    const blobHashes = () => target.all('SELECT content_hash FROM artifact_blobs ORDER BY content_hash').map((row) => row.content_hash);
    const strandedBodies = () =>
      target.get(
        'SELECT COUNT(*) AS n FROM artifacts a WHERE a.content_hash IS NOT NULL AND NOT EXISTS (SELECT 1 FROM artifact_blobs b WHERE b.content_hash = a.content_hash)',
      )?.n ?? 0;

    // The default grace is 14 days, and this blob was just created, so the first
    // pass may only stamp it. That is the grace period doing its job: the old code
    // deleted orphans on the very first `apply` because `orphaned_at` was never
    // written by anything and `gcBlobs` never tested it.
    const beforeGrace = blobHashes();
    target.gcBlobs({ apply: true, orphanBlobDays: 14 });
    assert.deepEqual(
      blobHashes(),
      beforeGrace,
      'a blob inside its 14d grace window was collected, or one was lost from the archive',
    );
    assert.equal(
      target.get('SELECT COUNT(*) AS n FROM artifact_blobs WHERE content_hash = ?', 'smoke-orphan-hash')?.n,
      1,
      'a freshly orphaned blob was collected inside the grace period',
    );
    assert.ok(
      target.get('SELECT orphaned_at FROM artifact_blobs WHERE content_hash = ?', 'smoke-orphan-hash')?.orphaned_at > 0,
      'becoming an orphan was never stamped, so the grace period cannot be measured',
    );

    // Grace 0 is "no grace": this blob was stamped by the grace-14 pass, so it is
    // past any cutoff. The outcome is asserted for THIS hash rather than from the
    // count printed in the message, which depends on what other steps left behind.
    assert.ok(blobHashes().includes('smoke-orphan-hash'), 'the fixture blob was already gone before the grace-0 pass');
    target.gcBlobs({ apply: true, orphanBlobDays: 0 });
    assert.equal(
      target.get('SELECT COUNT(*) AS n FROM artifact_blobs WHERE content_hash = ?', 'smoke-orphan-hash')?.n,
      0,
      'a blob past its grace period was not collected',
    );
    assert.equal(strandedBodies(), 0, 'gcBlobs deleted a blob an artifact still references');

    // A blob that stops being an orphan must lose its stamp: `insertArtifact` is
    // the only writer that can take it out of the orphan set, and a leftover stamp
    // would let the grace period expire against a body an artifact now references.
    // A second hash is used on purpose: re-referencing the first would remove the
    // orphan that the grace-0 assertion above needs.
    target.run(
      'INSERT INTO artifact_blobs (content_hash, content_text, char_count, created_at, orphaned_at) VALUES (?, ?, ?, ?, NULL)',
      'smoke-rereferenced-hash',
      'a body that becomes referenced again',
      33,
      Date.now(),
    );
    // Grace 0 is "no grace", but the stamp is written inside the same call, so a
    // blob first observed here is measured against a cutoff taken before the stamp:
    // it may be collected by this pass or by the next one, whichever way the clock
    // ticks. Run it twice and assert the outcome for THIS hash -- it is an orphan
    // (no artifact references it) and after the second pass it is gone. Asserting
    // on the count in the report string let that millisecond boundary, and any
    // orphan an earlier step left behind, decide whether the check passed.
    target.gcBlobs({ apply: true, orphanBlobDays: 0 });
    assert.equal(
      target.get('SELECT COUNT(*) AS n FROM artifacts WHERE content_hash = ?', 'smoke-rereferenced-hash')?.n,
      0,
      'the fixture blob is still referenced, so it was never an orphan',
    );
    target.gcBlobs({ apply: true, orphanBlobDays: 0 });
    assert.equal(
      target.get('SELECT COUNT(*) AS n FROM artifact_blobs WHERE content_hash = ?', 'smoke-rereferenced-hash')?.n,
      0,
      'at grace 0 an orphaned blob was not collected',
    );
    target.insertArtifact('session-atomic', 'atomic-referrer', {
      artifactId: 'atomic-referrer:0',
      blockIndex: 0,
      kind: 'text',
      fieldName: 'text',
      preview: 'a body that becomes referenced again',
      content: 'a body that becomes referenced again',
      contentHash: 'smoke-rereferenced-hash',
    });
    assert.equal(
      target.get('SELECT orphaned_at FROM artifact_blobs WHERE content_hash = ?', 'smoke-rereferenced-hash')?.orphaned_at,
      null,
      're-referencing a blob left its orphan stamp in place',
    );
    // The state the report text used to stand for: a no-grace pass must not collect
    // the body an artifact now references, and no artifact may be left without the
    // body it points at.
    target.gcBlobs({ apply: true, orphanBlobDays: 0 });
    assert.ok(blobHashes().includes('smoke-rereferenced-hash'), 'a re-referenced blob is still collectable');
    assert.equal(strandedBodies(), 0, 'an artifact was left without a readable body');
  } finally {
    // Closed here rather than in the body: a failed assertion must not leave the
    // WAL handle open, or the directory cannot be removed either.
    try {
      target?.close();
    } catch {
      // Already closed.
    }
    fs.rmSync(atomicDir, { recursive: true, force: true });
  }
});

check('stats reports the archive surface', () => {
  const stats = store.stats();
  assert.ok(stats.sessionCount >= 3, `sessions=${stats.sessionCount}`);
  assert.ok(stats.summaryNodeCount > 0, 'summary nodes counted');
  assert.ok(stats.totalBytes > 0, 'bytes counted');
  assert.match(stats.bytesLabel, /\d/);
});

check('retention report is safe and prune is explicit', () => {
  const report = store.retentionReport({ staleSessionDays: 0, limit: 5 });
  assert.match(report, /stale_session_days=0/);
  const dryRun = store.retentionPrune({ staleSessionDays: 0, limit: 5 });
  assert.match(dryRun, /Would prune/);
  const after = store.retentionPrune({ staleSessionDays: 0, apply: true, limit: 5 });
  assert.match(after, /pruned_sessions=\d+/);
});

check('compact previews then reclaims', () => {
  assert.match(store.compact({ limit: 5 }), /Preview only/);
  const applied = store.compact({ apply: true, limit: 5 });
  assert.match(applied, /db_bytes_after=\d+/);
});

check('lcm_compact clears an event backlog larger than one page', () => {
  // The prune used to delete one positional `LIMIT` page, so a backlog bigger than
  // the clamp was permanently unprunable while the tool still reported it had run.
  const { store: compacting, dir: compactDir } = tempStore('compact');
  try {
    let seq = 0;
    const backlog = [];
    for (let index = 0; index < 60; index += 1) backlog.push({ type: 'turn/start', seq: seq++, time: Date.now(), data: { turn: index } });
    backlog.push({
      type: 'compaction/summary',
      seq: seq++,
      time: Date.now(),
      data: { shadowedRange: { start: 1, end: 60 }, shadowedSeqs: Array.from({ length: 60 }, (_, index) => index + 1), shadowedTokenCount: 4321 },
    });
    compacting.capture(header, backlog);
    assert.equal(compacting.stats().prunableEventCount, 60, 'the fixture did not seed a turn backlog');
    assert.ok(
      compacting.get("SELECT COUNT(*) AS n FROM events WHERE event_type = 'compaction/summary'")?.n > 0,
      'the fixture did not capture the compaction payload',
    );
    assert.ok(compacting.sessionRow(SESSION_ID).compacted_at > 0, 'the compaction marker was not recorded');

    // `limit: 5` bounds the reported sample, not the number of rows one call clears.
    const applied = compacting.compact({ apply: true, vacuum: false, limit: 5 });
    assert.match(applied, /pruned_events=61/, `the backlog was not cleared in one call:\n${applied}`);
    assert.equal(
      compacting.get("SELECT COUNT(*) AS n FROM events WHERE event_type IN ('turn/start','turn/end','compaction/summary')")?.n,
      0,
      'events survived the prune',
    );
    // Consuming the payload must not consume the marker: the resume note is
    // derived from `sessions.compacted_at`, so the compaction stays visible.
    assert.ok(compacting.sessionRow(SESSION_ID).compacted_at > 0, 'the prune dropped the durable compaction marker');
  } finally {
    compacting.close();
    fs.rmSync(compactDir, { recursive: true, force: true });
  }
});

check('the snapshot tools refuse a path outside the archive directory', () => {
  // The path is a model-facing argument: writing the archive anywhere on disk, or
  // reading an arbitrary file and merging its "messages" into the archive, is what
  // the containment check exists to stop.
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lcm-outside-'));
  try {
    const outsideFile = path.join(outsideDir, 'elsewhere.json');
    const refusal = store.exportSnapshot({ filePath: outsideFile, sessionID: SESSION_ID, scope: 'session' });
    assert.match(refusal, /Refusing to write a snapshot outside the archive directory/, refusal);
    assert.equal(fs.existsSync(outsideFile), false, 'the refused export wrote a file anyway');
    assert.match(
      store.importSnapshot({ filePath: outsideFile, mode: 'merge' }),
      /Refusing to read a snapshot from outside the archive directory/,
      'the import read a path outside the archive directory',
    );
  } finally {
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

check('a snapshot is redacted on export, not only at capture', () => {
  // Privacy is applied when content is captured, but `redactPatterns` can be
  // configured afterwards and an export is a copy of the raw tables -- the one
  // place where archive content leaves the plugin.
  const { store: exporting, dir: exportDir } = tempStore('export-redaction');
  try {
    exporting.capture(header, [
      {
        type: 'user/message',
        seq: 0,
        time: 1,
        data: {
          id: 'export-secret-1',
          role: 'user',
          content: [{ type: 'text', text: 'a secret that was archived before redaction was configured: sk-EXPORT123456' }],
          source: { kind: 'user' },
        },
      },
    ]);
    assert.ok(
      exporting.get('SELECT text FROM messages WHERE message_id = ?', 'export-secret-1')?.text.includes('sk-EXPORT123456'),
      'the fixture secret was redacted at capture, so this check would prove nothing',
    );
    // The operator tightens the policy after the fact.
    exporting.privacy = compilePrivacy({ redactPatterns: ['sk-[A-Za-z0-9]+'] });

    const file = path.join(exportDir, 'redacted.json');
    const exported = exporting.exportSnapshot({ filePath: file, sessionID: SESSION_ID, scope: 'session' });
    assert.match(exported, /redacted=true/);
    assert.equal(fs.readFileSync(file, 'utf8').includes('sk-EXPORT123456'), false, 'the snapshot left the archive unredacted');
  } finally {
    exporting.close();
    fs.rmSync(exportDir, { recursive: true, force: true });
  }
});

check('snapshot export and import round-trip', () => {
  const file = path.join(dir, 'snapshot.json');
  store.capture(siblingHeader, []);
  const exported = store.exportSnapshot({ filePath: file, sessionID: SIBLING_ID, scope: 'session' });
  assert.match(exported, /snapshot=/);
  assert.ok(fs.existsSync(file), 'snapshot written');
  const imported = store.importSnapshot({ filePath: file, mode: 'merge' });
  assert.match(imported, /mode=merge/);
  assert.match(store.importSnapshot({ filePath: file, mode: 'replace' }), /mode=replace/);
  assert.match(store.importSnapshot({ filePath: file }), /mode is required/);
});

check('a newer archive schema is refused before anything is dropped', () => {
  const schemaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lcm-schema-'));
  try {
    const newerPath = path.join(schemaDir, 'newer.db');
    const newer = openArchive(newerPath);
    // Symbolic, so the check survives the next schema bump.
    newer.db
      .prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(SCHEMA_VERSION + 1));
    newer.db.close();

    assert.throws(() => openArchive(newerPath), /newer than this plugin/, 'a newer archive must not be silently downgraded');

    // The throw has to precede the DROP loop: a missing FTS table would mean the
    // archive was already stripped of its index by a plugin that cannot use it.
    const schemaCheck = new DatabaseSync(newerPath);
    assert.equal(
      schemaCheck.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'message_fts'").get().n,
      1,
      'the FTS tables were dropped before the version was refused',
    );
    assert.equal(
      schemaCheck.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value,
      String(SCHEMA_VERSION + 1),
      'the recorded version was rewritten by an older plugin',
    );
    schemaCheck.close();
  } finally {
    fs.rmSync(schemaDir, { recursive: true, force: true });
  }
});

check('opening an older archive migrates the inline bodies and rebuilds the index', () => {
  // Schema 3 stored each artifact body in `artifacts.content_text` *and* exploded
  // the whole body into `artifact_fts`. Opening that archive has to move the body
  // into the blob, clear the column, and rebuild the index from the preview --
  // otherwise an upgraded archive silently keeps the layout the bump exists to
  // remove.
  const olderDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lcm-older-schema-'));
  const olderPath = path.join(olderDir, 'lcm.db');
  try {
    const legacyBody = 'LEGACY-BODY-CONTENT that only the blob should hold';
    const first = openArchive(olderPath);
    first.db
      .prepare(
        `INSERT INTO artifacts (artifact_id, session_id, message_id, block_index, artifact_kind, field_name, preview_text, content_text, content_hash, metadata_json, char_count, created_at)
         VALUES ('legacy-1', 'legacy-session', 'legacy-msg', 0, 'text', 'text', 'legacy preview text', ?, 'legacyhash', '{}', ?, 1)`,
      )
      .run(legacyBody, legacyBody.length);
    first.db
      .prepare(
        'INSERT INTO artifact_fts (session_id, artifact_id, message_id, artifact_kind, created_at, content) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('legacy-session', 'legacy-1', 'legacy-msg', 'text', 1, explodeForIndex(legacyBody));
    first.db.prepare("UPDATE meta SET value = '3' WHERE key = 'schema_version'").run();
    first.db.close();

    const upgraded = new LcmStore({
      config: resolveConfig({ storeDir: olderDir }, { homeDir: olderDir }),
      logger,
    });
    upgraded.init();
    try {
      assert.equal(upgraded.stats().schemaVersion, SCHEMA_VERSION, 'the archive was not brought up to the current schema');
      assert.equal(upgraded.stats().artifactInlineBodyChars, 0, 'the legacy inline body was left in artifacts.content_text');
      assert.equal(
        upgraded.get("SELECT content_text FROM artifact_blobs WHERE content_hash = 'legacyhash'")?.content_text,
        legacyBody,
        'the legacy body did not reach the content-addressed blob',
      );
      // The rebuild indexes the preview, so the body's own words must no longer be
      // in the index while the preview is. The probe is a whole gram, not a prefix:
      // 'legacy' and 'LEGACY' share the gram `leg`, which would make a prefix test
      // pass whatever the index holds.
      const indexed = upgraded.get("SELECT content FROM artifact_fts WHERE artifact_id = 'legacy-1'")?.content ?? '';
      assert.ok(explodeForIndex('legacy preview text').split(' ').every((gram) => indexed.includes(gram)), 'the rebuilt index is missing the preview');
      assert.equal(indexed.includes('onl'), false, 'the rebuilt index still carries the exploded body');
    } finally {
      upgraded.close();
    }
  } finally {
    fs.rmSync(olderDir, { recursive: true, force: true });
  }
});

/**
 * Build an archive whose `artifacts` table has the *schema 3* shape.
 *
 * `content_text TEXT NOT NULL` is the whole point: the check above builds its
 * fixture through `openArchive`, which creates the current (nullable) table, so it
 * can never reproduce the constraint that made the real migration fail. This
 * fixture is written to the legacy DDL instead, and the version is passed in so
 * the same builder can produce "the version was already bumped" archives too.
 *
 * @param {string} dbPath
 * @param {{version: number, rows: Array<{id: string, body: string, hash?: string, preview: string}>}} options
 */
function buildSchema3Archive(dbPath, { version, rows }) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE artifacts (
        artifact_id   TEXT PRIMARY KEY,
        session_id    TEXT NOT NULL,
        message_id    TEXT NOT NULL,
        block_index   INTEGER NOT NULL DEFAULT 0,
        artifact_kind TEXT NOT NULL,
        field_name    TEXT NOT NULL,
        preview_text  TEXT NOT NULL,
        content_text  TEXT NOT NULL,
        content_hash  TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        char_count    INTEGER NOT NULL,
        created_at    INTEGER NOT NULL
      );
      CREATE INDEX idx_artifacts_session_message ON artifacts(session_id, message_id, block_index);
      CREATE INDEX idx_artifacts_content_hash ON artifacts(content_hash);
    `);
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(version));
    const insert = db.prepare(
      `INSERT INTO artifacts (
         artifact_id, session_id, message_id, block_index, artifact_kind, field_name,
         preview_text, content_text, content_hash, metadata_json, char_count, created_at
       ) VALUES (?, 'legacy-session', ?, 0, 'text', 'text', ?, ?, ?, '{}', ?, 1)`,
    );
    for (const row of rows) {
      insert.run(row.id, `legacy-msg-${row.id}`, row.preview, row.body, row.hash ?? null, row.body.length);
    }
  } finally {
    db.close();
  }
}

check('a schema-3 archive with content_text NOT NULL is rebuilt before the bodies move', () => {
  // The shape that actually broke a real archive. SQLite has no `ALTER TABLE ...
  // DROP NOT NULL`, and `CREATE TABLE IF NOT EXISTS` leaves an existing table
  // alone, so `UPDATE artifacts SET content_text = NULL` throws "NOT NULL
  // constraint failed", the migration transaction rolls back, and every body stays
  // inline. Rebuilding the table is the only way through.
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lcm-legacy-notnull-'));
  const legacyPath = path.join(legacyDir, 'lcm.db');
  const shared = 'LEGACY SHARED BODY that two artifacts point at';
  const unique = 'LEGACY UNIQUE BODY that carried no hash of its own';
  try {
    buildSchema3Archive(legacyPath, {
      version: 3,
      rows: [
        { id: 'legacy-notnull-1', body: shared, hash: 'legacy-shared-hash', preview: 'first legacy preview' },
        { id: 'legacy-notnull-2', body: unique, preview: 'second legacy preview' },
        { id: 'legacy-notnull-3', body: shared, hash: 'legacy-shared-hash', preview: 'third legacy preview' },
      ],
    });

    const upgraded = new LcmStore({ config: resolveConfig({ storeDir: legacyDir }, { homeDir: legacyDir }), logger });
    upgraded.init();
    try {
      assert.equal(upgraded.stats().artifactInlineBodyChars, 0, 'a NOT NULL schema-3 archive kept its inline bodies');
      // The rebuild is what made that possible, so assert the shape too: while the
      // column is NOT NULL, the next `insertArtifact` writes NULL into it.
      const contentText = upgraded.all('PRAGMA table_info(artifacts)').find((column) => column.name === 'content_text');
      assert.equal(Number(contentText?.notnull), 0, 'artifacts.content_text is still NOT NULL after the migration');
      // The rebuilt table must carry the indexes the old one had.
      const indexes = upgraded.all("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'artifacts'").map((row) => row.name);
      assert.ok(indexes.includes('idx_artifacts_session_message'), `the rebuild lost an index: ${indexes.join(', ')}`);
      assert.ok(indexes.includes('idx_artifacts_content_hash'), `the rebuild lost an index: ${indexes.join(', ')}`);
      // Every artifact is readable through the blob join, and none is stranded.
      assert.equal(upgraded.stats().artifactCount, 3);
      assert.equal(
        upgraded.get('SELECT COUNT(*) AS n FROM artifacts a JOIN artifact_blobs b ON b.content_hash = a.content_hash')?.n,
        3,
        'an artifact is not reachable through the blob join',
      );
      assert.equal(
        upgraded.get(
          'SELECT COUNT(*) AS n FROM artifacts a WHERE NOT EXISTS (SELECT 1 FROM artifact_blobs b WHERE b.content_hash = a.content_hash)',
        )?.n,
        0,
        'an artifact was left without a readable body',
      );
      // A row whose `content_hash` was NULL is hashed from its own text.
      assert.equal(
        upgraded.get('SELECT content_text FROM artifact_blobs WHERE content_hash = ?', hashContent(unique))?.content_text,
        unique,
        'the unhashed legacy body did not reach the blob',
      );
      // The shared body is stored once, and both referrers read it back.
      assert.equal(upgraded.get('SELECT COUNT(*) AS n FROM artifact_blobs WHERE content_hash = ?', 'legacy-shared-hash')?.n, 1);
      assert.equal(upgraded.get('SELECT COUNT(*) AS n FROM artifact_fts')?.n, 3, 'the rebuilt index is not populated for the migrated rows');
      for (const [id, body] of [
        ['legacy-notnull-1', shared],
        ['legacy-notnull-2', unique],
        ['legacy-notnull-3', shared],
      ]) {
        const view = upgraded.artifact({ artifactId: id, sessionId: 'legacy-session' });
        assert.ok(!view.includes('body unavailable'), `${id} lost its body: ${view.split('\n')[0]}`);
        assert.ok(view.includes(body), `${id} did not read its body back through the blob join`);
      }
    } finally {
      upgraded.close();
    }
  } finally {
    fs.rmSync(legacyDir, { recursive: true, force: true });
  }
});

check('a stamped schema version does not strand inline bodies: the migration retries', () => {
  // The state the failed migration left behind: `openArchive` had already stamped
  // `schema_version = 4` while every body was still inline, so `upgraded` is false
  // on the next start. Gating the migration on the version bump made that
  // permanent; the trigger has to be the archive's own contents, or the archive
  // stays stranded with every duplicate body and no way to retry.
  const retryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lcm-retry-'));
  const retryPath = path.join(retryDir, 'lcm.db');
  const body = 'A BODY LEFT BEHIND BY A FAILED MIGRATION';
  const openStore = () => new LcmStore({ config: resolveConfig({ storeDir: retryDir }, { homeDir: retryDir }), logger });
  try {
    // Same legacy shape, already stamped as the current version.
    buildSchema3Archive(retryPath, { version: SCHEMA_VERSION, rows: [{ id: 'retry-1', body, hash: 'retry-hash', preview: 'retry preview' }] });

    const retried = openStore();
    retried.init();
    try {
      assert.equal(retried.stats().schemaVersion, SCHEMA_VERSION);
      assert.equal(retried.stats().artifactInlineBodyChars, 0, 'a stamped version skipped the body migration');
      assert.equal(
        retried.get("SELECT content_text FROM artifact_blobs WHERE content_hash = 'retry-hash'")?.content_text,
        body,
        'the retried migration did not move the body into the blob',
      );
    } finally {
      retried.close();
    }

    // The other half of the trigger: rows left behind on an archive whose table was
    // already rebuilt (a crash between the rebuild and the body loop). Version and
    // shape are both current, so only the rows can say work is left.
    const leftover = openStore();
    leftover.init();
    try {
      leftover.run("UPDATE artifacts SET content_text = ?, content_hash = 'retry-hash' WHERE artifact_id = 'retry-1'", body);
      assert.equal(leftover.stats().artifactInlineBodyChars > 0, true);
    } finally {
      leftover.close();
    }

    const cleaned = openStore();
    cleaned.init();
    try {
      assert.equal(cleaned.stats().artifactInlineBodyChars, 0, 'a leftover inline body was never cleaned up');
      assert.equal(cleaned.stats().artifactBlobCount, 1, 'the retry duplicated the body instead of reusing the blob');
      assert.ok(cleaned.artifact({ artifactId: 'retry-1', sessionId: 'legacy-session' }).includes(body), 'the retried body is unreadable');
    } finally {
      cleaned.close();
    }
  } finally {
    fs.rmSync(retryDir, { recursive: true, force: true });
  }
});

await checkAsync("lcm_grep refuses scope 'all' unless the operator opts in", async () => {
  // `all` resolves to every session in the shared archive with no cwd, worktree or
  // profile filter. One Harness home is shared across projects, so a model-driven
  // call could pull another project's conversation into this one.
  //
  // This runs after the retention checks have emptied the fixture archive, so it
  // seeds its own session: an empty archive would make the opted-in search below
  // prove nothing about the gate.
  const scopeId = 'session-smoke-scope-all';
  store.capture(
    { ...header, id: scopeId },
    [
      {
        type: 'user/message',
        seq: 0,
        time: Date.now(),
        data: {
          id: 'scope-all-marker',
          role: 'user',
          content: [{ type: 'text', text: 'a session reachable only through the cross-project scope' }],
          source: { kind: 'user' },
        },
      },
    ],
  );

  const gated = buildTools({ store, ensureCaptured: async () => {}, config: resolveConfig({ storeDir: dir }, { homeDir: dir }) });
  const grep = gated.find((tool) => tool.name === 'lcm_grep');
  assert.deepEqual(grep.parameters.properties.scope.enum, ['session', 'root', 'worktree'], 'the model-facing enum must not offer all');

  const refused = await grep.execute({ query: 'cross-project scope', scope: 'all', sessionID: scopeId }, {});
  assert.equal(typeof refused, 'string', 'the tool must answer with an error string');
  assert.match(refused, /scope "all" is disabled/, `a scope=all call was not refused:\n${refused}`);
  assert.match(refused, /allowScopeAll=true/, 'the refusal must say how to opt in');
  assert.match(grep.parameters.properties.scope.description, /session, root/, 'the description must name the scopes that remain');

  const allowed = buildTools({
    store,
    ensureCaptured: async () => {},
    config: resolveConfig({ storeDir: dir, allowScopeAll: true }, { homeDir: dir }),
  }).find((tool) => tool.name === 'lcm_grep');
  assert.ok(allowed.parameters.properties.scope.enum.includes('all'), 'the opt-in must restore the scope');
  assert.match(
    String(await allowed.execute({ query: 'cross-project scope', scope: 'all', sessionID: scopeId }, {})),
    /results=/,
    'the opted-in scope did not search',
  );
});

check('a failed archive open closes its handle', () => {
  const openDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lcm-open-'));
  try {
    const notADatabase = path.join(openDir, 'not-a-database.txt');
    fs.writeFileSync(notADatabase, 'this is definitely not an SQLite database');
    assert.throws(() => openArchive(notADatabase), /not a database/i);
    // A leaked handle keeps the file alive; deleting it immediately is the
    // observable proof that the catch closed the connection.
    assert.doesNotThrow(() => fs.rmSync(notADatabase), 'the file is still held open');
  } finally {
    fs.rmSync(openDir, { recursive: true, force: true });
  }
});

check('privacy excludes configured tool payloads', () => {
  const strict = new LcmStore({
    config: resolveConfig(
      { storeDir: path.join(dir, 'privacy'), privacy: { excludeToolPrefixes: ['pwsh'] } },
      { homeDir: dir },
    ),
    logger,
  });
  strict.init();
  strict.capture(header, events);
  const row = strict.get("SELECT text FROM messages WHERE role = 'tool' LIMIT 1");
  assert.ok(row.text.includes('[Excluded tool payload'), `got: ${row.text.slice(0, 80)}`);
  strict.close();
});

check('store closes cleanly', () => {
  store.close();
  assert.equal(store.ready, false);
});

// --------------------------------------------------------------------- report

try {
  fs.rmSync(dir, { recursive: true, force: true });
} catch {
  // The OS will clean the temp directory.
}

process.stdout.write(failures === 0 ? '\nall checks passed\n' : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
