-- Agents as first-class, assignable system entities.
--
-- The code agents live in extensions/ai/agents/ and are registered in an
-- in-memory registry at boot. This table is their durable projection: the boot
-- sync (server/src/modules/agents/) upserts every registered agent here by
-- `slug`, so an agent can be referenced by assignments with referential
-- integrity — not just a free-text label.
--
-- Agents are NOT login accounts: no username/password, never in the users table.
-- `slug` is the stable key linking a DB row to its code agent (the registry
-- name, e.g. 'cancel-impact'). `status` tracks whether that code agent is still
-- present: a row whose code was removed is marked 'missing' rather than deleted,
-- so assignments that referenced it keep their history.

CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  input_schema TEXT,                       -- JSON Schema for the agent's run() input
  event TEXT,                              -- lifecycle event for EventAgents, else NULL
  enabled INTEGER NOT NULL DEFAULT 1,      -- 0 hides it from assignment without deleting
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','missing')), -- 'missing' = code agent no longer registered
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Link an assignment to a registered agent. assignee_type already allows 'agent'
-- (009); this gives that case a real foreign key. ON DELETE SET NULL is defensive
-- only — the sync never hard-deletes agents, it marks them 'missing'.
ALTER TABLE assignments
  ADD COLUMN assignee_agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_assignments_agent ON assignments(assignee_agent_id);
