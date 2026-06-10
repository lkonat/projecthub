import { assignmentsRepository } from './assignments.repository.js';
import { phasesService } from '../phases/phases.service.js';
import { registry } from '../../extensions/registry.js';
import { access } from '../../access/access.service.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';

const ASSIGNEE_TYPES = ['user', 'agent', 'bot'];
const STATUSES = ['open', 'resolved', 'cancelled'];
// "Done" means the assignment no longer needs work: resolved or cancelled.
const DONE_STATUSES = ['resolved', 'cancelled'];

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

  async create(actor, phaseId, { title, description, assignee_type, assignee_label, assignee_user_id }) {
    const phase = phasesService.get(phaseId); // ensures phase exists
    // Pass the phase: assignments can only be added while it's open (active or
    // upcoming). A passed (done) phase is frozen until the owner reopens it.
    access.authorize(actor, phase.project_id, 'assignment.create', { phase });
    validateAssigneeType(assignee_type);
    const assignment = assignmentsRepository.create({
      phaseId,
      title: cleanTitle(title),
      description: description?.trim() || null,
      assigneeType: assignee_type ?? 'user',
      assigneeLabel: typeof assignee_label === 'string' ? (assignee_label.trim() || null) : null,
      assigneeUserId: Number.isInteger(assignee_user_id) ? assignee_user_id : null,
    });
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
    const NON_RESOLVE = ['title', 'description', 'assignee_type', 'assignee_label', 'assignee_user_id', 'cancel_reason'];
    const setsResolved = patch.status === 'resolved';
    const editsOther =
      NON_RESOLVE.some((k) => patch[k] !== undefined) ||
      (patch.status !== undefined && patch.status !== 'resolved');
    if (setsResolved) {
      access.authorize(actor, phase.project_id, 'assignment.resolve', { assignment: existing, phase });
    }
    if (editsOther) {
      access.authorize(actor, phase.project_id, 'assignment.update', { assignment: existing, phase });
    }

    const next = {};
    if (patch.title !== undefined)          next.title = cleanTitle(patch.title);
    if (patch.description !== undefined)    next.description = patch.description?.trim() || null;
    if (patch.assignee_type !== undefined)  { validateAssigneeType(patch.assignee_type); next.assignee_type = patch.assignee_type; }
    if (patch.assignee_label !== undefined) next.assignee_label = typeof patch.assignee_label === 'string' ? (patch.assignee_label.trim() || null) : null;
    if (patch.assignee_user_id !== undefined) next.assignee_user_id = Number.isInteger(patch.assignee_user_id) ? patch.assignee_user_id : null;
    if (patch.status !== undefined)         { validateStatus(patch.status); next.status = patch.status; }

    // Cancelling requires a reason (why the work was dropped). Reopening or
    // resolving clears any stale reason. Editing the reason of an
    // already-cancelled assignment is allowed on its own.
    if (next.status === 'cancelled') {
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

    const assignment = assignmentsRepository.update(assignmentId, next);
    const phaseId = existing.phase_id;
    await registry.emit('assignment.after-update', {
      assignment,
      phase,
      projectId: phase.project_id,
    });
    // Differentiated event for dropped work, so hooks can react to a cancellation
    // (with its reason) specifically — not every generic update.
    if (next.status === 'cancelled') {
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
