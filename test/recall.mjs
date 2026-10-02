/**
 * Automatic-recall tests.
 *
 * `lib/recall.js` holds the riskiest logic in the plugin: it decides whether a
 * step receives archive context, and it depends on the Agent being resolved from
 * three different places. It is exercised here against a real archive and real
 * store behaviour, so the only thing left to confirm live is the Cordis plumbing.
 *
 *   node test/recall.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveConfig } from '../lib/config.js';
import { findAnchor, isInjectedMessage, makeRecallMessage, messageText, planRecall, resolveStepAgent } from '../lib/recall.js';
import { LcmStore } from '../lib/store.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lcm-recall-'));
let failures = 0;

function check(label, fn) {
  try {
    fn();
    process.stdout.write(`ok   ${label}\n`);
  } catch (error) {
    failures += 1;
    process.stdout.write(`FAIL ${label}\n     ${error?.message ?? error}\n`);
  }
}

const logger = { info: () => {}, warn: (m) => process.stdout.write(`warn ${m}\n`), debug: () => {}, error: () => {} };

const SESSION_ID = 'session-recall-0001';
const header = { version: 4, id: SESSION_ID, createdAt: Date.now(), cwd: 'C:/work', isSeeded: false };
const PHRASE = 'the salmon migration window opens in late autumn';

/** Archive a small but realistic log, including a compaction marker. */
function seed(store) {
  const events = [
    { type: 'session/title', seq: 0, time: 1, data: { title: 'recall fixture' } },
    {
      type: 'user/message',
      seq: 1,
      time: 2,
      data: { id: 'u1', role: 'user', content: [{ type: 'text', text: `Please remember that ${PHRASE}.` }], source: { kind: 'user' } },
    },
    {
      type: 'assistant/message',
      seq: 2,
      time: 3,
      data: {
        message: {
          id: 'a1',
          role: 'assistant',
          content: [{ type: 'text', text: `Noted: ${PHRASE}.` }],
          source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
        },
      },
    },
    {
      type: 'user/message',
      seq: 3,
      time: 4,
      data: {
        id: 'u2',
        role: 'user',
        content: [{ type: 'text', text: '顺便记一下：归档检索的召回诊断很重要。' }],
        source: { kind: 'user' },
      },
    },
    {
      type: 'assistant/message',
      seq: 4,
      time: 5,
      data: {
        message: {
          id: 'a2',
          role: 'assistant',
          content: [{ type: 'text', text: '好的，召回诊断已记录。' }],
          source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
        },
      },
    },
    { type: 'compaction/start', seq: 5, time: 6, data: {} },
    { type: 'compaction/summary', seq: 6, time: 7, data: { summary: 'condensed' } },
    { type: 'compaction/end', seq: 7, time: 8, data: {} },
  ];
  store.capture(header, events);
}

const config = resolveConfig(
  { storeDir: dir, freshTailMessages: 0, automaticRetrieval: { maxChars: 900 } },
  { homeDir: dir },
);
const store = new LcmStore({ config, logger });
store.init();
seed(store);

const userMessage = (text) => ({ id: `u-${text.length}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } });

// ------------------------------------------------------------------ message helpers

check('messageText concatenates only text blocks', () => {
  assert.equal(messageText({ content: [{ type: 'text', text: 'a' }, { type: 'image', attachment: {} }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.equal(messageText({ content: [] }), '');
  assert.equal(messageText(undefined), '');
});

check('isInjectedMessage recognises plugin and harness context', () => {
  assert.equal(isInjectedMessage({ source: { kind: 'lcm-recall' } }), true);
  assert.equal(isInjectedMessage({ source: { kind: 'system-prompt' } }), true);
  assert.equal(isInjectedMessage({ source: { kind: 'user' } }), false);
  assert.equal(isInjectedMessage(undefined), false);
});

check('findAnchor takes the newest genuine user message', () => {
  const messages = [
    userMessage('first'),
    { id: 'a', role: 'assistant', content: [] },
    userMessage('second'),
    { id: 'r', role: 'user', content: [{ type: 'text', text: 'recalled' }], source: { kind: 'lcm-recall' } },
  ];
  assert.equal(messageText(findAnchor(messages)), 'second');
});

check('findAnchor declines a continuation batch', () => {
  const messages = [
    { id: 'a', role: 'assistant', content: [{ type: 'text', text: 'thinking' }] },
    { id: 't', role: 'tool', content: [{ type: 'text', text: 'output' }], source: { kind: 'tool', callId: 'c1' }, toolCallId: 'c1' },
  ];
  assert.equal(findAnchor(messages), undefined);
  // A batch holding only previously injected context is also not an anchor.
  assert.equal(findAnchor([{ id: 'r', role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'lcm-recall' } }]), undefined);
});

check('makeRecallMessage produces a frozen, tagged user message', () => {
  const message = makeRecallMessage('archived text');
  assert.equal(message.role, 'user');
  assert.equal(message.source.kind, 'lcm-recall');
  assert.equal(message.content[0].type, 'text');
  assert.equal(typeof message.id, 'string');
  assert.ok(Object.isFrozen(message), 'message is frozen');
  assert.ok(Object.isFrozen(message.content[0]), 'content blocks are frozen');
});

// ------------------------------------------------------------- agent resolution

check('resolveStepAgent prefers the payload, then the scope, then the initiator', () => {
  const agent = { session: { id: 'session-from-payload' } };
  assert.equal(resolveStepAgent({ agent }, {}, {}), agent, 'payload wins');

  const scoped = { session: { id: 'session-from-scope' } };
  assert.equal(resolveStepAgent({}, { agent: scoped }, {}), scoped, 'scope is the second source');

  const initiated = { session: { id: 'session-from-initiator' } };
  const ctx = { agents: { currentInitiator: () => initiated } };
  assert.equal(resolveStepAgent({}, {}, ctx), initiated, 'the driver initiator is the fallback');

  // A Cordis context throws on an undeclared property; that must not escape.
  const hostileScope = {
    get agent() {
      throw new Error('cannot get property "agent" without inject');
    },
  };
  assert.equal(resolveStepAgent({}, hostileScope, { agents: { currentInitiator: () => undefined } }), undefined);
  assert.equal(resolveStepAgent({}, {}, {}), undefined);
});

// ------------------------------------------------------------------------- plan

check('planRecall injects archived context for a new user turn', () => {
  const plan = planRecall({
    store,
    config,
    sessionId: SESSION_ID,
    messages: [userMessage('when does the salmon migration window open?')],
    resumeDelivered: new Map(),
  });
  assert.ok(plan, 'a plan was produced');
  assert.match(plan.message.content[0].text, /Archived by dsh-lcm/);
  assert.ok(plan.message.content[0].text.length <= config.automaticRetrieval.maxChars, 'respects maxChars');
  assert.ok(plan.hits.length > 0, 'hits were selected');
  assert.equal(plan.message.source.kind, 'lcm-recall');
});

check('planRecall declines a continuation batch and an unknown session', () => {
  assert.equal(
    planRecall({ store, config, sessionId: SESSION_ID, messages: [{ id: 'a', role: 'assistant', content: [] }], resumeDelivered: new Map() }),
    undefined,
    'no anchor -> no plan',
  );
  assert.equal(
    planRecall({ store, config, sessionId: 'session-not-archived', messages: [userMessage('anything at all')], resumeDelivered: new Map() }),
    undefined,
    'unarchived session -> no plan',
  );
  assert.equal(
    planRecall({ store, config, sessionId: SESSION_ID, messages: [userMessage('   ')], resumeDelivered: new Map() }),
    undefined,
    'blank query -> no plan',
  );
});

check('planRecall emits the resume note once after a compaction', () => {
  const delivered = new Map();
  const first = planRecall({
    store,
    config,
    sessionId: SESSION_ID,
    messages: [userMessage('what did we decide about the migration window?')],
    resumeDelivered: delivered,
  });
  assert.ok(first, 'first plan produced');
  assert.ok(first.consumedResumeAt > 0, 'compaction was detected');
  assert.match(first.message.content[0].text, /LCM prototype resume note/);

  // Simulate the caller recording the delivery; the note must not repeat.
  delivered.set(SESSION_ID, first.consumedResumeAt);
  const second = planRecall({
    store,
    config,
    sessionId: SESSION_ID,
    messages: [userMessage('and what about the migration window again?')],
    resumeDelivered: delivered,
  });
  if (second) {
    assert.equal(second.consumedResumeAt, 0, 'the note is not re-consumed');
    assert.doesNotMatch(second.message.content[0].text, /LCM prototype resume note/);
  }
});

check('merging a plan preserves the rest of the step decision', () => {
  const decision = {
    kind: 'enter',
    messages: [userMessage('tell me about the salmon migration window')],
    startsRequestSeries: true,
    context: 'runtime-context',
  };
  const plan = planRecall({ store, config, sessionId: SESSION_ID, messages: decision.messages, resumeDelivered: new Map() });
  assert.ok(plan, 'plan produced');
  const merged = { ...decision, messages: [...decision.messages, plan.message] };
  assert.equal(merged.kind, 'enter');
  assert.equal(merged.startsRequestSeries, true, 'request-series marker survived');
  assert.equal(merged.context, 'runtime-context', 'runtime context survived');
  assert.equal(merged.messages.length, 2);
  assert.equal(merged.messages[1].source.kind, 'lcm-recall');
  assert.equal(merged.messages[0].content[0].text, 'tell me about the salmon migration window');
});

check('a two-character Chinese query is recalled through the index', () => {
  // The regression this exists for: 召回 and 诊断 are two characters each, below
  // the trigram tokenizer minimum, so automatic recall used to return nothing for
  // ordinary Chinese input. This asserts at the automaticRetrieval level, which is
  // exactly where the old fallback condition was wrong.
  const plan = planRecall({
    store,
    config,
    sessionId: SESSION_ID,
    messages: [userMessage('召回诊断')],
    resumeDelivered: new Map([[SESSION_ID, Number.MAX_SAFE_INTEGER]]),
  });
  assert.ok(plan, 'no plan was produced for a two-character Chinese query');
  const text = plan.message.content[0].text;
  assert.match(text, /Archived by dsh-lcm/);
  assert.ok(plan.hits.length > 0, 'no hits were selected');
  assert.match(text, /召回/, 'the Chinese context was not recalled');
});

store.close();

try {
  fs.rmSync(dir, { recursive: true, force: true });
} catch {
  // The OS will clean the temp directory.
}

process.stdout.write(failures === 0 ? '\nall recall checks passed\n' : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
