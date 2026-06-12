// Names of every event an Agent emits — the single source of truth shared by the
// emitter (Agent / the finish_assignment tool) and listeners (the runner). Same
// discipline as constants/assignmentStates.js: enumerate once so a generic tap
// can attach to ALL of them without drifting from what's actually emitted.

// Generic run-lifecycle events every Agent emits (see Agent.js). Each payload
// carries { name, assignmentId, … } — assignmentId is the run correlation id the
// caller put on ctx (agents are singletons; concurrent runs share the emitter).
export const AGENT_EVENT = Object.freeze({
  START:          'start',           // { name, assignmentId, input }
  MODEL_REQUEST:  'model:request',   // { name, assignmentId, iteration }
  MODEL_RESPONSE: 'model:response',  // { name, assignmentId, iteration, toolCalls }
  TOOL_CALL:      'tool:call',       // { name, assignmentId, tool, input, id }
  TOOL_RESULT:    'tool:result',     // { name, assignmentId, tool, content, error }
  COMPLETE:       'complete',        // { name, assignmentId, result }
  FAILED:         'failed',          // { name, assignmentId, error }
  INPUT_REQUEST:'input:request',
  THINKING_START:'thinking:start',
  THINKING_DONE:'thinking:done',
  ACTION_START:'action:start',
  ACTION_DONE: 'action:done'
});

// Intentional, AI-driven assignment signals — distinct from the lifecycle above.
// 'complete' fires when the loop ends; these fire when the model DECIDES the
// assignment is done (emitted by the finish_assignment tool).
export const ASSIGNMENT_EVENT = Object.freeze({
  SUCCEEDED: 'assignment:succeeded',  // payload: { assignmentId, result }
  FAILED:    'assignment:failed',     // payload: { assignmentId, error }
});

// Every event name an agent run can emit — for attaching a generic tap.
export const ALL_AGENT_EVENTS = Object.freeze([
  ...Object.values(AGENT_EVENT),
  ...Object.values(ASSIGNMENT_EVENT),
]);
