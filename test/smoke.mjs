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

import { resolveConfig, resolveHomeDir } from '../lib/config.js';
import { LcmStore } from '../lib/store.js';
import { buildFtsQuery, explodeForIndex, gramsOf, runsOf } from '../lib/text.js';

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

  push('compaction/start', {});
  push('compaction/summary', { summary: 'condensed turns 1-8' });
  push('compaction/end', {});
  push('turn/end', { turn: 12, reason: { kind: 'stop' } });
  return events;
}

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

const config = resolveConfig(
  { storeDir: dir, privacy: { redactPatterns: ['sk-[A-Za-z0-9]+'] } },
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

check('oversized payload is externalized and redacted', () => {
  const blob = store.get('SELECT COUNT(*) AS n FROM artifact_blobs')?.n ?? 0;
  assert.ok(blob >= 1, 'an artifact blob exists');
  const row = store.get("SELECT artifact_id, content_text FROM artifacts WHERE artifact_kind = 'text' LIMIT 1");
  assert.ok(row, 'artifact row exists');
  assert.ok(!row.content_text.includes('sk-ABCDEF123456'), 'secret was redacted before storage');
  assert.ok(row.content_text.includes('[REDACTED]'), 'redaction marker present');
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

check('summary-scoped grep restricts to one node subtree', () => {
  const built = store.buildSummaries(SESSION_ID);
  const scoped = store.grep({ query: 'summary tree', sessionId: SESSION_ID, summaryId: built.roots[0], allowScan: true });
  assert.ok(Array.isArray(scoped), 'scoped grep answers');
  const allowed = new Set(store.descendantMessageIds(built.roots[0]));
  for (const hit of scoped) {
    if (hit.type === 'summary') continue;
    assert.ok(allowed.has(hit.id), `hit ${hit.id} escaped the summary subtree`);
  }
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
  const text = store.artifact({ artifactId: row.artifact_id });
  assert.match(text, /artifact=/);
  assert.ok(text.length > 100, 'body included');
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

check('blob stats and doctor answer', () => {
  assert.match(store.blobStats({ limit: 5 }), /blobs=\d+/);
  const report = store.runDoctor({ limit: 5 });
  assert.match(report, /messages=\d+/);
  assert.match(store.runDoctor({ apply: true, limit: 5 }), /repairs_applied=\d+/);
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
