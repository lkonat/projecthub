import { queue, DropJob } from '../../queue/index.js';
import { agentRegistry, AGENT_EVENT, ASSIGNMENT_EVENT } from '../index.js';
import { agentsService } from '../../modules/agents/agents.service.js';
import { assignmentsService } from '../../modules/assignments/assignments.service.js';
import { assignmentsRepository } from '../../modules/assignments/assignments.repository.js';
import { phasesRepository } from '../../modules/phases/phases.repository.js';
import { projectsRepository } from '../../modules/projects/projects.repository.js';
import { registry } from '../../extensions/registry.js';
import { SYSTEM } from '../../access/actor.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { ASSIGNMENT_STATUS, EXECUTION_STATE } from '../../constants/assignmentStates.js';

// agentRunner — turns "run this agent assignment" into a queued job and executes
// it via the registered agent. The generic queue owns scheduling, concurrency,
// durability, and retry/backoff; the runner owns the agent-specific concerns:
//
//   _resolveRun     validate the run is still worth doing; gather what it needs
//   _execute        run the agent, surface its events, persist its outcome
//   _persistOutcome write the agent's success/failure to the assignment
//   _project        write queue lifecycle transitions to the assignment
//
// An assignment's run state is written from TWO sources, deliberately kept apart:
//
//   1. QUEUE LIFECYCLE → QUEUE_PROJECTIONS, applied by _project. started /
//      retrying / failed / completed map to a status + execution_state. This is
//      the run's mechanical progress, known to the queue.
//
//   2. AGENT OUTCOME → OUTCOME_TO_RUN, captured in _execute. The agent itself
//      decides success/failure by emitting an OUTCOME event (via the
//      finish_assignment tool); that's what resolves the assignment.
//
// Every OTHER event the agent emits (start, model:*, tool:*, complete, failed) is
// an EXECUTING event — observed for logging only, never persisted here.

const JOB_TYPE = 'agent-run';
const MAX_ATTEMPTS = 3;
const keyFor = (assignmentId) => `agent-run:${assignmentId}`;

const PRIORITY_BY_PROJECT = { critical: 30, high: 20, medium: 10, low: 0 };
const sqlNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19); // 'YYYY-MM-DD HH:MM:SS' (UTC)
const asText = (v) => (v == null ? null : typeof v === 'string' ? v : JSON.stringify(v));

// ── Event groups — kept separate on purpose ─────────────────────────────────
// EXECUTING: the agent's run-loop lifecycle — observed (logged), never persisted.
// OUTCOME:   the agent's success/failure signal — captured to resolve the run.
const EXECUTING_EVENTS = Object.values(AGENT_EVENT);
const OUTCOME_EVENTS = Object.values(ASSIGNMENT_EVENT);

// How an agent OUTCOME event resolves the assignment.
const OUTCOME_TO_RUN = {
  [ASSIGNMENT_EVENT.SUCCEEDED]: (p) => ({ status: ASSIGNMENT_STATUS.COMPLETED, execution_state: EXECUTION_STATE.IDLE,  result: p.result, error: null }),
  [ASSIGNMENT_EVENT.FAILED]:    (p) => ({ status: ASSIGNMENT_STATUS.FAILED,    execution_state: EXECUTION_STATE.ERROR, error: p.error }),
};

// How a QUEUE lifecycle event projects onto the assignment (status? + runFields).
// Each value is `(job) => patch` so timestamps are stamped at event time. Add a
// row to project a new transition — no handler wiring needed (see init()).
const QUEUE_PROJECTIONS = {
  started:   (job) => ({ status: ASSIGNMENT_STATUS.IN_PROGRESS, runFields: { execution_state: EXECUTION_STATE.EXECUTING, started_at: sqlNow(), attempts: job.attempts } }),
  completed: (job) => ({                                        runFields: { execution_state: EXECUTION_STATE.IDLE,      result: asText(job.result), finished_at: sqlNow() } }),
  retrying:  (job) => ({ status: ASSIGNMENT_STATUS.ACCEPTED,    runFields: { execution_state: EXECUTION_STATE.RETRYING,  error: job.error } }),
  failed:    (job) => ({ status: ASSIGNMENT_STATUS.FAILED,      runFields: { execution_state: EXECUTION_STATE.ERROR,     error: job.error, finished_at: sqlNow() } }),
};

function derivePriority(assignment) {
  const project = assignment.project_id ? projectsRepository.findById(assignment.project_id) : null;
  return PRIORITY_BY_PROJECT[project?.priority] ?? 10;
}

// Subscribe handler(event, payload) to several emitter events at once; returns a
// detach() that removes them all. Pair with try/finally so a run never leaks
// listeners onto the shared agent singleton.
function tap(emitter, events, handler) {
  const bound = events.map((event) => {
    const fn = (payload = {}) => handler(event, payload);
    emitter.on(event, fn);
    return [event, fn];
  });
  return () => bound.forEach(([event, fn]) => emitter.off(event, fn));
}

// Compact view of an agent event payload for logging: drop fields already in the
// log prefix (name/assignmentId), elide the prompt input, unwrap Errors, and trim
// long strings so a surfaced event stays one readable line.
function briefEvent(payload = {}) {
  const out = {};
  for (const [k, v] of Object.entries(payload)) {
    if (k === 'assignmentId' || k === 'name') continue;
    else if (k === 'input') out.input = '…';
    else if (v instanceof Error) out[k] = v.message;
    else if (typeof v === 'string') out[k] = v.length > 120 ? `${v.slice(0, 120)}…` : v;
    else out[k] = v;
  }
  return out;
}

export const agentRunner = {
  JOB_TYPE,

  // Register the job handler and wire each queue lifecycle event to its
  // projection. Call once at boot, before queue.start().
  init() {
    queue.register(JOB_TYPE, (payload) => this._execute(payload));
    for (const [event, projection] of Object.entries(QUEUE_PROJECTIONS)) {
      queue.on(event, (job) => this._project(job, projection));
    }
    return this;
  },

  // Enqueue a run for an agent-typed assignment. Dedup by assignment, so a second
  // request while one is queued/running returns the existing job. Returns the job.
  run(assignmentId, { priority } = {}) {
    const assignment = assignmentsRepository.findById(assignmentId);
    if (!assignment) throw new NotFoundError('Assignment');
    if (assignment.assignee_type !== 'agent' || !assignment.assignee_agent_id) {
      throw new ValidationError('Assignment has no agent assignee to run');
    }
    // Accepted the moment it's queued; cleared of any prior error.
    assignmentsService.recordRun({
      actor: SYSTEM,
      assignmentId,
      status: ASSIGNMENT_STATUS.ACCEPTED,
      runFields: { execution_state: EXECUTION_STATE.IDLE, error: null },
    });
    return queue.enqueue(
      JOB_TYPE,
      { assignmentId },
      { priority: priority ?? derivePriority(assignment), maxAttempts: MAX_ATTEMPTS, key: keyFor(assignmentId) },
    );
  },

  // Job handler: validate → run the agent → persist its outcome. Throwing lets the
  // queue retry/fail; the return value becomes the job result (and fires 'completed').
  async _execute({ assignmentId }) {
    const { instance, input, ctx } = await this._resolveRun(assignmentId);
    const log = ctx.log ?? console;

    // Agents are singletons, so concurrent runs share this emitter — only handle
    // events tagged with THIS run's assignmentId.
    const mine = (p) => p.assignmentId === undefined || p.assignmentId === assignmentId;
    const logEvent = (event, p) => { if (mine(p)) log.log?.(`[agent-run ${assignmentId}] ${event}`, briefEvent(p)); };

    // Two SEPARATE taps: executing events are observed (logged); outcome events
    // are captured to resolve the assignment after the run finishes.
    let outcome = null;
    const detachExecuting = tap(instance, EXECUTING_EVENTS, logEvent);
    const detachOutcome = tap(instance, OUTCOME_EVENTS, (event, p) => {
      if (!mine(p)) return;
      logEvent(event, p);
      outcome = OUTCOME_TO_RUN[event](p);
    });

    let run; // { ok, result, error } — tryRun never throws
    try {
      run = await instance.tryRun(input, ctx);
    } finally {
      detachExecuting();
      detachOutcome();
    }

    await this._persistOutcome(assignmentId, outcome, run);
    if (!run.ok) throw new Error(run.error); // a thrown run → let the queue retry/fail
    return run.result;
  },

  // Resolve everything needed to run, or throw DropJob (no retry) when the run is
  // moot — the assignment/project/phase is gone or no longer active (an agent only
  // runs on the ACTIVE phase of an ACTIVE project). Returns { assignment, instance,
  // input, ctx }.
  async _resolveRun(assignmentId) {
    const assignment = assignmentsRepository.findById(assignmentId);
    if (!assignment) throw new DropJob(`Assignment ${assignmentId} no longer exists`);

    const project = projectsRepository.findById(assignment.project_id);
    if (!project || project.status !== 'active') {
      throw new DropJob(`Assignment ${assignmentId}'s project is not active (${project?.status ?? 'gone'})`);
    }
    const phase = phasesRepository.findById(assignment.phase_id);
    if (!phase || phase.status !== 'active') {
      throw new DropJob(`Assignment ${assignmentId} is not on an active phase (${phase?.status ?? 'gone'})`);
    }

    const agentRow = agentsService.get(assignment.assignee_agent_id); // throws if the agent row is gone
    const instance = agentRegistry.get(agentRow.slug);                // throws if the code agent is unregistered
    const ext = assignmentsService.getAgentRun(assignmentId);
    const input = ext?.input ?? { assignment };                       // caller-supplied input, else the assignment
    // Per-run ctx (NOT the shared getContext singleton) so assignmentId is scoped
    // to this run — the agent stamps it on every event for correlation.
    const ctx = { ...(registry.getContext ? await registry.getContext() : {}), assignmentId };
    return { assignment, instance, input, ctx };
  },

  // Persist the agent-signaled outcome after the run. A run that THREW is resolved
  // by the queue's 'failed' lifecycle instead, so only a captured signal is written
  // here. On success, fall back to the run's final text when the model didn't pass
  // an explicit result.
  async _persistOutcome(assignmentId, outcome, run) {
    if (!outcome) return;
    const runFields = {
      execution_state: outcome.execution_state,
      error: outcome.error ?? null,
      finished_at: sqlNow(),
    };
    if (outcome.status === ASSIGNMENT_STATUS.COMPLETED) {
      runFields.result = outcome.result ?? asText(run.result);
    }
    await assignmentsService.recordRun({ actor: SYSTEM, assignmentId, status: outcome.status, runFields });
  },

  // Project a QUEUE lifecycle event onto the assignment. `projection(job)` returns
  // { status?, runFields } (a QUEUE_PROJECTIONS entry). Failures are logged, never
  // thrown — they must not disturb the queue.
  async _project(job, projection) {
    if (job.type !== JOB_TYPE) return;
    const assignmentId = job.payload?.assignmentId;
    if (!assignmentId) return;
    const { status, runFields } = projection(job);
    try {
      await assignmentsService.recordRun({ actor: SYSTEM, assignmentId, status, runFields });
    } catch (err) {
      console.error(`[agent-runner] could not record run for assignment ${assignmentId}: ${err.message}`);
    }
  },
};
