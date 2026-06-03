import { commentsRepository } from './comments.repository.js';
import { projectsService } from '../projects/projects.service.js';
import { registry } from '../../extensions/registry.js';
import { getDb } from '../../db/connection.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';

async function buildCtx() {
  const db = getDb();
  const { services } = await import('../../services.js');
  let realtime;
  try { ({ realtime } = await import('../../realtime/index.js')); }
  catch { realtime = { broadcast() {}, isStarted() { return false; } }; }
  return { db, log: console, services, realtime };
}

export const commentsService = {
  listForProject(projectId) {
    projectsService.get(projectId); // ensures project exists
    return commentsRepository.listByProject(projectId);
  },

  async create(projectId, { body }) {
    const project = projectsService.get(projectId);  // ensures project exists; also gives us .type
    if (!body || !body.trim()) throw new ValidationError('body is required');
    const comment = commentsRepository.create({ projectId, body: body.trim() });
    // Include `project` so type-scoped hooks on comment events route correctly.
    await registry.emit('comment.after-create', { comment, project, projectId }, await buildCtx());
    return comment;
  },

  async remove(id) {
    const existing = commentsRepository.findById(id);
    if (!existing) throw new NotFoundError('Comment');
    // Pull the project too so the event payload carries its type. If the
    // project was deleted concurrently (FK cascade race), fall through
    // with project=null — the strict check still passes via projectId.
    let project = null;
    try { project = projectsService.get(existing.project_id); } catch { /* gone */ }
    const removed = commentsRepository.remove(id);
    await registry.emit(
      'comment.after-delete',
      { id, project, projectId: existing.project_id, comment: existing },
      await buildCtx()
    );
    return removed;
  },
};
