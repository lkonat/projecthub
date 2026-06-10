import { getDb } from '../../db/connection.js';

export const checklistRepository = {
  listByProject(projectId) {
    return getDb()
      .prepare('SELECT * FROM checklist_items WHERE project_id = ? ORDER BY position ASC, id ASC')
      .all(projectId);
  },

  findById(id) {
    return getDb().prepare('SELECT * FROM checklist_items WHERE id = ?').get(id);
  },

  // Next free position for a project (append to the end of the list).
  nextPosition(projectId) {
    const row = getDb()
      .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM checklist_items WHERE project_id = ?')
      .get(projectId);
    return row.next;
  },

  create({ projectId, text, position }) {
    const info = getDb()
      .prepare('INSERT INTO checklist_items (project_id, text, position) VALUES (?, ?, ?)')
      .run(projectId, text, position);
    return this.findById(info.lastInsertRowid);
  },

  // Partial update. Only the keys present in `patch` are written; `updated_at`
  // is always touched. Returns the refreshed row (or undefined if id is gone).
  update(id, patch) {
    const sets = [];
    const args = [];
    if (patch.text !== undefined) { sets.push('text = ?'); args.push(patch.text); }
    if (patch.done !== undefined) { sets.push('done = ?'); args.push(patch.done ? 1 : 0); }
    if (sets.length === 0) return this.findById(id);
    sets.push("updated_at = datetime('now')");
    args.push(id);
    getDb().prepare(`UPDATE checklist_items SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    return this.findById(id);
  },

  remove(id) {
    return getDb().prepare('DELETE FROM checklist_items WHERE id = ?').run(id).changes > 0;
  },

  // Reorder: write each id's new position from its index in `orderedIds`.
  // Scoped to projectId so a caller can't reposition another project's items.
  // Runs in a single transaction. Returns the reordered list.
  reorder(projectId, orderedIds) {
    const db = getDb();
    const stmt = db.prepare(
      'UPDATE checklist_items SET position = ?, updated_at = datetime(\'now\') WHERE id = ? AND project_id = ?'
    );
    const tx = db.transaction((ids) => {
      ids.forEach((id, idx) => stmt.run(idx, id, projectId));
    });
    tx(orderedIds);
    return this.listByProject(projectId);
  },
};
