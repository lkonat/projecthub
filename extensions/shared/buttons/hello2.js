// A shared library button — reference it from a type's `buttons: [...]`.
// Logs to the server console. NOTE: `id` must match /^[a-z][a-z0-9_-]*$/i
// (letters, digits, _ and -) — no spaces, or the loader rejects it.

export default {
  id: 'hello2',
  label: 'Log hello test',
  async handler({ project },ctx,settings) {
    console.log({settings,ctx,project})
    console.log(`[lass-project] hello from project #${project.id} "${project.name}"`,settings);
    return { message: 'Logged to the server console.' };
  },
};
