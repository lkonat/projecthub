// Library button: clone the project's git repo into a local directory.
// Type-agnostic — reference it from a type's `buttons: [...]`.
//
// Uses the project's own fields (no per-type settings):
//   - fields.gitRepoUrl — the repo URL to clone
//   - fields.gitClone   — the local target dir name
// Clones under PROJECT_DIR (or the server cwd if unset). Filesystem checks go
// through the shared file-system tools rather than node:fs.

import path from 'node:path';
import gitCloneTool from '../git/clone.js';
import fsStat from '../file-system/stat.js';

export default {
  id: 'clone',
  label: 'Clone',
  destructive: true,
  // Disable until both the repo URL and a local target name are set.
  disabled: (project) =>
    (!project.fields?.gitRepoUrl || !project.fields?.gitClone)
      ? 'Set gitRepoUrl and gitClone fields first'
      : false,

  async handler({ project }, ctx) {
    const gitClone = project?.fields?.gitClone;
    const gitUrl = project?.fields?.gitRepoUrl;
    if (!gitClone) throw new Error('No gitClone field set on this project');
    if (!gitUrl) throw new Error('No gitRepoUrl field set on this project');

    const baseDir = process.env.PROJECT_DIR || process.cwd();
    const targetDir = path.resolve(baseDir, gitClone);

    const dir = await fsStat.execute({ path: targetDir });
    if (dir.exists) {
      const dotGit = await fsStat.execute({ path: path.join(targetDir, '.git') });
      if (dotGit.exists) {
        return { message: `Already cloned at ${targetDir}` };
      }
      throw new Error(`Path already exists but is not a git repository: ${targetDir}`);
    }

    const res = await gitCloneTool.execute({ cloneName: gitClone, gitUrl, baseDir });
    return { message: `Cloned to ${res.targetDir}` };
  },
};
