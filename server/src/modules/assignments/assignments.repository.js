import { getDb } from '../../db/connection.js';
import { DONE_STATUSES } from '../../constants/assignmentStates.js';

// SQL list of the "done" statuses, derived from the shared constant so the
// queries below can't drift from it. Safe to inline: these are fixed enum
// values, never user input.
const DONE_SQL = DONE_STATUSES.map((s) => `'${s}'`).join(',');

export const assignmentsRepository = {
  listByPhase(phaseId) {
    return getDb()
      .prepare('SELECT * FROM assignments WHERE phase_id = ? ORDER BY id ASC')
      .all(phaseId);
  },

  findById(id) {
    return getDb().prepare('SELECT * FROM assignments WHERE id = ?').get(id);
  },

  // Bump updated_at without changing any field — used when only the assignment's
  // agent_assignments extension changed (the extension has no timestamps of its
  // own; the parent's are authoritative).
  touch(id) {
    getDb().prepare("UPDATE assignments SET updated_at = datetime('now') WHERE id = ?").run(id);
    return this.findById(id);
  },

  // Enriched columns shared by the "my assignments" queries: each assignment
  // carries its phase + project context so the client can group/link without
  // extra round-trips.
  // (kept inline in each query string below for clarity)

  // Every assignment assigned to `userId`, across all projects/phases/statuses.
  // Powers the "All tasks" page.
  listForUser(userId) {
    return getDb()
      .prepare(
        `SELECT a.*,
                ph.name     AS phase_name,
                ph.status   AS phase_status,
                ph.position AS phase_position,
                pr.id       AS project_id,
                pr.name     AS project_name,
                pr.status   AS project_status,
                pr.user_id  AS project_owner_id
           FROM assignments a
           JOIN phases ph   ON a.phase_id = ph.id
           JOIN projects pr ON ph.project_id = pr.id
          WHERE a.assignee_user_id = ?
          ORDER BY pr.name COLLATE NOCASE ASC, ph.position ASC, a.id ASC`
      )
      .all(userId);
  },

  // Assignments assigned to `userId` that are still OPEN and sit in their
  // project's CURRENT phase (lowest-position open phase). Powers the
  // "Current assignments" page — what the user should work on now.
  listCurrentForUser(userId) {
    return getDb()
      .prepare(
        `SELECT a.*,
                ph.name     AS phase_name,
                ph.status   AS phase_status,
                ph.position AS phase_position,
                pr.id       AS project_id,
                pr.name     AS project_name,
                pr.status   AS project_status,
                pr.user_id  AS project_owner_id
           FROM assignments a
           JOIN phases ph   ON a.phase_id = ph.id
           JOIN projects pr ON ph.project_id = pr.id
          WHERE a.assignee_user_id = ?
            AND a.status NOT IN (${DONE_SQL})
            AND ph.status = 'open'
            AND ph.position = (
              SELECT MIN(p2.position) FROM phases p2
               WHERE p2.project_id = pr.id AND p2.status = 'open'
            )
          ORDER BY pr.name COLLATE NOCASE ASC, a.id ASC`
      )
      .all(userId);
  },

  // Tally for a phase. `total` is all assignments; `done` is the ones that no
  // longer need work (completed or cancelled) — what phase completion keys on.
  statusCounts(phaseId) {
    return getDb()
      .prepare(
        `SELECT
           COUNT(*)                                                AS total,
           COALESCE(SUM(status IN (${DONE_SQL})), 0)   AS done
         FROM assignments WHERE phase_id = ?`
      )
      .get(phaseId);
  },

  create({ phaseId, projectId = null, title, description = null, assigneeType = 'user', assigneeLabel = null, assigneeUserId = null, assigneeAgentId = null }) {
    const info = getDb()
      .prepare(
        `INSERT INTO assignments (phase_id, project_id, title, description, assignee_type, assignee_label, assignee_user_id, assignee_agent_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(phaseId, projectId, title, description, assigneeType, assigneeLabel, assigneeUserId, assigneeAgentId);
    return this.findById(info.lastInsertRowid);
  },

  // Partial update. Only keys present in `patch` are written; `updated_at` is
  // always touched. Returns the refreshed row (or undefined if id is gone).
  update(id, patch) {
    const sets = [];
    const args = [];
    if (patch.title !== undefined)          { sets.push('title = ?');            args.push(patch.title); }
    if (patch.description !== undefined)    { sets.push('description = ?');      args.push(patch.description); }
    if (patch.assignee_type !== undefined)  { sets.push('assignee_type = ?');    args.push(patch.assignee_type); }
    if (patch.assignee_label !== undefined) { sets.push('assignee_label = ?');   args.push(patch.assignee_label); }
    if (patch.assignee_user_id !== undefined) { sets.push('assignee_user_id = ?'); args.push(patch.assignee_user_id); }
    if (patch.assignee_agent_id !== undefined) { sets.push('assignee_agent_id = ?'); args.push(patch.assignee_agent_id); }
    if (patch.status !== undefined)         { sets.push('status = ?');           args.push(patch.status); }
    if (patch.cancel_reason !== undefined)  { sets.push('cancel_reason = ?');     args.push(patch.cancel_reason); }
    if (sets.length === 0) return this.findById(id);
    sets.push("updated_at = datetime('now')");
    args.push(id);
    getDb().prepare(`UPDATE assignments SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    return this.findById(id);
  },

  remove(id) {
    return getDb().prepare('DELETE FROM assignments WHERE id = ?').run(id).changes > 0;
  },
};
