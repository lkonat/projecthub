// extensions/shared/file-system/remove.js
//
// Deletes a file or directory. DESTRUCTIVE and not recoverable.
//
// Safety: a non-empty directory is refused unless `recursive: true`, so you
// can't wipe a tree by accident. `force: true` makes a missing path a no-op
// instead of an error.

const fsp = require("fs/promises");
const { resolvePath } = require("./_resolve.js");

const fsRemoveTool = {
  name: "fs_remove",

  description: "Delete a file or directory (a non-empty directory requires recursive:true).",

  parameters: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string", description: "Path to delete (absolute, or relative to baseDir/cwd)." },
      recursive: { type: "boolean", description: "Required to delete a non-empty directory (default false)." },
      force: { type: "boolean", description: "Treat a missing path as success instead of erroring (default false)." },
      baseDir: { type: "string", description: "If set, the path must resolve inside this directory." },
    },
  },

  async execute({ path: targetPath, recursive = false, force = false, baseDir } = {}) {
    const target = resolvePath(targetPath, baseDir);

    const stat = await fsp.lstat(target).catch(() => null);
    if (!stat) {
      if (force) return { success: true, path: target, removed: false, note: "did not exist" };
      throw new Error(`path does not exist: ${target}`);
    }

    const isDir = stat.isDirectory();
    if (isDir && !recursive) {
      const entries = await fsp.readdir(target);
      if (entries.length > 0) {
        throw new Error(`directory not empty (pass recursive:true): ${target}`);
      }
    }

    await fsp.rm(target, { recursive: isDir, force: true });
    return { success: true, path: target, removed: true, type: isDir ? "directory" : "file" };
  },
};

module.exports = fsRemoveTool;
