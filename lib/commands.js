/**
 * The human-facing `/lcm` command.
 *
 * Everything else this plugin exposes is model-facing (the `lcm_*` tools and the
 * system hint). This is the surface a person drives directly from the composer:
 * one command with subcommands, so it adds a single entry to the command palette
 * instead of eighteen.
 *
 * Command output is human-only by design — it is shown in the UI and is not
 * injected into the conversation — so the wording addresses the operator, not the
 * model. Mutating subcommands are preview-only unless the invocation says
 * `apply`, matching the tools.
 */

/** Usage text for `/lcm` with no subcommand, and for `/lcm help`. */
const HELP = [
  'Usage: /lcm <subcommand> [args]',
  '',
  '  status                      archive inventory and retrieval configuration',
  '  grep <query> [--scope s] [--limit n]   search the archive (s = session|root|worktree|all)',
  '  expand <nodeID|query> [raw] progressively expand summary nodes (raw = include messages)',
  '  describe [scope]            what the archive holds for a scope',
  '  resume                      the durable note that survives a compaction',
  '  lineage                     this session ancestry and children',
  '  debug [Deprecated]          diagnostics of the last automatic recall (off by default; use resume)',
  '  pin [reason] | unpin        protect this session from retention',
  '  blobstats [n]               artifact blob inventory',
  '  gc [apply]                  preview or delete orphaned blobs',
  '  compact [apply]             preview or reclaim database space',
  '  doctor [apply]              inspect or repair summaries and search indexes',
  '  retention [apply]           preview or apply the retention policy',
].join('\n');

/** Parse `--flag=value` and bare flags out of a subcommand's arguments. */
function parseArgs(tokens) {
  const flags = new Map();
  const positional = [];
  for (const token of tokens) {
    if (token.startsWith('--')) {
      const [key, value] = token.slice(2).split('=');
      flags.set(key, value ?? 'true');
      continue;
    }
    if (token === 'apply' || token === 'raw') {
      flags.set(token, 'true');
      continue;
    }
    positional.push(token);
  }
  return { flags, positional };
}

/** Integer flag with a default, clamped to a sane range. */
function numberFlag(flags, key, fallback, min, max) {
  const raw = flags.get(key);
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/** Render grep hits the way the tool does, for a human reader. */
function renderHits(results) {
  if (typeof results === 'string') return results;
  if (results.length === 0) return 'No archived matches found.';
  return results
    .map((hit) => `[${hit.type}] session=${hit.sessionID ?? '-'} id=${hit.id} score=${Math.round(hit.score ?? 0)}\n  ${hit.snippet}`)
    .join('\n\n');
}

/**
 * Build the `/lcm` command definition.
 *
 * @param {object} deps
 * @param {import('./store.js').LcmStore} deps.store
 * @param {(sessionId?: string) => Promise<void>} deps.ensureCaptured
 * @returns {{definitionId: string, name: string, description: string, handler: Function}}
 */
export function buildLcmCommand({ store, ensureCaptured }) {
  return {
    // The brand constructor is a plain passthrough at runtime, so no import from
    // `@deepseek-ai/dsh-commands` is needed (and could not be resolved anyway).
    definitionId: '@local/dsh-plugin-lcm',
    name: 'lcm',
    description: 'Inspect and maintain the Lossless Context Memory archive',
    // Optional discovery metadata: the registry surfaces this hint on the
    // command plane. Every byte after the name — including the separating
    // whitespace — arrives verbatim as `rawInput`, and this command owns that
    // syntax, so the subcommand parser below trims and tokenizes it itself.
    input: { hint: '<subcommand> [args]' },
    handler: async (invocation) => {
      const sessionId = invocation?.agent?.session?.id;
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return { kind: 'error', text: 'lcm: this command needs a session.' };
      }
      if (!store.ready) {
        return { kind: 'error', text: 'lcm: the archive is unavailable; see the plugin log for the reason.' };
      }

      const tokens = String(invocation.rawInput ?? '').trim().split(/\s+/).filter(Boolean);
      const subcommand = (tokens.shift() ?? 'help').toLowerCase();
      const { flags, positional } = parseArgs(tokens);
      const apply = flags.get('apply') === 'true';

      try {
        await ensureCaptured(sessionId);

        switch (subcommand) {
          case 'help':
            return { kind: 'success', text: HELP };

          case 'status':
            return { kind: 'success', text: renderStatus(store) };

          case 'grep': {
            const query = positional.join(' ');
            if (query.length === 0) return { kind: 'error', text: 'Usage: /lcm grep <query> [--scope s] [--limit n]' };
            const results = store.grep({
              query,
              sessionId,
              scope: flags.get('scope'),
              limit: numberFlag(flags, 'limit', 5, 1, 20),
            });
            return { kind: 'success', text: renderHits(results) };
          }

          case 'expand': {
            const first = positional[0];
            // Summary node ids look like lcm-<session>-L<level>-<start>-<end>;
            // anything else is treated as a query.
            const nodeId = first?.startsWith('lcm-') ? first : undefined;
            return {
              kind: 'success',
              text: store.expand({
                sessionId,
                nodeId,
                query: nodeId ? undefined : positional.join(' ') || undefined,
                includeRaw: flags.get('raw') === 'true',
              }),
            };
          }

          case 'describe':
            return { kind: 'success', text: store.describe({ sessionId, scope: positional[0] }) };

          case 'resume':
            return { kind: 'success', text: store.resume(sessionId) };

          case 'lineage': {
            const lineage = store.lineage(sessionId);
            if (!lineage.found) return { kind: 'success', text: `No archived capture for session=${sessionId}.` };
            return {
              kind: 'success',
              text: [
                `session=${lineage.sessionId}`,
                `title=${lineage.title ?? 'n/a'}`,
                `root=${lineage.rootSessionId} depth=${lineage.depth} cwd=${lineage.cwd ?? 'n/a'}`,
                `ancestry=${lineage.ancestry.length} children=${lineage.children.length}`,
                ...lineage.ancestry.map((entry) => `  ancestor depth=${entry.depth ?? '?'} ${entry.sessionId} ${entry.title ?? ''}`),
                ...lineage.children.map((child) => `  child depth=${child.depth} ${child.sessionId} ${child.title ?? ''}`),
              ].join('\n'),
            };
          }

          case 'debug':
            // Deprecated label, not removal. The subcommand still answers, but the feature
            // it reports on — similarity-based automatic recall — is off by default, so a
            // bare "not run" reads like a fault instead of a setting. Say what it means
            // every time, and point at the subcommand that does report something useful.
            return {
              kind: 'success',
              text: [
                'Deprecated: similarity recall is disabled (automaticRetrieval.enabled=false), so there is',
                'normally nothing to diagnose here. Use `/lcm resume` for what survives a compaction; turn',
                'automaticRetrieval on first if you want real telemetry from this subcommand.',
                '',
                store.retrievalDebugFor(sessionId),
              ].join('\n'),
            };

          case 'pin':
            return { kind: 'success', text: store.pinSession({ sessionId, reason: positional.join(' ') || undefined }) };

          case 'unpin':
            return { kind: 'success', text: store.unpinSession({ sessionId }) };

          case 'blobstats':
            return { kind: 'success', text: store.blobStats({ limit: numberFlag(flags, 'limit', 10, 1, 20) }) };

          case 'gc':
            return { kind: 'success', text: store.gcBlobs({ apply, limit: numberFlag(flags, 'limit', 20, 1, 50) }) };

          case 'compact':
            return { kind: 'success', text: store.compact({ apply, limit: numberFlag(flags, 'limit', 50, 1, 50) }) };

          case 'doctor':
            return { kind: 'success', text: store.runDoctor({ apply, limit: numberFlag(flags, 'limit', 20, 1, 50) }) };

          case 'retention':
            return { kind: 'success', text: apply ? store.retentionPrune({ apply: true }) : store.retentionReport({}) };

          default:
            return { kind: 'error', text: `Unknown subcommand "${subcommand}".\n\n${HELP}` };
        }
      } catch (error) {
        return { kind: 'error', text: `lcm ${subcommand} failed: ${error?.message ?? error}` };
      }
    },
  };
}

/** Compact multi-line status for the human, in `/lcm status`. */
function renderStatus(store) {
  const stats = store.stats();
  return [
    `archive        ${stats.dbPath}`,
    `schema         v${stats.schemaVersion}   search index: ${stats.ftsAvailable ? 'available' : 'unavailable'}`,
    `sessions       ${stats.sessionCount} (${stats.rootSessionCount} roots, ${stats.branchedSessionCount} branched, ${stats.pinnedSessionCount} pinned)`,
    `messages       ${stats.messageCount} archived, ${stats.deletedMessageCount} removed`,
    `summaries      ${stats.summaryNodeCount} nodes over ${stats.summaryStateCount} sessions`,
    `artifacts      ${stats.artifactCount} rows, ${stats.artifactBlobCount} blobs (${stats.sharedArtifactBlobCount} shared, ${stats.orphanArtifactBlobCount} orphaned)`,
    `size           ${stats.bytesLabel} (${stats.dbBytes} db + ${stats.walBytes} wal)`,
    `this activation captured ${stats.counters.capturedMessages} messages, ${stats.counters.captureFailures} failure(s)`,
  ].join('\n');
}
