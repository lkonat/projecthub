import { Router } from 'express';
import { commentsController } from './comments.controller.js';
import { asyncHandler } from '../../middleware/errorHandler.js';

// Nested under projects: /api/projects/:id/comments
export const projectCommentsRouter = Router({ mergeParams: true });
projectCommentsRouter.get('/',  asyncHandler(commentsController.listForProject));
projectCommentsRouter.post('/', asyncHandler(commentsController.createForProject));

// Direct: /api/comments/:id
export const commentsRouter = Router();
commentsRouter.delete('/:id', asyncHandler(commentsController.remove));
