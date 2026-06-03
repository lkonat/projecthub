// Singleton: tracks a directory per project for file/dir changes.
//
// Sits on top of the generic `fileWatcher` singleton — one underlying
// subscription per dirPath. Two responsibilities on top:
//   - Project-id-keyed lifecycle (start/stop by projectId).
//   - Server-side debounce: a flurry of file events (test runs, npm install,
//     branch switches) collapses to ONE `project.file-changed` registry emit
//     per ~250ms window. That keeps Socket.IO broadcasts (and any client
//     re-fetches they trigger) bounded regardless of disk activity.
//
// Usage:
//   import { projectDirTracker } from './tracker/projectDirTracker.js';
//   projectDirTracker.start(42, '/abs/path/to/repo', {
//     projectType: 'othot-swe-work',
//     ignore: ['**/.git/**'],
//     debounceMs: 250,   // optional override
//   });
//   projectDirTracker.stop(42);
//
// Emitted payload (one per debounce flush, not per file):
//   {
//     projectId,
//     projectType,           // for type-scoped hook routing
//     count,                 // number of raw fs events in this batch
//     paths,                 // sample of relPaths that changed (deduped)
//   }
//
// Clients listening to the resulting `project.file-changed` socket event
// should treat it as a *notification* — re-fetch the project's meta and
// rerender. The payload deliberately omits per-file mtime/stat info so
// the source of truth stays the meta endpoint, not the broadcast.

import path from 'node:path';
import { fileWatcher } from '../watcher/fileWatcher.js';
import { registry } from '../extensions/registry.js';

const DEFAULT_DEBOUNCE_MS = 250;

class ProjectDirTracker {
  constructor() {
    /** @type {Map<number, {
     *   subId: string,
     *   dirPath: string,
     *   debounceMs: number,
     *   projectType: string|null,
     *   timer: ReturnType<typeof setTimeout> | null,
     *   buffer: Array<{ type, path, relPath }>,
     * }>} */
    this._byProject = new Map();
  }

  start(projectId, dirPath, opts = {}) {
    if (!projectId || !dirPath) {
      throw new Error('start(projectId, dirPath) requires both arguments');
    }
    const abs = path.resolve(dirPath);
    const existing = this._byProject.get(projectId);
    if (existing) {
      if (existing.dirPath === abs) return false;       // already tracking same dir
      this.stop(projectId);
    }

    const entry = {
      subId:       null,
      dirPath:     abs,
      debounceMs:  opts.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      projectType: opts.projectType ?? null,
      timer:       null,
      buffer:      [],
    };

    const subId = fileWatcher.watch(abs, (event) => {
      if (event.type === 'ready' || event.type === 'error') return;
      entry.buffer.push({
        type:    event.type,
        path:    event.path,
        relPath: event.relPath ?? path.relative(event.watchPath, event.path),
      });
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => this._flush(projectId), entry.debounceMs);
    }, opts);

    entry.subId = subId;
    this._byProject.set(projectId, entry);
    return true;
  }

  stop(projectId) {
    const entry = this._byProject.get(projectId);
    if (!entry) return false;
    if (entry.timer) clearTimeout(entry.timer);
    fileWatcher.unwatch(entry.subId);
    this._byProject.delete(projectId);
    return true;
  }

  isTracking(projectId) {
    return this._byProject.has(projectId);
  }

  list() {
    return Array.from(this._byProject.entries()).map(([projectId, { dirPath, buffer, timer }]) => ({
      projectId, dirPath, pendingEvents: buffer.length, debounceArmed: !!timer,
    }));
  }

  async stopAll() {
    for (const projectId of [...this._byProject.keys()]) this.stop(projectId);
  }

  // ── internals ────────────────────────────────────────────────────

  async _flush(projectId) {
    const entry = this._byProject.get(projectId);
    if (!entry) return;
    entry.timer = null;
    if (entry.buffer.length === 0) return;
    const events = entry.buffer;
    entry.buffer = [];

    // Dedup paths so the summary stays small even when a file gets
    // create+update+update in one window.
    const seen = new Set();
    const paths = [];
    for (const e of events) {
      if (seen.has(e.relPath)) continue;
      seen.add(e.relPath);
      paths.push(e.relPath);
    }

    try {
      await registry.emit('project.file-changed', {
        projectId,
        projectType: entry.projectType,
        count: events.length,
        paths,
      }, undefined);
    } catch (err) {
      console.error('[projectDirTracker] emit project.file-changed failed:', err.message);
    }
  }
}

export const projectDirTracker = new ProjectDirTracker();
export default projectDirTracker;
