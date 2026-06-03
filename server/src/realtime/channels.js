// Channel (Socket.IO room) naming + the public event taxonomy.
//
// Channels are strings. The bridge resolves them per event; clients join
// them via `subscribe` and leave them via `unsubscribe`. Inventing new
// channels is just inventing new strings — no registration needed.

export const channels = {
  // List-level events. Every client auto-joins this room.
  projects() { return 'projects'; },

  // Project-scoped events. Clients viewing a project join this room.
  project(id) { return `project:${id}`; },
};

// Public wire-event names (past tense). The bridge maps internal lifecycle
// events to these. Listed here so any interface can know what to subscribe to.
export const wireEvents = {
  PROJECT_CREATED: 'project.created',
  PROJECT_UPDATED: 'project.updated',
  PROJECT_DELETED: 'project.deleted',
  PROJECT_FOCUSED: 'project.focused',
  PROJECT_FILE_CHANGED: 'project.file-changed',
  COMMENT_CREATED: 'comment.created',
  COMMENT_DELETED: 'comment.deleted',
};
