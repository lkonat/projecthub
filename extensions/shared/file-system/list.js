// extensions/shared/file-system/list.js
//
// Lists the entries of a directory. Each entry carries its type and (best
// effort) size + mtime. `recursive: true` walks the whole tree, returning
// paths relative to the listed directory.

const fsp = require("fs/promises");
const path = require("path");
const { resolvePath } = require("./_resolve.js");

function kind(d) {
  if (d.isDirectory()) return "directory";
  if (d.isFile()) return "file";
  if (d.isSymbolicLink()) return "symlink";
  return "other";
}

const fsListDirectoryTool = {
  name: "fs_list_directory",

  description: "List the contents of a directory (optionally recursive), with type, size, and mtime per entry.",

  parameters: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string", description: "Directory path (absolute, or relative to baseDir/cwd)." },
      recursive: { type: "boolean", description: "Walk the whole tree (default false)." },
      baseDir: { type: "string", description: "If set, the path must resolve inside this directory." },
    },
  },

  async execute({ path: targetPath, recursive = false, baseDir } = {}) {
    const dir = resolvePath(targetPath, baseDir);
    const stat = await fsp.stat(dir);
    if (!stat.isDirectory()) throw new Error(`not a directory: ${dir}`);

    const dirents = await fsp.readdir(dir, { withFileTypes: true, recursive });
    const entries = [];
    for (const d of dirents) {
      const parent = d.parentPath ?? d.path ?? dir; // parentPath: Node 20.12+
      const full = path.join(parent, d.name);
      let size = null, mtime = null;
      try {
        const s = await fsp.lstat(full);
        size = s.size;
        mtime = s.mtime.toISOString();
      } catch { /* broken symlink / race — leave null */ }
      entries.push({
        name: d.name,
        path: path.relative(dir, full),
        type: kind(d),
        size,
        mtime,
      });
    }

    return { success: true, path: dir, count: entries.length, entries };
  },
};

module.exports = fsListDirectoryTool;
