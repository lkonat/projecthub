// Example project type. Drop more files like this in extensions/types/
// to register new types. The default export must include `id` and `label`.
//
// Reusable buttons are imported from the shared button library and listed in
// `buttons: [...]` — they're registered scoped to this type. Reuse the same
// objects across types, or override per type with spread, e.g.
//   { ...clone, id: 'clone-fork', label: 'Fork & clone' }

import clone from '../../shared/buttons/clone.js';
import gitStatus from '../../shared/buttons/git-status.js';
import createRepo from '../../shared/buttons/create-repo.js';
import hello2 from '../../shared/buttons/hello2.js';
export default {
  id: 'lass-swe-work',
  label: 'lass-swe-work',
  description: 'lass swe projects',
  defaults: {
    priority: 'high',
    status: 'active',
  },
  buttons: [hello2,clone, gitStatus,createRepo],
  fields: [
    { key: 'gitRepoUrl',     label: 'Git repo url',      type: 'text', required: false },
    { key: 'gitClone',       label: 'Git Clone Name',    type: 'text', required: false },
    { key: 'remoteGitClone', label: 'Remote Clone Name', type: 'text', required: false },
  ],
};
