// extensions/shared/ssh/run.js
//
// Runs a command on a remote host over SSH and returns the result.
// Mirrors the git tools: shells out to the system `ssh` binary via spawn
// rather than pulling in an SSH library, so there's nothing to install.
//
// Authentication is key-based only. We pass `BatchMode=yes` so ssh never
// drops to an interactive password/passphrase prompt — if the key isn't
// accepted the command fails fast with a clear error instead of hanging.
// Point `identityFile` at a private key, or rely on the user's ssh-agent /
// ~/.ssh/config.
//
// Returns:
//   { success, code, host, command, stdout, stderr, timedOut }
// `success` is true only when ssh exits 0. A non-zero exit (remote command
// failed, auth rejected, host unreachable) resolves with success:false and
// the captured stderr — it does NOT reject. The promise only rejects when
// ssh itself can't be spawned.

const { spawn } = require("child_process");

const DEFAULT_TIMEOUT_MS = 30_000;

const sshRunTool = {
  name: "ssh_run_command",

  description:
    "Connect to a remote host over SSH (key-based auth) and run a shell command, " +
    "returning its exit code, stdout, and stderr.",

  parameters: {
    type: "object",
    required: ["host", "command"],
    properties: {
      host: {
        type: "string",
        description: "Remote hostname or IP address.",
      },
      command: {
        type: "string",
        description: "The shell command to run on the remote host.",
      },
      username: {
        type: "string",
        description: "Remote user to connect as. Falls back to ssh's default (current user / ~/.ssh/config).",
      },
      port: {
        type: "number",
        description: "SSH port (default 22).",
      },
      identityFile: {
        type: "string",
        description: "Absolute path to a private key file to authenticate with.",
      },
      timeoutMs: {
        type: "number",
        description: `Kill the command if it runs longer than this (default ${DEFAULT_TIMEOUT_MS}ms).`,
      },
      strictHostKeyChecking: {
        type: "string",
        enum: ["yes", "no", "accept-new"],
        description:
          "How to treat unknown host keys. 'accept-new' (default) trusts a host " +
          "the first time and pins it; 'yes' refuses unknown hosts; 'no' disables " +
          "the check entirely (insecure).",
      },
    },
  },

  async execute({
    host,
    command,
    username,
    port,
    identityFile,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    strictHostKeyChecking = "accept-new",
  }) {
    if (!host || !String(host).trim()) throw new Error("host is required");
    if (!command || !String(command).trim()) throw new Error("command is required");

    const target = username ? `${username}@${host}` : host;

    const args = [
      // Never prompt interactively — fail fast instead of hanging a request.
      "-o", "BatchMode=yes",
      "-o", `StrictHostKeyChecking=${strictHostKeyChecking}`,
      // ConnectTimeout is in seconds; mirror the overall timeout, min 1s.
      "-o", `ConnectTimeout=${Math.max(1, Math.round(timeoutMs / 1000))}`,
    ];
    if (port) args.push("-p", String(port));
    if (identityFile) args.push("-i", identityFile, "-o", "IdentitiesOnly=yes");
    // `--` so a target that looks like a flag can't be misread.
    args.push("--", target, command);

    return new Promise((resolve, reject) => {
      const ssh = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        ssh.kill("SIGKILL");
      }, timeoutMs);

      ssh.stdout.on("data", (d) => { stdout += d.toString(); });
      ssh.stderr.on("data", (d) => { stderr += d.toString(); });

      ssh.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      ssh.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          return resolve({
            success: false,
            code: null,
            host,
            command,
            stdout,
            stderr: stderr || `ssh timed out after ${timeoutMs}ms`,
            timedOut: true,
          });
        }
        resolve({
          success: code === 0,
          code,
          host,
          command,
          stdout,
          stderr,
          timedOut: false,
        });
      });
    });
  },
};

module.exports = sshRunTool;
