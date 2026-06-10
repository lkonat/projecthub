// A type-LOCAL button: it lives in this type's buttons/ folder, so the loader
// scopes it to lass-project automatically (no `type` needed). This shows that
// buttons can still be defined inside a type alongside the library buttons
// listed in type.js's `buttons: [...]`.
//
// It just logs to the server console.

export default {
  id: 'hello',
  label: 'Log hello',
  async handler({ project }, ctx) {
    console.log(`[lass-project] hello from project #${project.id} "${project.name}"`);
    return { message: 'Logged to the server console.' };
  },
};
