import { Router } from 'express';
import { projectsController } from './projects.controller.js';
import { actionsController } from './actions.controller.js';
import { asyncHandler } from '../../middleware/errorHandler.js';

const router = Router();

router.get('/meta',                    asyncHandler(projectsController.meta));      // static enums + types + buttons
router.get('/',                        asyncHandler(projectsController.list));
router.post('/',                       asyncHandler(projectsController.create));
router.get('/:id',                     asyncHandler(projectsController.getOne));
router.patch('/:id',                   asyncHandler(projectsController.update));
router.delete('/:id',                  asyncHandler(projectsController.remove));
router.get('/:id/meta',                asyncHandler(projectsController.getMeta));      // per-project live + stored meta
router.get('/:id/git/status',          asyncHandler(projectsController.getGitStatus));  // live git status
router.get('/:id/git/diff',            asyncHandler(projectsController.getGitDiff));    // unified diff for one file
router.post('/:id/git/revert',         asyncHandler(projectsController.revertGitHunk)); // discard one hunk
router.get('/:id/actions',             asyncHandler(actionsController.list));            // buttons resolved for this project
router.post('/:id/actions/:buttonId',  asyncHandler(actionsController.run));

export default router;
