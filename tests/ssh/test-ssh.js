#!/usr/bin/env node
//
// One use case: run a command on a remote host using the SSH tool directly
// (no server needed).
//
//   node test-ssh.js
//
// Configure the target with env vars (host is the only one you usually need):
//
//   SSH_HOST   remote host        (default: localhost)
//   SSH_USER   remote user        (default: ssh's default / current user)
//   SSH_KEY    private key path    (default: none — uses agent / ~/.ssh/config)
//   SSH_CMD    command to run      (default: uname -a && whoami)
//
// Example:
//   SSH_HOST=1.2.3.4 SSH_USER=deploy SSH_KEY=~/.ssh/id_ed25519 \
//     SSH_CMD='uptime' node test-ssh.js

const os = require("node:os");
const path = require("node:path");

const sshRunTool = require(path.resolve(
  __dirname,
  "../../extensions/shared/ssh/run.js"
));

const target = {
  host: "example.com",
  username: "jondoe",
  command:"ls",
};

async function main() {

  const r = await sshRunTool.execute(target);

  console.log("success :", r.success);
  console.log("code    :", r.code);
  if (r.stdout) console.log("--- stdout ---\n" + r.stdout.trimEnd());
  if (r.stderr) console.log("--- stderr ---\n" + r.stderr.trimEnd());
  process.exit(r.success ? 0 : 1);
}

main();
