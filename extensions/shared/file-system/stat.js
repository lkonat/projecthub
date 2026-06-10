// extensions/shared/file-system/stat.js
//
// Returns information about a path (type, size, timestamps) and whether it
// exists. A missing path is NOT an error — it returns { exists: false }.

const fsp = require("fs/promises");
const { resolvePath } = require("./_resolve.js");

function kind(stat) {
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  if (stat.isSymbolicLink()) return "symlink";
  return "other";
}

const fsStatTool = {
  name: "fs_stat",

  description: "Get information about a file or directory (type, size, timestamps, existence).",

  parameters: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string", description: "Path to inspect (absolute, or relative to baseDir/cwd)." },
      baseDir: { type: "string", description: "If set, the path must resolve inside this directory." },
    },
  },

  async execute({ path: targetPath, baseDir } = {}) {
    const target = resolvePath(targetPath, baseDir);
    const stat = await fsp.lstat(target).catch((err) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    if (!stat) return { success: true, path: target, exists: false };

    return {
      success: true,
      path: target,
      exists: true,
      type: kind(stat),
      isDirectory: stat.isDirectory(),
      isFile: stat.isFile(),
      isSymlink: stat.isSymbolicLink(),
      size: stat.size,
      mode: stat.mode,
      mtime: stat.mtime.toISOString(),
      ctime: stat.ctime.toISOString(),
      birthtime: stat.birthtime ? stat.birthtime.toISOString() : null,
    };
  },
};

module.exports = fsStatTool;
