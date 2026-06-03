import { Router } from 'express';
import projectsRouter from '../modules/projects/projects.routes.js';
import { projectCommentsRouter, commentsRouter } from '../modules/comments/comments.routes.js';
import sshRouter from '../modules/ssh/ssh.routes.js';

// Central API router. Mount new modules here as the system grows.
const api = Router();

api.get('/health', (req, res) => res.json({ ok: true }));

api.use('/projects', projectsRouter);
api.use('/projects/:id/comments', projectCommentsRouter);
api.use('/comments', commentsRouter);
api.use('/ssh', sshRouter);

export default api;
