import { getDb } from '../db/connection.js';
import { conversationsRepository as repo } from './conversations.repository.js';
import { ValidationError } from '../utils/errors.js';

// ConversationStore — durable transcript storage for the qa/ subsystem. Where a
// question is one ask/answer, a conversation is the FULL message history an agent
// accumulates (too large for a question's `meta`). One transcript per subject,
// stored as a JSON array of RAW provider messages so a run can be replayed exactly.
//
// It's a plain store (no events): resume is driven by question answers, not by
// message appends. Auth-free and domain-agnostic, like the rest of qa/.

const parseJson = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

// Shape a row (or a default empty transcript when none exists). `id` is null
// until the row is persisted (ensure/append/save create it).
function present(row, subjectType, subjectId) {
  if (!row) {
    return { id: null, subjectType: String(subjectType), subjectId: String(subjectId), messages: [], meta: null, created_at: null, updated_at: null };
  }
  return {
    id: row.id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    messages: parseJson(row.messages) ?? [],
    meta: parseJson(row.meta),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// A stored message is a raw provider object; we only require it carries a role.
function assertMessages(messages) {
  if (!Array.isArray(messages)) throw new ValidationError('messages must be an array');
  for (const m of messages) {
    if (!m || typeof m !== 'object' || typeof m.role !== 'string') {
      throw new ValidationError('each message must be an object with a string `role`');
    }
  }
  return messages;
}

export class ConversationStore {
  // The subject's transcript record (empty messages [] when none stored yet; its
  // `id` is null until persisted).
  get({ subjectType, subjectId }) {
    return present(repo.find(String(subjectType), String(subjectId)), subjectType, subjectId);
  }

  // Get the subject's conversation, creating an empty one if it doesn't exist —
  // so callers have a persisted `id` to link questions to (questions.ask({ conversationId })).
  ensure({ subjectType, subjectId }) {
    const st = String(subjectType);
    const sid = String(subjectId);
    const row = repo.find(st, sid) ?? repo.save(st, sid, '[]');
    return present(row, st, sid);
  }

  // Just the messages array (oldest-first) — what a consumer replays to resume.
  messages({ subjectType, subjectId }) {
    return this.get({ subjectType, subjectId }).messages;
  }

  // Overwrite the whole transcript (e.g. the agent hands back its full messages).
  save({ subjectType, subjectId }, messages) {
    assertMessages(messages);
    const row = repo.save(String(subjectType), String(subjectId), JSON.stringify(messages));
    return present(row, subjectType, subjectId);
  }

  append(subject, message) {
    return this.appendMany(subject, [message]);
  }

  // Append messages atomically (read-modify-write the blob inside a transaction
  // so concurrent appends to the same subject don't clobber each other).
  appendMany({ subjectType, subjectId }, messages) {
    assertMessages(messages);
    const st = String(subjectType);
    const sid = String(subjectId);
    const row = getDb().transaction(() => {
      const existing = parseJson(repo.find(st, sid)?.messages) ?? [];
      return repo.save(st, sid, JSON.stringify(existing.concat(messages)));
    })();
    return present(row, st, sid);
  }

  // Reset the transcript to empty (keeps the row).
  clear({ subjectType, subjectId }) {
    return this.save({ subjectType, subjectId }, []);
  }

  // Drop the transcript entirely.
  remove({ subjectType, subjectId }) {
    return repo.remove(String(subjectType), String(subjectId));
  }
}

export const conversations = new ConversationStore();
