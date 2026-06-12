import { assignmentsRepository } from './assignments.repository.js';
import { agentAssignmentsRepository } from './agent-assignments.repository.js';
import { phasesService } from '../phases/phases.service.js';
import { agentsService } from '../agents/agents.service.js';
import { agentRunner } from '../../ai/runner/index.js';
import { registry } from '../../extensions/registry.js';
import { access } from '../../access/access.service.js';
import { getDb } from '../../db/connection.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { ASSIGNMENT_STATUS, ASSIGNMENT_STATUSES, DONE_STATUSES } from '../../constants/assignmentStates.js';

const ASSIGNEE_TYPES = ['user', 'agent', 'bot'];
// Status enums come from the shared single source of truth (see
// constants/assignmentStates.js → client/lib/assignmentStates.mjs).
//   STATUSES       — every valid assignment status
//   DONE_STATUSES  — completed/cancelled: no longer needs work, so the phase can
//                    complete (failed/rejected/blocked/waiting keep it open)
const STATUSES = ASSIGNMENT_STATUSES;

// ── Agent-run extension (agent_assignments) ────────────────────────────────
// agent_assignments is a 1:1 extension of an agent-typed assignment. It's owned
// by THIS service (not a separate one) so run-state and assignment changes can be
// updated together in a transaction. It has no timestamps of its own — the
// parent assignment's updated_at is bumped instead.

// Shape an agent_assignments row: parse its JSON columns.
function presentAgentRun(row) {
  if (!row) return null;
  const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
  return {
    assignment_id: row.assignment_id,
    execution_state: row.execution_state,  // agent run-loop state (see migration 024)
    input: parse(row.input),
    result: row.result,
    error: row.error,
    model: row.model,
    usage: parse(row.usage),
    attempts: row.attempts,
    started_at: row.started_at,
    finished_at: row.finished_at,
  };
}

const agentRunOf = (assignmentId) => presentAgentRun(agentAssignmentsRepository.findById(assignmentId));

function cleanTitle(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError('title is required');
  }
  return value.trim();
}

function validateAssigneeType(t) {
  if (t !== undefined && !ASSIGNEE_TYPES.includes(t)) {
    throw new ValidationError(`assignee_type must be one of: ${ASSIGNEE_TYPES.join(', ')}`);
  }
}

function validateStatus(s) {
  if (s !== undefined && !STATUSES.includes(s)) {
    throw new ValidationError(`status must be one of: ${STATUSES.join(', ')}`);
  }
}

// Resolve the four assignee_* fields into a consistent set, keyed off the type.
// The id fields are mutually exclusive: a 'user' assignee carries assignee_user_id
// (and no agent), an 'agent' assignee must reference an assignable agent (and no
// user), a 'bot' carries neither. An agent assignee defaults its display label to
// the agent's name unless an explicit label is given.
function normalizeAssignee({ assignee_type, assignee_label, assignee_user_id, assignee_agent_id }) {
  const type = assignee_type ?? 'user';
  validateAssigneeType(type);
  const label = typeof assignee_label === 'string' ? (assignee_label.trim() || null) : null;

  if (type === 'agent') {
    const agentId = Number.isInteger(assignee_agent_id) ? assignee_agent_id : null;
    const agent = agentsService.assignableOrThrow(agentId); // throws if missing/disabled
    return { assignee_type: 'agent', assignee_agent_id: agent.id, assignee_user_id: null, assignee_label: label ?? agent.title };
  }
  if (type === 'user') {
    const userId = Number.isInteger(assignee_user_id) ? assignee_user_id : null;
    return { assignee_type: 'user', assignee_user_id: userId, assignee_agent_id: null, assignee_label: label };
  }
  // bot — label only
  return { assignee_type: 'bot', assignee_user_id: null, assignee_agent_id: null, assignee_label: label };
}

export const assignmentsService = {
  ASSIGNEE_TYPES,
  STATUSES,
  DONE_STATUSES,

  listForPhase(actor, phaseId) {
    const phase = phasesService.get(phaseId); // ensures phase exists (throws NotFound)
    const project = access.authorize(actor, phase.project_id, 'assignment.view');
    // Per-row capability booleans, computed server-side with the phase in
    // context so the conditional update rule (assignee blocked once the phase is
    // done) is honored. The client just reads these — no rule duplicated there.
    return assignmentsRepository.listByPhase(phaseId).map((a) => ({
      ...a,
      // canResolve = may mark THIS assignment done (assignee only); canUpdate =
      // may cancel/reopen/edit it (owner or assignee). The client shows the
      // Resolve button off canResolve and Cancel/Reopen off canUpdate.
      canResolve: access.allows(actor, project, 'assignment.resolve', { assignment: a, phase }),
      canUpdate: access.allows(actor, project, 'assignment.update', { assignment: a, phase }),
      canDelete: access.allows(actor, project, 'assignment.delete', { assignment: a, phase }),
      // Whether THIS actor may run the assigned agent (owner, active project).
      // Only meaningful for agent assignees.
      canRun: a.assignee_type === 'agent' && access.allows(actor, project, 'assignment.run', { assignment: a, phase }),
      // For agent assignees, attach the 1:1 extension row (run state, etc.).
      agent: a.assignee_type === 'agent' ? agentRunOf(a.id) : undefined,
    }));
  },

  get(id) {
    const a = assignmentsRepository.findById(id);
    if (!a) throw new NotFoundError('Assignment');
    return a;
  },

  // The actor's assignments across all projects. `current: true` limits to open
  // assignments in each project's active phase. (Scoped to the actor by id, so
  // no per-project authorization is needed — you only ever see your own.)
  listForUser(actor, { current = false } = {}) {
    return current
      ? assignmentsRepository.listCurrentForUser(actor.id)
      : assignmentsRepository.listForUser(actor.id);
  },

  // The project an assignment belongs to (or null) — for ownership checks.
  // Walks assignment -> phase -> project.
  projectIdOf(assignmentId) {
    const a = assignmentsRepository.findById(assignmentId);
    if (!a) return null;
    return phasesService.projectIdOf(a.phase_id);
  },

  // Enqueue an agent run for an agent-typed assignment. Owner-gated; the actual
  // execution happens asynchronously via the queue (see ai/runner/agentRunner).
  // Uses the denormalized assignment.project_id for the authorization check.
  requestRun(actor, assignmentId, { priority } = {}) {
    const assignment = assignmentsRepository.findById(assignmentId);
    if (!assignment) throw new NotFoundError('Assignment');
    // Load the phase so the rule can require it to be ACTIVE (you can only run
    // the agent on the current phase, not an idle or done one).
    const phase = phasesService.get(assignment.phase_id);
    access.authorize(actor, assignment.project_id, 'assignment.run', { assignment, phase });
    return agentRunner.run({ assignmentId, priority });
  },

  // The agent-run extension for an assignment (or null if it isn't agent-typed).
  getAgentRun(assignmentId) {
    return agentRunOf(assignmentId);
  },

  // Record an agent run — the assignment's `status` and/or its agent-execution
  // payload (result, error, model, usage, attempts, timing), atomically. Status
  // now lives ON the assignment (there is no run_status); the runner and the
  // task tools pass it directly. `runFields` writes the agent_assignments
  // extension; a missing extension row is created. JSON columns (input/usage)
  // are stringified. Either may be omitted: a status-only call leaves the
  // payload alone, a payload-only call leaves the status alone — both still bump
  // the assignment's updated_at. If `status` moves the assignment to a done
  // status, the phase is re-evaluated (it may complete and advance the project),
  // exactly like a manual resolve.
  //
  // This is the trusted run-state path: unlike update(), it sets status directly
  // (no cancel-reason rule, no resolve gate). Authorized like any run operation —
  // the runner passes the SYSTEM actor (the in-process trust lane, which bypasses
  // the policy); a real actor must hold `assignment.run` on the project.
  async recordRun({ actor, assignmentId, status, runFields = {} }) {
    const assignment = assignmentsRepository.findById(assignmentId);
    if (!assignment) throw new NotFoundError('Assignment');
    const phase = phasesService.get(assignment.phase_id);
    access.authorize(actor, phase.project_id, 'assignment.run', { assignment, phase });
    if (status !== undefined) validateStatus(status);

    const { execution_state, input, result, error, model, usage, attempts, started_at, finished_at } = runFields;
    const ext = {};
    if (execution_state !== undefined) ext.execution_state = execution_state;
    if (input       !== undefined) ext.input       = input == null ? null : JSON.stringify(input);
    if (result      !== undefined) ext.result      = result;
    if (error       !== undefined) ext.error       = error;
    if (model       !== undefined) ext.model       = model;
    if (usage       !== undefined) ext.usage       = usage == null ? null : JSON.stringify(usage);
    if (attempts    !== undefined) ext.attempts    = attempts;
    if (started_at  !== undefined) ext.started_at  = started_at;
    if (finished_at !== undefined) ext.finished_at = finished_at;

    const recorded = getDb().transaction(() => {
      if (Object.keys(ext).length) agentAssignmentsRepository.upsert(assignmentId, ext);
      // Setting status updates the assignment (and bumps updated_at); otherwise a
      // payload-only write still bumps it (the extension has no timestamps).
      if (status !== undefined) assignmentsRepository.update(assignmentId, { status });
      else assignmentsRepository.touch(assignmentId);
      return agentRunOf(assignmentId);
    })();

    // A done status can complete the phase — re-evaluate after the transaction
    // (same as assignmentsService.update does on a manual resolve).
    if (status !== undefined && DONE_STATUSES.includes(status)) {
      await phasesService.evaluatePhaseCompletion(phase.id);
    }
    return recorded;
  },

  async create(actor, phaseId, { title, description, assignee_type, assignee_label, assignee_user_id, assignee_agent_id }) {
    const phase = phasesService.get(phaseId); // ensures phase exists
    // Pass the phase: assignments can only be added while it's open (active or
    // upcoming). A passed (done) phase is frozen until the owner reopens it.
    access.authorize(actor, phase.project_id, 'assignment.create', { phase });
    const assignee = normalizeAssignee({ assignee_type, assignee_label, assignee_user_id, assignee_agent_id });
    // Insert the assignment and, for an agent assignee, its 1:1 extension row in
    // one transaction so the parent and child never diverge. project_id is
    // denormalized from the phase (immutable thereafter).
    const assignment = getDb().transaction(() => {
      const a = assignmentsRepository.create({
        phaseId,
        projectId: phase.project_id,
        title: cleanTitle(title),
        description: description?.trim() || null,
        assigneeType: assignee.assignee_type,
        assigneeLabel: assignee.assignee_label,
        assigneeUserId: assignee.assignee_user_id,
        assigneeAgentId: assignee.assignee_agent_id,
      });
      if (a.assignee_type === 'agent') agentAssignmentsRepository.create({ assignmentId: a.id });
      return a;
    })();
    await registry.emit('assignment.after-create', {
      assignment,
      phase,
      projectId: phase.project_id,
    });
    return assignment;
  },

  async update(actor, assignmentId, patch) {
    const existing = assignmentsRepository.findById(assignmentId);
    if (!existing) throw new NotFoundError('Assignment');
    // Load the phase so the conditional rules can see its status. Two distinct
    // gates: RESOLVING (marking work done) is reserved to the assignee; every
    // OTHER change (cancel, reopen, edit, reassign) uses the general update rule
    // (owner or the assignee). A patch that does both must satisfy both.
    const phase = phasesService.get(existing.phase_id);
    const NON_RESOLVE = ['title', 'description', 'assignee_type', 'assignee_label', 'assignee_user_id', 'assignee_agent_id', 'cancel_reason'];
    // "Resolving" — marking your own work done — now means setting 'completed';
    // every other status change (accept, reject, block, cancel, reopen, …) goes
    // through the general update gate.
    const setsResolved = patch.status === ASSIGNMENT_STATUS.COMPLETED;
    const editsOther =
      NON_RESOLVE.some((k) => patch[k] !== undefined) ||
      (patch.status !== undefined && patch.status !== ASSIGNMENT_STATUS.COMPLETED);
    if (setsResolved) {
      access.authorize(actor, phase.project_id, 'assignment.resolve', { assignment: existing, phase });
    }
    if (editsOther) {
      access.authorize(actor, phase.project_id, 'assignment.update', { assignment: existing, phase });
    }

    const next = {};
    if (patch.title !== undefined)          next.title = cleanTitle(patch.title);
    if (patch.description !== undefined)    next.description = patch.description?.trim() || null;
    if (patch.status !== undefined)         { validateStatus(patch.status); next.status = patch.status; }

    // Assignee is resolved as a unit so the type and its id field stay consistent
    // (switching to an agent clears the user link and vice versa). Only recompute
    // when the patch touches an assignee field; merge unspecified parts from the
    // existing row, but never carry a label or id across a type change.
    const ASSIGNEE_KEYS = ['assignee_type', 'assignee_label', 'assignee_user_id', 'assignee_agent_id'];
    if (ASSIGNEE_KEYS.some((k) => patch[k] !== undefined)) {
      const nextType = patch.assignee_type ?? existing.assignee_type;
      const sameType = nextType === existing.assignee_type;
      const merged = normalizeAssignee({
        assignee_type:     nextType,
        assignee_label:    patch.assignee_label    ?? (sameType ? existing.assignee_label : null),
        assignee_user_id:  patch.assignee_user_id  ?? (nextType === 'user'  ? existing.assignee_user_id  : null),
        assignee_agent_id: patch.assignee_agent_id ?? (nextType === 'agent' ? existing.assignee_agent_id : null),
      });
      Object.assign(next, merged);
    }

    // Cancelling requires a reason (why the work was dropped). Reopening or
    // resolving clears any stale reason. Editing the reason of an
    // already-cancelled assignment is allowed on its own.
    if (next.status === ASSIGNMENT_STATUS.CANCELLED) {
      const reason = typeof patch.cancel_reason === 'string' ? patch.cancel_reason.trim() : '';
      if (!reason) throw new ValidationError('A reason is required to cancel an assignment');
      next.cancel_reason = reason;
    } else if (next.status !== undefined) {
      next.cancel_reason = null; // moved to open/resolved → drop the reason
    } else if (patch.cancel_reason !== undefined) {
      next.cancel_reason = typeof patch.cancel_reason === 'string' ? (patch.cancel_reason.trim() || null) : null;
    }

    if (Object.keys(next).length === 0) {
      throw new ValidationError('Nothing to update');
    }

    // Update the assignment and reconcile its agent extension row in one
    // transaction: gaining the 'agent' type creates the 1:1 row, losing it drops
    // the row (per the "row exists iff agent-typed" invariant).
    const assignment = getDb().transaction(() => {
      const a = assignmentsRepository.update(assignmentId, next);
      const wasAgent = existing.assignee_type === 'agent';
      const isAgent = a.assignee_type === 'agent';
      if (isAgent && !wasAgent)      agentAssignmentsRepository.create({ assignmentId: a.id });
      else if (!isAgent && wasAgent) agentAssignmentsRepository.remove(a.id);
      return a;
    })();
    const phaseId = existing.phase_id;
    await registry.emit('assignment.after-update', {
      assignment,
      phase,
      projectId: phase.project_id,
    });
    // Differentiated event for dropped work, so hooks can react to a cancellation
    // (with its reason) specifically — not every generic update.
    if (next.status === ASSIGNMENT_STATUS.CANCELLED) {
      await registry.emit('assignment.after-cancel', {
        assignment,
        phase,
        projectId: phase.project_id,
      });
    }

    // Status moving into a done state may complete the phase (and close the
    // project). Only bother when the status actually changed to done.
    if (next.status !== undefined && DONE_STATUSES.includes(next.status)) {
      await phasesService.evaluatePhaseCompletion(phaseId);
    }
    return assignment;
  },

  async remove(actor, assignmentId) {
    const existing = assignmentsRepository.findById(assignmentId);
    if (!existing) throw new NotFoundError('Assignment');
    const phaseId = existing.phase_id;
    // Load the phase first: deletion is frozen once the phase is passed (done),
    // so the conditional rule needs the phase's status in context.
    const phase = phasesService.get(phaseId);
    access.authorize(actor, phase.project_id, 'assignment.delete', { assignment: existing, phase });
    const removed = assignmentsRepository.remove(assignmentId);
    await registry.emit('assignment.after-delete', {
      id: assignmentId,
      assignment: existing,
      phase,
      projectId: phase?.project_id,
    });
    // Removing an assignment can complete a phase (e.g. it was the last open
    // one), so re-evaluate. evaluatePhaseCompletion requires >=1 assignment,
    // so removing the only assignment will NOT auto-complete an empty phase.
    await phasesService.evaluatePhaseCompletion(phaseId);
    return removed;
  },
};
