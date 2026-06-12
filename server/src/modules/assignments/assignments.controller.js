import { assignmentsService } from './assignments.service.js';
import { userActor } from '../../access/actor.js';
import { parseId, pickFields } from '../../middleware/validate.js';

const CREATE_FIELDS = ['title', 'description', 'assignee_type', 'assignee_label', 'assignee_user_id', 'assignee_agent_id'];
const UPDATE_FIELDS = [...CREATE_FIELDS, 'status', 'cancel_reason'];

// Thin web adapter: req → actor, delegate to the service (which authorizes).
export const assignmentsController = {
  // GET /api/me/assignments?scope=current|all — the actor's assignments across
  // every project (read-only; scoped to the actor, so no per-project authz).
  listMine(req, res) {
    const current = req.query.scope === 'current';
    res.json({ data: assignmentsService.listForUser(userActor(req.user.id), { current }) });
  },

  listForPhase(req, res) {
    const phaseId = parseId(req.params.phaseId, 'phase id');
    res.json({ data: assignmentsService.listForPhase(userActor(req.user.id), phaseId) });
  },

  async createForPhase(req, res) {
    const phaseId = parseId(req.params.phaseId, 'phase id');
    const body = pickFields(req.body, CREATE_FIELDS);
    res.status(201).json({ data: await assignmentsService.create(userActor(req.user.id), phaseId, body) });
  },

  async update(req, res) {
    const assignmentId = parseId(req.params.assignmentId, 'assignment id');
    const patch = pickFields(req.body, UPDATE_FIELDS);
    res.json({ data: await assignmentsService.update(userActor(req.user.id), assignmentId, patch) });
  },

  async remove(req, res) {
    const assignmentId = parseId(req.params.assignmentId, 'assignment id');
    await assignmentsService.remove(userActor(req.user.id), assignmentId);
    res.status(204).end();
  },

  // POST /api/assignments/:assignmentId/run — enqueue an agent run. Returns the
  // queued job. Optional body { priority } overrides the project-derived default.
  run(req, res) {
    const assignmentId = parseId(req.params.assignmentId, 'assignment id');
    const priority = Number.isInteger(req.body?.priority) ? req.body.priority : undefined;
    const job = assignmentsService.requestRun(userActor(req.user.id), assignmentId, { priority });
    console.log(job,"assignment run")
    res.status(202).json({ data: job });
  },
};
