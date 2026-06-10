import { getDb } from '../../db/connection.js';

export const phasesRepository = {
  listByProject(projectId) {
    return getDb()
      .prepare('SELECT * FROM phases WHERE project_id = ? ORDER BY position ASC, id ASC')
      .all(projectId);
  },

  findById(id) {
    return getDb().prepare('SELECT * FROM phases WHERE id = ?').get(id);
  },

  // The not-done phases of a project (idle or active), in order. Used to tell
  // whether any work remains (for project auto-close).
  liveByProject(projectId) {
    return getDb()
      .prepare(
        "SELECT * FROM phases WHERE project_id = ? AND status IN ('idle','active') ORDER BY position ASC, id ASC"
      )
      .all(projectId);
  },

  // The single active (current) phase of a project, or undefined.
  activeByProject(projectId) {
    return getDb()
      .prepare(
        "SELECT * FROM phases WHERE project_id = ? AND status = 'active' ORDER BY position ASC, id ASC LIMIT 1"
      )
      .get(projectId);
  },

  // The lowest-position idle phase of a project, or undefined. The next phase to
  // promote to active when the current one completes.
  firstIdleByProject(projectId) {
    return getDb()
      .prepare(
        "SELECT * FROM phases WHERE project_id = ? AND status = 'idle' ORDER BY position ASC, id ASC LIMIT 1"
      )
      .get(projectId);
  },

  countByProject(projectId) {
    return getDb()
      .prepare('SELECT COUNT(*) AS n FROM phases WHERE project_id = ?')
      .get(projectId).n;
  },

  // Next free position for a project (append to the end of the list).
  nextPosition(projectId) {
    const row = getDb()
      .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM phases WHERE project_id = ?')
      .get(projectId);
    return row.next;
  },

  create({ projectId, name, description = null, position }) {
    const info = getDb()
      .prepare('INSERT INTO phases (project_id, name, description, position) VALUES (?, ?, ?, ?)')
      .run(projectId, name, description, position);
    return this.findById(info.lastInsertRowid);
  },

  // Partial update. Only keys present in `patch` are written; `updated_at` is
  // always touched. Returns the refreshed row (or undefined if id is gone).
  update(id, patch) {
    const sets = [];
    const args = [];
    if (patch.name !== undefined)        { sets.push('name = ?');        args.push(patch.name); }
    if (patch.description !== undefined) { sets.push('description = ?'); args.push(patch.description); }
    if (patch.status !== undefined)      { sets.push('status = ?');      args.push(patch.status); }
    if (sets.length === 0) return this.findById(id);
    sets.push("updated_at = datetime('now')");
    args.push(id);
    getDb().prepare(`UPDATE phases SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    return this.findById(id);
  },

  remove(id) {
    return getDb().prepare('DELETE FROM phases WHERE id = ?').run(id).changes > 0;
  },

  // Reorder: write each id's new position from its index in `orderedIds`.
  // Scoped to projectId so a caller can't reposition another project's phases.
  reorder(projectId, orderedIds) {
    const db = getDb();
    const stmt = db.prepare(
      "UPDATE phases SET position = ?, updated_at = datetime('now') WHERE id = ? AND project_id = ?"
    );
    const tx = db.transaction((ids) => {
      ids.forEach((id, idx) => stmt.run(idx, id, projectId));
    });
    tx(orderedIds);
    return this.listByProject(projectId);
  },
};
