// Subscribes to the in-process registry and broadcasts selected lifecycle
// events to Socket.IO rooms.
//
// Adding a new built-in broadcast = one entry in MAPPINGS.

import { registry } from '../extensions/registry.js';
import { channels, wireEvents } from './channels.js';

// Each mapping says: when this internal event fires, emit this wire event
// on these channels with this payload.
//
//   internal:  registry event name
//   wire:      socket.io event name clients listen for
//   channels:  fn(payload) → string[]   rooms to emit into
//   payload:   fn(payload) → object     wire payload sent to clients
const MAPPINGS = [
  {
    internal: 'project.after-create',
    wire:     wireEvents.PROJECT_CREATED,
    channels: () => [channels.projects()],
    payload:  ({ project }) => ({ project }),
  },
  {
    internal: 'project.after-update',
    wire:     wireEvents.PROJECT_UPDATED,
    channels: ({ project }) => [channels.projects(), channels.project(project.id)],
    payload:  ({ project }) => ({ project }),
  },
  {
    internal: 'project.after-delete',
    wire:     wireEvents.PROJECT_DELETED,
    channels: () => [channels.projects()],
    payload:  ({ id }) => ({ id }),
  },
  {
    internal: 'project.file-changed',
    wire:     wireEvents.PROJECT_FILE_CHANGED,
    channels: ({ projectId }) => [channels.project(projectId)],
    payload:  (p) => p,    // pass through { projectId, type, path, relPath, mtime, mtimeMs, ... }
  },
  {
    internal: 'comment.after-create',
    wire:     wireEvents.COMMENT_CREATED,
    channels: ({ projectId }) => [channels.project(projectId)],
    payload:  ({ comment, projectId }) => ({ projectId, comment }),
  },
  {
    internal: 'comment.after-delete',
    wire:     wireEvents.COMMENT_DELETED,
    channels: ({ projectId }) => [channels.project(projectId)],
    payload:  ({ id, projectId }) => ({ projectId, id }),
  },
];

/**
 * Subscribe the realtime layer to registry events.
 * Registered as plain registry hooks — they fire in registration order
 * along with user hooks. Loader runs first, so user hooks fire BEFORE the
 * broadcasts (state observable to a user hook is sent over the wire).
 */
export function attachBridge(io) {
  for (const m of MAPPINGS) {
    registry.registerHook(
      {
        event: m.internal,
        async handler(payload) {
          const wirePayload = m.payload(payload);
          for (const channel of m.channels(payload)) {
            io.to(channel).emit(m.wire, wirePayload);
          }
        },
      },
      `realtime/bridge[${m.internal} → ${m.wire}]`
    );
  }
}
