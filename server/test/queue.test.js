// Tests for the generic JobQueue (src/queue/) — priority ordering, the
// concurrency cap, retry + backoff, dedup-by-key, and crash recovery. No AI.
//
// Run with:  node --test test/queue.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'projecthub-queue-test-')), 'test.db');
process.env.DB_PATH = tmpDb;

const { runMigrations } = await import('../src/db/migrate.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const { JobQueue, DropJob, jobsRepository } = await import('../src/queue/index.js');

runMigrations();
test.after(() => { closeDb(); fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true }); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function deferred() { let resolve; const promise = new Promise((r) => (resolve = r)); return { promise, resolve }; }
async function waitFor(fn, { timeout = 3000, interval = 10 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await fn()) return; await sleep(interval); }
  throw new Error('waitFor timed out');
}
const clearJobs = () => getDb().prepare('DELETE FROM jobs').run();

test('runs higher-priority jobs first', async () => {
  clearJobs();
  const order = [];
  const q = new JobQueue({ concurrency: 1 });
  q.register('p', async (payload) => { order.push(payload.tag); });
  // Enqueue before start() so nothing is claimed until all three are queued.
  q.enqueue('p', { tag: 'lo' },  { priority: 1 });
  q.enqueue('p', { tag: 'hi' },  { priority: 5 });
  q.enqueue('p', { tag: 'mid' }, { priority: 3 });
  q.start();
  await waitFor(() => order.length === 3);
  q.stop();
  assert.deepEqual(order, ['hi', 'mid', 'lo']);
});

test('never exceeds the concurrency cap', async () => {
  clearJobs();
  let active = 0, maxActive = 0;
  const gate = deferred();
  const q = new JobQueue({ concurrency: 2, pollIntervalMs: 1000 });
  q.register('block', async () => { active++; maxActive = Math.max(maxActive, active); await gate.promise; active--; });
  q.start();
  for (let i = 0; i < 4; i++) q.enqueue('block', { i });
  await waitFor(() => q.running === 2);   // only 2 of 4 claimed
  await sleep(40);
  assert.equal(maxActive, 2, 'at most 2 ran at once');
  gate.resolve();
  await waitFor(() => q.stats().completed === 4);
  q.stop();
});

test('retries with backoff, then succeeds; attempts are counted', async () => {
  clearJobs();
  let calls = 0, completed = null;
  const q = new JobQueue({ concurrency: 1, pollIntervalMs: 10, backoff: () => 10 });
  q.on('completed', (j) => { completed = j; });   // succeeded rows are cleared, so capture the event
  q.register('flaky', async () => { calls++; if (calls < 3) throw new Error('boom'); return 'ok'; });
  q.start();
  const job = q.enqueue('flaky', {}, { maxAttempts: 3 });
  await waitFor(() => completed !== null);
  q.stop();
  assert.equal(calls, 3);
  assert.equal(completed.attempts, 3);
  assert.equal(completed.result, 'ok');
  assert.equal(jobsRepository.findById(job.id), undefined); // cleared on success
});

test('marks failed after exhausting max_attempts', async () => {
  clearJobs();
  const q = new JobQueue({ concurrency: 1, pollIntervalMs: 10, backoff: () => 5 });
  q.register('bad', async () => { throw new Error('nope'); });
  q.start();
  const job = q.enqueue('bad', {}, { maxAttempts: 2 });
  await waitFor(() => jobsRepository.findById(job.id).status === 'failed');
  q.stop();
  const row = jobsRepository.findById(job.id);
  assert.equal(row.attempts, 2);
  assert.match(row.error, /nope/);
});

test('dedup: a second enqueue with the same active key returns the same job', () => {
  clearJobs();
  const q = new JobQueue({ concurrency: 1 });
  q.register('d', async () => { await sleep(50); });
  // Not started, so both stay queued and the dedup key collides.
  const j1 = q.enqueue('d', { n: 1 }, { key: 'same' });
  const j2 = q.enqueue('d', { n: 2 }, { key: 'same' });
  assert.equal(j1.id, j2.id);
  assert.equal(q.stats().queued, 1);
});

test('recovers jobs left running by a crash, on start()', async () => {
  clearJobs();
  const job = jobsRepository.insert({ type: 'r' });
  getDb().prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(job.id); // simulate interruption
  let ran = false;
  const q = new JobQueue({ concurrency: 1 });
  q.register('r', async () => { ran = true; });
  q.start(); // recoverInterrupted() resets running → queued
  await waitFor(() => ran);
  await waitFor(() => jobsRepository.findById(job.id) === undefined); // re-ran, then cleared on success
  q.stop();
});

test('a successful job is cleared from the queue', async () => {
  clearJobs();
  const q = new JobQueue({ concurrency: 1 });
  q.register('ok', async () => 'done');
  q.start();
  const job = q.enqueue('ok', {});
  await waitFor(() => jobsRepository.findById(job.id) === undefined);
  q.stop();
  assert.equal(q.stats().completed, 1);
});

test('DropJob removes the job with no retry and no failed row', async () => {
  clearJobs();
  let calls = 0;
  const q = new JobQueue({ concurrency: 1, pollIntervalMs: 10, backoff: () => 5 });
  q.register('drop', async () => { calls++; throw new DropJob('moot'); });
  q.start();
  const job = q.enqueue('drop', {}, { maxAttempts: 3 });
  await waitFor(() => jobsRepository.findById(job.id) === undefined);
  q.stop();
  assert.equal(calls, 1);              // dropped on first run — not retried
  assert.equal(q.stats().dropped, 1);
});
