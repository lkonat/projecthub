// Service registry exposed to hooks and buttons via `ctx.services`.
//
// Lazy-imported by callers (`await import('../../services.js')`) so that
// modules participating in the cycle (e.g. projects.service ↔ comments.service)
// finish evaluating before this barrel resolves them.

import { projectsService } from './modules/projects/projects.service.js';
import { commentsService } from './modules/comments/comments.service.js';

export const services = {
  projects: projectsService,
  comments: commentsService,
};
