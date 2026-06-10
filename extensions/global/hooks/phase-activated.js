// Global hook: a phase BECOMES ACTIVE through forward progress (idle -> active)
// — the first phase of a project, or the next idle phase promoted when the
// active one completes. This is the normal advance; reactivation of a *done*
// phase fires phase.after-reopen instead (see phase-reactivated.js).
//
// No `type:` filter → runs for every project. Replace the body with whatever
// should happen when work starts on a phase (notify the assignees, start a
// timer, kick off CI, etc.).

export default {
  event: 'phase.after-activate',
  async handler({ phase, projectId }, ctx) {
        console.log({phase},"activated phase");
    ctx.log.info(
      `[hook] phase ACTIVATED: #${phase.id} "${phase.name}" ` +
      `(project ${projectId}) — work can now begin`
    );
  },
};
