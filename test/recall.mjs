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
import {
  deliveredCompactionFrom,
  findAnchor,
  isInjectedMessage,
  makeRecallMessage,
  messageText,
  planRecall,
  resolveStepAgent,
} from '../lib/recall.js';
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
    {
      type: 'compaction/summary',
      seq: 6,
      time: 7,
      data: {
        summary: 'condensed',
        shadowedRange: { start: 1, end: 4 },
        shadowedSeqs: [1, 2, 3, 4],
        shadowedTokenCount: 120,
      },
    },
    { type: 'compaction/end', seq: 7, time: 8, data: { shadowedRange: null, shadowedSeqs: null, shadowedTokenCount: null } },
  ];
  store.capture(header, events);
}

const NO_MAP_ID = 'session-recall-0002';
const noMapHeader = { ...header, id: NO_MAP_ID };

/** A compaction that recorded no inverse map: start/end only, as live archives have. */
function seedPointerlessCompaction(store) {
  store.capture(noMapHeader, [
    {
      type: 'user/message',
      seq: 0,
      time: 1,
      data: { id: 'nm-u1', role: 'user', content: [{ type: 'text', text: 'a turn that was archived here too' }], source: { kind: 'user' } },
    },
    { type: 'compaction/start', seq: 1, time: 2, data: {} },
    { type: 'compaction/end', seq: 2, time: 3, data: { shadowedRange: null, shadowedSeqs: null, shadowedTokenCount: null } },
  ]);
}

const NEVER_COMPACTED_ID = 'session-recall-0003';
const neverCompactedHeader = { ...header, id: NEVER_COMPACTED_ID };

/** A session that never compacted, used to prove similarity is genuinely opt-in. */
function seedNeverCompacted(store) {
  store.capture(neverCompactedHeader, [
    {
      type: 'user/message',
      seq: 0,
      time: 1,
      data: { id: 'nc-u1', role: 'user', content: [{ type: 'text', text: `Please remember that ${PHRASE}.` }], source: { kind: 'user' } },
    },
    {
      type: 'assistant/message',
      seq: 1,
      time: 2,
      data: {
        message: {
          id: 'nc-a1',
          role: 'assistant',
          content: [{ type: 'text', text: `Noted: ${PHRASE}.` }],
          source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
        },
      },
    },
  ]);
}

const configOn = resolveConfig(
  { storeDir: dir, freshTailMessages: 0, automaticRetrieval: { enabled: true, maxChars: 900 } },
  { homeDir: dir },
);
const configOff = resolveConfig(
  { storeDir: dir, freshTailMessages: 0, automaticRetrieval: { enabled: false, maxChars: 900 } },
  { homeDir: dir },
);
const store = new LcmStore({ config: configOn, logger });
store.init();
seed(store);
seedPointerlessCompaction(store);
seedNeverCompacted(store);

const userMessage = (text) => ({ id: `u-${text.length}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } });

/**
 * The committed marker for a delivered resume note.
 *
 * Delivery is read from the model surface alone, so "this note was already
 * shown" has to be expressed as the message the plugin would have injected --
 * exactly the shape `makeRecallMessage` produces, and exactly what the Harness
 * would have written to the log had the step been committed.
 */
const deliveredMarker = (compactAt) => ({ id: `delivered-${compactAt}`, role: 'user', content: [], source: { kind: 'lcm-recall', form: 'retrieval', compactAt } });

// ------------------------------------------------------------------ message helpers

check('messageText concatenates only text blocks', () => {
  assert.equal(messageText({ content: [{ type: 'text', text: 'a' }, { type: 'image', attachment: {} }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.equal(messageText({ content: [] }), '');
  assert.equal(messageText(undefined), '');
});

check('isInjectedMessage recognises plugin and harness context', () => {
  assert.equal(isInjectedMessage({ source: { kind: 'lcm-recall' } }), true);
  assert.equal(isInjectedMessage({ source: { kind: 'system-prompt' } }), true);
  assert.equal(isInjectedMessage({ source: { kind: 'runtime-context' } }), true, 'the harness envelope is not input');
  assert.equal(isInjectedMessage({ source: { kind: 'user' } }), false);
  assert.equal(isInjectedMessage({ source: {} }), false, 'an absent kind is genuine input');
  assert.equal(isInjectedMessage(undefined), false);
});

check('a runtime-context envelope is never the recall anchor', () => {
  const envelope = {
    id: 'ctx',
    role: 'user',
    content: [{ type: 'text', text: 'denial guidance refuse standing normally answerer answerers enforced closed supersedes' }],
    source: { kind: 'runtime-context' },
  };
  assert.equal(findAnchor([envelope]), undefined, 'the envelope was taken for operator input');
  assert.equal(
    planRecall({ store, config: configOn, sessionId: SESSION_ID, messages: [envelope], surfaceMessages: [] }),
    undefined,
    'the envelope became the recall query',
  );
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
  // No compaction is pending for this session, so this stays the similarity
  // path; the compacted session's first turn is the pointer, asserted below.
  const plan = planRecall({
    store,
    config: configOn,
    sessionId: NEVER_COMPACTED_ID,
    messages: [userMessage('when does the salmon migration window open?')],
    surfaceMessages: [],
  });
  assert.ok(plan, 'a plan was produced');
  assert.match(plan.message.content[0].text, /Archived by dsh-lcm/);
  assert.ok(plan.message.content[0].text.length <= configOn.automaticRetrieval.maxChars, 'respects maxChars');
  assert.ok(plan.hits.length > 0, 'hits were selected');
  assert.equal(plan.message.source.kind, 'lcm-recall');
});

check('the first turn after a compaction injects a deterministic pointer', () => {
  const turn = (config, surfaceMessages) =>
    planRecall({
      store,
      config,
      sessionId: SESSION_ID,
      messages: [userMessage('what did we decide about the migration window?')],
      surfaceMessages,
    });

  // The pointer must not depend on the similarity flag, so the whole check runs
  // with similarity OFF.
  const first = turn(configOff, []);
  assert.ok(first, 'no plan on the turn after a compaction');
  assert.deepEqual(first.hits, [], 'the pointer carries no similarity hits');
  assert.ok(first.consumedResumeAt > 0, 'the compaction was consumed');
  assert.equal(first.message.source.kind, 'lcm-recall');
  const text = first.message.content[0].text;
  const pointer = text.split('\n')[0];
  assert.match(pointer, /compaction pointer/);
  assert.match(pointer, /4 archived messages/);
  assert.match(pointer, /seq 1-4/);
  assert.ok(pointer.length <= 300, `pointer is ${pointer.length} chars`);
  assert.match(pointer, /lcm_expand|lcm_grep/, 'the pointer must name a way back');
  assert.doesNotMatch(pointer, new RegExp(PHRASE), 'the pointer must carry no archived body text');
  assert.doesNotMatch(pointer, /LCM prototype resume note/, 'the note is a separate paragraph');
  assert.match(text, /LCM prototype resume note/, 'the resume note still rides the same message');

  // ...and it is emitted regardless of the flag.
  const withFlag = turn(configOn, []);
  assert.match(withFlag.message.content[0].text.split('\n')[0], /compaction pointer/);

  // Once the step is committed, the marker is in the log -- not in a caller's
  // memory -- and nothing is left to say.
  assert.equal(
    turn(configOff, [deliveredMarker(first.consumedResumeAt)]),
    undefined,
    'the pointer must not repeat while its own committed marker is in the surface',
  );
});

check('a compaction with no inverse map still delivers the resume note', () => {
  const plan = planRecall({
    store,
    config: configOff,
    sessionId: NO_MAP_ID,
    messages: [userMessage('what happened before the compaction?')],
    surfaceMessages: [],
  });
  assert.ok(plan, 'nothing was delivered for a compaction without a span');
  assert.ok(plan.consumedResumeAt > 0, 'the compaction was still consumed');
  assert.match(plan.message.content[0].text, /LCM prototype resume note/);
  assert.doesNotMatch(plan.message.content[0].text, /compaction pointer/, 'no pointer was invented');
  assert.deepEqual(plan.hits, []);
});

check('similarity retrieval is opt-in once no compaction is pending', () => {
  const messages = [userMessage('when does the salmon migration window open?')];
  const on = planRecall({ store, config: configOn, sessionId: NEVER_COMPACTED_ID, messages, surfaceMessages: [] });
  assert.ok(on, 'the fixture must genuinely match, or this check proves nothing');
  assert.ok(on.hits.length > 0, 'configOn must still recall');
  assert.equal(
    planRecall({ store, config: configOff, sessionId: NEVER_COMPACTED_ID, messages, surfaceMessages: [] }),
    undefined,
    'similarity recall ran while it was disabled',
  );
});

check('planRecall declines a continuation batch and an unknown session', () => {
  assert.equal(
    planRecall({ store, config: configOn, sessionId: SESSION_ID, messages: [{ id: 'a', role: 'assistant', content: [] }], surfaceMessages: [] }),
    undefined,
    'no anchor -> no plan',
  );
  assert.equal(
    planRecall({ store, config: configOn, sessionId: 'session-not-archived', messages: [userMessage('anything at all')], surfaceMessages: [] }),
    undefined,
    'unarchived session -> no plan',
  );
  assert.equal(
    planRecall({ store, config: configOn, sessionId: SESSION_ID, messages: [userMessage('   ')], surfaceMessages: [] }),
    undefined,
    'blank query -> no plan',
  );
});

check('planRecall emits the resume note once after a compaction', () => {
  const first = planRecall({
    store,
    config: configOn,
    sessionId: SESSION_ID,
    messages: [userMessage('what did we decide about the migration window?')],
    surfaceMessages: [],
  });
  assert.ok(first, 'first plan produced');
  assert.ok(first.consumedResumeAt > 0, 'compaction was detected');
  assert.match(first.message.content[0].text, /LCM prototype resume note/);

  // The committed marker is the delivery proof; the note must not repeat.
  const second = planRecall({
    store,
    config: configOn,
    sessionId: SESSION_ID,
    messages: [userMessage('and what about the migration window again?')],
    surfaceMessages: [deliveredMarker(first.consumedResumeAt)],
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
  const plan = planRecall({ store, config: configOn, sessionId: SESSION_ID, messages: decision.messages, surfaceMessages: [] });
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
    config: configOn,
    sessionId: SESSION_ID,
    messages: [userMessage('召回诊断')],
    // This check asserts the similarity path, so the compaction is declared
    // already delivered by its committed marker.
    surfaceMessages: [deliveredMarker(Number.MAX_SAFE_INTEGER)],
  });
  assert.ok(plan, 'no plan was produced for a two-character Chinese query');
  const text = plan.message.content[0].text;
  assert.match(text, /Archived by dsh-lcm/);
  assert.ok(plan.hits.length > 0, 'no hits were selected');
  assert.match(text, /召回/, 'the Chinese context was not recalled');
});

check('maxRecallMessagesPerSession is enforced against the durable surface', () => {
  // The ceiling was declared, resolved and reported, and enforced nowhere: a long
  // session accumulated one injected block per turn with no bound. It is checked
  // against the surface rather than a per-process counter, so a restart cannot
  // silently raise it.
  const capped = resolveConfig(
    { storeDir: dir, freshTailMessages: 0, maxRecallMessagesPerSession: 1, automaticRetrieval: { enabled: true } },
    { homeDir: dir },
  );
  const messages = [userMessage('when does the salmon migration window open?')];
  const before = store.counters.recallCapReached;

  const allowed = planRecall({ store, config: capped, sessionId: NEVER_COMPACTED_ID, messages, surfaceMessages: [] });
  assert.ok(allowed, 'the cap must not block the first recall');
  assert.equal(store.counters.recallCapReached, before, 'the cap was reported as reached before it was');

  const blocked = planRecall({
    store,
    config: capped,
    sessionId: NEVER_COMPACTED_ID,
    messages,
    surfaceMessages: [{ id: 'recall-in-surface', role: 'user', content: [{ type: 'text', text: 'an earlier recall' }], source: { kind: 'lcm-recall' } }],
  });
  assert.equal(blocked, undefined, 'the cap did not stop another injection');
  assert.equal(store.counters.recallCapReached, before + 1, 'the cap was enforced without being counted');
});

check('delivery is read from the committed surface, in both directions', () => {
  // Reading the marker out of the log is what makes the two failure modes of the
  // old bookkeeping impossible: a process that restarts cannot re-deliver a note
  // the model already saw, and a step that was never committed cannot consume one.
  assert.equal(deliveredCompactionFrom([]), 0, 'an empty surface has delivered nothing');
  assert.equal(deliveredCompactionFrom([{ source: { kind: 'lcm-recall' } }]), 0, 'a marker without a compaction records nothing');
  assert.equal(
    deliveredCompactionFrom([{ source: { kind: 'lcm-recall', compactAt: 7 } }]),
    7,
    'a committed marker was not read back',
  );
  assert.equal(
    deliveredCompactionFrom([
      { source: { kind: 'user' } },
      { source: { kind: 'lcm-recall', compactAt: 7 } },
      { source: { kind: 'lcm-recall', compactAt: 9 } },
      { source: { kind: 'lcm-recall', compactAt: null } },
    ]),
    9,
    'the newest committed compaction must win',
  );

  // ...and the plan honours exactly that: a delivered marker suppresses the note,
  // while a compaction with no marker delivers it.
  const compactedAt = store.sessionRow(SESSION_ID).compacted_at;
  assert.ok(compactedAt > 0, 'the fixture session has no compaction to deliver');
  const message = [userMessage('what did we decide about the migration window?')];
  assert.equal(
    planRecall({ store, config: configOff, sessionId: SESSION_ID, messages: message, surfaceMessages: [deliveredMarker(compactedAt)] }),
    undefined,
    'a committed delivery did not suppress the note',
  );
  const undelivered = planRecall({ store, config: configOff, sessionId: SESSION_ID, messages: message, surfaceMessages: [] });
  assert.ok(undelivered, 'a step that was never committed must leave the note deliverable');
  assert.match(undelivered.message.content[0].text, /LCM prototype resume note/);
});

store.close();

try {
  fs.rmSync(dir, { recursive: true, force: true });
} catch {
  // The OS will clean the temp directory.
}

process.stdout.write(failures === 0 ? '\nall recall checks passed\n' : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
