// Destructive action — UI styles this red and shows a confirmation prompt.

export default {
  id: 'archive',
  label: 'Archive',
  confirm: 'Archive this project? It will be hidden from default views.',
  destructive: true,
  // Already archived? Show the button but disable it, with a reason.
  disabled: (project) => project.status === 'archived' && 'Already archived',
  async handler({ project }, ctx) {
    await ctx.services.projects.update(project.id, { status: 'archived' });
    return { message: 'Archived.' };
  },
};
