import { getDb } from '../../db/connection.js';

export const commentsRepository = {
  listByProject(projectId) {
    return getDb()
      .prepare(
        `SELECT c.*, u.username AS author
           FROM comments c
           LEFT JOIN users u ON c.user_id = u.id
          WHERE c.project_id = ?
          ORDER BY c.created_at DESC, c.id DESC`
      )
      .all(projectId);
  },

  findById(id) {
    return getDb().prepare('SELECT * FROM comments WHERE id = ?').get(id);
  },

  create({ projectId, body, userId = null }) {
    const info = getDb()
      .prepare('INSERT INTO comments (project_id, body, user_id) VALUES (?, ?, ?)')
      .run(projectId, body, userId);
    // Re-read via listByProject's shape so the created row carries `author`.
    return getDb()
      .prepare(
        `SELECT c.*, u.username AS author
           FROM comments c LEFT JOIN users u ON c.user_id = u.id
          WHERE c.id = ?`
      )
      .get(info.lastInsertRowid);
  },

  remove(id) {
    return getDb().prepare('DELETE FROM comments WHERE id = ?').run(id).changes > 0;
  },
};
