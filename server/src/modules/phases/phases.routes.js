import { Router } from 'express';
import { phasesController } from './phases.controller.js';
import { asyncHandler } from '../../middleware/errorHandler.js';

// Nested under projects: /api/projects/:id/phases
export const projectPhasesRouter = Router({ mergeParams: true });
projectPhasesRouter.get('/',         asyncHandler(phasesController.listForProject));
projectPhasesRouter.post('/',        asyncHandler(phasesController.createForProject));
projectPhasesRouter.post('/reorder', asyncHandler(phasesController.reorder));

// Direct phase ops: /api/phases/:phaseId
export const phasesRouter = Router();
phasesRouter.patch('/:phaseId',         asyncHandler(phasesController.update));
phasesRouter.delete('/:phaseId',        asyncHandler(phasesController.remove));
phasesRouter.post('/:phaseId/reopen',   asyncHandler(phasesController.reopen));
