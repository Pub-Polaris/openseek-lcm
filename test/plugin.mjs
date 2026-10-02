/**
 * Plugin-entry integration test.
 *
 * Loads `index.js` exactly as the Harness loader would and runs `apply()` against
 * a minimal fake Cordis host. That exercises the parts a restart would otherwise
 * be the first to try: effect registration on the synchronous path, the tool and
 * system-hint registrations, the `global: true` listener options, event capture,
 * and a real `agent/pre-step` dispatch that injects recalled context.
 *
 *   node test/plugin.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply, inject, makeNoteFailure, name } from '../index.js';
import { SCHEMA_VERSION } from '../lib/db.js';
import { resolveStepAgent } from '../lib/recall.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lcm-plugin-'));
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

async function checkAsync(label, fn) {
  try {
    await fn();
    process.stdout.write(`ok   ${label}\n`);
  } catch (error) {
    failures += 1;
    process.stdout.write(`FAIL ${label}\n     ${error?.message ?? error}\n`);
  }
}

const SESSION_ID = 'session-plugin-0001';
const PHRASE = 'the lantern festival is on the second friday of october';
const warnings = [];

/**
 * A minimal stand-in for the Cordis host.
 *
 * Only the surface the plugin actually touches is implemented, and every
 * registration is recorded so the test can assert on it.
 */
function createFakeHost() {
  const host = {
    listeners: [],
    sections: [],
    tools: [],
    registeredCommands: [],
    injected: [],
    effects: [],
    disposed: [],
    effectWhileAwaiting: 0,
    awaiting: false,
    log: [],
    /** The live model surface returned by `sessionQuery.readSurface`. */
    surfaceEvents: [],
    /** How many times the plugin asked for that surface. */
    surfaceReads: 0,
    /** Session log returned by `sessionQuery.readSession`. */
    events: [
      { type: 'session/title', seq: 0, time: 1, data: { title: 'plugin fixture' } },
      {
        type: 'user/message',
        seq: 1,
        time: 2,
        data: { id: 'u1', role: 'user', content: [{ type: 'text', text: `Remember: ${PHRASE}.` }], source: { kind: 'user' } },
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
        type: 'compaction/summary',
        seq: 3,
        time: 4,
        data: {
          summary: 'condensed',
          shadowedRange: { start: 1, end: 2 },
          shadowedSeqs: [1, 2],
          shadowedTokenCount: 42,
        },
      },
    ],
  };

  const session = {
    id: SESSION_ID,
    header: { version: 4, id: SESSION_ID, createdAt: Date.now(), cwd: 'C:/work', isSeeded: false },
  };
  const agent = { session };

  const logger = {
    info: (m) => host.log.push(`info ${m}`),
    warn: (m) => {
      warnings.push(String(m));
      host.log.push(`warn ${m}`);
    },
    debug: () => {},
    error: (m) => host.log.push(`error ${m}`),
  };

  const ctx = {
    logger: () => logger,
    effect(factory, label) {
      if (host.awaiting) host.effectWhileAwaiting += 1;
      const disposer = factory();
      host.effects.push({ label, dispose: typeof disposer === 'function' ? disposer : () => {} });
      return () => {};
    },
    on(event, listener, options) {
      host.listeners.push({ event, listener, options });
      return () => {};
    },
    systemPrompt: {
      section(definition) {
        host.sections.push(definition);
        return () => {};
      },
    },
    commands: {
      register(definition) {
        host.registeredCommands.push(definition);
        return () => {};
      },
    },
    inject(deps, callback) {
      host.injected.push([...deps]);
      // Optional dependencies are already available in this profile, so a real
      // Cordis context invokes the callback synchronously.
      callback(ctx);
      return () => {};
    },
    tools: {
      register(definition) {
        host.tools.push(definition);
        return () => {};
      },
    },
    sessionQuery: {
      async readSession(sessionId) {
        assert.equal(sessionId, SESSION_ID);
        return { session: session.header, inheritedEventCount: 0, events: host.events };
      },
      // The live model surface. It is mutable so a check can commit a message
      // the plugin injected, exactly as the Harness does after a step lands --
      // which is what makes "this was already delivered" a durable fact rather
      // than a plugin-held guess. The counter is what proves the *wiring*, since a
      // fake host without this method would make every surface read fail silently
      // and recall would look identical.
      async readSurface(sessionId) {
        assert.equal(sessionId, SESSION_ID);
        host.surfaceReads += 1;
        return { session: session.header, events: host.surfaceEvents };
      },
    },
    agents: {
      get: (id) => (id === SESSION_ID ? agent : undefined),
      list: () => [agent],
      currentInitiator: () => agent,
    },
    host,
    agent,
  };

  return ctx;
}

const ctx = createFakeHost();

check('the entry declares its required services', () => {
  assert.deepEqual(inject, ['tools', 'systemPrompt', 'sessionQuery', 'agents']);
  assert.equal(name, 'lcm');
});

// ---------------------------------------------------------------- activation

const activationError = (() => {
  try {
    // Similarity retrieval is off by default now; this suite asserts both the
    // deterministic pointer and the similarity path, so it opts in explicitly.
    apply(ctx, { storeDir: dir, freshTailMessages: 0, automaticRetrieval: { enabled: true } });
    return undefined;
  } catch (error) {
    return error;
  }
})();

check('apply() completes without throwing', () => {
  assert.equal(activationError, undefined, `apply threw: ${activationError?.message}`);
});

check('every registration happens on the synchronous path', () => {
  // A registration made after an await is not owned by the fiber and the whole
  // plugin fails to activate; an empty effect list is the observable symptom.
  assert.ok(ctx.host.effects.length >= 5, `only ${ctx.host.effects.length} effects registered`);
  assert.equal(ctx.host.effectWhileAwaiting, 0);
});

check('all 18 lcm tools are registered with usable schemas', () => {
  assert.equal(ctx.host.tools.length, 18, `registered ${ctx.host.tools.length}`);
  const names = ctx.host.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    'lcm_artifact', 'lcm_blob_gc', 'lcm_blob_stats', 'lcm_compact', 'lcm_describe', 'lcm_doctor',
    'lcm_expand', 'lcm_export_snapshot', 'lcm_grep', 'lcm_import_snapshot', 'lcm_lineage',
    'lcm_pin_session', 'lcm_resume', 'lcm_retention_prune', 'lcm_retention_report',
    'lcm_retrieval_debug', 'lcm_status', 'lcm_unpin_session',
  ].sort());
  for (const tool of ctx.host.tools) {
    assert.equal(tool.parameters.type, 'object', `${tool.name} parameters must be an object schema`);
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 0, `${tool.name} needs a description`);
    assert.equal(typeof tool.execute, 'function', `${tool.name} needs execute`);
    assert.equal(typeof tool.output?.render, 'function', `${tool.name} needs an output renderer`);
  }
});

check('the system hint is one section at the configured order', () => {
  assert.equal(ctx.host.sections.length, 1);
  const section = ctx.host.sections[0];
  assert.equal(section.name, 'lcm:hint');
  assert.equal(section.order, 9000);
  assert.equal(section.interpolate, false, 'braces in the hint must never fail assembly');
  assert.match(section.text, /Archived long-term context/);
  assert.match(section.text, /lcm_grep/);
});

check('scoped events are subscribed globally', () => {
  const byEvent = new Map(ctx.host.listeners.map((entry) => [entry.event, entry]));
  for (const event of ['session/event', 'session/created', 'agent/pre-step']) {
    const entry = byEvent.get(event);
    assert.ok(entry, `${event} listener is missing`);
    assert.equal(entry.options?.global, true, `${event} must be subscribed with { global: true }`);
  }
});

// ------------------------------------------------------------------- capture

check('a live session event is buffered, not written inline', () => {
  const listener = ctx.host.listeners.find((entry) => entry.event === 'session/event').listener;
  assert.doesNotThrow(() =>
    listener(ctx.agent.session, {
      type: 'user/message',
      seq: 4,
      time: 5,
      data: { id: 'u2', role: 'user', content: [{ type: 'text', text: 'another turn' }], source: { kind: 'user' } },
    }),
  );
});

await checkAsync('a tool call backfills the archive', async () => {
  const status = ctx.host.tools.find((tool) => tool.name === 'lcm_status');
  const output = await status.execute({}, { agent: ctx.agent });
  // Two messages come from the backfill (seq 1 and 2) and one from the buffered
  // live event (seq 4). The earlier history must survive even though the later
  // event arrived first: that ordering is exactly what the contiguous watermark
  // protects, and a jumping watermark would leave message_count at 1.
  assert.match(output, /message_count=3\b/, `nothing was archived:\n${output}`);
  assert.match(output, /fts_available=true/);
  assert.match(output, /capture_failures=0/);
  assert.match(output, /store_path=/);
});

await checkAsync('lcm_grep finds the archived phrase', async () => {
  const grep = ctx.host.tools.find((tool) => tool.name === 'lcm_grep');
  const output = await grep.execute({ query: 'lantern festival', limit: 5 }, { agent: ctx.agent });
  assert.match(output, /results=\d+/, output);
  assert.match(output, /lantern festival/, output);
});

// -------------------------------------------------------------- /lcm command

await checkAsync('the /lcm command registers and answers its subcommands', async () => {
  assert.deepEqual(ctx.host.injected, [['commands']], 'the command registry is an optional dependency');
  assert.equal(ctx.host.registeredCommands.length, 1, `registered ${ctx.host.registeredCommands.length} command(s)`);
  const command = ctx.host.registeredCommands[0];
  assert.equal(command.name, 'lcm');
  assert.match(command.name, /^[a-z][a-z0-9_-]*$/, 'the registry requires this name shape');
  assert.ok(command.description.length > 0, "a command needs a non-empty description");
  assert.equal(typeof command.handler, 'function', 'a command needs a handler function');
  assert.ok(
    typeof command.input?.hint === 'string' && command.input.hint.trim().length > 0,
    'a declared input hint must be a non-empty string',
  );
  const invoke = (rawInput) => command.handler({ agent: ctx.agent, rawInput, attachments: [], signal: undefined });

  const help = await invoke('');
  assert.equal(help.kind, 'success');
  assert.match(help.text, /Usage: \/lcm/);

  // The registry passes every byte after the name, separating space included.
  const spaced = await invoke(' status');
  assert.equal(spaced.kind, 'success', spaced.text);
  // Symbolic, so this check survives the next schema bump instead of pinning a
  // version the plugin is allowed to advance.
  assert.match(spaced.text, new RegExp(`schema\\s+v${SCHEMA_VERSION}\\b`));

  const status = await invoke('status');
  assert.equal(status.kind, 'success', status.text);
  assert.match(status.text, new RegExp(`schema\\s+v${SCHEMA_VERSION}\\b`));
  assert.match(status.text, /messages\s+\d+ archived/);

  const grep = await invoke('grep lantern');
  assert.equal(grep.kind, 'success', grep.text);
  assert.match(grep.text, /lantern/);

  const unknown = await invoke('definitely-not-a-subcommand');
  assert.equal(unknown.kind, 'error');
  assert.match(unknown.text, /Unknown subcommand/);
});

// -------------------------------------------------------------- pre-step hook

await checkAsync('agent/pre-step injects the compaction pointer and preserves the decision', async () => {
  const listener = ctx.host.listeners.find((entry) => entry.event === 'agent/pre-step').listener;
  const messages = [
    {
      id: 'pending',
      role: 'user',
      content: [{ type: 'text', text: 'when exactly is the lantern festival?' }],
      source: { kind: 'user' },
    },
  ];
  const decision = { kind: 'enter', messages, startsRequestSeries: true, context: 'runtime-context' };

  // `this` is the dispatching scope; the payload intentionally omits `agent`,
  // which is what the Harness actually sends.
  const result = await listener.call({}, { messages, turn: 1, step: 1, signal: undefined }, async () => decision);

  assert.equal(result.kind, 'enter');
  assert.equal(result.startsRequestSeries, true, 'request-series marker was dropped');
  assert.equal(result.context, 'runtime-context', 'runtime context was dropped');
  assert.equal(result.messages.length, 2, 'expected one injected message');
  assert.equal(result.messages[0], messages[0], 'the original messages must survive in order');
  const injected = result.messages[1];
  assert.equal(injected.role, 'user');
  assert.equal(injected.source.kind, 'lcm-recall');
  // The first turn after a compaction is answered deterministically: a pointer,
  // never similarity hits.
  const text = injected.content[0].text;
  const pointer = text.split('\n')[0];
  assert.match(pointer, /compaction pointer/);
  assert.match(pointer, /2 archived messages/);
  assert.match(pointer, /seq 1-2/);
  assert.match(text, /lcm_expand|lcm_grep/, 'the pointer must name a way back');
  assert.match(text, /LCM prototype resume note/, 'the resume note rides the same message');

  // Commit the injected message as the Harness does once the step lands. The
  // plugin keeps no in-memory delivery marker, so this committed message is the
  // *only* thing that can stop the pointer repeating -- and the check below is
  // what proves it does.
  ctx.host.surfaceEvents.push({ type: 'user/message', seq: 5, time: 6, data: injected });
});

await checkAsync('agent/pre-step recalls by similarity once the pointer turn is committed', async () => {
  const listener = ctx.host.listeners.find((entry) => entry.event === 'agent/pre-step').listener;
  const messages = [
    {
      id: 'pending-2',
      role: 'user',
      content: [{ type: 'text', text: 'what did we say about the lantern festival?' }],
      source: { kind: 'user' },
    },
  ];
  const decision = { kind: 'enter', messages };
  const result = await listener.call({}, { messages, turn: 2, step: 1, signal: undefined }, async () => decision);

  assert.equal(result.messages.length, 2, 'expected one injected message');
  const injected = result.messages[1];
  assert.equal(injected.source.kind, 'lcm-recall');
  assert.match(injected.content[0].text, /Archived by dsh-lcm/);
  assert.match(injected.content[0].text, /lantern festival/);
  assert.doesNotMatch(injected.content[0].text, /compaction pointer/, 'the committed marker must suppress the pointer');
  // The suppression above is only meaningful if the plan actually read this
  // surface: an unread surface and an empty one behave identically.
  assert.ok(ctx.host.surfaceReads > 0, 'the pre-step never asked for the model surface');
});

await checkAsync('agent/pre-step leaves a continuation step alone', async () => {
  const listener = ctx.host.listeners.find((entry) => entry.event === 'agent/pre-step').listener;
  const messages = [
    { id: 'a', role: 'assistant', content: [{ type: 'text', text: 'working' }], source: { kind: 'model' } },
  ];
  const decision = { kind: 'enter', messages };
  const result = await listener.call({}, { messages, turn: 1, step: 2, signal: undefined }, async () => decision);
  assert.equal(result.messages.length, 1, 'a continuation step must not be injected');
  assert.equal(result.messages, messages);
});

await checkAsync('a rejected decision is passed through untouched', async () => {
  const listener = ctx.host.listeners.find((entry) => entry.event === 'agent/pre-step').listener;
  const rejection = { kind: 'reject', reason: 'no input' };
  const result = await listener.call({}, { messages: [], turn: 1, step: 1 }, async () => rejection);
  assert.equal(result, rejection);
});

await checkAsync('the retrieval debug tool reports the last recall', async () => {
  const debug = ctx.host.tools.find((tool) => tool.name === 'lcm_retrieval_debug');
  const output = await debug.execute({}, { agent: ctx.agent });
  assert.match(output, /raw_results=\d/, output);
  assert.match(output, /scope=session/, output);
});

// ------------------------------------------------------- surface exclusion

await checkAsync('recall never re-injects a message the model surface already holds', async () => {
  // `agent/pre-step`'s payload `messages` is only the newly claimed batch, so it
  // cannot say what the prompt already contains. Without the surface read, the
  // plugin re-injects what the model is already looking at.
  const host = createFakeHost();
  const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lcm-plugin-surface-'));
  try {
    // freshTailMessages: 0 removes the other exclusion, so the only thing that can
    // keep this message out of the injection is the surface itself.
    apply(host, { storeDir: localDir, freshTailMessages: 0, automaticRetrieval: { enabled: true } });

    // The surface holds a copy of an archived user message -- the same words the
    // model can already read -- plus the committed marker for the fixture
    // compaction, so this asserts the similarity path rather than the pointer.
    const surfaceCopy = {
      id: 'surface-copy',
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'SURFACE-ONLY-COPY: the lantern festival is on the second friday of october and the salmon migration window opens in may',
        },
      ],
      source: { kind: 'user' },
    };
    host.host.surfaceEvents.push({ type: 'user/message', seq: 1, time: 2, data: surfaceCopy });
    host.host.surfaceEvents.push({
      type: 'user/message',
      seq: 2,
      time: 3,
      data: { id: 'delivered-pointer', role: 'user', content: [], source: { kind: 'lcm-recall', compactAt: Number.MAX_SAFE_INTEGER } },
    });

    const listener = host.host.listeners.find((entry) => entry.event === 'agent/pre-step').listener;
    const messages = [
      {
        id: 'pending-surface',
        role: 'user',
        content: [{ type: 'text', text: 'the lantern festival and the salmon migration window' }],
        source: { kind: 'user' },
      },
    ];
    const decision = { kind: 'enter', messages };
    const result = await listener.call(host, { messages, turn: 1, step: 1, signal: undefined }, async () => decision);

    assert.equal(result.messages.length, 2, 'expected a recalled-context message');
    const injected = result.messages[1].content[0].text;
    assert.match(injected, /Archived by dsh-lcm/);
    assert.doesNotMatch(injected, /SURFACE-ONLY-COPY/, 'a message already in the surface was injected back into it');
  } finally {
    for (const effect of host.host.effects) {
      try {
        effect.dispose();
      } catch {
        // Disposal is best-effort here; the owning checks cover it.
      }
    }
    fs.rmSync(localDir, { recursive: true, force: true });
  }
});

await checkAsync('a supplied scope agent is enough to produce an injection', async () => {
  // `resolveStepAgent`'s scope branch is only reachable because the pre-step
  // listener is a real `function`: an arrow would bind `this` to `apply()`'s
  // context, so a dispatch outside `withInitiator` -- which the payload and the
  // initiator both cover -- would silently disable recall.
  const scoped = { session: { id: 'scoped-session' } };
  assert.equal(
    resolveStepAgent({}, { agent: scoped }, { agents: { currentInitiator: () => undefined } }),
    scoped,
    'the dispatching scope must be a usable agent source',
  );

  const host = createFakeHost();
  const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lcm-plugin-scope-'));
  try {
    apply(host, { storeDir: localDir, freshTailMessages: 0, automaticRetrieval: { enabled: true } });
    const listener = host.host.listeners.find((entry) => entry.event === 'agent/pre-step').listener;
    const messages = [
      {
        id: 'pending-scope',
        role: 'user',
        content: [{ type: 'text', text: 'what did we say about the lantern festival?' }],
        source: { kind: 'user' },
      },
    ];
    const decision = { kind: 'enter', messages };
    // No `agent` in the payload, and no initiator: the dispatching scope is the
    // only remaining source.
    const result = await listener.call(
      { agent: host.agent },
      { messages, turn: 1, step: 1, signal: undefined },
      async () => decision,
    );
    assert.equal(result.messages.length, 2, 'the scope agent was ignored, so no injection happened');
    assert.equal(result.messages[1].source.kind, 'lcm-recall');
  } finally {
    for (const effect of host.host.effects) {
      try {
        effect.dispose();
      } catch {
        // Best-effort.
      }
    }
    fs.rmSync(localDir, { recursive: true, force: true });
  }
});

check('noteFailure cannot become the failure it reports', () => {
  // It runs from `catch` blocks, so a throwing logger or a missing counters object
  // would propagate out of the catch and take down the turn the catch protects.
  const failures = [];
  let logged = 0;
  const hostile = makeNoteFailure({
    getLogger: () => ({
      warn() {
        logged += 1;
        throw new Error('this logger throws');
      },
    }),
    getStore: () => ({ counters: null }),
    failures,
  });
  assert.doesNotThrow(() => hostile('a hostile capture', new Error('the original failure')), 'noteFailure threw out of its guards');
  assert.ok(logged > 0, 'the report never reached the logger, so this check would prove nothing');
  assert.equal(failures.length, 1, 'the failure was not recorded');
  assert.equal(failures[0].operation, 'a hostile capture');
  assert.equal(failures[0].message, 'the original failure');

  // The harsher shape: the caller's error value is untrusted too, so even reading
  // it has to sit behind a guard, and the store lookup itself may throw.
  const harsher = makeNoteFailure({
    getLogger: () => {
      throw new Error('the logger cannot even be resolved');
    },
    getStore: () => {
      throw new Error('the store is gone');
    },
    failures: null,
  });
  const hostileError = {
    get message() {
      throw new Error('reading the message throws');
    },
    get [Symbol.toPrimitive]() {
      throw new Error('stringifying throws');
    },
  };
  assert.doesNotThrow(() => harsher('a hostile error', hostileError), 'an untrusted error value escaped the guards');
});

// ------------------------------------------------------------------ teardown

check('disposal closes the archive cleanly', () => {
  let disposed = 0;
  for (const effect of ctx.host.effects) {
    try {
      effect.dispose();
      disposed += 1;
    } catch (error) {
      assert.fail(`disposer "${effect.label}" threw: ${error?.message}`);
    }
  }
  assert.equal(disposed, ctx.host.effects.length, 'every effect must dispose cleanly');
});

check('no warnings were logged during the run', () => {
  assert.deepEqual(warnings, [], `the plugin logged warnings:\n${warnings.join('\n')}`);
});

try {
  fs.rmSync(dir, { recursive: true, force: true });
} catch {
  // SQLite may still hold the file briefly; the OS will clean the temp directory.
}

process.stdout.write(failures === 0 ? '\nall plugin checks passed\n' : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
