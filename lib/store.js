/**
 * The LCM archive store.
 *
 * Responsibilities, mirroring `opencode-lcm`'s `SqliteLcmStore`:
 *   - capture session-log messages into a searchable archive
 *   - build deterministic summary nodes with a parent/child tree
 *   - answer scoped search across session / root / worktree / all
 *   - recall archived context for the current turn
 *   - externalize oversized payloads as deduplicated artifacts
 *   - answer retention, compaction, doctor and snapshot operations
 *
 * Every read path degrades gracefully: a failed capture must never break a
 * conversation, so callers in `index.js` wrap store calls and log failures
 * instead of propagating them into the agent loop.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { SCHEMA_VERSION, artifactsContentTextIsNotNull, inTransaction, openArchive, parseJson, plain, plainAll, rebuildArtifactsTableIfNeeded } from './db.js';
import { messageOfEvent, isMessageEventType, normalizeMessage, summarizeMessage } from './messages.js';
import { compilePrivacy } from './privacy.js';
import { filterTokensByTfidf, rankSearchCandidates } from './ranking.js';
import {
  buildFtsQuery,
  buildSnippet,
  collapseWhitespace,
  compressText,
  deepFreeze,
  escapeLike,
  explodeForIndex,
  formatBytes,
  hashContent,
  isCjkRun,
  pluralize,
  queryPhrases,
  shortNodeId,
  tokenizeQuery,
  truncate,
  unindexableRuns,
} from './text.js';
import {
  blobStats,
  compactDatabase,
  doctor,
  gcBlobs,
  importSnapshot,
  exportSnapshot,
  retentionPrune,
  retentionReport,
} from './maintenance.js';

/** `undefined` is not bindable in node:sqlite; SQL NULL is. */
function nz(value) {
  return value === undefined ? null : value;
}

function int(bool) {
  return bool ? 1 : 0;
}

/** Normalize a directory into a comparison key (the Harness analogue of a git worktree). */
function worktreeKeyOf(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return null;
  return cwd.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

/**
 * The fields of a compaction payload that anything actually reads.
 *
 * `compaction/summary` carries the whole compaction report -- a `summary` body
 * plus the shadowed span -- and live archives measured that payload at 96% of
 * all event bytes (214,044 of 223,651 chars). Only three fields are consumed:
 * `LcmStore.latestCompaction` reads them to build the deterministic pointer, and
 * the resume note is derived from archived messages instead. Storing the raw
 * event meant the archive paid for a report no code path ever read back.
 */
const COMPACTION_SPAN_FIELDS = ['shadowedRange', 'shadowedSeqs', 'shadowedTokenCount'];

/**
 * The JSON actually persisted for one notable event.
 *
 * A compaction event keeps only its span fields. Everything else stays verbatim:
 * the other notable types are small, and truncating an unknown future payload
 * would silently lose information the plugin cannot yet name.
 */
function eventPayloadJson(type, data) {
  const source = data && typeof data === 'object' ? data : {};
  if (type !== 'compaction/summary' && type !== 'compaction/end') return JSON.stringify(source);
  const span = {};
  for (const field of COMPACTION_SPAN_FIELDS) {
    if (source[field] !== undefined) span[field] = source[field];
  }
  return JSON.stringify(span);
}

export class LcmStore {
  /**
   * @param {object} options
   * @param {ReturnType<import('./config.js').resolveConfig>} options.config
   * @param {{info: Function, warn: Function, debug: Function, error: Function}} options.logger
   */
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
    this.privacy = compilePrivacy(config.privacy);
    /** @type {import('node:sqlite').DatabaseSync|undefined} */
    this.db = undefined;
    this.dbPath = undefined;
    this.ready = false;
    this.initError = undefined;
    /** Reusable statement cache: preparing on every call is measurably slower. */
    this.statements = new Map();
    /** Last automatic-retrieval telemetry per session, for `lcm_retrieval_debug`. */
    this.retrievalDebug = new Map();
    /** Document-frequency cache used by TF-IDF token filtering. */
    this.docFreqCache = new Map();
    /** Counters surfaced by `lcm_status`. */
    this.counters = {
      capturedMessages: 0,
      capturedEvents: 0,
      captureFailures: 0,
      summaryRebuilds: 0,
      /** Times `maxRecallMessagesPerSession` prevented another injection. */
      recallCapReached: 0,
    };
    /**
     * `callId -> tool name`, folded from `tool/call` events in log order.
     *
     * A `tool/result` message carries only its `toolCallId`, so this pairing is
     * what lets the privacy `excludeToolPrefixes` policy match a tool result.
     */
    this.toolCalls = new Map();
    this.ftsAvailable = true;
  }

  /** Open the database. Throws only when the archive itself cannot be opened. */
  init() {
    const directory = this.config.storeDir ?? join(process.cwd(), '.lcm');
    this.dbPath = join(directory, 'lcm.db');
    const opened = openArchive(this.dbPath);
    // Accept a bare database handle too: a module generation cached across a fiber
    // reload can pair an older db.js with this store, and failing activation over
    // that would be far worse than skipping a migration.
    this.db = opened?.db ?? opened;
    const upgraded = opened?.upgraded === true;
    this.ready = true;
    // The version bump is not the migration's condition. `openArchive` stamps
    // `schema_version = 4` on the way in, so gating on `upgraded` made a failed
    // migration permanent: the next start saw version 4, skipped the retry, and
    // left every legacy body in place forever. The condition is the archive's own
    // state instead, which is what makes the retry possible -- and what keeps the
    // invariant explicit: after a successful init,
    // `stats().artifactInlineBodyChars` is 0.
    if (upgraded || this.artifactBodyMigrationNeeded()) {
      try {
        const migrated = this.migrateArtifactBodies();
        if (migrated > 0) this.logger?.info?.(`[lcm] moved ${migrated} artifact bodies into content-addressed blobs`);
      } catch (error) {
        // Loud but non-fatal: the archive stays usable with the bodies inline. It
        // does not read as success either -- the bodies are still there, so
        // `stats().artifactInlineBodyChars` stays non-zero and the next start
        // retries, which is the whole point of not gating on the version bump.
        this.logger?.warn?.(
          `[lcm] artifact body migration failed; bodies stay in place and the next start retries: ${error?.message ?? error}`,
        );
      }
    }
    if (upgraded) {
      // The search tables are derived and their format is part of the schema, so a
      // version bump rebuilds them here rather than leaving search silently empty.
      try {
        const documents = this.rebuildSearchIndexes();
        this.logger?.info?.(`[lcm] rebuilt the search index for schema ${SCHEMA_VERSION}: ${documents} documents`);
      } catch (error) {
        this.ftsAvailable = false;
        this.logger?.warn?.(`[lcm] search index rebuild failed; falling back to substring search: ${error?.message ?? error}`);
      }
    }
    return this;
  }

  /**
   * Whether the schema-4 body layout is still unfulfilled on this archive.
   *
   * Two independent conditions, because either one alone strands the archive:
   * rows still carrying an inline body (a failed or interrupted migration), and
   * a table whose `content_text` is still `NOT NULL` -- which cannot store the
   * NULL body that `insertArtifact` writes, even when no legacy row is left.
   *
   * This is deliberately not "was the version bumped". `openArchive` stamps
   * `schema_version = 4` before this is asked, so a version test answers "yes"
   * exactly once and then skips the retry forever after a failure.
   */
  artifactBodyMigrationNeeded() {
    if (artifactsContentTextIsNotNull(this.db)) return true;
    return this.get('SELECT 1 AS present FROM artifacts WHERE content_text IS NOT NULL LIMIT 1') !== undefined;
  }

  /**
   * Move legacy `artifacts.content_text` bodies into `artifact_blobs`.
   *
   * Schema 4 keeps the text in exactly one place: the content-addressed blob.
   * The body is copied first and the column nulled only afterwards, so the
   * operation is idempotent and interruptible -- a crash between the two leaves
   * a duplicate the next run accepts, never a lost body.
   *
   * A schema-3 table declares `content_text NOT NULL`, which no `UPDATE ... SET
   * content_text = NULL` can satisfy, so the table is rebuilt with the schema-4
   * shape first (see `rebuildArtifactsTableIfNeeded`). Both steps share one
   * transaction: a half-rebuilt table or a half-moved set of bodies must never be
   * visible to the next open.
   *
   * @returns {number} artifacts whose column was cleared
   */
  migrateArtifactBodies() {
    let moved = 0;
    // One transaction: a large archive is thousands of rows, and a partial
    // migration would leave the index rebuilt from a half-moved table.
    inTransaction(this.db, () => {
      if (rebuildArtifactsTableIfNeeded(this.db)) {
        // Every cached statement was prepared against the table that was just
        // dropped. SQLite recompiles them on the next step, but dropping the
        // cache keeps that implicit behaviour from being load-bearing.
        this.statements.clear();
      }
      const rows = this.all(
        'SELECT artifact_id, content_text, content_hash, char_count, created_at FROM artifacts WHERE content_text IS NOT NULL',
      );
      for (const row of rows) {
        const hash = row.content_hash ?? hashContent(row.content_text);
        this.run(
          'INSERT INTO artifact_blobs (content_hash, content_text, char_count, created_at, orphaned_at) VALUES (?, ?, ?, ?, NULL) ON CONFLICT(content_hash) DO NOTHING',
          hash,
          row.content_text,
          row.char_count ?? String(row.content_text).length,
          row.created_at ?? Date.now(),
        );
        // Reconciliation: the blob is already present, so clearing the column
        // cannot lose the body.
        this.run('UPDATE artifacts SET content_text = NULL, content_hash = ? WHERE artifact_id = ?', hash, row.artifact_id);
        moved += 1;
      }
    });
    return moved;
  }

  close() {
    if (this.db) {
      try {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        // A checkpoint failure must not block unload.
      }
      try {
        this.db.close();
      } catch {
        // Already closed.
      }
      this.db = undefined;
    }
    this.statements.clear();
    this.ready = false;
  }

  /**
   * Repopulate the three full-text tables from the base tables.
   *
   * The index stores n-gram-exploded text (see `explodeForIndex`), so this is the
   * only correct way to rebuild it — including after a schema upgrade changed the
   * tokenizer.
   *
   * @returns {number} documents indexed
   */
  rebuildSearchIndexes() {
    if (!this.ftsAvailable) return 0;
    let documents = 0;
    // A rebuild is thousands of inserts, so one transaction keeps activation fast
    // instead of paying a commit per row.
    inTransaction(this.db, () => {
      documents = this.writeSearchIndexRows();
    });
    return documents;
  }

  /** Insert every derived search row. Must be called inside a transaction. */
  writeSearchIndexRows() {
    let documents = 0;
    this.db.exec('DELETE FROM message_fts');
    this.db.exec('DELETE FROM summary_fts');
    this.db.exec('DELETE FROM artifact_fts');
    // Tombstoned messages stay out of the index, exactly as every query path
    // filters them and as `feedback/message-delete` removes their row. Rebuilding
    // them in would recreate, on the first repair, the drift the repair is for.
    for (const row of this.all('SELECT session_id, message_id, role, created_at, text FROM messages WHERE deleted_at IS NULL')) {
      this.run(
        'INSERT INTO message_fts (session_id, message_id, role, created_at, content) VALUES (?, ?, ?, ?, ?)',
        row.session_id,
        row.message_id,
        row.role,
        row.created_at,
        explodeForIndex(row.text ?? ''),
      );
      documents += 1;
    }
    for (const row of this.all('SELECT session_id, node_id, level, created_at, summary_text FROM summary_nodes')) {
      this.run(
        'INSERT INTO summary_fts (session_id, node_id, level, created_at, content) VALUES (?, ?, ?, ?, ?)',
        row.session_id,
        row.node_id,
        row.level,
        row.created_at,
        explodeForIndex(row.summary_text ?? ''),
      );
      documents += 1;
    }
    // Only the preview is indexed. The whole body used to be exploded into
    // n-grams -- 29.5 MB of index for 8.58 MB of text in the reference archive --
    // while the leading text is what makes an artifact discoverable. What is
    // indexed and what `gatherCandidates` reports therefore agree by construction.
    for (const row of this.all('SELECT session_id, artifact_id, message_id, artifact_kind, created_at, preview_text FROM artifacts')) {
      this.run(
        'INSERT INTO artifact_fts (session_id, artifact_id, message_id, artifact_kind, created_at, content) VALUES (?, ?, ?, ?, ?, ?)',
        row.session_id,
        row.artifact_id,
        row.message_id,
        row.artifact_kind,
        row.created_at,
        explodeForIndex(row.preview_text ?? ''),
      );
      documents += 1;
    }
    return documents;
  }

  /** Prepare (and cache) one statement. */
  stmt(sql) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  run(sql, ...params) {
    return this.stmt(sql).run(...params.map(nz));
  }

  get(sql, ...params) {
    return plain(this.stmt(sql).get(...params.map(nz)));
  }

  all(sql, ...params) {
    return plainAll(this.stmt(sql).all(...params.map(nz)));
  }

  // ---------------------------------------------------------------- sessions

  /**
   * Insert or refresh one session row.
   *
   * @param {object} header the Harness `SessionHeader` (or a compatible subset)
   * @param {{title?: string}} [extra]
   */
  upsertSession(header, extra = {}) {
    const sessionId = typeof header?.id === 'string' ? header.id : undefined;
    if (!sessionId) return undefined;
    const parentSessionId = typeof header?.parentSession === 'string' ? header.parentSession : null;
    const existing = this.get('SELECT * FROM sessions WHERE session_id = ?', sessionId);
    const rootSessionId = this.resolveRootSessionId(sessionId, parentSessionId, existing);
    const depth = Number.isFinite(header?.delegationDepth)
      ? header.delegationDepth
      : parentSessionId
        ? (this.get('SELECT lineage_depth FROM sessions WHERE session_id = ?', parentSessionId)?.lineage_depth ?? 0) + 1
        : 0;
    const createdAt = Number.isFinite(header?.createdAt) ? header.createdAt : Date.now();
    const cwd = typeof header?.cwd === 'string' ? header.cwd : null;
    const title = typeof extra.title === 'string' && extra.title.length > 0 ? extra.title : (existing?.title ?? null);

    this.run(
      `INSERT INTO sessions (
         session_id, title, cwd, worktree_key, parent_session_id, root_session_id,
         lineage_depth, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         title = COALESCE(excluded.title, sessions.title),
         cwd = COALESCE(excluded.cwd, sessions.cwd),
         worktree_key = COALESCE(excluded.worktree_key, sessions.worktree_key),
         parent_session_id = COALESCE(excluded.parent_session_id, sessions.parent_session_id),
         root_session_id = excluded.root_session_id,
         lineage_depth = excluded.lineage_depth,
         updated_at = excluded.updated_at`,
      sessionId,
      title,
      cwd,
      worktreeKeyOf(cwd),
      parentSessionId,
      rootSessionId,
      depth,
      createdAt,
      Date.now(),
    );
    return sessionId;
  }

  /** Walk the parent chain to the root, guarding against cycles. */
  resolveRootSessionId(sessionId, parentSessionId, existing) {
    if (existing?.root_session_id) return existing.root_session_id;
    if (!parentSessionId) return sessionId;
    const seen = new Set([sessionId]);
    let current = parentSessionId;
    for (let hops = 0; hops < 64; hops += 1) {
      if (seen.has(current)) break;
      seen.add(current);
      const row = this.get('SELECT root_session_id, parent_session_id FROM sessions WHERE session_id = ?', current);
      if (!row) return current;
      if (row.root_session_id && row.root_session_id !== current) return row.root_session_id;
      if (!row.parent_session_id) return current;
      current = row.parent_session_id;
    }
    return parentSessionId;
  }

  /** The last archived seq for a session, or -1. */
  watermark(sessionId) {
    return this.get('SELECT watermark_seq FROM sessions WHERE session_id = ?', sessionId)?.watermark_seq ?? -1;
  }

  setWatermark(sessionId, seq) {
    this.run('UPDATE sessions SET watermark_seq = MAX(watermark_seq, ?), updated_at = ? WHERE session_id = ?', seq, Date.now(), sessionId);
  }

  hasSession(sessionId) {
    return this.get('SELECT 1 AS present FROM sessions WHERE session_id = ?', sessionId) !== undefined;
  }

  sessionRow(sessionId) {
    return this.get('SELECT * FROM sessions WHERE session_id = ?', sessionId);
  }

  // ----------------------------------------------------------------- capture

  /**
   * Archive the message-bearing events of one session log.
   *
   * The caller supplies the log (from `ctx.sessionQuery.readSession`) and the
   * store skips everything at or below its watermark, so repeated backfills are
   * cheap and gaps left by a plugin reload self-heal.
   *
   * @param {object} header session header
   * @param {Array<{type: string, seq: number, time?: number, data?: unknown}>} events
   * @returns {{captured: number, skipped: number}}
   */
  capture(header, events) {
    if (!this.ready || !this.config.capture.enabled) return { captured: 0, skipped: 0 };
    const sessionId = this.upsertSession(header);
    if (!sessionId || !Array.isArray(events) || events.length === 0) return { captured: 0, skipped: 0 };

    const watermark = this.watermark(sessionId);
    let captured = 0;
    let skipped = 0;
    // Artifacts are written after the transaction commits. `insertArtifact`
    // necessarily commits its own blob+row pair, and `node:sqlite` has no nested
    // transactions, so collecting them here is what keeps the archive row and the
    // artifact body in agreement without a `BEGIN` inside a `BEGIN`.
    /** @type {Array<{messageId: string, artifact: object}>} */
    const pendingArtifacts = [];
    // The archived frontier. It advances only across a contiguous run of event
    // positions, so an event delivered ahead of the backfill -- a live
    // session/event that arrives before this session's first full read -- cannot
    // push the watermark over unarchived history and discard it.
    let frontier = watermark;

    // Ascending order is what lets the frontier advance contiguously.
    const ordered = [...events].sort(
      (a, b) => (Number.isFinite(a?.seq) ? a.seq : -1) - (Number.isFinite(b?.seq) ? b.seq : -1),
    );

    inTransaction(this.db, () => {
      for (const event of ordered) {
        const seq = Number.isFinite(event?.seq) ? event.seq : undefined;
        if (seq === undefined || seq <= frontier) {
          skipped += 1;
          continue;
        }

        if (this.captureSideEffectEvent(sessionId, event)) {
          this.counters.capturedEvents += 1;
        }

        // Remember the name behind each call id before its result arrives.
        if (event.type === 'tool/call') this.rememberToolCall(event.data);

        if (isMessageEventType(event.type)) {
          const message = messageOfEvent(event);
          const result = message
            ? this.captureMessage(sessionId, seq, event.time, message, this.toolNameFor(message), pendingArtifacts)
            : undefined;
          if (result) captured += 1;
        }

        // Advance only across contiguous positions. A gap leaves the frontier
        // behind, so the next backfill replays from it and repairs the archive.
        if (seq === frontier + 1) frontier = seq;
      }

      this.run(
        `UPDATE sessions
            SET watermark_seq = MAX(watermark_seq, ?),
                event_count = event_count + ?,
                updated_at = ?
          WHERE session_id = ?`,
        frontier,
        captured,
        Date.now(),
        sessionId,
      );
    });

    // Now that the message rows and the watermark are committed, write the
    // externalized bodies. Each insert is its own transaction, so a failure here
    // costs that one artifact rather than the whole capture.
    for (const entry of pendingArtifacts) {
      try {
        this.insertArtifact(sessionId, entry.messageId, entry.artifact);
      } catch (error) {
        this.logger?.warn?.(`[lcm] artifact write failed for ${entry.artifact?.artifactId}: ${error?.message ?? error}`);
      }
    }

    this.counters.capturedMessages += captured;
    return { captured, skipped };
  }

  /**
   * Record log-only events that carry session lifecycle meaning.
   *
   * Only notable events are persisted: message events are already stored in
   * `messages`, and duplicating the whole structural log would double the
   * archive for no retrieval benefit. A compaction event is persisted as its span
   * fields alone -- see `eventPayloadJson` -- which is what keeps the largest
   * payload in the archive from being the one nothing reads.
   */
  captureSideEffectEvent(sessionId, event) {
    const type = event?.type;
    const ts = Number.isFinite(event?.time) ? event.time : Date.now();

    if (type === 'session/title') {
      const data = event.data ?? {};
      const title = data.title ?? data.value ?? data.text;
      if (typeof title === 'string' && title.length > 0) {
        this.run('UPDATE sessions SET title = ?, updated_at = ? WHERE session_id = ?', truncate(title, 400), Date.now(), sessionId);
        return true;
      }
      return false;
    }

    if (type === 'compaction/summary' || type === 'compaction/end') {
      // MAX, not assignment: `compaction/summary` and `compaction/end` both stamp
      // this, and the two can arrive with non-advancing or out-of-order times.
      // Writing the older stamp last moved the marker backwards, which re-armed a
      // note the model had already been shown.
      this.run(
        'UPDATE sessions SET compacted_at = MAX(COALESCE(compacted_at, 0), ?), updated_at = ? WHERE session_id = ?',
        ts,
        Date.now(),
        sessionId,
      );
    }

    if (type === 'feedback/message-delete') {
      const messageId = event.data?.messageId ?? event.data?.message_id ?? event.data?.id;
      if (typeof messageId === 'string') {
        this.run('UPDATE messages SET deleted_at = ? WHERE message_id = ?', ts, messageId);
        // The index row goes with it: `deleted_at` keeps the tombstone out of
        // every query, and `writeSearchIndexRows` skips tombstones too, so an
        // index still holding the row would report permanent drift.
        this.deleteFts('message_fts', 'message_id', messageId);
      }
    }

    const notables = new Set([
      'compaction/start',
      'compaction/end',
      'compaction/summary',
      'session/title',
      'feedback/message-delete',
      'feedback/message-put',
      'turn/start',
      'turn/end',
    ]);
    if (!notables.has(type)) return false;

    this.run(
      'INSERT INTO events (id, session_id, event_type, seq, ts, payload_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
      `${sessionId}:${event.seq}:${type}`,
      sessionId,
      String(type),
      Number.isFinite(event.seq) ? event.seq : -1,
      ts,
      eventPayloadJson(type, event.data),
    );
    return true;
  }

  /** Record the tool name that a `tool/call` event pairs with a call id. */
  rememberToolCall(data) {
    const callId = data?.callId;
    const callName = data?.name;
    if (typeof callId !== 'string' || callId.length === 0) return;
    if (typeof callName !== 'string' || callName.length === 0) return;
    this.toolCalls.delete(callId);
    this.toolCalls.set(callId, callName);
    if (this.toolCalls.size > 20_000) {
      this.toolCalls.delete(this.toolCalls.keys().next().value);
    }
  }

  /** Tool name behind a tool-result message, from its call id when needed. */
  toolNameFor(message) {
    if (message?.role !== 'tool') return undefined;
    const direct = message.toolName ?? message.source?.toolName ?? message.source?.name;
    if (typeof direct === 'string' && direct.length > 0) return direct;
    const callId = message.toolCallId;
    return typeof callId === 'string' ? this.toolCalls.get(callId) : undefined;
  }

  /**
   * Store one normalized message plus its FTS row.
   *
   * Externalized artifacts are appended to `pendingArtifacts` instead of being
   * written here: this runs inside `capture`'s transaction, where `insertArtifact`
   * could not open one of its own.
   *
   * @param {Array<{messageId: string, artifact: object}>} [pendingArtifacts]
   */
  captureMessage(sessionId, seq, time, message, toolName, pendingArtifacts) {
    const messageId = typeof message.id === 'string' && message.id.length > 0 ? message.id : `${sessionId}:seq-${seq}`;
    const createdAt = Number.isFinite(time) ? time : Date.now();
    const normalized = normalizeMessage(message, {
      seq,
      createdAt,
      privacy: this.privacy,
      sessionId,
      toolName,
      // Externalization thresholds live on the top-level config, not on
      // `capture`; merge so `normalizeMessage` sees one coherent object.
      config: {
        ...this.config.capture,
        largeContentThreshold: this.config.largeContentThreshold,
        artifactPreviewChars: this.config.artifactPreviewChars,
      },
    });

    // The capture-side filter declined this message: it is harness-injected, or a
    // system message the configuration excludes. Nothing is written, and the
    // watermark still advances so the skipped event is not replayed forever.
    if (!normalized) return false;

    const capped = truncate(normalized.text, this.config.capture.maxTextCharsPerMessage);

    this.run(
      `INSERT INTO messages (message_id, session_id, seq, role, created_at, info_json, text)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET
         seq = excluded.seq,
         role = excluded.role,
         created_at = excluded.created_at,
         deleted_at = NULL,
         info_json = excluded.info_json,
         text = excluded.text`,
      messageId,
      sessionId,
      seq,
      normalized.role,
      createdAt,
      normalized.infoJson,
      capped,
    );

    this.replaceFts('message_fts', 'message_id', messageId, () => {
      this.run(
        'INSERT INTO message_fts (session_id, message_id, role, created_at, content) VALUES (?, ?, ?, ?, ?)',
        sessionId,
        messageId,
        normalized.role,
        createdAt,
        explodeForIndex(capped),
      );
    });

    // Artifacts are written after the message row, in their own transaction:
    // `capture` already holds one, and `node:sqlite` throws on a nested `BEGIN`,
    // so the insert must not open a second one here.
    if (Array.isArray(pendingArtifacts)) {
      for (const artifact of normalized.artifacts) pendingArtifacts.push({ messageId, artifact });
    } else {
      for (const artifact of normalized.artifacts) this.insertArtifact(sessionId, messageId, artifact);
    }
    return true;
  }

  /**
   * Insert one artifact, storing its body exactly once.
   *
   * The content-addressed blob owns the text; `artifacts` keeps the preview, the
   * hash and the length, and `artifact()` reads the body back through a join. The
   * upsert clears any legacy `content_text` on the row it replaces, which is what
   * makes the column's remaining presence harmless.
   *
   * Both writes share one transaction: a crash between them would otherwise leave
   * a blob with no referrer, or an artifact pointing at a body that was never
   * written.
   */
  insertArtifact(sessionId, messageId, artifact) {
    const contentHash = artifact.contentHash ?? hashContent(artifact.content);
    const preview = artifact.preview ?? truncate(artifact.content, this.config.artifactPreviewChars);
    const createdAt = Date.now();

    inTransaction(this.db, () => {
      const existingBlob = this.get('SELECT content_hash FROM artifact_blobs WHERE content_hash = ?', contentHash);
      if (!existingBlob) {
        this.run(
          'INSERT INTO artifact_blobs (content_hash, content_text, char_count, created_at, orphaned_at) VALUES (?, ?, ?, ?, NULL)',
          contentHash,
          artifact.content,
          artifact.content.length,
          createdAt,
        );
      } else {
        this.run('UPDATE artifact_blobs SET orphaned_at = NULL WHERE content_hash = ?', contentHash);
      }

      this.run(
        `INSERT INTO artifacts (
           artifact_id, session_id, message_id, block_index, artifact_kind, field_name,
           preview_text, content_text, content_hash, metadata_json, char_count, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
         ON CONFLICT(artifact_id) DO UPDATE SET
           preview_text = excluded.preview_text,
           content_text = NULL,
           content_hash = excluded.content_hash,
           metadata_json = excluded.metadata_json,
           char_count = excluded.char_count`,
        artifact.artifactId,
        sessionId,
        messageId,
        artifact.blockIndex ?? 0,
        artifact.kind ?? 'unknown',
        artifact.fieldName ?? 'content',
        preview,
        contentHash,
        JSON.stringify(artifact.metadata ?? {}),
        artifact.content.length,
        createdAt,
      );
    });

    // Only the preview is indexed: the body is fetched on demand by
    // `lcm_artifact`, so paying 29.5 MB of n-grams to make it greppable as well
    // is the third copy this layout removes.
    this.replaceFts('artifact_fts', 'artifact_id', artifact.artifactId, () => {
      this.run(
        'INSERT INTO artifact_fts (session_id, artifact_id, message_id, artifact_kind, created_at, content) VALUES (?, ?, ?, ?, ?, ?)',
        sessionId,
        artifact.artifactId,
        messageId,
        artifact.kind ?? 'unknown',
        createdAt,
        explodeForIndex(preview),
      );
    });
  }

  /**
   * Delete then insert one FTS row, tolerating a missing or duplicate row.
   *
   * @param {string} table FTS table name
   * @param {string} column the table's UNINDEXED id column
   * @param {string} id row identity to replace
   * @param {() => void} insert performs the insert
   */
  replaceFts(table, column, id, insert) {
    if (!this.ftsAvailable) return;
    try {
      this.run(`DELETE FROM ${table} WHERE ${column} = ?`, id);
      insert();
    } catch (error) {
      // An FTS tokenizer failure must not lose the archive row itself, and the
      // store degrades to substring scanning for the rest of this lifetime.
      this.ftsAvailable = false;
      this.logger?.warn?.(`[lcm] FTS write failed; falling back to substring search: ${error?.message ?? error}`);
    }
  }

  /**
   * Delete one FTS row.
   *
   * The id column is a parameter, exactly as in `replaceFts`: the FTS tables do
   * not share a column name, so hardcoding `message_id` made every call for
   * `summary_fts` or `artifact_fts` throw "no such column" -- and the swallowing
   * catch turned that into a silent no-op.
   *
   * @param {string} table FTS table name
   * @param {string} column the table's UNINDEXED id column
   * @param {string} id row identity to delete
   */
  deleteFts(table, column, id) {
    if (!this.ftsAvailable) return;
    try {
      this.run(`DELETE FROM ${table} WHERE ${column} = ?`, id);
    } catch {
      // Ignore: the row may not exist.
    }
  }

  // ------------------------------------------------------------------- scopes

  /** All archived session ids, newest first. */
  listSessionIds() {
    return this.all('SELECT session_id FROM sessions ORDER BY updated_at DESC').map((row) => row.session_id);
  }

  /**
   * Resolve a retrieval scope to concrete session ids.
   *
   * @param {'session'|'root'|'worktree'|'all'} scope
   * @param {string} sessionId
   * @returns {string[]}
   */
  resolveScope(scope, sessionId) {
    switch (scope) {
      case 'all':
        return this.listSessionIds();
      case 'root': {
        const row = this.sessionRow(sessionId);
        const rootId = row?.root_session_id ?? sessionId;
        const ids = this.all('SELECT session_id FROM sessions WHERE root_session_id = ? ORDER BY updated_at DESC', rootId).map(
          (entry) => entry.session_id,
        );
        return ids.includes(rootId) ? ids : [rootId, ...ids];
      }
      case 'worktree': {
        const key = this.sessionRow(sessionId)?.worktree_key;
        if (!key) return [sessionId];
        return this.all('SELECT session_id FROM sessions WHERE worktree_key = ? ORDER BY updated_at DESC', key).map(
          (entry) => entry.session_id,
        );
      }
      case 'session':
      default:
        return [sessionId];
    }
  }

  /** Lineage of one session: ancestry, then direct children. */
  lineage(sessionId) {
    const row = this.sessionRow(sessionId);
    if (!row) return { found: false, sessionId };

    const ancestry = [];
    let current = row.parent_session_id;
    const seen = new Set([sessionId]);
    while (current && !seen.has(current) && ancestry.length < 64) {
      seen.add(current);
      const parent = this.sessionRow(current);
      if (!parent) {
        ancestry.push({ sessionId: current, missing: true });
        break;
      }
      ancestry.push({
        sessionId: parent.session_id,
        title: parent.title ?? undefined,
        depth: parent.lineage_depth,
      });
      current = parent.parent_session_id;
    }

    const children = this.all(
      'SELECT session_id, title, lineage_depth, updated_at FROM sessions WHERE parent_session_id = ? ORDER BY updated_at DESC LIMIT 100',
      sessionId,
    );

    return {
      found: true,
      sessionId,
      title: row.title ?? undefined,
      rootSessionId: row.root_session_id,
      depth: row.lineage_depth,
      cwd: row.cwd ?? undefined,
      ancestry,
      children: children.map((child) => ({
        sessionId: child.session_id,
        title: child.title ?? undefined,
        depth: child.lineage_depth,
      })),
    };
  }

  // -------------------------------------------------------------------- search

  /**
   * Number of archived messages.
   *
   * This is the population documentFrequency() counts over, so it is also the
   * denominator for the corpus-commonness ratio.
   */
  messageCount() {
    return this.get('SELECT COUNT(*) AS n FROM messages')?.n ?? 0;
  }

  /** Total FTS document count across the three corpora. */
  totalDocuments() {
    const count = (table) => {
      try {
        return this.get(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0;
      } catch {
        return 0;
      }
    };
    return Math.max(1, count('message_fts') + count('summary_fts') + count('artifact_fts'));
  }

  /** Document frequency of one token, used for TF-IDF token filtering. */
  documentFrequency(token) {
    const pattern = `%${escapeLike(token)}%`;
    const message = this.get("SELECT COUNT(*) AS n FROM messages WHERE deleted_at IS NULL AND text LIKE ? ESCAPE '\\'", pattern)?.n ?? 0;
    return message;
  }

  /**
   * Gather raw candidates for a query inside a scope.
   *
   * @param {object} options
   * @param {string} options.query
   * @param {string[]} options.sessionIds
   * @param {boolean} [options.allowScan]
   * @param {Set<string>} [options.restrictMessageIds] restrict every corpus by these message ids; an
   *   empty set therefore restricts everything away, which is what an empty subtree means
   * @returns {Array<object>} ranked candidates
   */
  gatherCandidates({ query, sessionIds, allowScan = true, restrictMessageIds }) {
    if (sessionIds.length === 0) return [];
    const placeholders = sessionIds.map(() => '?').join(', ');
    const rankTokens = tokenizeQuery(query);
    const ftsQuery = buildFtsQuery(query);
    const candidates = [];
    // Terms the n-gram index is structurally unable to answer, whatever the
    // query looks like overall: a single Han character is a real word, but the
    // index stores bigrams, so `上` can only ever be found by a substring scan.
    const unindexable = unindexableRuns(query);

    const pushMessage = (row) => {
      candidates.push({
        id: row.message_id,
        type: row.role,
        sessionID: row.session_id,
        timestamp: row.created_at,
        snippet: buildSnippet(row.text, query, 280),
        content: row.text ?? '',
        sourceKind: 'message',
        sourceOrder: 0,
      });
    };

    if (ftsQuery && this.ftsAvailable) {
      try {
        for (const row of this.all(
          `SELECT f.message_id, f.session_id, f.role, f.created_at,
                  m.text AS text, 0 AS source_order
             FROM message_fts f
             JOIN messages m ON m.message_id = f.message_id
            WHERE message_fts MATCH ?
              AND f.session_id IN (${placeholders})
              AND m.deleted_at IS NULL
            ORDER BY f.created_at DESC, f.message_id
            LIMIT 400`,
          ftsQuery,
          ...sessionIds,
        )) {
          pushMessage(row);
        }

        for (const row of this.all(
          `SELECT n.node_id, n.session_id, n.level, n.created_at, n.summary_text
             FROM summary_fts f
             JOIN summary_nodes n ON n.node_id = f.node_id
            WHERE summary_fts MATCH ?
              AND f.session_id IN (${placeholders})
            ORDER BY n.created_at DESC, n.node_id
            LIMIT 200`,
          ftsQuery,
          ...sessionIds,
        )) {
          candidates.push({
            id: row.node_id,
            type: 'summary',
            sessionID: row.session_id,
            timestamp: row.created_at,
            snippet: buildSnippet(row.summary_text, query, 280),
            content: row.summary_text ?? '',
            sourceKind: 'summary',
            sourceOrder: row.level ?? 0,
          });
        }

        for (const row of this.all(
          `SELECT a.artifact_id, a.session_id, a.message_id, a.artifact_kind, a.created_at, a.preview_text
             FROM artifact_fts f
             JOIN artifacts a ON a.artifact_id = f.artifact_id
            WHERE artifact_fts MATCH ?
              AND f.session_id IN (${placeholders})
            ORDER BY a.created_at DESC, a.artifact_id
            LIMIT 200`,
          ftsQuery,
          ...sessionIds,
        )) {
          candidates.push({
            id: row.artifact_id,
            type: `artifact:${row.artifact_kind}`,
            sessionID: row.session_id,
            messageID: row.message_id,
            timestamp: row.created_at,
            // The preview, not the body: the index holds only the preview, and
            // the body is fetched on demand by `lcm_artifact`.
            snippet: buildSnippet(row.preview_text, query, 280),
            content: row.preview_text ?? '',
            sourceKind: 'artifact',
            sourceOrder: 0,
          });
        }
      } catch (error) {
        this.logger?.warn?.(`[lcm] FTS query failed, using substring scan: ${error?.message ?? error}`);
      }
    }

    // The LIKE scan is the fallback for sub-gram queries (the index needs three
    // Latin characters and two CJK ones) and for a database whose FTS tables
    // failed to build. It must also run when the index *did* answer a different
    // term of the same query: a hit on `上下文` says nothing about whether `上`
    // is contained, so "no candidates" is not the right trigger.
    if (allowScan && (candidates.length === 0 || unindexable.length > 0)) {
      const terms = [...new Set([...queryPhrases(query), ...rankTokens, ...unindexable])]
        // A single Latin character is too common to scan for; a single CJK
        // character is a word and is exactly the case this scan exists for.
        .filter((term) => term.length >= 2 || (term.length === 1 && isCjkRun(term)))
        .slice(0, 6);
      for (const term of terms) {
        if (candidates.length >= 400) break;
        const rows = this.all(
          `SELECT message_id, session_id, role, created_at, text
             FROM messages
            WHERE session_id IN (${placeholders})
              AND deleted_at IS NULL
              AND text LIKE ? ESCAPE '\\'
            ORDER BY created_at DESC, message_id
            LIMIT 120`,
          ...sessionIds,
          `%${escapeLike(term)}%`,
        );
        for (const row of rows) pushMessage(row);
      }
    }

    // A summary-scoped search must restrict every corpus by the subtree, not
    // only messages: an artifact row that survives the filter is precisely the
    // leak the restriction exists to prevent. A caller that passed a set asked
    // for a restriction, including the empty set an empty subtree produces.
    if (restrictMessageIds) {
      return candidates.filter((candidate) => {
        if (candidate.sourceKind === 'message') return restrictMessageIds.has(candidate.id);
        if (candidate.sourceKind === 'artifact') return restrictMessageIds.has(candidate.messageID);
        return true;
      });
    }
    return candidates;
  }

  /**
   * Scoped search over the archive.
   *
   * @param {object} options
   * @returns {Array<object>|string} ranked results, or a message when nothing was searched
   */
  grep({ query, sessionId, scope, limit = 5, offset = 0, summaryId, allowScan = true }) {
    const trimmed = collapseWhitespace(query);
    if (trimmed.length === 0) return 'A non-empty query is required.';
    if (!this.hasSession(sessionId)) return 'No archived capture for this session yet.';

    const sessionIds = this.resolveScope(scope ?? this.config.scopeDefaults.grep, sessionId);
    let restrictMessageIds;
    if (summaryId) {
      // An unresolvable node must answer rather than silently widen the search
      // back to the whole scope: a caller that named a subtree asked for one.
      if (!this.get('SELECT 1 AS present FROM summary_nodes WHERE node_id = ?', summaryId)) {
        return `No summary node matched "${summaryId}".`;
      }
      restrictMessageIds = new Set(this.descendantMessageIds(summaryId));
    }

    const candidates = this.gatherCandidates({ query: trimmed, sessionIds, allowScan, restrictMessageIds });
    if (candidates.length === 0) return [];
    // Over-fetch so pagination stays meaningful after dedup and ranking.
    const ranked = rankSearchCandidates(candidates, trimmed, limit + offset + 8);
    return ranked.slice(offset, offset + limit);
  }

  /** Every raw message id referenced by a summary node and its descendants. */
  descendantMessageIds(nodeId) {
    const node = this.get('SELECT * FROM summary_nodes WHERE node_id = ?', nodeId);
    if (!node) return [];
    const ids = new Set(parseJson(node.message_ids_json, []));
    const queue = [nodeId];
    const seen = new Set([nodeId]);
    while (queue.length > 0) {
      const current = queue.shift();
      const children = this.all('SELECT child_id FROM summary_edges WHERE parent_id = ? ORDER BY child_position', current);
      for (const child of children) {
        if (seen.has(child.child_id)) continue;
        seen.add(child.child_id);
        const childNode = this.get('SELECT message_ids_json FROM summary_nodes WHERE node_id = ?', child.child_id);
        for (const id of parseJson(childNode?.message_ids_json, [])) ids.add(id);
        queue.push(child.child_id);
      }
    }
    return [...ids];
  }

  /** Human-readable description of archived capture for a scope. */
  describe({ sessionId, scope }) {
    const resolved = scope ?? this.config.scopeDefaults.describe;
    const sessionIds = this.resolveScope(resolved, sessionId);
    if (sessionIds.length === 0) return 'No archived capture yet.';

    const placeholders = sessionIds.map(() => '?').join(', ');
    const totals = this.get(
      `SELECT COUNT(*) AS messages,
              MIN(created_at) AS oldest,
              MAX(created_at) AS newest,
              SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS tombstones
         FROM messages WHERE session_id IN (${placeholders})`,
      ...sessionIds,
    ) ?? { messages: 0 };

    const byRole = this.all(
      `SELECT role, COUNT(*) AS n FROM messages
        WHERE session_id IN (${placeholders}) AND deleted_at IS NULL
        GROUP BY role ORDER BY n DESC`,
      ...sessionIds,
    );

    const summaryCount = this.get(
      `SELECT COUNT(*) AS n, MAX(level) AS max_level FROM summary_nodes WHERE session_id IN (${placeholders})`,
      ...sessionIds,
    ) ?? { n: 0 };

    const artifactCount = this.get(
      `SELECT COUNT(*) AS n, COALESCE(SUM(char_count), 0) AS chars FROM artifacts WHERE session_id IN (${placeholders})`,
      ...sessionIds,
    ) ?? { n: 0, chars: 0 };

    const lines = [
      `scope=${resolved}`,
      `sessions=${sessionIds.length}`,
      `messages=${totals.messages ?? 0}`,
      `tombstoned_messages=${totals.tombstones ?? 0}`,
      `roles=${byRole.map((row) => `${row.role}:${row.n}`).join(',') || 'none'}`,
      `oldest=${totals.oldest ? new Date(totals.oldest).toISOString() : 'n/a'}`,
      `newest=${totals.newest ? new Date(totals.newest).toISOString() : 'n/a'}`,
      `summary_nodes=${summaryCount.n ?? 0}`,
      `summary_max_level=${summaryCount.max_level ?? 0}`,
      `artifacts=${artifactCount.n ?? 0}`,
      `artifact_chars=${artifactCount.chars ?? 0}`,
    ];
    for (const id of sessionIds.slice(0, 20)) {
      const row = this.sessionRow(id);
      if (!row) continue;
      lines.push(
        `session=${row.session_id} messages=${this.get('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?', id)?.n ?? 0} pinned=${row.pinned === 1} compacted_at=${row.compacted_at ?? 'n/a'} title=${truncate(row.title ?? '', 80) || 'n/a'}`,
      );
    }
    return lines.join('\n');
  }

  // ----------------------------------------------------------------- summaries

  /**
   * Rebuild the deterministic summary tree for one session.
   *
   * Leaves cover `levelSize` consecutive archived messages; each higher level
   * folds `levelSize` children. Node ids are derived from the covered range, so
   * an unchanged archive produces identical ids and the rebuild is idempotent.
   *
   * @param {string} sessionId
   * @param {{force?: boolean}} [options]
   * @returns {{rebuilt: boolean, nodes: number, roots: string[]}}
   */
  buildSummaries(sessionId, options = {}) {
    if (!this.hasSession(sessionId)) return { rebuilt: false, nodes: 0, roots: [] };
    const { levelSize, minMessagesForTransform, perMessageBudget, summaryCharBudget, strategy } = this.config.summary;

    const messages = this.all(
      `SELECT message_id, seq, role, created_at, text FROM messages
        WHERE session_id = ? AND deleted_at IS NULL
        ORDER BY seq ASC`,
      sessionId,
    );
    if (messages.length < Math.max(2, minMessagesForTransform)) {
      return { rebuilt: false, nodes: 0, roots: [] };
    }

    // Keep the newest `freshTailMessages` out of the summary: those turns are
    // still verbatim in the model's working context, so summarizing them would
    // only duplicate what the model already sees.
    const tail = Math.max(0, this.config.freshTailMessages);
    const archived = tail > 0 ? messages.slice(0, Math.max(0, messages.length - tail)) : messages;
    if (archived.length === 0) return { rebuilt: false, nodes: 0, roots: [] };

    const signature = hashContent(`${archived.length}:${archived[0].seq}:${archived.at(-1).seq}:${archived.map((m) => m.message_id).join(',')}`);
    const state = this.get('SELECT * FROM summary_state WHERE session_id = ?', sessionId);
    if (!options.force && state?.archived_signature === signature) {
      return { rebuilt: false, nodes: 0, roots: parseJson(state.root_node_ids_json, []) };
    }

    this.counters.summaryRebuilds += 1;
    let nodes = 0;
    let roots = [];

    inTransaction(this.db, () => {
      this.run('DELETE FROM summary_edges WHERE session_id = ?', sessionId);
      this.run('DELETE FROM summary_nodes WHERE session_id = ?', sessionId);
      this.replaceFtsSession('summary_fts', sessionId);

      // Level 0: leaf nodes over consecutive messages.
      let level = 0;
      /** @type {Array<{nodeId: string, text: string, startSeq: number, endSeq: number, messageIds: string[]}>} */
      let current = [];
      for (let index = 0; index < archived.length; index += levelSize) {
        const chunk = archived.slice(index, index + levelSize);
        const startSeq = chunk[0].seq;
        const endSeq = chunk.at(-1).seq;
        const nodeId = this.summaryNodeId(sessionId, level, startSeq, endSeq);
        const text = this.renderLeafSummary(chunk, perMessageBudget, summaryCharBudget);
        this.insertSummaryNode({ nodeId, sessionId, level, kind: 'leaf', startSeq, endSeq, messageIds: chunk.map((m) => m.message_id), text, strategy });
        nodes += 1;
        current.push({ nodeId, text, startSeq, endSeq, messageIds: chunk.map((m) => m.message_id) });
      }

      // Higher levels fold the previous level until a single root remains.
      while (current.length > 1) {
        level += 1;
        const parents = [];
        for (let index = 0; index < current.length; index += levelSize) {
          const chunk = current.slice(index, index + levelSize);
          const startSeq = chunk[0].startSeq;
          const endSeq = chunk.at(-1).endSeq;
          const nodeId = this.summaryNodeId(sessionId, level, startSeq, endSeq);
          const text = compressText(chunk.map((child) => child.text).join(' '), summaryCharBudget);
          this.insertSummaryNode({
            nodeId,
            sessionId,
            level,
            kind: 'fold',
            startSeq,
            endSeq,
            messageIds: chunk.flatMap((child) => child.messageIds),
            text,
            strategy,
          });
          nodes += 1;
          for (let position = 0; position < chunk.length; position += 1) {
            this.run(
              'INSERT INTO summary_edges (session_id, parent_id, child_id, child_position) VALUES (?, ?, ?, ?) ON CONFLICT(parent_id, child_id) DO NOTHING',
              sessionId,
              nodeId,
              chunk[position].nodeId,
              position,
            );
          }
          parents.push({ nodeId, text, startSeq, endSeq, messageIds: chunk.flatMap((child) => child.messageIds) });
        }
        if (parents.length === current.length) break; // defensive: no progress
        current = parents;
      }

      roots = current.map((node) => node.nodeId);
      const latestCreated = messages.at(-1)?.created_at ?? 0;
      this.run(
        `INSERT INTO summary_state (
           session_id, archived_count, latest_message_created, archived_signature, root_node_ids_json, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           archived_count = excluded.archived_count,
           latest_message_created = excluded.latest_message_created,
           archived_signature = excluded.archived_signature,
           root_node_ids_json = excluded.root_node_ids_json,
           updated_at = excluded.updated_at`,
        sessionId,
        archived.length,
        latestCreated,
        signature,
        JSON.stringify(roots),
        Date.now(),
      );
    });

    return { rebuilt: true, nodes, roots };
  }

  /** Deterministic node id from the session, level and covered range. */
  summaryNodeId(sessionId, level, startSeq, endSeq) {
    return `lcm-${sessionId.slice(-12)}-L${level}-${startSeq}-${endSeq}`;
  }

  renderLeafSummary(chunk, perMessageBudget, budget) {
    return compressText(
      chunk.map((message) => `[seq ${message.seq}] ${summarizeMessage({ role: message.role, content: [{ type: 'text', text: message.text }] }, perMessageBudget)}`).join(' '),
      budget,
    );
  }

  insertSummaryNode({ nodeId, sessionId, level, kind, startSeq, endSeq, messageIds, text, strategy }) {
    this.run(
      `INSERT INTO summary_nodes (
         node_id, session_id, level, node_kind, start_seq, end_seq, message_ids_json, summary_text, strategy, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(node_id) DO UPDATE SET
         summary_text = excluded.summary_text,
         message_ids_json = excluded.message_ids_json,
         created_at = excluded.created_at`,
      nodeId,
      sessionId,
      level,
      kind,
      startSeq,
      endSeq,
      JSON.stringify(messageIds),
      text,
      strategy,
      Date.now(),
    );
    if (this.ftsAvailable) {
      try {
        this.run(
          'INSERT INTO summary_fts (session_id, node_id, level, created_at, content) VALUES (?, ?, ?, ?, ?)',
          sessionId,
          nodeId,
          level,
          Date.now(),
          explodeForIndex(text),
        );
      } catch {
        this.ftsAvailable = false;
      }
    }
  }

  replaceFtsSession(table, sessionId) {
    if (!this.ftsAvailable) return;
    try {
      this.run(`DELETE FROM ${table} WHERE session_id = ?`, sessionId);
    } catch {
      this.ftsAvailable = false;
    }
  }

  /**
   * Progressively expand archived summary nodes.
   *
   * @param {object} options
   * @param {string} options.sessionId
   * @param {string} [options.nodeId]
   * @param {string} [options.query]
   * @param {number} [options.depth]
   * @param {number} [options.messageLimit]
   * @param {boolean} [options.includeRaw]
   */
  expand({ sessionId, nodeId, query, depth = 2, messageLimit = 4, includeRaw = false }) {
    if (!this.hasSession(sessionId)) return 'No archived capture for this session yet.';

    let target = nodeId ? this.get('SELECT * FROM summary_nodes WHERE node_id = ?', nodeId) : undefined;
    if (!target && nodeId) {
      // The caller's text becomes a LIKE pattern, so it must be escaped: a bare
      // `%` would otherwise match every node in the session. Two matches mean
      // the prefix is not a prefix at all, and guessing one would be wrong.
      const matches = this.all(
        "SELECT * FROM summary_nodes WHERE session_id = ? AND node_id LIKE ? ESCAPE '\\' ORDER BY node_id LIMIT 2",
        sessionId,
        `${escapeLike(nodeId)}%`,
      );
      if (matches.length > 1) return `Ambiguous node id "${nodeId}"; pass a longer id.`;
      target = matches[0];
    }

    if (!target && typeof query === 'string' && query.trim().length > 0) {
      const built = this.buildSummaries(sessionId);
      const roots = built.roots.length > 0 ? built.roots : parseJson(this.get('SELECT root_node_ids_json FROM summary_state WHERE session_id = ?', sessionId)?.root_node_ids_json, []);
      const candidates = this.gatherCandidates({ query, sessionIds: [sessionId], allowScan: true }).filter(
        (candidate) => candidate.sourceKind === 'summary',
      );
      const ranked = rankSearchCandidates(candidates, query, 1);
      target = ranked.length > 0 ? this.get('SELECT * FROM summary_nodes WHERE node_id = ?', ranked[0].id) : undefined;
      if (!target && roots.length > 0) target = this.get('SELECT * FROM summary_nodes WHERE node_id = ?', roots[0]);
    }

    if (!target) {
      const rootIds = parseJson(this.get('SELECT root_node_ids_json FROM summary_state WHERE session_id = ?', sessionId)?.root_node_ids_json, []);
      if (rootIds.length === 0) return 'No archived summary nodes for this session. Run lcm_describe or wait for capture.';
      return [
        'No summary node matched. Available roots:',
        ...rootIds.map((id) => {
          const row = this.get('SELECT node_id, level, summary_text, start_seq, end_seq FROM summary_nodes WHERE node_id = ?', id);
          return row ? `- ${row.node_id} L${row.level} seq ${row.start_seq}-${row.end_seq}: ${truncate(row.summary_text, 200)}` : `- ${id}`;
        }),
        'Pass nodeID to expand one of these.',
      ].join('\n');
    }

    const lines = [
      `node=${target.node_id}`,
      `session=${target.session_id}`,
      `level=${target.level}`,
      `kind=${target.node_kind}`,
      `seq_range=${target.start_seq}-${target.end_seq}`,
      `strategy=${target.strategy}`,
      `summary: ${target.summary_text}`,
    ];

    const children = this.all('SELECT child_id, child_position FROM summary_edges WHERE parent_id = ? ORDER BY child_position', target.node_id);
    if (children.length > 0) {
      lines.push(`children=${children.length}`);
      if (depth > 1) {
        for (const child of children.slice(0, 12)) {
          const row = this.get('SELECT node_id, level, summary_text, start_seq, end_seq FROM summary_nodes WHERE node_id = ?', child.child_id);
          if (!row) continue;
          lines.push(`  child L${row.level} seq ${row.start_seq}-${row.end_seq} ${row.node_id}: ${truncate(row.summary_text, 220)}`);
        }
        if (children.length > 12) lines.push(`  …${children.length - 12} more children omitted`);
      }
    }

    if (includeRaw) {
      const messageIds = parseJson(target.message_ids_json, []).slice(0, Math.max(1, messageLimit));
      lines.push(`raw_messages=${messageIds.length}${messageIds.length < parseJson(target.message_ids_json, []).length ? ` of ${parseJson(target.message_ids_json, []).length}` : ''}`);
      for (const id of messageIds) {
        const row = this.get('SELECT message_id, seq, role, created_at, text, info_json, deleted_at FROM messages WHERE message_id = ?', id);
        if (!row) {
          lines.push(`  [pruned: ${id}]`);
          continue;
        }
        const prefix = row.deleted_at ? '[removed] ' : '';
        lines.push(`  ${prefix}[seq ${row.seq}] ${row.role}: ${truncate(collapseWhitespace(row.text), 700)}`);
      }
    } else {
      lines.push('raw_messages=omitted (pass includeRaw=true when progressive summaries are insufficient)');
    }

    return lines.join('\n');
  }

  // ----------------------------------------------------------------- artifacts

  /**
   * Read one externalized artifact by id (or unique id prefix) inside one session.
   *
   * The body comes from the content-addressed blob, not from the `artifacts` row:
   * that join is the whole point of the single-copy layout. A body that is
   * genuinely gone reports as such rather than as an empty success.
   */
  artifact({ artifactId, sessionId, chars }) {
    const select = `SELECT a.*, b.content_text AS blob_text
                      FROM artifacts a
                      LEFT JOIN artifact_blobs b ON b.content_hash = a.content_hash`;
    let row = this.get(`${select} WHERE a.artifact_id = ?`, artifactId);
    if (!row) {
      // `artifactId` is caller text, so escape it before it becomes a LIKE
      // pattern: a bare `%` would otherwise match every artifact. The prefix is
      // resolved inside this session only, so a prefix shared with another
      // project's archive can never be answered from here.
      const pattern = `${escapeLike(artifactId)}%`;
      const matches =
        this.get("SELECT COUNT(*) AS n FROM artifacts WHERE session_id = ? AND artifact_id LIKE ? ESCAPE '\\'", sessionId, pattern)?.n ?? 0;
      if (matches > 1) return `Ambiguous artifact id "${artifactId}" matches ${matches} artifacts; pass a longer id.`;
      row = this.get(
        `${select} WHERE a.session_id = ? AND a.artifact_id LIKE ? ESCAPE '\\' LIMIT 1`,
        sessionId,
        pattern,
      );
    }
    if (!row) return `No artifact matched "${artifactId}".`;
    const limit = Math.min(Math.max(chars ?? this.config.artifactViewChars, 200), 20_000);
    const body = truncate(row.blob_text ?? '', limit);
    return [
      `artifact=${row.artifact_id}`,
      `session=${row.session_id}`,
      `message=${row.message_id}`,
      `kind=${row.artifact_kind}`,
      `field=${row.field_name}`,
      `chars=${row.char_count}`,
      `hash=${shortNodeId(row.content_hash ?? '')}`,
      row.blob_text === null || row.blob_text === undefined
        ? '--- body unavailable (the blob for this hash is gone) ---'
        : body.length < row.blob_text.length
          ? `--- first ${body.length} of ${row.char_count} chars ---`
          : '--- full content ---',
      body,
    ].join('\n');
  }

  // -------------------------------------------------------------------- resume

  /** Set or replace the durable resume note for one session. */
  setResume(sessionId, note) {
    this.run(
      `INSERT INTO resumes (session_id, note, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`,
      sessionId,
      note,
      Date.now(),
    );
  }

  /** Durable resume note, falling back to a derived one. */
  resume(sessionId) {
    const stored = this.get('SELECT note, updated_at FROM resumes WHERE session_id = ?', sessionId);
    if (stored) {
      return `session=${sessionId}\nupdated_at=${new Date(stored.updated_at).toISOString()}\nnote=${stored.note}`;
    }
    const derived = this.deriveResumeNote(sessionId);
    return derived ?? 'No archived resume note for this session.';
  }

  /**
   * Build the compact resume note appended after compaction.
   *
   * Upstream injects this into the compaction input. The Harness owns
   * compaction, so this note is delivered through automatic recall instead: it
   * is emitted for the first turn after a compaction, which preserves the
   * upstream outcome (important context survives the shrink) without replacing
   * the compaction backend.
   */
  deriveResumeNote(sessionId) {
    const row = this.sessionRow(sessionId);
    if (!row) return undefined;
    const latest = this.get(
      'SELECT role, text, created_at FROM messages WHERE session_id = ? AND deleted_at IS NULL ORDER BY seq DESC LIMIT 1',
      sessionId,
    );
    const state = this.get('SELECT * FROM summary_state WHERE session_id = ?', sessionId);
    const roots = parseJson(state?.root_node_ids_json, []).slice(0, 3);
    const pinned = this.get('SELECT COUNT(*) AS n FROM sessions WHERE pinned = 1 AND root_session_id = ?', row.root_session_id)?.n ?? 0;
    const lines = [
      '[lcm: LCM prototype resume note]',
      `session=${sessionId} root=${row.root_session_id} depth=${row.lineage_depth}`,
      `archived_messages=${state?.archived_count ?? 0}`,
      `summary_roots=${roots.length}`,
      ...roots.map((id) => {
        const node = this.get('SELECT level, start_seq, end_seq, summary_text FROM summary_nodes WHERE node_id = ?', id);
        return node ? `  root L${node.level} seq ${node.start_seq}-${node.end_seq}: ${truncate(node.summary_text, 240)}` : `  ${id}`;
      }),
      pinned > 0 ? `pinned_sessions_in_root=${pinned}` : undefined,
      latest ? `latest_archived=${latest.role} at ${new Date(latest.created_at).toISOString()}: ${truncate(collapseWhitespace(latest.text), 240)}` : undefined,
      'Recall archived detail with lcm_grep, lcm_expand, lcm_artifact or lcm_resume.',
    ].filter(Boolean);
    return lines.join('\n');
  }

  /** Whether this session was compacted since the given epoch millisecond. */
  compactedSince(sessionId, since) {
    const row = this.sessionRow(sessionId);
    return Boolean(row?.compacted_at && row.compacted_at > (since ?? 0));
  }

  // ------------------------------------------------------- compaction pointer

  /**
   * The newest compaction that removed history from this session's prompt.
   *
   * DSH's compaction backend records the exact span it shadowed on
   * `compaction/summary`, so "what did compaction take away, and how do I get it
   * back" is a deterministic lookup instead of a similarity search. This is the
   * inverse of the capture path, which stores that payload verbatim under
   * `events`.
   *
   * Only `compaction/summary` is a source: live archives show `compaction/end`
   * storing NULL for the span fields, so treating it as a fallback could only
   * produce an unusable pointer. A session whose only compaction rows are
   * `start`/`end` has no recoverable span and answers `undefined`.
   *
   * @param {string} sessionId
   * @returns {{summarySeq: number, startSeq: number, endSeq: number, count: number,
   *   tokens: number|undefined, entryNodes: string[]}|undefined} a frozen pointer
   */
  latestCompaction(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
    try {
      const row = this.get(
        "SELECT seq, payload_json FROM events WHERE session_id = ? AND event_type = 'compaction/summary' ORDER BY seq DESC LIMIT 1",
        sessionId,
      );
      if (!row) return undefined;

      // Every field is untrusted here: another Harness version may omit any of
      // them, and a NULL must never be read as seq 0. A malformed row degrades to
      // "no pointer" rather than to a bogus one.
      const payload = parseJson(row.payload_json, undefined);
      const range = payload?.shadowedRange;
      const startSeq = Number.isFinite(range?.start) ? range.start : undefined;
      const endSeq = Number.isFinite(range?.end) ? range.end : undefined;
      if (startSeq === undefined || endSeq === undefined || endSeq < startSeq) return undefined;

      // `shadowedSeqs` is the authoritative removal list; without it the count
      // the pointer promises cannot be derived, so there is no pointer to give.
      const shadowedSeqs = Array.isArray(payload?.shadowedSeqs) ? payload.shadowedSeqs : [];
      if (shadowedSeqs.length === 0) return undefined;

      return deepFreeze({
        summarySeq: Number.isFinite(row.seq) ? row.seq : -1,
        startSeq,
        endSeq,
        count: shadowedSeqs.length,
        tokens: Number.isFinite(payload?.shadowedTokenCount) ? payload.shadowedTokenCount : undefined,
        entryNodes: this.containedSummaryNodes(sessionId, startSeq, endSeq),
      });
    } catch (error) {
      this.logger?.warn?.(`[lcm] compaction lookup failed: ${error?.message ?? error}`);
      return undefined;
    }
  }

  /**
   * Summary nodes fully contained in a seq span, as entry points.
   *
   * The tree spans the whole session, so the node *covering* a compacted span is
   * always the session-wide root -- useless as an entry point. The recoverable
   * ones sit entirely inside the span: expanding one walks its own levels down to
   * raw text.
   *
   * @returns {string[]} at most two node ids, coarsest first
   */
  containedSummaryNodes(sessionId, startSeq, endSeq) {
    if (!Number.isFinite(startSeq) || !Number.isFinite(endSeq) || endSeq < startSeq) return [];
    try {
      return this.all(
        `SELECT node_id FROM summary_nodes
          WHERE session_id = ? AND start_seq >= ? AND end_seq <= ?
          ORDER BY level DESC, (end_seq - start_seq) DESC
          LIMIT 2`,
        sessionId,
        startSeq,
        endSeq,
      ).map((entry) => entry.node_id);
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------------- pins

  pinSession({ sessionId, reason }) {
    if (!this.hasSession(sessionId)) return 'No archived capture for this session yet.';
    this.run('UPDATE sessions SET pinned = 1, pin_reason = ? WHERE session_id = ?', reason ?? null, sessionId);
    return `Pinned session=${sessionId}${reason ? ` reason=${reason}` : ''}`;
  }

  unpinSession({ sessionId }) {
    this.run('UPDATE sessions SET pinned = 0, pin_reason = NULL WHERE session_id = ?', sessionId);
    return `Unpinned session=${sessionId}`;
  }

  // ------------------------------------------------------- automatic retrieval

  /**
   * Select and render archived context for the current turn.
   *
   * @param {object} options
   * @param {string} options.sessionId
   * @param {string} options.query anchor text (the pending user message)
   * @param {Set<string>} [options.freshMessageIds] messages already verbatim in context
   * @param {boolean} [options.includeResume]
   * @returns {{text: string, hits: Array<object>, telemetry: object}|undefined}
   */
  automaticRetrieval({ sessionId, query, freshMessageIds, includeResume = false }) {
    const settings = this.config.automaticRetrieval;
    if (!settings.enabled) return undefined;
    const trimmed = collapseWhitespace(query);
    if (trimmed.length === 0) return undefined;
    if (!this.hasSession(sessionId)) return undefined;

    const tokens = tokenizeQuery(trimmed);
    if (tokens.length < Math.max(1, settings.minTokens)) return undefined;

    // Spend the retrieval budget on terms the archive actually contains, most
    // discriminating first. Terms absent from the corpus are dropped: they could
    // only ever match nothing.
    // A term the index cannot represent (a single Han character) is not "absent"
    // just because the index has no row for it: it is reachable by substring, so
    // its frequency is counted the same way the scan would count it.
    const unindexable = new Set(unindexableRuns(trimmed));
    const informative = filterTokensByTfidf(
      {
        documentFrequency: (token) =>
          unindexable.has(token)
            ? this.get("SELECT COUNT(*) AS n FROM messages WHERE deleted_at IS NULL AND text LIKE ? ESCAPE '\\'", `%${escapeLike(token)}%`)?.n ?? 0
            : this.documentFrequency(token),
        totalDocuments: this.messageCount(),
        cache: this.docFreqCache,
      },
      tokens,
      10,
    );
    const searchQuery = informative.length > 0 ? informative.map((entry) => entry.token).join(' ') : trimmed;

    const telemetry = { sessionId, queries: [searchQuery], rawResults: 0, stopReason: 'none', scopeStats: [], at: Date.now() };
    const selected = [];
    const quotas = {
      message: settings.maxMessageHits,
      summary: settings.maxSummaryHits,
      artifact: settings.maxArtifactHits,
    };
    const fresh = freshMessageIds ?? new Set();
    const minSnippetMatches = tokens.length >= 2 ? 2 : 1;

    for (const scope of settings.scopeOrder) {
      const budget = settings.scopeBudgets[scope] ?? 0;
      if (budget <= 0) {
        telemetry.scopeStats.push({ scope, budget, rawResults: 0, selectedHits: 0 });
        continue;
      }
      const sessionIds = this.resolveScope(scope, sessionId);
      // Ask the index first and fall back to a bounded substring scan only when it
      // could not answer at all: a term shorter than its script index gram (a
      // two-character Latin fragment, for instance) lands in the second pass.
      let candidates = this.gatherCandidates({ query: searchQuery, sessionIds, allowScan: false });
      if (candidates.length === 0) {
        candidates = this.gatherCandidates({ query: trimmed, sessionIds, allowScan: true });
      }
      telemetry.rawResults += candidates.length;
      const ranked = rankSearchCandidates(candidates, searchQuery, budget);
      let scopeHits = 0;

      for (const result of ranked) {
        const kind = result.type === 'summary' ? 'summary' : result.type.startsWith('artifact:') ? 'artifact' : 'message';
        if (quotas[kind] <= 0) continue;
        if (kind === 'message' && fresh.has(result.id)) continue;
        const lower = (result.snippet ?? '').toLowerCase();
        const matched = tokens.filter((token) => lower.includes(token)).length;
        if (tokens.length > 1 && matched < minSnippetMatches) continue;
        selected.push({
          kind,
          id: result.id,
          label: result.type,
          sessionID: result.sessionID,
          snippet: result.snippet,
          score: result.score,
        });
        quotas[kind] -= 1;
        scopeHits += 1;
        if (selected.length >= settings.stop.targetHits) break;
      }

      telemetry.scopeStats.push({ scope, budget, rawResults: candidates.length, selectedHits: scopeHits });
      if (scopeHits > 0 && settings.stop.stopOnFirstScopeWithHits) {
        telemetry.stopReason = 'first_scope_with_hits';
        break;
      }
      if (selected.length >= settings.stop.targetHits) {
        telemetry.stopReason = 'target_hits';
        break;
      }
      if (quotas.message <= 0 && quotas.summary <= 0 && quotas.artifact <= 0) {
        telemetry.stopReason = 'quotas_exhausted';
        break;
      }
    }

    const sections = [];
    if (selected.length > 0) {
      const scopeLabel = telemetry.scopeStats.filter((entry) => entry.selectedHits > 0).map((entry) => entry.scope).join(' -> ') || settings.scopeOrder[0];
      const lines = [
        `[Archived by dsh-lcm: recalled ${selected.length} archived ${pluralize(selected.length, 'hit')} for this turn (scope=${scopeLabel}).]`,
        `Archived hits: ${selected
          .map((hit) => {
            const session = hit.sessionID ? ` session=${hit.sessionID}` : '';
            const id = hit.kind === 'summary' ? shortNodeId(hit.id) : hit.id;
            const label = hit.label !== hit.kind ? ` (${hit.label})` : '';
            return `${hit.kind}${session} id=${id}${label}: ${truncate(hit.snippet, 180)}`;
          })
          .join(' | ')}`,
      ];
      sections.push(lines.join('\n'));
    }

    if (includeResume) {
      const note = this.deriveResumeNote(sessionId);
      if (note) sections.push(note);
    }

    if (sections.length === 0) {
      this.retrievalDebug.set(sessionId, telemetry);
      return undefined;
    }

    const text = truncate(sections.join('\n'), settings.maxChars);
    this.retrievalDebug.set(sessionId, telemetry);
    // Bound the telemetry map so a long-lived host cannot leak per-session state.
    if (this.retrievalDebug.size > 512) {
      const oldest = this.retrievalDebug.keys().next().value;
      this.retrievalDebug.delete(oldest);
    }
    return { text, hits: selected, telemetry };
  }

  /** Latest automatic-retrieval diagnostics for one session. */
  retrievalDebugFor(sessionId) {
    const telemetry = this.retrievalDebug.get(sessionId);
    if (!telemetry) return 'No automatic retrieval has run for this session yet.';
    return [
      `session=${telemetry.sessionId}`,
      `at=${new Date(telemetry.at).toISOString()}`,
      `queries=${telemetry.queries.join(' | ')}`,
      `raw_results=${telemetry.rawResults}`,
      `stop_reason=${telemetry.stopReason}`,
      `automatic_retrieval_enabled=${this.config.automaticRetrieval.enabled}`,
      ...telemetry.scopeStats.map(
        (entry) => `scope=${entry.scope} budget=${entry.budget} raw=${entry.rawResults} selected=${entry.selectedHits}`,
      ),
    ].join('\n');
  }

  /** The most recent user-authored message text, used as the recall anchor. */
  latestUserText(sessionId) {
    const row = this.get(
      "SELECT text FROM messages WHERE session_id = ? AND role = 'user' AND deleted_at IS NULL ORDER BY seq DESC LIMIT 1",
      sessionId,
    );
    return row?.text ?? '';
  }

  /** Raw message rows for the newest N messages (used to detect the fresh tail). */
  recentMessageIds(sessionId, limit) {
    return this.all(
      'SELECT message_id FROM messages WHERE session_id = ? AND deleted_at IS NULL ORDER BY seq DESC LIMIT ?',
      sessionId,
      Math.max(0, limit),
    ).map((row) => row.message_id);
  }

  // --------------------------------------------------------------------- stats

  stats() {
    const count = (sql, ...params) => this.get(sql, ...params)?.n ?? 0;
    const bytesOf = (file) => {
      try {
        return existsSync(file) ? statSync(file).size : 0;
      } catch {
        return 0;
      }
    };
    const dbBytes = bytesOf(this.dbPath);
    const walBytes = bytesOf(`${this.dbPath}-wal`);
    const shmBytes = bytesOf(`${this.dbPath}-shm`);
    const byType = this.all('SELECT event_type, COUNT(*) AS n FROM events GROUP BY event_type ORDER BY n DESC LIMIT 10');

    return {
      schemaVersion: Number(this.get("SELECT value FROM meta WHERE key = 'schema_version'")?.value ?? SCHEMA_VERSION),
      dbPath: this.dbPath,
      ftsAvailable: this.ftsAvailable,
      totalEvents: count('SELECT COUNT(*) AS n FROM events'),
      prunableEventCount: count("SELECT COUNT(*) AS n FROM events WHERE event_type IN ('turn/start','turn/end')"),
      sessionCount: count('SELECT COUNT(*) AS n FROM sessions'),
      rootSessionCount: count('SELECT COUNT(*) AS n FROM sessions WHERE parent_session_id IS NULL'),
      branchedSessionCount: count('SELECT COUNT(*) AS n FROM sessions WHERE parent_session_id IS NOT NULL'),
      pinnedSessionCount: count('SELECT COUNT(*) AS n FROM sessions WHERE pinned = 1'),
      worktreeCount: count('SELECT COUNT(DISTINCT worktree_key) AS n FROM sessions WHERE worktree_key IS NOT NULL'),
      messageCount: count('SELECT COUNT(*) AS n FROM messages'),
      deletedMessageCount: count('SELECT COUNT(*) AS n FROM messages WHERE deleted_at IS NOT NULL'),
      artifactCount: count('SELECT COUNT(*) AS n FROM artifacts'),
      // The body is only ever in the blob now, so this must stay 0 on an archive
      // written by this version; it is the measurement for "stored three times".
      artifactInlineBodyChars: count('SELECT COALESCE(SUM(LENGTH(content_text)), 0) AS n FROM artifacts'),
      artifactBlobCount: count('SELECT COUNT(*) AS n FROM artifact_blobs'),
      sharedArtifactBlobCount: count(
        'SELECT COUNT(*) AS n FROM artifact_blobs b WHERE (SELECT COUNT(*) FROM artifacts a WHERE a.content_hash = b.content_hash) > 1',
      ),
      orphanArtifactBlobCount: count(
        'SELECT COUNT(*) AS n FROM artifact_blobs b WHERE NOT EXISTS (SELECT 1 FROM artifacts a WHERE a.content_hash = b.content_hash)',
      ),
      summaryNodeCount: count('SELECT COUNT(*) AS n FROM summary_nodes'),
      summaryStateCount: count('SELECT COUNT(*) AS n FROM summary_state'),
      resumeCount: count('SELECT COUNT(*) AS n FROM resumes'),
      dbBytes,
      walBytes,
      shmBytes,
      totalBytes: dbBytes + walBytes + shmBytes,
      byType,
      counters: { ...this.counters },
      bytesLabel: formatBytes(dbBytes + walBytes + shmBytes),
    };
  }

  // -------------------------------------------------------------- maintenance

  blobStats(options) {
    return blobStats(this, options);
  }

  gcBlobs(options) {
    return gcBlobs(this, options);
  }

  compact(options) {
    return compactDatabase(this, options);
  }

  runDoctor(options) {
    return doctor(this, options);
  }

  retentionReport(options) {
    return retentionReport(this, options);
  }

  retentionPrune(options) {
    return retentionPrune(this, options);
  }

  exportSnapshot(options) {
    return exportSnapshot(this, options);
  }

  importSnapshot(options) {
    return importSnapshot(this, options);
  }
}

export { nz, int, worktreeKeyOf, randomUUID, mkdirSync, dirname, readFileSync, writeFileSync, parseJson };
