-- jobs — the durable backing store for the generic job queue (src/queue/).
--
-- This table is intentionally NOT agent-specific: the queue runs any job `type`
-- you register a handler for, so it can be reused for other background work
-- later. The agent runner engine (src/ai/runner/) is just one producer/consumer,
-- enqueueing 'agent-run' jobs.
--
-- An in-process scheduler claims the highest-priority due job
-- (status='queued' AND run_after <= now), marks it 'running', executes the
-- handler with bounded concurrency, then records the outcome. Durable: jobs
-- survive restart, and interrupted 'running' jobs are recovered to 'queued' at
-- boot.

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,                       -- handler key, e.g. 'agent-run'
  payload TEXT,                             -- JSON args for the handler
  priority INTEGER NOT NULL DEFAULT 0,      -- higher runs first
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,      -- times started (incremented on claim)
  max_attempts INTEGER NOT NULL DEFAULT 1,  -- retry ceiling
  run_after TEXT NOT NULL DEFAULT (datetime('now')), -- earliest run time (backoff/delay)
  dedup_key TEXT,                           -- optional: at most one ACTIVE job per key
  result TEXT,                              -- handler return value (JSON/text)
  error TEXT,                               -- last failure message
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT
);

-- The claim query: cheapest path to the next due job in priority order.
CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(status, run_after, priority DESC, id ASC);

-- Dedup: at most one queued/running job per dedup_key (prevents double-enqueue,
-- e.g. running the same agent assignment twice). Partial unique index over the
-- ACTIVE statuses only — finished jobs with the same key don't conflict.
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_dedup ON jobs(dedup_key)
  WHERE dedup_key IS NOT NULL AND (status = 'queued' OR status = 'running');
