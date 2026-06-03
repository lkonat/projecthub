// Thin singleton wrapper around socket.io-client.
// The script tag in index.html loads the global `io` from /socket.io/socket.io.js.

/* global io */

const handlers = new Map(); // key: `${channel}|${event}` → Set<fn>
let socket = null;
let activeProjectChannel = null;

function key(channel, event) { return `${channel}|${event}`; }

function ensureSocket() {
  if (socket) return socket;
  if (typeof io === 'undefined') {
    console.warn('socket.io-client not loaded — realtime disabled');
    return null;
  }
  socket = io({ path: '/socket.io' });

  // Single dispatch point. Each (channel, event) listener bag fires
  // on every matching incoming event. We don't filter by channel
  // server-side — we trust the server only sends to rooms we joined.
  socket.onAny((eventName, payload) => {
    console.log({eventName, payload})
    // Try fan-out to all channels we've subscribed under.
    for (const [k, set] of handlers) {
      const [, ev] = k.split('|');
      if (ev === eventName) {
        for (const fn of set) {
          try { fn(payload); }
          catch (err) { console.error('[realtime] handler threw:', err); }
        }
      }
    }
  });

  socket.on('connect',    () => console.log('[realtime] connected'));
  socket.on('disconnect', () => console.log('[realtime] disconnected'));
  return socket;
}

export const realtime = {
  /**
   * Subscribe to `event` on `channel`. Returns an unsubscribe function.
   * The channel string is informational on the client (filtering is by
   * room membership server-side); we keep it so callers can be explicit.
   */
  on(channel, event, fn) {
    ensureSocket();
    const k = key(channel, event);
    let bag = handlers.get(k);
    if (!bag) { bag = new Set(); handlers.set(k, bag); }
    bag.add(fn);
    return () => bag.delete(fn);
  },

  /** Join a Socket.IO room. */
  subscribe(channel) {
    const s = ensureSocket();
    if (!s || !channel) return;
    s.emit('subscribe', channel);
  },

  /** Leave a Socket.IO room. */
  unsubscribe(channel) {
    if (!socket || !channel) return;
    socket.emit('unsubscribe', channel);
  },

  /**
   * Convenience: switch the "currently viewed project" room. Unsubscribes
   * from the previous one. Pass null/undefined to leave without joining.
   */
  setActiveProject(id) {
    const next = id ? `project:${id}` : null;
    if (next === activeProjectChannel) return;
    if (activeProjectChannel) this.unsubscribe(activeProjectChannel);
    activeProjectChannel = next;
    if (next) this.subscribe(next);
  },

  isConnected() {
    return !!socket?.connected;
  },
};

export default realtime;
