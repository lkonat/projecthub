// Access service — the Policy Decision Point. Services (the universal API) call
// it; controllers/CLI/agents are just enforcement points that build an actor.
//
// EFFICIENCY: the only database touch in a decision is the relationship lookup
// `isAssignee(actor, project)`. We memoize it per (actor, project) for the life
// of the actor — and an actor is built once per request — so however many rows
// or actions a request checks, that lookup runs AT MOST ONCE per project. This
// is the Zanzibar insight (relationship checks dominate; cache them). Everything
// else in a decision is an in-memory array intersection.

import { projectsRepository } from '../modules/projects/projects.repository.js';
import { can, CLIENT_CAPABILITIES } from './policy.js';
import { isSystem } from './actor.js';
import { NotFoundError, ForbiddenError } from '../utils/errors.js';

// Per-actor-instance cache of PROJECT-level roles, keyed by the actor object.
// A WeakMap means the cache lives exactly as long as the request's actor and is
// garbage-collected with it — no manual cleanup, no cross-request leakage.
const projectRoleCache = new WeakMap(); // actor -> Map<projectId, string[]>

// Project-level roles (owner / assignee). The cached part — the single
// `isAssignee` query happens here, once per (actor, project).
function projectRoles(actor, project) {
  let perProject = projectRoleCache.get(actor);
  if (!perProject) { perProject = new Map(); projectRoleCache.set(actor, perProject); }

  let roles = perProject.get(project.id);
  if (roles === undefined) {
    roles = [];
    if (project.user_id === actor.id) roles.push('owner');
    // Owner already outranks assignee for every current rule, so skip the query.
    else if (projectsRepository.isAssignee(actor.id, project.id)) roles.push('assignee');
    perProject.set(project.id, roles);
  }
  return roles;
}

// Full role set for one decision: cached project roles + cheap, in-memory
// item-ownership roles derived straight from the row already in hand.
function computeRoles(actor, project, extra) {
  const base = projectRoles(actor, project);
  const item = [];
  if (extra.assignment && extra.assignment.assignee_user_id === actor.id) item.push('assignmentOwner');
  if (extra.comment && extra.comment.user_id === actor.id) item.push('commentOwner');
  return item.length ? base.concat(item) : base;
}

// The decision context handed to the policy: the actor's roles plus the actual
// entities, so predicate rules (e.g. "phase not done") can read resource state.
function contextFor(actor, project, extra) {
  return { roles: computeRoles(actor, project, extra), actor, project, ...extra };
}

export const access = {
  // Enforce: authorize an actor for an action on a project, returning the project.
  // SYSTEM bypasses. NotFound if missing or not even viewable (don't leak it);
  // Forbidden if viewable but the action isn't allowed. Pass a preloaded
  // `project` to skip the refetch when the caller already has it; pass the
  // relevant item (assignment/comment/phase) in `extra` so conditional rules
  // and item-ownership roles resolve.
  authorize(actor, projectId, action, extra = {}, project = null) {
    const proj = project || projectsRepository.findById(projectId);
    if (!proj) throw new NotFoundError('Project');
    if (isSystem(actor)) return proj;

    const ctx = contextFor(actor, proj, extra);
    if (can(action, ctx)) return proj;
    if (!can('project.view', ctx)) throw new NotFoundError('Project');
    throw new ForbiddenError(`You do not have permission to ${action} on this project`);
  },

  // Decide (no throw) for an already-loaded project — for per-row capability
  // booleans and capability maps. No project fetch; project roles come from the
  // cache. Pass the item in `extra` for conditional/item-level rules.
  allows(actor, project, action, extra = {}) {
    if (isSystem(actor)) return true;
    return can(action, contextFor(actor, project, extra));
  },

  // Project-level capability map for the client UI (project-scoped affordances).
  capabilitiesFor(actor, project) {
    const caps = {};
    for (const a of CLIENT_CAPABILITIES) caps[a] = this.allows(actor, project, a);
    return caps;
  },
};
