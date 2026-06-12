// The Q&A engine's public surface. Import the singleton `questions` to ask /
// answer; import QUESTION_EVENT to listen. The engine is standalone — nothing in
// the app wires it yet.
//
//   import { questions, QUESTION_EVENT } from '../qa/index.js';
//   const q = questions.ask({ subjectType: 'thing', subjectId: id, prompt: '…' });
//   questions.on(QUESTION_EVENT.ANSWERED, (q) => { /* resume work for q.subjectId */ });
//   questions.answer({ id: q.id, answer: '…' });

import { QuestionEngine } from './QuestionEngine.js';
import { ConversationStore } from './ConversationStore.js';

export { QuestionEngine, QUESTION_EVENT, QUESTION_KIND, QUESTION_STATUS } from './QuestionEngine.js';
export { questionsRepository } from './questions.repository.js';
export { ConversationStore } from './ConversationStore.js';
export { conversationsRepository } from './conversations.repository.js';

// Process-wide singletons: `questions` (ask/answer, with events) and
// `conversations` (the durable message transcript per subject).
export const questions = new QuestionEngine();
export const conversations = new ConversationStore();
