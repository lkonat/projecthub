// Tests for the AI framework: LLMProvider/provider registry, the Agent agentic
// loop (plain, structured, tool-using), EventAgent dispatch/gating, and the
// agent registry's event binding. Uses a FakeProvider — no network calls.
//
// Run with:  node --test test/ai-framework.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

const { LLMProvider, Agent, EventAgent, providerRegistry, agentRegistry } =
  await import('../src/ai/index.js');
const { registry } = await import('../src/extensions/registry.js');

// A scriptable provider: each complete()/generateStructured() returns the next
// queued response. Records calls for assertions.
class FakeProvider extends LLMProvider {
  static id = 'fake';
  constructor(script = []) { super(); this.script = [...script]; this.calls = []; }
  get capabilities() { return { tools: true, structured: true, streaming: true }; }
  async complete(req) { this.calls.push(req); return this.script.shift() ?? { text: '', toolCalls: [] }; }
  async generateStructured(req) { this.calls.push(req); return this.script.shift(); }
  appendAssistant(messages, response) { return messages.concat([{ role: 'assistant', _from: response }]); }
  appendToolResults(messages, results) { return messages.concat([{ role: 'user', _results: results }]); }
}

const SILENT = { log: { info() {}, error() {}, warn() {} } };

test('providerRegistry: register, default, get, env selection', () => {
  // Hermetic: this test asserts env-driven selection, so it must OWN AI_PROVIDER
  // and not inherit whatever .env set (e.g. AI_PROVIDER=ollama).
  const prev = process.env.AI_PROVIDER;
  delete process.env.AI_PROVIDER;
  try {
    providerRegistry._reset();
    const fake = new FakeProvider();
    providerRegistry.register(fake, 'test');
    assert.equal(providerRegistry.default(), fake); // unset → first registered
    assert.deepEqual(providerRegistry.list(), ['fake']);
    assert.throws(() => providerRegistry.get('nope'), /Unknown LLM provider/);
    assert.throws(() => providerRegistry.register(new LLMProvider(), 'x'), /non-abstract/);

    process.env.AI_PROVIDER = 'fake';
    assert.equal(providerRegistry.default(), fake);
    process.env.AI_PROVIDER = 'missing';
    assert.throws(() => providerRegistry.default(), /Unknown LLM provider 'missing'/);
  } finally {
    if (prev === undefined) delete process.env.AI_PROVIDER; else process.env.AI_PROVIDER = prev;
  }
});

test('Agent: plain text run uses the injected provider', async () => {
  const fake = new FakeProvider([{ text: 'hi there', toolCalls: [] }]);
  class Echo extends Agent {
    static agentName = 'echo';
    systemPrompt() { return 'be brief'; }
  }
  const res = await new Echo({ provider: fake }).run('hello');
  assert.equal(res, 'hi there');
  assert.equal(fake.calls[0].system, 'be brief');
  assert.deepEqual(fake.calls[0].messages, [{ role: 'user', content: 'hello' }]);
});

test('Agent.tryRun returns a structured outcome instead of throwing', async () => {
  const good = new (class extends Agent { static agentName = 'tr-good'; })({
    provider: new FakeProvider([{ text: 'hi', toolCalls: [] }]),
  });
  assert.deepEqual(await good.tryRun('x'), { ok: true, result: 'hi' });

  const fp = new FakeProvider();
  fp.complete = async () => { throw new Error('model down'); };
  const bad = new (class extends Agent { static agentName = 'tr-bad'; })({ provider: fp });
  const r = await bad.tryRun('x');
  assert.equal(r.ok, false);
  assert.match(r.error, /model down/);
});

test('Agent: structured run returns the parsed object', async () => {
  const fake = new FakeProvider([{ text: '{"items":[1,2]}', parsed: { items: [1, 2] } }]);
  class Planner extends Agent {
    static agentName = 'planner';
    responseSchema() { return { type: 'object' }; }
  }
  const res = await new Planner({ provider: fake }).run('plan it');
  assert.deepEqual(res, { items: [1, 2] });
  // generateStructured was used (schema, no tools) — complete() was not called.
  assert.equal(fake.calls.length, 1);
});

test('Agent: tool loop executes tools and returns the final text', async () => {
  const fake = new FakeProvider([
    { text: '', toolCalls: [{ id: 't1', name: 'add', input: { a: 2, b: 3 } }] },
    { text: 'the sum is 5', toolCalls: [] },
  ]);
  let ran = null;
  class Calc extends Agent {
    static agentName = 'calc';
    tools() {
      return [{
        name: 'add', description: 'add', input_schema: { type: 'object' },
        run: ({ a, b }) => { ran = a + b; return String(a + b); },
      }];
    }
  }
  const res = await new Calc({ provider: fake }).run('add 2 and 3');
  assert.equal(res, 'the sum is 5');
  assert.equal(ran, 5);                 // tool actually executed
  assert.equal(fake.calls.length, 2);   // looped once after the tool result
});

test('Agent: tool loop respects maxIterations', async () => {
  // Provider that never stops asking for a tool.
  const looping = new FakeProvider();
  looping.complete = async () => ({ text: '', toolCalls: [{ id: 'x', name: 'noop', input: {} }] });
  class Spin extends Agent {
    static agentName = 'spin';
    tools() { return [{ name: 'noop', description: '', input_schema: {}, run: () => 'ok' }]; }
  }
  await assert.rejects(
    () => new Spin({ provider: looping, maxIterations: 2 }).run('go'),
    /exceeded maxIterations \(2\)/,
  );
});

test('EventAgent: dispatch runs + applies result; shouldRun gates; errors are swallowed', async () => {
  class EA extends EventAgent {
    static agentName = 'ea';
    static event = 'assignment.after-cancel';
    shouldRun(p) { return !!p.go; }
    buildInput(p) { return p.msg; }
    async onResult(r) { this.last = r; }
  }

  // Runs when the gate passes.
  const ok = new EA({ provider: new FakeProvider([{ text: 'handled', toolCalls: [] }]) });
  await ok.dispatch({ go: true, msg: 'cancelled X' }, SILENT);
  assert.equal(ok.last, 'handled');

  // Skipped when the gate fails — run() never called.
  const skip = new EA({ provider: new FakeProvider([{ text: 'should not run' }]) });
  await skip.dispatch({ go: false }, SILENT);
  assert.equal(skip.last, undefined);

  // A throwing provider does NOT propagate out of dispatch (after-* semantics).
  const boom = new EA({ provider: new FakeProvider() });
  boom.provider.complete = async () => { throw new Error('model down'); };
  await assert.doesNotReject(() => boom.dispatch({ go: true, msg: 'x' }, SILENT));
});

test('Agent: asTool() exposes the agent as a tool def from its contract', () => {
  class Impact extends Agent {
    static agentName = 'impact';
    static description = 'assess impact';
    static inputSchema = { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] };
  }
  const tool = new Impact({ provider: new FakeProvider() }).asTool();
  assert.equal(tool.name, 'impact');
  assert.equal(tool.description, 'assess impact');
  assert.deepEqual(tool.input_schema, Impact.inputSchema);
  assert.equal(typeof tool.run, 'function');

  // Defaults when undeclared: a generic description + open object schema.
  class Bare extends Agent { static agentName = 'bare'; }
  const bare = new Bare({ provider: new FakeProvider() }).asTool();
  assert.match(bare.description, /Run the 'bare' agent/);
  assert.deepEqual(bare.input_schema, { type: 'object' });
});

test('agentRegistry: describe() / asTool() surface the agent catalog', () => {
  registry._reset();
  agentRegistry._reset();

  class Impact extends Agent {
    static agentName = 'impact';
    static title = 'Impact Analyst';
    static description = 'assess impact';
    static inputSchema = { type: 'object' };
  }
  class Watch extends EventAgent {
    static agentName = 'watch';
    static event = 'assignment.after-cancel';
  }
  agentRegistry.register(new Impact({ provider: new FakeProvider() }), 'test');
  agentRegistry.register(new Watch({ provider: new FakeProvider() }), 'test');

  const cat = agentRegistry.describe();
  assert.deepEqual(cat.find((a) => a.name === 'impact'),
    { name: 'impact', title: 'Impact Analyst', description: 'assess impact', inputSchema: { type: 'object' }, event: null });
  // title falls back to the name when unset.
  assert.equal(cat.find((a) => a.name === 'watch').title, 'watch');
  assert.equal(cat.find((a) => a.name === 'watch').event, 'assignment.after-cancel');

  // asTool(name) is the registry shortcut to the instance's asTool().
  assert.equal(agentRegistry.asTool('impact').name, 'impact');
  assert.throws(() => agentRegistry.asTool('nope'), /Unknown agent/);
});

test('Agent: an agent invokes another agent listed as a tool, threading the stack', async () => {
  let innerStack = null;
  class Inner extends Agent {
    static agentName = 'inner';
    static description = 'doubles x';
    async run(input, ctx = {}) { innerStack = ctx.agentStack; return { doubled: input.x * 2 }; }
  }
  const outerProvider = new FakeProvider([
    { text: '', toolCalls: [{ id: 't1', name: 'inner', input: { x: 21 } }] },
    { text: 'done', toolCalls: [] },
  ]);
  class Outer extends Agent {
    static agentName = 'outer';
    tools() { return [new Inner({ provider: new FakeProvider() }).asTool()]; }
  }
  const res = await new Outer({ provider: outerProvider }).run('go');
  assert.equal(res, 'done');
  // Inner saw itself called within outer's stack — proves childCtx threading.
  assert.deepEqual(innerStack, ['outer']);
});

test('Agent: cycle and depth guards reject runaway agent chains', async () => {
  class A extends Agent { static agentName = 'a'; }
  const agent = new A({ provider: new FakeProvider([{ text: 'x', toolCalls: [] }]) });

  // Cycle: the agent is already on the stack.
  await assert.rejects(() => agent.run('x', { agentStack: ['a'] }), /Agent cycle detected: a → a/);

  // Depth: stack already at the default limit (8).
  const deep = Array.from({ length: 8 }, (_, i) => `n${i}`);
  await assert.rejects(() => agent.run('x', { agentStack: deep }), /depth limit \(8\) exceeded/);

  // Custom limit via ctx.maxAgentDepth.
  await assert.rejects(
    () => agent.run('x', { agentStack: ['n0'], maxAgentDepth: 1 }),
    /depth limit \(1\) exceeded/,
  );
});

test('agentRegistry: registering an EventAgent binds a hook on its event', () => {
  registry._reset();
  agentRegistry._reset();

  class EA extends EventAgent {
    static agentName = 'cancel-watch';
    static event = 'assignment.after-cancel';
  }
  agentRegistry.register(new EA({ provider: new FakeProvider() }), 'test');

  assert.deepEqual(agentRegistry.list(), ['cancel-watch']);
  const hook = registry.listHooks().find((h) => h.source === 'agent:cancel-watch');
  assert.ok(hook, 'a hook should be registered for the event agent');
  assert.equal(hook.event, 'assignment.after-cancel');

  // Non-agents and duplicates are rejected.
  assert.throws(() => agentRegistry.register({}, 'bad'), /instance of Agent/);
  assert.throws(
    () => agentRegistry.register(new EA({ provider: new FakeProvider() }), 'dup'),
    /already registered/,
  );
});
