// extensions/shared/file-system/append.js
//
// Appends content to the end of a file, creating it if it doesn't exist.

const fsp = require("fs/promises");
const path = require("path");
const { resolvePath } = require("./_resolve.js");

const fsAppendFileTool = {
  name: "fs_append_file",

  description: "Append content to the end of a file (creating it if missing).",

  parameters: {
    type: "object",
    required: ["path", "content"],
    properties: {
      path: { type: "string", description: "File path (absolute, or relative to baseDir/cwd)." },
      content: { type: "string", description: "Content to append." },
      encoding: { type: "string", description: "Encoding of `content` (default 'utf8')." },
      createDirs: { type: "boolean", description: "Create missing parent directories (default false)." },
      baseDir: { type: "string", description: "If set, the path must resolve inside this directory." },
    },
  },

  async execute({ path: targetPath, content, encoding = "utf8", createDirs = false, baseDir } = {}) {
    if (content === undefined || content === null) throw new Error("content is required");
    const file = resolvePath(targetPath, baseDir);
    if (createDirs) await fsp.mkdir(path.dirname(file), { recursive: true });

    await fsp.appendFile(file, content, { encoding });
    const stat = await fsp.stat(file);
    return { success: true, path: file, size: stat.size };
  },
};

module.exports = fsAppendFileTool;
