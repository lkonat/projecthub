# `qa/` — the Question & Answer engine

A standalone primitive for **"ask a question / request input now, get an answer
later."** One party asks; another answers — possibly minutes later, possibly
after a restart — so a question is a **persisted record**, not an in-memory
await. The engine owns that record, its small state machine, and an event bus;
it knows nothing about who's asking, who's answering, or what the subject is.

It is **not wired into anything yet** — built to be applied to a feature later
(the first intended consumer is agent runs that need human input mid-task).

## Model

A question hangs off a polymorphic **subject** `(subjectType, subjectId)` — e.g.
`('assignment', '42')` — so any feature attaches Q&A to its own entities without
the engine depending on them. (See migration `025_questions.sql`.)

```
pending ──answer()──▶ answered
pending ──cancel()──▶ cancelled
```

The **transcript** of a subject is just `listFor(subject)` (rows oldest-first) —
replay it to rebuild context when resuming long-running work.

## API

```js
import { questions, QUESTION_EVENT } from '../qa/index.js';

const q = questions.ask({                 // → pending question, emits ASKED
  subjectType: 'assignment', subjectId: 42,
  prompt: 'Which environment should I deploy to?',
  kind: 'choice', options: ['staging', 'prod'],   // kind ∈ question|input|choice|confirm
  meta: { runId: 7 },                              // free-form context for the consumer
});

questions.answer({ id: q.id, answer: 'staging' }); // → answered, emits ANSWERED
questions.cancel({ id: q.id, reason: 'obsolete' }); // → cancelled, emits CANCELLED

questions.get(id);
questions.listFor({ subjectType, subjectId });     // full transcript (oldest-first)
questions.pendingFor({ subjectType, subjectId });  // unanswered for one subject
questions.pending();                               // every pending question (inbox)
await questions.waitFor(id);                        // in-process await (NOT restart-durable)
```

`ask`/`answer`/`cancel` are synchronous DB writes that return the shaped question
(`options`/`meta` parsed from JSON). They **emit** `QUESTION_EVENT.{ASKED,
ANSWERED,CANCELLED}` with the question as payload.

## Conversations (transcripts)

A question is one ask/answer; a **conversation** is the full message history an
agent accumulates — far too big for a question's `meta`. `conversations` stores
one transcript per subject (same `(subjectType, subjectId)` key) as a JSON array
of **raw provider messages** (each carries its own `role` plus any tool_use /
tool_result blocks), so a run can be replayed exactly when resuming.

```js
import { conversations } from '../qa/index.js';

const subject = { subjectType: 'assignment', subjectId: 42 };
conversations.append(subject, { role: 'user', content: 'Deploy where?' });
conversations.appendMany(subject, [{ role: 'assistant', content: '…' }]);
conversations.save(subject, fullMessagesArray); // overwrite (e.g. agent hands back its messages)
conversations.messages(subject);                // ordered transcript → replay to resume
conversations.get(subject);                     // { messages, meta, timestamps }
conversations.clear(subject);                   // empty it (keep the row)
conversations.remove(subject);                  // drop it
```

Appends are atomic (read-modify-write the blob in a transaction). The only
constraint on a stored message is that it's an object with a string `role` — the
rest is whatever the provider produced. It's a plain store (no events); resume is
driven by `QUESTION_EVENT.ANSWERED`, not by message appends.

### Linking questions to a conversation

A question may belong to the conversation it was asked within (a conversation has
many questions; a question has at most one — `conversationId` is `null` for a
standalone ask). Use `ensure()` to get the conversation's `id`, then pass it to
`ask()`:

```js
const conv = conversations.ensure(subject);          // persisted; conv.id is set
questions.ask({ ...subject, prompt: '…', conversationId: conv.id });
questions.inConversation(conv.id);                    // all questions in that conversation
```

`ask()` rejects a `conversationId` that doesn't exist. Deleting a conversation
cascades to its questions (FK `ON DELETE CASCADE`).

## Authorization

None. The engine never checks who may ask or answer — that's the consumer's job
(e.g. "only the project owner may answer this assignment's questions"). Keeping
auth out is what makes the engine reusable across features.

## How a consumer wires it (future, illustrative — not built)

```js
// 1. Ask when work needs input (e.g. from the agent's input:request event):
const q = questions.ask({ subjectType: 'assignment', subjectId, prompt, meta: { … } });
//    …and park the work (set the assignment 'waiting').

// 2. Resume when answered — durable path is the event, not waitFor():
questions.on(QUESTION_EVENT.ANSWERED, (q) => {
  if (q.subjectType !== 'assignment') return;
  // replay questions.listFor(q) into the agent's context and re-enqueue the run.
});

// 3. Expose: surface questions.pendingFor(subject) in an API/UI; an answer
//    endpoint calls questions.answer({ id, answer }) after checking permissions.
```

## Files

- `QuestionEngine.js` — the question engine (state machine + events). Exports the
  class plus the `QUESTION_KIND` / `QUESTION_STATUS` / `QUESTION_EVENT` enums.
- `questions.repository.js` — `questions` table data access (raw rows).
- `ConversationStore.js` — the transcript store (one JSON blob of raw messages
  per subject).
- `conversations.repository.js` — `conversations` table data access.
- `index.js` — the public surface; exports the `questions` and `conversations`
  singletons.
