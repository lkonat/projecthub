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
| DELETE | `/api/comments/:id`               | Delete comment                |
| GET    | `/api/ssh`                        | List saved SSH connections    |
| POST   | `/api/ssh`                        | Save a connection             |
| GET    | `/api/ssh/:id`                    | Get one                       |
| PATCH  | `/api/ssh/:id`                    | Update                        |
| DELETE | `/api/ssh/:id`                    | Delete                        |
| POST   | `/api/ssh/:id/run`               | Run a command on a saved connection |
| POST   | `/api/ssh/run`                    | Run a command on an inline host (nothing saved) |

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

Connect to a remote host and run a command. Auth is **key-based only** — ssh
runs with `BatchMode=yes`, so it never blocks on a password prompt; point it at
a key with `identityFile` or rely on your ssh-agent / `~/.ssh/config`.

```bash
# Ad-hoc: run a command without saving anything
curl -s localhost:3005/api/ssh/run -H 'Content-Type: application/json' \
  -d '{"host":"1.2.3.4","username":"deploy","command":"uptime","identityFile":"/Users/me/.ssh/id_ed25519"}'

# Save a connection, then run against it by id
curl -s localhost:3005/api/ssh -H 'Content-Type: application/json' \
  -d '{"name":"prod","host":"1.2.3.4","username":"deploy","port":22}'

curl -s localhost:3005/api/ssh/1/run -H 'Content-Type: application/json' \
  -d '{"command":"systemctl status nginx"}'
```

The run response carries `{ success, code, stdout, stderr, timedOut }`.
`success` is true only when the remote command exits 0.
