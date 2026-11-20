/**
 * Text utilities for the LCM archive.
 *
 * Ported from `opencode-lcm`'s `src/utils.ts`, with a search layer rebuilt for
 * CJK. Upstream only recognizes `[a-z0-9_]+` runs, so a Chinese query collapses
 * to zero tokens and retrieval silently stops working. Two further facts shape
 * the design here:
 *
 *   - FTS5's default `unicode61` tokenizer treats a whole run of Han characters
 *     as ONE token, so `无损上下文记忆` is unsearchable by `上下文`.
 *   - The `trigram` tokenizer fixes that for three or more characters but cannot
 *     represent a two-character token at all — and two characters is the normal
 *     length of a Chinese word (召回, 诊断, 记忆, 索引, 归档…).
 *
 * So the archive does not rely on a tokenizer's script handling at all: text is
 * exploded into ordered n-grams sized per script (`explodeForIndex`) and indexed
 * with `unicode61`, and a query becomes the matching gram phrase
 * (`buildFtsQuery`). "Does this substring occur?" then becomes "does this gram
 * sequence occur adjacently?", which holds for Latin substrings, two-character
 * Chinese words, and longer Chinese runs alike.
 */

import { createHash } from 'node:crypto';

/**
 * Slice by code point instead of by UTF-16 code unit.
 *
 * A JS string is a sequence of UTF-16 code units, so a cut can land between the two
 * halves of a surrogate pair and leave one half in the output. `JSON.stringify`
 * then writes it as `\ud83e` -- legal JSON, but the API rejects the *whole* request
 * body, not just that one string, and the session becomes unusable.
 *
 * The axis is code units, not bytes: every character above U+FFFF is two units, so
 * this covers PUA-Ext A/B (`U+F0000`, `U+100000`) exactly like emoji. BMP PUA
 * (`U+E000`) is one unit and can never be cut, even though its UTF-8 form is three
 * bytes.
 *
 * An orphaned half is dropped rather than kept: it cannot be sent anyway, and
 * keeping it only moves the failure to the caller.
 *
 * @param {string} text
 * @param {number} start
 * @param {number} [end] defaults to the end of the string
 * @returns {string}
 */
export function safeSlice(text, start, end) {
  if (typeof text !== 'string') return '';
  const length = text.length;
  const clamp = (value) => Math.max(0, Math.min(Number.isFinite(value) ? Math.trunc(value) : 0, length));
  let from = clamp(start);
  let to = end === undefined ? length : clamp(end);

  if (from > 0 && from < length) {
    const code = text.charCodeAt(from);
    if (code >= 0xdc00 && code <= 0xdfff) from += 1;
  }
  // `to === length` is already a boundary: a string does not end mid-pair unless it
  // was broken on the way in.
  if (to > from && to < length) {
    const code = text.charCodeAt(to - 1);
    if (code >= 0xd800 && code <= 0xdbff) to -= 1;
  }

  return to > from ? text.slice(from, to) : '';
}

/** Shorten text to `limit` characters, appending an ellipsis when cut. */
export function truncate(text, limit) {
  if (typeof text !== 'string') return '';
  if (!Number.isFinite(limit) || limit <= 0) return '';
  if (text.length <= limit) return text;
  if (limit === 1) return '…';
  return `${safeSlice(text, 0, limit - 1)}…`;
}

/** Collapse every whitespace run to one space and trim. */
export function collapseWhitespace(text) {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
}

/** Take an even head/tail sample when text exceeds `limit`. */
export function headTail(text, limit) {
  if (typeof text !== 'string' || text.length <= limit) return text ?? '';
  const half = Math.floor((limit - 5) / 2);
  return `${safeSlice(text, 0, half)}\n…\n${safeSlice(text, text.length - half)}`;
}

/** Stable short identifier used in model-facing tool output. */
export function shortNodeId(nodeId) {
  return typeof nodeId === 'string' && nodeId.length > 10 ? nodeId.slice(0, 10) : String(nodeId ?? '');
}

/** Content hash for artifact blob deduplication. */
export function hashContent(content) {
  return createHash('sha256').update(String(content), 'utf8').digest('hex');
}

// ---------------------------------------------------------------- indexing

/**
 * The three run classes the index recognises, and the width each one gets.
 *
 * There is deliberately no code-point table.
 *
 * A hardcoded set of code points is a snapshot of Unicode, and it starts decaying
 * the moment it is written. The previous table stopped at CJK Extension B, so
 * 32,223 assigned Han characters never became a run at all -- they could not be
 * indexed or searched, and a query for them returned "no match", which cannot be
 * told apart from "this never existed". It also dropped Greek and Cyrillic prose
 * entirely, because those scripts matched none of the three classes.
 *
 * The classes below ask the runtime instead. `\p{L}`, `\p{N}`, `\p{M}` and
 * `\p{Extended_Pictographic}` follow the Unicode version of the ICU that ships with
 * Node, so a new Han extension, or a script nobody has heard of yet, is covered
 * without a code change here. The widths are the only policy, and policy does not
 * decay: ASCII words want trigrams, everything else wants bigrams, and a symbol is
 * its own token.
 *
 * Measured on the live archive: 32,223 previously-unindexed characters become
 * findable, and the exploded index grows by 0.1%.
 */
export const CJK_GRAM = 2;
export const LATIN_GRAM = 3;
/** Symbols and emoji are tokens on their own: a single `😀` has to be findable. */
export const SYMBOL_GRAM = 1;

/** ASCII words. Tried first, so a run that starts with ASCII stays a word. */
const LATIN_RUN = '[a-z0-9_]+';
/**
 * Every other letter, number and combining mark.
 *
 * This class necessarily also matches ASCII (there is no portable "letter but not
 * ASCII" class), and the alternation above claims ASCII before it gets a turn -- so
 * a wide run always starts at a non-ASCII character. It may continue into ASCII
 * afterwards (`第3章` is one run), which is what makes a phrase that mixes scripts
 * searchable as a phrase.
 */
const WIDE_CLASS = '[\\p{L}\\p{N}\\p{M}]';
const WIDE_RUN = `${WIDE_CLASS}+`;
/**
 * Pictographs, plus the arrow block this house uses as prose punctuation.
 * `unicode61` would drop both, so they are mapped to `sym<hex>` at index time.
 */
const SYMBOL_RUN = '[\\p{Extended_Pictographic}\\u2190-\\u21ff]+';

/**
 * Wide runs as they appear in a scan: only those that *start* non-ASCII.
 *
 * `WIDE_RUN` also matches ASCII (the character class has no way to say "letter but
 * not Latin"), so a stray scan over an English sentence would treat `hello` as a
 * bigram run and add `he el ll lo` to the scoring tokens and phrases. The lookahead
 * pins a wide run to its real start.
 */
const WIDE_SCAN = new RegExp(`(?![\\x00-\\x7f])${WIDE_RUN}`, 'gu');
const SYMBOL_ANY = new RegExp(`^${SYMBOL_RUN}`, 'u');
const ASCII_ANY = /^[\x00-\x7f]/;
/** One ordered scan over all three classes, so run order is preserved. */
const RUN_SOURCE = `(${LATIN_RUN})|(${WIDE_RUN})|(${SYMBOL_RUN})`;

/**
 * Fold a string into the form the index and the query share.
 *
 * NFKC turns full-width forms into ASCII (`ＡＢＣ` → `ABC`, `１２３` → `123`) and
 * composes compatibility characters, which is what makes a query typed in a
 * different width still reach the same row. Folding happens on both sides -- the
 * indexed text and the query -- because folding only one side would be a new way
 * to miss.
 *
 * @param {string} text
 * @returns {string}
 */
export function foldText(text) {
  if (typeof text !== 'string' || text.length === 0) return '';
  try {
    return text.normalize('NFKC');
  } catch {
    return text;
  }
}

/**
 * Whether a run is a wide (bigram) run.
 *
 * The name is historical -- it used to test a CJK range table. A run is wide when it
 * does not start with ASCII: the alternation tries the Latin class first at every
 * position, so anything that reaches the wide class starts at a non-ASCII character.
 */
export function isCjkRun(run) {
  return typeof run === 'string' && run.length > 0 && !ASCII_ANY.test(run);
}

/** Whether a run is a symbol/emoji run (single-code-point width). */
export function isSymbolRun(run) {
  return typeof run === 'string' && run.length > 0 && SYMBOL_ANY.test(run);
}

/** The gram width this run is indexed at. */
export function gramWidthOf(run) {
  if (isSymbolRun(run)) return SYMBOL_GRAM;
  return isCjkRun(run) ? CJK_GRAM : LATIN_GRAM;
}

/**
 * Split text into ordered lowercase runs: Latin/digit/underscore words, CJK runs,
 * and symbol/emoji runs. Everything else (spaces, punctuation) is a separator.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function runsOf(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const pattern = new RegExp(RUN_SOURCE, 'gu');
  return [...foldText(text).toLowerCase().matchAll(pattern)].map((match) => match[0]);
}

/**
 * Sliding windows of `width` code points over one run.
 *
 * Code points, not UTF-16 units: an emoji is two units, so slicing by index would
 * split a surrogate pair into two halves that match nothing.
 *
 * A run shorter than the width is kept whole, so a two-character Latin word
 * remains findable by its own text.
 *
 * @param {string} run
 * @param {number} width
 * @returns {string[]}
 */
export function gramsOf(run, width) {
  if (typeof run !== 'string' || run.length === 0) return [];
  const points = Array.from(run);
  if (points.length <= width) return [run];
  const out = [];
  for (let index = 0; index + width <= points.length; index += 1) {
    out.push(points.slice(index, index + width).join(''));
  }
  return out;
}

/**
 * Build the text that is actually stored in the FTS tables.
 *
 * Each run contributes its ordered n-grams, space-separated. Adjacency inside a
 * run is what makes phrase matching work; runs are separated by a single space,
 * and the re-ranker checks the original text, so a phrase cannot silently drift
 * across a run boundary into a false positive.
 *
 * @param {string} text
 * @returns {string}
 */
export function explodeForIndex(text) {
  if (typeof text !== 'string' || text.length === 0) return '';
  const pieces = [];
  for (const run of runsOf(text)) {
    // Symbols go through the ASCII stand-in: `unicode61` would drop them entirely.
    if (isSymbolRun(run)) pieces.push(symbolTokens(run).join(' '));
    else pieces.push(gramsOf(run, gramWidthOf(run)).join(' '));
  }
  return pieces.join(' ');
}

/**
 * Whether the index can represent this run at all.
 *
 * A run shorter than its script's gram width is not stored as grams at all:
 * `explodeForIndex` keeps such a run whole, so the index holds one token for it
 * and `runExpression` asks for that same single token. The expression is valid
 * but can only ever match a document whose *entire* run is that character, which
 * is not what the query means. A single Han character is the common case: it is
 * a real word (`上`), but the index stores bigrams, so `buildFtsQuery('上')`
 * cannot find `上下文记忆`. Latin runs below three characters have the same
 * problem.
 *
 * @param {string} run
 * @returns {boolean}
 */
export function indexCanRepresentRun(run) {
  if (typeof run !== 'string' || run.length === 0) return false;
  return Array.from(run).length >= gramWidthOf(run);
}

/**
 * Ordered runs of a query that the n-gram index cannot represent.
 *
 * These are exactly the terms a substring scan exists for, so a caller that can
 * scan should do so whenever this is non-empty -- an index hit on some *other*
 * term of the same query is not evidence that this one was answered.
 *
 * @param {string} query
 * @returns {string[]}
 */
export function unindexableRuns(query) {
  return runsOf(query).filter((run) => !indexCanRepresentRun(run));
}

/**
 * ASCII stand-ins for a symbol run.
 *
 * FTS5's `unicode61` tokenizer only keeps word characters, so an emoji indexes as
 * nothing at all -- the row would be unfindable however it was exploded. Mapping
 * each code point to `sym<hex>` keeps the term inside what the tokenizer accepts,
 * and both sides of the index share this function, so they cannot disagree.
 */
export function symbolTokens(run) {
  if (typeof run !== 'string' || run.length === 0) return [];
  return Array.from(run).map((point) => `sym${point.codePointAt(0).toString(16)}`);
}

/** The FTS5 phrase expression that matches one run in the exploded index. */
export function runExpression(run) {
  if (isSymbolRun(run)) return `"${symbolTokens(run).join(' ')}"`;
  const grams = gramsOf(run, isCjkRun(run) ? CJK_GRAM : LATIN_GRAM);
  return `"${grams.join(' ').replace(/"/g, '""')}"`;
}

/**
 * Split a query into scoring tokens.
 *
 * Latin runs stay whole; CJK runs are expanded into bigrams so partial Chinese
 * queries still score (`上下文记忆` -> `上下 下文 文记 记忆`).
 *
 * @param {string} query
 * @returns {string[]} unique lowercase tokens
 */
export function tokenizeQuery(query) {
  if (typeof query !== 'string' || query.length === 0) return [];
  const lower = query.toLowerCase();
  const tokens = new Set();

  for (const run of lower.match(/[a-z0-9_]+/g) ?? []) tokens.add(run);
  for (const run of lower.match(WIDE_SCAN) ?? []) {
    if (run.length === 1) {
      tokens.add(run);
      continue;
    }
    for (let index = 0; index < run.length - 1; index += 1) tokens.add(run.slice(index, index + 2));
  }

  return [...tokens];
}

/**
 * Substring phrases taken verbatim from the query.
 *
 * Used for LIKE scanning and snippet centring, where whole runs are wanted
 * rather than index grams.
 *
 * @param {string} query
 * @returns {string[]}
 */
export function queryPhrases(query) {
  if (typeof query !== 'string') return [];
  const phrases = new Set();

  for (const match of query.matchAll(/"([^"]+)"/g)) {
    const inner = collapseWhitespace(match[1]);
    if (inner.length >= 3) phrases.add(inner);
  }

  const remainder = query.replace(/"[^"]+"/g, ' ');
  const lower = remainder.toLowerCase();
  for (const run of lower.match(/[a-z0-9_]+/g) ?? []) {
    if (run.length >= 3) phrases.add(run);
  }
  for (const run of lower.match(WIDE_SCAN) ?? []) {
    if (run.length >= 2) phrases.add(run);
  }

  return [...phrases];
}

/**
 * Build the FTS5 MATCH expression for a query against the exploded index.
 *
 * Candidate gathering is deliberately recall-oriented: quoted groups must all be
 * present, bare terms are OR-ed, and precision comes from the JavaScript
 * re-ranker in `ranking.js`, which scores coverage, phrase hits, role and
 * recency against the *original* text.
 *
 * @param {string} query
 * @returns {string|undefined} MATCH expression, or `undefined` when nothing usable remains
 */
export function buildFtsQuery(query) {
  if (typeof query !== 'string' || query.length === 0) return undefined;
  const clauses = [];

  const quoted = [];
  for (const match of query.matchAll(/"([^"]+)"/g)) {
    const runs = runsOf(match[1]).filter((run) => run.length >= 2 || isCjkRun(run));
    if (runs.length > 0) quoted.push(`(${runs.map(runExpression).join(' AND ')})`);
  }
  if (quoted.length > 0) clauses.push(quoted.join(' AND '));

  const remainder = query.replace(/"[^"]+"/g, ' ');
  // A single Latin character is too common to be a useful filter; a single CJK
  // character is a real word and stays.
  const bare = runsOf(remainder).filter((run) => run.length >= 2 || isCjkRun(run));
  if (bare.length > 0) clauses.push(`(${bare.map(runExpression).join(' OR ')})`);

  if (clauses.length === 0) return undefined;
  return clauses.join(' AND ');
}

/** Escape a value for use inside a SQL LIKE pattern. */
export function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** Extract a relevance snippet centred on the first query hit. */
export function buildSnippet(content, query, limit = 280) {
  const normalized = collapseWhitespace(content);
  if (!normalized) return '';
  if (!query) return truncate(normalized, limit);

  const lower = normalized.toLowerCase();
  const exact = String(query).toLowerCase().trim();
  let index = exact.length > 0 ? lower.indexOf(exact) : -1;
  if (index < 0) {
    for (const token of tokenizeQuery(query)) {
      index = lower.indexOf(token);
      if (index >= 0) break;
    }
  }
  if (index < 0) {
    for (const phrase of queryPhrases(query)) {
      index = lower.indexOf(phrase);
      if (index >= 0) break;
    }
  }
  if (index < 0) return truncate(normalized, limit);

  const start = Math.max(0, index - 90);
  const end = Math.min(normalized.length, index + Math.max(exact.length, 32) + 150);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < normalized.length ? '…' : '';
  return truncate(`${prefix}${safeSlice(normalized, start, end)}${suffix}`, limit);
}

/**
 * Deterministic single-pass compressor.
 *
 * Ported from the intent of upstream's `deterministic-v3` strategy: normalize
 * whitespace, drop low-signal lines, then keep whole leading sentences until the
 * character budget is spent. It is intentionally not a model call.
 */
export function compressText(text, budget, options = {}) {
  const normalized = collapseWhitespace(text);
  if (!normalized) return '';
  if (normalized.length <= budget) return normalized;

  const sentences = normalized
    .split(/(?<=[.!?。！？；;])\s*/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
  const kept = [];
  let used = 0;

  for (const sentence of sentences) {
    if (used + sentence.length > budget && kept.length > 0) break;
    kept.push(sentence);
    used += sentence.length + 1;
    if (used >= budget) break;
  }

  const joined = kept.join(' ');
  if (joined.length === 0) return truncate(normalized, budget);
  if (joined.length >= normalized.length) return truncate(normalized, budget);
  const omitted = normalized.length - joined.length;
  return truncate(`${joined} […${omitted} chars omitted]`, budget);
}

/** `1 turn` / `2 turns` */
export function pluralize(count, singular, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

/** Human-readable byte size. */
export function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const scaled = bytes / 1024 ** exponent;
  return `${exponent === 0 ? bytes : scaled.toFixed(1)} ${units[exponent]}`;
}

/** Epoch milliseconds from whatever a harness timestamp looks like. */
export function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

/** Recursively freeze a value, mirroring the harness's message immutability. */
export function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}
