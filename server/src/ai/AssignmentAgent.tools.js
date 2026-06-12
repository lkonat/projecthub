// Tools for AssignmentAgent — kept next to the agent that uses them.
//
// finish_assignment is a PURE SIGNAL tool: it does NOT touch the database. When
// the model decides the assignment is done it calls this, and the tool EMITS the
// outcome on the running agent (via ctx.emit, provided by Agent._run). Whoever
// orchestrates the run listens and persists it — the runner maps the event to
// assignmentsService.recordRun. So the agent/tool stay decoupled from storage:
// the tool only announces intent.
//
// Events emitted (names from the shared agentEvents.js, so emitter and listener
// can't drift):
//   succeed → 'assignment:succeeded'  { assignmentId, result }
//   fail    → 'assignment:failed'     { assignmentId, error }
//
// `assignmentId` rides along from ctx so a listener can correlate the signal to
// the right assignment (agents are singletons; concurrent runs share the emitter).

import {AGENT_EVENT} from './agentEvents.js';

export const finishAssignment = {
  name: 'finish_assignment',
  // Terminal: calling this once ends the run (see Agent._run). It's a one-shot
  // "I'm done" signal, not a step — so the model can't keep re-calling it.
  final: true,
  description:
    "Call this once when you have finished the assignment. Use outcome 'succeed' " +
    'and pass your output as `result`. Use outcome `fail` and explain in `error` ' +
    'if you could not complete it. This reports the outcome — it does not write ' +
    'storage directly.',
  input_schema: {
    type: 'object',
    properties: {
      outcome: {
        type: 'string',
        enum: ['succeed', 'fail'],
        description: "'succeed' if the assignment is done, 'fail' if it cannot be completed.",
      },
      result: {
        type: 'string',
        description: "Your output/answer — provide when outcome is 'succeed'.",
      },
      error: {
        type: 'string',
        description: "Why it could not be completed — provide when outcome is 'fail'.",
      },
    },
    required: ['outcome'],
  },

  run({ outcome, result, error }, ctx = {}) {
    const succeeded = outcome === 'succeed';
    if (succeeded) {
      ctx.emit?.(AGENT_EVENT.COMPLETE, { assignmentId: ctx.assignmentId, result: result ?? null });
      return 'Reported success.';
    }
    ctx.emit?.(AGENT_EVENT.FAILED, { assignmentId: ctx.assignmentId, result: result ?? null, error: error?.trim() || 'Assignment failed.' });
    return 'Reported failure.';
  },
};
export const askQuestion = {
  name: 'ask_question',
  // Terminal: calling this once ends the run (see Agent._run). It's a one-shot
  // "I'm done" signal, not a step — so the model can't keep re-calling it.
  final: true,
  description:
    "Call this when you need to ask user any question",
  input_schema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: "the question to ask user",
      }
    },
    required: ['question'],
  },

  run({ question }, ctx = {}) {
    ctx.emit?.(AGENT_EVENT.INPUT_REQUEST, { assignmentId: ctx.assignmentId, question });
    return 'asked question';
  },
};
// The AssignmentAgent's tool set (see AssignmentAgent.taskTools()).
export const assignmentAgentTools = [finishAssignment,askQuestion];

export default assignmentAgentTools;
