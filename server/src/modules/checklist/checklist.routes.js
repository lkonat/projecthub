import { Router } from 'express';
import { checklistController } from './checklist.controller.js';
import { asyncHandler } from '../../middleware/errorHandler.js';

// Nested under projects: /api/projects/:id/checklist
export const projectChecklistRouter = Router({ mergeParams: true });
projectChecklistRouter.get('/',         asyncHandler(checklistController.listForProject));
projectChecklistRouter.post('/',        asyncHandler(checklistController.createForProject));
projectChecklistRouter.post('/reorder', asyncHandler(checklistController.reorder));

// Direct item ops: /api/checklist/:itemId
export const checklistRouter = Router();
checklistRouter.patch('/:itemId',  asyncHandler(checklistController.update));
checklistRouter.delete('/:itemId', asyncHandler(checklistController.remove));
