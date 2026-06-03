// tools/gitStatusTool.js
//
// Returns the state of a local git working tree. Parses
// `git status --porcelain=v1 --branch` so callers can use the structured
// `files`/`branch`/`clean` fields, or fall back to `stdout`.
//
// Status codes (per file): two characters X and Y.
//   X = index (staged) state
//   Y = working tree state
// Common values: ' ' unchanged, M modified, A added, D deleted, R renamed,
// C copied, U unmerged, ? untracked, ! ignored.
//
// Each file entry also carries `mtime` (ISO string) and `mtimeMs` (epoch
// ms) from the filesystem, so callers can tell *when* each change
// happened. Files that no longer exist on disk (e.g. deletions) get
// `mtime: null`.

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const gitStatusTool = {
  name: "git_status_repository",

  description: "Inspect the state of a local Git working tree (branch, ahead/behind, changed/untracked files).",

  parameters: {
    type: "object",
    required: ["cwd"],
    properties: {
      cwd: {
        type: "string",
        description: "Absolute path to a local git repository.",
      },
      includeIgnored: {
        type: "boolean",
        description: "Include ignored files in the result (off by default).",
      },
      modifiedFiles: {
        type: "boolean",
        description:
          "When true, return ONLY files that were already tracked by git " +
          "(i.e. previously committed) AND now have modifications: " +
          "staged or unstaged change, deletion, rename, copy, or unmerged. " +
          "Excludes untracked (`?? `), ignored (`!! `), and newly-added " +
          "(`A ` / `AM`) files — those aren't yet tracked by git in the " +
          "sense of being in HEAD. `files`, `clean`, `untracked`, and " +
          "`ignored` all reflect this filter — a repo where the only " +
          "changes are untracked or added files reports `clean: true`.",
      },
    },
  },

  async execute({ cwd, includeIgnored = false, modifiedFiles = false }) {
    if (!cwd) throw new Error("cwd is required");

    const targetDir = path.resolve(cwd);
    if (!fs.existsSync(targetDir)) {
      throw new Error(`cwd does not exist: ${targetDir}`);
    }

    const args = ["status", "--porcelain=v1", "--branch"];
    // `modifiedFiles` filters in JS; no need to ask git for ignored files.
    if (includeIgnored && !modifiedFiles) args.push("--ignored");

    return new Promise((resolve, reject) => {
      const git = spawn("git", args, {
        cwd: targetDir,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      git.stdout.on("data", (data) => { stdout += data.toString(); });
      git.stderr.on("data", (data) => { stderr += data.toString(); });

      git.on("error", reject);

      git.on("close", (code) => {
        if (code !== 0) {
          return reject(
            new Error(`git status failed with exit code ${code}: ${stderr.trim() || stdout.trim()}`)
          );
        }

        const parsed = parsePorcelain(stdout);

        // Attach filesystem timestamps so callers can tell *when* each
        // change happened. Cheap: one stat() per dirty file.
        attachFsTimestamps(parsed.files, targetDir);

        // `modifiedFiles` is ALSO surfaced as a dedicated output array so
        // callers can read it directly without flipping the input flag.
        parsed.modifiedFiles = parsed.files.filter(isTrackedChange);

        if (modifiedFiles) {
          parsed.files = parsed.modifiedFiles;
          parsed.untracked = [];
          parsed.ignored = [];
          parsed.clean = parsed.files.length === 0;
        }

        resolve({
          success: true,
          cwd: targetDir,
          ...parsed,
          stdout,
          stderr,
        });
      });
    });
  },
};

// --- internals ----------------------------------------------------------

function parsePorcelain(text) {
  const lines = text.split("\n");
  let branch = null;
  let upstream = null;
  let ahead = 0;
  let behind = 0;
  const files = [];

  for (const line of lines) {
    if (!line) continue;

    if (line.startsWith("## ")) {
      // Examples:
      //   "## main"                              (no upstream)
      //   "## main...origin/main"                (clean)
      //   "## main...origin/main [ahead 1]"      (ahead only)
      //   "## main...origin/main [ahead 1, behind 2]"
      //   "## HEAD (no branch)"                  (detached)
      const rest = line.slice(3);
      const tracking = rest.match(/^(.*?)\.\.\.(.+?)(?:\s+\[(.+)\])?$/);
      if (tracking) {
        branch = tracking[1];
        upstream = tracking[2];
        const counts = tracking[3];
        if (counts) {
          const a = counts.match(/ahead (\d+)/);
          const b = counts.match(/behind (\d+)/);
          if (a) ahead = Number(a[1]);
          if (b) behind = Number(b[1]);
        }
      } else {
        branch = rest;
      }
      continue;
    }

    // File line: "XY path"  or  "XY path -> renamedPath"  (when renamed)
    // X and Y are exactly one char each, separated by a space.
    if (line.length < 4) continue;
    const x = line[0];
    const y = line[1];
    let rest = line.slice(3);

    // Porcelain v1 unquotes when LC_ALL=C; if a quoted path slipped in
    // we leave it as-is (rare in practice).
    let pathField = rest;
    let renamedTo = null;
    const arrowIdx = rest.indexOf(" -> ");
    if (arrowIdx !== -1) {
      pathField = rest.slice(0, arrowIdx);
      renamedTo = rest.slice(arrowIdx + 4);
    }

    files.push({
      path: pathField,
      x,
      y,
      ...(renamedTo ? { renamedTo } : {}),
      ...(describeStatus(x, y) ? { description: describeStatus(x, y) } : {}),
    });
  }

  return {
    branch,
    upstream,
    ahead,
    behind,
    clean: files.length === 0,
    files,
    staged: files.filter((f) => f.x !== " " && f.x !== "?" && f.x !== "!"),
    unstaged: files.filter((f) => f.y !== " " && f.y !== "?" && f.y !== "!"),
    untracked: files.filter((f) => f.x === "?" && f.y === "?"),
    ignored: files.filter((f) => f.x === "!" && f.y === "!"),
  };
}

function isTrackedChange(f) {
  // "Previously tracked + now modified".
  // Excludes:
  //   ?? untracked         — git doesn't know about this file
  //   !! ignored           — git knows but explicitly ignores
  //   A  / AM newly added  — being added in this commit, wasn't in HEAD
  if (f.x === "?" && f.y === "?") return false;
  if (f.x === "!" && f.y === "!") return false;
  if (f.x === "A") return false;
  return true;
}

// Best-effort: stat each file in the working tree to get its last-modified
// timestamp. Files that no longer exist (deleted, or the "old" half of a
// rename) get `mtime: null`. Adds the field in-place.
function attachFsTimestamps(files, cwd) {
  for (const f of files) {
    // For renames, the file is now at `renamedTo`; `path` is the old name
    // and no longer exists on disk.
    const onDiskPath = f.renamedTo || f.path;
    const fullPath = path.resolve(cwd, onDiskPath);
    try {
      const stat = fs.statSync(fullPath);
      f.mtime = stat.mtime.toISOString();
      f.mtimeMs = stat.mtimeMs;
    } catch {
      f.mtime = null;
      f.mtimeMs = null;
    }
  }
}

function describeStatus(x, y) {
  if (x === "?" && y === "?") return "untracked";
  if (x === "!" && y === "!") return "ignored";
  if (x === "U" || y === "U") return "unmerged";
  if (x === "A") return "added";
  if (x === "M" || y === "M") return "modified";
  if (x === "D" || y === "D") return "deleted";
  if (x === "R") return "renamed";
  if (x === "C") return "copied";
  return null;
}

module.exports = gitStatusTool;
