import { Router } from 'express';
import authRouter from '../modules/auth/auth.routes.js';
import projectsRouter from '../modules/projects/projects.routes.js';
import { projectCommentsRouter, commentsRouter } from '../modules/comments/comments.routes.js';
import { projectChecklistRouter, checklistRouter } from '../modules/checklist/checklist.routes.js';
import { authController } from '../modules/auth/auth.controller.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { projectPhasesRouter, phasesRouter } from '../modules/phases/phases.routes.js';
import { phaseAssignmentsRouter, assignmentsRouter } from '../modules/assignments/assignments.routes.js';
import { assignmentsController } from '../modules/assignments/assignments.controller.js';
import { policyMatrix, ROLES } from '../access/policy.js';
import { requireAuth } from '../middleware/auth.js';

// Central API router. Mount new modules here as the system grows.
const api = Router();

// ---- public ----
api.get('/health', (req, res) => res.json({ ok: true }));
api.use('/auth', authRouter); // register/login/logout are public; /me self-guards

// ---- everything below requires a valid session ----
api.use(requireAuth);

api.get('/users', asyncHandler(authController.listUsers)); // account directory for assignee pickers
api.get('/me/assignments', asyncHandler(assignmentsController.listMine)); // my tasks across all projects
// Self-documenting access matrix: action -> roles allowed. Single source of
// truth lives in src/access/policy.js; this just exposes it.
api.get('/policy', (req, res) => res.json({ data: { roles: ROLES, policy: policyMatrix() } }));
api.use('/projects', projectsRouter);
api.use('/projects/:id/comments', projectCommentsRouter);
api.use('/projects/:id/checklist', projectChecklistRouter);
api.use('/projects/:id/phases', projectPhasesRouter);
api.use('/phases/:phaseId/assignments', phaseAssignmentsRouter);
api.use('/comments', commentsRouter);
api.use('/checklist', checklistRouter);
api.use('/phases', phasesRouter);
api.use('/assignments', assignmentsRouter);

export default api;
