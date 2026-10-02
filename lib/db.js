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

/**
 * Archive format version.
 *
 * 3 -> 4: artifact content moved out of `artifacts.content_text` into the
 * content-addressed `artifact_blobs` row, and `artifact_fts` indexes
 * `preview_text` instead of the whole body. `LcmStore.init` migrates the stored
 * bodies into blobs before rebuilding the index.
 */
export const SCHEMA_VERSION = 4;

/**
 * The `artifacts` column list, shared by the initial schema and the schema-3
 * table rebuild.
 *
 * `content_text` is nullable here because from schema 4 the body lives in the
 * content-addressed `artifact_blobs` row. A schema-3 archive declared the same
 * column `NOT NULL`, and `CREATE TABLE IF NOT EXISTS` cannot relax a constraint
 * on a table that already exists -- `rebuildArtifactsTableIfNeeded` exists for
 * exactly that archive.
 */
export const ARTIFACTS_COLUMNS_SQL = `(
  artifact_id   TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  message_id    TEXT NOT NULL,
  block_index   INTEGER NOT NULL DEFAULT 0,
  artifact_kind TEXT NOT NULL,
  field_name    TEXT NOT NULL,
  preview_text  TEXT NOT NULL,
  -- Legacy column. The body lives in artifact_blobs, keyed by content_hash, from
  -- schema 4 on: storing it here as well made one payload occupy three places
  -- (this column, the blob, and the FTS n-grams). Kept nullable so an archive
  -- written by an older plugin still opens; LcmStore migrates it.
  content_text  TEXT,
  content_hash  TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  char_count    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
)`;

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

CREATE TABLE IF NOT EXISTS artifacts ${ARTIFACTS_COLUMNS_SQL};
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
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA temp_store = MEMORY');
    const recorded = readSchemaVersion(db);
    // A newer archive belongs to a newer plugin. Downgrading it silently drops
    // and rewrites the derived tables before the older code has any idea what
    // the new columns mean, so refuse while the archive is still intact.
    if (Number.isFinite(recorded) && recorded > SCHEMA_VERSION) {
      throw new Error(
        `Archive schema ${recorded} is newer than this plugin supports (${SCHEMA_VERSION}); upgrade dsh-lcm instead of opening it here.`,
      );
    }
    // The full-text tables are derived, and their tokenizer is part of the schema, so
    // an older archive drops them before CREATE rebuilds them; the caller repopulates.
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
  } catch (error) {
    // The host keeps running with `storeError` set, so a half-open archive must
    // not leave its handle -- and the WAL/SHM locks that come with it -- alive.
    try {
      db.close();
    } catch {
      // Closing a handle that never opened cleanly must not mask the cause.
    }
    throw error;
  }
}

/**
 * Whether `artifacts.content_text` is still declared `NOT NULL` (the schema-3
 * shape). `LcmStore` uses this as a migration trigger, because a table that
 * cannot store a NULL body can never satisfy the schema-4 layout, even when it
 * happens to hold no inline body at all -- the next `insertArtifact` would write
 * NULL into it and fail.
 */
export function artifactsContentTextIsNotNull(db) {
  const columns = plainAll(db.prepare('PRAGMA table_info(artifacts)').all());
  const contentText = columns.find((column) => column.name === 'content_text');
  return contentText !== undefined && Number(contentText.notnull) === 1;
}

/**
 * Rebuild `artifacts` with the schema-4 column shape when it is still schema 3.
 *
 * SQLite cannot drop a `NOT NULL` constraint: `ALTER TABLE` has no such form, and
 * `CREATE TABLE IF NOT EXISTS` leaves an existing table alone. So the only way to
 * make `content_text` nullable on a legacy archive is to create the new table,
 * copy every row into it, drop the old one and rename -- recreating the indexes
 * the old table carried. Without this, the `UPDATE artifacts SET content_text =
 * NULL` that moves bodies into `artifact_blobs` throws "NOT NULL constraint
 * failed", the migration's transaction rolls back, and *zero* of the archive's
 * bodies ever move.
 *
 * The caller must already be inside a transaction: the shape change and the row
 * copy have to commit or roll back as one, and a copied-then-crashed run must
 * leave the archive readable rather than half-rebuilt.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {boolean} whether the table was rebuilt
 */
export function rebuildArtifactsTableIfNeeded(db) {
  if (!artifactsContentTextIsNotNull(db)) return false;

  // Read before the drop: dropping a table drops its indexes, and this archive's
  // `content_hash` lookups need `idx_artifacts_content_hash` back. `sql` is NULL
  // for the implicit PRIMARY KEY index, which the new table's own DDL recreates.
  const indexes = plainAll(
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'artifacts' AND sql IS NOT NULL").all(),
  ).map((row) => row.sql);

  // The copy is by name, not by position, and only over the columns both shapes
  // have: a legacy archive that carries an extra column still rebuilds into the
  // columns the current schema declares instead of failing on the unknown name.
  const legacyColumns = plainAll(db.prepare('PRAGMA table_info(artifacts)').all()).map((column) => column.name);
  db.exec(`CREATE TABLE artifacts_rebuild ${ARTIFACTS_COLUMNS_SQL}`);
  const rebuiltColumns = new Set(plainAll(db.prepare('PRAGMA table_info(artifacts_rebuild)').all()).map((column) => column.name));
  const columns = legacyColumns.filter((name) => rebuiltColumns.has(name)).join(', ');
  db.exec(`INSERT INTO artifacts_rebuild (${columns}) SELECT ${columns} FROM artifacts`);
  db.exec('DROP TABLE artifacts');
  db.exec('ALTER TABLE artifacts_rebuild RENAME TO artifacts');
  for (const sql of indexes) db.exec(sql);
  return true;
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
