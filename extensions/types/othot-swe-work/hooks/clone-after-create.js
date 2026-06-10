// Fires after an othot-swe-work project is created.
// (Type is inferred from this file's location under types/othot-swe-work/.)
//
// `settings` (3rd arg) is this type's settings object — injected by the
// registry when types/othot-swe-work/settings/ is defined, and `undefined`
// otherwise. We read from it only if present.

import fs from 'node:fs';
import path from 'node:path';
import gitCloneTool from '../../../shared/git/clone.js';

export default {
  event: 'project.after-create',
  async handler({ project }, ctx, settings) {
    const gitClone = project?.fields?.gitClone;
    if (!gitClone) {
      throw new Error('No gitClone field set on this project');
    }

    // Resolve the same way gitCloneTool does so the existence check matches
    // what the tool would write to.
    const baseDir = settings?.cloneBaseDir || process.cwd();
    const targetDir = path.resolve(baseDir, gitClone);

    if (fs.existsSync(targetDir)) {
      if (fs.existsSync(path.join(targetDir, '.git'))) {
        // Already a git clone — nothing to do. Return success rather than
        // throwing so the UI shows a friendly toast.
        return { message: `Already cloned at ${targetDir}` };
      }
      // The path exists but isn't a git repo. Refuse to overwrite.
      throw new Error(`Path already exists but is not a git repository: ${targetDir}`);
    }

    // Prefer the project's own repo URL; fall back to the type's settings
    // default (GIT_URL in the type .env), if settings are defined.
    const gitUrl = project?.fields?.gitRepoUrl || settings?.gitUrl;
    if (!gitUrl) {
      throw new Error(
        'No git URL: set the project\'s "gitRepoUrl" field or GIT_URL in the type .env',
      );
    }

    const res = await gitCloneTool.execute({
      cloneName: gitClone,
      gitUrl,
      ...(settings?.cloneBaseDir ? { baseDir: settings.cloneBaseDir } : {}),
    });

    return { message: `Cloned to ${res.targetDir}` };
  },
};
