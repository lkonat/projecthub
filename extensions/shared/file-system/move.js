// extensions/shared/file-system/move.js
//
// Moves or renames a file or directory. Falls back to copy+remove across
// devices (EXDEV). Refuses to overwrite an existing destination unless
// `overwrite: true`.

const fsp = require("fs/promises");
const path = require("path");
const { resolvePath } = require("./_resolve.js");

const fsMoveTool = {
  name: "fs_move",

  description: "Move or rename a file or directory.",

  parameters: {
    type: "object",
    required: ["from", "to"],
    properties: {
      from: { type: "string", description: "Source path (absolute, or relative to baseDir/cwd)." },
      to: { type: "string", description: "Destination path (absolute, or relative to baseDir/cwd)." },
      overwrite: { type: "boolean", description: "Replace the destination if it exists (default false)." },
      createDirs: { type: "boolean", description: "Create missing parent dirs of the destination (default false)." },
      baseDir: { type: "string", description: "If set, BOTH paths must resolve inside this directory." },
    },
  },

  async execute({ from, to, overwrite = false, createDirs = false, baseDir } = {}) {
    const src = resolvePath(from, baseDir);
    const dst = resolvePath(to, baseDir);

    await fsp.stat(src); // throws if source is missing

    const dstExists = await fsp.stat(dst).then(() => true).catch(() => false);
    if (dstExists && !overwrite) {
      throw new Error(`destination exists (pass overwrite:true): ${dst}`);
    }
    if (createDirs) await fsp.mkdir(path.dirname(dst), { recursive: true });

    try {
      if (dstExists && overwrite) await fsp.rm(dst, { recursive: true, force: true });
      await fsp.rename(src, dst);
    } catch (err) {
      // Cross-device move: rename can't span filesystems → copy then delete.
      if (err.code === "EXDEV") {
        await fsp.cp(src, dst, { recursive: true, force: true });
        await fsp.rm(src, { recursive: true, force: true });
      } else {
        throw err;
      }
    }

    return { success: true, from: src, to: dst };
  },
};

module.exports = fsMoveTool;
