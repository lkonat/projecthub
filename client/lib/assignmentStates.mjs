// Single source of truth for the assignment status + agent execution-state enums.
//
// Imported by BOTH runtimes:
//   • the browser client — `import { … } from './lib/assignmentStates.mjs'`
//   • the Node server     — via `server/src/constants/assignmentStates.js`
//     (a thin re-export, so the one cross-boundary path lives in a single file).
//
// Keep this file PURE: ESM, zero dependencies, no Node/DOM APIs — it must run
// unchanged in both. It is `.mjs` so Node always treats it as ESM (there is no
// package.json under client/).
//
// The DB CHECK constraints mirror these lists and must be kept in sync:
//   • status          → server/src/db/migrations/022_assignment_status.sql
//   • execution_state → server/src/db/migrations/024_agent_assignments_execution_state.sql

// ── Assignment status: the outward lifecycle of an assignment ───────────────
export const ASSIGNMENT_STATUS = Object.freeze({
  PENDING:     'pending',      // assigned but not yet started
  ACCEPTED:    'accepted',     // assignee acknowledged responsibility
  IN_PROGRESS: 'in_progress',  // work has started
  BLOCKED:     'blocked',      // cannot continue until something is resolved
  WAITING:     'waiting',      // waiting on another assignment, approval, input, or event
  COMPLETED:   'completed',    // work finished successfully
  FAILED:      'failed',       // attempted but could not complete
  CANCELLED:   'cancelled',    // intentionally cancelled
  REJECTED:    'rejected',     // assignee declined the assignment
});
// All status values, in declaration order (matches the migration's CHECK list).
export const ASSIGNMENT_STATUSES = Object.freeze(Object.values(ASSIGNMENT_STATUS));

// "Done" — the assignment no longer needs work, so its phase can complete.
export const DONE_STATUSES = Object.freeze([
  ASSIGNMENT_STATUS.COMPLETED,
  ASSIGNMENT_STATUS.CANCELLED,
]);

// The statuses an agent run passes through while it's "in flight" (the client
// polls run state while the assignment is in one of these).
export const RUN_ACTIVE_STATUSES = Object.freeze([
  ASSIGNMENT_STATUS.ACCEPTED,
  ASSIGNMENT_STATUS.IN_PROGRESS,
]);

// ── Execution state: the agent's INTERNAL run-loop state (a finer axis) ──────
export const EXECUTION_STATE = Object.freeze({
  IDLE:               'idle',                // not running
  PLANNING:           'planning',            // deciding what to do / building a plan
  EXECUTING:          'executing',           // actively working (model call / tool loop)
  WAITING_PERMISSION: 'waiting_permission',  // paused for a human/authorization decision
  WAITING_TOOL:       'waiting_tool',        // blocked on a tool/external call
  RETRYING:           'retrying',            // re-attempting after a transient failure
  PAUSED:             'paused',              // suspended (will resume)
  ERROR:              'error',               // the run hit an error
});
// All execution-state values, in declaration order (matches the migration).
export const EXECUTION_STATES = Object.freeze(Object.values(EXECUTION_STATE));
