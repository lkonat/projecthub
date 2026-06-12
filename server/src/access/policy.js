// ─────────────────────────────────────────────────────────────────────────
// Authorization policy — the SINGLE SOURCE OF TRUTH for "who can do what".
//
// Every project-scoped action a user can attempt is listed here, mapped to the
// set of ROLES that are allowed to perform it. The check is OR semantics: a
// user may perform an action if they hold ANY of the listed roles.
//
// Roles are DERIVED per request (see access.service.js → buildRoles), never
// stored:
//   owner            — the user owns the project
//   assignee         — the user has at least one assignment in the project
//   assignmentOwner  — the user is the assignee of the specific assignment in play
//   commentOwner     — the user authored the specific comment in play
//
// To change access rules, edit ONE line in POLICY below — nothing else.
// To add a capability, add a row and reference its action from a SERVICE method
// via access.authorize(actor, projectId, '<action>'). Services (not controllers)
// authorize, because the service layer is the universal API for web/CLI/agents.
//
// This table is plain data (no functions), so it is serialized verbatim at
// GET /api/policy for documentation/tooling, and drives the per-project
// capability flags the client uses to show/hide affordances.
// ─────────────────────────────────────────────────────────────────────────

export const ROLES = ['owner', 'assignee', 'assignmentOwner', 'commentOwner'];

// Small predicates shared by the conditional rules below. They read resource
// state from the decision context — `ctx.phase` for phase rules, `ctx.project`
// for the project-active rule (always present) — so any caller authorizing a
// phase-scoped action MUST pass the phase in `extra`.
const isOwner       = (ctx) => ctx.roles.includes('owner');
// A phase has three states: idle (planned, not started), active (the current
// one being worked), done (completed/frozen). "Editable" means not-done — its
// structure and assignment roster can still change. "Active" is the stricter
// state where assignment WORK (resolve/cancel/reopen/edit) is allowed.
const phaseEditable = (ctx) => !!ctx.phase && ctx.phase.status !== 'done';   // idle or active
const phaseActive   = (ctx) => !!ctx.phase && ctx.phase.status === 'active'; // the current phase
const phasePassed   = (ctx) => !!ctx.phase && ctx.phase.status === 'done';   // completed/frozen
const projectActive = (ctx) => !!ctx.project && ctx.project.status === 'active';

export const POLICY = {
  // Project. Ownership (project.edit) governs the lifecycle transitions
  // (complete / cancel / reactivate) and stays available whatever the status —
  // otherwise you could never reactivate a closed project. CONTENT edits
  // (name/description/priority/type/fields/meta) and all sub-resource editing
  // (phases, assignments, checklist) are additionally frozen once the project
  // is not active: it's a closed record. Reactivate it first to make changes.
  // Comments stay open regardless, so a done/cancelled project can still get a
  // closing or post-mortem note.
  'project.view':         ['owner', 'assignee'],
  'project.edit':         ['owner'],                                  // owner signal + lifecycle transitions
  'project.edit-content': (ctx) => isOwner(ctx) && projectActive(ctx), // editable only while active
  'project.delete':       ['owner'],

  // Git (read = view repo status/diffs; write = revert hunks)
  'git.read':          ['owner', 'assignee'],
  'git.write':         ['owner'],

  // Custom action buttons
  'action.view':       ['owner', 'assignee'],
  'action.run':        ['owner'],

  // Phases. A phase's CONTENT (its details and its assignments) is editable only
  // while the phase is OPEN — the active phase or one still ahead. Once a phase
  // is done it is "passed" and frozen: nobody (not even the owner) may edit its
  // details or add/change/remove its assignments. The owner's one move on a
  // passed phase is to reopen it ("go backward"), which makes it the active phase
  // again. The content rules below need `ctx.phase`; callers must supply it.
  // Editing is gated on the project being active (a closed project is frozen)
  // AND the phase being editable, i.e. not done. A done phase is frozen
  // entirely. phase.reopen — the "resume" action — is the exception: it acts on
  // a done phase and itself reactivates the project, so it is NOT gated on
  // project-active.
  'phase.view':        ['owner', 'assignee'],
  'phase.manage':      (ctx) => isOwner(ctx) && projectActive(ctx),                       // create / reorder
  'phase.edit':        (ctx) => isOwner(ctx) && projectActive(ctx) && phaseEditable(ctx), // rename / re-describe
  'phase.delete':      (ctx) => isOwner(ctx) && projectActive(ctx) && phaseEditable(ctx), // delete a non-done phase
  'phase.reopen':      (ctx) => isOwner(ctx) && phasePassed(ctx),                         // go backward / resume

  // Assignments. Two different gates by phase state:
  //   - create / delete: allowed on an idle OR active phase (you can build out a
  //     planned phase's roster), but never on a done one.
  //   - update (resolve / cancel / reopen / edit): WORK on assignments, allowed
  //     only on the ACTIVE phase. An idle phase isn't being worked yet, and a
  //     done phase is frozen.
  // All of the above also require the project to be active.
  'assignment.view':   ['owner', 'assignee'],
  'assignment.create': (ctx) => isOwner(ctx) && projectActive(ctx) && phaseEditable(ctx),
  'assignment.delete': (ctx) => isOwner(ctx) && projectActive(ctx) && phaseEditable(ctx),
  // Resolving — marking your OWN work done — is reserved to the assignee. Not the
  // owner, not other assignees: only the user the assignment is assigned to
  // (`assignmentOwner`). Requires the active phase and an active project, like
  // any assignment work.
  'assignment.resolve': (ctx) =>
    projectActive(ctx) && phaseActive(ctx) && ctx.roles.includes('assignmentOwner'),
  // Every OTHER change (cancel, reopen, edit, reassign): owner may do any in the
  // active phase; a non-owner assignee may do their OWN. `ctx.phase` required.
  'assignment.update': (ctx) =>
    projectActive(ctx) && phaseActive(ctx) && (isOwner(ctx) || ctx.roles.includes('assignmentOwner')),
  // Running the assigned agent (enqueue an agent-run job). Owner-only, and only
  // while the assignment's phase is ACTIVE — you run the work that's current, not
  // an idle (not-started) or done (frozen) phase. `ctx.phase` required.
  'assignment.run': (ctx) => isOwner(ctx) && projectActive(ctx) && phaseActive(ctx),

  // Comments — anyone assigned to the project may comment; authors (or the
  // owner) may delete.
  'comment.view':      ['owner', 'assignee'],
  'comment.create':    ['owner', 'assignee'],
  'comment.delete':    ['commentOwner','owner'],

  // Checklist (owner-managed; visible to assignees). Frozen on a closed project.
  'checklist.view':    ['owner', 'assignee'],
  'checklist.manage':  (ctx) => isOwner(ctx) && projectActive(ctx),
};

// Project-level capabilities surfaced to the client so the UI can show/hide
// affordances from the same source of truth. Actions that depend on a specific
// resource's state are omitted here and computed per-resource instead:
//   - per-row item ownership (assignment.update, comment.delete) — client-side
//     from the row's own fields;
//   - per-phase state (phase.edit, phase.reopen, assignment.create) — returned
//     as `canEdit` / `canReopen` / `canAddAssignment` on each phase by the
//     phases list endpoint, since they hinge on whether that phase is passed.
export const CLIENT_CAPABILITIES = [
  'project.edit',          // owner signal (lifecycle buttons, delete) — any status
  'project.edit-content',  // content editable? false on a closed project → read-only UI
  'phase.manage',
  'checklist.manage',
  'comment.create',
  'action.run',
  'git.write',
];

// Decide whether `ctx` may perform `action`. A policy entry is EITHER:
//   - a role list (the common case): allowed iff the actor holds one of them,
//     i.e. the list intersects `ctx.roles` (an array like ['owner','commentOwner']); OR
//   - a predicate `(ctx) => boolean` (the escape hatch for conditional rules
//     that depend on resource state, e.g. phase status), given the full context
//     `{ roles, actor, project, assignment?, phase?, comment? }`.
// Throws on an unknown action so typos fail loudly rather than silently denying.
export function can(action, ctx) {
  const rule = POLICY[action];
  if (!rule) throw new Error(`Unknown policy action: '${action}'`);
  if (typeof rule === 'function') return rule(ctx) === true;
  return rule.some((role) => ctx.roles.includes(role));
}

// Serializable view of the policy for GET /api/policy: role lists pass through;
// predicate rules are opaque, shown as 'conditional' (the server evaluates them).
export function policyMatrix() {
  const out = {};
  for (const [action, rule] of Object.entries(POLICY)) {
    out[action] = typeof rule === 'function' ? 'conditional' : rule;
  }
  return out;
}
