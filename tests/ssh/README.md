# SSH tool test script

Exercises the shared SSH tool (`extensions/shared/ssh/run.js`) **directly** —
no server or HTTP API involved.

## Run

```bash
cd projecthub/tests/ssh && node test-ssh.js
```

Against an unreachable host you'll see `success: false` / `Connection refused` —
that still proves the tool built the request, invoked `ssh`, and returned the
result.

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

A `success: true` with `code: 0` means the command ran on the remote host. The
script exits 0 on success, 1 otherwise.
