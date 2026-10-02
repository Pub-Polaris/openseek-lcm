/**
 * Search candidate re-ranking, ported from `opencode-lcm`'s
 * `src/search-ranking.ts`.
 *
 * The score is a weighted sum of source kind, role, exact-phrase match, token
 * coverage, boundary hits and corpus recency. FTS is only used to gather
 * candidates; the ordering the model sees comes from here, which keeps ranking
 * behaviour identical between the FTS path and the LIKE-scan fallback.
 */

import { collapseWhitespace, tokenizeQuery, queryPhrases } from './text.js';

const MESSAGE_BASE_SCORE = 135;
const ARTIFACT_BASE_SCORE = 96;
const SUMMARY_BASE_SCORE = 78;
const USER_ROLE_BONUS = 22;
const ASSISTANT_ROLE_BONUS = 12;
const EXACT_PHRASE_BONUS = 90;
const COVERAGE_MULTIPLIER = 70;
const TOKEN_MATCH_MULTIPLIER = 12;
const TOTAL_HIT_MULTIPLIER = 2;
const BOUNDARY_HIT_MULTIPLIER = 4;
const SNIPPET_EXACT_BONUS = 24;
const SOURCE_ORDER_DECAY_BASE = 18;
const RECENCY_MULTIPLIER = 28;

/**
 * Corpus size below which the commonness ratio is not applied.
 *
 * The check exists to drop genuine stop-words, which needs a corpus large enough
 * for a document-frequency ratio to mean anything.
 */
const COMMONNESS_MIN_CORPUS = 20;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRecencyRange(candidates) {
  let oldest = Number.POSITIVE_INFINITY;
  let newest = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    oldest = Math.min(oldest, candidate.timestamp);
    newest = Math.max(newest, candidate.timestamp);
  }
  if (!Number.isFinite(oldest) || !Number.isFinite(newest)) return { oldest: 0, newest: 0 };
  return { oldest, newest };
}

/**
 * Score one candidate.
 *
 * @param {object} candidate
 * @param {string} candidate.type model-facing hit type (`user`, `assistant`, `tool`, `summary`, `artifact:*`)
 * @param {'message'|'summary'|'artifact'} candidate.sourceKind
 * @param {number} candidate.timestamp
 * @param {number} candidate.sourceOrder
 * @param {string} candidate.content
 * @param {string} candidate.snippet
 * @param {string} query
 * @param {string[]} tokens
 * @param {{oldest:number,newest:number}} recencyRange
 */
function scoreCandidate(candidate, query, tokens, recencyRange) {
  const content = candidate.content.toLowerCase();
  const snippet = candidate.snippet.toLowerCase();
  const base =
    candidate.sourceKind === 'message'
      ? MESSAGE_BASE_SCORE
      : candidate.sourceKind === 'artifact'
        ? ARTIFACT_BASE_SCORE
        : SUMMARY_BASE_SCORE;

  let matchedTokens = 0;
  let totalHits = 0;
  let boundaryHits = 0;

  for (const token of tokens) {
    const hasToken = content.includes(token);
    if (hasToken) matchedTokens += 1;

    // Boundary counting is only meaningful for word-like tokens.
    if (/^[a-z0-9_]+$/.test(token)) {
      const boundaryPattern = new RegExp(`\\b${escapeRegExp(token)}\\b`, 'g');
      const matches = content.match(boundaryPattern)?.length ?? 0;
      boundaryHits += matches;
      totalHits += matches > 0 ? matches : hasToken ? 1 : 0;
    } else {
      totalHits += hasToken ? 1 : 0;
    }
  }

  // Substring occurrences of a full query phrase are a stronger signal than tokens.
  let phraseHits = 0;
  for (const phrase of queryPhrases(query)) {
    if (phrase.length >= 2 && content.includes(phrase)) phraseHits += 1;
  }

  const coverage = tokens.length > 0 ? matchedTokens / tokens.length : 0;
  let score = base;
  if (candidate.sourceKind === 'message') {
    score += candidate.type === 'user' ? USER_ROLE_BONUS : candidate.type === 'assistant' ? ASSISTANT_ROLE_BONUS : 0;
  }
  score += query.length > 0 && content.includes(query) ? EXACT_PHRASE_BONUS : 0;
  score += coverage * COVERAGE_MULTIPLIER;
  score += matchedTokens * TOKEN_MATCH_MULTIPLIER;
  score += phraseHits * TOKEN_MATCH_MULTIPLIER;
  score += Math.min(totalHits, matchedTokens + 2) * TOTAL_HIT_MULTIPLIER;
  score += Math.min(boundaryHits, matchedTokens) * BOUNDARY_HIT_MULTIPLIER;
  score += snippet.includes(query) ? SNIPPET_EXACT_BONUS : 0;
  score += Math.max(0, SOURCE_ORDER_DECAY_BASE - candidate.sourceOrder);
  if (recencyRange.newest > recencyRange.oldest) {
    const ratio = (candidate.timestamp - recencyRange.oldest) / (recencyRange.newest - recencyRange.oldest);
    score += ratio * RECENCY_MULTIPLIER;
  }
  return score;
}

/**
 * Deduplicate, score, sort and trim candidates into model-facing results.
 *
 * @param {Array<object>} candidates
 * @param {string} query
 * @param {number} limit
 * @returns {Array<{id:string,type:string,sessionID?:string,timestamp:number,snippet:string,score:number}>}
 */
export function rankSearchCandidates(candidates, query, limit) {
  const exactQuery = collapseWhitespace(query).toLowerCase();
  const tokens = tokenizeQuery(query);
  const recencyRange = buildRecencyRange(candidates);
  const deduped = new Map();

  for (const candidate of candidates) {
    const score = scoreCandidate(candidate, exactQuery, tokens, recencyRange);
    const key = `${candidate.type}:${candidate.id}`;
    const existing = deduped.get(key);
    if (!existing || score > existing.score || (score === existing.score && candidate.timestamp > existing.timestamp)) {
      deduped.set(key, { ...candidate, score });
    }
  }

  // Score and timestamp are not unique, so the comparison has to end on an id:
  // without it two equally-scored hits can swap places between calls and page 2
  // stops being a continuation of page 1.
  return [...deduped.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.timestamp - a.timestamp ||
        String(a.id).localeCompare(String(b.id)) ||
        String(a.type).localeCompare(String(b.type)),
    )
    .slice(0, Math.max(0, limit))
    .map(({ content, sourceKind, sourceOrder, score, ...result }) => ({ ...result, score }));
}

/**
 * Token frequency filter used before FTS retrieval.
 *
 * Mirrors upstream's `filterTokensByTfidf`: tokens present in almost every
 * document are corpus noise and are dropped, and the remaining tokens are
 * ordered most-informative-first so a scope budget spends on the best ones.
 *
 * @param {{documentFrequency: (token: string) => number, totalDocuments: number, cache?: Map<string, {value:number, at:number}>}} corpus
 * @param {string[]} tokens
 * @param {number} [maxTokens]
 */
export function filterTokensByTfidf(corpus, tokens, maxTokens = 10) {
  const total = Math.max(1, corpus.totalDocuments);
  const now = Date.now();
  const scored = [];
  // Terms that are present but look corpus-common. They are only used as a last
  // resort, so a small archive cannot make recall disappear entirely.
  const common = [];
  // A ratio over a handful of documents is noise: with two messages, any term
  // that appears in both looks "common" even though it is the subject at hand.
  const applyCommonness = total >= COMMONNESS_MIN_CORPUS;

  for (const token of tokens) {
    if (token.length < 2) continue;
    let documentFrequency;
    const cached = corpus.cache?.get(token);
    if (cached && now - cached.at < 5 * 60_000) {
      documentFrequency = cached.value;
    } else {
      documentFrequency = corpus.documentFrequency(token);
      corpus.cache?.set(token, { value: documentFrequency, at: now });
    }
    // Absent from the corpus: it can only ever match nothing, so never query it.
    // IDF alone would rank it highest, because a term that appears nowhere looks
    // maximally rare; most words of a real question are absent, so keeping them
    // would spend the whole retrieval budget on a query that cannot succeed.
    if (documentFrequency <= 0) continue;
    const idf = Math.log((total + 1) / (documentFrequency + 1));
    // A token in more than 80% of documents carries no discriminating power.
    if (applyCommonness && documentFrequency / total > 0.8 && tokens.length > 1) {
      common.push({ token, idf, documentFrequency });
      continue;
    }
    scored.push({ token, idf, documentFrequency });
  }

  // Falling back to the common terms is strictly better than returning nothing:
  // an empty query silently disables recall for the turn.
  const pool = scored.length > 0 ? scored : common;
  pool.sort((a, b) => b.idf - a.idf || a.token.localeCompare(b.token));
  return pool.slice(0, Math.max(1, maxTokens));
}
