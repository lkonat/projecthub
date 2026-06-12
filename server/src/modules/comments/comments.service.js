import { commentsRepository } from './comments.repository.js';
import { projectsService } from '../projects/projects.service.js';
import { registry } from '../../extensions/registry.js';
import { access } from '../../access/access.service.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';

export const commentsService = {
  listForProject(actor, projectId) {
    const project = access.authorize(actor, projectId, 'comment.view');
    // Per-row capability boolean, computed server-side from the policy. The
    // isAssignee lookup is memoized, so this stays O(1)-DB across all rows.
    return commentsRepository.listByProject(projectId).map((c) => ({
      ...c,
      canDelete: access.allows(actor, project, 'comment.delete', { comment: c }),
    }));
  },

  async create(actor, projectId, { body, parentId = null }) {
    access.authorize(actor, projectId, 'comment.create'); // owner OR assignee
    const project = projectsService.get(projectId); // for the hook payload (.type)
    if (!body || !body.trim()) throw new ValidationError('body is required');
    // Replies attach to a parent comment. Validate it exists, belongs to this
    // project, and is itself top-level so threads stay one level deep.
    let parent = null;
    if (parentId != null) {
      parent = commentsRepository.findById(parentId);
      if (!parent || parent.project_id !== projectId) {
        throw new ValidationError('parent comment not found in this project');
      }
      if (parent.parent_id != null) {
        throw new ValidationError('cannot reply to a reply');
      }
    }
    const comment = commentsRepository.create({
      projectId, body: body.trim(), userId: actor.id, parentId: parent ? parent.id : null,
    });
    // Include `project` so type-scoped hooks on comment events route correctly.
    await registry.emit('comment.after-create', { comment, project, projectId });
    return comment;
  },

  async remove(actor, id) {
    const existing = commentsRepository.findById(id);
    if (!existing) throw new NotFoundError('Comment');
    // owner OR the comment's author may delete (commentOwner).
    access.authorize(actor, existing.project_id, 'comment.delete', { comment: existing });
    let project = null;
    try { project = projectsService.get(existing.project_id); } catch { /* gone */ }
    const removed = commentsRepository.remove(id);
    await registry.emit(
      'comment.after-delete',
      { id, project, projectId: existing.project_id, comment: existing },
    );
    return removed;
  },
};
