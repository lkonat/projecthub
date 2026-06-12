-- agent_assignments — a 1:1 subtype/extension of `assignments` for agent-typed
-- assignments (assignee_type = 'agent').
--
-- Shared-primary-key pattern: assignment_id is BOTH the primary key AND the
-- foreign key, so there is at most one extension row per assignment and it is
-- deleted with its parent (ON DELETE CASCADE). The lean `assignments` row keeps
-- the columns every assignment needs; the agent-specific execution details live
-- here. A row exists IFF the assignment is currently agent-typed — it's created
-- with the assignment and dropped if the assignment is reassigned to a
-- user/bot (enforced in the assignments service, inside a transaction).
--
-- These columns track an agent RUN. Invocation isn't wired yet (assignment →
-- agent is linkage only for now); this is the durable place that run state will
-- be written once agents are actually invoked.

CREATE TABLE IF NOT EXISTS agent_assignments (
  assignment_id INTEGER PRIMARY KEY REFERENCES assignments(id) ON DELETE CASCADE,
  run_status TEXT NOT NULL DEFAULT 'idle'
    CHECK(run_status IN ('idle','queued','running','succeeded','failed')),
  input       TEXT,                       -- JSON: params passed to the agent's run()
  result      TEXT,                       -- the agent's output (text or JSON string)
  error       TEXT,                       -- failure message when run_status = 'failed'
  model       TEXT,                       -- model used for the latest run
  usage       TEXT,                       -- JSON: token usage / metering
  attempts    INTEGER NOT NULL DEFAULT 0, -- how many times it has been run
  started_at  TEXT,                       -- when the latest run began
  finished_at TEXT,                       -- when the latest run ended
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
