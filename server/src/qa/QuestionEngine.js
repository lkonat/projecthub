import { EventEmitter } from 'node:events';
import { questionsRepository as repo } from './questions.repository.js';
import { conversationsRepository } from './conversations.repository.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';

// QuestionEngine — a standalone "ask a question / request input, get an answer
// later" primitive. One party (e.g. an agent) ASKS; another (e.g. a user) ANSWERS,
// possibly much later — so the question is persisted, not awaited in memory.
//
// It is deliberately domain-agnostic: a question hangs off a polymorphic
// (subjectType, subjectId) pair, and the engine enforces NO authorization — who
// may ask or answer is the consumer's concern. The engine just owns the durable
// record + its state machine, and EMITS events so a consumer can react (e.g.
// resume a paused job when its question is answered).
//
//   pending --answer()--> answered
//   pending --cancel()--> cancelled
//
// The transcript for a subject is simply listFor(subject) (rows oldest-first) —
// a consumer replays it to rebuild context when resuming long-running work.

export const QUESTION_KIND = Object.freeze({
  QUESTION: 'question', // free-text answer
  INPUT:    'input',    // request specific input (options may carry a schema)
  CHOICE:   'choice',   // pick from options
  CONFIRM:  'confirm',  // yes/no
});
const KINDS = Object.freeze(Object.values(QUESTION_KIND));

export const QUESTION_STATUS = Object.freeze({
  PENDING: 'pending',
  ANSWERED: 'answered',
  CANCELLED: 'cancelled',
});

export const QUESTION_EVENT = Object.freeze({
  ASKED:     'question:asked',     // payload: the question (just created)
  ANSWERED:  'question:answered',  // payload: the question (now answered)
  CANCELLED: 'question:cancelled', // payload: the question (now cancelled)
});

const sqlNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19); // 'YYYY-MM-DD HH:MM:SS' (UTC)
const parseJson = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

// Shape a row for callers: parse the JSON columns.
function present(row) {
  if (!row) return null;
  return {
    id: row.id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    conversationId: row.conversation_id ?? null,
    kind: row.kind,
    prompt: row.prompt,
    options: parseJson(row.options),
    status: row.status,
    answer: row.answer,
    meta: parseJson(row.meta),
    created_at: row.created_at,
    answered_at: row.answered_at,
  };
}

export class QuestionEngine extends EventEmitter {
  constructor() {
    super();
    // Consumers may attach many waitFor()/listeners; lift the warning cap.
    this.setMaxListeners(0);
  }

  // Ask a question about a subject. Optionally link it to the conversation it was
  // asked within (conversationId). Returns the pending question; emits ASKED.
  ask({ subjectType, subjectId, prompt, kind = QUESTION_KIND.QUESTION, options = null, meta = null, conversationId = null }) {
    if (!subjectType) throw new ValidationError('subjectType is required');
    if (subjectId === undefined || subjectId === null) throw new ValidationError('subjectId is required');
    if (typeof prompt !== 'string' || !prompt.trim()) throw new ValidationError('prompt is required');
    if (!KINDS.includes(kind)) throw new ValidationError(`kind must be one of: ${KINDS.join(', ')}`);
    if (conversationId != null && !conversationsRepository.findById(conversationId)) {
      throw new ValidationError(`conversation ${conversationId} does not exist`);
    }

    const row = repo.create({
      subjectType: String(subjectType),
      subjectId: String(subjectId),
      kind,
      prompt: prompt.trim(),
      options: options == null ? null : JSON.stringify(options),
      meta: meta == null ? null : JSON.stringify(meta),
      conversationId: conversationId ?? null,
    });
    const question = present(row);
    this.emit(QUESTION_EVENT.ASKED, question);
    return question;
  }

  // Answer a pending question. Returns the answered question; emits ANSWERED.
  answer({ id, answer }) {
    const row = repo.findById(id);
    if (!row) throw new NotFoundError('Question');
    if (row.status !== QUESTION_STATUS.PENDING) {
      throw new ValidationError(`Question ${id} is already ${row.status}`);
    }
    if (answer === undefined || answer === null) throw new ValidationError('answer is required');

    const updated = repo.update(id, {
      status: QUESTION_STATUS.ANSWERED,
      answer: typeof answer === 'string' ? answer : JSON.stringify(answer),
      answered_at: sqlNow(),
    });
    const question = present(updated);
    this.emit(QUESTION_EVENT.ANSWERED, question);
    return question;
  }

  // Cancel a pending question (no answer will come). Emits CANCELLED.
  cancel({ id, reason = null }) {
    const row = repo.findById(id);
    if (!row) throw new NotFoundError('Question');
    if (row.status !== QUESTION_STATUS.PENDING) {
      throw new ValidationError(`Question ${id} is already ${row.status}`);
    }
    const updated = repo.update(id, {
      status: QUESTION_STATUS.CANCELLED,
      answer: reason,
      answered_at: sqlNow(),
    });
    const question = present(updated);
    this.emit(QUESTION_EVENT.CANCELLED, question);
    return question;
  }

  // ── Reads ───────────────────────────────────────────────────────────────
  get(id) {
    return present(repo.findById(id));
  }

  // The full Q&A transcript for a subject, oldest-first.
  listFor({ subjectType, subjectId }) {
    return repo.listBySubject(String(subjectType), String(subjectId)).map(present);
  }

  // Unanswered questions for a subject (oldest-first).
  pendingFor({ subjectType, subjectId }) {
    return repo.pendingBySubject(String(subjectType), String(subjectId)).map(present);
  }

  // Every pending question across all subjects (e.g. an inbox).
  pending() {
    return repo.listByStatus(QUESTION_STATUS.PENDING).map(present);
  }

  // Every question asked within a conversation (oldest-first).
  inConversation(conversationId) {
    return repo.listByConversation(conversationId).map(present);
  }

  // Convenience for an in-process asker that wants to await an answer. Resolves
  // with the question once it leaves 'pending'. NOTE: in-process only — it does
  // NOT survive a restart; durable consumers should listen for ANSWERED instead.
  waitFor(id) {
    const current = this.get(id);
    if (!current) return Promise.reject(new NotFoundError('Question'));
    if (current.status !== QUESTION_STATUS.PENDING) return Promise.resolve(current);
    return new Promise((resolve) => {
      const done = (q) => {
        if (q.id !== id) return;
        this.off(QUESTION_EVENT.ANSWERED, done);
        this.off(QUESTION_EVENT.CANCELLED, done);
        resolve(q);
      };
      this.on(QUESTION_EVENT.ANSWERED, done);
      this.on(QUESTION_EVENT.CANCELLED, done);
    });
  }
}
