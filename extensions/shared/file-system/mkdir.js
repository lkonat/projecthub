// extensions/shared/file-system/mkdir.js
//
// Creates a directory. `recursive` (default true) makes any missing parents
// and treats an already-existing directory as success.

const fsp = require("fs/promises");
const { resolvePath } = require("./_resolve.js");

const fsMakeDirectoryTool = {
  name: "fs_make_directory",

  description: "Create a directory (recursively by default; existing dir is a no-op).",

  parameters: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string", description: "Directory path (absolute, or relative to baseDir/cwd)." },
      recursive: { type: "boolean", description: "Create missing parents; ok if it exists (default true)." },
      baseDir: { type: "string", description: "If set, the path must resolve inside this directory." },
    },
  },

  async execute({ path: targetPath, recursive = true, baseDir } = {}) {
    const dir = resolvePath(targetPath, baseDir);
    const firstCreated = await fsp.mkdir(dir, { recursive });
    return { success: true, path: dir, created: firstCreated ?? null };
  },
};

module.exports = fsMakeDirectoryTool;
