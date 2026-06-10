-- Authentication: user accounts + per-user project ownership.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Projects belong to a user. Nullable so this migration applies cleanly to an
-- existing db; pre-auth projects (user_id IS NULL) are adopted by the first
-- account that registers. Deleting a user removes their projects (which
-- cascade to comments + checklist items via their own FKs).
ALTER TABLE projects ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
