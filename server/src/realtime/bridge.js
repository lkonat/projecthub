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
    channels: ({ project }) => [channels.user(project.user_id)],
    payload:  ({ project }) => ({ project }),
  },
  {
    internal: 'project.after-update',
    wire:     wireEvents.PROJECT_UPDATED,
    channels: ({ project }) => [channels.user(project.user_id), channels.project(project.id)],
    payload:  ({ project }) => ({ project }),
  },
  {
    internal: 'project.after-delete',
    wire:     wireEvents.PROJECT_DELETED,
    channels: ({ project }) => [channels.user(project.user_id)],
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
  {
    internal: 'checklist.after-create',
    wire:     wireEvents.CHECKLIST_CREATED,
    channels: ({ projectId }) => [channels.project(projectId)],
    payload:  ({ item, projectId }) => ({ projectId, item }),
  },
  {
    internal: 'checklist.after-update',
    wire:     wireEvents.CHECKLIST_UPDATED,
    channels: ({ projectId }) => [channels.project(projectId)],
    payload:  ({ item, projectId }) => ({ projectId, item }),
  },
  {
    internal: 'checklist.after-delete',
    wire:     wireEvents.CHECKLIST_DELETED,
    channels: ({ projectId }) => [channels.project(projectId)],
    payload:  ({ id, projectId }) => ({ projectId, id }),
  },
  {
    internal: 'checklist.after-reorder',
    wire:     wireEvents.CHECKLIST_REORDERED,
    channels: ({ projectId }) => [channels.project(projectId)],
    payload:  ({ items, projectId }) => ({ projectId, items }),
  },
  {
    internal: 'phase.after-create',
    wire:     wireEvents.PHASE_CREATED,
    channels: ({ projectId }) => [channels.project(projectId)],
    payload:  ({ phase, projectId }) => ({ projectId, phase }),
  },
  {
    internal: 'phase.after-update',
    wire:     wireEvents.PHASE_UPDATED,
    channels: ({ projectId }) => [channels.project(projectId)],
    payload:  ({ phase, projectId }) => ({ projectId, phase }),
  },
  {
    internal: 'phase.after-delete',
    wire:     wireEvents.PHASE_DELETED,
    channels: ({ projectId }) => [channels.project(projectId)],
    payload:  ({ id, projectId }) => ({ projectId, id }),
  },
  {
    internal: 'phase.after-reorder',
    wire:     wireEvents.PHASE_REORDERED,
    channels: ({ projectId }) => [channels.project(projectId)],
    payload:  ({ phases, projectId }) => ({ projectId, phases }),
  },
  {
    internal: 'phase.after-complete',
    wire:     wireEvents.PHASE_COMPLETED,
    channels: ({ projectId }) => [channels.project(projectId)],
    payload:  ({ phase, projectId }) => ({ projectId, phase }),
  },
  {
    // A phase became active (idle -> active). Status change → same wire event as
    // any other phase update so the client re-renders.
    internal: 'phase.after-activate',
    wire:     wireEvents.PHASE_UPDATED,
    channels: ({ projectId }) => [channels.project(projectId)],
    payload:  ({ phase, projectId }) => ({ projectId, phase }),
  },
  {
    // "Go backward": a passed phase reopened. It's a phase status change, so it
    // rides the same wire event as any other phase update.
    internal: 'phase.after-reopen',
    wire:     wireEvents.PHASE_UPDATED,
    channels: ({ projectId }) => [channels.project(projectId)],
    payload:  ({ phase, projectId }) => ({ projectId, phase }),
  },
  {
    internal: 'assignment.after-create',
    wire:     wireEvents.ASSIGNMENT_CREATED,
    channels: ({ projectId }) => [channels.project(projectId)],
    payload:  ({ assignment, projectId }) => ({ projectId, assignment }),
  },
  {
    internal: 'assignment.after-update',
    wire:     wireEvents.ASSIGNMENT_UPDATED,
    channels: ({ projectId }) => [channels.project(projectId)],
    payload:  ({ assignment, projectId }) => ({ projectId, assignment }),
  },
  {
    internal: 'assignment.after-delete',
    wire:     wireEvents.ASSIGNMENT_DELETED,
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
