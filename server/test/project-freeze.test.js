// Tests for the "a non-active project is a frozen record" rule.
//
// When a project is done or cancelled:
//   - its content (name/description/priority/type/...) cannot be edited;
//   - its sub-resources (phases, assignments, checklist) cannot be edited;
//   - BUT the lifecycle status can still change (reactivate / complete / cancel);
//   - AND comments stay open (closing / post-mortem notes).
// Reactivating the project unfreezes everything.
//
// Run with:  node --test test/project-freeze.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmpDb = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'projecthub-freeze-test-')),
  'test.db'
);
process.env.DB_PATH = tmpDb;

const { runMigrations } = await import('../src/db/migrate.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const { registry } = await import('../src/extensions/registry.js');
const { projectsService } = await import('../src/modules/projects/projects.service.js');
const { phasesService } = await import('../src/modules/phases/phases.service.js');
const { assignmentsService } = await import('../src/modules/assignments/assignments.service.js');
const { access } = await import('../src/access/access.service.js');
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

async function activeProjectWithPhase() {
  registry._reset();
  const owner = makeUser();
  const project = await projectsService.create(owner, { name: 'P' });
  const phase = await phasesService.create(owner, project.id, { name: 'Phase 1' });
  return { owner, project, phase };
}

test('content edits are frozen on a cancelled project, but status changes are not', async () => {
  const { owner, project } = await activeProjectWithPhase();

  // Active: content edit works.
  const renamed = await projectsService.update(owner, project.id, { name: 'Renamed' });
  assert.equal(renamed.name, 'Renamed');

  // Cancel it (status-only change is allowed).
  const cancelled = await projectsService.update(owner, project.id, { status: 'cancelled' });
  assert.equal(cancelled.status, 'cancelled');

  // Now content edits are blocked...
  await assert.rejects(
    () => projectsService.update(owner, project.id, { name: 'Nope' }),
    /permission/i,
    'editing content of a cancelled project must be blocked'
  );
  await assert.rejects(
    () => projectsService.update(owner, project.id, { priority: 'high' }),
    /permission/i
  );

  // ...but reactivating (status change) still works.
  const reactivated = await projectsService.update(owner, project.id, { status: 'active' });
  assert.equal(reactivated.status, 'active');

  // And once active again, content edits work.
  const ok = await projectsService.update(owner, project.id, { name: 'Edited again' });
  assert.equal(ok.name, 'Edited again');
});

test('sub-resources cannot be created/edited on a closed project', async () => {
  const { owner, project, phase } = await activeProjectWithPhase();
  await projectsService.update(owner, project.id, { status: 'done' });

  await assert.rejects(
    () => phasesService.create(owner, project.id, { name: 'Late phase' }),
    /permission/i,
    'adding a phase to a done project must be blocked'
  );
  await assert.rejects(
    () => phasesService.update(owner, phase.id, { name: 'rename' }),
    /permission/i
  );
  await assert.rejects(
    () => assignmentsService.create(owner, phase.id, { title: 'Late task' }),
    /permission/i,
    'adding an assignment in a done project must be blocked'
  );

  // Reactivate -> sub-resource editing works again.
  await projectsService.update(owner, project.id, { status: 'active' });
  const a = await assignmentsService.create(owner, phase.id, { title: 'Now allowed' });
  assert.equal(a.title, 'Now allowed');
});

test('comments stay open on a closed project; checklist + content do not', async () => {
  const { owner, project } = await activeProjectWithPhase();
  await projectsService.update(owner, project.id, { status: 'cancelled' });
  const closed = projectsService.get(project.id);

  assert.equal(access.allows(owner, closed, 'comment.create'), true,  'comments must stay open');
  assert.equal(access.allows(owner, closed, 'checklist.manage'), false, 'checklist must freeze');
  assert.equal(access.allows(owner, closed, 'project.edit-content'), false, 'content must freeze');
  // Ownership signal + delete remain available regardless of status.
  assert.equal(access.allows(owner, closed, 'project.edit'), true);
  assert.equal(access.allows(owner, closed, 'project.delete'), true);
});

test('capability map reflects the freeze for the client', async () => {
  const { owner, project } = await activeProjectWithPhase();

  let caps = access.capabilitiesFor(owner, projectsService.get(project.id));
  assert.equal(caps['project.edit'], true);
  assert.equal(caps['project.edit-content'], true);  // active → editable
  assert.equal(caps['phase.manage'], true);

  await projectsService.update(owner, project.id, { status: 'done' });
  caps = access.capabilitiesFor(owner, projectsService.get(project.id));
  assert.equal(caps['project.edit'], true);          // still the owner
  assert.equal(caps['project.edit-content'], false); // but content frozen
  assert.equal(caps['phase.manage'], false);
  assert.equal(caps['checklist.manage'], false);
  assert.equal(caps['comment.create'], true);        // comments stay
});
