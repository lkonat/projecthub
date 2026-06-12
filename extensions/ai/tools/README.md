# `ai/tools/` — reusable tool definitions

Plain tool definitions for agents to use. The loader scans only `providers/`
and `agents/` (see [`../README.md`](../README.md)), so **nothing here is
auto-loaded** — these are libraries you `import` into an agent's `tools()`
method, exactly like `lib/` and `tasks/`.

A tool is a plain object with the shape the agentic loop expects (see
[`server/src/ai/Agent.js`](../../../server/src/ai/Agent.js)):

```js
{
  name,           // machine name the model calls
  description,    // what it does / when to use it
  input_schema,   // JSON Schema for the call (the wire contract)
  run(input, ctx) // the executor — stripped from the wire schema before send
}
```

`run` receives the agent's `ctx` (`{ log, services, realtime, ai, db }`).
Wire one into an agent:

```js
import resolveTask from '../tools/tasks-tool/resolve-task.js';
import saveResult  from '../tools/tasks-tool/save-result.js';

class MyAgent extends Agent {
  tools() { return [resolveTask, saveResult]; }
}
```

## `tasks-tool/`

Tools for acting on a **task** (an assignment). Both write run state through
`assignmentsService.recordRun` with the `SYSTEM` actor — the same trusted,
in-process path the agent runner uses for run-state writes.

- [`resolve-task.js`](./tasks-tool/resolve-task.js) — set the assignment to
  `completed` (may complete its phase) or `failed` (records the error; failed
  isn't "done", so the phase stays open to retry).
- [`save-result.js`](./tasks-tool/save-result.js) — persist a task's result
  without changing its status.
