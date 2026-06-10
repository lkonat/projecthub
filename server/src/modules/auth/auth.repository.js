import { getDb } from '../../db/connection.js';

export const authRepository = {
  countUsers() {
    return getDb().prepare('SELECT COUNT(*) AS n FROM users').get().n;
  },

  findByUsername(username) {
    return getDb().prepare('SELECT * FROM users WHERE username = ?').get(username);
  },

  findById(id) {
    return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
  },

  // All accounts, for assignee pickers. id + username only.
  listAll() {
    return getDb().prepare('SELECT id, username FROM users ORDER BY username ASC').all();
  },

  create({ username, passwordHash }) {
    const info = getDb()
      .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
      .run(username, passwordHash);
    return this.findById(info.lastInsertRowid);
  },

  // Partial profile update. Only keys present in `patch` are written;
  // `updated_at` is always touched. Returns the refreshed row.
  updateProfile(id, patch) {
    const sets = [];
    const args = [];
    if (patch.name !== undefined)               { sets.push('name = ?');               args.push(patch.name); }
    if (patch.email !== undefined)              { sets.push('email = ?');              args.push(patch.email); }
    if (patch.phone !== undefined)              { sets.push('phone = ?');              args.push(patch.phone); }
    if (patch.contact_preference !== undefined) { sets.push('contact_preference = ?'); args.push(patch.contact_preference); }
    if (sets.length === 0) return this.findById(id);
    sets.push("updated_at = datetime('now')");
    args.push(id);
    getDb().prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    return this.findById(id);
  },

  // One-time adoption: assign any pre-auth projects (no owner) to a user.
  claimOrphanProjects(userId) {
    return getDb()
      .prepare('UPDATE projects SET user_id = ? WHERE user_id IS NULL')
      .run(userId).changes;
  },
};
