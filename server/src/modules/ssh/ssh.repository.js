import { getDb } from '../../db/connection.js';

export const sshRepository = {
  list() {
    return getDb()
      .prepare('SELECT * FROM ssh_connections ORDER BY name COLLATE NOCASE ASC')
      .all();
  },

  findById(id) {
    return getDb().prepare('SELECT * FROM ssh_connections WHERE id = ?').get(id);
  },

  findByName(name) {
    return getDb().prepare('SELECT * FROM ssh_connections WHERE name = ?').get(name);
  },

  create({ name, host, port = 22, username = null, identityFile = null }) {
    const info = getDb()
      .prepare(`INSERT INTO ssh_connections (name, host, port, username, identity_file)
                VALUES (@name, @host, @port, @username, @identityFile)`)
      .run({ name, host, port, username, identityFile });
    return this.findById(info.lastInsertRowid);
  },

  update(id, patch) {
    // Map camelCase service keys to snake_case columns.
    const columnFor = {
      name: 'name',
      host: 'host',
      port: 'port',
      username: 'username',
      identityFile: 'identity_file',
    };
    const keys = Object.keys(patch).filter((k) => k in columnFor);
    if (keys.length === 0) return this.findById(id);
    const setSql = keys.map((k) => `${columnFor[k]} = @${k}`).join(', ');
    getDb()
      .prepare(`UPDATE ssh_connections
                SET ${setSql}, updated_at = datetime('now')
                WHERE id = @id`)
      .run({ ...patch, id });
    return this.findById(id);
  },

  remove(id) {
    return getDb().prepare('DELETE FROM ssh_connections WHERE id = ?').run(id).changes > 0;
  },
};
