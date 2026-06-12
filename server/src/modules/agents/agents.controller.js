import { agentsService } from './agents.service.js';
import { parseId } from '../../middleware/validate.js';

// Thin web adapter for the agent directory. Read-only: agents are registered
// from code at boot, not created over the API.
export const agentsController = {
  // GET /api/agents — assignable agents by default (the picker list); pass
  // ?scope=all to include disabled/missing ones (e.g. an admin view).
  list(req, res) {
    const all = req.query.scope === 'all';
    res.json({ data: all ? agentsService.list() : agentsService.listAssignable() });
  },

  // GET /api/agents/:id
  get(req, res) {
    const id = parseId(req.params.id, 'agent id');
    res.json({ data: agentsService.get(id) });
  },
};
