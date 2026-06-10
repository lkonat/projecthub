// extensions/shared/file-system/_resolve.js
//
// Shared path resolution for the file-system tools. Internal helper (the
// loader ignores shared/); imported by the tools, not used directly.
//
// Resolves `targetPath` to an absolute path. If `baseDir` is provided, the
// result MUST stay inside it — a path-traversal guard (the same approach
// git/revert.js uses) so a confined caller can't escape with `../` or an
// absolute path. Without `baseDir`, the path resolves against process.cwd()
// and may point anywhere on disk.

const path = require("path");

function resolvePath(targetPath, baseDir) {
  if (!targetPath || typeof targetPath !== "string") {
    throw new Error("path is required");
  }
  if (!baseDir) return path.resolve(targetPath);

  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, targetPath);
  const rel = path.relative(base, resolved);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`path escapes baseDir (${base}): ${targetPath}`);
  }
  return resolved;
}

module.exports = { resolvePath };
