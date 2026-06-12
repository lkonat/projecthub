import { queue, DropJob } from '../../queue/index.js';
import { agentRegistry, ASSIGNMENT_EVENT, ALL_AGENT_EVENTS } from '../index.js';
import { agentsService } from '../../modules/agents/agents.service.js';
import { assignmentsService } from '../../modules/assignments/assignments.service.js';
import { assignmentsRepository } from '../../modules/assignments/assignments.repository.js';
import { phasesRepository } from '../../modules/phases/phases.repository.js';
import { projectsRepository } from '../../modules/projects/projects.repository.js';
import { registry } from '../../extensions/registry.js';
import { SYSTEM } from '../../access/actor.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { ASSIGNMENT_STATUS, EXECUTION_STATE } from '../../constants/assignmentStates.js';

// agentRunner — the engine that turns "run this agent assignment" into a queued
// job, then executes it via the registered agent. It OWNS the agent-specific
// concerns (build input/ctx, invoke agent.run, persist run state); the generic
// queue owns scheduling, concurrency, durability, and retry/backoff.
//
// Run state is projected onto the assignment's status by listening to the
// queue's lifecycle events (queued→accepted, running→in_progress, failed→failed),
// so there's one writer for the lifecycle and the handler stays a thin "run the
// agent and return its output". (Success is left to the agent itself — an
// AssignmentAgent resolves via the resolve_task tool — so 'completed' isn't
// projected here.)

const JOB_TYPE = 'agent-run';
const MAX_ATTEMPTS = 3;
const keyFor = (assignmentId) => `agent-run:${assignmentId}`;

// Default job priority derived from the project's priority (overridable per run).
const PRIORITY_BY_PROJECT = { critical: 30, high: 20, medium: 10, low: 0 };
const sqlNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19); // 'YYYY-MM-DD HH:MM:SS' (UTC)
const asText = (v) => (v == null ? null : typeof v === 'string' ? v : JSON.stringify(v));

// Compact view of an agent event payload for logging: drop fields already in the
// log prefix (name/assignmentId), elide the prompt input, unwrap Errors, and trim
// long strings so a surfaced event stays one readable line.
function briefEvent(p = {}) {
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    if (k === 'assignmentId' || k === 'name') continue;
    if (k === 'input') { out.input = '…'; continue; }
    if (v instanceof Error) { out[k] = v.message; continue; }
    if (typeof v === 'string') { out[k] = v.length > 120 ? `${v.slice(0, 120)}…` : v; continue; }
    out[k] = v;
  }
  return out;
}

function derivePriority(assignment) {
  const project = assignment.project_id ? projectsRepository.findById(assignment.project_id) : null;
  return PRIORITY_BY_PROJECT[project?.priority] ?? 10;
}

export const agentRunner = {
  JOB_TYPE,

  // Register the handler and wire queue lifecycle → assignment status. Call once
  // at boot, before queue.start().
  init() {
    queue.register(JOB_TYPE, (payload) => this._execute(payload));
    queue.on('started',   (job) => this._project(job, { status: ASSIGNMENT_STATUS.IN_PROGRESS, runFields: { execution_state: EXECUTION_STATE.EXECUTING, started_at: sqlNow(), attempts: job.attempts } }));
    queue.on('completed', (job) => this._project(job, { runFields: { execution_state: EXECUTION_STATE.IDLE, result: asText(job.result), finished_at: sqlNow() } }));
    queue.on('retrying',  (job) => this._project(job, { status: ASSIGNMENT_STATUS.ACCEPTED, runFields: { execution_state: EXECUTION_STATE.RETRYING, error: job.error } }));
    queue.on('failed',    (job) => this._project(job, { status: ASSIGNMENT_STATUS.FAILED, runFields: { execution_state: EXECUTION_STATE.ERROR, error: job.error, finished_at: sqlNow() } }));
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
    assignmentsService.recordRun({ actor: SYSTEM, assignmentId, status: ASSIGNMENT_STATUS.ACCEPTED, runFields: { execution_state: EXECUTION_STATE.IDLE, error: null } });
    return queue.enqueue(
      JOB_TYPE,
      { assignmentId },
      { priority: priority ?? derivePriority(assignment), maxAttempts: MAX_ATTEMPTS, key: keyFor(assignmentId) },
    );
  },

  // The job handler: build input + ctx, invoke the agent, return its output (the
  // queue stores it as the job result; events project the assignment status). Throwing lets
  // the queue retry with backoff.
  async _execute({ assignmentId }) {
    console.log("QUEUE _execute",{assignmentId} )
    const assignment = assignmentsRepository.findById(assignmentId);
    // The assignment is gone — the run is moot. Drop the job (no retry, no fail).
    if (!assignment) throw new DropJob(`Assignment ${assignmentId} no longer exists`);
    // The project must still be active — a done/cancelled project is frozen, so
    // the run is moot. Drop it.
    const project = projectsRepository.findById(assignment.project_id);
    if (!project || project.status !== 'active') {
      throw new DropJob(`Assignment ${assignmentId}'s project is not active (${project?.status ?? 'gone'})`);
    }
    // The phase may have advanced since the job was enqueued. An agent only runs
    // on the ACTIVE phase, so if it isn't active anymore the run is moot — drop it.
    const phase = phasesRepository.findById(assignment.phase_id);
    if (!phase || phase.status !== 'active') {
      throw new DropJob(`Assignment ${assignmentId} is not on an active phase (phase ${assignment.phase_id} is ${phase?.status ?? 'gone'})`);
    }
    const agentRow = agentsService.get(assignment.assignee_agent_id); // throws if the agent row is gone
    const instance = agentRegistry.get(agentRow.slug);                // throws if the code agent is unregistered
    const ext = assignmentsService.getAgentRun(assignmentId);
    const input = ext?.input ?? { assignment };                       // caller-supplied input, else the assignment
    // Per-run ctx (NOT the shared singleton from getContext) so assignmentId is
    // scoped to this run — finish_assignment reads it and stamps the event so the
    // listener can correlate (agents are singletons; runs share the emitter).
    const ctx = { ...(registry.getContext ? await registry.getContext() : {}), assignmentId };

    // Surface EVERY event the agent emits during this run. One tap over the full
    // event set (ALL_AGENT_EVENTS) — filtered to this run by assignmentId, since
    // the agent singleton is shared across concurrent runs. Lifecycle events are
    // logged for observability; the two outcome signals also capture the result
    // to persist AFTER the run (the runner stays the single DB writer).
    const log = ctx.log ?? console;
    let signal = null;
    const onEvent = (event) => (p = {}) => {
      if (p.assignmentId !== undefined && p.assignmentId !== assignmentId) return; // another run on the shared instance
      log.log?.(`[agent-run ${assignmentId}] ${event}`, briefEvent(p));
      if (event === ASSIGNMENT_EVENT.SUCCEEDED) {
        signal = { status: ASSIGNMENT_STATUS.COMPLETED, result: p.result, execution_state: EXECUTION_STATE.IDLE, error: null };
      } else if (event === ASSIGNMENT_EVENT.FAILED) {
        signal = { status: ASSIGNMENT_STATUS.FAILED, error: p.error, execution_state: EXECUTION_STATE.ERROR };
      }else if(ALL_AGENT_EVENTS.INPUT_REQUEST){
        // request input from user
        // the the current state of the agent for later when the question is answered.  ask user 
      }
    };
    const taps = ALL_AGENT_EVENTS.map((event) => {
      const fn = onEvent(event);
      instance.on(event, fn);
      return [event, fn];
    });

    // tryRun returns { ok, result, error } — translate failure into a throw so
    // the queue retries/fails, and success into the result so the queue clears it.
    let outcome;
    try {
      outcome = await instance.tryRun(input, ctx);
    } finally {
      for (const [event, fn] of taps) instance.off(event, fn);
    }

    // Persist the agent-signaled outcome (a thrown run is handled by the queue's
    // 'failed' lifecycle instead). On success, fall back to the run's final text
    // if the model didn't pass an explicit result.
    // if (signal) {
    //   await assignmentsService.recordRun({
    //     actor: SYSTEM,
    //     assignmentId,
    //     status: signal.status,
    //     runFields: {
    //       execution_state: signal.execution_state,
    //       error: signal.error ?? null,
    //       ...(signal.status === ASSIGNMENT_STATUS.COMPLETED ? { result: signal.result ?? asText(outcome.result) } : {}),
    //       finished_at: sqlNow(),
    //     },
    //   });
    // }

    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.result;
  },

  // Mirror a queue lifecycle event onto the assignment's run state. Failures here
  // are logged, never thrown — they must not disturb the queue.
  async _project(job, { status, runFields }) {
    if (job.type !== JOB_TYPE) return;
    const assignmentId = job.payload?.assignmentId;
    if (!assignmentId) return;
    try { await assignmentsService.recordRun({ actor: SYSTEM, assignmentId, status, runFields }); }
    catch (err) { console.error(`[agent-runner] could not record run for assignment ${assignmentId}: ${err.message}`); }
  },
};
