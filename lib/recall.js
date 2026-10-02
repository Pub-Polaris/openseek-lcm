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

import { deepFreeze } from './text.js';

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

/** Whether a message came from the Harness or this plugin rather than the user. */
export function isInjectedMessage(message) {
  const kind = message?.source?.kind;
  return kind === 'lcm-recall' || kind === 'system-prompt';
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
 * @returns {object} a frozen user message
 */
export function makeRecallMessage(text) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'lcm-recall', form: 'retrieval' },
  });
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
 * @param {Map<string, number>} [input.resumeDelivered] last delivered `compacted_at` per session
 * @returns {{message: object, hits: Array<object>, consumedResumeAt: number}|undefined}
 *   `undefined` means "leave the step exactly as the Harness decided it"
 */
export function planRecall({ store, config, sessionId, messages, resumeDelivered }) {
  if (!store?.ready) return undefined;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;

  const anchor = findAnchor(messages);
  if (!anchor) return undefined;

  const query = messageText(anchor);
  if (query.trim().length === 0) return undefined;

  // Messages still verbatim in the working context must not be recalled.
  const fresh = new Set(store.recentMessageIds(sessionId, config.freshTailMessages));

  // A compaction shrinks the prompt; the first turn afterwards carries the
  // resume note so important archived context survives the shrink.
  const compactedAt = store.sessionRow(sessionId)?.compacted_at ?? 0;
  const deliveredAt = resumeDelivered?.get(sessionId) ?? 0;
  const includeResume = compactedAt > deliveredAt;

  const recall = store.automaticRetrieval({ sessionId, query, freshMessageIds: fresh, includeResume });
  if (!recall) return undefined;

  return {
    message: makeRecallMessage(recall.text),
    hits: recall.hits,
    consumedResumeAt: includeResume ? compactedAt : 0,
  };
}
