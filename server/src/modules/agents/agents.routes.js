import { Router } from 'express';
import { agentsController } from './agents.controller.js';
import { asyncHandler } from '../../middleware/errorHandler.js';

// Agent directory: /api/agents
export const agentsRouter = Router();
agentsRouter.get('/',    asyncHandler(agentsController.list));
agentsRouter.get('/:id', asyncHandler(agentsController.get));
