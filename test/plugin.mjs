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

import { apply, inject, name } from '../index.js';

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
      { type: 'compaction/summary', seq: 3, time: 4, data: { summary: 'condensed' } },
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
    apply(ctx, { storeDir: dir, freshTailMessages: 0 });
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
  assert.match(spaced.text, /schema\s+v3/);

  const status = await invoke('status');
  assert.equal(status.kind, 'success', status.text);
  assert.match(status.text, /schema\s+v3/);
  assert.match(status.text, /messages\s+\d+ archived/);

  const grep = await invoke('grep lantern');
  assert.equal(grep.kind, 'success', grep.text);
  assert.match(grep.text, /lantern/);

  const unknown = await invoke('definitely-not-a-subcommand');
  assert.equal(unknown.kind, 'error');
  assert.match(unknown.text, /Unknown subcommand/);
});

// -------------------------------------------------------------- pre-step hook

await checkAsync('agent/pre-step injects recalled context and preserves the decision', async () => {
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
  assert.match(injected.content[0].text, /Archived by dsh-lcm/);
  assert.match(injected.content[0].text, /lantern festival/);
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
  assert.match(output, /raw_results=\d+/, output);
  assert.match(output, /scope=session/, output);
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
