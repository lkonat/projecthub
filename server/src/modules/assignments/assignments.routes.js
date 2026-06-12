import { Router } from 'express';
import { assignmentsController } from './assignments.controller.js';
import { asyncHandler } from '../../middleware/errorHandler.js';

// Nested under phases: /api/phases/:phaseId/assignments
export const phaseAssignmentsRouter = Router({ mergeParams: true });
phaseAssignmentsRouter.get('/',  asyncHandler(assignmentsController.listForPhase));
phaseAssignmentsRouter.post('/', asyncHandler(assignmentsController.createForPhase));

// Direct assignment ops: /api/assignments/:assignmentId
export const assignmentsRouter = Router();
assignmentsRouter.patch('/:assignmentId',     asyncHandler(assignmentsController.update));
assignmentsRouter.delete('/:assignmentId',    asyncHandler(assignmentsController.remove));
assignmentsRouter.post('/:assignmentId/run',  asyncHandler(assignmentsController.run));
