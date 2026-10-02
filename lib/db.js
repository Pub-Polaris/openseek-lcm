/**
 * Archive database: connection handling and schema.
 *
 * The store is a single SQLite file owned by this plugin, opened through
 * `node:sqlite` (the same engine the Harness itself uses for session search, so
 * no extra native dependency is introduced). The table layout follows
 * `opencode-lcm`'s `.lcm/lcm.db`, adapted to Harness vocabulary:
 *
 *   - the Harness identity of a message is its brand `id`, and its log position
 *     is `seq`; ordering and ranges therefore use `seq` instead of a wall clock.
 *   - a message carries `content: ContentBlock[]` inline, so the upstream
 *     `messages` + `parts` split collapses into one row plus `artifacts` for
 *     oversized blocks.
 *
 * Search does not depend on a tokenizer's script handling. `text.js` explodes every
 * run into ordered n-grams (bigrams for CJK, trigrams for Latin) and the FTS5 tables
 * index that exploded text with `unicode61`, so "does this substring occur?" becomes
 * "does this gram sequence occur adjacently?". That is what makes a two-character
 * Chinese word searchable, which neither `unicode61` alone (one token per Han run)
 * nor `trigram` (no two-character tokens at all) can do.
 *
 * `tokenchars '_'` keeps underscores inside tokens: identifiers such as `store_path`
 * explode into grams that contain `_`, and the default tokenizer would split them and
 * break the phrase adjacency the index relies on.
 *
 * Candidates found by FTS are always re-ranked in JavaScript (see `ranking.js`), so
 * the tokenizer choice does not leak into the ordering the model sees.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 3;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id        TEXT PRIMARY KEY,
  title             TEXT,
  cwd               TEXT,
  worktree_key      TEXT,
  parent_session_id TEXT,
  root_session_id   TEXT,
  lineage_depth     INTEGER NOT NULL DEFAULT 0,
  pinned            INTEGER NOT NULL DEFAULT 0,
  pin_reason        TEXT,
  created_at        INTEGER NOT NULL DEFAULT 0,
  updated_at        INTEGER NOT NULL DEFAULT 0,
  compacted_at      INTEGER,
  deleted           INTEGER NOT NULL DEFAULT 0,
  event_count       INTEGER NOT NULL DEFAULT 0,
  watermark_seq     INTEGER NOT NULL DEFAULT -1
);
CREATE INDEX IF NOT EXISTS idx_sessions_root ON sessions(root_session_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_worktree ON sessions(worktree_key, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  role       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  info_json  TEXT NOT NULL,
  text       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at, message_id);

CREATE TABLE IF NOT EXISTS artifacts (
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
CREATE INDEX IF NOT EXISTS idx_artifacts_session_message ON artifacts(session_id, message_id, block_index);
CREATE INDEX IF NOT EXISTS idx_artifacts_content_hash ON artifacts(content_hash);

CREATE TABLE IF NOT EXISTS artifact_blobs (
  content_hash TEXT PRIMARY KEY,
  content_text TEXT NOT NULL,
  char_count   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  orphaned_at  INTEGER
);

CREATE TABLE IF NOT EXISTS summary_nodes (
  node_id      TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  level        INTEGER NOT NULL,
  node_kind    TEXT NOT NULL,
  start_seq    INTEGER NOT NULL,
  end_seq      INTEGER NOT NULL,
  message_ids_json TEXT NOT NULL,
  summary_text TEXT NOT NULL,
  strategy     TEXT NOT NULL DEFAULT 'deterministic-v3',
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_summary_nodes_session_level ON summary_nodes(session_id, level);

CREATE TABLE IF NOT EXISTS summary_edges (
  session_id     TEXT NOT NULL,
  parent_id      TEXT NOT NULL,
  child_id       TEXT NOT NULL,
  child_position INTEGER NOT NULL,
  PRIMARY KEY (parent_id, child_id)
);
CREATE INDEX IF NOT EXISTS idx_summary_edges_session_parent ON summary_edges(session_id, parent_id, child_position);

CREATE TABLE IF NOT EXISTS summary_state (
  session_id             TEXT PRIMARY KEY,
  archived_count         INTEGER NOT NULL DEFAULT 0,
  latest_message_created INTEGER NOT NULL DEFAULT 0,
  archived_signature     TEXT NOT NULL DEFAULT '',
  root_node_ids_json     TEXT NOT NULL DEFAULT '[]',
  updated_at             INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS resumes (
  session_id TEXT PRIMARY KEY,
  note       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  seq          INTEGER NOT NULL DEFAULT -1,
  ts           INTEGER NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_session_ts ON events(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);

CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
  session_id UNINDEXED,
  message_id UNINDEXED,
  role UNINDEXED,
  created_at UNINDEXED,
  content,
  tokenize = "unicode61 tokenchars '_'"
);

CREATE VIRTUAL TABLE IF NOT EXISTS summary_fts USING fts5(
  session_id UNINDEXED,
  node_id UNINDEXED,
  level UNINDEXED,
  created_at UNINDEXED,
  content,
  tokenize = "unicode61 tokenchars '_'"
);

CREATE VIRTUAL TABLE IF NOT EXISTS artifact_fts USING fts5(
  session_id UNINDEXED,
  artifact_id UNINDEXED,
  message_id UNINDEXED,
  artifact_kind UNINDEXED,
  created_at UNINDEXED,
  content,
  tokenize = "unicode61 tokenchars '_'"
);
`;

/**
 * Open (creating when absent) the archive database and apply the schema.
 *
 * @param {string} dbPath absolute path of the database file
 * @returns {{db: import('node:sqlite').DatabaseSync, upgraded: boolean}} the open
 *   database, and whether an older schema was migrated (the caller must then rebuild
 *   the derived search tables)
 */
/** The derived full-text tables, in the order the caller repopulates them. */
export const FTS_TABLES = ['message_fts', 'summary_fts', 'artifact_fts'];

/** Recorded schema version, or 0 when the archive has no meta table yet. */
function readSchemaVersion(db) {
  try {
    return Number(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value ?? 0);
  } catch {
    return 0;
  }
}

export function openArchive(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA temp_store = MEMORY');
  // The full-text tables are derived, and their tokenizer is part of the schema, so
  // an older archive drops them before CREATE rebuilds them; the caller repopulates.
  const recorded = readSchemaVersion(db);
  const upgraded = Number.isFinite(recorded) && recorded > 0 && recorded !== SCHEMA_VERSION;
  if (upgraded) {
    for (const table of FTS_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
  }

  db.exec(SCHEMA_SQL);
  const rows = db.prepare('SELECT key, value FROM meta').all();
  const meta = new Map(rows.map((row) => [row.key, row.value]));
  if (Number(meta.get('schema_version') ?? 0) !== SCHEMA_VERSION) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
      'schema_version',
      String(SCHEMA_VERSION),
    );
  }
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    'created_at',
    meta.get('created_at') ?? String(Date.now()),
  );
  return { db, upgraded };
}

/**
 * Run a function inside a transaction, rolling back on a throw.
 *
 * `node:sqlite` has no transaction helper, and nesting `BEGIN` throws, so the
 * caller must not already be inside one.
 *
 * @template T
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {() => T} work
 * @returns {T}
 */
export function inTransaction(db, work) {
  db.exec('BEGIN');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // A failed rollback must not mask the original failure.
    }
    throw error;
  }
}

/** Convert a `node:sqlite` row into a plain object. */
export function plain(row) {
  return row === undefined || row === null ? undefined : { ...row };
}

/** Convert rows into plain objects. */
export function plainAll(rows) {
  return (rows ?? []).map((row) => ({ ...row }));
}

/** Parse a JSON column defensively. */
export function parseJson(text, fallback) {
  if (typeof text !== 'string' || text.length === 0) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}
