// Global hook: an assignment was ADDED to a phase.
// Payload: { assignment, phase, projectId }. No `type:` filter → all projects.

export default {
  event: 'assignment.after-create',
  async handler({ assignment, phase, projectId }, ctx) {
    console.log({assignment,phase})
    ctx.log.info(
      `[hook] assignment ADDED: #${assignment.id} "${assignment.title}" ` +
      `to phase "${phase.name}" (project ${projectId}), ` +
      `assignee=${assignment.assignee_label || assignment.assignee_user_id || assignment.assignee_type}`
    );
  },
};
