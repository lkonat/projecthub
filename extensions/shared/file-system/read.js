// extensions/shared/file-system/read.js
//
// Reads the contents of a file. Refuses files larger than `maxBytes` so a
// stray huge file can't blow up memory. Use encoding 'base64' for binary.

const fsp = require("fs/promises");
const { resolvePath } = require("./_resolve.js");

const fsReadFileTool = {
  name: "fs_read_file",

  description: "Read the contents of a file (text, or base64 for binary).",

  parameters: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string", description: "File path (absolute, or relative to baseDir/cwd)." },
      encoding: { type: "string", description: "Text encoding (default 'utf8'). Use 'base64' for binary." },
      maxBytes: { type: "number", description: "Refuse to read files larger than this (default 5000000)." },
      baseDir: { type: "string", description: "If set, the path must resolve inside this directory." },
    },
  },

  async execute({ path: targetPath, encoding = "utf8", maxBytes = 5_000_000, baseDir } = {}) {
    const file = resolvePath(targetPath, baseDir);
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error(`not a file: ${file}`);
    if (stat.size > maxBytes) {
      throw new Error(`file is ${stat.size} bytes, exceeds maxBytes ${maxBytes}`);
    }
    const content = await fsp.readFile(file, encoding);
    return { success: true, path: file, size: stat.size, encoding, content };
  },
};

module.exports = fsReadFileTool;
