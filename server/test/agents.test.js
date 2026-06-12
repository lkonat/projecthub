// Tests for agents as first-class, assignable system entities:
//   - syncFromRegistry() projects the in-memory registry into the agents table
//   - re-sync is idempotent and marks vanished agents 'missing' (never deletes)
//   - an assignment can target an agent; bad/missing/disabled agents are rejected
//
// Run with:  node --test test/agents.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmpDb = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'projecthub-agents-test-')),
  'test.db'
);
process.env.DB_PATH = tmpDb;

const { runMigrations } = await import('../src/db/migrate.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const { Agent, agentRegistry } = await import('../src/ai/index.js');
const { agentsService } = await import('../src/modules/agents/agents.service.js');
const { agentsRepository } = await import('../src/modules/agents/agents.repository.js');
const { projectsService } = await import('../src/modules/projects/projects.service.js');
const { phasesService } = await import('../src/modules/phases/phases.service.js');
const { assignmentsService } = await import('../src/modules/assignments/assignments.service.js');
const { userActor } = await import('../src/access/actor.js');

runMigrations();

test.after(() => {
  closeDb();
  fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });
});

function makeAgent(name, { title = '', description = '', inputSchema, event } = {}) {
  return new (class extends Agent {
    static agentName = name;
    static title = title;
    static description = description;
    static inputSchema = inputSchema;
    static event = event;
  })({ provider: {} });
}

function makeUser(n) {
  const info = getDb().prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(`u${n}`, 'x');
  return userActor(info.lastInsertRowid);
}

test('syncFromRegistry: inserts registered agents into the table', () => {
  agentRegistry._reset();
  agentRegistry.register(makeAgent('summarize', { title: 'Summarizer', description: 'summarizes', inputSchema: { type: 'object' } }), 't');
  agentRegistry.register(makeAgent('triage'), 't'); // no title set

  const res = agentsService.syncFromRegistry();
  assert.equal(res.synced, 2);

  const a = agentsService.getBySlug('summarize');
  assert.equal(a.slug, 'summarize');     // the unique name
  assert.equal(a.title, 'Summarizer');   // human-friendly display label
  assert.equal(a.description, 'summarizes');
  assert.deepEqual(a.inputSchema, { type: 'object' }); // stored as JSON, parsed back
  assert.equal(a.status, 'active');
  assert.equal(a.assignable, true);

  // title falls back to the unique name when unset.
  assert.equal(agentsService.getBySlug('triage').title, 'triage');

  // The picker list (assignable agents) returns both, ordered by title.
  const assignable = agentsService.listAssignable().map((a) => a.slug);
  assert.deepEqual([...assignable].sort(), ['summarize', 'triage']);
});

test('agent names are unique: the registry rejects a duplicate slug', () => {
  agentRegistry._reset();
  agentRegistry.register(makeAgent('dup'), 't');
  assert.throws(() => agentRegistry.register(makeAgent('dup'), 't'), /already registered/);
});

test('syncFromRegistry: idempotent re-sync, and vanished agents are marked missing (not deleted)', () => {
  // Re-register only one of the two — 'triage' disappears from the registry.
  agentRegistry._reset();
  agentRegistry.register(makeAgent('summarize', { description: 'now better' }), 't');

  const res = agentsService.syncFromRegistry();
  assert.equal(res.synced, 1);
  assert.equal(res.missing, 1);

  const summarize = agentsService.getBySlug('summarize');
  assert.equal(summarize.description, 'now better'); // metadata refreshed in place

  const triage = agentsService.getBySlug('triage');
  assert.equal(triage.status, 'missing');            // kept, not deleted
  assert.equal(triage.assignable, false);

  // Same id preserved across re-sync (durable identity for assignment FKs).
  assert.ok(agentsRepository.findBySlug('summarize').id > 0);
});

test('assignment can target an active agent; label defaults to the agent title', async () => {
  agentRegistry._reset();
  agentRegistry.register(makeAgent('planner', { title: 'Phase Planner', description: 'plans' }), 't');
  agentsService.syncFromRegistry();
  const planner = agentsService.getBySlug('planner');

  const owner = makeUser(1);
  const project = await projectsService.create(owner, { name: 'P' });
  const phase = await phasesService.create(owner, project.id, { name: 'Phase 1' });

  const a = await assignmentsService.create(owner, phase.id, {
    title: 'Draft the plan',
    assignee_type: 'agent',
    assignee_agent_id: planner.id,
  });
  assert.equal(a.assignee_type, 'agent');
  assert.equal(a.assignee_agent_id, planner.id);
  assert.equal(a.assignee_label, 'Phase Planner'); // defaulted from the agent's title
  assert.equal(a.assignee_user_id, null);          // mutually exclusive with the user link
});

test('an agent is global: the same agent can be assigned to tasks in ANY project', async () => {
  agentRegistry._reset();
  agentRegistry.register(makeAgent('global', { title: 'Global Agent' }), 't');
  agentsService.syncFromRegistry();
  const agent = agentsService.getBySlug('global');

  // Two separate projects owned by two different users — no shared scope.
  const alice = makeUser(10);
  const bob = makeUser(11);
  const projA = await projectsService.create(alice, { name: 'Alice Project' });
  const projB = await projectsService.create(bob, { name: 'Bob Project' });
  const phaseA = await phasesService.create(alice, projA.id, { name: 'P' });
  const phaseB = await phasesService.create(bob, projB.id, { name: 'P' });

  // The SAME registered agent is assignable to a task in each, by each owner.
  const a1 = await assignmentsService.create(alice, phaseA.id, { title: 'work A', assignee_type: 'agent', assignee_agent_id: agent.id });
  const a2 = await assignmentsService.create(bob,   phaseB.id, { title: 'work B', assignee_type: 'agent', assignee_agent_id: agent.id });
  assert.equal(a1.assignee_agent_id, agent.id);
  assert.equal(a2.assignee_agent_id, agent.id);

  // And it's offered by the (global, non project-scoped) picker.
  assert.ok(agentsService.listAssignable().some((x) => x.slug === 'global'));
});

test('assignment rejects an unknown, missing, or disabled agent', async () => {
  agentRegistry._reset();
  agentRegistry.register(makeAgent('worker'), 't');
  agentsService.syncFromRegistry();
  const worker = agentsService.getBySlug('worker');

  const owner = makeUser(2);
  const project = await projectsService.create(owner, { name: 'P2' });
  const phase = await phasesService.create(owner, project.id, { name: 'Phase 1' });

  // Unknown id.
  await assert.rejects(
    () => assignmentsService.create(owner, phase.id, { title: 'x', assignee_type: 'agent', assignee_agent_id: 99999 }),
    /No agent with id 99999/,
  );
  // Missing assignee_agent_id for an agent assignee.
  await assert.rejects(
    () => assignmentsService.create(owner, phase.id, { title: 'x', assignee_type: 'agent' }),
    /assignee_agent_id must be an integer/,
  );
  // Disabled agent.
  getDb().prepare('UPDATE agents SET enabled = 0 WHERE id = ?').run(worker.id);
  await assert.rejects(
    () => assignmentsService.create(owner, phase.id, { title: 'x', assignee_type: 'agent', assignee_agent_id: worker.id }),
    /is disabled/,
  );
});
