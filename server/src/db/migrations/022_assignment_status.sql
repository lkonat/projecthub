-- Replace the assignment status enum with a richer, unified set — the single
-- source of truth for an assignment's state (agent runs included). Old enum was
-- open | resolved | cancelled; agent run state lived separately in
-- agent_assignments.run_status. Both collapse into assignments.status here:
--
--   pending      Assigned but not yet started. (was 'open')
--   accepted     Assignee acknowledged responsibility.
--   in_progress  Work has started.
--   blocked      Cannot continue until something is resolved.
--   waiting      Waiting on another assignment, approval, input, or event.
--   completed    Work finished successfully. (was 'resolved')
--   failed       Attempted but could not complete.
--   cancelled    Intentionally cancelled.
--   rejected     Assignee declined the assignment.
--
-- Value migration: open -> pending, resolved -> completed, cancelled stays.
--
-- SQLite can't alter a CHECK constraint in place, so the table is rebuilt
-- (create new -> copy -> drop old -> rename). The migration runner disables
-- foreign_keys for the run (see migrate.js), so dropping the old assignments
-- table does NOT cascade-delete its agent_assignments / children, and the FK
-- references (by table name) stay valid after the rename.

CREATE TABLE assignments_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phase_id INTEGER NOT NULL REFERENCES phases(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  assignee_type TEXT NOT NULL DEFAULT 'user'
    CHECK(assignee_type IN ('user','agent','bot')),
  assignee_label TEXT,
  assignee_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','accepted','in_progress','blocked','waiting',
                     'completed','failed','cancelled','rejected')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  cancel_reason TEXT,
  assignee_agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE
);

INSERT INTO assignments_new
  (id, phase_id, title, description, assignee_type, assignee_label,
   assignee_user_id, status, created_at, updated_at, cancel_reason,
   assignee_agent_id, project_id)
SELECT
  id, phase_id, title, description, assignee_type, assignee_label,
  assignee_user_id,
  CASE status
    WHEN 'open'     THEN 'pending'
    WHEN 'resolved' THEN 'completed'
    ELSE status
  END,
  created_at, updated_at, cancel_reason, assignee_agent_id, project_id
FROM assignments;

DROP TABLE assignments;
ALTER TABLE assignments_new RENAME TO assignments;

-- Recreate the indexes that lived on the old table.
CREATE INDEX IF NOT EXISTS idx_assignments_phase   ON assignments(phase_id);
CREATE INDEX IF NOT EXISTS idx_assignments_agent   ON assignments(assignee_agent_id);
CREATE INDEX IF NOT EXISTS idx_assignments_project ON assignments(project_id);

-- Fold the now-retired agent_assignments.run_status into the unified status for
-- in-flight / failed agent runs that hadn't otherwise resolved (status still the
-- mapped 'pending'). A succeeded run already mapped to 'completed' via resolved
-- above; idle leaves it 'pending'. (run_status is dropped in the next migration.)
UPDATE assignments
   SET status = (
     SELECT CASE aa.run_status
              WHEN 'running'   THEN 'in_progress'
              WHEN 'queued'    THEN 'accepted'
              WHEN 'failed'    THEN 'failed'
              WHEN 'succeeded' THEN 'completed'
              ELSE 'pending'
            END
       FROM agent_assignments aa
      WHERE aa.assignment_id = assignments.id)
 WHERE status = 'pending'
   AND id IN (SELECT assignment_id FROM agent_assignments);
