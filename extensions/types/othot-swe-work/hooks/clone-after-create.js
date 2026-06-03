// Fires after an othot-swe-work project is created.
// (Type is inferred from this file's location under types/othot-swe-work/.)
//
// Currently writes a kickoff comment; cloning the repo lives in the
// `clone` button so the user controls when it happens.

import fs from 'node:fs';
import path from 'node:path';
import gitCloneTool from '../../../shared/git/clone.js';
export default {
  event: 'project.after-create',
  async handler({ project }, ctx) {
    // Service call → fires comment.after-create → broadcasts to viewers.
    // await ctx.services.comments.create(project.id, {
    //   body: 'Kickoff: set up the repo via the Clone button when ready.',
    // });
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
