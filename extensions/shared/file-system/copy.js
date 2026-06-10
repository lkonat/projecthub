// extensions/shared/file-system/copy.js
//
// Copies a file or directory (directories copied recursively). Refuses to
// overwrite an existing destination unless `overwrite: true`.

const fsp = require("fs/promises");
const { resolvePath } = require("./_resolve.js");

const fsCopyTool = {
  name: "fs_copy",

  description: "Copy a file or directory (recursively for directories).",

  parameters: {
    type: "object",
    required: ["from", "to"],
    properties: {
      from: { type: "string", description: "Source path (absolute, or relative to baseDir/cwd)." },
      to: { type: "string", description: "Destination path (absolute, or relative to baseDir/cwd)." },
      overwrite: { type: "boolean", description: "Overwrite existing files at the destination (default false)." },
      baseDir: { type: "string", description: "If set, BOTH paths must resolve inside this directory." },
    },
  },

  async execute({ from, to, overwrite = false, baseDir } = {}) {
    const src = resolvePath(from, baseDir);
    const dst = resolvePath(to, baseDir);

    await fsp.stat(src); // throws if source is missing

    await fsp.cp(src, dst, {
      recursive: true,
      force: overwrite,
      errorOnExist: !overwrite,
    });

    return { success: true, from: src, to: dst };
  },
};

module.exports = fsCopyTool;
