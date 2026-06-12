import { getDb } from '../db/connection.js';

// Data access for the `conversations` table (migration 026): one row per subject,
// the transcript stored as a JSON blob in `messages`. JSON (de)serialization and
// append semantics live in the store (ConversationStore.js).
export const conversationsRepository = {
  find(subjectType, subjectId) {
    return getDb()
      .prepare('SELECT * FROM conversations WHERE subject_type = ? AND subject_id = ?')
      .get(subjectType, subjectId);
  },

  findById(id) {
    return getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  },

  // Upsert the whole messages blob for a subject; bumps updated_at on overwrite.
  save(subjectType, subjectId, messagesJson) {
    getDb()
      .prepare(
        `INSERT INTO conversations (subject_type, subject_id, messages)
         VALUES (?, ?, ?)
         ON CONFLICT(subject_type, subject_id)
         DO UPDATE SET messages = excluded.messages, updated_at = datetime('now')`,
      )
      .run(subjectType, subjectId, messagesJson);
    return this.find(subjectType, subjectId);
  },

  remove(subjectType, subjectId) {
    return getDb()
      .prepare('DELETE FROM conversations WHERE subject_type = ? AND subject_id = ?')
      .run(subjectType, subjectId).changes > 0;
  },
};
