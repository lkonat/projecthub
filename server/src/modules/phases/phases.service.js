import { phasesRepository } from './phases.repository.js';
import { assignmentsRepository } from '../assignments/assignments.repository.js';
import { projectsService } from '../projects/projects.service.js';
import { registry } from '../../extensions/registry.js';
import { access } from '../../access/access.service.js';
import { SYSTEM } from '../../access/actor.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';

function cleanName(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError('name is required');
  }
  return value.trim();
}

export const phasesService = {
  listForProject(actor, projectId) {
    const project = access.authorize(actor, projectId, 'phase.view'); // owner OR assignee
    // Per-phase capability booleans, computed server-side with the phase in
    // context so the "passed phase is frozen" rule lives only in the policy. The
    // client reads these to show/hide the edit, add-assignment, and reopen
    // ("go backward") affordances — no rule duplicated there.
    return phasesRepository.listByProject(projectId).map((phase) => ({
      ...phase,
      canEdit:          access.allows(actor, project, 'phase.edit', { phase }),
      canDelete:        access.allows(actor, project, 'phase.delete', { phase }),
      canAddAssignment: access.allows(actor, project, 'assignment.create', { phase }),
      canReopen:        access.allows(actor, project, 'phase.reopen', { phase }),
    }));
  },

  // The current (active) phase of a project, or null if none is active (every
  // phase done, or none exist). Callers authorize via listForProject.
  currentForProject(projectId) {
    return phasesRepository.activeByProject(projectId) ?? null;
  },

  // Maintain the "at most one active phase" invariant: if a project has no
  // active phase but still has idle ones, promote the lowest-position idle phase
  // to active. Returns the promoted phase (or null). Internal — no auth (the
  // caller already authorized the action that triggered the advance).
  async ensureActive(projectId) {
    if (phasesRepository.activeByProject(projectId)) return null;
    const next = phasesRepository.firstIdleByProject(projectId);
    if (!next) return null;
    const promoted = phasesRepository.update(next.id, { status: 'active' });
    let project = null;
    try { project = projectsService.get(projectId); } catch { /* gone */ }
    // phase.after-activate (not the generic after-update): a phase became the
    // current one through forward progress. Differentiated from phase.after-reopen
    // (reactivation of a done phase via "go backward").
    await registry.emit('phase.after-activate', { phase: promoted, project, projectId });
    return promoted;
  },

  // The project a phase belongs to (or null) — for ownership checks.
  projectIdOf(phaseId) {
    const phase = phasesRepository.findById(phaseId);
    return phase ? phase.project_id : null;
  },

  get(phaseId) {
    const phase = phasesRepository.findById(phaseId);
    if (!phase) throw new NotFoundError('Phase');
    return phase;
  },

  async create(actor, projectId, { name, description }) {
    const project = access.authorize(actor, projectId, 'phase.manage');
    const created = phasesRepository.create({
      projectId,
      name: cleanName(name),
      description: description?.trim() || null,
      position: phasesRepository.nextPosition(projectId),
    });
    await registry.emit('phase.after-create', { phase: created, project, projectId });
    // New phases start idle. If the project has no active phase yet (e.g. this
    // is the first phase), promote it so there's always a current phase to work.
    await this.ensureActive(projectId);
    return phasesRepository.findById(created.id); // reflect any promotion
  },

  async update(actor, phaseId, patch) {
    const existing = phasesRepository.findById(phaseId);
    if (!existing) throw new NotFoundError('Phase');
    // phase.edit (not phase.manage): a passed (done) phase is frozen — its
    // details can't be edited until the owner reopens it. Pass the phase so the
    // conditional rule can read its status.
    access.authorize(actor, existing.project_id, 'phase.edit', { phase: existing });

    const next = {};
    if (patch.name !== undefined)        next.name = cleanName(patch.name);
    if (patch.description !== undefined) next.description = patch.description?.trim() || null;
    if (Object.keys(next).length === 0) {
      throw new ValidationError('Nothing to update (expected `name` and/or `description`)');
    }

    const phase = phasesRepository.update(phaseId, next);
    let project = null;
    try { project = projectsService.get(existing.project_id); } catch { /* gone */ }
    await registry.emit('phase.after-update', { phase, project, projectId: existing.project_id });
    return phase;
  },

  async remove(actor, phaseId) {
    const existing = phasesRepository.findById(phaseId);
    if (!existing) throw new NotFoundError('Phase');
    // phase.delete (not phase.manage): a passed (done) phase is frozen and can't
    // be deleted until the owner reopens it. Pass the phase for the status check.
    access.authorize(actor, existing.project_id, 'phase.delete', { phase: existing });
    let project = null;
    try { project = projectsService.get(existing.project_id); } catch { /* gone */ }
    const removed = phasesRepository.remove(phaseId);
    await registry.emit(
      'phase.after-delete',
      { id: phaseId, phase: existing, project, projectId: existing.project_id }
    );
    // If the active phase was deleted, promote the next idle one so the project
    // still has a current phase. Then re-check closure (e.g. the deleted phase
    // was the last non-done one).
    await this.ensureActive(existing.project_id);
    await this.maybeCloseProject(existing.project_id);
    return removed;
  },

  async reorder(actor, projectId, orderedIds) {
    const project = access.authorize(actor, projectId, 'phase.manage');
    if (!Array.isArray(orderedIds) || orderedIds.some((n) => !Number.isInteger(n) || n <= 0)) {
      throw new ValidationError('orderedIds must be an array of positive integers');
    }
    const phases = phasesRepository.reorder(projectId, orderedIds);
    await registry.emit('phase.after-reorder', { phases, project, projectId });
    return phases;
  },

  // "Go backward": the owner reopens a passed (done) phase, making it the current
  // phase again. It becomes 'active', and any phase that was active is demoted
  // back to 'idle' (there's only one current phase). Its details and assignments
  // become editable once more. Only a done phase can be reopened (enforced by the
  // phase.reopen rule, which requires status 'done').
  async reopen(actor, phaseId) {
    const existing = phasesRepository.findById(phaseId);
    if (!existing) throw new NotFoundError('Phase');
    access.authorize(actor, existing.project_id, 'phase.reopen', { phase: existing });

    // Demote the current active phase (if any) — we're moving back to an earlier
    // one, so only the reopened phase should be active.
    const current = phasesRepository.activeByProject(existing.project_id);
    if (current && current.id !== phaseId) {
      const demoted = phasesRepository.update(current.id, { status: 'idle' });
      await registry.emit('phase.after-update', {
        phase: demoted, project: null, projectId: existing.project_id,
      });
    }

    const phase = phasesRepository.update(phaseId, { status: 'active' });

    // Reopening un-does completion: if the project had auto-closed (every phase
    // done), there's open work again, so reactivate it. Mirrors maybeCloseProject
    // as a SYSTEM action — the system maintaining its own "all phases done ⇒
    // done" invariant, not a principal editing the project.
    let project = null;
    try { project = projectsService.get(existing.project_id); } catch { /* gone */ }
    if (project && project.status === 'done') {
      await projectsService.update(SYSTEM, existing.project_id, { status: 'active' });
    }
    await registry.emit('phase.after-reopen', { phase, project, projectId: existing.project_id });
    return phase;
  },

  // Re-evaluate a phase after one of its assignments changed. Only the ACTIVE
  // phase can auto-complete (idle phases aren't being worked, and their
  // assignments can't be resolved); it completes when it has at least one
  // assignment and every assignment is done (resolved or cancelled). On
  // completion the next idle phase is promoted to active, and we re-check whether
  // the whole project is now closed.
  //
  // Returns { phase, completed } where `completed` is true iff this call moved
  // the phase from active -> done.
  async evaluatePhaseCompletion(phaseId) {
    const phase = phasesRepository.findById(phaseId);
    if (!phase || phase.status !== 'active') return { phase, completed: false };

    const counts = assignmentsRepository.statusCounts(phaseId);
    const total = counts.total;
    const done = counts.done;
    if (total === 0 || done < total) {
      return { phase, completed: false };
    }

    const updated = phasesRepository.update(phaseId, { status: 'done' });
    let project = null;
    try { project = projectsService.get(phase.project_id); } catch { /* gone */ }
    await registry.emit('phase.after-complete', {
      phase: updated,
      project,
      projectId: phase.project_id,
    });
    // Advance: promote the next idle phase to active (if any), then re-check
    // whether all phases are now done and the project should close.
    await this.ensureActive(phase.project_id);
    await this.maybeCloseProject(phase.project_id);
    return { phase: updated, completed: true };
  },

  // Close the project if it has at least one phase and every phase is done.
  // Idempotent: does nothing if the project is already done.
  // Returns true iff this call closed the project.
  async maybeCloseProject(projectId) {
    const total = phasesRepository.countByProject(projectId);
    if (total === 0) return false;
    const live = phasesRepository.liveByProject(projectId); // idle or active
    if (live.length > 0) return false;

    let project;
    try { project = projectsService.get(projectId); } catch { return false; }
    if (project.status === 'done') return false;

    // Auto-close is a SYSTEM action (the system enforcing its own invariant —
    // all phases done — not a principal editing the project), so it bypasses
    // the owner-only `project.edit` rule. This is the trusted internal lane.
    await projectsService.update(SYSTEM, projectId, { status: 'done' });
    await registry.emit('project.after-close', { projectId, project });
    return true;
  },
};
