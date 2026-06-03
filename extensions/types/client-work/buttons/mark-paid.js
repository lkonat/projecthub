// Button shown on client-work projects.
// (Type is inferred from this file's location under types/client-work/.)

export default {
  id: 'mark-paid',
  label: 'Mark paid',
  confirm: 'Mark this project as paid and close it out?',
  async handler({ project }, ctx) {
    await ctx.services.projects.update(project.id, { status: 'completed' });
    await ctx.services.comments.create(project.id, { body: 'Marked paid — engagement closed.' });
    return { message: `"${project.name}" marked paid.` };
  },
};
