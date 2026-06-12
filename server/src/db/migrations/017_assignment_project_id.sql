-- assignments.project_id — a denormalized, immutable copy of the assignment's
-- project (assignment → phase → project).
--
-- Why it's safe: the chain is immutable. An assignment never changes phase
-- (phase_id is set at insert, never updated) and a phase never changes project
-- (only its position is updated), so this column can never drift from
-- phase.project_id. It exists so assignments can be queried/aggregated by project
-- DIRECTLY — e.g. "every assignment (and its agent) in project X" — without a
-- join through phases. Populated at insert from the phase; never updated.

ALTER TABLE assignments
  ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE;

-- Backfill existing rows from their phase.
UPDATE assignments SET project_id = (
  SELECT ph.project_id FROM phases ph WHERE ph.id = assignments.phase_id
) WHERE project_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_assignments_project ON assignments(project_id);
