// Regression tests for project creation, focused on the project.before-create
// lifecycle event and its interaction with the registry's strict
// project-scoped context check.
//
// Bug being guarded against: creating a project WITHOUT a `type` (input.type
// === null) used to 500. `project.before-create` is a PROJECT_SCOPED_EVENT, and
// the registry's strict check threw when the payload lacked project context.
// An untyped project's payload is `{ input }` with input.type === null, which
// the check rejected — so emit() threw before the insert and the whole request
// failed.
//
// Run with:  node --test test/projects-create.test.js
//        or:  node --test            (from the server/ dir)

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Point the DB at a throwaway file BEFORE anything imports config/connection,
// so we never touch the real projecthub.db.
const tmpDb = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'projecthub-test-')),
  'test.db'
);
process.env.DB_PATH = tmpDb;

const { runMigrations } = await import('../src/db/migrate.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const { registry } = await import('../src/extensions/registry.js');
const { projectsService } = await import('../src/modules/projects/projects.service.js');
const { userActor } = await import('../src/access/actor.js');

runMigrations();

// A real owner: projectsService.create stamps the new project with actor.id, so
// these tests need an actual user row (user_id has a FK to users). One shared
// owner is enough — these tests only care about the create lifecycle, not auth.
const ownerId = getDb()
  .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
  .run('owner', 'x').lastInsertRowid;
const owner = userActor(ownerId);

test.after(() => {
  closeDb();
  fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });
});

// Fresh registry state per test: no types, no hooks. Projects are created by the
// shared `owner` actor (see above) so each gets a valid user_id.
test.beforeEach(() => {
  registry._reset();
});

test('creating an untyped project (type: null) succeeds', async () => {
  // This is the exact README repro: `{ "name": "Tax filing", "priority": "high" }`
  const project = await projectsService.create(owner, {
    name: 'Tax filing',
    priority: 'high',
  });
  assert.equal(project.name, 'Tax filing');
  assert.equal(project.priority, 'high');
  assert.equal(project.type, null);
});

test('an untyped project runs global before-create hooks only', async () => {
  const calls = [];
  registry.registerHook({
    event: 'project.before-create',
    handler: (payload) => { calls.push(['global', payload.input.type]); },
  }, 'test:global');
  registry.registerType({ id: 'client-work', label: 'Client Work' }, 'test:type');
  registry.registerHook({
    event: 'project.before-create',
    type: 'client-work',
    handler: () => { calls.push(['typed', 'client-work']); },
  }, 'test:typed');

  await projectsService.create(owner, { name: 'No type here' });

  // Global hook ran (with type === null); the type-scoped hook did NOT.
  assert.deepEqual(calls, [['global', null]]);
});

test('typed creation still works and type-scoped hooks receive context', async () => {
  const seen = [];
  registry.registerType(
    { id: 'client-work', label: 'Client Work', defaults: { priority: 'high' } },
    'test:type'
  );
  registry.registerHook({
    event: 'project.before-create',
    type: 'client-work',
    handler: (payload, ctx) => {
      seen.push({ type: payload.input.type, hasCtx: !!ctx, name: payload.input.name });
      // A before-create hook may mutate the pending input.
      payload.input.description = 'set by hook';
    },
  }, 'test:typed');

  const project = await projectsService.create(owner, {
    name: 'Acme onboarding',
    type: 'client-work',
  });

  assert.equal(project.type, 'client-work');
  assert.equal(project.priority, 'high');            // type default applied
  assert.equal(project.description, 'set by hook');  // hook mutation persisted
  assert.deepEqual(seen, [
    { type: 'client-work', hasCtx: true, name: 'Acme onboarding' },
  ]);
});

test('emit still rejects a before-create call with no input payload', async () => {
  // The relaxed check is not a free pass: a genuinely contextless before-create
  // (no `input` object at all) must still throw loudly.
  await assert.rejects(
    () => registry.emit('project.before-create', {}),
    /must include an 'input' object/
  );
  await assert.rejects(
    () => registry.emit('project.before-create', { input: null }),
    /must include an 'input' object/
  );
});

test('other project-scoped events still require full project context', async () => {
  // after-create is NOT a pending-entity event — its strict check is unchanged.
  await assert.rejects(
    () => registry.emit('project.after-create', { foo: 'bar' }),
    /project-scoped/
  );
});
