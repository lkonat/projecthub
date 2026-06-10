# Extensions

Everything in this directory is loaded at server boot. Restart the server
after adding, editing, or removing any file here.

If a file fails to load — a bad button/hook `id`, an import error, a duplicate,
etc. — the loader **skips it and reports it loudly**: the boot summary shows
`⚠ N FAILED`, followed by a block naming each failure and why. So when a button
or hook doesn't show up, check the end of the server boot log first. (Note: a
button/hook `id` must match `/^[a-z][a-z0-9_-]*$/i` — letters, digits, `_`, `-`,
**no spaces**; the `label` is free-form.)

```
extensions/
├── global/                       # extensions that apply across all types
│   ├── hooks/
│   └── buttons/
├── shared/                       # plain helper modules (ignored by the loader)
│   └── git/clone.js
└── types/
    └── <type-id>/                # one folder per project type
        ├── type.js               # the type definition
        ├── hooks/                # fires only for projects of this type
        └── buttons/              # only shown on projects of this type
```

The folder a file lives in determines its scope:

- A file under `types/<id>/hooks/` or `types/<id>/buttons/` is automatically
  scoped to `type: '<id>'` — you don't need to declare `type:` in the file.
- A file under `global/` runs for every project.
- `shared/` is for code reused by multiple extensions (helpers, third-party
  wrappers, etc.). The loader ignores it; you `import` from it explicitly.

---

## Adding a new project type

```bash
mkdir -p extensions/types/my-type/{hooks,buttons}
```

Then create `extensions/types/my-type/type.js`:

```js
export default {
  id: 'my-type',                 // must match the folder name
  label: 'My type',              // shown in the UI
  description: 'Optional.',
  defaults: {                    // applied when creating, if caller omits them
    priority: 'medium',
    status: 'active',
  },
  fields: [                      // custom fields the user must fill in
    { key: 'owner', label: 'Owner', type: 'text', required: true },
    // type: 'text' | 'textarea' | 'number' | 'date' | 'select' | 'boolean'
    // for 'select', also pass `options: ['a', 'b', ...]`
  ],
};
```

That's enough — restart the server and the type is available everywhere.

### Field coercion

| `type`     | Coerced to            | Notes                                                |
|------------|-----------------------|------------------------------------------------------|
| `text`     | trimmed string        |                                                      |
| `textarea` | trimmed string        | Same as `text`; UI renders a textarea                |
| `number`   | finite number         | Rejects `NaN` / `Infinity`                           |
| `boolean`  | `true` / `false`      | Accepts `'true'`/`'false'`/`'1'`/`'0'`/`'on'`        |
| `date`     | `'YYYY-MM-DD'` string |                                                      |
| `select`   | one of `options[]`    | `options` must be a non-empty string array           |

Field keys must match `/^[a-z][a-z0-9_]*$/i`. Stored as JSON in
`projects.fields` and returned to clients as a nested object.

---

## Hooks

A hook reacts to a lifecycle event. Default export:

```js
// extensions/types/my-type/hooks/welcome-comment.js
export default {
  event: 'project.after-create',          // see events below
  async handler(payload, ctx, settings) { // `settings` (3rd arg): see Per-type settings
    // do stuff
  },
};
```

A hook under `types/<id>/hooks/` automatically only fires for that type. A
hook under `global/hooks/` fires for every project. The optional third
argument `settings` is the project type's settings (or `undefined`) — see
[Per-type settings](#per-type-settings).

### Events

| Event                    | `payload`                          | When                                                                | Errors                            |
|--------------------------|------------------------------------|---------------------------------------------------------------------|-----------------------------------|
| `project.before-create`  | `{ input }`                        | Inside the insert transaction                                       | Throw to cancel — rolls back      |
| `project.after-create`   | `{ project, input }`               | After commit                                                        | Logged; request still succeeds    |
| `project.after-update`   | `{ project, before }`              | After `projectsService.update` commits                              | Logged; request still succeeds    |
| `project.after-delete`   | `{ id, project }`                  | After `projectsService.remove` commits                              | Logged; request still succeeds    |
| `project.focus`          | `{ project, source }`              | A client calls `POST /api/projects/:id/focus`                       | Logged; request still succeeds    |
| `comment.after-create`   | `{ comment, projectId }`           | After a comment is inserted                                         | Logged; request still succeeds    |
| `comment.after-delete`   | `{ id, projectId, comment }`       | After a comment is removed                                          | Logged; request still succeeds    |

`input` is mutable in `before-create` — assign to `payload.input.priority`,
`payload.input.name`, etc. to alter what gets inserted.

### `ctx`

| Key            | What it is                                                                       |
|----------------|----------------------------------------------------------------------------------|
| `ctx.db`       | The live `better-sqlite3` connection (for ad-hoc queries)                        |
| `ctx.log`      | `console`-compatible logger                                                      |
| `ctx.services` | `{ projects, comments }` — call business logic instead of poking the DB         |
| `ctx.realtime` | `{ broadcast(channel, event, payload), broadcastAll(event, payload) }` — push to web clients (see [server/src/realtime/README.md](../server/src/realtime/README.md)) |

`ctx.services.projects` exposes the usual CRUD plus:

- **`updateFields(id, partial)`** — merge-update for the `fields` object.
  Pass only keys you want to change; existing ones are preserved. Pass
  `null` for a key to clear it (required fields still must be set).
  ```js
  ctx.services.projects.updateFields(project.id, { gitClone: '/path/to/repo' });
  ```

- **`updateMeta(id, partial)`** — merge-update for the `meta` object.
  `meta` is free-form project metadata not bound to the type's field
  schema — use it to stash hook/button state (timestamps, cached values,
  counters, etc.) without polluting the user-facing `fields`. Same merge
  semantics as `updateFields`; `null` clears a key.
  ```js
  ctx.services.projects.updateMeta(project.id, {
    lastClonedAt:   new Date().toISOString(),
    lastClonedFrom: gitUrl,
  });
  ```
  `meta` is **not** displayed in the default web view (yet); it's purely
  for code consumers right now.

Hooks fire in filename order (alphabetical) within an event. Prefix with
numbers if order matters: `01-validate.js`, `02-enrich.js`.

---

## Buttons

A button is an on-demand action. It appears in the project detail panel
and runs its `handler` on click. Default export:

```js
// extensions/types/my-type/buttons/promote.js
export default {
  id: 'promote',                       // required, unique, kebab-case
  label: 'Promote',                    // shown in the UI
  confirm: 'Promote this project?',    // optional — browser confirm() prompt
  destructive: false,                  // optional — UI styles the button red
  async handler({ project }, ctx, settings) { // `settings` (3rd arg): Per-type settings
    ctx.services.projects.update(project.id, { priority: 'critical' });
    return { message: 'Promoted' };    // surfaced as a toast in the UI
  },
};
```

A button under `types/<id>/buttons/` only shows on projects of that type.
A button under `global/buttons/` shows on every project.

### Reusable buttons (a library)

When several types need the same action, define the button **once** in the
library at `extensions/shared/buttons/` (a plain button object, no `type`), then
have each type **opt in** from its `type.js` via a `buttons: [...]` array:

```js
// extensions/shared/buttons/clone.js — defined once, type-agnostic
export default { id: 'clone', label: 'Clone', async handler({ project }, ctx) { ... } };
```
```js
// extensions/types/lass-project/type.js
import clone      from '../../shared/buttons/clone.js';
import createRepo from '../../shared/buttons/create-repo.js';

export default {
  id: 'lass-project',
  label: '…',
  buttons: [ clone, createRepo,
             { ...clone, id: 'clone-fork', label: 'Fork & clone' } ], // reuse + override
  fields: [ … ],
};
```

Each entry in `buttons[]` is registered **scoped to that type** — the same
library object can be listed by many types. Per-type tweaks use object spread
(`{ ...clone, label: '…' }`), the composition equivalent of "inherit + override"
— no class hierarchy.

Button identity is **`(type, id)`**, so two types can both use a button with
`id: 'clone'` without colliding. A type's effective buttons are the globals plus
its own; a typed button **shadows** a global one of the same id. The action
endpoint resolves `POST /actions/<id>` against the project's type.

These compose with the folder convention: `types/<id>/buttons/*.js` files still
register for that type alongside whatever the type's `buttons: [...]` lists.

### Conditional display & disabling

Two optional predicates gate a button against the **specific project**. Both
are pure, synchronous functions of the project object (its `fields`, `meta`,
`status`, `priority`, …):

```js
export default {
  id: 'archive',
  label: 'Archive',
  // Hide the button entirely when this returns false. Default: always shown.
  visible: (project) => project.status !== 'archived',
  // Grey it out when this is truthy. Return a STRING to show that text as the
  // disabled tooltip/reason. Default: always enabled.
  disabled: (project) =>
    project.meta?.locked ? 'Project is locked' : false,
  async handler({ project }, ctx) { /* ... */ },
};
```

- `visible(project) → boolean` — `false` drops the button from the list.
- `disabled(project) → boolean | string` — truthy disables it; a string is the
  reason surfaced as a tooltip.

A throwing predicate fails safe (`visible` hides, `disabled` disables) and is
logged. The rules are **enforced server-side**: the action endpoint
re-evaluates them, so a hidden button returns `404 BUTTON_NOT_AVAILABLE` and a
disabled one returns `409 BUTTON_DISABLED` even if a client POSTs directly.

The resolved buttons for a project (type-filtered, hidden ones dropped, each
with its computed `disabled`/`disabledReason`) are available at
`GET /api/projects/<id>/actions` — this is what the web client renders.

### Asking for inputs

A button can prompt the user for values before it runs. `inputs` uses the
**same field schema as a type's `fields`** (`text` · `textarea` · `number` ·
`date` · `select` · `boolean`, plus `required`, `options`, `default`):

```js
export default {
  id: 'create-repo',
  label: 'Create GitHub repo',
  inputs: [
    { key: 'name', label: 'Repository name', type: 'text', required: true,
      // `default` may be a literal OR a function(project), evaluated per
      // project so the form opens pre-filled.
      default: (project) => project.name },
    { key: 'private', label: 'Private repository', type: 'boolean', default: true },
    { key: 'description', label: 'Description', type: 'textarea' },
  ],
  async handler({ project, input }, ctx) {
    // input === { name, private, description } — validated & coerced
  },
};
```

The web client renders a small form (a button with `inputs` opens a modal
instead of running immediately). Values are **validated and coerced
server-side** with the same logic as type fields: bad or missing-required
values return `400`, unknown keys are stripped, and the result is passed to the
handler as the second destructured property: `handler({ project, input }, ctx)`.
Buttons without `inputs` receive `input = {}`.

Send inputs as the JSON body:
`POST /api/projects/<id>/actions/<button-id>` with `{ "name": "thing", … }`.

Invoke from any client: `POST /api/projects/<id>/actions/<button-id>`.
Response:
```json
{ "data": {
  "button":  "promote",
  "project": { ... refreshed project ... },
  "result":  { "message": "Promoted" }
}}
```

Errors thrown by the handler become `500 BUTTON_HANDLER_ERROR` (unless
the error is already an `AppError`, which passes through).

---

## Shared helpers

Anything under `shared/` is just code — the loader ignores it. Import it
from your hooks/buttons:

```js
import gitCloneTool from '../../../shared/git/clone.js';
```

Use this for libraries, wrappers, or tools you call from multiple
extensions. Helpers used by exactly one type can also live inside that
type's folder if you prefer:
`extensions/types/my-type/helpers/foo.js`.

---

## Per-type settings

A project type can carry its own configuration in a `.env` file placed in the
type directory, surfaced through a small hub:

```
types/<id>/
├── type.js
├── .env                 # this type's config (KEY=VALUE)
├── settings/
│   └── settings.js      # the hub — loads ../.env, exposes accessors
├── hooks/
└── buttons/
```

The loader **loads** `types/<id>/settings/settings.js` (if present) and
**injects** its default export into that type's hook and button handlers as the
**third argument**, `settings`. `settings/settings.js` wraps the shared loader:

```js
// types/<id>/settings/settings.js
import { createSettings } from '../../../shared/settings/env.js';
export default createSettings(import.meta.url);   // reads ../.env
```

Handlers receive it alongside `ctx` — no import. It's `undefined` for a type
with no `settings/` folder, so read defensively:

```js
// a hook:   handler(payload, ctx, settings)
// a button: handler({ project, input }, ctx, settings)
async handler({ project }, ctx, settings) {
  const url = project.fields?.gitRepoUrl ?? settings?.get('GIT_URL');
  // settings?.get('GIT_URL') · settings?.require('K') · settings?.bool('F', false)
  // settings?.int('N', 5000) · settings?.values · settings?.typeId · settings?.loaded
}
```

`ctx` stays a memoized, type-agnostic singleton (`log`, `services`, `realtime`,
`db`); `settings` is the per-type config, passed separately so the two never
mix. Need a type's settings outside a handler? `registry.getSettings(typeId)`.

**Precedence** for a key: the type's `.env` wins, then `process.env`, then the
caller's default. The loader uses only Node built-ins (no `dotenv`) since the
extensions tree has no reachable `node_modules`, and it never mutates
`process.env`, so each type's settings stay isolated.

To give another type settings, drop a `settings/settings.js` + `.env` in its
folder — the loader finds them by location and injects automatically. Commit a
`.env.example` as documentation.

---

## Examples in this repo

- `types/client-work/` — required deadline, budget, engagement type. Auto-
  comments on creation, "Mark paid" button.
- `types/othot-swe-work/` — required `repo` field, `Clone` button that
  invokes `shared/git/clone.js` and writes `gitClone` back to the project.
- `types/personal/`, `types/research/` — type-only, no hooks/buttons.
- `global/hooks/log-creation.js` — logs every new project.
- `global/buttons/archive.js`, `bump-priority.js` — apply to any project.
