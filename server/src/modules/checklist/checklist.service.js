import { checklistRepository } from './checklist.repository.js';
import { projectsService } from '../projects/projects.service.js';
import { registry } from '../../extensions/registry.js';
import { access } from '../../access/access.service.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';

function cleanText(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError('text is required');
  }
  return value.trim();
}

export const checklistService = {
  listForProject(actor, projectId) {
    access.authorize(actor, projectId, 'checklist.view');
    return checklistRepository.listByProject(projectId);
  },

  async create(actor, projectId, { text }) {
    const project = access.authorize(actor, projectId, 'checklist.manage');
    const item = checklistRepository.create({
      projectId,
      text: cleanText(text),
      position: checklistRepository.nextPosition(projectId),
    });
    await registry.emit('checklist.after-create', { item, project, projectId });
    return item;
  },

  async update(actor, itemId, patch) {
    const existing = checklistRepository.findById(itemId);
    if (!existing) throw new NotFoundError('Checklist item');
    access.authorize(actor, existing.project_id, 'checklist.manage');

    const next = {};
    if (patch.text !== undefined) next.text = cleanText(patch.text);
    if (patch.done !== undefined) next.done = toBool(patch.done);
    if (Object.keys(next).length === 0) {
      throw new ValidationError('Nothing to update (expected `text` and/or `done`)');
    }

    const item = checklistRepository.update(itemId, next);
    let project = null;
    try { project = projectsService.get(existing.project_id); } catch { /* gone */ }
    await registry.emit(
      'checklist.after-update',
      { item, project, projectId: existing.project_id },
    );
    return item;
  },

  async remove(actor, itemId) {
    const existing = checklistRepository.findById(itemId);
    if (!existing) throw new NotFoundError('Checklist item');
    access.authorize(actor, existing.project_id, 'checklist.manage');
    let project = null;
    try { project = projectsService.get(existing.project_id); } catch { /* gone */ }
    const removed = checklistRepository.remove(itemId);
    await registry.emit(
      'checklist.after-delete',
      { id: itemId, item: existing, project, projectId: existing.project_id },
    );
    return removed;
  },

  async reorder(actor, projectId, orderedIds) {
    const project = access.authorize(actor, projectId, 'checklist.manage');
    if (!Array.isArray(orderedIds) || orderedIds.some((n) => !Number.isInteger(n) || n <= 0)) {
      throw new ValidationError('orderedIds must be an array of positive integers');
    }
    const items = checklistRepository.reorder(projectId, orderedIds);
    await registry.emit('checklist.after-reorder', { items, project, projectId });
    return items;
  },
};

function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
  throw new ValidationError('done must be a boolean');
}
