// extensions/shared/git/revert.js
//
// Discards a single hunk of a file's working-tree changes, restoring those
// lines to their HEAD state — the equivalent of "Discard hunk" in a git GUI.
//
// Mechanism: re-derive the file's diff vs HEAD (so the server, not the
// caller, is the source of truth), extract the requested hunk by index,
// reconstruct a minimal one-hunk patch, and reverse-apply it with
// `git apply --reverse`. git apply matches by context and fails cleanly if
// the file changed underneath, so a stale request can't corrupt the file.
//
// NOTE: this is destructive — the discarded edits are not recoverable via
// git. Callers should confirm with the user first.
//
// Returns: { success, cwd, file, hunkIndex, reverted }

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

function run(cmd, args, opts, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, opts);
    let out = "";
    let err = "";
    if (p.stdout) p.stdout.on("data", (d) => { out += d.toString(); });
    if (p.stderr) p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, out, err }));
    if (input !== undefined) { p.stdin.write(input); p.stdin.end(); }
  });
}

// Split `git diff` output into its header (everything before the first @@)
// and an array of hunk strings (each starting at a @@ line).
function splitDiff(text) {
  const lines = text.split("\n");
  const atIdxs = [];
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].startsWith("@@")) atIdxs.push(k);
  }
  if (atIdxs.length === 0) return { header: "", hunks: [] };
  const header = lines.slice(0, atIdxs[0]).join("\n");
  const hunks = [];
  for (let h = 0; h < atIdxs.length; h++) {
    const start = atIdxs[h];
    const end = h + 1 < atIdxs.length ? atIdxs[h + 1] : lines.length;
    hunks.push(lines.slice(start, end).join("\n"));
  }
  return { header, hunks };
}

const gitRevertHunkTool = {
  name: "git_revert_hunk",

  description: "Reverse-apply a single hunk of a file's working-tree changes, restoring those lines to HEAD.",

  parameters: {
    type: "object",
    required: ["cwd", "file", "hunkIndex"],
    properties: {
      cwd: { type: "string", description: "Absolute path to a local git repository." },
      file: { type: "string", description: "Repo-relative path of the file." },
      hunkIndex: { type: "number", description: "Zero-based index of the hunk to revert, as ordered in `git diff HEAD -- <file>`." },
    },
  },

  async execute({ cwd, file, hunkIndex }) {
    if (!cwd) throw new Error("cwd is required");
    if (!file) throw new Error("file is required");
    if (!Number.isInteger(hunkIndex) || hunkIndex < 0) {
      throw new Error("hunkIndex must be a non-negative integer");
    }

    const targetDir = path.resolve(cwd);
    if (!fs.existsSync(targetDir)) throw new Error(`cwd does not exist: ${targetDir}`);

    // Path-traversal guard: the file must resolve inside the repo.
    const resolved = path.resolve(targetDir, file);
    const rel = path.relative(targetDir, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`file is outside the repository: ${file}`);
    }
    const relFile = rel || file;

    // 1. Current diff for just this file (server is the source of truth).
    const diff = await run(
      "git",
      ["diff", "HEAD", "--no-color", "--", relFile],
      { cwd: targetDir, stdio: ["ignore", "pipe", "pipe"] }
    );
    if (diff.code !== 0) {
      throw new Error(`git diff failed: ${diff.err.trim() || diff.out.trim()}`);
    }
    if (!diff.out.trim()) throw new Error("no changes to revert for this file");

    // 2. Extract the requested hunk and rebuild a minimal patch.
    const { header, hunks } = splitDiff(diff.out);
    if (hunkIndex >= hunks.length) {
      throw new Error(`hunkIndex ${hunkIndex} out of range (file has ${hunks.length} hunk(s))`);
    }
    let patch = header + "\n" + hunks[hunkIndex];
    if (!patch.endsWith("\n")) patch += "\n";

    // 3. Reverse-apply the one hunk to the working tree. --recount lets git
    //    fix up line counts; context matching makes it fail safely on drift.
    const applied = await run(
      "git",
      ["apply", "--reverse", "--recount"],
      { cwd: targetDir, stdio: ["pipe", "pipe", "pipe"] },
      patch
    );
    if (applied.code !== 0) {
      throw new Error(`git apply failed: ${applied.err.trim() || applied.out.trim()}`);
    }

    return { success: true, cwd: targetDir, file: relFile, hunkIndex, reverted: true };
  },
};

module.exports = gitRevertHunkTool;
