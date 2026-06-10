// Creates a new GitHub repository for this project via the shared
// create-repo tool. Auth comes from the GITHUB_TOKEN environment variable
// (see server/.env.example); no token is passed here.
//
// Clicking the button opens a small form (the button's `inputs`) so the user
// can confirm/override the repo name, visibility, and description before it's
// created. On success the created repo's URLs are stashed in the project's
// free-form `meta` so a follow-up Clone can find them — and so this button can
// disable itself.

import gitCreateRepoTool from '../../../shared/git/create-repo.js';

export default {
  id: 'create-repo',
  label: 'Create GitHub repo',

  // Prompt for these before running. `default` functions are evaluated against
  // the project server-side, so the form opens pre-filled.
  inputs: [
    {
      key: 'name',
      label: 'Repository name',
      type: 'text',
      required: true,
      // Prefer the project's "Remote Clone Name" field, else its name.
      default: (project) =>
        (project.fields?.remoteGitClone || project.name || '')
          .trim()
          .replace(/\s+/g, '-'),
    },
    { key: 'private', label: 'Private repository', type: 'boolean', default: true },
    {
      key: 'description',
      label: 'Description',
      type: 'textarea',
      default: (project) => project.description || '',
    },
  ],

  // Once a repo has been created (recorded in meta), disable the button and
  // show which one — prevents accidental duplicates.
  disabled: (project) =>
    project.meta?.githubRepo?.fullName
      ? `Already created: ${project.meta.githubRepo.fullName}`
      : false,

  async handler({ project, input }, ctx) {
    // GitHub rejects spaces; collapse whitespace to hyphens.
    const name = String(input.name || '').trim().replace(/\s+/g, '-');
    if (!name) {
      throw new Error('Repository name is required');
    }

    // Token resolves from process.env.GITHUB_TOKEN inside the tool.
    const repo = await gitCreateRepoTool.execute({
      name,
      description: input.description?.trim() || undefined,
      private: input.private !== false, // default to private
      autoInit: false,
    });

    // Record it in free-form meta (not the type's field schema) so it persists
    // without needing a declared field. `targetDir` is the local git-inited
    // checkout the tool created under PROJECT_DIR.
    ctx.services.projects.updateMeta(project.id, {
      githubRepo: {
        fullName: repo.fullName,
        htmlUrl: repo.htmlUrl,
        cloneUrl: repo.cloneUrl,
        sshUrl: repo.sshUrl,
        localDir: repo.targetDir || null,
        createdAt: new Date().toISOString(),
      },
    });

    const where = repo.targetDir ? ` (local: ${repo.targetDir})` : '';
    return { message: `Created ${repo.fullName} — ${repo.htmlUrl}${where}` };
  },
};
