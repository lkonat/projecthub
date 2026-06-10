-- Phases + assignments.
--
-- A project moves through an ordered list of phases. Each phase holds many
-- assignments (work given to a user, agent, or bot). An assignment is "done"
-- when it is resolved or cancelled. When every assignment in the current phase
-- is done (and there is at least one), the phase is marked done and the project
-- advances to the next open phase. When all phases are done the project is
-- closed (projects.status = 'completed') — handled in the service layer.
--
-- "Current phase" is derived, not stored: it is the lowest-position phase whose
-- status is still 'open'. Deleting a project cascades to its phases, and a
-- phase cascades to its assignments (foreign_keys pragma is ON in connection.js).

CREATE TABLE IF NOT EXISTS phases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_phases_project ON phases(project_id);

CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phase_id INTEGER NOT NULL REFERENCES phases(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  assignee_type TEXT NOT NULL DEFAULT 'user'
    CHECK(assignee_type IN ('user','agent','bot')),
  assignee_label TEXT,
  assignee_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK(status IN ('open','resolved','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_assignments_phase ON assignments(phase_id);
