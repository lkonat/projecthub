-- Simplify the project status enum to: active | cancelled | done.
--
-- Old values are folded into the new set:
--   'completed' -> 'done'      (finished work)
--   'archived'  -> 'done'      (closed/filed away — also terminal)
--   'paused'    -> 'active'    (paused isn't terminal; the only live status left)
--
-- SQLite can't alter a CHECK constraint in place, so the table is rebuilt
-- (create new → copy → drop old → rename). The migration runner disables
-- foreign_keys for the run (see migrate.js), so dropping the old projects table
-- does NOT cascade-delete child rows (comments, phases, checklist_items).

CREATE TABLE projects_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  priority TEXT NOT NULL DEFAULT 'medium'
    CHECK(priority IN ('low','medium','high','critical')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','cancelled','done')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  type TEXT,
  fields TEXT,
  meta TEXT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO projects_new
  (id, name, description, priority, status, created_at, updated_at, type, fields, meta, user_id)
SELECT
  id, name, description, priority,
  CASE status
    WHEN 'completed' THEN 'done'
    WHEN 'archived'  THEN 'done'
    WHEN 'paused'    THEN 'active'
    ELSE status
  END,
  created_at, updated_at, type, fields, meta, user_id
FROM projects;

DROP TABLE projects;
ALTER TABLE projects_new RENAME TO projects;

-- Recreate the indexes that lived on the old table.
CREATE INDEX IF NOT EXISTS idx_projects_priority ON projects(priority);
CREATE INDEX IF NOT EXISTS idx_projects_status   ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_type     ON projects(type);
CREATE INDEX IF NOT EXISTS idx_projects_user     ON projects(user_id);
