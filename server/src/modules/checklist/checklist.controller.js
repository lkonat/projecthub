import { checklistService } from './checklist.service.js';
import { userActor } from '../../access/actor.js';
import { parseId, pickFields } from '../../middleware/validate.js';

// Thin web adapter: req → actor, delegate to the service (which authorizes).
export const checklistController = {
  listForProject(req, res) {
    const projectId = parseId(req.params.id, 'project id');
    res.json({ data: checklistService.listForProject(userActor(req.user.id), projectId) });
  },

  async createForProject(req, res) {
    const projectId = parseId(req.params.id, 'project id');
    const body = pickFields(req.body, ['text']);
    res.status(201).json({ data: await checklistService.create(userActor(req.user.id), projectId, body) });
  },

  async update(req, res) {
    const itemId = parseId(req.params.itemId, 'item id');
    const patch = pickFields(req.body, ['text', 'done']);
    res.json({ data: await checklistService.update(userActor(req.user.id), itemId, patch) });
  },

  async remove(req, res) {
    const itemId = parseId(req.params.itemId, 'item id');
    await checklistService.remove(userActor(req.user.id), itemId);
    res.status(204).end();
  },

  async reorder(req, res) {
    const projectId = parseId(req.params.id, 'project id');
    const { orderedIds } = pickFields(req.body, ['orderedIds']);
    res.json({ data: await checklistService.reorder(userActor(req.user.id), projectId, orderedIds) });
  },
};
