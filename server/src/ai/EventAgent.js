import { Agent } from './Agent.js';

// EventAgent — an Agent bound to a lifecycle event.
//
// The event bus (the extension registry) dispatches to it polymorphically: when
// the agent is registered, the registry wires a hook on `event` to its
// dispatch(). The bus knows only EventAgent — not any LLM. Concrete event agents
// set `static event` and override the hooks below.
//
//   class CancelImpactAgent extends EventAgent {
//     static agentName = 'cancel-impact';
//     static event = 'assignment.after-cancel';
//     shouldRun({ assignment }) { return !!assignment?.cancel_reason; }
//     buildInput({ assignment, phase }) { return `Assess impact of cancelling "${assignment.title}"...`; }
//     async onResult(text, payload, ctx) { /* post a comment via ctx.services, etc. */ }
//   }
export class EventAgent extends Agent {
  // The lifecycle event this agent reacts to (must be a registry event id).
  static event = null;

  get event() { return this.constructor.event; }

  // Gate: should this agent act on this payload? Default: always.
  shouldRun(_payload, _ctx) { return true; }

  // Map the event payload to the agent's run() input.
  buildInput(payload, _ctx) { return payload; }

  // Apply the agent's output as a side effect. Default: log it. Override to
  // post a comment, create assignments, notify, etc. (via ctx.services).
  async onResult(result, _payload, ctx) {
    (ctx.log ?? console).info(
      `[agent:${this.name}] ${typeof result === 'string' ? result : JSON.stringify(result)}`
    );
  }

  // The hook handler bound to `event`. After-* semantics: a failure is logged
  // and swallowed so the triggering operation is never broken by an agent.
  async dispatch(payload, ctx = {}) {
    try {
      if (!this.shouldRun(payload, ctx)) return;
      const result = await this.run(this.buildInput(payload, ctx), ctx);
      await this.onResult(result, payload, ctx);
    } catch (err) {
      (ctx.log ?? console).error(`[agent:${this.name}] failed on '${this.event}': ${err.message}`);
    }
  }
}
