import { getDb } from '../../db/connection.js';

// Data access for the `agents` table. Rows are a durable projection of the
// in-memory agent registry (see agents.service.syncFromRegistry).
export const agentsRepository = {
  list() {
    return getDb().prepare('SELECT * FROM agents ORDER BY title COLLATE NOCASE ASC').all();
  },

  // Only the agents that can currently be assigned: present in code + enabled.
  listAssignable() {
    return getDb()
      .prepare("SELECT * FROM agents WHERE status = 'active' AND enabled = 1 ORDER BY title COLLATE NOCASE ASC")
      .all();
  },

  findById(id) {
    return getDb().prepare('SELECT * FROM agents WHERE id = ?').get(id);
  },

  findBySlug(slug) {
    return getDb().prepare('SELECT * FROM agents WHERE slug = ?').get(slug);
  },

  // Upsert by slug: insert a new agent or refresh an existing one's metadata,
  // flipping it back to 'active' (a previously-missing agent whose code returned).
  upsertBySlug({ slug, title, description = null, inputSchema = null, event = null }) {
    getDb()
      .prepare(
        `INSERT INTO agents (slug, title, description, input_schema, event, status)
         VALUES (@slug, @title, @description, @inputSchema, @event, 'active')
         ON CONFLICT(slug) DO UPDATE SET
           title        = excluded.title,
           description  = excluded.description,
           input_schema = excluded.input_schema,
           event        = excluded.event,
           status       = 'active',
           updated_at   = datetime('now')`
      )
      .run({ slug, title, description, inputSchema, event });
    return this.findBySlug(slug);
  },

  // Mark every agent whose slug is NOT in `activeSlugs` as 'missing' (its code is
  // no longer registered). Returns how many rows changed. Never deletes — keeps
  // assignment history intact.
  markMissingExcept(activeSlugs) {
    const db = getDb();
    if (activeSlugs.length === 0) {
      return db.prepare("UPDATE agents SET status = 'missing', updated_at = datetime('now') WHERE status != 'missing'").run().changes;
    }
    const placeholders = activeSlugs.map(() => '?').join(', ');
    return db
      .prepare(
        `UPDATE agents SET status = 'missing', updated_at = datetime('now')
          WHERE status != 'missing' AND slug NOT IN (${placeholders})`
      )
      .run(...activeSlugs).changes;
  },
};
