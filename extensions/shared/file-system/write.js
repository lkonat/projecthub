// extensions/shared/file-system/write.js
//
// Writes content to a file, creating or overwriting it. Pass encoding
// 'base64' to write binary content. `createDirs` makes missing parents;
// `overwrite: false` refuses to clobber an existing file.

const fsp = require("fs/promises");
const path = require("path");
const { resolvePath } = require("./_resolve.js");

const fsWriteFileTool = {
  name: "fs_write_file",

  description: "Write content to a file, creating or overwriting it.",

  parameters: {
    type: "object",
    required: ["path", "content"],
    properties: {
      path: { type: "string", description: "File path (absolute, or relative to baseDir/cwd)." },
      content: { type: "string", description: "Content to write." },
      encoding: { type: "string", description: "Encoding of `content` (default 'utf8'; 'base64' for binary)." },
      createDirs: { type: "boolean", description: "Create missing parent directories (default false)." },
      overwrite: { type: "boolean", description: "Allow overwriting an existing file (default true)." },
      baseDir: { type: "string", description: "If set, the path must resolve inside this directory." },
    },
  },

  async execute({ path: targetPath, content, encoding = "utf8", createDirs = false, overwrite = true, baseDir } = {}) {
    if (content === undefined || content === null) throw new Error("content is required");
    const file = resolvePath(targetPath, baseDir);

    if (!overwrite) {
      const exists = await fsp.stat(file).then(() => true).catch(() => false);
      if (exists) throw new Error(`file already exists (overwrite is false): ${file}`);
    }
    if (createDirs) await fsp.mkdir(path.dirname(file), { recursive: true });

    await fsp.writeFile(file, content, { encoding });
    const stat = await fsp.stat(file);
    return { success: true, path: file, bytesWritten: stat.size };
  },
};

module.exports = fsWriteFileTool;
