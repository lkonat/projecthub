// Tests for:
//   - assignments.project_id  — denormalized from the phase at insert
//   - agent_assignments       — the 1:1 extension of an agent-typed assignment:
//       created eagerly with an agent assignment, dropped on reassign-away,
//       cascaded on delete, and surfaced in listForPhase.
//
// Run with:  node --test test/agent-assignments.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmpDb = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'projecthub-agent-assign-test-')),
  'test.db'
);
process.env.DB_PATH = tmpDb;

const { runMigrations } = await import('../src/db/migrate.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const { Agent, agentRegistry } = await import('../src/ai/index.js');
const { agentsService } = await import('../src/modules/agents/agents.service.js');
const { projectsService } = await import('../src/modules/projects/projects.service.js');
const { phasesService } = await import('../src/modules/phases/phases.service.js');
const { assignmentsService } = await import('../src/modules/assignments/assignments.service.js');
const { userActor } = await import('../src/access/actor.js');

runMigrations();

test.after(() => {
  closeDb();
  fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });
});

let _u = 0;
function makeUser() {
  const info = getDb().prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(`u${++_u}`, 'x');
  return userActor(info.lastInsertRowid);
}
function registerAgent(slug) {
  agentRegistry.register(new (class extends Agent { static agentName = slug; static title = slug; })({ provider: {} }), 't');
  agentsService.syncFromRegistry();
  return agentsService.getBySlug(slug);
}
const extRow = (assignmentId) =>
  getDb().prepare('SELECT * FROM agent_assignments WHERE assignment_id = ?').get(assignmentId);

async function scaffold() {
  const owner = makeUser();
  const project = await projectsService.create(owner, { name: 'P' });
  const phase = await phasesService.create(owner, project.id, { name: 'Phase 1' });
  return { owner, project, phase };
}

test('assignment.project_id is denormalized from the phase at insert', async () => {
  const { owner, project, phase } = await scaffold();
  const a = await assignmentsService.create(owner, phase.id, { title: 'task' });
  assert.equal(a.project_id, project.id);
});

test('an agent assignment eagerly creates its 1:1 extension row (run_status idle)', async () => {
  agentRegistry._reset();
  const agent = registerAgent('runner');
  const { owner, phase } = await scaffold();

  const a = await assignmentsService.create(owner, phase.id, {
    title: 'do it', assignee_type: 'agent', assignee_agent_id: agent.id,
  });
  const ext = extRow(a.id);
  assert.ok(ext, 'extension row should exist for an agent assignment');
  assert.equal(ext.run_status, 'idle');
  assert.equal(ext.attempts, 0);
});

test('a non-agent assignment has NO extension row', async () => {
  const { owner, phase } = await scaffold();
  const a = await assignmentsService.create(owner, phase.id, { title: 'human task', assignee_user_id: owner.id });
  assert.equal(extRow(a.id), undefined);
});

test('listForPhase attaches the agent extension only for agent assignees', async () => {
  agentRegistry._reset();
  const agent = registerAgent('lister');
  const { owner, phase } = await scaffold();
  await assignmentsService.create(owner, phase.id, { title: 'human', assignee_user_id: owner.id });
  await assignmentsService.create(owner, phase.id, { title: 'bot-y', assignee_type: 'agent', assignee_agent_id: agent.id });

  const rows = assignmentsService.listForPhase(owner, phase.id);
  const human = rows.find((r) => r.title === 'human');
  const agentRow = rows.find((r) => r.title === 'bot-y');
  assert.equal(human.agent, undefined);
  assert.equal(agentRow.agent.run_status, 'idle');
});

test('reassigning an agent → user DELETES the extension row; user → agent CREATES it', async () => {
  agentRegistry._reset();
  const agent = registerAgent('switch');
  const { owner, phase } = await scaffold();

  // Start as agent → row exists.
  const a = await assignmentsService.create(owner, phase.id, { title: 't', assignee_type: 'agent', assignee_agent_id: agent.id });
  assert.ok(extRow(a.id));

  // Reassign to a user → row dropped.
  await assignmentsService.update(owner, a.id, { assignee_type: 'user', assignee_user_id: owner.id });
  assert.equal(extRow(a.id), undefined);

  // Reassign back to the agent → row recreated.
  await assignmentsService.update(owner, a.id, { assignee_type: 'agent', assignee_agent_id: agent.id });
  assert.ok(extRow(a.id));
});

test('deleting the assignment cascades to the extension row', async () => {
  agentRegistry._reset();
  const agent = registerAgent('doomed');
  const { owner, phase } = await scaffold();
  const a = await assignmentsService.create(owner, phase.id, { title: 't', assignee_type: 'agent', assignee_agent_id: agent.id });
  assert.ok(extRow(a.id));

  await assignmentsService.remove(owner, a.id);
  assert.equal(extRow(a.id), undefined);
});

test('recordRun upserts: a missing extension row is created so run-state lands', async () => {
  agentRegistry._reset();
  const agent = registerAgent('upsert-agent');
  const { owner, phase } = await scaffold();
  const a = await assignmentsService.create(owner, phase.id, { title: 't', assignee_type: 'agent', assignee_agent_id: agent.id });

  // Simulate drift (e.g. an assignment created before this table existed).
  getDb().prepare('DELETE FROM agent_assignments WHERE assignment_id = ?').run(a.id);
  assert.equal(extRow(a.id), undefined);

  // recordRun must recreate the row, not silently no-op.
  await assignmentsService.recordRun({ actor: owner, assignmentId: a.id, runFields: { run_status: 'running' } });
  assert.equal(extRow(a.id)?.run_status, 'running');
});

test('recordRun bumps the parent assignment.updated_at (extension has no own timestamps)', async () => {
  agentRegistry._reset();
  const agent = registerAgent('touch-agent');
  const { owner, phase } = await scaffold();
  const a = await assignmentsService.create(owner, phase.id, { title: 't', assignee_type: 'agent', assignee_agent_id: agent.id });
  getDb().prepare("UPDATE assignments SET updated_at = '2000-01-01 00:00:00' WHERE id = ?").run(a.id); // backdate

  await assignmentsService.recordRun({ actor: owner, assignmentId: a.id, runFields: { run_status: 'running' } });

  const after = getDb().prepare('SELECT updated_at FROM assignments WHERE id = ?').get(a.id).updated_at;
  assert.notEqual(after, '2000-01-01 00:00:00'); // a run-state change bumps the parent
});

test('recordRun derives the assignment status from the run: succeeded → resolved (one transaction)', async () => {
  agentRegistry._reset();
  const agent = registerAgent('joint');
  const { owner, phase } = await scaffold();
  const a = await assignmentsService.create(owner, phase.id, { title: 't', assignee_type: 'agent', assignee_agent_id: agent.id });

  // A succeeded run resolves the assignment — DERIVED from the run, not passed in.
  await assignmentsService.recordRun({ actor: owner, assignmentId: a.id, runFields: { run_status: 'succeeded' } });

  assert.equal(extRow(a.id).run_status, 'succeeded');
  assert.equal(getDb().prepare('SELECT status FROM assignments WHERE id = ?').get(a.id).status, 'resolved');
});

test('recordRun is authorized: a non-owner actor cannot record run state', async () => {
  agentRegistry._reset();
  const agent = registerAgent('guarded');
  const { owner, phase } = await scaffold();
  const a = await assignmentsService.create(owner, phase.id, { title: 't', assignee_type: 'agent', assignee_agent_id: agent.id });

  const stranger = makeUser(); // not the owner, not an assignee
  await assert.rejects(
    () => assignmentsService.recordRun({ actor: stranger, assignmentId: a.id, runFields: { run_status: 'running' } }),
  );
  // The owner (and the SYSTEM runner) may.
  await assignmentsService.recordRun({ actor: owner, assignmentId: a.id, runFields: { run_status: 'running' } });
  assert.equal(extRow(a.id).run_status, 'running');
});

test('a failed run leaves the assignment status unchanged (stays open, re-runnable)', async () => {
  agentRegistry._reset();
  const agent = registerAgent('failer');
  const { owner, phase } = await scaffold();
  const a = await assignmentsService.create(owner, phase.id, { title: 't', assignee_type: 'agent', assignee_agent_id: agent.id });

  await assignmentsService.recordRun({ actor: owner, assignmentId: a.id, runFields: { run_status: 'failed', error: 'boom' } });

  assert.equal(extRow(a.id).run_status, 'failed');
  assert.equal(getDb().prepare('SELECT status FROM assignments WHERE id = ?').get(a.id).status, 'open');
});

test('recordRun updates the extension row (JSON columns round-trip)', async () => {
  agentRegistry._reset();
  const agent = registerAgent('worker');
  const { owner, phase } = await scaffold();
  const a = await assignmentsService.create(owner, phase.id, { title: 't', assignee_type: 'agent', assignee_agent_id: agent.id });

  const updated = await assignmentsService.recordRun({
    actor: owner,
    assignmentId: a.id,
    runFields: {
      run_status: 'succeeded',
      input: { x: 1 },
      result: 'all good',
      usage: { tokens: 42 },
      attempts: 1,
    },
  });
  assert.equal(updated.run_status, 'succeeded');
  assert.deepEqual(updated.input, { x: 1 });
  assert.equal(updated.result, 'all good');
  assert.deepEqual(updated.usage, { tokens: 42 });
  assert.equal(updated.attempts, 1);
});
