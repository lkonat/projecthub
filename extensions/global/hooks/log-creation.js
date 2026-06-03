// Example after-create hook. Logs every new project to the server console.
// Runs after the transaction commits — errors here don't fail the request.

export default {
  event: 'project.after-create',
  // No `type:` filter means it runs for every project.
  async handler({ project }, ctx) {
    console.log({ project }, ctx)
    ctx.log.info(
      `[hook] project created: #${project.id} "${project.name}" ` +
      `(type=${project.type || 'none'}, priority=${project.priority})`
    );
  },
};
