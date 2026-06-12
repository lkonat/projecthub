# `ai/` — the AI layer

Everything ProjectHub does with LLMs lives here. The **framework** (the stable
abstractions the system depends on) lives in `server/src/ai/`; the **pluggable
implementations** — providers and agents — live in this directory and are
auto-registered by the extension loader. **Adding a provider or an agent is a
drop-in file; no core edits.**

```
server/src/ai/            ← core contracts (the system depends on THESE)
  LLMProvider.js          ← provider interface (normalizes one vendor SDK)
  Agent.js                ← base agentic class (the agentic loop)
  EventAgent.js           ← Agent bound to a lifecycle event
  providerRegistry.js     ← swap point for providers (AI_PROVIDER env)
  agentRegistry.js        ← holds agents; auto-binds event agents to the bus

extensions/ai/            ← THIS directory: the pluggable implementations
  lib/core.js             ← re-exports the core contracts (one stable import path)
  providers/*.js          ← LLM providers (anthropic, openai) — auto-loaded
  agents/*.js             ← agent modules (Agent instances)   — auto-loaded
  tasks/*.js              ← legacy standalone helpers           — NOT auto-loaded
  node_modules/           ← SDKs (@anthropic-ai/sdk, openai)
  package.json            ← scopes the whole folder to ESM + pins the SDKs
```

## What the loader does

On boot the loader scans exactly two folders here:

- every `providers/*.js` → registered as an **LLM provider**
- every `agents/*.js` whose default export is an `Agent` → registered as an **agent**

`lib/`, `tasks/`, `node_modules/`, and anything else are left alone — they're
libraries you `import` explicitly. Restart the server after adding, editing, or
removing a file. Load failures are reported loudly in the boot summary (see the
top-level [`extensions/README.md`](../README.md)).

## The one import path

Provider and agent files import their base classes from `./lib/core.js` (a thin
re-export of `server/src/ai/index.js`) instead of reaching into the server's
internals. That keeps the single cross-boundary path in one file — if the core
moves, only `lib/core.js` changes.

```js
import { Agent, EventAgent, LLMProvider, providerRegistry } from '../lib/core.js';
```

## Dependency inversion

`Agent` depends only on `LLMProvider`, never on a concrete SDK. Switch the model
vendor with config, not code via `AI_PROVIDER`. The shipped providers are
`ollama` (local, **the default**), `anthropic`, and `openai` — set
`AI_PROVIDER=anthropic` (plus `ANTHROPIC_API_KEY`) to use a hosted model instead.

## Add a provider

Create `providers/<id>.js`:

```js
import { LLMProvider } from '../lib/core.js';
class MyProvider extends LLMProvider {
  static id = 'myvendor';
  get capabilities() { return { tools: true, structured: true, streaming: true }; }
  async complete({ model, system, messages, tools, maxTokens }) { /* → { text, toolCalls, raw } */ }
  async generateStructured({ schema, ... }) { /* → { text, parsed, raw } */ }
  appendAssistant(messages, response) { /* native assistant turn */ }
  appendToolResults(messages, results) { /* native tool-result turn */ }
}
export default new MyProvider();
```

## Add an agent

Create `agents/<name>.js`. A **task agent** extends `Agent` and is invoked
explicitly; an **event agent** extends `EventAgent`, sets `static event`, and
auto-binds to that lifecycle event (e.g. `assignment.after-cancel`,
`phase.after-activate`).

An agent always needs a provider — inject one at construction:
`new MyAgent({ provider: providerRegistry.default() })` (swappable via
`AI_PROVIDER`) or a specific provider from `./providers/`.

```js
// agents/cancel-impact.js  — a task agent, invoked on demand
import { Agent, providerRegistry } from '../lib/core.js';
class CancelImpactAgent extends Agent {
  static agentName = 'cancel-impact';
  systemPrompt() { return 'You are a concise project analyst…'; }
  buildMessages({ assignment, phase }) {
    return [{ role: 'user', content: `Phase: ${phase?.name}\nTask: ${assignment.title}\nReason: ${assignment.cancel_reason}` }];
  }
}
export default new CancelImpactAgent({ provider: providerRegistry.default() });
```

```js
// agents/cancel-impact.js  — the same idea as an EventAgent, fired automatically
import { EventAgent } from '../lib/core.js';
export default new (class extends EventAgent {
  static agentName = 'cancel-impact';
  static event = 'assignment.after-cancel';
  shouldRun({ assignment }) { return !!assignment?.cancel_reason; }
  buildInput({ assignment }) { return `Summarize the impact of cancelling "${assignment.title}".`; }
  systemPrompt() { return 'You are a concise project analyst.'; }
  async onResult(text, payload, ctx) { /* post a comment via ctx.services, etc. */ }
})();
```

Override the small hooks as needed: `systemPrompt`, `buildMessages`, `tools`
(for tool use), `responseSchema` (for structured output), `parseResult`.

Call a registered agent on demand from any hook/button/route:

```js
const note = await ctx.ai.agents.get('cancel-impact').run({ assignment, phase });
```

[`agents/cancel-impact.js`](./agents/cancel-impact.js) is the working example.

## Self-describing agents (so the system can use them by capability)

An agent's name alone says nothing about what it does or what it expects. Give
it a **contract** — two static fields — and it becomes describable and callable
the same way a tool is:

```js
class CancelImpactAgent extends Agent {
  static agentName  = 'cancel-impact';
  static description = 'Given a cancelled assignment + its phase, returns a 1–2 sentence impact note.';
  static inputSchema = { type: 'object', properties: { assignment: {...}, phase: {...} }, required: ['assignment'] };
  // …
}
```

Set these on any agent meant to be **composed into another agent** or **chosen
by a router**. They power two things:

- **Capability catalog.** `ctx.ai.agents.describe()` returns
  `[{ name, description, inputSchema, event }]` for every registered agent — a
  rule-based dispatcher or an LLM "orchestrator" agent reads this to route work
  by capability.

- **Agents triggering agents.** `ctx.ai.agents.asTool(name)` (or
  `agent.asTool()`) wraps an agent as a `{ name, description, input_schema, run }`
  tool def. Drop it into another agent's `tools()` and the agentic loop invokes
  it like any tool — *an agent is just a tool whose body is another agentic
  loop*. No separate orchestration system.

```js
class TriageAgent extends Agent {
  static agentName = 'triage';
  tools(_input, ctx) {
    return [ ctx.ai.agents.asTool('cancel-impact') ]; // compose another agent
  }
}
```

### Guards on agent-to-agent calls

`run()` threads a `ctx.agentStack` through nested calls and enforces two limits,
so a composed graph can't melt down:

- **Cycle** — re-entering an agent already on the stack throws
  `Agent cycle detected: a → b → a`.
- **Depth** — chains deeper than `ctx.maxAgentDepth` (default **8**) throw.

`maxIterations` still bounds each *single* loop; these bound the *chain across
agents*. Note the failure contract: an `EventAgent` swallows its own errors so it
never breaks the triggering operation — but an agent invoked **as a tool**
propagates, surfacing to the caller as a tool-result error string.

## Setup

**Default: Ollama (local).** `AI_PROVIDER=ollama` and `OLLAMA_MODEL=llama3.2:3b`
are set in `server/.env`. It talks to a local Ollama install via the built-in
`fetch` (no SDK, no API key, no egress) at `OLLAMA_HOST` (default
`http://localhost:11434`) — just run `ollama serve`. Switch models with
`OLLAMA_MODEL` (e.g. `qwen3:8b`; `<think>` reasoning blocks are stripped).

**Hosted providers.** Set `AI_PROVIDER=anthropic` (+ `ANTHROPIC_API_KEY`) or
`openai` (+ `OPENAI_API_KEY`). Their SDK clients are created lazily, so boot
never requires a key — a missing key fails loudly at first call. Install the SDK
deps with `npm install` inside `extensions/ai/` (declared in
[`package.json`](./package.json)); Ollama needs none.

## Registered into the database (assignable agents)

Loading an agent registers it in the in-memory registry. On boot the server then
**syncs every registered agent into the `agents` table** (see
`server/src/modules/agents/`), so each one is a first-class, assignable entity —
an assignment can target it via `assignee_type: 'agent'` + `assignee_agent_id`.

Each agent has two names: a **unique** `slug` (its registry name / `agentName`,
e.g. `cancel-impact` — the registry rejects duplicates, so it's unique
system-wide and is the stable key for sync + assignment FKs) and a free-form
**`title`** for display (`static title`, e.g. `Cancel Impact Analyst`; defaults
to the slug). The title is the default assignee label.

The sync keys on the `slug`: new agents are inserted, existing ones have their
`title`/`description`/`inputSchema`/`event` refreshed, and a row whose code has
disappeared is marked `status: 'missing'` (never deleted, so historical
assignments keep resolving). `GET /api/agents` lists the assignable ones.

Agents are **global, not project-scoped**: the `agents` table has no owner or
project column, so every registered agent can be assigned to a task in **any
project** (the picker at `GET /api/agents` returns the same list everywhere).
Who may put an agent on a task is governed by the usual `assignment.create`
rule — the project owner.

### Agent-run data: the `agent_assignments` extension

When an assignment is agent-typed, it gets a **1:1 extension row** in
`agent_assignments` (shared primary key `assignment_id`; see
`server/src/modules/assignments/`). The assignment's outward
`status` (pending/accepted/in_progress/blocked/waiting/completed/failed/cancelled/
rejected) is the single source of truth for the lifecycle, agent runs included.
The extension holds the agent-execution **payload** plus one finer-grained state:
`execution_state` — the agent's internal run-loop state
(idle/planning/executing/waiting_permission/waiting_tool/retrying/paused/error),
a different axis from `status` — alongside `input`, `result`, `error`, `model`,
token `usage`, `attempts`, and run timing. The extension has **no timestamps of
its own** — it's part of the assignment, so the parent's `created_at`/`updated_at`
are authoritative. The row is created with the agent assignment, dropped if it's
reassigned to a user/bot, and cascade-deleted with the assignment (all inside a
transaction, so the 1:1 never diverges). It's surfaced as `assignment.agent` in
`GET /phases/:id/assignments`.

The extension is owned by the **same service** as the assignment:
`assignmentsService.recordRun({ actor, assignmentId, status, runFields })` updates
the assignment's `status` and/or the extension payload **atomically**, and is
**authorized** like any run operation (`assignment.run` on the project — the runner
passes the `SYSTEM` actor, which bypasses the policy). `status` is written directly
to the assignment; a done status (`completed`/`cancelled`) re-evaluates the phase,
exactly like a manual resolve — it may complete the phase and advance the project.
`assignmentsService.getAgentRun(id)` reads the payload. (Assignments also carry a
denormalized, immutable `project_id`, so agent work can be queried per project
without joining through phases.)

## Running agents: the runner engine + job queue

Agents are invoked through a **runner engine** (`server/src/ai/runner/`) on top
of a **generic job queue** (`server/src/queue/`, see its README). The split is
deliberate: the queue handles scheduling, **bounded concurrency** (so the system
isn't overwhelmed), priority, durability, and retry/backoff — knowing nothing
about AI; the engine handles the agent-specific work.

```
POST /api/assignments/:id/run        (owner-gated: the `assignment.run` policy)
  → agentRunner.run(assignmentId, { priority })
  → status = 'accepted'  +  queue.enqueue('agent-run', { assignmentId }, { priority, key, maxAttempts })

queue worker (≤ QUEUE_CONCURRENCY at once, highest priority first)
  → engine handler: load agent + build input/ctx → agentRegistry.get(slug).run(input, ctx)
  → job lifecycle events project onto assignments.status:
       started → in_progress · retrying → accepted · failed → failed (+error)
  → success is left to the agent (an AssignmentAgent marks 'completed' via resolve_task)
```

- **Priority** defaults from the project's priority (critical 30 / high 20 /
  medium 10 / low 0); override per call with `{ priority }`.
- **Retry** up to 3 attempts with exponential backoff (transient LLM/network
  errors); `attempts` is tracked.
- **Dedup** by `agent-run:<assignmentId>` — a second run request while one is
  active returns the existing job, so an assignment can't run twice at once.
- **Durable** — queued/running jobs survive a restart; interrupted runs are
  recovered and re-run at boot.
- **Trigger is explicit** (the endpoint). Auto-running on assignment is an easy
  future extension (an `assignment.after-create` hook that calls
  `agentRunner.run`).

## `tasks/` — legacy standalone helpers

`tasks/phase-planner.js` and `tasks/status-reporter.js` predate the
provider/Agent framework. They call Claude directly via `tasks/client.js`
(`export default { name, run }`) and are **not** auto-registered — `import` and
call them like any library. They're left as-is intentionally; port them to
extend `Agent` when convenient (they'll then auto-register as agents).
