-- Saved SSH connection profiles. Credentials are intentionally NOT stored:
-- auth is key-based, so we keep only a pointer to a private key on disk
-- (identity_file) and rely on the user's ssh-agent / ~/.ssh/config otherwise.
CREATE TABLE IF NOT EXISTS ssh_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  username TEXT,
  identity_file TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ssh_connections_name ON ssh_connections(name);
