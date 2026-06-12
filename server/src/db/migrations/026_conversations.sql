-- conversations — transcript storage for the Q&A engine (server/src/qa/), plus
-- the link from questions to the conversation they belong to.
--
-- A question (025) is one ask/answer; a conversation is the FULL message history
-- an agent accumulates — far too big for a question's `meta`. One row per subject
-- (same polymorphic (subject_type, subject_id) key as questions), holding the
-- whole transcript as a JSON array in `messages`. Each array entry is a RAW
-- provider message (it carries its own `role` plus any tool_use / tool_result
-- blocks), so a run can be replayed exactly. `messages` is TEXT, which holds very
-- large histories (SQLite TEXT ~ up to 1GB).
--
-- It has a surrogate `id` so a question can point at it via conversation_id —
-- a conversation has MANY questions; a question has at most one (NULL when the
-- question is standalone, i.e. not part of an agent transcript). UNIQUE keeps
-- "one conversation per subject" while staying upsertable on the subject key.
-- Standalone and unwired, like the rest of qa/.

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_type TEXT NOT NULL,            -- polymorphic owner kind, e.g. 'assignment'
  subject_id   TEXT NOT NULL,            -- polymorphic owner id (TEXT: accepts any id)
  messages     TEXT NOT NULL DEFAULT '[]', -- JSON array of raw messages (each has a `role`)
  meta         TEXT,                      -- JSON: free-form context for the consumer
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(subject_type, subject_id)
);

-- Optional link: the conversation a question was asked within. NULL for a
-- standalone question. CASCADE so dropping a conversation removes its questions.
-- (Added after conversations exists; the migration runner has foreign_keys OFF.)
ALTER TABLE questions
  ADD COLUMN conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_questions_conversation ON questions(conversation_id);
