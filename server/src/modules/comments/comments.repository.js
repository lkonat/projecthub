import { getDb } from '../../db/connection.js';

export const commentsRepository = {
  listByProject(projectId) {
    return getDb()
      .prepare('SELECT * FROM comments WHERE project_id = ? ORDER BY created_at DESC, id DESC')
      .all(projectId);
  },

  findById(id) {
    return getDb().prepare('SELECT * FROM comments WHERE id = ?').get(id);
  },

  create({ projectId, body }) {
    const info = getDb()
      .prepare('INSERT INTO comments (project_id, body) VALUES (?, ?)')
      .run(projectId, body);
    return this.findById(info.lastInsertRowid);
  },

  remove(id) {
    return getDb().prepare('DELETE FROM comments WHERE id = ?').run(id).changes > 0;
  },
};
