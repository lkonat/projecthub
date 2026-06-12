-- agent_assignments is a 1:1 EXTENSION of assignments — it shouldn't carry its
-- own created_at/updated_at. The parent assignment's timestamps are the single
-- source of truth: any run-state change is a change to the assignment, so the
-- assignments service bumps assignments.updated_at (in the same transaction).
ALTER TABLE agent_assignments DROP COLUMN created_at;
ALTER TABLE agent_assignments DROP COLUMN updated_at;
