// Runs `git status` against the project's cloned repo and posts a summary
// as a comment. Requires the Clone button to have run first (it sets
// fields.gitClone).
//
// Going through ctx.services.comments.create means the realtime bridge
// broadcasts the new comment to all viewers automatically.

import gitStatusTool from '../../../shared/git/status.js';

const MAX_FILES_IN_COMMENT = 20;

export default {
  id: 'git-status',
  label: 'Status',
  async handler({ project }, ctx) {
    const gitClone = project?.fields?.gitClone;
    if (!gitClone) {
      throw new Error("No gitClone on this project — click Clone first.");
    }

    const res = await gitStatusTool.execute({ cwd: gitClone });

    const headline = res.clean
      ? `${res.branch}: clean working tree`
      : `${res.branch}: ${res.staged.length} staged, ` +
        `${res.unstaged.length} unstaged, ${res.untracked.length} untracked`;

    const trackingLine =
      res.upstream
        ? `tracking ${res.upstream}` +
          (res.ahead || res.behind
            ? ` (ahead ${res.ahead}, behind ${res.behind})`
            : '')
        : 'no upstream';

    let body = `git status — ${headline}\n${trackingLine}`;

    if (!res.clean) {
      const shown = res.files.slice(0, MAX_FILES_IN_COMMENT);
      const lines = shown.map((f) => {
        const code = `${f.x}${f.y}`.replace(/ /g, '·');
        const rename = f.renamedTo ? ` -> ${f.renamedTo}` : '';
        const desc = f.description ? ` (${f.description})` : '';
        return `  ${code}  ${f.path}${rename}${desc}`;
      });
      body += `\n\n${lines.join('\n')}`;
      if (res.files.length > shown.length) {
        body += `\n  …and ${res.files.length - shown.length} more`;
      }
    }

    await ctx.services.comments.create(project.id, { body });

    return { message: headline };
  },
};
