// Global hook: an assignment was CANCELLED (status -> cancelled, with a reason).
// Distinct from deletion (the row is kept as a record) and from a generic
// update. Payload: { assignment, phase, projectId }; assignment.cancel_reason
// holds why it was dropped. No `type:` filter → all projects.

export default {
  event: 'assignment.after-cancel',
  async handler({ assignment, phase, projectId }, ctx) {
     console.log({assignment,phase})
    ctx.log.info(
      `[hook] assignment CANCELLED: #${assignment.id} "${assignment.title}" ` +
      `in phase "${phase.name}" (project ${projectId}) — ` +
      `reason: ${assignment.cancel_reason || '(none)'}`
    );
  },
};
