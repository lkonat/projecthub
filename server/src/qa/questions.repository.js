import { getDb } from '../db/connection.js';

// Data access for the `questions` table (see migration 025). Raw rows in/out —
// JSON parsing and the state machine live in the engine (QuestionEngine.js).
const UPDATABLE = ['kind', 'prompt', 'options', 'status', 'answer', 'meta', 'answered_at'];

export const questionsRepository = {
  create({ subjectType, subjectId, kind = 'question', prompt, options = null, meta = null, conversationId = null }) {
    const info = getDb()
      .prepare(
        `INSERT INTO questions (subject_type, subject_id, kind, prompt, options, meta, conversation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(subjectType, subjectId, kind, prompt, options, meta, conversationId);
    return this.findById(info.lastInsertRowid);
  },

  findById(id) {
    return getDb().prepare('SELECT * FROM questions WHERE id = ?').get(id);
  },

  // Partial update over the updatable columns; returns the refreshed row.
  update(id, patch) {
    const sets = [];
    const args = [];
    for (const col of UPDATABLE) {
      if (patch[col] !== undefined) { sets.push(`${col} = ?`); args.push(patch[col]); }
    }
    if (sets.length === 0) return this.findById(id);
    args.push(id);
    getDb().prepare(`UPDATE questions SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    return this.findById(id);
  },

  // All questions for a subject, oldest first — this ordering IS the transcript.
  listBySubject(subjectType, subjectId) {
    return getDb()
      .prepare('SELECT * FROM questions WHERE subject_type = ? AND subject_id = ? ORDER BY id ASC')
      .all(subjectType, subjectId);
  },

  pendingBySubject(subjectType, subjectId) {
    return getDb()
      .prepare("SELECT * FROM questions WHERE subject_type = ? AND subject_id = ? AND status = 'pending' ORDER BY id ASC")
      .all(subjectType, subjectId);
  },

  listByStatus(status) {
    return getDb().prepare('SELECT * FROM questions WHERE status = ? ORDER BY id ASC').all(status);
  },

  // All questions asked within a conversation, oldest first.
  listByConversation(conversationId) {
    return getDb().prepare('SELECT * FROM questions WHERE conversation_id = ? ORDER BY id ASC').all(conversationId);
  },
};
