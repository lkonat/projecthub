import { commentsService } from './comments.service.js';
import { parseId, pickFields } from '../../middleware/validate.js';

export const commentsController = {
  listForProject(req, res) {
    const projectId = parseId(req.params.id, 'project id');
    res.json({ data: commentsService.listForProject(projectId) });
  },

  async createForProject(req, res) {
    const projectId = parseId(req.params.id, 'project id');
    const body = pickFields(req.body, ['body']);
    res.status(201).json({ data: await commentsService.create(projectId, body) });
  },

  async remove(req, res) {
    const id = parseId(req.params.id);
    await commentsService.remove(id);
    res.status(204).end();
  },
};
