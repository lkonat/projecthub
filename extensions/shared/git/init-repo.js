// extensions/shared/git/init-repo.js
//
// Initializes a local git repository in a directory and (optionally) points a
// remote at a URL — the "git init + git remote add origin" half of setting up
// a repo, split out as its own tool so it's reusable on its own.
//
// Filesystem work goes through the shared file-system tools (no direct `fs`);
// git work shells out to the `git` binary like the other tools here.
//
// Idempotent: an existing git repo just has its remote (re)set; a non-empty,
// non-git directory is refused rather than scribbled over.

const { spawn } = require("child_process");
const path = require("path");
const fsStat = require("../file-system/stat.js");
const fsMkdir = require("../file-system/mkdir.js");
const fsList = require("../file-system/list.js");

const gitInitRepoTool = {
  name: "git_init_repo",

  description:
    "Create a directory if needed, `git init` it, and point a remote " +
    "(default 'origin') at a URL.",

  parameters: {
    type: "object",
    required: ["dir"],
    properties: {
      dir: {
        type: "string",
        description: "Local directory for the repo (absolute, or relative to cwd).",
      },
      remoteUrl: {
        type: "string",
        description: "If set, add (or update) this remote URL.",
      },
      remoteName: {
        type: "string",
        description: "Remote name to set (default 'origin').",
      },
      branch: {
        type: "string",
        description: "Initial branch name (default 'main').",
      },
    },
  },

  async execute({ dir, remoteUrl, remoteName = "origin", branch = "main" } = {}) {
    if (!dir || !String(dir).trim()) throw new Error("dir is required");
    const targetDir = path.resolve(dir);
    const gitDir = path.join(targetDir, ".git");

    // Already a git repo? Don't re-init — just (re)set the remote if given.
    const gitStat = await fsStat.execute({ path: gitDir });
    if (gitStat.exists) {
      if (remoteUrl) await setRemote(targetDir, remoteName, remoteUrl);
      return {
        success: true, dir: targetDir, created: false, initialized: false,
        remote: remoteUrl ? { name: remoteName, url: remoteUrl } : null,
        branch, note: "already a git repository",
      };
    }

    // Otherwise create the directory (refusing to init over a non-empty,
    // non-git directory). All via the shared file-system tools.
    const dirStat = await fsStat.execute({ path: targetDir });
    if (dirStat.exists) {
      if (!dirStat.isDirectory) {
        throw new Error(`path exists and is not a directory: ${targetDir}`);
      }
      const listing = await fsList.execute({ path: targetDir });
      if (listing.count > 0) {
        throw new Error(`target directory exists and is not empty: ${targetDir}`);
      }
    } else {
      await fsMkdir.execute({ path: targetDir }); // recursive by default
    }

    const opts = { cwd: targetDir, stdio: ["ignore", "pipe", "pipe"] };
    let initRes = await run("git", ["init", "-b", branch], opts);
    if (initRes.code !== 0) {
      // Older git (< 2.28) has no `-b`: plain init, then point HEAD at the branch.
      initRes = await run("git", ["init"], opts);
      if (initRes.code !== 0) throw new Error(`git init failed: ${gitErr(initRes)}`);
      await run("git", ["symbolic-ref", "HEAD", `refs/heads/${branch}`], opts);
    }

    if (remoteUrl) await setRemote(targetDir, remoteName, remoteUrl);

    return {
      success: true, dir: targetDir, created: true, initialized: true,
      remote: remoteUrl ? { name: remoteName, url: remoteUrl } : null, branch,
    };
  },
};

async function setRemote(cwd, name, url) {
  const opts = { cwd, stdio: ["ignore", "pipe", "pipe"] };
  const add = await run("git", ["remote", "add", name, url], opts);
  if (add.code !== 0) {
    // remote already exists → update it.
    const set = await run("git", ["remote", "set-url", name, url], opts);
    if (set.code !== 0) throw new Error(`failed to set remote ${name}: ${gitErr(set)}`);
  }
}

function gitErr(r) {
  return (r.err || "").trim() || (r.out || "").trim() || `exit ${r.code}`;
}

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, opts);
    let out = "", err = "";
    if (p.stdout) p.stdout.on("data", (d) => { out += d.toString(); });
    if (p.stderr) p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

module.exports = gitInitRepoTool;
