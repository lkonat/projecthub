# Realtime

Pushes server-side lifecycle events to connected clients over Socket.IO.
The same registry that drives user hooks drives the broadcast layer — every
new event becomes broadcast-capable by adding one line to
[`bridge.js`](./bridge.js).

```
   service.create / .update / .focus / ...
                 │
                 ▼
       ┌─────────────────────┐
       │ registry.emit(...)  │
       └──────┬──────────────┘
              │
       ┌──────┴───────┐
       │              │
       ▼              ▼
   user hooks    realtime bridge
                      │
                      ▼
                 Socket.IO rooms
                      │
                 ┌────┴────┐
                 ▼         ▼
              client    other clients
```

## Public API

```js
import { realtime } from './realtime/index.js';

realtime.start(httpServer);            // attach Socket.IO + bridge
realtime.broadcast(channel, event, payload);
realtime.broadcastAll(event, payload); // shorthand for the global room
realtime.isStarted();
await realtime.close();                // on shutdown
```

The same object is exposed to every hook and button via `ctx.realtime`:

```js
async handler({ project }, ctx) {
  ctx.realtime.broadcast(`project:${project.id}`, 'custom.event', { ... });
}
```

If realtime hasn't been started (e.g. a test), `broadcast` is a no-op.

## Channels (rooms)

| Channel       | Who's in it                                        |
|---------------|----------------------------------------------------|
| `projects`    | Every connected client (auto-joined on connect)    |
| `project:<id>` | Clients viewing project `<id>` — joined via the client's `setActiveProject(id)` |

Channels are arbitrary strings. Invent new ones for new scopes (e.g.
`project:<id>:comments`, `user:<id>`). Clients join by sending
`socket.emit('subscribe', '<channel>')`.

## Built-in wire events (set by the bridge)

| Event             | Channel(s)                          | Payload                          |
|-------------------|-------------------------------------|----------------------------------|
| `project.created` | `projects`                          | `{ project }`                    |
| `project.updated` | `projects`, `project:<id>`          | `{ project }`                    |
| `project.deleted` | `projects`                          | `{ id }`                         |
| `project.focused` | `project:<id>`                      | `{ project, source }`            |
| `comment.created` | `project:<id>`                      | `{ projectId, comment }`         |
| `comment.deleted` | `project:<id>`                      | `{ projectId, id }`              |

## Adding a new built-in event

1. Pick an internal registry event (e.g. `project.after-archive`) and
   `registry.emit(...)` it from the service.
2. Add an entry to `MAPPINGS` in `bridge.js`:
   ```js
   {
     internal: 'project.after-archive',
     wire:     'project.archived',
     channels: ({ project }) => [channels.projects(), channels.project(project.id)],
     payload:  ({ project }) => ({ project }),
   }
   ```
3. Constant in `channels.js#wireEvents` if you want to reference it by name.

## Client integration

The HTML loads the auto-served Socket.IO client at `/socket.io/socket.io.js`.
The app's [`client/lib/realtime.js`](../../../client/lib/realtime.js) wraps it
with a minimal singleton:

```js
import { realtime } from './lib/realtime.js';

realtime.on('project:42', 'project.updated', ({ project }) => { /* ... */ });
realtime.setActiveProject(42);   // joins `project:42`, leaves the previous one
```

## Refresh strategy

When a wire event arrives, the web client **re-fetches** via REST instead
of mutating local state from the payload. Reasons:

- The DB is the source of truth — no merge bugs from partial payloads.
- One render path (the same code paints the initial load and post-event).

A short debounce coalesces bursts. See the comment around
`debounceRefreshProject` in `client/app.js`.
