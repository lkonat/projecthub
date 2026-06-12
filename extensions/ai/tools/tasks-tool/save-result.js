// Tool: save a task's result — persist output without resolving it.
//
// A "task" is an assignment. This records the run's `result` (and, optionally,
// the model and token usage) on its agent_assignments extension row via
// assignmentsService.recordRun. It passes NO status, so the assignment's own
// status is left untouched — only the result is stored and the parent's
// updated_at is bumped. Resolving the task is a separate step; see ./resolve-task.js.
//
// Like the runner, run-state writes use the SYSTEM actor (the in-process trust
// lane that bypasses the `assignment.run` policy). recordRun stores `result` as
// a plain string column, so non-string results are JSON-stringified here.
//
// A tool definition ({ name, description, input_schema, run }), not an
// auto-loaded agent — import it into an agent's tools().

import { assignmentsService } from '../../../../server/src/modules/assignments/assignments.service.js';
import { SYSTEM } from '../../../../server/src/access/actor.js';

export default {
  name: 'save_task_result',
  description:
    'Save the result of a task without resolving it. Records the output (and ' +
    "optionally the model used and token usage) on the task's run, leaving its " +
    'status unchanged so it can still be resolved or retried afterward.',
  input_schema: {
    type: 'object',
    properties: {
      assignmentId: {
        type: 'number',
        description: 'Id of the task (assignment) to save the result on.',
      },
      result: {
        type: 'string',
        description: "The task's result/output to persist.",
      },
      model: {
        type: 'string',
        description: 'Optional — the model that produced the result.',
      },
      usage: {
        type: 'object',
        description: 'Optional — token usage for the run (e.g. { input, output }).',
      },
    },
    required: ['assignmentId', 'result'],
  },

  async run({ assignmentId, result, model, usage }, ctx = {}) {
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    await assignmentsService.recordRun({
      actor: SYSTEM,
      assignmentId,
      runFields: {
        result: text,
        ...(model !== undefined ? { model } : {}),
        ...(usage !== undefined ? { usage } : {}),
      },
    });
    ctx.log?.log?.(`[tasks-tool] saved result on assignment ${assignmentId} (${text.length} chars)`);
    return {
      assignmentId,
      saved: true,
    };
  },
};
