import { getDb } from '../db/connection.js';

// Data access for the `jobs` table. Pure SQL, no scheduling logic and no
// knowledge of any job type — the JobQueue drives this; agents never touch it.

// Parse the JSON-ish columns for consumers (payload is JSON; result may be JSON
// or a plain string — we try JSON and fall back to the raw text).
export function presentJob(row) {
  if (!row) return null;
  const parse = (s) => { if (s == null) return null; try { return JSON.parse(s); } catch { return s; } };
  return { ...row, payload: parse(row.payload), result: parse(row.result) };
}

export const jobsRepository = {
  insert({ type, payload = null, priority = 0, maxAttempts = 1, dedupKey = null, delayMs = 0 }) {
    const runAfter = delayMs > 0
      ? `datetime('now', '+${Math.ceil(delayMs / 1000)} seconds')`
      : `datetime('now')`;
    const info = getDb()
      .prepare(
        `INSERT INTO jobs (type, payload, priority, max_attempts, dedup_key, run_after)
         VALUES (?, ?, ?, ?, ?, ${runAfter})`
      )
      .run(type, payload == null ? null : JSON.stringify(payload), priority, maxAttempts, dedupKey);
    return this.findById(info.lastInsertRowid);
  },

  findById(id) {
    return getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  },

  // The active (queued or running) job for a dedup key, if any.
  findActiveByKey(dedupKey) {
    return getDb()
      .prepare("SELECT * FROM jobs WHERE dedup_key = ? AND status IN ('queued','running') LIMIT 1")
      .get(dedupKey);
  },

  // Atomically claim the next due job: highest priority, oldest first. Marks it
  // 'running' and bumps attempts. Single transaction so a claim can't double-run.
  claimNext() {
    const db = getDb();
    return db.transaction(() => {
      const row = db
        .prepare(
          `SELECT * FROM jobs
            WHERE status = 'queued' AND run_after <= datetime('now')
            ORDER BY priority DESC, id ASC
            LIMIT 1`
        )
        .get();
      if (!row) return null;
      db.prepare(
        `UPDATE jobs
            SET status = 'running', attempts = attempts + 1,
                started_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ?`
      ).run(row.id);
      return this.findById(row.id);
    })();
  },

  succeed(id, result) {
    getDb()
      .prepare(
        `UPDATE jobs SET status = 'succeeded', result = ?, error = NULL,
                         finished_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ?`
      )
      .run(result == null ? null : (typeof result === 'string' ? result : JSON.stringify(result)), id);
    return this.findById(id);
  },

  fail(id, error) {
    getDb()
      .prepare(
        `UPDATE jobs SET status = 'failed', error = ?,
                         finished_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ?`
      )
      .run(String(error), id);
    return this.findById(id);
  },

  // Re-queue a failed attempt for retry after a backoff delay.
  retry(id, error, delayMs) {
    getDb()
      .prepare(
        `UPDATE jobs
            SET status = 'queued', error = ?, finished_at = NULL,
                run_after = datetime('now', '+' || ? || ' seconds'),
                updated_at = datetime('now')
          WHERE id = ?`
      )
      .run(String(error), Math.ceil(delayMs / 1000), id);
    return this.findById(id);
  },

  // Cancel a job that hasn't started. Running jobs are left to finish.
  cancel(id) {
    return getDb()
      .prepare("UPDATE jobs SET status = 'cancelled', updated_at = datetime('now') WHERE id = ? AND status = 'queued'")
      .run(id).changes > 0;
  },

  cancelByKey(dedupKey) {
    return getDb()
      .prepare("UPDATE jobs SET status = 'cancelled', updated_at = datetime('now') WHERE dedup_key = ? AND status = 'queued'")
      .run(dedupKey).changes;
  },

  // Remove a job row entirely (used when a job succeeds or is dropped).
  delete(id) {
    return getDb().prepare('DELETE FROM jobs WHERE id = ?').run(id).changes > 0;
  },

  // Boot recovery: a job left 'running' when the process died never finished.
  // Reset it to 'queued' so it runs again (attempts already counted, so a poison
  // job still hits max_attempts).
  recoverInterrupted() {
    return getDb()
      .prepare("UPDATE jobs SET status = 'queued', started_at = NULL, updated_at = datetime('now') WHERE status = 'running'")
      .run().changes;
  },

  counts() {
    const rows = getDb().prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all();
    const out = { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 };
    for (const r of rows) out[r.status] = r.n;
    return out;
  },
};
