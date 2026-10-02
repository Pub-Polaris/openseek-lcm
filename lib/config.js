/**
 * Configuration resolution for the LCM plugin.
 *
 * Mirrors `opencode-lcm`'s `resolveOptions()`: every field is optional, every
 * value is normalized defensively, and an invalid value falls back to the
 * default rather than failing activation. A plugin that throws during `apply`
 * disappears from the profile with no readable error, so nothing here may throw.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

const SCOPE_NAMES = new Set(['session', 'root', 'worktree', 'all']);

/**
 * Locate the Harness home directory, which is where the archive belongs.
 *
 * `DSH_HOME` is exported into shell calls but is deliberately *not* present in
 * the Host process environment, so it cannot be the only source: relying on it
 * alone silently drops the archive into the Host working directory, which is the
 * profile directory. The Host working directory is `<home>/profiles/<name>` — a
 * stable layout fact to derive from — and the OS default (`~/.dsh`) is the last
 * resort.
 *
 * The environment, working directory and OS home are injectable so this can be
 * tested without touching the real machine.
 *
 * @param {object} [sources]
 * @param {Record<string, string|undefined>} [sources.env]
 * @param {string} [sources.cwd]
 * @param {() => string} [sources.home]
 * @returns {string|undefined} absolute home directory, when one can be determined
 */
export function resolveHomeDir(sources = {}) {
  const env = sources.env ?? process.env;
  const fromEnv = env?.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;

  const cwd = sources.cwd ?? process.cwd();
  const profileLayout = /^(.*)[\\/]profiles[\\/][^\\/\\]+$/.exec(cwd ?? '');
  if (profileLayout && profileLayout[1].length > 0) return profileLayout[1];

  try {
    return join((sources.home ?? homedir)(), '.dsh');
  } catch {
    return undefined;
  }
}

/** Defaults, matching upstream opencode-lcm where a field has an analogue. */
export const DEFAULT_CONFIG = {
  storeDir: undefined,
  capture: {
    enabled: true,
    includeToolResults: true,
    includeSystemMessages: false,
    /** Per-message text cap before the overflow is externalized as an artifact. */
    maxTextCharsPerMessage: 60_000,
  },
  scopeDefaults: { grep: 'session', describe: 'session' },
  automaticRetrieval: {
    /**
     * Similarity retrieval is off by default.
     *
     * The Harness delivers its runtime context as its own inert `runtime-context`
     * user-role message, and anchor selection mistook that envelope for operator
     * input, so the query became machine-generated harness boilerplate and the
     * user's own language could contribute no terms at all. Measured in a live
     * session: 74 raw candidates, 3 injected hits, all of them other turns'
     * identical envelope -- ~900 chars of context the model cannot distinguish
     * from what it already sees. The deterministic compaction pointer and the
     * resume note are the intended replacement and do not depend on this flag.
     */
    enabled: false,
    maxChars: 900,
    minTokens: 2,
    maxMessageHits: 2,
    maxSummaryHits: 1,
    maxArtifactHits: 1,
    scopeOrder: ['session', 'root', 'worktree'],
    scopeBudgets: { session: 16, root: 12, worktree: 8, all: 6 },
    stop: { targetHits: 3, stopOnFirstScopeWithHits: false },
  },
  summary: {
    strategy: 'deterministic-v3',
    perMessageBudget: 110,
    summaryCharBudget: 1500,
    /** Child summaries folded into one parent once a level reaches this size. */
    levelSize: 6,
    /** Archived messages are summarized once this many exist past the fresh tail. */
    minMessagesForTransform: 16,
  },
  freshTailMessages: 10,
  partCharBudget: 160,
  largeContentThreshold: 1200,
  artifactPreviewChars: 220,
  artifactViewChars: 4000,
  systemHint: true,
  /**
   * Prompt section order for the hint. First-party orders run up to 10200
   * (harness source at 10000); 9000 places the hint with the other model
   * guidance and before the environment suffix.
   */
  systemHintOrder: 9000,
  /** Cap on auto-recall context messages retained per session (defensive). */
  maxRecallMessagesPerSession: 200,
  /**
   * Whether the model-facing tools may use the cross-project `all` scope.
   *
   * One Harness home is shared across projects, so `all` resolves to every
   * archived session in it with no cwd, worktree or profile filter: a
   * model-driven call could pull another project's conversation into this one,
   * and the `IN (...)` list is unbounded. Off unless an operator opts in.
   */
  allowScopeAll: false,
  retention: { staleSessionDays: undefined, deletedSessionDays: 30, orphanBlobDays: 14 },
  privacy: { excludeToolPrefixes: [], excludePathPatterns: [], redactPatterns: [] },
  tools: { enabled: true, expose: undefined },
};

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function asBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function asNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asNonNegativeNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function asOptionalNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function asStringArray(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  const next = value.filter((item) => typeof item === 'string' && item.length > 0);
  return next.length > 0 ? next : fallback;
}

function asOptionalStringArray(value) {
  if (!Array.isArray(value)) return undefined;
  const next = value.filter((item) => typeof item === 'string' && item.length > 0);
  return next.length > 0 ? next : undefined;
}

function asScopeName(value, fallback) {
  return SCOPE_NAMES.has(value) ? value : fallback;
}

function asScopeOrder(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  const result = [];
  for (const item of value) {
    if (!SCOPE_NAMES.has(item) || result.includes(item)) continue;
    result.push(item);
  }
  return result.length > 0 ? result : fallback;
}

function asScopeBudgets(value, fallback) {
  const record = asRecord(value);
  const result = {};
  for (const scope of SCOPE_NAMES) {
    result[scope] = asNonNegativeNumber(record?.[scope], fallback[scope]);
  }
  return result;
}

function asSummaryStrategy(value, fallback) {
  return value === 'deterministic-v1' || value === 'deterministic-v2' || value === 'deterministic-v3'
    ? value
    : fallback;
}

/**
 * Normalize one plugin Config payload.
 *
 * @param {unknown} raw the `config` block from the profile patch row
 * @param {{homeDir?: string}} [context] resolved host facts
 * @returns {typeof DEFAULT_CONFIG & {storeDir: string}}
 */
export function resolveConfig(raw, context = {}) {
  const root = asRecord(raw) ?? {};
  const capture = asRecord(root.capture);
  const auto = asRecord(root.automaticRetrieval);
  const autoStop = asRecord(auto?.stop);
  const summary = asRecord(root.summary);
  const retention = asRecord(root.retention);
  const privacy = asRecord(root.privacy);
  const tools = asRecord(root.tools);
  const scopeDefaults = asRecord(root.scopeDefaults);

  const homeDir = typeof context.homeDir === 'string' && context.homeDir.length > 0 ? context.homeDir : undefined;

  return {
    storeDir:
      typeof root.storeDir === 'string' && root.storeDir.length > 0
        ? root.storeDir
        : homeDir
          ? // DSH's own plugin-data area, namespaced to this plugin. A bare
            // `<home>/lcm` directory would sit next to opencode-lcm's `.lcm`
            // store and invites exactly the wrong database to be opened.
            join(homeDir, 'storages', 'dsh-plugin-lcm')
          : undefined,
    capture: {
      enabled: asBoolean(capture?.enabled, DEFAULT_CONFIG.capture.enabled),
      includeToolResults: asBoolean(capture?.includeToolResults, DEFAULT_CONFIG.capture.includeToolResults),
      includeSystemMessages: asBoolean(capture?.includeSystemMessages, DEFAULT_CONFIG.capture.includeSystemMessages),
      maxTextCharsPerMessage: asNonNegativeNumber(
        capture?.maxTextCharsPerMessage,
        DEFAULT_CONFIG.capture.maxTextCharsPerMessage,
      ),
    },
    scopeDefaults: {
      grep: asScopeName(scopeDefaults?.grep, DEFAULT_CONFIG.scopeDefaults.grep),
      describe: asScopeName(scopeDefaults?.describe, DEFAULT_CONFIG.scopeDefaults.describe),
    },
    automaticRetrieval: {
      enabled: asBoolean(auto?.enabled, DEFAULT_CONFIG.automaticRetrieval.enabled),
      maxChars: asNonNegativeNumber(auto?.maxChars, DEFAULT_CONFIG.automaticRetrieval.maxChars),
      minTokens: asNonNegativeNumber(auto?.minTokens, DEFAULT_CONFIG.automaticRetrieval.minTokens),
      maxMessageHits: asNonNegativeNumber(auto?.maxMessageHits, DEFAULT_CONFIG.automaticRetrieval.maxMessageHits),
      maxSummaryHits: asNonNegativeNumber(auto?.maxSummaryHits, DEFAULT_CONFIG.automaticRetrieval.maxSummaryHits),
      maxArtifactHits: asNonNegativeNumber(auto?.maxArtifactHits, DEFAULT_CONFIG.automaticRetrieval.maxArtifactHits),
      scopeOrder: asScopeOrder(auto?.scopeOrder, DEFAULT_CONFIG.automaticRetrieval.scopeOrder),
      scopeBudgets: asScopeBudgets(auto?.scopeBudgets, DEFAULT_CONFIG.automaticRetrieval.scopeBudgets),
      stop: {
        targetHits: asNonNegativeNumber(autoStop?.targetHits, DEFAULT_CONFIG.automaticRetrieval.stop.targetHits),
        stopOnFirstScopeWithHits: asBoolean(
          autoStop?.stopOnFirstScopeWithHits,
          DEFAULT_CONFIG.automaticRetrieval.stop.stopOnFirstScopeWithHits,
        ),
      },
    },
    summary: {
      strategy: asSummaryStrategy(summary?.strategy, DEFAULT_CONFIG.summary.strategy),
      perMessageBudget: asNonNegativeNumber(summary?.perMessageBudget, DEFAULT_CONFIG.summary.perMessageBudget),
      summaryCharBudget: asNonNegativeNumber(summary?.summaryCharBudget, DEFAULT_CONFIG.summary.summaryCharBudget),
      levelSize: Math.max(2, asNonNegativeNumber(summary?.levelSize, DEFAULT_CONFIG.summary.levelSize)),
      minMessagesForTransform: asNonNegativeNumber(
        summary?.minMessagesForTransform,
        DEFAULT_CONFIG.summary.minMessagesForTransform,
      ),
    },
    freshTailMessages: asNonNegativeNumber(root.freshTailMessages, DEFAULT_CONFIG.freshTailMessages),
    partCharBudget: asNonNegativeNumber(root.partCharBudget, DEFAULT_CONFIG.partCharBudget),
    largeContentThreshold: asNonNegativeNumber(root.largeContentThreshold, DEFAULT_CONFIG.largeContentThreshold),
    artifactPreviewChars: asNonNegativeNumber(root.artifactPreviewChars, DEFAULT_CONFIG.artifactPreviewChars),
    artifactViewChars: asNonNegativeNumber(root.artifactViewChars, DEFAULT_CONFIG.artifactViewChars),
    systemHint: asBoolean(root.systemHint, DEFAULT_CONFIG.systemHint),
    systemHintOrder: asNumber(root.systemHintOrder, DEFAULT_CONFIG.systemHintOrder),
    maxRecallMessagesPerSession: asNonNegativeNumber(
      root.maxRecallMessagesPerSession,
      DEFAULT_CONFIG.maxRecallMessagesPerSession,
    ),
    allowScopeAll: asBoolean(root.allowScopeAll, DEFAULT_CONFIG.allowScopeAll),
    retention: {
      staleSessionDays:
        retention?.staleSessionDays === undefined
          ? DEFAULT_CONFIG.retention.staleSessionDays
          : asOptionalNonNegativeNumber(retention.staleSessionDays),
      deletedSessionDays:
        retention?.deletedSessionDays === undefined
          ? DEFAULT_CONFIG.retention.deletedSessionDays
          : asOptionalNonNegativeNumber(retention.deletedSessionDays),
      orphanBlobDays:
        retention?.orphanBlobDays === undefined
          ? DEFAULT_CONFIG.retention.orphanBlobDays
          : asOptionalNonNegativeNumber(retention.orphanBlobDays),
    },
    privacy: {
      excludeToolPrefixes: asStringArray(privacy?.excludeToolPrefixes, DEFAULT_CONFIG.privacy.excludeToolPrefixes),
      excludePathPatterns: asStringArray(privacy?.excludePathPatterns, DEFAULT_CONFIG.privacy.excludePathPatterns),
      redactPatterns: asStringArray(privacy?.redactPatterns, DEFAULT_CONFIG.privacy.redactPatterns),
    },
    tools: {
      enabled: asBoolean(tools?.enabled, DEFAULT_CONFIG.tools.enabled),
      expose: asOptionalStringArray(tools?.expose),
    },
  };
}
