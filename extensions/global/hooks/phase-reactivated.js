// Global hook: a DONE phase is REACTIVATED via "go backward" (done -> active).
// This is deliberately distinct from phase.after-activate (the normal forward
// advance): reaching here means the owner reopened a completed phase to redo or
// amend work that was considered finished — often worth flagging differently
// (e.g. notify stakeholders that a closed phase was reopened).
//
// No `type:` filter → runs for every project.

export default {
  event: 'phase.after-reopen',
  async handler({ phase, projectId }, ctx) {
    console.log({phase},"reactivated phase");
    ctx.log.info(
      `[hook] phase REACTIVATED (reopened): #${phase.id} "${phase.name}" ` +
      `(project ${projectId}) — a completed phase was reopened`
    );
  },
};
