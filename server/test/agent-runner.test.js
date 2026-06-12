// Tests for the agent runner engine (src/ai/runner/) — enqueueing an agent run
// and projecting the job lifecycle onto agent_assignments.run_status, using the
// real (singleton) queue and a fake LLM provider (no network).
//
// Run with:  node --test test/agent-runner.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'projecthub-runner-test-')), 'test.db');
process.env.DB_PATH = tmpDb;

const { runMigrations } = await import('../src/db/migrate.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const { Agent, agentRegistry } = await import('../src/ai/index.js');
const { queue } = await import('../src/queue/index.js');
const { agentRunner } = await import('../src/ai/runner/index.js');
const { agentsService } = await import('../src/modules/agents/agents.service.js');
const { projectsService } = await import('../src/modules/projects/projects.service.js');
const { phasesService } = await import('../src/modules/phases/phases.service.js');
const { assignmentsService } = await import('../src/modules/assignments/assignments.service.js');
const { userActor } = await import('../src/access/actor.js');

runMigrations();
agentRunner.init();
queue.start();
test.after(() => { queue.stop(); closeDb(); fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true }); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 3000, interval = 10 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await fn()) return; await sleep(interval); }
  throw new Error('waitFor timed out');
}

// A provider that returns fixed text — no network.
const fakeProvider = {
  async complete() { return { text: 'analysis done', toolCalls: [] }; },
};

let _u = 0;
function makeUser() {
  const info = getDb().prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(`u${++_u}`, 'x');
  return userActor(info.lastInsertRowid);
}
function registerAgent(slug) {
  agentRegistry.register(new (class extends Agent { static agentName = slug; static title = slug; })({ provider: fakeProvider }), 't');
  agentsService.syncFromRegistry();
  return agentsService.getBySlug(slug);
}

test('run() enqueues a job and the engine drives the agent to a succeeded run', async () => {
  const agent = registerAgent('analyst');
  const owner = makeUser();
  const project = await projectsService.create(owner, { name: 'P' });
  const phase = await phasesService.create(owner, project.id, { name: 'Phase 1' });
  const a = await assignmentsService.create(owner, phase.id, {
    title: 'analyze', assignee_type: 'agent', assignee_agent_id: agent.id,
  });

  // Enqueue via the owner-gated service entry point.
  const job = assignmentsService.requestRun(owner, a.id, {});
  assert.equal(job.type, 'agent-run');
  // Immediately queued.
  assert.ok(['queued', 'running', 'succeeded'].includes(assignmentsService.getAgentRun(a.id).run_status));

  // The queue processes it; run state ends 'succeeded' with the agent's output.
  await waitFor(() => assignmentsService.getAgentRun(a.id).run_status === 'succeeded');
  const ext = assignmentsService.getAgentRun(a.id);
  assert.equal(ext.result, 'analysis done');
  assert.ok(ext.started_at && ext.finished_at);
});

test('a second run() while one is active is deduped to the same job', async () => {
  const agent = registerAgent('dedup-agent');
  const owner = makeUser();
  const project = await projectsService.create(owner, { name: 'P2' });
  const phase = await phasesService.create(owner, project.id, { name: 'Phase 1' });
  const a = await assignmentsService.create(owner, phase.id, {
    title: 't', assignee_type: 'agent', assignee_agent_id: agent.id,
  });
  const j1 = agentRunner.run(a.id);
  const j2 = agentRunner.run(a.id);
  assert.equal(j1.id, j2.id); // same active job, not double-enqueued
  await waitFor(() => assignmentsService.getAgentRun(a.id).run_status === 'succeeded');
});

test('_execute throws DropJob when the assignment no longer exists (job gets dropped)', async () => {
  await assert.rejects(
    () => agentRunner._execute({ assignmentId: 999999 }),
    (e) => e.name === 'DropJob',
  );
});

test('_execute drops the job when the project is not active (done/cancelled)', async () => {
  const agent = registerAgent('done-project');
  const owner = makeUser();
  const project = await projectsService.create(owner, { name: 'DP' });
  const phase = await phasesService.create(owner, project.id, { name: 'Phase 1' }); // active
  const a = await assignmentsService.create(owner, phase.id, {
    title: 't', assignee_type: 'agent', assignee_agent_id: agent.id,
  });
  getDb().prepare("UPDATE projects SET status = 'cancelled' WHERE id = ?").run(project.id); // project frozen
  await assert.rejects(() => agentRunner._execute({ assignmentId: a.id }), (e) => e.name === 'DropJob');
});

test('_execute drops the job when the assignment phase is no longer active', async () => {
  const agent = registerAgent('phase-drop');
  const owner = makeUser();
  const project = await projectsService.create(owner, { name: 'PD' });
  await phasesService.create(owner, project.id, { name: 'Active' });             // active
  const idle = await phasesService.create(owner, project.id, { name: 'Idle' });  // idle (not active)
  const a = await assignmentsService.create(owner, idle.id, {
    title: 't', assignee_type: 'agent', assignee_agent_id: agent.id,
  });
  await assert.rejects(() => agentRunner._execute({ assignmentId: a.id }), (e) => e.name === 'DropJob');
});

test('requestRun is rejected when the assignment phase is not active', async () => {
  const agent = registerAgent('phase-gated');
  const owner = makeUser();
  const project = await projectsService.create(owner, { name: 'PG' });
  await phasesService.create(owner, project.id, { name: 'Active' });             // first phase → active
  const idle = await phasesService.create(owner, project.id, { name: 'Idle' });  // second phase → idle
  const a = await assignmentsService.create(owner, idle.id, {
    title: 't', assignee_type: 'agent', assignee_agent_id: agent.id,
  });
  assert.throws(() => assignmentsService.requestRun(owner, a.id, {}), /permission to assignment\.run/);
});

test('requestRun rejects an assignment with no agent assignee', async () => {
  const owner = makeUser();
  const project = await projectsService.create(owner, { name: 'P3' });
  const phase = await phasesService.create(owner, project.id, { name: 'Phase 1' });
  const a = await assignmentsService.create(owner, phase.id, { title: 'human', assignee_user_id: owner.id });
  assert.throws(() => assignmentsService.requestRun(owner, a.id, {}), /no agent assignee/);
});
