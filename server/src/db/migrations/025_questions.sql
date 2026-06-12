-- questions — storage for the standalone Q&A engine (server/src/qa/).
--
-- A generic "ask a question / request input, get an answer later" primitive,
-- deliberately NOT tied to assignments or agents. A question belongs to some
-- subject via a polymorphic (subject_type, subject_id) pair — e.g.
-- ('assignment', '42') — so any feature can attach Q&A to its own entities.
--
-- Lifecycle: pending --answer--> answered, or pending --cancel--> cancelled.
-- The row IS the durable transcript: ordering rows by id for a subject replays
-- the full back-and-forth, which a consumer uses to resume long-running work.
-- Nothing references this table yet; the engine is unwired by design.

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_type TEXT NOT NULL,            -- polymorphic owner kind, e.g. 'assignment'
  subject_id   TEXT NOT NULL,            -- polymorphic owner id (TEXT: accepts any id)
  kind TEXT NOT NULL DEFAULT 'question'
    CHECK(kind IN ('question','input','choice','confirm')),
  prompt  TEXT NOT NULL,                 -- the question / input request shown to the responder
  options TEXT,                          -- JSON: choices or an input schema (for choice/input)
  status  TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','answered','cancelled')),
  answer  TEXT,                          -- the response (text, or JSON string)
  meta    TEXT,                          -- JSON: free-form context for the consumer
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  answered_at TEXT                       -- when answered/cancelled (terminal)
);

CREATE INDEX IF NOT EXISTS idx_questions_subject ON questions(subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_questions_status  ON questions(status);
