/**
 * The `lcm_*` tool suite.
 *
 * Mirrors `opencode-lcm`'s 18 tools one-for-one so an operator moving between
 * the two plugins sees the same surface. Names, argument shapes, defaults and
 * the dry-run-unless-`apply` convention are preserved.
 *
 * Harness-specific adaptation: every tool that acts on "the current session"
 * resolves it from `exec.agent.session.id` rather than from an ambient context,
 * because the Harness tool registry is global while sessions are per-agent.
 * An explicit `sessionID` argument always overrides it.
 *
 * Registration cost: the Harness attaches every visible tool schema to every
 * request, so this suite is opt-out (`tools.enabled`) and trimmable
 * (`tools.expose`) — see the README.
 */

/** Minimal tool factory: every LCM tool answers with human-readable text. */
function textTool({ name, description, parameters, execute }) {
  return {
    name,
    description,
    parameters: { type: 'object', properties: parameters ?? {} },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    },
    execute,
  };
}

/**
 * The retrieval-scope enum for the model-facing tools.
 *
 * `all` resolves to every session in the shared archive with no cwd, worktree or
 * profile filter, so with one Harness home across projects a model-driven call
 * could pull another project's conversation into this one. It is therefore
 * offered only when the operator opts in with `allowScopeAll: true`.
 */
function scopeEnum(allowScopeAll) {
  return {
    type: 'string',
    description: allowScopeAll
      ? 'Retrieval scope: session, root (the whole branch tree), worktree (same working directory), or all (every archived session — enabled by allowScopeAll).'
      : 'Retrieval scope: session, root (the whole branch tree), or worktree (same working directory).',
    enum: allowScopeAll ? ['session', 'root', 'worktree', 'all'] : ['session', 'root', 'worktree'],
  };
}

const SCOPE_ALL_REFUSAL =
  'scope "all" is disabled: it would search every session in the shared archive, including other projects. ' +
  'Pass scope session, root or worktree, or set allowScopeAll=true in the plugin config to opt in.';

/** Resolve the session a tool call acts on. */
function sessionIdOf(args, exec) {
  if (typeof args?.sessionID === 'string' && args.sessionID.length > 0) return args.sessionID;
  const fromAgent = exec?.agent?.session?.id;
  return typeof fromAgent === 'string' && fromAgent.length > 0 ? fromAgent : undefined;
}

/**
 * Build every LCM tool definition.
 *
 * @param {object} deps
 * @param {import('./store.js').LcmStore} deps.store
 * @param {() => Promise<void>} deps.backfillPending
 * @param {(sessionId?: string) => Promise<void>} deps.ensureCaptured
 * @param {import('./config.js').resolveConfig} deps.config
 * @returns {Array<object>} tool definitions
 */
export function buildTools({ store, ensureCaptured, config }) {
  const tools = [];
  const scopeAllAllowed = config.allowScopeAll === true;
  const scopeParameter = scopeEnum(scopeAllAllowed);

  /**
   * A gate on top of the enum.
   *
   * A tool argument is not validated by the schema at call time -- the model can
   * send any string -- so the refusal has to be a runtime answer, not merely an
   * absent enum member.
   */
  const refuseScopeAll = (args) => (args?.scope === 'all' && !scopeAllAllowed ? SCOPE_ALL_REFUSAL : undefined);

  const withSession = (handler) => async (args, exec) => {
    const sessionId = sessionIdOf(args, exec);
    if (!sessionId) return 'No session context: pass sessionID explicitly.';
    try {
      await ensureCaptured(sessionId);
    } catch (error) {
      // A backfill failure degrades to the archive's current contents.
      store.logger?.debug?.(`[lcm] backfill failed for ${sessionId}: ${error?.message ?? error}`);
    }
    return handler(args, exec, sessionId);
  };

  // ---------------------------------------------------------------- status

  tools.push(
    textTool({
      name: 'lcm_status',
      description: 'Show archived LCM capture stats: sessions, messages, summaries, artifacts, and retrieval configuration.',
      parameters: {},
      execute: async () => {
        try {
          await ensureCaptured();
        } catch {
          // Status must always answer.
        }
        const stats = store.stats();
        const options = config;
        const lines = [
          `schema_version=${stats.schemaVersion}`,
          `store_path=${stats.dbPath}`,
          `fts_available=${stats.ftsAvailable}`,
          `total_events=${stats.totalEvents}`,
          `prunable_events=${stats.prunableEventCount}`,
          `session_count=${stats.sessionCount}`,
          `root_sessions=${stats.rootSessionCount}`,
          `branched_sessions=${stats.branchedSessionCount}`,
          `pinned_sessions=${stats.pinnedSessionCount}`,
          `worktrees=${stats.worktreeCount}`,
          `message_count=${stats.messageCount}`,
          `removed_messages=${stats.deletedMessageCount}`,
          `summary_nodes=${stats.summaryNodeCount}`,
          `summary_states=${stats.summaryStateCount}`,
          `resume_notes=${stats.resumeCount}`,
          `artifacts=${stats.artifactCount}`,
          `artifact_inline_body_chars=${stats.artifactInlineBodyChars}`,
          `artifact_blobs=${stats.artifactBlobCount}`,
          `shared_artifact_blobs=${stats.sharedArtifactBlobCount}`,
          `orphan_artifact_blobs=${stats.orphanArtifactBlobCount}`,
          `db_bytes=${stats.dbBytes}`,
          `wal_bytes=${stats.walBytes}`,
          `shm_bytes=${stats.shmBytes}`,
          `total_bytes_label=${stats.bytesLabel}`,
          `captured_messages=${stats.counters.capturedMessages}`,
          `captured_events=${stats.counters.capturedEvents}`,
          `capture_failures=${stats.counters.captureFailures}`,
          `summary_rebuilds=${stats.counters.summaryRebuilds}`,
          `recall_cap_reached=${stats.counters.recallCapReached ?? 0}`,
          `capture_enabled=${options.capture.enabled}`,
          `scope_default_grep=${options.scopeDefaults.grep}`,
          `scope_default_describe=${options.scopeDefaults.describe}`,
          `retention_stale_session_days=${options.retention.staleSessionDays ?? 'disabled'}`,
          `retention_deleted_session_days=${options.retention.deletedSessionDays ?? 'disabled'}`,
          `retention_orphan_blob_days=${options.retention.orphanBlobDays ?? 'disabled'}`,
          `automatic_retrieval_enabled=${options.automaticRetrieval.enabled}`,
          `automatic_retrieval_max_chars=${options.automaticRetrieval.maxChars}`,
          `automatic_retrieval_min_tokens=${options.automaticRetrieval.minTokens}`,
          `automatic_retrieval_message_hits=${options.automaticRetrieval.maxMessageHits}`,
          `automatic_retrieval_summary_hits=${options.automaticRetrieval.maxSummaryHits}`,
          `automatic_retrieval_artifact_hits=${options.automaticRetrieval.maxArtifactHits}`,
          `automatic_retrieval_scope_order=${options.automaticRetrieval.scopeOrder.join(',')}`,
          `automatic_retrieval_scope_budgets=session:${options.automaticRetrieval.scopeBudgets.session},root:${options.automaticRetrieval.scopeBudgets.root},worktree:${options.automaticRetrieval.scopeBudgets.worktree},all:${options.automaticRetrieval.scopeBudgets.all}`,
          `fresh_tail_messages=${options.freshTailMessages}`,
          `max_recall_messages_per_session=${options.maxRecallMessagesPerSession}`,
          `allow_scope_all=${options.allowScopeAll === true}`,
          `min_messages_for_transform=${options.summary.minMessagesForTransform}`,
          `summary_strategy=${options.summary.strategy}`,
          `summary_level_size=${options.summary.levelSize}`,
          `large_content_threshold=${options.largeContentThreshold}`,
          `privacy_exclude_tool_prefixes=${options.privacy.excludeToolPrefixes.join(',') || 'none'}`,
          `privacy_exclude_path_patterns=${options.privacy.excludePathPatterns.length}`,
          `privacy_redact_patterns=${options.privacy.redactPatterns.length}`,
          `system_hint=${options.systemHint}`,
          ...stats.byType.slice(0, 10).map((row) => `event_${row.event_type}=${row.n}`),
        ];
        return lines.join('\n');
      },
    }),
  );

  tools.push(
    textTool({
      name: 'lcm_retrieval_debug',
      description: 'Show the diagnostics of the most recent automatic recall for a session.',
      parameters: { sessionID: { type: 'string', description: 'Session to inspect; defaults to the current session.' } },
      execute: withSession(async (args, exec, sessionId) => store.retrievalDebugFor(sessionId)),
    }),
  );

  tools.push(
    textTool({
      name: 'lcm_resume',
      description: 'Show the durable resume note for a session: what survives a compaction.',
      parameters: {
        sessionID: { type: 'string', description: 'Session to inspect; defaults to the current session.' },
        refresh: { type: 'boolean', description: 'Recompute the derived note from the current archive before answering.' },
      },
      execute: withSession(async (args, exec, sessionId) => {
        if (args.refresh === true) {
          const note = store.deriveResumeNote(sessionId);
          if (note) store.setResume(sessionId, note);
        }
        return store.resume(sessionId);
      }),
    }),
  );

  // ------------------------------------------------------------------ search

  tools.push(
    textTool({
      name: 'lcm_grep',
      description:
        'Search the archived capture of earlier conversation with scope. Paginate by repeating with offset = previous offset + limit.',
      parameters: {
        query: { type: 'string', description: 'Search text. Quoted groups are matched as phrases.' },
        sessionID: { type: 'string', description: 'Anchor session; defaults to the current session.' },
        scope: scopeParameter,
        limit: { type: 'number', description: 'Results to return, 1-20. Default 5.' },
        offset: { type: 'number', description: 'Results to skip, 0-200. Default 0.' },
        summaryID: { type: 'string', description: 'Restrict results to one summary node and its descendants.' },
      },
      execute: withSession(async (args, exec, sessionId) => {
        const refused = refuseScopeAll(args);
        if (refused) return refused;
        const limit = clampNumber(args.limit, 1, 20, 5);
        const offset = clampNumber(args.offset, 0, 200, 0);
        const results = store.grep({
          query: String(args.query ?? ''),
          sessionId,
          scope: args.scope,
          limit,
          offset,
          summaryId: typeof args.summaryID === 'string' ? args.summaryID : undefined,
        });
        if (typeof results === 'string') return results;
        if (results.length === 0) return 'No archived matches found.';
        return [
          `results=${results.length} offset=${offset} limit=${limit}`,
          ...results.map((result) => {
            const session = result.sessionID ?? '-';
            return `[${result.type}] session=${session} node=${result.id} score=${Math.round(result.score ?? 0)} ${result.snippet}`;
          }),
        ].join('\n\n');
      }),
    }),
  );

  tools.push(
    textTool({
      name: 'lcm_describe',
      description: 'Summarize what the archive holds for a session and its scope.',
      parameters: {
        sessionID: { type: 'string', description: 'Anchor session; defaults to the current session.' },
        scope: scopeParameter,
      },
      execute: withSession(async (args, exec, sessionId) => {
        const refused = refuseScopeAll(args);
        if (refused) return refused;
        return store.describe({ sessionId, scope: args.scope });
      }),
    }),
  );

  tools.push(
    textTool({
      name: 'lcm_lineage',
      description: 'Show the branch lineage of a session: its ancestry and direct children.',
      parameters: { sessionID: { type: 'string', description: 'Session to trace; defaults to the current session.' } },
      execute: withSession(async (args, exec, sessionId) => {
        const lineage = store.lineage(sessionId);
        if (!lineage.found) return `No archived capture for session=${sessionId}.`;
        return [
          `session=${lineage.sessionId}`,
          `title=${lineage.title ?? 'n/a'}`,
          `root_session_id=${lineage.rootSessionId}`,
          `depth=${lineage.depth}`,
          `cwd=${lineage.cwd ?? 'n/a'}`,
          `ancestry=${lineage.ancestry.length}`,
          ...lineage.ancestry.map((entry) => `  ancestor depth=${entry.depth ?? '?'} session=${entry.sessionId}${entry.missing ? ' (missing)' : ''} title=${entry.title ?? 'n/a'}`),
          `children=${lineage.children.length}`,
          ...lineage.children.map((child) => `  child depth=${child.depth} session=${child.sessionId} title=${child.title ?? 'n/a'}`),
        ].join('\n');
      }),
    }),
  );

  tools.push(
    textTool({
      name: 'lcm_expand',
      description:
        'Progressively expand archived summary nodes. Raw messages stay excluded unless includeRaw=true, which is only needed when the summary levels are insufficient.',
      parameters: {
        sessionID: { type: 'string', description: 'Session to expand; defaults to the current session.' },
        nodeID: { type: 'string', description: 'Summary node id (an unambiguous prefix is accepted).' },
        query: { type: 'string', description: 'Pick the best-matching summary node when nodeID is omitted.' },
        depth: { type: 'number', description: 'Child levels to list, 1-4. Default 2.' },
        messageLimit: { type: 'number', description: 'Raw messages to include with includeRaw, 1-20. Default 4.' },
        includeRaw: { type: 'boolean', description: 'Include raw archived messages referenced by the node.' },
      },
      execute: withSession(async (args, exec, sessionId) => {
        // Summaries are derived, so refresh them before expanding.
        try {
          store.buildSummaries(sessionId);
        } catch (error) {
          store.logger?.warn?.(`[lcm] summary rebuild failed: ${error?.message ?? error}`);
        }
        return store.expand({
          sessionId,
          nodeId: typeof args.nodeID === 'string' ? args.nodeID : undefined,
          query: typeof args.query === 'string' ? args.query : undefined,
          depth: clampNumber(args.depth, 1, 4, 2),
          messageLimit: clampNumber(args.messageLimit, 1, 20, 4),
          includeRaw: args.includeRaw === true,
        });
      }),
    }),
  );

  tools.push(
    textTool({
      name: 'lcm_artifact',
      description: 'Read a payload that was externalized out of the archive because it was too large.',
      parameters: {
        artifactID: { type: 'string', description: 'Artifact id from lcm_grep; an unambiguous prefix is accepted.' },
        chars: { type: 'number', description: 'Characters to return, 200-20000. Default 4000.' },
      },
      execute: async (args, exec) => {
        if (typeof args.artifactID !== 'string' || args.artifactID.length === 0) return 'artifactID is required.';
        // A prefix is resolved inside one session, so this tool needs a session
        // even though an exact id is globally unique.
        const sessionId = sessionIdOf(args, exec);
        if (!sessionId) return 'No session context: pass sessionID explicitly.';
        return store.artifact({ artifactId: args.artifactID, sessionId, chars: args.chars });
      },
    }),
  );

  // -------------------------------------------------------------------- pins

  tools.push(
    textTool({
      name: 'lcm_pin_session',
      description: 'Pin a session so retention pruning will never remove it.',
      parameters: {
        sessionID: { type: 'string', description: 'Session to pin; defaults to the current session.' },
        reason: { type: 'string', description: 'Why this session matters; recorded with the pin.' },
      },
      execute: withSession(async (args, exec, sessionId) => store.pinSession({ sessionId, reason: args.reason })),
    }),
  );

  tools.push(
    textTool({
      name: 'lcm_unpin_session',
      description: 'Remove a session retention pin.',
      parameters: { sessionID: { type: 'string', description: 'Session to unpin; defaults to the current session.' } },
      execute: withSession(async (args, exec, sessionId) => store.unpinSession({ sessionId })),
    }),
  );

  // --------------------------------------------------------------- artifacts

  tools.push(
    textTool({
      name: 'lcm_blob_stats',
      description: 'Show deduplicated artifact blob statistics, largest first.',
      parameters: { limit: { type: 'number', description: 'Blobs to list, 1-20. Default 10.' } },
      execute: async (args) => store.blobStats({ limit: args.limit }),
    }),
  );

  tools.push(
    textTool({
      name: 'lcm_blob_gc',
      description: 'Preview or delete artifact blobs that no artifact references.',
      parameters: {
        apply: { type: 'boolean', description: 'Actually delete. Omit for a dry run.' },
        limit: { type: 'number', description: 'Blobs to consider, 1-50. Default 20.' },
      },
      execute: async (args) => store.gcBlobs({ apply: args.apply === true, limit: args.limit }),
    }),
  );

  // ------------------------------------------------------------ housekeeping

  tools.push(
    textTool({
      name: 'lcm_compact',
      description:
        'Measure and reclaim archive database space: prune internal events, checkpoint the WAL, and VACUUM when requested.',
      parameters: {
        apply: { type: 'boolean', description: 'Actually apply. Omit for a dry run.' },
        vacuum: { type: 'boolean', description: 'Run VACUUM (default true when applying).' },
        limit: { type: 'number', description: 'Events to prune, 1-50. Default 50.' },
      },
      execute: async (args) => store.compact({ apply: args.apply === true, vacuum: args.vacuum, limit: args.limit }),
    }),
  );

  tools.push(
    textTool({
      name: 'lcm_doctor',
      description: 'Inspect the archive for inconsistency, and repair summaries and search indexes when apply=true.',
      parameters: {
        apply: { type: 'boolean', description: 'Repair what the inspection finds. Omit for a dry run.' },
        sessionID: { type: 'string', description: 'Limit the inspection to one session.' },
        limit: { type: 'number', description: 'Findings per category, 1-50. Default 20.' },
      },
      execute: async (args) => store.runDoctor({ apply: args.apply === true, sessionID: args.sessionID, limit: args.limit }),
    }),
  );

  tools.push(
    textTool({
      name: 'lcm_retention_report',
      description: 'Preview which sessions and blobs the retention policy would remove.',
      parameters: {
        staleSessionDays: { type: 'number', description: 'Override the configured stale-session age in days.' },
        deletedSessionDays: { type: 'number', description: 'Override the configured deleted-session age in days.' },
        orphanBlobDays: { type: 'number', description: 'Override the configured orphan-blob grace period in days.' },
        limit: { type: 'number', description: 'Entries per category, 1-50. Default 20.' },
      },
      execute: async (args) => store.retentionReport(args),
    }),
  );

  tools.push(
    textTool({
      name: 'lcm_retention_prune',
      description: 'Preview or apply the retention policy. Pinned sessions are never pruned.',
      parameters: {
        apply: { type: 'boolean', description: 'Actually prune. Omit for a dry run.' },
        staleSessionDays: { type: 'number', description: 'Override the configured stale-session age in days.' },
        deletedSessionDays: { type: 'number', description: 'Override the configured deleted-session age in days.' },
        orphanBlobDays: { type: 'number', description: 'Override the configured orphan-blob grace period in days.' },
        limit: { type: 'number', description: 'Entries per category, 1-50. Default 20.' },
      },
      execute: async (args) => store.retentionPrune({ ...args, apply: args.apply === true }),
    }),
  );

  // ---------------------------------------------------------------- snapshots

  tools.push(
    textTool({
      name: 'lcm_export_snapshot',
      description: 'Export a portable long-memory snapshot to a JSON file inside the archive directory.',
      parameters: {
        filePath: { type: 'string', description: 'Path of the JSON file to write; it must resolve inside the archive directory.' },
        sessionID: { type: 'string', description: 'Anchor session; defaults to the current session.' },
        scope: scopeParameter,
      },
      execute: withSession(async (args, exec, sessionId) => {
        const refused = refuseScopeAll(args);
        if (refused) return refused;
        return store.exportSnapshot({ filePath: args.filePath, sessionID: sessionId, scope: args.scope });
      }),
    }),
  );

  tools.push(
    textTool({
      name: 'lcm_import_snapshot',
      description: 'Import a portable long-memory snapshot. Requires an explicit merge or replace mode.',
      parameters: {
        filePath: { type: 'string', description: 'Absolute path of the JSON snapshot to read.' },
        mode: {
          type: 'string',
          description: 'merge keeps existing archive rows; replace first clears the snapshot\'s sessions.',
          enum: ['merge', 'replace'],
        },
      },
      execute: async (args) => store.importSnapshot({ filePath: args.filePath, mode: args.mode }),
    }),
  );

  const expose = config.tools.expose;
  if (Array.isArray(expose) && expose.length > 0) {
    const allowed = new Set(expose);
    return tools.filter((tool) => allowed.has(tool.name));
  }
  return tools;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), min), max);
}
