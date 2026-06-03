// Stop watching the project's local repo when the last client leaves
// its page. Pairs with track-repo-on-activate.js.

import { projectDirTracker } from '../../../server/src/tracker/projectDirTracker.js';

export default {
  event: 'project.deactivate',
  async handler({ project }) {
    if (projectDirTracker.stop(project.id)) {
      console.log(`[track-repo] stopped watching project #${project.id}`);
    }
  },
};
