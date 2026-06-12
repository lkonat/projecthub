// Cancel-Impact agent.
//
// An assignment agent: given a cancelled assignment (and its phase), it asks the
// model for a short impact assessment, then saves that note as the assignment's
// result and resolves it. Call it on demand:
//
//   const note = await ctx.ai.agents.get('cancel-impact').run({ assignment, phase });
//
// It extends AssignmentAgent (the core base for agents that work on an
// assignment), so the `save_task_result` + `resolve_task` tools and the
// save-then-resolve protocol come for free — this file only supplies the
// analyst `instructions()`, the extra `phase` input, and how to render it.
// Base classes come from the core framework (server/src/ai), re-exported through
// the local ../lib/core.js shim; the configured default provider is injected.

import { AssignmentAgent, providerRegistry } from '../lib/core.js';

class CancelImpactAgent extends AssignmentAgent {
  static agentName = 'cancel-impact';      // unique machine name
  static title = 'Cancel Impact Analyst';  // human-friendly display label

  // Self-description (see Agent.js): lets the registry list this agent's
  // capability and lets another agent invoke it via `ctx.ai.agents.asTool(...)`.
  static description =
    'Given a cancelled assignment and its phase, returns a 1–2 sentence note on ' +
    'the likely impact on the phase plus one concrete follow-up to consider.';

  // The call contract: { assignment, phase }. Extends AssignmentAgent's base
  // { assignment } schema with the `phase` context this analyst needs.
  static inputSchema = {
    type: 'object',
    properties: {
      assignment: {
        type: 'object',
        description: 'The cancelled assignment.',
        properties: {
          id: { type: 'number', description: 'Assignment id — pass to the task tools.' },
          title: { type: 'string', description: 'Assignment title.' },
          cancel_reason: { type: 'string', description: 'Why it was cancelled.' },
        },
        required: ['id', 'title'],
      },
      phase: {
        type: 'object',
        description: 'The phase the assignment belonged to.',
        properties: { name: { type: 'string', description: 'Phase name.' } },
      },
    },
    required: ['assignment'],
  };

  // WHAT to do with the assignment. The base systemPrompt() appends the
  // save_task_result → resolve_task protocol around this.
  // instructions() {
  //   return (
  //     'You are a concise project analyst. Given a cancelled assignment and its ' +
  //     'reason, write 1–2 sentences: the likely impact on the phase, and one ' +
  //     'concrete follow-up worth considering. No preamble, no headings.'
  //   );
  // }
  instructions() {
    return (
      'You are a concise project analyst. Given an assignment ' +
      'ask user about the assignment id and reply if the id is correct'
    );
  }
  buildMessages({ assignment, phase }) {
    return [{
      role: 'user',
      content:
        `Phase: ${phase?.name ?? 'unknown'}\n` +
        `Cancelled assignment #${assignment.id}: ${assignment.title}\n` +
        `Reason: ${assignment.cancel_reason ?? '(none given)'}`,
    }];
  }
}

// Built with a provider, per the framework's contract.
export default new CancelImpactAgent({ provider: providerRegistry.default() });
