// tools/gitCloneTool.js

const { spawn } = require("child_process");
const path = require("path");

const gitCloneTool = {
  name: "git_clone_repository",

  description: "Clone a Git repository into a local directory.",

  parameters: {
    type: "object",
    required: ["cloneName", "gitUrl"],
    properties: {
      cloneName: {
        type: "string",
        description: "The local folder name to clone the repository into.",
      },
      gitUrl: {
        type: "string",
        description: "The Git repository URL. Supports HTTPS or SSH.",
      },
      baseDir: {
        type: "string",
        description: "Optional base directory. Defaults to current working directory.",
      },
    },
  },

  async execute({ cloneName, gitUrl, baseDir = process.cwd() }) {
    if (!cloneName) throw new Error("cloneName is required");
    if (!gitUrl) throw new Error("gitUrl is required");

    const targetDir = path.resolve(baseDir, cloneName);

    return new Promise((resolve, reject) => {
      const git = spawn("git", ["clone", gitUrl, targetDir], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      git.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      git.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      git.on("error", reject);

      git.on("close", (code) => {
        if (code !== 0) {
          return reject(
            new Error(`git clone failed with exit code ${code}: ${stderr}`)
          );
        }

        resolve({
          success: true,
          message: "Repository cloned successfully.",
          cloneName,
          gitUrl,
          targetDir,
          stdout,
          stderr,
        });
      });
    });
  },
};

module.exports = gitCloneTool;