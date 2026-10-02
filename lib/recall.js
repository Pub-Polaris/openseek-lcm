/**
 * The automatic-recall decision for one step.
 *
 * This is the Harness counterpart of `opencode-lcm`'s
 * `experimental.chat.messages.transform`: take the user input that is about to
 * enter the step, use it as an archive query, and decide whether to append one
 * recalled-context message.
 *
 * The logic lives here rather than inline in the plugin entry so it can be
 * tested without a live Harness: everything it touches arrives as arguments.
 */

import { randomUUID } from 'node:crypto';

import { deepFreeze, pluralize, truncate } from './text.js';

/** Read a possibly-undeclared Cordis context property without throwing. */
function safeRead(read) {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** Text of a message's text blocks, used to build a retrieval query. */
export function messageText(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter((text) => text.length > 0)
    .join('\n');
}

/**
 * Whether a message came from the Harness or another plugin rather than the user.
 *
 * The Harness and other plugins tag their own user-role messages with a
 * `source.kind` (`runtime-context`, `system-prompt`, a skill catalog, this
 * plugin's `lcm-recall`); only a missing kind or the literal `'user'` is real
 * operator input. A blocklist would silently admit every future injector -- which
 * is exactly how the `runtime-context` envelope became the recall query.
 */
export function isInjectedMessage(message) {
  const kind = message?.source?.kind;
  return typeof kind === 'string' && kind.length > 0 && kind !== 'user';
}

/**
 * Find the user message that anchors recall: the newest user-role message that
 * the user actually typed.
 *
 * Continuation steps claim no new prompt, so they have no anchor and must not
 * re-inject context.
 *
 * @param {Array<object>} messages
 * @returns {object|undefined}
 */
export function findAnchor(messages) {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (candidate?.role === 'user' && !isInjectedMessage(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Build the recalled-context message.
 *
 * `source.kind` is a plugin-owned tag: the Harness validates only that a
 * user-role message's `source` is an object with a non-empty string `kind`, so
 * this is legal, self-identifying, and lets `isInjectedMessage` recognise it on
 * the next step.
 *
 * @param {string} text
 * @param {number} [compactAt] the compaction this message answers, recorded so a
 *   later step can tell from the *committed log* that the note was delivered
 * @returns {object} a frozen user message
 */
export function makeRecallMessage(text, compactAt) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'lcm-recall', form: 'retrieval', ...(compactAt > 0 ? { compactAt } : {}) },
  });
}

/**
 * The id of a message entering the prompt, or undefined when it carries none.
 *
 * Loose on purpose: the Harness assigns message ids, so this must not invent one.
 */
function messageIdOf(message) {
  const id = message?.id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/**
 * The compaction a committed recall message answered, or 0.
 *
 * Reading delivery out of the committed log fixes both directions of the old
 * bookkeeping at once. The log is durable, so a restart cannot re-deliver a note
 * the model already saw; and it is only written when the Harness commits the
 * step, so a rejected or aborted step leaves the note deliverable instead of
 * consuming it. This is the sole delivery source -- `planRecall` keeps no
 * in-memory marker, because any such marker is wrong about one of those two
 * cases by construction.
 *
 * @param {Array<object>} surfaceMessages the current model surface
 * @returns {number} newest committed recall marker
 */
export function deliveredCompactionFrom(surfaceMessages) {
  let newest = 0;
  const list = Array.isArray(surfaceMessages) ? surfaceMessages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const source = list[index]?.source;
    if (source?.kind !== 'lcm-recall') continue;
    if (Number.isFinite(source.compactAt) && source.compactAt > newest) newest = source.compactAt;
  }
  return newest;
}

/** Every id in a message list, for the "already in the prompt" exclusion set. */
function messageIdsOf(messages, into) {
  for (const message of Array.isArray(messages) ? messages : []) {
    const id = messageIdOf(message);
    if (id) into.add(id);
  }
  return into;
}

/**
 * How many of this plugin's own recall messages are already in the prompt.
 *
 * `maxRecallMessagesPerSession` was declared, resolved and reported nowhere: it
 * is enforced here, against the durable surface rather than a per-process
 * counter, so a restart cannot silently raise the ceiling.
 *
 * @param {Array<object>} surfaceMessages the current model surface
 * @returns {number}
 */
export function recallMessagesIn(surfaceMessages) {
  let count = 0;
  for (const message of Array.isArray(surfaceMessages) ? surfaceMessages : []) {
    if (message?.source?.kind === 'lcm-recall') count += 1;
  }
  return count;
}

/**
 * Hard bound on the compaction pointer.
 *
 * A single compaction in the live archive shadows 676-1094 messages and ~300k
 * tokens, so the pointer must never grow into a payload: it is a signpost to the
 * progressive path, not a way to dump history back into the prompt.
 */
const POINTER_CHAR_BUDGET = 300;

/**
 * Render the deterministic pointer for the newest compaction.
 *
 * The compaction backend already recorded which seqs left the prompt, so the
 * first turn afterwards needs no search: one line naming the span, the size of
 * what was lost, and the exact way back. `entryNodes` are summary nodes fully
 * contained in the span -- expanding one walks its own levels down to raw text
 * with `includeRaw`, which is the only sane way to traverse ~1,000 messages.
 *
 * @param {{startSeq: number, endSeq: number, count: number, tokens?: number, entryNodes?: string[]}} pointer
 * @returns {string} at most `POINTER_CHAR_BUDGET` characters, carrying no archived content
 */
export function makeCompactionPointer(pointer) {
  const range = `seq ${pointer.startSeq}-${pointer.endSeq}`;
  const tokens = Number.isFinite(pointer.tokens) ? `, ~${pointer.tokens} tokens` : '';
  const nodes = Array.isArray(pointer.entryNodes)
    ? pointer.entryNodes.filter((id) => typeof id === 'string' && id.length > 0)
    : [];

  const head = `[lcm: compaction pointer] The last compaction removed ${pointer.count} archived ${pluralize(pointer.count, 'message')} (${range}${tokens}) from this prompt.`;
  const how =
    nodes.length > 0
      ? ` Read them back with lcm_expand, starting at nodeID ${nodes.map((id) => `"${id}"`).join(' or ')}; includeRaw=true returns raw text.`
      : ` Read them back with lcm_grep({ query: "<your terms>", scope: "session" }) over ${range}, then lcm_expand on a node it names.`;
  return truncate(`${head}${how}`, POINTER_CHAR_BUDGET);
}

/**
 * The message body for the first turn after a compaction.
 *
 * The pointer comes first and the durable resume note follows as its own
 * paragraph, in one injected message: the smallest change that keeps
 * `consumedResumeAt`, the note's rendering and the "one message per step" shape
 * exactly as they were. Both are delivered regardless of
 * `automaticRetrieval.enabled`; a compaction with no usable inverse map degrades
 * to the note alone rather than to nothing.
 *
 * @returns {string|undefined}
 */
function resumeTurnText(store, sessionId, config) {
  const sections = [];
  // Optional call: tolerates a store generation that predates latestCompaction.
  const pointer = store.latestCompaction?.(sessionId);
  if (pointer) sections.push(makeCompactionPointer(pointer));
  const note = store.deriveResumeNote(sessionId);
  if (note) sections.push(note);
  if (sections.length === 0) return undefined;
  const text = truncate(sections.join('\n'), config.automaticRetrieval.maxChars);
  return text.length > 0 ? text : undefined;
}

/**
 * Resolve the Agent that owns the current step.
 *
 * The Harness dispatches `agent/pre-step` with the agent as the Cordis scope
 * (`this`) and runs the whole driver inside `agents.withInitiator(agent, …)`,
 * but the dispatcher's payload carries only `{ messages, turn, step, signal }`.
 * All three sources are tried, cheapest first.
 *
 * @param {object} payload the `agent/pre-step` payload
 * @param {unknown} scope the listener's `this` (the dispatching scope)
 * @param {object} ctx the plugin's Cordis context
 * @returns {object|undefined} the owning Agent
 */
export function resolveStepAgent(payload, scope, ctx) {
  if (payload?.agent?.session?.id) return payload.agent;

  const fromScope = safeRead(() => scope?.agent);
  if (fromScope?.session?.id) return fromScope;

  const initiator = safeRead(() => ctx.agents.currentInitiator());
  return initiator?.session?.id ? initiator : undefined;
}

/**
 * Decide whether this step receives recalled archive context.
 *
 * @param {object} input
 * @param {import('./store.js').LcmStore} input.store
 * @param {object} input.config resolved plugin config
 * @param {string} input.sessionId
 * @param {Array<object>} input.messages the messages entering this step
 * @param {Array<object>} [input.surfaceMessages] the session's current model
 *   surface (`ctx.sessionQuery.readSurface(sessionId).events` folded to messages).
 *   This is a dependency, not ambient state: `planRecall` stays testable without
 *   a live Harness, `payload.messages` is only the newly claimed batch and cannot
 *   stand in for it, and the surface is also the only record of whether the resume
 *   note was delivered.
 * @returns {{message: object, hits: Array<object>, consumedResumeAt: number}|undefined}
 *   `undefined` means "leave the step exactly as the Harness decided it"; `hits` is
 *   `[]` on the pointer turn, which injects a deterministic pointer instead of
 *   similarity hits
 */
export function planRecall({ store, config, sessionId, messages, surfaceMessages }) {
  if (!store?.ready) return undefined;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;

  const anchor = findAnchor(messages);
  if (!anchor) return undefined;

  const query = messageText(anchor);
  if (query.trim().length === 0) return undefined;

  // A compaction shrinks the prompt; the first turn afterwards carries the
  // resume note so important archived context survives the shrink.
  const compactedAt = store.sessionRow(sessionId)?.compacted_at ?? 0;
  // Delivery is read from the committed log and nowhere else. That is the only
  // record that cannot be wrong in either direction: an in-memory "already
  // delivered" map re-delivered the note after every restart (or never, if the
  // map outlived the note), and a marker advanced before the Harness committed
  // the step consumed a note that was never shown. A recall message carrying this
  // compaction is *in the prompt*, so the note must not repeat; a step that was
  // rejected or aborted left no such message, so the note stays deliverable.
  const deliveredAt = deliveredCompactionFrom(surfaceMessages);
  const includeResume = compactedAt > deliveredAt;

  // That turn is answered deterministically and deliberately ignores
  // `automaticRetrieval.enabled`: the compaction backend already recorded exactly
  // which seqs the prompt lost, so a pointer costs no search and cannot inject
  // unrelated boilerplate.
  if (includeResume) {
    const text = resumeTurnText(store, sessionId, config);
    if (text) return { message: makeRecallMessage(text, compactedAt), hits: [], consumedResumeAt: compactedAt };
    // Nothing to say at all: fall through rather than inventing a pointer.
  }

  // Similarity retrieval is opt-in: the Harness delivers its runtime context as
  // its own inert `runtime-context` message, and treating that envelope as the
  // anchor made the query harness boilerplate.
  if (!config.automaticRetrieval.enabled) return undefined;

  // Messages still verbatim in the working context must not be recalled. The
  // fresh tail is only the newest few archived rows, while the model surface is
  // the whole prompt the Harness is about to send -- excluding only the former
  // re-injected messages the model could already read.
  const fresh = new Set(store.recentMessageIds(sessionId, config.freshTailMessages));
  messageIdsOf(surfaceMessages, fresh);

  // `maxRecallMessagesPerSession` is a real ceiling, not documentation: without
  // it a long session accumulates one injected block per turn forever.
  const cap = config.maxRecallMessagesPerSession;
  if (Number.isFinite(cap) && cap > 0 && recallMessagesIn(surfaceMessages) >= cap) {
    store.counters.recallCapReached = (store.counters.recallCapReached ?? 0) + 1;
    return undefined;
  }

  const recall = store.automaticRetrieval({ sessionId, query, freshMessageIds: fresh, includeResume: false });
  if (!recall) return undefined;

  return { message: makeRecallMessage(recall.text), hits: recall.hits, consumedResumeAt: 0 };
}
