-- Backfill agent_assignments for agent-typed assignments missing their 1:1 row.
--
-- The extension table (018) is created with each NEW agent assignment, but agent
-- assignments created before that — or by an older server build — never got a
-- row. With no row, run-state updates (recordRun) silently no-op'd and the UI
-- showed 'idle' forever. Restore the invariant "a row exists for every agent
-- assignment" by inserting the missing ones at their default (run_status='idle').
INSERT INTO agent_assignments (assignment_id)
SELECT a.id
  FROM assignments a
 WHERE a.assignee_type = 'agent'
   AND NOT EXISTS (SELECT 1 FROM agent_assignments aa WHERE aa.assignment_id = a.id);
