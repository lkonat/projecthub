// The AI framework's public surface. The system imports the abstractions and
// registries from here; concrete providers/agents live in extensions/ and
// implement/extend these.
export { LLMProvider } from './LLMProvider.js';
export { Agent } from './Agent.js';
export { EventAgent } from './EventAgent.js';
export { AssignmentAgent } from './AssignmentAgent.js';
export { AGENT_EVENT, ASSIGNMENT_EVENT, ALL_AGENT_EVENTS } from './agentEvents.js';
export { providerRegistry } from './providerRegistry.js';
export { agentRegistry } from './agentRegistry.js';
