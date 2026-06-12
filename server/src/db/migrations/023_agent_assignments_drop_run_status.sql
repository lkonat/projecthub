-- Drop agent_assignments.run_status — assignment state now lives entirely in
-- assignments.status (see migration 022, which already folded run_status into
-- it). agent_assignments keeps only the agent-execution payload: the input,
-- result, error, model, usage, attempts, and run timing. There is no longer a
-- separate run-state column; the parent assignment's status IS the run state.
--
-- run_status carries an inline CHECK constraint, so it can't be removed with a
-- plain DROP COLUMN — the table is rebuilt (create new -> copy -> drop -> rename)
-- like the other enum/constraint changes. The runner disables foreign_keys for
-- the migration, so dropping the old table doesn't cascade.

CREATE TABLE agent_assignments_new (
  assignment_id INTEGER PRIMARY KEY REFERENCES assignments(id) ON DELETE CASCADE,
  input       TEXT,                       -- JSON: params passed to the agent's run()
  result      TEXT,                       -- the agent's output (text or JSON string)
  error       TEXT,                       -- failure message from the latest run
  model       TEXT,                       -- model used for the latest run
  usage       TEXT,                       -- JSON: token usage / metering
  attempts    INTEGER NOT NULL DEFAULT 0, -- how many times it has been run
  started_at  TEXT,                       -- when the latest run began
  finished_at TEXT                        -- when the latest run ended
);

INSERT INTO agent_assignments_new
  (assignment_id, input, result, error, model, usage, attempts, started_at, finished_at)
SELECT
  assignment_id, input, result, error, model, usage, attempts, started_at, finished_at
FROM agent_assignments;

DROP TABLE agent_assignments;
ALTER TABLE agent_assignments_new RENAME TO agent_assignments;
