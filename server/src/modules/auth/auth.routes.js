import { Router } from 'express';
import { authController } from './auth.controller.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { requireAuth } from '../../middleware/auth.js';

// Mounted at /api/auth, BEFORE the global requireAuth gate, so register/login/
// logout are reachable while logged out. `/me` protects itself.
const router = Router();
router.post('/register', asyncHandler(authController.register));
router.post('/login', asyncHandler(authController.login));
router.post('/logout', asyncHandler(authController.logout));
router.get('/me', requireAuth, asyncHandler(authController.me));
router.patch('/me', requireAuth, asyncHandler(authController.updateMe));

export default router;
