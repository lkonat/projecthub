// Start watching the project's local repo as soon as the first client
// opens its page. Pairs with track-repo-on-deactivate.js.
//
// Lives under `global/` so it runs for any project type that happens to
// have a `gitClone` field set — projects without one are silently skipped.

import path from 'node:path';
import { projectDirTracker } from '../../../server/src/tracker/projectDirTracker.js';

export default {
  event: 'project.activate',
  async handler({ project }) {
    const gitClone = project?.fields?.gitClone;
    if (!gitClone) return;
    if (projectDirTracker.isTracking(project.id)) return;

    // Resolve the same way the clone button + tool do, so the watcher
    // points at the directory git actually wrote to.
    const cwd = path.resolve(process.cwd(), gitClone);

    try {
      projectDirTracker.start(project.id, cwd, {
        projectType: project.type,    // so file-changed events route to type-scoped hooks
        ignore: ['**/.git/**', '**/node_modules/**'],
      });
      console.log(`[track-repo] watching project #${project.id} at ${cwd}`);
    } catch (err) {
      console.warn(`[track-repo] failed to start watching #${project.id}:`, err.message);
    }
  },
};
