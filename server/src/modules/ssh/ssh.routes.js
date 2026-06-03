import { Router } from 'express';
import { sshController } from './ssh.controller.js';
import { asyncHandler } from '../../middleware/errorHandler.js';

const router = Router();

router.post('/run',         asyncHandler(sshController.runAdhoc));  // ad-hoc, before /:id
router.get('/',             asyncHandler(sshController.list));
router.post('/',            asyncHandler(sshController.create));
router.get('/:id',          asyncHandler(sshController.getOne));
router.patch('/:id',        asyncHandler(sshController.update));
router.delete('/:id',       asyncHandler(sshController.remove));
router.post('/:id/run',     asyncHandler(sshController.run));

export default router;
