/**
 * Privacy controls, ported from `opencode-lcm`'s `src/privacy.ts`.
 *
 * All three controls run *before* content reaches the archive, so exclusion is
 * genuinely non-capturing. `redactPatterns` is intentionally destructive: the
 * replacement is stored, not the original.
 */

export const PRIVACY_REDACTION_TEXT = '[REDACTED]';
export const PRIVACY_REDACTED_PATH_TEXT = '[REDACTED_PATH]';
export const PRIVACY_EXCLUDED_TOOL_OUTPUT = '[Excluded tool payload by lcm privacy policy.]';
export const PRIVACY_EXCLUDED_FILE_CONTENT = '[Excluded file content by lcm privacy policy.]';

/** Keys whose string values are identity, not content, and are never redacted. */
const EXEMPT_STRING_KEYS = new Set([
  'agent', 'artifactId', 'callId', 'fieldName', 'id', 'messageId', 'mime', 'modelId',
  'name', 'nodeId', 'parentId', 'parentSessionId', 'role', 'rootSessionId', 'sessionId',
  'status', 'tool', 'toolCallId', 'type', 'urlScheme', 'kind', 'seq',
]);

function compilePattern(source) {
  try {
    // A pattern that matches the empty string would redact everything.
    if (new RegExp(source, 'u').test('')) return undefined;
    return new RegExp(source, 'gu');
  } catch {
    return undefined;
  }
}

function applyPatterns(value, patterns, replacement) {
  let next = value;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    next = next.replace(pattern, replacement);
  }
  return next;
}

/**
 * Compile the raw privacy config once per activation.
 *
 * @param {{excludeToolPrefixes?: string[], excludePathPatterns?: string[], redactPatterns?: string[]}} options
 */
export function compilePrivacy(options = {}) {
  return {
    excludeToolPrefixes: [...new Set((options.excludeToolPrefixes ?? []).filter((value) => value.length > 0))],
    excludePathPatterns: (options.excludePathPatterns ?? [])
      .map(compilePattern)
      .filter(Boolean),
    redactPatterns: (options.redactPatterns ?? []).map(compilePattern).filter(Boolean),
  };
}

/** Apply redaction then path suppression to one string. */
export function redactText(value, privacy) {
  if (typeof value !== 'string' || value.length === 0) return value;
  const redacted = applyPatterns(value, privacy.redactPatterns, PRIVACY_REDACTION_TEXT);
  return applyPatterns(redacted, privacy.excludePathPatterns, PRIVACY_REDACTED_PATH_TEXT);
}

/**
 * Recursively redact a structured value, leaving identity fields untouched.
 *
 * @template T
 * @param {T} value
 * @param {ReturnType<typeof compilePrivacy>} privacy
 * @param {string} [currentKey]
 * @returns {T}
 */
export function redactStructuredValue(value, privacy, currentKey) {
  if (typeof value === 'string') {
    return currentKey && EXEMPT_STRING_KEYS.has(currentKey) ? value : redactText(value, privacy);
  }
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => redactStructuredValue(entry, privacy, currentKey));
  const entries = Object.entries(value).map(([key, entry]) => [key, redactStructuredValue(entry, privacy, key)]);
  return Object.fromEntries(entries);
}

/** Whether a tool's payload must not be archived at all. */
export function isExcludedTool(toolName, privacy) {
  if (typeof toolName !== 'string') return false;
  return privacy.excludeToolPrefixes.some((prefix) => toolName.startsWith(prefix));
}

/** Whether any candidate path matches a capture-exclusion pattern. */
export function matchesExcludedPath(candidates, privacy) {
  if (privacy.excludePathPatterns.length === 0) return false;
  return candidates.some((candidate) => {
    if (typeof candidate !== 'string' || candidate.length === 0) return false;
    return privacy.excludePathPatterns.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(candidate);
    });
  });
}
