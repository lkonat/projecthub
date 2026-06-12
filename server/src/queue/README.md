# `queue/` — a generic durable job queue

A small, dependency-free **priority job queue with bounded concurrency**, backed
by SQLite (`jobs` table). It exists so background work doesn't overwhelm the
process: jobs wait their turn, only N run at once, and they survive a restart.

**It is deliberately not AI-specific.** Register a handler per job `type` and
enqueue jobs; any subsystem can use it. The agent runner
(`src/ai/runner/`) is just the first consumer.

```
queue/
  jobs.repository.js   ← all SQL (enqueue, claim, succeed/fail/retry, recover, stats)
  JobQueue.js          ← the in-process scheduler (concurrency, priority, retry/backoff, events)
  index.js             ← the shared `queue` singleton + the JobQueue class
```

## How it works

- **Durable + ordered** in the `jobs` table. The scheduler atomically *claims*
  the next due job (`status='queued' AND run_after<=now`, ordered by
  `priority DESC, id ASC`), marks it `running`, runs the handler, and records the
  outcome.
- **Successful jobs are cleared.** A job that completes without error is removed
  from the table (after a `completed` event carrying its result), so the queue
  holds only pending and failed work. Lifetime totals stay visible via
  `stats().completed` / `stats().dropped`.
- **Drop a moot job** — a handler can `throw new DropJob(reason)` to remove the
  job with **no retry and no `failed` row** (e.g. the thing it was about was
  deleted). The queue deletes it and emits `dropped`.
- **Bounded concurrency** — at most `concurrency` jobs run at once (default 4,
  `QUEUE_CONCURRENCY`). A free slot pulls the next job; a periodic tick also
  picks up delayed/retry jobs.
- **Retry + backoff** — a throwing handler is re-queued with exponential backoff
  until `max_attempts`, then marked `failed` (error stored).
- **Dedup** — an optional `key` means at most one *active* (queued/running) job
  per key (a partial unique index enforces it) — e.g. don't run the same thing
  twice.
- **Crash recovery** — on `start()`, jobs left `running` by a dead process are
  reset to `queued` and re-run.

## Use it

```js
import { queue } from './queue/index.js';

queue.register('email', async (payload, job) => {     // handler: returns a result, or throws to retry
  await send(payload.to);
  return { sent: true };
});
queue.start();                                         // recover + begin (called once at boot)

queue.enqueue('email', { to: 'a@b.c' }, {
  priority: 10,          // higher runs first
  maxAttempts: 3,        // retry on failure
  key: 'email:a@b.c',    // dedup: no duplicate active job
  delayMs: 5000,         // run no earlier than +5s
});

queue.on('completed', (job) => { /* job.result */ });  // also: 'started','failed','retrying','dropped'
queue.stats();                                         // { queued, running, failed, cancelled, completed, dropped, concurrency }
```

```js
import { DropJob } from './queue/index.js';
queue.register('thing', async (payload) => {
  if (!stillRelevant(payload)) throw new DropJob('subject gone'); // remove, don't retry
  return doWork(payload);
});
```

> Backoff/delay granularity is **1 second** (SQLite `run_after` is second-precise).

## Extending

- **New job type:** `register(type, handler)` + `enqueue(type, ...)`. No schema
  change — the `jobs` table is generic.
- **Another queue instance:** `new JobQueue({ concurrency })` for an isolated
  pool (e.g. a slow lane). The singleton in `index.js` is the default.
- **Per-type concurrency, scheduled/cron jobs, a persistence adapter:** clean
  future seams — the scheduler is ~90 lines and the storage is behind the
  repository.
