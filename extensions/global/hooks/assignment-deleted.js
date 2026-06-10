// Global hook: an assignment was DELETED from a phase (removed entirely).
// Payload: { id, assignment, phase, projectId }. No `type:` filter → all projects.

export default {
  event: 'assignment.after-delete',
  async handler({ id, assignment, phase, projectId }, ctx) {
     console.log({assignment,phase})
    ctx.log.info(
      `[hook] assignment DELETED: #${id} "${assignment?.title ?? ''}" ` +
      `from phase "${phase?.name ?? '?'}" (project ${projectId})`
    );
  },
};
