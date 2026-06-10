// Service registry exposed to hooks and buttons via `ctx.services`, and used by
// the realtime layer. Everything reached through here runs server-side as
// trusted code, so the facade binds the SYSTEM actor onto the actor-first
// service methods: extensions keep calling `ctx.services.projects.updateMeta(id, {...})`
// (no actor) and it executes in the trusted lane, bypassing the policy.
//
// Principal-initiated calls (web/CLI/agent) do NOT come through here — they go
// through the controllers/entry points, which build a real actor.
//
// Lazy-imported by callers (`await import('../../services.js')`) so that modules
// participating in the cycle (e.g. projects.service ↔ comments.service) finish
// evaluating before this barrel resolves them.

import { projectsService } from './modules/projects/projects.service.js';
import { commentsService } from './modules/comments/comments.service.js';
import { checklistService } from './modules/checklist/checklist.service.js';
import { SYSTEM } from './access/actor.js';

// Wrap a service so the named methods get SYSTEM injected as their first (actor)
// argument; all other methods (e.g. the actor-less `get`) and constants pass
// through unchanged. `this` is preserved so internal `this.update(...)` calls work.
function systemBound(service, actorMethods) {
  const out = {};
  for (const key of Object.keys(service)) {
    const val = service[key];
    if (typeof val !== 'function') { out[key] = val; continue; }
    out[key] = actorMethods.includes(key)
      ? (...args) => val.call(service, SYSTEM, ...args)
      : (...args) => val.call(service, ...args);
  }
  return out;
}

export const services = {
  projects: systemBound(projectsService, ['list', 'view', 'create', 'update', 'remove', 'updateFields', 'updateMeta']),
  comments: systemBound(commentsService, ['listForProject', 'create', 'remove']),
  checklist: systemBound(checklistService, ['listForProject', 'create', 'update', 'remove', 'reorder']),
};
