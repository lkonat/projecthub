import { phasesService } from './phases.service.js';
import { userActor } from '../../access/actor.js';
import { parseId, pickFields } from '../../middleware/validate.js';

// Thin web adapter: req → actor, delegate to the service (which authorizes).
export const phasesController = {
  listForProject(req, res) {
    const projectId = parseId(req.params.id, 'project id');
    const actor = userActor(req.user.id);
    res.json({
      data: phasesService.listForProject(actor, projectId), // authorizes phase.view
      current: phasesService.currentForProject(projectId),
    });
  },

  async createForProject(req, res) {
    const projectId = parseId(req.params.id, 'project id');
    const body = pickFields(req.body, ['name', 'description']);
    res.status(201).json({ data: await phasesService.create(userActor(req.user.id), projectId, body) });
  },

  async update(req, res) {
    const phaseId = parseId(req.params.phaseId, 'phase id');
    const patch = pickFields(req.body, ['name', 'description']);
    res.json({ data: await phasesService.update(userActor(req.user.id), phaseId, patch) });
  },

  async remove(req, res) {
    const phaseId = parseId(req.params.phaseId, 'phase id');
    await phasesService.remove(userActor(req.user.id), phaseId);
    res.status(204).end();
  },

  // Go backward: reopen a passed phase (owner only).
  async reopen(req, res) {
    const phaseId = parseId(req.params.phaseId, 'phase id');
    res.json({ data: await phasesService.reopen(userActor(req.user.id), phaseId) });
  },

  async reorder(req, res) {
    const projectId = parseId(req.params.id, 'project id');
    const { orderedIds } = pickFields(req.body, ['orderedIds']);
    res.json({ data: await phasesService.reorder(userActor(req.user.id), projectId, orderedIds) });
  },
};
