// Clones the project's repo. If the target directory already contains a
// git clone, the button is a no-op (reports "already cloned").
//
// `project.fields.gitClone` is the local target — either an absolute path
// or a name relative to the server's cwd (same resolution the clone tool
// uses internally).

import fs from 'node:fs';
import path from 'node:path';
import gitCloneTool from '../../../shared/git/clone.js';

export default {
  id: 'clone',
  label: 'Clone',
  destructive: true,
  // confirm: 'Are you sure to clone',
  async handler({ project }, ctx) {
    const gitClone = project?.fields?.gitClone;
    if (!gitClone) {
      throw new Error('No gitClone field set on this project');
    }

    // Resolve the same way gitCloneTool does so the existence check matches
    // what the tool would write to.
    const targetDir = path.resolve(process.cwd(), gitClone);

    if (fs.existsSync(targetDir)) {
      if (fs.existsSync(path.join(targetDir, '.git'))) {
        // Already a git clone — nothing to do. Return success rather than
        // throwing so the UI shows a friendly toast.
        return { message: `Already cloned at ${targetDir}` };
      }
      // The path exists but isn't a git repo. Refuse to overwrite.
      throw new Error(`Path already exists but is not a git repository: ${targetDir}`);
    }

    const res = await gitCloneTool.execute({
      cloneName: gitClone,
      gitUrl: 'https://github.com/lkonat/question_app.git',
    });

    return { message: `Cloned to ${res.targetDir}` };
  },
};