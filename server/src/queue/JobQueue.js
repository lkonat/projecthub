import { EventEmitter } from 'node:events';
import { jobsRepository, presentJob } from './jobs.repository.js';

// Throw this from a handler to DROP the job entirely — no retry, no 'failed'
// row. Use it when the work has become moot (e.g. its subject was deleted): the
// queue simply removes the job.
export class DropJob extends Error {
  constructor(message = 'job dropped') { super(message); this.name = 'DropJob'; }
}

// JobQueue — a generic, durable, priority job queue with bounded concurrency.
//
// Durability + ordering live in the `jobs` table; this class is the in-process
// SCHEDULER that claims due jobs, runs their handler with a concurrency cap, and
// records the outcome (with retry + backoff). It is deliberately AI-agnostic:
// register a handler per `type` and enqueue jobs. The agent runner is just one
// consumer.
//
// Lifecycle events (listen via .on): 'started', 'completed', 'failed',
// 'retrying' — each carries the presented job row (payload/result parsed).
//
//   const q = new JobQueue({ concurrency: 4 });
//   q.register('agent-run', async (payload, job) => { ... });   // returns result
//   q.start();
//   q.enqueue('agent-run', { assignmentId: 7 }, { priority: 20, key: 'agent-run:7' });
export class JobQueue extends EventEmitter {
  constructor({ concurrency = 4, pollIntervalMs = 1000, backoff } = {}) {
    super();
    this.concurrency = Math.max(1, concurrency);
    this.pollIntervalMs = pollIntervalMs;
    // Exponential backoff by attempt number (1-based): 1s, 2s, 4s, ...
    this.backoff = backoff ?? ((attempt) => 1000 * 2 ** (attempt - 1));
    this.handlers = new Map();
    this.running = 0;
    this.started = false;
    this._timer = null;
    // Lifetime counters — succeeded/dropped jobs are deleted, so they're not in
    // the table; these keep them observable via stats().
    this.completedCount = 0;
    this.droppedCount = 0;
  }

  register(type, handler) {
    if (this.handlers.has(type)) throw new Error(`Queue handler for '${type}' already registered`);
    this.handlers.set(type, handler);
    return this;
  }

  // Add a job. Dedup: if `key` is given and an active (queued/running) job with
  // that key exists, return it instead of inserting a duplicate.
  enqueue(type, payload, { priority = 0, maxAttempts = 1, key = null, delayMs = 0 } = {}) {
    if (!this.handlers.has(type)) throw new Error(`No queue handler registered for '${type}'`);
    if (key) {
      const active = jobsRepository.findActiveByKey(key);
      if (active) return presentJob(active);
    }
    const job = jobsRepository.insert({ type, payload, priority, maxAttempts, dedupKey: key, delayMs });
    if (this.started) this._pump();
    return presentJob(job);
  }

  // Begin processing. Recovers jobs interrupted by a previous crash, then pumps
  // and starts a periodic tick that also picks up delayed/retry jobs.
  start() {
    if (this.started) return this;
    this.started = true;
    const recovered = jobsRepository.recoverInterrupted();
    if (recovered) console.log(`[queue] recovered ${recovered} interrupted job(s)`);
    this._timer = setInterval(() => this._pump(), this.pollIntervalMs);
    if (this._timer.unref) this._timer.unref(); // don't keep the process alive
    this._pump();
    return this;
  }

  // Stop claiming new jobs. In-flight jobs are left to settle.
  stop() {
    this.started = false;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    return this;
  }

  cancel(jobId) { return jobsRepository.cancel(jobId); }
  cancelByKey(key) { return jobsRepository.cancelByKey(key); }

  stats() {
    return {
      ...jobsRepository.counts(),
      running: this.running,
      completed: this.completedCount, // lifetime succeeded (rows are cleared)
      dropped: this.droppedCount,     // lifetime dropped (rows are cleared)
      concurrency: this.concurrency,
    };
  }

  // Fill free concurrency slots with the next due jobs.
  _pump() {
    if (!this.started) return;
    while (this.running < this.concurrency) {
      const job = jobsRepository.claimNext();
      if (!job) break;
      this.running++;
      this._run(job); // async; do not await — concurrency is the point
    }
  }

  async _run(job) {
    const presented = presentJob(job);
    this.emit('started', presented);
    try {
      const handler = this.handlers.get(job.type);
      if (!handler) throw new Error(`No handler for job type '${job.type}'`);
      const result = await handler(presented.payload, presented);
      // Success: notify with the result, then CLEAR the job from the queue.
      this.emit('completed', presentJob(jobsRepository.succeed(job.id, result)));
      jobsRepository.delete(job.id);
      this.completedCount++;
    } catch (err) {
      if (err instanceof DropJob) {
        // The work is moot (e.g. its subject was deleted) — remove the job with
        // no retry and no 'failed' record.
        this.emit('dropped', { ...presented, error: err.message });
        jobsRepository.delete(job.id);
        this.droppedCount++;
      } else {
        const msg = err?.message ?? String(err);
        if (job.attempts < job.max_attempts) {
          const delay = this.backoff(job.attempts);
          this.emit('retrying', presentJob(jobsRepository.retry(job.id, msg, delay)));
        } else {
          this.emit('failed', presentJob(jobsRepository.fail(job.id, msg)));
        }
      }
    } finally {
      this.running--;
      this._pump(); // a slot freed — claim the next
    }
  }
}
