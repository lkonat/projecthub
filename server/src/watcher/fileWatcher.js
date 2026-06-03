// Singleton file/directory watcher, backed by @parcel/watcher — the same
// native-backed (FSEvents / inotify / ReadDirectoryChangesW) library VS
// Code, Parcel, and Astro use.
//
// One `fileWatcher` instance is shared across the whole process (ES modules
// are evaluated once and cached). Internally each watched path has at most
// one underlying subscription; multiple listeners on the same path share it.
//
// Usage:
//
//   import { fileWatcher } from './watcher/fileWatcher.js';
//
//   const subId = fileWatcher.watch('/abs/path/to/dir', (event) => {
//     // event.type  ∈ 'create' | 'update' | 'delete' | 'ready' | 'error'
//     // event.path       — absolute path of the file/dir that changed
//     // event.watchPath  — root path this listener subscribed to
//     // event.relPath    — `event.path` relative to `event.watchPath`
//     // event.error      — present when type === 'error'
//   });
//
//   fileWatcher.unwatch(subId);            // remove this single listener
//   fileWatcher.unwatchPath(watchPath);    // remove all listeners + tear down
//   fileWatcher.list();                    // [{ path, listeners, ready }]
//   await fileWatcher.close();             // tear down everything (on shutdown)
//
// Options accepted by `watch(path, listener, options)`:
//   ignore — array of glob patterns relative to the watched root, e.g.
//            ['**/.git/**', '**/node_modules/**']. Forwarded to
//            @parcel/watcher.subscribe.
//
// Notes vs the previous chokidar-backed implementation:
//   - Event types are now `create | update | delete` (matches the native
//     events emitted by FSEvents / inotify). The old `add`/`addDir`/
//     `change`/`unlink`/`unlinkDir` split is gone — @parcel/watcher
//     doesn't distinguish files from directories in its events.
//   - Always fully recursive — no `depth` option.
//   - No initial scan or `ready` burst of synthetic add events. A single
//     `ready` event fires once the subscription is live.
//   - The native backend coalesces rapid writes for you, so the old
//     `awaitWriteFinishMs` option is no longer needed (or accepted).

import parcelWatcher from '@parcel/watcher';
import path from 'node:path';
import fs from 'node:fs';

// macOS reports paths through /private/var/... while /var (and /tmp) are
// symlinks. The native watcher canonicalizes its event paths, so we
// canonicalize the watch root too — otherwise `path.relative(root, ev.path)`
// produces nonsense like `../../../private/tmp/...`.
function canonicalize(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

class FileWatcher {
  constructor() {
    /** @type {Map<string, {
     *   subscription: { unsubscribe(): Promise<void> } | null,
     *   listeners: Map<string, Function>,
     *   options: object,
     *   ready: boolean,
     *   pending: Promise<void> | null,
     * }>} */
    this._byPath = new Map();
    this._nextId = 1;
    this._closed = false;
  }

  /**
   * Subscribe to file/dir changes under `dirPath`.
   * Returns a subscription id you can pass to `unwatch`.
   *
   * The underlying native subscription is opened asynchronously; the
   * `ready` event fires once it's live. Listeners added BEFORE ready
   * still see every event — @parcel/watcher doesn't deliver synthetic
   * "initial scan" events, so there's no missed-event window.
   */
  watch(dirPath, listener, options = {}) {
    if (this._closed) throw new Error('FileWatcher is closed');
    if (typeof dirPath !== 'string' || !dirPath) {
      throw new TypeError('watch(dirPath, listener) — dirPath must be a non-empty string');
    }
    if (typeof listener !== 'function') {
      throw new TypeError('watch(dirPath, listener) — listener must be a function');
    }

    const abs = canonicalize(path.resolve(dirPath));
    const id = `sub_${this._nextId++}`;
    let entry = this._byPath.get(abs);

    if (!entry) {
      entry = {
        subscription: null,
        listeners: new Map(),
        options,
        ready: false,
        pending: null,
      };
      this._byPath.set(abs, entry);

      entry.pending = parcelWatcher
        .subscribe(abs, (err, events) => this._onEvents(abs, err, events), {
          ignore: options.ignore,
        })
        .then((subscription) => {
          // Caller may have called unwatchPath/close before we resolved.
          const current = this._byPath.get(abs);
          if (!current || current !== entry) {
            // Stale subscription — tear it down immediately.
            subscription.unsubscribe().catch(() => {});
            return;
          }
          entry.subscription = subscription;
          entry.ready = true;
          this._fanout(abs, { type: 'ready', path: abs, watchPath: abs, relPath: '' });
        })
        .catch((err) => {
          console.error(`[fileWatcher] subscribe failed for ${abs}: ${err.message}`);
          this._fanout(abs, { type: 'error', path: abs, watchPath: abs, error: err });
          this._byPath.delete(abs);
        })
        .finally(() => { if (entry) entry.pending = null; });
    }

    entry.listeners.set(id, listener);
    return id;
  }

  /** Remove a single listener. Returns true if a listener was removed. */
  async unwatch(subId) {
    for (const [pathKey, entry] of this._byPath) {
      if (entry.listeners.delete(subId)) {
        if (entry.listeners.size === 0) {
          this._byPath.delete(pathKey);
          await this._tearDown(entry);
        }
        return true;
      }
    }
    return false;
  }

  /** Remove all listeners for a given path and close its subscription. */
  async unwatchPath(dirPath) {
    const abs = canonicalize(path.resolve(dirPath));
    const entry = this._byPath.get(abs);
    if (!entry) return false;
    this._byPath.delete(abs);
    entry.listeners.clear();
    await this._tearDown(entry);
    return true;
  }

  /** Snapshot of currently-watched paths. */
  list() {
    return Array.from(this._byPath.entries()).map(([p, e]) => ({
      path: p,
      listeners: e.listeners.size,
      ready: e.ready,
    }));
  }

  /** Close every watcher. Call on process shutdown. */
  async close() {
    this._closed = true;
    const tasks = [];
    for (const entry of this._byPath.values()) tasks.push(this._tearDown(entry));
    this._byPath.clear();
    await Promise.all(tasks);
  }

  // ── internals ────────────────────────────────────────────────────

  _onEvents(absPath, err, events) {
    if (err) {
      this._fanout(absPath, { type: 'error', path: absPath, watchPath: absPath, error: err });
      return;
    }
    for (const event of events) {
      this._fanout(absPath, {
        type: event.type,                                    // 'create'|'update'|'delete'
        path: event.path,
        watchPath: absPath,
        relPath: path.relative(absPath, event.path),
      });
    }
  }

  _fanout(absPath, event) {
    const entry = this._byPath.get(absPath);
    if (!entry) return;
    for (const listener of entry.listeners.values()) {
      try { listener(event); }
      catch (err) { console.error('[fileWatcher] listener threw:', err); }
    }
  }

  async _tearDown(entry) {
    // Wait for any in-flight subscribe() to finish first; otherwise the
    // newly-arrived subscription would leak.
    if (entry.pending) {
      try { await entry.pending; } catch { /* logged in catch above */ }
    }
    if (entry.subscription) {
      try { await entry.subscription.unsubscribe(); }
      catch (err) { console.error('[fileWatcher] unsubscribe failed:', err.message); }
    }
  }
}

export const fileWatcher = new FileWatcher();
export default fileWatcher;
