import { commentsService } from './comments.service.js';
import { userActor } from '../../access/actor.js';
import { parseId, pickFields } from '../../middleware/validate.js';

// Thin web adapter: req → actor, delegate to the service (which authorizes).
export const commentsController = {
  listForProject(req, res) {
    const projectId = parseId(req.params.id, 'project id');
    res.json({ data: commentsService.listForProject(userActor(req.user.id), projectId) });
  },

  async createForProject(req, res) {
    const projectId = parseId(req.params.id, 'project id');
    const body = pickFields(req.body, ['body', 'parentId']);
    res.status(201).json({ data: await commentsService.create(userActor(req.user.id), projectId, body) });
  },

  async remove(req, res) {
    const id = parseId(req.params.id);
    await commentsService.remove(userActor(req.user.id), id);
    res.status(204).end();
  },
};
