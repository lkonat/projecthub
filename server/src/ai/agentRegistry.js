import { registry } from '../extensions/registry.js';
import { Agent } from './Agent.js';
import { EventAgent } from './EventAgent.js';

// agentRegistry — holds the system's agents and wires event agents to the bus.
//
// Registering an EventAgent auto-binds it: a hook is registered on the agent's
// `event`, so when that lifecycle event fires the agent's dispatch() runs. The
// event system therefore depends on the EventAgent abstraction, not on any LLM.
// Non-event agents (task agents) are just held for lookup/invocation.

const agents = new Map(); // name -> Agent instance

export const agentRegistry = {
  register(agent, source = '<unknown>') {
    if (!(agent instanceof Agent)) {
      throw new Error(`Agent from ${source} must be an instance of Agent`);
    }
    const name = agent.name;
    if (agents.has(name)) {
      throw new Error(`Agent '${name}' from ${source} is already registered`);
    }
    agents.set(name, agent);

    // Event agents bind to their lifecycle event via a registry hook.
    if (agent instanceof EventAgent) {
      if (!agent.event) {
        throw new Error(`EventAgent '${name}' from ${source} must set a static event`);
      }
      registry.registerHook(
        { event: agent.event, handler: (payload, ctx) => agent.dispatch(payload, ctx) },
        `agent:${name}`,
      );
    }
    return name;
  },

  has(name) { return agents.has(name); },

  get(name) {
    const a = agents.get(name);
    if (!a) throw new Error(`Unknown agent '${name}'. Registered: ${this.list().join(', ') || '(none)'}`);
    return a;
  },

  list() { return [...agents.keys()]; },

  // Capability catalog: what every registered agent is and expects. A router
  // (rule-based, or an LLM orchestrator) reads this to dispatch by capability;
  // it also just documents the agent surface. `event` is set for event agents.
  describe() {
    return [...agents.values()].map((a) => ({
      name: a.name,           // unique machine identifier
      title: a.title,         // human-friendly display label (falls back to name)
      description: a.constructor.description || '',
      inputSchema: a.constructor.inputSchema ?? null,
      event: a instanceof EventAgent ? a.event : null,
    }));
  },

  // Convenience: a registered agent already wrapped as a tool definition, ready
  // to drop into another agent's tools(). Throws (via get) on an unknown name.
  asTool(name) { return this.get(name).asTool(); },

  // Test/reload only. Note: hooks bound by register() are cleared via
  // registry._reset() (the loader resets both together).
  _reset() { agents.clear(); },
};
