// Tool: resolve a task — mark its run succeeded or failed.
//
// A "task" is an assignment. Resolving it sets a terminal status via
// assignmentsService.recordRun, the same primitive the agent runner uses:
//
//   outcome 'succeed' → status 'completed' (its phase is re-evaluated — it may
//                       complete and advance the project, like a manual resolve).
//   outcome 'fail'    → status 'failed', error recorded; failed is NOT a "done"
//                       status, so the phase stays open and the work can be retried.
//
// Run-state writes are trusted, in-process operations, so — like the runner —
// we call recordRun with the SYSTEM actor (the trust lane that bypasses the
// `assignment.run` policy). These modules are server internals, not the AI
// core, so they're imported directly rather than through ../lib/core.js.
//
// This is a tool definition ({ name, description, input_schema, run }), not an
// auto-loaded agent: import it into an agent's tools() to let the model resolve
// the task it was given. The executor (`run`) is stripped from the wire schema.

import { assignmentsService } from '../../../../server/src/modules/assignments/assignments.service.js';
import { SYSTEM } from '../../../../server/src/access/actor.js';
import { ASSIGNMENT_STATUS, EXECUTION_STATE } from '../../../../server/src/constants/assignmentStates.js';

export default {
  name: 'resolve_task',
  description:
    "Resolve a task by recording its terminal outcome. Use outcome 'succeed' " +
    'when the task is done — this resolves the assignment (and may complete its ' +
    "phase). Use outcome 'fail' when it could not be completed — this records the " +
    'failure and leaves the task open so it can be retried.',
  input_schema: {
    type: 'object',
    properties: {
      assignmentId: {
        type: 'number',
        description: 'Id of the task (assignment) to resolve.',
      },
      outcome: {
        type: 'string',
        enum: ['succeed', 'fail'],
        description: "Terminal outcome: 'succeed' resolves the task, 'fail' records an error.",
      },
      error: {
        type: 'string',
        description: "Failure message — recorded when outcome is 'fail'; ignored on success.",
      },
    },
    required: ['assignmentId', 'outcome'],
  },

  async run({ assignmentId, outcome, error }, ctx = {}) {
    const succeeded = outcome === 'succeed';
    const status = succeeded ? ASSIGNMENT_STATUS.COMPLETED : ASSIGNMENT_STATUS.FAILED;
    const run = await assignmentsService.recordRun({
      actor: SYSTEM,
      assignmentId,
      status,
      runFields: {
        execution_state: succeeded ? EXECUTION_STATE.IDLE : EXECUTION_STATE.ERROR,
        error: succeeded ? null : (error?.trim() || 'Task failed.'),
        finished_at: new Date().toISOString(),
      },
    });
    ctx.log?.log?.(
      `[tasks-tool] assignment ${assignmentId} → ${status}` +
      (succeeded ? '' : `: ${run?.error}`)
    );
    return {
      assignmentId,
      status,                       // 'completed' | 'failed'
      error: run?.error,
      finished_at: run?.finished_at,
    };
  },
};
