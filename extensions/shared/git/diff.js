// extensions/shared/git/diff.js
//
// Returns the unified `git diff` for a single file in a local working tree.
// Mirrors status.js: shells out to the system `git` binary via spawn.
//
// Diffs against HEAD (`git diff HEAD -- <file>`) so the result captures both
// staged and unstaged changes in one view — i.e. everything that differs from
// the last commit. Works for modified, deleted, and renamed files.
//
// Returns:
//   { success, cwd, file, diff, empty, stdout, stderr }
// `empty` is true when there's no textual diff (e.g. a binary file, or the
// file matches HEAD). The promise rejects only if git can't be spawned or
// the file escapes the repo directory.

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const gitDiffTool = {
  name: "git_diff_file",

  description: "Get the unified git diff (vs HEAD) for a single file in a local git working tree.",

  parameters: {
    type: "object",
    required: ["cwd", "file"],
    properties: {
      cwd: {
        type: "string",
        description: "Absolute path to a local git repository.",
      },
      file: {
        type: "string",
        description: "Repo-relative path of the file to diff.",
      },
    },
  },

  async execute({ cwd, file }) {
    if (!cwd) throw new Error("cwd is required");
    if (!file) throw new Error("file is required");

    const targetDir = path.resolve(cwd);
    if (!fs.existsSync(targetDir)) {
      throw new Error(`cwd does not exist: ${targetDir}`);
    }

    // Guard against path traversal: the file must resolve to somewhere
    // inside the repo directory.
    const resolved = path.resolve(targetDir, file);
    const rel = path.relative(targetDir, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`file is outside the repository: ${file}`);
    }

    const args = [
      "diff",
      "HEAD",
      "--no-color",
      "--",
      // Use the normalized repo-relative path.
      rel || file,
    ];

    return new Promise((resolve, reject) => {
      const git = spawn("git", args, {
        cwd: targetDir,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      git.stdout.on("data", (d) => { stdout += d.toString(); });
      git.stderr.on("data", (d) => { stderr += d.toString(); });

      git.on("error", reject);

      git.on("close", (code) => {
        if (code !== 0) {
          return reject(
            new Error(`git diff failed with exit code ${code}: ${stderr.trim() || stdout.trim()}`)
          );
        }
        resolve({
          success: true,
          cwd: targetDir,
          file: rel || file,
          diff: stdout,
          empty: stdout.trim() === "",
          stdout,
          stderr,
        });
      });
    });
  },
};

module.exports = gitDiffTool;
