-- agent_assignments.execution_state — the agent's INTERNAL run-loop state, a
-- finer-grained axis than the assignment's status.
--
-- assignments.status is the outward lifecycle (pending/accepted/in_progress/…/
-- completed). execution_state is the inward runtime detail of a single run: what
-- the agent loop is doing right now. The two move independently — e.g. an
-- assignment can be 'in_progress' while its execution_state cycles through
-- planning → executing → waiting_tool → executing.
--
--   idle                not running
--   planning            deciding what to do / building a plan
--   executing           actively working (model call / tool loop)
--   waiting_permission  paused for a human/authorization decision
--   waiting_tool        blocked on a tool/external call to return
--   retrying            re-attempting after a transient failure
--   paused              suspended (will resume)
--   error               the run hit an error
--
-- Added in place: the column has a constant default that satisfies the CHECK, so
-- existing rows backfill to 'idle' without a table rebuild.
ALTER TABLE agent_assignments
  ADD COLUMN execution_state TEXT NOT NULL DEFAULT 'idle'
    CHECK(execution_state IN ('idle','planning','executing','waiting_permission',
                              'waiting_tool','retrying','paused','error'));
