// Realtime singleton — Socket.IO server, channel/room management, and a
// `broadcast` helper exposed to hooks via `ctx.realtime`.
//
// Usage in server entry:
//
//   import { createServer } from 'node:http';
//   import { realtime } from './realtime/index.js';
//   const httpServer = createServer(app);
//   realtime.start(httpServer);
//   httpServer.listen(port);
//
// Usage anywhere (hook, button, service):
//
//   ctx.realtime.broadcast('project:42', 'custom.event', { ... });
//
// Channels are arbitrary strings — see channels.js for the built-in names.
// Clients join/leave channels by sending 'subscribe'/'unsubscribe' messages
// containing the channel name(s).

import { Server } from 'socket.io';
import { channels } from './channels.js';
import { attachBridge } from './bridge.js';
import { registry } from '../extensions/registry.js';

const PROJECT_CHANNEL_RE = /^project:(\d+)$/;

let io = null;

// Translate a `project:<id>` channel name into a project.activate/deactivate
// event and emit it via the registry. The project is loaded fresh so hooks
// see current state. Missing/deleted projects are ignored silently.
async function emitProjectLifecycle(channel, event) {
  const match = PROJECT_CHANNEL_RE.exec(channel);
  if (!match) return;
  const projectId = Number(match[1]);
  // Lazy import to avoid a cycle (projects.service ↔ realtime).
  const { services } = await import('../services.js');
  let project;
  try { project = services.projects.get(projectId); }
  catch { return; } // project no longer exists
  try {
    await registry.emit(event, { project, projectId }, undefined);
  } catch (err) {
    console.error(`[realtime] ${event} hook error:`, err.message);
  }
}

export const realtime = {
  /**
   * Attach Socket.IO to the given HTTP server and start listening for
   * subscribe/unsubscribe messages. Safe to call once per process.
   */
  start(httpServer) {
    if (io) return io;
    io = new Server(httpServer, {
      cors: { origin: true, credentials: true }, // local app — open by default
    });

    io.on('connection', (socket) => {
      // Every client auto-joins the global `projects` room so they pick
      // up list-level changes without an explicit subscribe.
      socket.join(channels.projects());

      socket.on('subscribe', async (channel) => {
        if (typeof channel !== 'string' || !channel) return;
        const sizeBefore = io.sockets.adapter.rooms.get(channel)?.size ?? 0;
        socket.join(channel);
        // Room went from 0 → 1 viewers — emit activate for project channels.
        if (sizeBefore === 0) await emitProjectLifecycle(channel, 'project.activate');
      });

      socket.on('unsubscribe', async (channel) => {
        if (typeof channel !== 'string' || !channel) return;
        socket.leave(channel);
        const sizeAfter = io.sockets.adapter.rooms.get(channel)?.size ?? 0;
        if (sizeAfter === 0) await emitProjectLifecycle(channel, 'project.deactivate');
      });

      // `disconnecting` fires while the socket still appears in its rooms,
      // so we can predict which rooms are about to become empty.
      socket.on('disconnecting', async () => {
        for (const room of socket.rooms) {
          if (!PROJECT_CHANNEL_RE.test(room)) continue;
          const afterLeave = (io.sockets.adapter.rooms.get(room)?.size ?? 1) - 1;
          if (afterLeave === 0) await emitProjectLifecycle(room, 'project.deactivate');
        }
      });
    });

    attachBridge(io);
    console.log('[realtime] socket.io attached');
    return io;
  },

  /**
   * Broadcast a custom event to one channel. No-op until `start()` has run.
   */
  broadcast(channel, event, payload = {}) {
    if (!io) return false;
    if (typeof channel !== 'string' || !channel) {
      throw new TypeError('broadcast(channel, event, payload?) — channel must be a non-empty string');
    }
    if (typeof event !== 'string' || !event) {
      throw new TypeError('broadcast(channel, event, payload?) — event must be a non-empty string');
    }
    io.to(channel).emit(event, payload);
    return true;
  },

  /**
   * Broadcast to every connected client (joined to the global room).
   * Equivalent to `broadcast(channels.projects(), event, payload)`.
   */
  broadcastAll(event, payload = {}) {
    return this.broadcast(channels.projects(), event, payload);
  },

  isStarted() {
    return io !== null;
  },

  // Internal — exposed for tests/diagnostics.
  _io() { return io; },

  /**
   * Close the Socket.IO server. Call on shutdown.
   */
  async close() {
    if (!io) return;
    await new Promise((resolve) => io.close(resolve));
    io = null;
  },
};

export default realtime;
