// Settings hub for the "othot-swe-work" project type.
//
// This is the single place that loads this type's configuration and exposes
// it to the rest of the type's extensions. It reads the `.env` file sitting
// in the type directory (../.env) via the shared loader, then layers on a few
// named conveniences for the keys this type actually uses.
//
// The extension loader ignores the settings/ folder (like shared/), so this
// module is only ever pulled in by an explicit import, e.g. from a button:
//
//   import settings from '../settings/settings.js';
//   const url = settings.gitUrl;
//
// To give another project type its own settings, copy this file into
// types/<that-type>/settings/ — the shared loader figures out which type it
// belongs to from the file's location.

import { createSettings } from '../../../shared/settings/env.js';

const base = createSettings(import.meta.url);

const settings = Object.freeze({
  ...base,

  // ---- named conveniences for this type ----

  // Default repo to clone when a project has no `gitRepoUrl` field of its own.
  get gitUrl() {
    return base.get('GIT_URL');
  },

  // Optional base dir for clones; `undefined` lets callers fall back to cwd.
  get cloneBaseDir() {
    return base.get('CLONE_BASE_DIR');
  },
});

export default settings;
export { settings };
