// An ACTOR is the principal performing an operation. Authorization is about
// the actor, never the transport — so the web controller, a future CLI, and an
// in-process agent all build an actor and call the same service methods.
//
//   user    — a human (or service account) identified by a users.id
//   agent   — an automated principal; carries the id the policy reasons about
//             (must match assignee_user_id for `assignmentOwner` to resolve)
//   system  — trusted internal work (cascades, migrations, the framework).
//             Bypasses the policy entirely. NEVER build a system actor from
//             request input — it is the in-process trust lane only.

export const SYSTEM = Object.freeze({ type: 'system', id: null });

export function userActor(id) {
  return { type: 'user', id };
}

export function agentActor(id) {
  return { type: 'agent', id };
}

export function isSystem(actor) {
  return !!actor && actor.type === 'system';
}
