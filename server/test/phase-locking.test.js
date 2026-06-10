// Tests for the "passed phase is frozen" rule and the owner's "go backward"
// (reopen) escape hatch.
//
// Rules under test:
//   - Only an OPEN phase (the active phase or one still ahead) can be edited or
//     have its assignments created/updated/deleted.
//   - Once a phase is done it is "passed" and frozen — for EVERYONE, including
//     the owner.
//   - The owner (only) can reopen a passed phase ("go backward"), which makes it
//     editable again and reactivates an auto-closed project.
//
// Run with:  node --test test/phase-locking.test.js
//        or:  node --test            (from the server/ dir)

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Throwaway DB before anything imports config/connection.
const tmpDb = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'projecthub-lock-test-')),
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

// Build: owner's project with one phase holding one assignment owned by `who`.
async function setup(assigneeActor = null) {
  registry._reset();
  const owner = makeUser();
  const project = await projectsService.create(owner, { name: 'P' });
  const phase = await phasesService.create(owner, project.id, { name: 'Phase 1' });
  const assignment = await assignmentsService.create(owner, phase.id, {
    title: 'Task',
    assignee_user_id: assigneeActor ? assigneeActor.id : owner.id,
  });
  return { owner, project, phase, assignment };
}

// Mark a phase done by resolving its assignment (the real flow). Resolving is
// reserved to the assignee, so `resolver` must be the assignment's assignee.
async function passPhase(resolver, assignmentId) {
  await assignmentsService.update(resolver, assignmentId, { status: 'resolved' });
}

test('owner CAN edit an open phase and add/update/delete its assignments', async () => {
  const { owner, phase } = await setup();
  // edit details
  const renamed = await phasesService.update(owner, phase.id, { name: 'Renamed' });
  assert.equal(renamed.name, 'Renamed');
  // add another assignment
  const extra = await assignmentsService.create(owner, phase.id, { title: 'Extra' });
  // update it
  const upd = await assignmentsService.update(owner, extra.id, { title: 'Extra v2' });
  assert.equal(upd.title, 'Extra v2');
  // delete it
  await assignmentsService.remove(owner, extra.id);
});

test('a passed phase is frozen: owner cannot edit it or assign to it', async () => {
  const { owner, phase, assignment } = await setup();
  await passPhase(owner, assignment.id);

  const fresh = phasesService.get(phase.id);
  assert.equal(fresh.status, 'done'); // phase auto-completed

  await assert.rejects(
    () => phasesService.update(owner, phase.id, { name: 'Nope' }),
    /permission/i,
    'editing a passed phase must be blocked'
  );
  await assert.rejects(
    () => phasesService.remove(owner, phase.id),
    /permission/i,
    'deleting a passed phase must be blocked'
  );
  await assert.rejects(
    () => assignmentsService.create(owner, phase.id, { title: 'Late task' }),
    /permission/i,
    'adding an assignment to a passed phase must be blocked'
  );
  await assert.rejects(
    () => assignmentsService.update(owner, assignment.id, { title: 'edit' }),
    /permission/i,
    'editing an assignment in a passed phase must be blocked'
  );
  await assert.rejects(
    () => assignmentsService.remove(owner, assignment.id),
    /permission/i,
    'deleting an assignment in a passed phase must be blocked'
  );
});

test('owner can "go backward": reopen a passed phase, then edit again', async () => {
  const { owner, phase, assignment } = await setup();
  await passPhase(owner, assignment.id);
  assert.equal(phasesService.get(phase.id).status, 'done');

  const reopened = await phasesService.reopen(owner, phase.id);
  assert.equal(reopened.status, 'active'); // reopened phase becomes the current one

  // Editing works again now that it's the active phase.
  const renamed = await phasesService.update(owner, phase.id, { name: 'Back in business' });
  assert.equal(renamed.name, 'Back in business');
  const late = await assignmentsService.create(owner, phase.id, { title: 'Now allowed' });
  assert.equal(late.title, 'Now allowed');
});

test('reopening the last done phase reactivates an auto-closed project', async () => {
  const { owner, project, phase, assignment } = await setup();
  await passPhase(owner, assignment.id);
  // Single phase, now done => project auto-closed (status 'done').
  assert.equal(projectsService.get(project.id).status, 'done');

  await phasesService.reopen(owner, phase.id);
  assert.equal(projectsService.get(project.id).status, 'active');
});

test('reopen is owner-only and only valid on a passed phase', async () => {
  const assignee = makeUser();
  const { owner, phase, assignment } = await setup(assignee);
  await passPhase(assignee, assignment.id); // the assignee resolves their own work

  // Non-owner assignee cannot reopen.
  await assert.rejects(
    () => phasesService.reopen(assignee, phase.id),
    /permission|not have/i
  );
  // Owner reopens it; now it's open, so a second reopen is rejected by the rule
  // (phase.reopen requires status 'done').
  await phasesService.reopen(owner, phase.id);
  await assert.rejects(
    () => phasesService.reopen(owner, phase.id),
    /permission/i
  );
});

test('assignee cannot edit their own assignment once the phase is passed', async () => {
  const assignee = makeUser();
  const { owner, phase, assignment } = await setup(assignee);

  // While open, the assignee may update their own assignment.
  const ok = await assignmentsService.update(assignee, assignment.id, { title: 'mine' });
  assert.equal(ok.title, 'mine');

  // Resolve it -> phase passes -> frozen even to the assignment's owner.
  await passPhase(assignee, assignment.id);
  await assert.rejects(
    () => assignmentsService.update(assignee, assignment.id, { title: 'too late' }),
    /permission/i
  );
});

test('only the assignee can resolve their assignment — not the owner or others', async () => {
  const assignee = makeUser();
  const stranger = makeUser();
  const { owner, phase, assignment } = await setup(assignee); // active phase, assigned to `assignee`

  // Per-row resolve flag: assignee yes, owner no. Owner keeps canUpdate (manage).
  assert.equal(assignmentsService.listForPhase(assignee, phase.id)[0].canResolve, true);
  assert.equal(assignmentsService.listForPhase(owner, phase.id)[0].canResolve, false);
  assert.equal(assignmentsService.listForPhase(owner, phase.id)[0].canUpdate, true);

  // Owner cannot resolve the assignee's work; a stranger cannot either.
  await assert.rejects(
    () => assignmentsService.update(owner, assignment.id, { status: 'resolved' }),
    /permission/i, 'owner must not resolve the assignee\'s work'
  );
  await assert.rejects(() => assignmentsService.update(stranger, assignment.id, { status: 'resolved' }));

  // Owner CAN still edit (management) — that's not a resolve.
  const edited = await assignmentsService.update(owner, assignment.id, { title: 'clarified' });
  assert.equal(edited.title, 'clarified');

  // The assignee resolves their own — allowed.
  const resolved = await assignmentsService.update(assignee, assignment.id, { status: 'resolved' });
  assert.equal(resolved.status, 'resolved');
});

test('cancelling an assignment requires a reason; reopening clears it', async () => {
  const { owner, assignment } = await setup(); // active phase, assigned to owner

  // Cancel without a reason — rejected.
  await assert.rejects(
    () => assignmentsService.update(owner, assignment.id, { status: 'cancelled' }),
    /reason is required/i
  );
  await assert.rejects(
    () => assignmentsService.update(owner, assignment.id, { status: 'cancelled', cancel_reason: '   ' }),
    /reason is required/i, 'a blank reason must not count'
  );

  // Cancel with a reason — stored (and trimmed).
  const cancelled = await assignmentsService.update(owner, assignment.id, {
    status: 'cancelled', cancel_reason: '  out of scope  ',
  });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancel_reason, 'out of scope');

  // Reopening clears the reason. (Cancelling completed the phase, so reopen the
  // phase first to make it active again, then reopen the assignment.)
  await phasesService.reopen(owner, assignment.phase_id);
  const reopened = await assignmentsService.update(owner, assignment.id, { status: 'open' });
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.cancel_reason, null);
});

test('an open phase can be deleted; after reopening a passed one it can too', async () => {
  // Open phase: deletable.
  const { owner, phase } = await setup();
  await phasesService.remove(owner, phase.id);
  assert.equal(phasesService.listForProject(owner, phase.project_id).length, 0);

  // Passed phase: blocked until reopened, then deletable.
  const b = await setup();
  await passPhase(b.owner, b.assignment.id);
  await assert.rejects(() => phasesService.remove(b.owner, b.phase.id), /permission/i);
  await phasesService.reopen(b.owner, b.phase.id);
  await phasesService.remove(b.owner, b.phase.id); // now allowed
});

// Build owner + project + two phases (p1 active, p2 idle).
async function twoPhases() {
  registry._reset();
  const owner = makeUser();
  const project = await projectsService.create(owner, { name: 'P' });
  const p1 = await phasesService.create(owner, project.id, { name: 'Phase 1' });
  const p2 = await phasesService.create(owner, project.id, { name: 'Phase 2' });
  return { owner, project, p1, p2 };
}

test('first phase is active, later phases are idle', async () => {
  const { p1, p2 } = await twoPhases();
  assert.equal(phasesService.get(p1.id).status, 'active');
  assert.equal(phasesService.get(p2.id).status, 'idle');
});

test('idle phase: assignments can be added and removed but not updated', async () => {
  const { owner, project, p2 } = await twoPhases();

  // Add to the idle phase — allowed.
  const a = await assignmentsService.create(owner, p2.id, { title: 'Planned task' });

  // Per-row flags: addable + deletable, but NOT updatable on an idle phase.
  const rows = assignmentsService.listForPhase(owner, p2.id);
  assert.equal(rows[0].canUpdate, false, 'idle-phase assignment must not be updatable');
  assert.equal(rows[0].canDelete, true,  'idle-phase assignment must be deletable');

  // Updating (edit or resolve) — blocked.
  await assert.rejects(
    () => assignmentsService.update(owner, a.id, { title: 'x' }),
    /permission/i, 'editing an idle-phase assignment must be blocked'
  );
  await assert.rejects(
    () => assignmentsService.update(owner, a.id, { status: 'resolved' }),
    /permission/i, 'resolving an idle-phase assignment must be blocked'
  );

  // Removing — allowed.
  await assignmentsService.remove(owner, a.id);
  assert.equal(assignmentsService.listForPhase(owner, p2.id).length, 0);
});

test('completing the active phase promotes the next idle phase', async () => {
  const { owner, project, p1, p2 } = await twoPhases();
  const a = await assignmentsService.create(owner, p1.id, { title: 'Task', assignee_user_id: owner.id });
  await assignmentsService.update(owner, a.id, { status: 'resolved' }); // assignee (owner) resolves; phase completes

  assert.equal(phasesService.get(p1.id).status, 'done');
  assert.equal(phasesService.get(p2.id).status, 'active'); // promoted
  assert.equal(projectsService.get(project.id).status, 'active'); // work remains
});

test('reopening a done phase makes it active and demotes the current active to idle', async () => {
  const { owner, project, p1, p2 } = await twoPhases();
  const a = await assignmentsService.create(owner, p1.id, { title: 'Task', assignee_user_id: owner.id });
  await assignmentsService.update(owner, a.id, { status: 'resolved' }); // p1 done, p2 active

  await phasesService.reopen(owner, p1.id); // go backward to p1
  assert.equal(phasesService.get(p1.id).status, 'active');
  assert.equal(phasesService.get(p2.id).status, 'idle'); // demoted
});

test('listForProject reports per-phase capability flags', async () => {
  const { owner, phase, assignment } = await setup();
  let phases = phasesService.listForProject(owner, phase.project_id);
  assert.equal(phases[0].canEdit, true);
  assert.equal(phases[0].canDelete, true);
  assert.equal(phases[0].canAddAssignment, true);
  assert.equal(phases[0].canReopen, false);

  await passPhase(owner, assignment.id);
  phases = phasesService.listForProject(owner, phase.project_id);
  assert.equal(phases[0].canEdit, false);
  assert.equal(phases[0].canDelete, false); // frozen: not deletable
  assert.equal(phases[0].canAddAssignment, false);
  assert.equal(phases[0].canReopen, true); // the go-backward affordance
});
