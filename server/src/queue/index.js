// The generic job-queue layer. Exposes the JobQueue class plus a shared default
// instance the app wires up at boot (concurrency from QUEUE_CONCURRENCY).
//
// Reusable for any background work — not just agents. Producers register a
// handler per type and enqueue jobs; the engine in src/ai/runner/ is one such
// producer.
import { JobQueue } from './JobQueue.js';

export { JobQueue, DropJob } from './JobQueue.js';
export { jobsRepository } from './jobs.repository.js';

const concurrency = Number(process.env.QUEUE_CONCURRENCY) || 4;

// The process-wide queue. Handlers are registered against this at boot.
export const queue = new JobQueue({ concurrency });
