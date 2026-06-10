# ProjectHub

Personal project tracker. All business logic lives in the backend so any interface (web, CLI, mobile, scripts) can drive the same system.

## Stack
- Node.js + Express
- SQLite (better-sqlite3)
- Vanilla JS browser client (one of many possible interfaces)

## Run

```bash
cd server
npm install
npm run setup   # runs migrations
npm start       # http://localhost:3005
```

Open `http://localhost:3005` for the default web view.

## Project layout

```
projecthub/
├── client/                       # the web interface (thin)
│   ├── index.html
│   ├── app.js
│   └── styles.css
└── server/
    ├── data/                     # sqlite db lives here
    └── src/
        ├── index.js              # entry point
        ├── app.js                # express wiring
        ├── config/               # env-driven config
        ├── db/
        │   ├── connection.js
        │   ├── migrate.js        # auto-runs on boot
        │   └── migrations/*.sql
        ├── middleware/
        │   ├── errorHandler.js
        │   └── validate.js
        ├── routes/
        │   └── index.js          # central API router
        ├── modules/              # feature modules
        │   ├── projects/         # repo -> service -> controller -> routes
        │   └── comments/
        └── utils/
            └── errors.js
```

### Adding a new module
1. Create `server/src/modules/<name>/` with `*.repository.js`, `*.service.js`, `*.controller.js`, `*.routes.js`.
2. Add a migration in `server/src/db/migrations/` (e.g. `002_tags.sql`).
3. Mount the router in `server/src/routes/index.js`.

Each layer has one job:
- **Repository** — SQL only, no validation.
- **Service** — business rules, throws domain errors.
- **Controller** — HTTP shape (req/res), no business logic.
- **Routes** — URL → controller wiring.

## Access control

All authorization is defined in **one place**: `server/src/access/policy.js`. It's a
plain data table mapping each action to the roles allowed to perform it (OR
semantics):

```js
export const POLICY = {
  'project.edit':      ['owner'],
  'comment.create':    ['owner', 'assignee'],         // anyone assigned can comment
  'assignment.update': ['owner', 'assignmentOwner'],  // assignees edit their OWN assignments
  // ...
};
```

Roles are derived per request, never stored: `owner` (owns the project),
`assignee` (has any assignment in it), `assignmentOwner` / `commentOwner` (owns
the specific item in play).

**Authorization lives in the SERVICES, not the controllers** — because the
service layer is the universal API (web today, CLI/agents later all call
services directly). Every principal-initiated service method takes an `actor`
as its first argument and authorizes via the policy:

```js
// access.service.js
access.authorize(actor, projectId, 'comment.create');   // throws, or returns the project
```

- **Actors** (`server/src/access/actor.js`): `userActor(id)`, `agentActor(id)`,
  and `SYSTEM`. The web controllers are thin adapters that build `userActor(req.user.id)`
  and delegate; a CLI/agent builds its own actor and calls the same methods.
- **`SYSTEM`** is the trusted internal lane — it bypasses the policy. Cascades
  (e.g. auto-closing a project when its last phase completes) and extension code
  (`ctx.services.*`, which is SYSTEM-bound) run as SYSTEM. That's why the
  auto-close can write `project.status` even though the assignee who triggered
  it isn't allowed to edit the project.
- **`get(id)`** on a service is the actor-less internal fetch (existence checks,
  service-to-service calls); it does NOT authorize. Principal reads use an
  authorized method (e.g. `projectsService.view(actor, id)`).
- **Add/change a rule** = edit one line in `POLICY`. The matrix is served at
  `GET /api/policy`, and per-project capability flags ride on
  `GET /api/projects/:id` (`data.capabilities`) so the web client shows/hides
  affordances from the exact rules the server enforces.

To grant a non-owner a new ability you usually just add a role to a line in
`POLICY` — no service or controller changes needed.

## API

| Method | Path                              | Purpose                       |
|--------|-----------------------------------|-------------------------------|
| GET    | `/api/health`                     | Health check                  |
| GET    | `/api/projects/meta`              | Allowed priorities & statuses |
| GET    | `/api/projects`                   | List (filter: `priority`, `status`, `sort`) |
| POST   | `/api/projects`                   | Create                        |
| GET    | `/api/projects/:id`               | Get one                       |
| PATCH  | `/api/projects/:id`               | Update                        |
| DELETE | `/api/projects/:id`               | Delete (cascades to comments) |
| GET    | `/api/projects/:id/comments`      | List comments                 |
| POST   | `/api/projects/:id/comments`      | Add comment                   |
| DELETE | `/api/comments/:id`               | Delete comment (owner or author) |
| GET    | `/api/me/assignments`             | My assignments (`?scope=current`) |
| GET    | `/api/users`                      | Account directory (assignee picker) |
| GET    | `/api/policy`                     | Access-control matrix (action → roles) |

### Examples

```bash
curl -s localhost:3005/api/projects -H 'Content-Type: application/json' \
  -d '{"name":"Tax filing","priority":"high"}'

curl -s 'localhost:3005/api/projects?priority=high&status=active'

curl -s localhost:3005/api/projects/1/comments -H 'Content-Type: application/json' \
  -d '{"body":"Found receipts in the drawer"}'
```

Priorities: `low`, `medium`, `high`, `critical`
Statuses:  `active`, `paused`, `completed`, `archived`

### SSH

There is no SSH HTTP API. SSH is a stateless shared tool —
`extensions/shared/ssh/run.js` — that a hook or button imports and calls with
connection details per invocation (nothing is persisted). Auth is **key-based
only** (`BatchMode=yes`, never blocks on a password prompt): pass a key via
`identityFile` or rely on your ssh-agent / `~/.ssh/config`.

```js
import sshRunTool from '../../../shared/ssh/run.js';
const r = await sshRunTool.execute({
  host: '1.2.3.4', username: 'deploy', command: 'uptime',
  identityFile: '/Users/me/.ssh/id_ed25519',
});
// r = { success, code, stdout, stderr, timedOut }  — success is true only on exit 0
```
