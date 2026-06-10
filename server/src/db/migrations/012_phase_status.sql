-- Phases gain a three-state status: idle | active | done (was: open | done).
--
--   idle   — planned but not started yet (an upcoming phase)
--   active — the current phase being worked (at most one per project)
--   done   — completed and frozen
--
-- Migrating existing rows: 'done' stays 'done'. The old 'open' phases split —
-- the lowest-position open phase in each project becomes 'active' (it was the
-- derived "current" phase), and any remaining open phases become 'idle'.
--
-- SQLite can't alter a CHECK constraint in place, so the table is rebuilt. The
-- migration runner disables foreign_keys for the run (see migrate.js), so
-- dropping the old phases table does NOT cascade-delete its assignments.

CREATE TABLE phases_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle','active','done')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO phases_new (id, project_id, name, description, position, status, created_at, updated_at)
SELECT
  id, project_id, name, description, position,
  CASE
    WHEN status = 'done' THEN 'done'
    WHEN id = (
      SELECT p2.id FROM phases p2
       WHERE p2.project_id = phases.project_id AND p2.status = 'open'
       ORDER BY p2.position ASC, p2.id ASC
       LIMIT 1
    ) THEN 'active'
    ELSE 'idle'
  END,
  created_at, updated_at
FROM phases;

DROP TABLE phases;
ALTER TABLE phases_new RENAME TO phases;

CREATE INDEX IF NOT EXISTS idx_phases_project ON phases(project_id);
