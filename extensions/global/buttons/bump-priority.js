// Bumps a project up one priority step. No `type:` filter so it applies to all.

const LADDER = ['low', 'medium', 'high', 'critical'];

export default {
  id: 'bump-priority',
  label: 'Bump priority',
  async handler({ project }, ctx) {
    const idx = LADDER.indexOf(project.priority);
    if (idx < 0 || idx === LADDER.length - 1) {
      return { message: `Already at ${project.priority}.` };
    }
    const next = LADDER[idx + 1];
    await ctx.services.projects.update(project.id, { priority: next });
    return { message: `Bumped to ${next}.` };
  },
};
