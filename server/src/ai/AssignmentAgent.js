import { Agent } from './Agent.js';
import { assignmentAgentTools } from './AssignmentAgent.tools.js';

// AssignmentAgent — a base Agent for agents that work on an assignment.
//
// It pre-wires the `finish_assignment` signal tool, so the model can declare the
// outcome when it's done: `finish_assignment` with outcome 'succeed' (and the
// result) or 'fail' (and a reason). That tool does NOT touch the database — it
// EMITS the outcome on the agent (`assignment:succeeded` / `assignment:failed`).
// Persistence is a listener's job: the runner attaches one and maps the event to
// assignmentsService.recordRun. So the agent/tool stay decoupled from storage.
//
// A concrete assignment agent just extends this and overrides `instructions()`
// (what to do) — and, if it needs more capabilities, `extraTools()`:
//
//   import { AssignmentAgent, providerRegistry } from '../lib/core.js';
//
//   class SummarizeAssignmentAgent extends AssignmentAgent {
//     static agentName  = 'summarize-assignment';
//     static title      = 'Assignment Summarizer';
//     static description = 'Summarizes the assignment and finishes with the summary.';
//     instructions() { return 'Write a one-paragraph summary of the assignment.'; }
//   }
//   export default new SummarizeAssignmentAgent({ provider: providerRegistry.default() });
//
// Like EventAgent, this is a base class in the core framework — concrete
// subclasses live in extensions/ai/agents/ and get auto-registered there.
//
// Persistence note: the emitted outcome is only written to storage if something
// is LISTENING. The queue runner listens (and also projects accepted →
// in_progress → failed onto the status from the job lifecycle). A direct,
// off-queue run emits the signal but persists nothing unless the caller attaches
// its own listener — the deliberate trade-off of decoupling the tool from the DB.

export class AssignmentAgent extends Agent {
  static agentName = 'assignment-agent';

  // The call contract: run({ assignment }). The assignment's `id` is what the
  // task tools key on, so the model must see it (buildMessages surfaces it).
  static inputSchema = {
    type: 'object',
    properties: {
      assignment: {
        type: 'object',
        description: 'The assignment to work on.',
        properties: {
          id:          { type: 'number', description: 'Assignment id — pass this to the task tools.' },
          title:       { type: 'string', description: 'Assignment title.' },
          description: { type: 'string', description: 'Assignment details, if any.' },
        },
        required: ['id', 'title'],
      },
    },
    required: ['assignment'],
  };

  // ── Subclass hooks ────────────────────────────────────────────────────────

  // WHAT this agent should do with the assignment. Override per agent. The
  // standard finish protocol is appended by systemPrompt() below.
  instructions(_input, _ctx) {
    return 'Complete the assignment described by the user.';
  }

  // Agent-specific tools, merged after the signal tool. Override to add more.
  extraTools(_input, _ctx) {
    return [];
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  // The signal tools every assignment agent gets (defined in AssignmentAgent.tools.js,
  // next to this class): announce the outcome when done.
  taskTools() {
    return assignmentAgentTools;
  }

  tools(input, ctx) {
    return [...this.taskTools(), ...(this.extraTools(input, ctx) || [])];
  }

  systemPrompt(input, ctx) {
    return (
      `${this.instructions(input, ctx)}\n\n` +
      "Protocol: when you have finished, call finish_assignment with outcome " +
      "'succeed' and your output in `result`. If you cannot complete the " +
      "assignment, call finish_assignment with outcome 'fail' and a short `error` " +
      'explaining why. Always end by calling finish_assignment exactly once.'
    );
  }

  buildMessages({ assignment }, _ctx) {
    return [{
      role: 'user',
      content:
        `Assignment #${assignment.id}: ${assignment.title}\n` +
        (assignment.description ? `Details: ${assignment.description}\n` : '') +
        '\nWork on this assignment, then call finish_assignment with the outcome.',
    }];
  }
}

export default AssignmentAgent;
