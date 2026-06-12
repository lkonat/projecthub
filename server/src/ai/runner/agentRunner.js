import { queue, DropJob } from '../../queue/index.js';
import { agentRegistry, AGENT_EVENT } from '../index.js';
import { agentsService } from '../../modules/agents/agents.service.js';
import { assignmentsService } from '../../modules/assignments/assignments.service.js';
import { assignmentsRepository } from '../../modules/assignments/assignments.repository.js';
import { phasesRepository } from '../../modules/phases/phases.repository.js';
import { projectsRepository } from '../../modules/projects/projects.repository.js';
import { registry } from '../../extensions/registry.js';
import { SYSTEM } from '../../access/actor.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { ASSIGNMENT_STATUS, EXECUTION_STATE } from '../../constants/assignmentStates.js';
import { questions, conversations, QUESTION_EVENT } from '../../qa/index.js';

// An assignment's run is a `qa` subject — its transcript + questions hang off this.
const SUBJECT_TYPE = 'assignment';
const subjectOf = (assignmentId) => ({ subjectType: SUBJECT_TYPE, subjectId: assignmentId });

// agentRunner — turns "run this agent assignment" into a queued job and executes
// it via the registered agent. The generic queue owns scheduling, concurrency,
// durability, and retry/backoff; the runner owns the agent-specific concerns:
//
//   _resolveRun  validate the run is still worth doing; gather what it needs
//   _execute     run the agent, observe its events, capture how it finished
//   _resolve     turn "how it finished" into an assignment update (verify first)
//   _verify      decide whether a completed result is acceptable
//   _project     write queue lifecycle transitions to the assignment
//
// An assignment's run state is written from TWO sources, deliberately kept apart:
//
//   1. QUEUE LIFECYCLE → QUEUE_PROJECTIONS, applied by _project. started /
//      retrying / failed map to a status + execution_state — the run's mechanical
//      progress, known to the queue (a thrown run is failed here).
//
//   2. THE FINISHED RUN → _resolve, in _execute. The agent only REPORTS how it
//      finished, by emitting a terminal EXECUTING event — 'complete' (with a
//      result), 'failed', or 'input:request'. The runner DECIDES the assignment's
//      fate: a completed result is VERIFIED before it's accepted (completed) or
//      rejected (failed); a reported failure fails; an input request parks the
//      assignment as 'waiting'. The agent never writes status itself.

const JOB_TYPE = 'agent-run';
const MAX_ATTEMPTS = 3;
const keyFor = (assignmentId) => `agent-run:${assignmentId}`;

const PRIORITY_BY_PROJECT = { critical: 30, high: 20, medium: 10, low: 0 };
const sqlNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19); // 'YYYY-MM-DD HH:MM:SS' (UTC)
const asText = (v) => (v == null ? null : typeof v === 'string' ? v : JSON.stringify(v));

// All the events an agent emits during a run — observed (logged) by _execute. A
// few are TERMINAL (how the run finished) and drive resolution; see _execute.
const EXECUTING_EVENTS = Object.values(AGENT_EVENT);

// How a QUEUE lifecycle event projects onto the assignment (status? + runFields).
// Each value is `(job) => patch` so timestamps are stamped at event time. Add a
// row to project a new transition — no handler wiring needed (see init()).
// NOTE: there's no 'completed' here — a successful run is resolved by _resolve
// (which verifies the result first), not by the queue.
const QUEUE_PROJECTIONS = {
  started:  (job) => ({ status: ASSIGNMENT_STATUS.IN_PROGRESS, runFields: { execution_state: EXECUTION_STATE.EXECUTING, started_at: sqlNow(), attempts: job.attempts } }),
  retrying: (job) => ({ status: ASSIGNMENT_STATUS.ACCEPTED,    runFields: { execution_state: EXECUTION_STATE.RETRYING,  error: job.error } }),
  failed:   (job) => ({ status: ASSIGNMENT_STATUS.FAILED,      runFields: { execution_state: EXECUTION_STATE.ERROR,     error: job.error, finished_at: sqlNow() } }),
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
      queue.on(event, (job) => this._project({ job, projection }));
    }
    // Resume a parked assignment when the question it's waiting on is answered.
    questions.on(QUESTION_EVENT.ANSWERED, (question) => this._onAnswered({ question }));
    return this;
  },

  // Enqueue a run for an agent-typed assignment. Dedup by assignment, so a second
  // request while one is queued/running returns the existing job. Returns the job.
  run({ assignmentId, priority } = {}) {
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

  // Job handler: validate → run the agent → resolve the assignment from how it
  // finished. Throwing lets the queue retry/fail; the return value becomes the job
  // result.
  async _execute({ assignmentId }) {
    const { assignment, instance, input, ctx } = await this._resolveRun({ assignmentId });
    const log = ctx.log ?? console;

    // Agents are singletons, so concurrent runs share this emitter — only handle
    // events tagged with THIS run's assignmentId. Observe every event (logging);
    // capture the FIRST terminal one as how the run finished. First-wins because
    // a terminal tool (finish_assignment / ask_question) emits its event before
    // the loop's own trailing 'complete', which we want to ignore.
    const mine = (p) => p.assignmentId === undefined || p.assignmentId === assignmentId;
    let signal = null;
    const detach = tap(instance, EXECUTING_EVENTS, (event, p) => {
      if (!mine(p)) return;
      log.log?.(`[agent-run ${assignmentId}] ${event}`, briefEvent(p));
      if (signal) return;
      if (event === AGENT_EVENT.COMPLETE)          signal = { kind: 'complete', result: p.result };
      else if (event === AGENT_EVENT.FAILED)       signal = { kind: 'failed',   error: p.error };
      else if (event === AGENT_EVENT.INPUT_REQUEST) signal = { kind: 'input',   question: p.question };
    });

    let run; // { ok, result, error } — tryRun never throws
    try {
      run = await instance.tryRun(input, ctx);
    } finally {
      detach();
    }

    // Persist the transcript the agent built/continued (the agent writes the
    // latest onto ctx.messages) — durable history + the basis for resuming.
    if (Array.isArray(ctx.messages)) conversations.save(subjectOf(assignmentId), ctx.messages);

    if (!run.ok) throw new Error(run.error); // a thrown run → let the queue retry/fail
    await this._resolve({ assignmentId, assignment, signal, run });
    // run.result may be a deferred function (a final tool's emitter); never hand
    // that to the queue as the job result.
    return typeof run.result === 'function' ? null : run.result;
  },

  // Resolve everything needed to run, or throw DropJob (no retry) when the run is
  // moot — the assignment/project/phase is gone or no longer active (an agent only
  // runs on the ACTIVE phase of an ACTIVE project). Returns { assignment, instance,
  // input, ctx }.
  async _resolveRun({ assignmentId }) {
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
    // to this run — the agent stamps it on every event for correlation. Seed the
    // prior transcript (empty on a first run) so the agent RESUMES from it after a
    // question was answered; the agent writes the latest transcript back here.
    const ctx = {
      ...(registry.getContext ? await registry.getContext() : {}),
      assignmentId,
      messages: conversations.messages(subjectOf(assignmentId)),
    };
    return { assignment, instance, input, ctx };
  },

  // Resolve the assignment from how the run finished (`signal`). The agent only
  // REPORTED; the runner DECIDES here:
  //   input    → park as 'waiting' (a human must answer before it can continue)
  //   failed   → 'failed' with the agent's reason
  //   complete → VERIFY the result, then 'completed' (accepted) or 'failed' (rejected)
  // A thrown run never reaches here — the queue's 'failed' lifecycle handles it.
  async _resolve({ assignmentId, assignment, signal, run }) {
    if (signal?.kind === 'input') {
      // Record the question against this assignment's conversation, then park the
      // assignment. The ANSWERED listener (see _onAnswered) resumes the run.
      const conv = conversations.ensure(subjectOf(assignmentId));
      questions.ask({
        subjectType: SUBJECT_TYPE,
        subjectId: assignmentId,
        conversationId: conv.id,
        prompt: signal.question || 'The agent requested input.',
      });
      return this._record({
        assignmentId,
        status: ASSIGNMENT_STATUS.WAITING,
        runFields: { execution_state: EXECUTION_STATE.WAITING_PERMISSION },
      });
    }
    if (signal?.kind === 'failed') {
      return this._record({
        assignmentId,
        status: ASSIGNMENT_STATUS.FAILED,
        runFields: { execution_state: EXECUTION_STATE.IDLE, error: signal.error ?? 'Assignment failed.', finished_at: sqlNow() },
      });
    }

    // Completed (or no explicit signal): verify the produced result.
    const result = signal?.kind === 'complete' ? signal.result : run.result;
    const verdict = this._verify({ assignment, result });
    return verdict.passed
      ? this._record({ assignmentId, status: ASSIGNMENT_STATUS.COMPLETED, runFields: { execution_state: EXECUTION_STATE.IDLE, result: asText(result), error: null, finished_at: sqlNow() } })
      : this._record({ assignmentId, status: ASSIGNMENT_STATUS.FAILED,    runFields: { execution_state: EXECUTION_STATE.IDLE, error: verdict.reason, finished_at: sqlNow() } });
  },

  // Decide whether a completed run's result is acceptable → { passed, reason }.
  // STUB: a non-empty result passes. Replace with a real verifier (e.g. an
  // LLM-as-judge agent given the assignment + result) returning this same shape —
  // _resolve depends only on { passed, reason }, nothing else changes.
  _verify({ assignment, result }) {
    const text = asText(result)?.trim();
    if (text) return { passed: true, reason: null };
    return { passed: false, reason: 'Agent finished without producing a result.' };
  },

  // Record a resolution on the assignment (SYSTEM actor — the trusted run lane).
  _record({ assignmentId, status, runFields }) {
    return assignmentsService.recordRun({ actor: SYSTEM, assignmentId, status, runFields });
  },

  // A question was answered → fold the answer into the conversation and re-enqueue
  // the run. _resolveRun seeds the (now-extended) transcript, so the agent resumes
  // where it paused. Only our subjects; failures are logged, never thrown (this is
  // an event handler — it must not break the qa engine).
  _onAnswered({ question }) {
    if (question?.subjectType !== SUBJECT_TYPE) return;
    const assignmentId = Number(question.subjectId);
    try {
      conversations.append(subjectOf(assignmentId), {
        role: 'user',
        content: `Answer to "${question.prompt}": ${question.answer}`,
      });
      this.run({ assignmentId }); // re-enqueue (status → accepted → in_progress)
    } catch (err) {
      console.error(`[agent-runner] could not resume assignment ${assignmentId} after answer: ${err.message}`);
    }
  },

  // Project a QUEUE lifecycle event onto the assignment. `projection(job)` returns
  // { status?, runFields } (a QUEUE_PROJECTIONS entry). Failures are logged, never
  // thrown — they must not disturb the queue.
  async _project({ job, projection }) {
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
