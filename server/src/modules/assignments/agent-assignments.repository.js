import { getDb } from '../../db/connection.js';

// Data access for agent_assignments — the 1:1 extension of an agent-typed
// assignment (keyed by assignment_id, the shared primary key). Lifecycle
// (create on agent-assign, delete on reassign-away, cascade on delete) is
// orchestrated by the assignments service inside a transaction.
// Agent-execution columns. The assignment's outward state is assignments.status;
// `execution_state` here is the agent's internal run-loop state (a finer axis).
const RUN_COLS = ['execution_state', 'input', 'result', 'error', 'model', 'usage', 'attempts', 'started_at', 'finished_at'];

export const agentAssignmentsRepository = {
  create({ assignmentId, input = null }) {
    getDb()
      .prepare('INSERT INTO agent_assignments (assignment_id, input) VALUES (?, ?)')
      .run(assignmentId, input);
    return this.findById(assignmentId);
  },

  findById(assignmentId) {
    return getDb().prepare('SELECT * FROM agent_assignments WHERE assignment_id = ?').get(assignmentId);
  },

  // Ensure the row exists (with defaults), then apply the partial update. Used by
  // recordRun so run-state writes never silently no-op on a missing extension row
  // (e.g. an agent assignment created before this table existed).
  upsert(assignmentId, patch) {
    getDb()
      .prepare('INSERT INTO agent_assignments (assignment_id) VALUES (?) ON CONFLICT(assignment_id) DO NOTHING')
      .run(assignmentId);
    return this.update(assignmentId, patch);
  },

  // Partial update of the run columns. No updated_at here — this table has no
  // timestamps of its own; the parent assignment's updated_at is bumped by the
  // assignments service in the same transaction.
  update(assignmentId, patch) {
    const sets = [];
    const args = [];
    for (const c of RUN_COLS) {
      if (patch[c] !== undefined) { sets.push(`${c} = ?`); args.push(patch[c]); }
    }
    if (sets.length === 0) return this.findById(assignmentId);
    args.push(assignmentId);
    getDb().prepare(`UPDATE agent_assignments SET ${sets.join(', ')} WHERE assignment_id = ?`).run(...args);
    return this.findById(assignmentId);
  },

  remove(assignmentId) {
    return getDb().prepare('DELETE FROM agent_assignments WHERE assignment_id = ?').run(assignmentId).changes > 0;
  },
};
