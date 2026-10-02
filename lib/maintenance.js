/**
 * Archive maintenance: blob garbage collection, database compaction, integrity
 * repair, retention, and portable snapshots.
 *
 * Every function takes the `LcmStore` instance so it can reuse the store's
 * cached statements, and every mutating operation is preview-first: it reports
 * what it *would* do unless the caller passes `apply: true`. That mirrors
 * `opencode-lcm`, where `lcm_blob_gc`, `lcm_compact`, `lcm_retention_prune` and
 * `lcm_doctor` are all dry-run by default.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { inTransaction, parseJson } from './db.js';
import { formatBytes, truncate } from './text.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Deduplicated artifact-blob inventory, largest first. */
export function blobStats(store, options = {}) {
  const limit = clamp(options.limit ?? 10, 1, 20);
  const totals =
    store.get(
      `SELECT COUNT(*) AS blobs,
              COALESCE(SUM(char_count), 0) AS chars,
              COALESCE(SUM(CASE WHEN orphaned_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS orphans
         FROM artifact_blobs`,
    ) ?? {};
  const referenced =
    store.get(
      `SELECT COUNT(DISTINCT content_hash) AS n FROM artifacts WHERE content_hash IS NOT NULL`,
    )?.n ?? 0;

  const rows = store.all(
    `SELECT b.content_hash,
            b.char_count,
            b.created_at,
            b.orphaned_at,
            (SELECT COUNT(*) FROM artifacts a WHERE a.content_hash = b.content_hash) AS refs
       FROM artifact_blobs b
       ORDER BY b.char_count DESC
       LIMIT ?`,
    limit,
  );

  return [
    `blobs=${totals.blobs ?? 0}`,
    `blob_chars=${totals.chars ?? 0}`,
    `referenced_hashes=${referenced}`,
    `orphan_blobs=${totals.orphans ?? 0}`,
    `artifact_rows=${store.get('SELECT COUNT(*) AS n FROM artifacts')?.n ?? 0}`,
    ...rows.map(
      (row) =>
        `blob hash=${String(row.content_hash).slice(0, 12)} chars=${row.char_count} refs=${row.refs} created=${new Date(row.created_at).toISOString()} orphaned=${row.orphaned_at ? new Date(row.orphaned_at).toISOString() : 'no'}`,
    ),
  ].join('\n');
}

/**
 * Delete artifact blobs no artifact references.
 *
 * A blob first becomes an orphan (marked with `orphaned_at`) and is only
 * deleted after the configured grace period, so a transient capture failure
 * cannot destroy content that a later repair would have re-referenced.
 */
export function gcBlobs(store, options = {}) {
  const apply = options.apply === true;
  const limit = clamp(options.limit ?? 20, 1, 50);

  const orphans = store.all(
    `SELECT b.content_hash, b.char_count, b.orphaned_at
       FROM artifact_blobs b
      WHERE NOT EXISTS (SELECT 1 FROM artifacts a WHERE a.content_hash = b.content_hash)
      ORDER BY b.char_count DESC
      LIMIT ?`,
    limit,
  );

  if (orphans.length === 0) return 'No orphaned artifact blobs.';

  const lines = [
    `${apply ? 'Deleted' : 'Previewing'} ${orphans.length} orphaned ${orphans.length === 1 ? 'blob' : 'blobs'}:`,
    ...orphans.map((row) => `- hash=${String(row.content_hash).slice(0, 12)} chars=${row.char_count}`),
  ];

  if (apply) {
    inTransaction(store.db, () => {
      for (const row of orphans) {
        store.run('DELETE FROM artifact_blobs WHERE content_hash = ?', row.content_hash);
      }
    });
    lines.push('Reclaim with lcm_compact to shrink the database file.');
  } else {
    lines.push('Pass apply=true to delete.');
  }
  return lines.join('\n');
}

/** Prune internal events, checkpoint the WAL, and optionally VACUUM. */
export function compactDatabase(store, options = {}) {
  const apply = options.apply === true;
  const limit = clamp(options.limit ?? 50, 1, 50);
  const vacuum = options.vacuum !== false;

  const before = store.stats();
  const prunable = store.all(
    `SELECT id FROM events WHERE event_type IN ('turn/start','turn/end') ORDER BY ts ASC LIMIT ?`,
    limit,
  );

  const lines = [
    `db_bytes_before=${before.dbBytes}`,
    `wal_bytes_before=${before.walBytes}`,
    `prunable_events=${prunable.length}`,
  ];

  if (!apply) {
    lines.push('Preview only: pass apply=true to prune, checkpoint, and vacuum.');
    return lines.join('\n');
  }

  inTransaction(store.db, () => {
    for (const row of prunable) store.run('DELETE FROM events WHERE id = ?', row.id);
  });
  lines.push(`pruned_events=${prunable.length}`);

  if (vacuum) {
    try {
      // VACUUM cannot run inside a transaction. It rewrites the whole database
      // through the write-ahead log, so it must precede the final checkpoint --
      // the other order leaves the entire vacuumed database sitting in the WAL.
      store.db.exec('VACUUM');
      lines.push('vacuum=ok');
    } catch (error) {
      lines.push(`vacuum=failed (${error?.message ?? error})`);
    }
  }

  try {
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    lines.push('wal_checkpoint=truncate');
  } catch (error) {
    lines.push(`wal_checkpoint=failed (${error?.message ?? error})`);
  }

  const after = store.stats();
  lines.push(`db_bytes_after=${after.dbBytes}`);
  lines.push(`wal_bytes_after=${after.walBytes}`);
  lines.push(`reclaimed=${formatBytes(Math.max(0, before.totalBytes - after.totalBytes))}`);
  return lines.join('\n');
}

/**
 * Check archive integrity and optionally repair the derived layers.
 *
 * The base table is derived from the Harness session log, so a corrupt FTS
 * index or a stale `summary_state` row is recoverable; a missing message in the
 * base table is reported but never invented.
 */
export function doctor(store, options = {}) {
  const apply = options.apply === true;
  const sessionId = typeof options.sessionID === 'string' && options.sessionID.length > 0 ? options.sessionID : undefined;
  const limit = clamp(options.limit ?? 20, 1, 50);

  const findings = [];

  const orphanMessages = store.all(
    `SELECT m.session_id, COUNT(*) AS n
       FROM messages m
       LEFT JOIN sessions s ON s.session_id = m.session_id
      WHERE s.session_id IS NULL
      ${sessionId ? 'AND m.session_id = ?' : ''}
      GROUP BY m.session_id
      LIMIT ?`,
    ...(sessionId ? [sessionId, limit] : [limit]),
  );
  for (const row of orphanMessages) findings.push(`messages_without_session session=${row.session_id} count=${row.n}`);

  const missingSessions = store.all(
    `SELECT s.session_id FROM sessions s
      WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.session_id)
        ${sessionId ? 'AND s.session_id = ?' : ''}
      LIMIT ?`,
    ...(sessionId ? [sessionId, limit] : [limit]),
  );
  for (const row of missingSessions) findings.push(`session_without_messages session=${row.session_id}`);

  const artifactOrphans = store.get(
    `SELECT COUNT(*) AS n FROM artifacts a
      WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.message_id = a.message_id)`,
  )?.n ?? 0;
  if (artifactOrphans > 0) findings.push(`artifacts_without_message count=${artifactOrphans}`);

  const danglingEdges = store.get(
    `SELECT COUNT(*) AS n FROM summary_edges e
      WHERE NOT EXISTS (SELECT 1 FROM summary_nodes n WHERE n.node_id = e.parent_id)
         OR NOT EXISTS (SELECT 1 FROM summary_nodes n WHERE n.node_id = e.child_id)`,
  )?.n ?? 0;
  if (danglingEdges > 0) findings.push(`summary_edges_with_missing_node count=${danglingEdges}`);

  const ftsCounts = store.ftsAvailable
    ? {
        message: store.get('SELECT COUNT(*) AS n FROM message_fts')?.n ?? 0,
        summary: store.get('SELECT COUNT(*) AS n FROM summary_fts')?.n ?? 0,
        artifact: store.get('SELECT COUNT(*) AS n FROM artifact_fts')?.n ?? 0,
      }
    : { message: 0, summary: 0, artifact: 0 };
  const baseCounts = {
    message: store.get('SELECT COUNT(*) AS n FROM messages')?.n ?? 0,
    summary: store.get('SELECT COUNT(*) AS n FROM summary_nodes')?.n ?? 0,
    artifact: store.get('SELECT COUNT(*) AS n FROM artifacts')?.n ?? 0,
  };
  for (const key of ['message', 'summary', 'artifact']) {
    if (ftsCounts[key] !== baseCounts[key]) {
      findings.push(`fts_drift corpus=${key} fts=${ftsCounts[key]} base=${baseCounts[key]}`);
    }
  }

  const staleState = store.get(
    `SELECT COUNT(*) AS n FROM summary_state st
      WHERE st.archived_count <> (SELECT COUNT(*) FROM messages m WHERE m.session_id = st.session_id AND m.deleted_at IS NULL)`,
  )?.n ?? 0;
  if (staleState > 0) findings.push(`summary_state_stale count=${staleState}`);

  if (findings.length === 0 && baseCounts.message === 0) {
    return 'Archive is empty; nothing to check.';
  }

  const lines = [
    `sessions=${baseCounts.message > 0 ? store.get('SELECT COUNT(*) AS n FROM sessions')?.n ?? 0 : 0}`,
    `messages=${baseCounts.message}`,
    `summary_nodes=${baseCounts.summary}`,
    `artifacts=${baseCounts.artifact}`,
    `fts_available=${store.ftsAvailable}`,
    findings.length === 0 ? 'findings=none' : `findings=${findings.length}`,
    ...findings,
  ];

  if (!apply) {
    lines.push(findings.length === 0 ? 'Nothing to repair.' : 'Pass apply=true to rebuild the derived layers.');
    return lines.join('\n');
  }

  let repaired = 0;
  // Orphan messages: recreate the minimal session row so lineage queries work.
  for (const row of orphanMessages) {
    store.run(
      `INSERT INTO sessions (session_id, root_session_id, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO NOTHING`,
      row.session_id,
      row.session_id,
      Date.now(),
    );
    repaired += 1;
  }

  // Dangling edges: drop them.
  if (danglingEdges > 0) {
    store.run(
      `DELETE FROM summary_edges
        WHERE NOT EXISTS (SELECT 1 FROM summary_nodes n WHERE n.node_id = summary_edges.parent_id)
           OR NOT EXISTS (SELECT 1 FROM summary_nodes n WHERE n.node_id = summary_edges.child_id)`,
    );
    repaired += 1;
  }

  // Rebuild the derived search corpora from the base tables.
  if (
    store.ftsAvailable &&
    (ftsCounts.message !== baseCounts.message ||
      ftsCounts.summary !== baseCounts.summary ||
      ftsCounts.artifact !== baseCounts.artifact)
  ) {
    try {
      const documents = store.rebuildSearchIndexes();
      repaired += 1;
      lines.push(`fts_rebuilt=${documents} documents`);
    } catch (error) {
      lines.push(`fts_rebuild_failed=${error?.message ?? error}`);
    }
  }

  // Rebuild summary state for the affected sessions.
  const sessionsToRebuild = sessionId ? [sessionId] : store.listSessionIds().slice(0, 25);
  for (const id of sessionsToRebuild) {
    try {
      const result = store.buildSummaries(id, { force: true });
      if (result.rebuilt) repaired += 1;
    } catch (error) {
      lines.push(`summary_rebuild_failed session=${id} error=${error?.message ?? error}`);
    }
  }

  lines.push(`repairs_applied=${repaired}`);
  return lines.join('\n');
}

/** Preview stale sessions, deleted sessions, and orphan blobs. */
export function retentionReport(store, options = {}) {
  const policy = resolvePolicy(store, options);
  const limit = clamp(options.limit ?? 20, 1, 50);
  const now = Date.now();
  const lines = [
    `stale_session_days=${policy.staleSessionDays ?? 'disabled'}`,
    `deleted_session_days=${policy.deletedSessionDays ?? 'disabled'}`,
    `orphan_blob_days=${policy.orphanBlobDays ?? 'disabled'}`,
  ];

  if (policy.staleSessionDays !== undefined) {
    const cutoff = now - policy.staleSessionDays * DAY_MS;
    const rows = store.all(
      `SELECT session_id, updated_at, pinned FROM sessions
        WHERE pinned = 0 AND updated_at < ? ORDER BY updated_at ASC LIMIT ?`,
      cutoff,
      limit,
    );
    lines.push(`stale_sessions=${rows.length}`);
    for (const row of rows) lines.push(`  stale session=${row.session_id} updated=${new Date(row.updated_at).toISOString()}`);
  }

  if (policy.deletedSessionDays !== undefined) {
    const cutoff = now - policy.deletedSessionDays * DAY_MS;
    const rows = store.all(
      'SELECT session_id, updated_at FROM sessions WHERE deleted = 1 AND updated_at < ? ORDER BY updated_at ASC LIMIT ?',
      cutoff,
      limit,
    );
    lines.push(`deleted_sessions=${rows.length}`);
    for (const row of rows) lines.push(`  deleted session=${row.session_id} updated=${new Date(row.updated_at).toISOString()}`);
  }

  if (policy.orphanBlobDays !== undefined) {
    const cutoff = now - policy.orphanBlobDays * DAY_MS;
    const rows = store.all(
      `SELECT content_hash, char_count, orphaned_at FROM artifact_blobs
        WHERE NOT EXISTS (SELECT 1 FROM artifacts a WHERE a.content_hash = artifact_blobs.content_hash)
          AND (orphaned_at IS NULL OR orphaned_at < ?)
        ORDER BY char_count DESC LIMIT ?`,
      cutoff,
      limit,
    );
    lines.push(`orphan_blobs=${rows.length}`);
    for (const row of rows) lines.push(`  orphan hash=${String(row.content_hash).slice(0, 12)} chars=${row.char_count}`);
  }

  lines.push('Nothing is pruned by this report; use lcm_retention_prune with apply=true.');
  return lines.join('\n');
}

/** Apply retention policy. */
export function retentionPrune(store, options = {}) {
  const policy = resolvePolicy(store, options);
  const apply = options.apply === true;
  const limit = clamp(options.limit ?? 20, 1, 50);
  const now = Date.now();
  const actions = [];

  if (policy.staleSessionDays !== undefined) {
    const cutoff = now - policy.staleSessionDays * DAY_MS;
    const rows = store.all('SELECT session_id FROM sessions WHERE pinned = 0 AND updated_at < ? LIMIT ?', cutoff, limit);
    actions.push({ kind: 'stale-session', ids: rows.map((row) => row.session_id) });
  }
  if (policy.deletedSessionDays !== undefined) {
    const cutoff = now - policy.deletedSessionDays * DAY_MS;
    const rows = store.all('SELECT session_id FROM sessions WHERE deleted = 1 AND updated_at < ? LIMIT ?', cutoff, limit);
    actions.push({ kind: 'deleted-session', ids: rows.map((row) => row.session_id) });
  }

  const lines = [`policy_stale_days=${policy.staleSessionDays ?? 'disabled'}`, `policy_deleted_days=${policy.deletedSessionDays ?? 'disabled'}`];
  for (const action of actions) {
    lines.push(`${apply ? 'Pruned' : 'Would prune'} ${action.ids.length} ${action.kind} ${action.ids.length === 1 ? 'entry' : 'entries'}`);
    for (const id of action.ids) lines.push(`  ${action.kind} session=${id}`);
  }

  if (!apply) {
    lines.push('Pass apply=true to prune. Blob grace periods are separate: use lcm_blob_gc.');
    return lines.join('\n');
  }

  inTransaction(store.db, () => {
    for (const action of actions) {
      for (const id of action.ids) {
        store.run('DELETE FROM messages WHERE session_id = ?', id);
        store.run('DELETE FROM artifacts WHERE session_id = ?', id);
        store.run('DELETE FROM summary_nodes WHERE session_id = ?', id);
        store.run('DELETE FROM summary_edges WHERE session_id = ?', id);
        store.run('DELETE FROM summary_state WHERE session_id = ?', id);
        store.run('DELETE FROM resumes WHERE session_id = ?', id);
        store.run('DELETE FROM events WHERE session_id = ?', id);
        store.run('DELETE FROM sessions WHERE session_id = ?', id);
      }
    }
    if (store.ftsAvailable) {
      for (const action of actions) {
        for (const id of action.ids) {
          store.run('DELETE FROM message_fts WHERE session_id = ?', id);
          store.run('DELETE FROM summary_fts WHERE session_id = ?', id);
          store.run('DELETE FROM artifact_fts WHERE session_id = ?', id);
        }
      }
    }
  });

  lines.push(`pruned_sessions=${actions.reduce((sum, action) => sum + action.ids.length, 0)}`);
  return lines.join('\n');
}

/** Write a portable JSON snapshot. */
export function exportSnapshot(store, options = {}) {
  const filePath = options.filePath;
  if (typeof filePath !== 'string' || filePath.length === 0) return 'filePath is required.';
  const scope = typeof options.scope === 'string' && options.scope.length > 0 ? options.scope : 'session';
  const sessionId = typeof options.sessionID === 'string' && options.sessionID.length > 0 ? options.sessionID : undefined;
  const sessionIds = sessionId ? store.resolveScope(scope, sessionId) : store.listSessionIds();
  if (sessionIds.length === 0) return 'Nothing to export.';

  const placeholders = sessionIds.map(() => '?').join(', ');
  const snapshot = {
    format: 'dsh-lcm-snapshot',
    version: 1,
    exportedAt: new Date().toISOString(),
    scope,
    sessions: store.all(`SELECT * FROM sessions WHERE session_id IN (${placeholders})`, ...sessionIds),
    messages: store.all(`SELECT * FROM messages WHERE session_id IN (${placeholders})`, ...sessionIds),
    artifacts: store.all(`SELECT * FROM artifacts WHERE session_id IN (${placeholders})`, ...sessionIds),
    summaryNodes: store.all(`SELECT * FROM summary_nodes WHERE session_id IN (${placeholders})`, ...sessionIds),
    summaryEdges: store.all(`SELECT * FROM summary_edges WHERE session_id IN (${placeholders})`, ...sessionIds),
    summaryState: store.all(`SELECT * FROM summary_state WHERE session_id IN (${placeholders})`, ...sessionIds),
    resumes: store.all(`SELECT * FROM resumes WHERE session_id IN (${placeholders})`, ...sessionIds),
  };

  try {
    writeFileSync(filePath, JSON.stringify(snapshot), 'utf8');
  } catch (error) {
    return `Failed to write snapshot: ${error?.message ?? error}`;
  }

  return [
    `snapshot=${filePath}`,
    `scope=${scope}`,
    `sessions=${snapshot.sessions.length}`,
    `messages=${snapshot.messages.length}`,
    `artifacts=${snapshot.artifacts.length}`,
    `summary_nodes=${snapshot.summaryNodes.length}`,
    `bytes=${JSON.stringify(snapshot).length}`,
  ].join('\n');
}

/** Merge or replace from a portable JSON snapshot. */
export function importSnapshot(store, options = {}) {
  const filePath = options.filePath;
  const mode = options.mode;
  if (typeof filePath !== 'string' || filePath.length === 0) return 'filePath is required.';
  if (mode !== 'merge' && mode !== 'replace') return 'mode is required and must be "merge" or "replace".';
  if (!existsSync(filePath)) return `Snapshot not found: ${filePath}`;

  let snapshot;
  try {
    snapshot = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    return `Snapshot is not valid JSON: ${error?.message ?? error}`;
  }
  if (snapshot?.format !== 'dsh-lcm-snapshot') return 'Not a dsh-lcm snapshot file.';

  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  const targetIds = sessions.map((row) => row.session_id).filter(Boolean);

  if (mode === 'replace' && targetIds.length > 0) {
    const placeholders = targetIds.map(() => '?').join(', ');
    inTransaction(store.db, () => {
      for (const table of ['messages', 'artifacts', 'summary_nodes', 'summary_edges', 'summary_state', 'resumes', 'events']) {
        store.run(`DELETE FROM ${table} WHERE session_id IN (${placeholders})`, ...targetIds);
      }
      if (store.ftsAvailable) {
        for (const table of ['message_fts', 'summary_fts', 'artifact_fts']) {
          store.run(`DELETE FROM ${table} WHERE session_id IN (${placeholders})`, ...targetIds);
        }
      }
    });
  }

  const sessionColumns = ['session_id', 'title', 'cwd', 'worktree_key', 'parent_session_id', 'root_session_id', 'lineage_depth', 'pinned', 'pin_reason', 'created_at', 'updated_at', 'compacted_at', 'deleted', 'event_count', 'watermark_seq'];
  const counts = { sessions: 0, messages: 0, artifacts: 0, summaryNodes: 0, resumes: 0 };

  inTransaction(store.db, () => {
    for (const row of sessions) {
      if (!row?.session_id) continue;
      store.run(
        `INSERT INTO sessions (${sessionColumns.join(', ')})
         VALUES (${sessionColumns.map(() => '?').join(', ')})
         ON CONFLICT(session_id) DO UPDATE SET
           title = COALESCE(excluded.title, sessions.title),
           cwd = COALESCE(excluded.cwd, sessions.cwd),
           worktree_key = COALESCE(excluded.worktree_key, sessions.worktree_key),
           parent_session_id = COALESCE(excluded.parent_session_id, sessions.parent_session_id),
           root_session_id = excluded.root_session_id,
           lineage_depth = excluded.lineage_depth,
           pinned = MAX(sessions.pinned, excluded.pinned),
           updated_at = MAX(sessions.updated_at, excluded.updated_at),
           watermark_seq = MAX(sessions.watermark_seq, excluded.watermark_seq)`,
        ...sessionColumns.map((column) => row[column] ?? null),
      );
      counts.sessions += 1;
    }

    for (const row of snapshot.messages ?? []) {
      store.run(
        `INSERT INTO messages (message_id, session_id, seq, role, created_at, deleted_at, info_json, text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(message_id) DO UPDATE SET
           seq = MIN(messages.seq, excluded.seq),
           info_json = excluded.info_json,
           text = excluded.text`,
        row.message_id,
        row.session_id,
        row.seq,
        row.role,
        row.created_at,
        row.deleted_at ?? null,
        row.info_json,
        row.text ?? '',
      );
      counts.messages += 1;
    }

    for (const row of snapshot.artifacts ?? []) {
      store.run(
        `INSERT INTO artifacts (artifact_id, session_id, message_id, block_index, artifact_kind, field_name, preview_text, content_text, content_hash, metadata_json, char_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(artifact_id) DO NOTHING`,
        row.artifact_id,
        row.session_id,
        row.message_id,
        row.block_index ?? 0,
        row.artifact_kind,
        row.field_name,
        row.preview_text,
        row.content_text,
        row.content_hash ?? null,
        row.metadata_json ?? '{}',
        row.char_count,
        row.created_at,
      );
      if (row.content_hash) {
        store.run(
          'INSERT INTO artifact_blobs (content_hash, content_text, char_count, created_at, orphaned_at) VALUES (?, ?, ?, ?, NULL) ON CONFLICT(content_hash) DO NOTHING',
          row.content_hash,
          row.content_text,
          row.char_count,
          row.created_at,
        );
      }
      counts.artifacts += 1;
    }

    for (const row of snapshot.summaryNodes ?? []) {
      store.run(
        `INSERT INTO summary_nodes (node_id, session_id, level, node_kind, start_seq, end_seq, message_ids_json, summary_text, strategy, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(node_id) DO NOTHING`,
        row.node_id,
        row.session_id,
        row.level,
        row.node_kind,
        row.start_seq,
        row.end_seq,
        row.message_ids_json,
        row.summary_text,
        row.strategy,
        row.created_at,
      );
      counts.summaryNodes += 1;
    }

    for (const row of snapshot.summaryEdges ?? []) {
      store.run(
        'INSERT INTO summary_edges (session_id, parent_id, child_id, child_position) VALUES (?, ?, ?, ?) ON CONFLICT(parent_id, child_id) DO NOTHING',
        row.session_id,
        row.parent_id,
        row.child_id,
        row.child_position,
      );
    }

    for (const row of snapshot.resumes ?? []) {
      store.run(
        'INSERT INTO resumes (session_id, note, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at',
        row.session_id,
        row.note,
        row.updated_at,
      );
      counts.resumes += 1;
    }
  });

  // Derived layers are rebuilt rather than imported, so a snapshot from another
  // archive cannot carry a stale index into this one.
  const rebuilt = [];
  for (const id of targetIds.slice(0, 50)) {
    const result = store.buildSummaries(id, { force: true });
    if (result.rebuilt) rebuilt.push(`${id}:${result.nodes}`);
  }

  return [
    `mode=${mode}`,
    `imported_sessions=${counts.sessions}`,
    `imported_messages=${counts.messages}`,
    `imported_artifacts=${counts.artifacts}`,
    `imported_summary_nodes=${counts.summaryNodes}`,
    `imported_resumes=${counts.resumes}`,
    `summary_rebuilds=${rebuilt.length}`,
    'Run lcm_doctor apply=true to rebuild search indexes.',
  ].join('\n');
}

function resolvePolicy(store, options) {
  const configured = store.config.retention;
  return {
    staleSessionDays: options.staleSessionDays !== undefined ? options.staleSessionDays : configured.staleSessionDays,
    deletedSessionDays: options.deletedSessionDays !== undefined ? options.deletedSessionDays : configured.deletedSessionDays,
    orphanBlobDays: options.orphanBlobDays !== undefined ? options.orphanBlobDays : configured.orphanBlobDays,
  };
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(Math.max(Math.trunc(number), min), max);
}

export { parseJson };
