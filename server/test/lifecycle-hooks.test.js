// Tests for the lifecycle hook events:
//   - phase.after-activate  — a phase becomes active via forward progress
//   - phase.after-reopen    — a done phase is REACTIVATED (go backward)  [differentiated]
//   - assignment.after-create / after-delete / after-cancel
// Verifies each fires at the right moment with the right payload, and that
// "became active" and "reactivated" are distinct events.
//
// Run with:  node --test test/lifecycle-hooks.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmpDb = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'projecthub-hooks-test-')),
  'test.db'
);
process.env.DB_PATH = tmpDb;

const { runMigrations } = await import('../src/db/migrate.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const { registry } = await import('../src/extensions/registry.js');
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
  const info = getDb()
    .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
    .run(`user${++_u}`, 'x');
  return userActor(info.lastInsertRowid);
}

// Fresh registry + spies for the lifecycle events. Returns a map event -> calls[].
function spyOn(events) {
  registry._reset();
  const calls = {};
  for (const ev of events) {
    calls[ev] = [];
    registry.registerHook({ event: ev, handler: (payload) => { calls[ev].push(payload); } }, `spy:${ev}`);
  }
  return calls;
}

test('phase.after-activate fires for the first phase and for each promotion', async () => {
  const spies = spyOn(['phase.after-activate', 'phase.after-reopen', 'phase.after-complete']);
  const owner = makeUser();
  const project = await projectsService.create(owner, { name: 'P' });

  const p1 = await phasesService.create(owner, project.id, { name: 'Phase 1' });
  // First phase auto-activated -> one activate event for p1.
  assert.equal(spies['phase.after-activate'].length, 1);
  assert.equal(spies['phase.after-activate'][0].phase.id, p1.id);
  assert.equal(spies['phase.after-activate'][0].phase.status, 'active');
  assert.equal(spies['phase.after-activate'][0].projectId, project.id);

  const p2 = await phasesService.create(owner, project.id, { name: 'Phase 2' });
  // p2 is idle (active already exists) -> no new activate event.
  assert.equal(spies['phase.after-activate'].length, 1);

  // Complete p1 -> p2 promoted -> a second activate event, for p2.
  const a = await assignmentsService.create(owner, p1.id, { title: 'T', assignee_user_id: owner.id });
  await assignmentsService.update(owner, a.id, { status: 'resolved' });

  assert.equal(spies['phase.after-complete'].length, 1);
  assert.equal(spies['phase.after-activate'].length, 2);
  assert.equal(spies['phase.after-activate'][1].phase.id, p2.id);
  // Reopen never fired during forward progress.
  assert.equal(spies['phase.after-reopen'].length, 0);
});

test('reactivation fires phase.after-reopen, NOT phase.after-activate', async () => {
  const spies = spyOn(['phase.after-activate', 'phase.after-reopen']);
  const owner = makeUser();
  const project = await projectsService.create(owner, { name: 'P' });
  const p1 = await phasesService.create(owner, project.id, { name: 'Only phase' });
  const a = await assignmentsService.create(owner, p1.id, { title: 'T', assignee_user_id: owner.id });
  await assignmentsService.update(owner, a.id, { status: 'resolved' }); // p1 done, project done

  const activateBefore = spies['phase.after-activate'].length; // 1 (the initial activation)

  await phasesService.reopen(owner, p1.id); // go backward

  // Reactivation is a DISTINCT event from forward activation.
  assert.equal(spies['phase.after-reopen'].length, 1);
  assert.equal(spies['phase.after-reopen'][0].phase.id, p1.id);
  assert.equal(spies['phase.after-reopen'][0].phase.status, 'active');
  assert.equal(spies['phase.after-activate'].length, activateBefore, 'reopen must not fire after-activate');
});

test('assignment.after-create fires when an assignment is added', async () => {
  const spies = spyOn(['assignment.after-create']);
  const owner = makeUser();
  const project = await projectsService.create(owner, { name: 'P' });
  const p1 = await phasesService.create(owner, project.id, { name: 'Phase 1' });

  const a = await assignmentsService.create(owner, p1.id, { title: 'New task' });
  assert.equal(spies['assignment.after-create'].length, 1);
  assert.equal(spies['assignment.after-create'][0].assignment.id, a.id);
  assert.equal(spies['assignment.after-create'][0].phase.id, p1.id);
  assert.equal(spies['assignment.after-create'][0].projectId, project.id);
});

test('assignment.after-delete fires when an assignment is removed', async () => {
  const spies = spyOn(['assignment.after-delete']);
  const owner = makeUser();
  const project = await projectsService.create(owner, { name: 'P' });
  const p1 = await phasesService.create(owner, project.id, { name: 'Phase 1' });
  const a = await assignmentsService.create(owner, p1.id, { title: 'Temp' });

  await assignmentsService.remove(owner, a.id);
  assert.equal(spies['assignment.after-delete'].length, 1);
  assert.equal(spies['assignment.after-delete'][0].id, a.id);
});

test('assignment.after-cancel fires on cancel (with reason), not on resolve', async () => {
  const spies = spyOn(['assignment.after-cancel']);
  const owner = makeUser();
  const project = await projectsService.create(owner, { name: 'P' });
  const p1 = await phasesService.create(owner, project.id, { name: 'Phase 1' });
  // Two assignments so resolving/cancelling one doesn't prematurely matter.
  const a1 = await assignmentsService.create(owner, p1.id, { title: 'A', assignee_user_id: owner.id });
  const a2 = await assignmentsService.create(owner, p1.id, { title: 'B', assignee_user_id: owner.id });

  // Resolving does NOT fire after-cancel.
  await assignmentsService.update(owner, a1.id, { status: 'resolved' });
  assert.equal(spies['assignment.after-cancel'].length, 0);

  // Cancelling fires after-cancel, carrying the reason.
  await assignmentsService.update(owner, a2.id, { status: 'cancelled', cancel_reason: 'duplicate' });
  assert.equal(spies['assignment.after-cancel'].length, 1);
  assert.equal(spies['assignment.after-cancel'][0].assignment.id, a2.id);
  assert.equal(spies['assignment.after-cancel'][0].assignment.cancel_reason, 'duplicate');
});
