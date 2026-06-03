// Fires after a client-work project is created.
// (Type is inferred from this file's location under types/client-work/.)

export default {
  event: 'project.after-create',
  async handler({ project }, ctx) {
    // Service call → fires comment.after-create → broadcasts to viewers.
    await ctx.services.comments.create(project.id, {
      body: 'Kickoff: confirm scope, deadline, and billing terms with the client.',
    });
  },
};
