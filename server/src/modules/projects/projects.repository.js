import { getDb } from '../../db/connection.js';

// JSON columns we parse on read and serialize on write.
const JSON_COLUMNS = ['fields', 'meta'];

function hydrate(row) {
  if (!row) return row;
  const out = { ...row };
  for (const col of JSON_COLUMNS) {
    if (row[col]) {
      try { out[col] = JSON.parse(row[col]); }
      catch { out[col] = {}; }
    } else {
      out[col] = {};
    }
  }
  return out;
}

function serializeJsonColumns(params, keys) {
  for (const col of JSON_COLUMNS) {
    if (keys.includes(col)) {
      params[col] = params[col] ? JSON.stringify(params[col]) : null;
    }
  }
  return params;
}

export const projectsRepository = {
  list(userId, { priority, status, sort = 'priority' } = {}) {
    const db = getDb();
    const where = ['user_id = @userId'];
    const params = { userId };
    if (priority) { where.push('priority = @priority'); params.priority = priority; }
    if (status)   { where.push('status = @status');     params.status = status; }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    // priority ordering: critical > high > medium > low
    const orderSql = sort === 'created'
      ? 'ORDER BY created_at DESC'
      : `ORDER BY CASE priority
            WHEN 'critical' THEN 0
            WHEN 'high'     THEN 1
            WHEN 'medium'   THEN 2
            WHEN 'low'      THEN 3
         END, created_at DESC`;

    return db.prepare(`SELECT * FROM projects ${whereSql} ${orderSql}`).all(params).map(hydrate);
  },

  findById(id) {
    return hydrate(getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id));
  },

  // Ownership-scoped lookup: only returns the project if it belongs to userId.
  findByIdForUser(userId, id) {
    return hydrate(
      getDb().prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(id, userId)
    );
  },

  // True if `userId` has at least one assignment in any phase of the project.
  // Used to grant read-only access to non-owners who are assigned work there.
  isAssignee(userId, projectId) {
    const row = getDb()
      .prepare(
        `SELECT 1
           FROM assignments a
           JOIN phases p ON a.phase_id = p.id
          WHERE p.project_id = ? AND a.assignee_user_id = ?
          LIMIT 1`
      )
      .get(projectId, userId);
    return !!row;
  },

  create({
    userId,
    name,
    description = null,
    priority = 'medium',
    status = 'active',
    type = null,
    fields = null,
    meta = null,
  }) {
    const params = serializeJsonColumns(
      { user_id: userId, name, description, priority, status, type, fields, meta },
      ['fields', 'meta']
    );
    const info = getDb()
      .prepare(`INSERT INTO projects (user_id, name, description, priority, status, type, fields, meta)
                VALUES (@user_id, @name, @description, @priority, @status, @type, @fields, @meta)`)
      .run(params);
    return this.findById(info.lastInsertRowid);
  },

  update(id, patch) {
    const allowed = ['name', 'description', 'priority', 'status', 'type', 'fields', 'meta'];
    const keys = Object.keys(patch).filter((k) => allowed.includes(k));
    if (keys.length === 0) return this.findById(id);
    const setSql = keys.map((k) => `${k} = @${k}`).join(', ');
    const params = serializeJsonColumns({ ...patch, id }, keys);
    getDb()
      .prepare(`UPDATE projects
                SET ${setSql}, updated_at = datetime('now')
                WHERE id = @id`)
      .run(params);
    return this.findById(id);
  },

  remove(id) {
    return getDb().prepare('DELETE FROM projects WHERE id = ?').run(id).changes > 0;
  },
};
