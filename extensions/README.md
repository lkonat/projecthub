# Extensions

Everything in this directory is loaded at server boot. Restart the server
after adding, editing, or removing any file here.

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
  async handler(payload, ctx) {
    // do stuff
  },
};
```

A hook under `types/<id>/hooks/` automatically only fires for that type. A
hook under `global/hooks/` fires for every project.

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
  async handler({ project }, ctx) {
    ctx.services.projects.update(project.id, { priority: 'critical' });
    return { message: 'Promoted' };    // surfaced as a toast in the UI
  },
};
```

A button under `types/<id>/buttons/` only shows on projects of that type.
A button under `global/buttons/` shows on every project.

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

## Examples in this repo

- `types/client-work/` — required deadline, budget, engagement type. Auto-
  comments on creation, "Mark paid" button.
- `types/othot-swe-work/` — required `repo` field, `Clone` button that
  invokes `shared/git/clone.js` and writes `gitClone` back to the project.
- `types/personal/`, `types/research/` — type-only, no hooks/buttons.
- `global/hooks/log-creation.js` — logs every new project.
- `global/buttons/archive.js`, `bump-priority.js` — apply to any project.
