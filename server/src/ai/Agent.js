import { EventEmitter } from 'node:events';
import { providerRegistry } from './providerRegistry.js';
import { AGENT_EVENT } from './agentEvents.js';

// Agent — the base "agentic AI" class.
//
// It owns the agentic loop (prompt → model → optional tool calls → repeat →
// result) and depends ONLY on an LLMProvider, never on a concrete SDK. Concrete
// agents extend this and override the small hooks below; EventAgent extends it
// further for event-driven agents.
//
// The provider is resolved lazily from the registry's default unless one is
// injected, so registration order and test injection both work.
//
// Agent extends EventEmitter, so a run BROADCASTS its lifecycle — attach
// listeners with `agent.on(event, fn)` to observe / trace / drive UI without
// touching the loop. The event names and payloads are the single source of
// truth in ./agentEvents.js (AGENT_EVENT): start, model:request, model:response,
// tool:call, tool:result, complete, failed. Every payload carries { name (the
// agent), assignmentId (the run correlation id from ctx) } plus event-specific
// fields, so an observer can attribute events to a run on the shared singleton.
// Note: the failure event is named 'failed', NOT 'error' — EventEmitter throws
// on an unhandled 'error' event, which would turn a missing listener into a crash.

// Cap on nested agent-as-tool calls (A→B→C…) — a backstop against runaway or
// accidentally recursive agent graphs. Overridable per call via ctx.maxAgentDepth.
const DEFAULT_MAX_AGENT_DEPTH = 8;

export class Agent extends EventEmitter {
  // Unique registry name (the agent's machine identifier, kebab-case). The
  // registry rejects a duplicate, so names are unique across the system.
  static agentName = 'agent';

  // Human-friendly display title (e.g. 'Cancel Impact Analyst'). Falls back to
  // the name when unset — see `title`.
  static title = '';

  // Self-description, so an agent is discoverable and callable like a tool:
  //   description — one line, human- AND model-readable (what the agent does)
  //   inputSchema — JSON Schema for run(input): the call contract
  // Both default to "unspecified". Set them on any agent meant to be composed
  // into another agent's tools() or chosen by a capability router.
  static description = '';
  static inputSchema = undefined;

  // opts: { provider?: LLMProvider, model?: string, maxIterations?: number }
  constructor(opts = {}) {
    super(); // EventEmitter — enables agent.on(...) / this.emit(...)
    // Agents are singletons, so concurrent runs share this emitter; an
    // orchestrator (the runner) attaches a couple of listeners per active run
    // (removed when it ends). Lift the default 10-listener warning cap.
    this.setMaxListeners(0);
    this._provider = opts.provider ?? null;
    this.model = opts.model ?? null; // null → provider's default model
    this.maxIterations = opts.maxIterations ?? 6;
  }

  get name() { return this.constructor.agentName; }

  // Display title, defaulting to the name when none is set.
  get title() { return this.constructor.title || this.name; }

  get provider() { return this._provider ?? providerRegistry.default(); }

  // Expose this agent as a tool definition. Another agent lists it in its
  // tools() and the agentic loop invokes it like any tool. This is the single
  // primitive behind both "agents triggering agents" and capability routing:
  // an agent is just a tool whose body is another agentic loop.
  asTool() {
    return {
      name: this.name,
      description: this.constructor.description || `Run the '${this.name}' agent.`,
      input_schema: this.constructor.inputSchema ?? { type: 'object' },
      run: (input, ctx) => this.run(input, ctx),
    };
  }

  // ── Subclass hooks (override as needed) ─────────────────────────────────
  // System prompt for the run (string or undefined).
  systemPrompt(_input, _ctx) { return undefined; }

  // Tool definitions: [{ name, description, input_schema, run(input, ctx), final? }].
  // Return [] / undefined for a non-tool agent. A tool with `final: true` is a
  // one-shot terminal signal: when it runs successfully the loop stops after that
  // round (the model can't keep calling it) and the run returns the tool's output.
  tools(_input, _ctx) { return undefined; }

  // JSON Schema → forces a structured (non-tool) response, parsed into an object.
  responseSchema(_input, _ctx) { return undefined; }

  // Turn the caller's input into the provider's initial messages. Default: a
  // single user message (stringifying non-string input).
  buildMessages(input, _ctx) {
    const content = typeof input === 'string' ? input : JSON.stringify(input);
    return [{ role: 'user', content }];
  }

  // Map the final provider response to the agent's return value.
  parseResult(response, _ctx) {
    return response.parsed ?? response.text;
  }

  // ── The agentic loop ────────────────────────────────────────────────────
  // Public entry: emits 'start' → ('complete' | 'failed') around the loop so a
  // run is always bracketed by events, however it ends. The loop itself is _run.
  // Every event is tagged with the caller's run correlation id (ctx.assignmentId)
  // so observers can attribute events to a run — agents are singletons, so
  // concurrent runs emit on the same instance.
  async run(input, ctx = {}) {
    const cid = ctx?.assignmentId;
    this.emit(AGENT_EVENT.START, { name: this.name, assignmentId: cid, input });
    try {
      const result = await this._run(input, ctx);
      if(typeof result ==="function"){
          let r = await result();// this function will emit the appropriate end event
      }else{
        this.emit(AGENT_EVENT.COMPLETE, { name: this.name, assignmentId: cid, result });
      }
      return result;
    } catch (err) {
      console.log(err)
      this.emit(AGENT_EVENT.FAILED, { name: this.name, assignmentId: cid, error: err });
      throw err;
    }
  }

  async _run(input, ctx = {}) {
    const cid = ctx?.assignmentId; // run correlation id, tagged onto each event
    // Cycle + depth guards for agent-as-tool chains. ctx.agentStack carries the
    // agents currently on the call stack; each nested run() extends it.
    const stack = ctx.agentStack ?? [];
    if (stack.includes(this.name)) {
      throw new Error(`Agent cycle detected: ${[...stack, this.name].join(' → ')}`);
    }
    const maxDepth = ctx.maxAgentDepth ?? DEFAULT_MAX_AGENT_DEPTH;
    if (stack.length >= maxDepth) {
      throw new Error(
        `Agent call depth limit (${maxDepth}) exceeded at '${this.name}' — ` +
        `stack: ${[...stack, this.name].join(' → ')}`
      );
    }
    // ctx handed to tools (which may themselves be agents) carries this agent on
    // the stack; the agent's own hooks keep the caller's ctx unchanged. It also
    // exposes `emit` so a tool can signal on THIS agent (e.g. an assignment
    // outcome) without holding a reference to it — listeners persist/route it.
    const childCtx = { ...ctx, agentStack: [...stack, this.name], emit: (event, payload = {}) => this.emit(event, payload) };

    const provider = this.provider;
    const system = this.systemPrompt(input, ctx);
    const schema = this.responseSchema(input, ctx);
    const toolDefs = this.tools(input, ctx) || [];
    // Resume support: continue from a prior transcript when the caller seeded one
    // on ctx.messages, otherwise open fresh. The latest transcript is written back
    // to ctx.messages at each exit so the caller can persist it (and resume later).
    let messages = (Array.isArray(ctx.messages) && ctx.messages.length) ? ctx.messages : this.buildMessages(input, ctx);

    // Structured, non-tool path.
    if (schema && toolDefs.length === 0) {
      this.emit(AGENT_EVENT.MODEL_REQUEST, { name: this.name, assignmentId: cid, iteration: 0 });
      const response = await provider.generateStructured({ model: this.model, system, messages, schema });
      this.emit(AGENT_EVENT.MODEL_RESPONSE, { name: this.name, assignmentId: cid, iteration: 0, toolCalls: 0 });
      ctx.messages = messages;
      return this.parseResult(response, ctx);
    }

    // Plain or tool-using path. With no tools this resolves in one turn (the
    // model returns text, no tool calls). With tools it loops until the model
    // stops requesting them.
    const toolMap = new Map(toolDefs.map((t) => [t.name, t]));
    // Send only the wire fields to the provider — never `run` (the executor) or
    // local-only flags like `final`.
    const wireTools = toolDefs.length
      ? toolDefs.map(({ name, description, input_schema }) => ({ name, description, input_schema }))
      : undefined;

    for (let i = 0; i < this.maxIterations; i++) {
      this.emit(AGENT_EVENT.MODEL_REQUEST, { name: this.name, assignmentId: cid, iteration: i });
      this.emit(AGENT_EVENT.THINKING_START);
      const response = await provider.complete({ model: this.model, system, messages, tools: wireTools });
      this.emit(AGENT_EVENT.MODEL_RESPONSE, { name: this.name, assignmentId: cid, iteration: i, toolCalls: response.toolCalls?.length ?? 0 });
      this.emit(AGENT_EVENT.THINKING_DONE);
      if (!response.toolCalls || response.toolCalls.length === 0) {
        ctx.messages = messages;
        return this.parseResult(response, ctx);
      }
      const finalToolCall = response.toolCalls&&response.toolCalls.length>0 ?  response.toolCalls.find((x)=>{return toolMap.get(x.name)?.final}): false;

      if(finalToolCall){// these final tool call will emit the last event
          messages = provider.appendAssistant(messages, response);
          ctx.messages = messages;
          const tool = toolMap.get(finalToolCall.name);
          return async()=>{ // return a function
             let result = await tool.run(finalToolCall.input, childCtx);
          };
      }
      messages = provider.appendAssistant(messages, response);
      const results = [];
      for (const call of response.toolCalls) {
        this.emit(AGENT_EVENT.TOOL_CALL, { name: this.name, assignmentId: cid, tool: call.name, input: call.input, id: call.id });
        this.emit(AGENT_EVENT.ACTION_START,{call});
        const tool = toolMap.get(call.name);
        let content, error;
        try {
          content = tool ? await tool.run(call.input, childCtx) : `Unknown tool: ${call.name}`;
        } catch (err) {
          error = err;
          content = `Error executing ${call.name}: ${err.message}`;
        }
        this.emit(AGENT_EVENT.TOOL_RESULT, { name: this.name, assignmentId: cid, tool: call.name, content, error });
        this.emit(AGENT_EVENT.ACTION_DONE,{call});
        results.push({
          toolUseId: call.id,
          content: typeof content === 'string' ? content : JSON.stringify(content),
        });
      }
      messages = provider.appendToolResults(messages, results);
    }

    ctx.messages = messages;
    throw new Error(`Agent '${this.name}' exceeded maxIterations (${this.maxIterations}) without a final answer`);
  }

  // Like run(), but never throws: returns a structured outcome so a caller knows
  // whether the run succeeded without a try/catch.
  //   { ok: true,  result }  — the agent's output
  //   { ok: false, error }   — the failure message
  async tryRun(input, ctx = {}) {
    try {
      return { ok: true, result: await this.run(input, ctx) };
    } catch (err) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  }
}
