# SSH API test script

One use case: run a command on a remote host through the ProjectHub API
(`POST /api/ssh/run`).

## Run

```bash
# 1. start the server
cd projecthub/server && npm start          # http://localhost:3005

# 2. run the test (in another shell)
cd projecthub/tests/ssh && node test-ssh.js
```

With no config it targets `localhost`, so on a Mac without Remote Login you'll
see `success: false` / `Connection refused` — that still proves the API received
the request, invoked `ssh`, and returned the result.

## Point it at a real target

```bash
SSH_HOST=your.server.com SSH_USER=deploy SSH_KEY=~/.ssh/id_ed25519 \
  SSH_CMD='uptime' node test-ssh.js
```

| Var        | Meaning                    | Default                 |
|------------|----------------------------|-------------------------|
| `SSH_HOST` | remote host                | `localhost`             |
| `SSH_USER` | remote user                | ssh default / current   |
| `SSH_KEY`  | private key path (`~` ok)  | none (agent/`~/.ssh`)   |
| `SSH_CMD`  | command to run             | `uname -a && whoami`    |
| `API_URL`  | server base url            | `http://localhost:3005` |

A `success: true` with `code: 0` means the command ran on the remote host. The
script exits 0 on success, 1 otherwise.
