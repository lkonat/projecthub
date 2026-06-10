// extensions/shared/git/create-repo.js
//
// Creates a new repository on GitHub via the REST API, then (by default)
// creates a local directory for it under PROJECT_DIR and `git init`s it with
// `origin` pointing at the new remote — so the local checkout is wired up to
// track the repo and is ready for the first commit + push.
//
// The REST call uses the global `fetch` (Node 18+); the local setup shells out
// to the `git` binary like the other tools here. No dependencies.
//
// Auth uses a Personal Access Token, read from the `token` argument and
// falling back to the GITHUB_TOKEN (or GH_TOKEN) environment variable:
//   - classic PAT:      `repo` scope (for orgs, also grant repo creation rights)
//   - fine-grained PAT: "Administration: Read and write" on the target account
// The token is never logged or returned.
//
// The local repo dir is created at  <PROJECT_DIR>/<repo-name>  where
// PROJECT_DIR comes from the environment (.env). The local git init + remote
// setup is delegated to the git_init_repo tool. Pass `init: false` to skip the
// local setup and only create the remote.

const path = require("path");
const gitInitRepoTool = require("./init-repo.js");

const GITHUB_API = "https://api.github.com";

const gitCreateRepoTool = {
  name: "github_create_repository",

  description:
    "Create a new GitHub repository for the authenticated user (or an org), " +
    "then create + git-init a local directory under PROJECT_DIR tracking it.",

  parameters: {
    type: "object",
    required: ["name"],
    properties: {
      name: {
        type: "string",
        description: "Repository name (e.g. 'my-new-app').",
      },
      description: {
        type: "string",
        description: "Optional repository description.",
      },
      private: {
        type: "boolean",
        description: "Create the repo as private. Defaults to true.",
      },
      autoInit: {
        type: "boolean",
        description: "Initialize the REMOTE with an empty README commit. Defaults to false.",
      },
      org: {
        type: "string",
        description:
          "Create the repo under this organization instead of the authenticated user.",
      },
      token: {
        type: "string",
        description:
          "GitHub Personal Access Token. Defaults to env GITHUB_TOKEN / GH_TOKEN.",
      },
      init: {
        type: "boolean",
        description:
          "After creating the remote, create a local directory under PROJECT_DIR " +
          "and `git init` it with `origin` set to the new repo. Defaults to true.",
      },
      projectDir: {
        type: "string",
        description: "Base directory for the local repo dir. Defaults to env PROJECT_DIR.",
      },
      ssh: {
        type: "boolean",
        description: "Use the SSH remote URL for `origin` instead of HTTPS. Defaults to false.",
      },
    },
  },

  async execute({
    name,
    description,
    private: isPrivate = true,
    autoInit = false,
    org,
    token,
    init = true,
    projectDir,
    ssh = false,
  } = {}) {
    if (!name || !String(name).trim()) {
      throw new Error("name is required");
    }

    const auth = token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (!auth) {
      throw new Error(
        "No GitHub token: pass `token` or set GITHUB_TOKEN in the environment"
      );
    }

    // Fail fast if we'll need PROJECT_DIR but don't have it — before creating
    // the remote, so we don't leave an orphaned repo on a misconfig.
    const localRoot = init ? (projectDir || process.env.PROJECT_DIR) : null;
    if (init && !localRoot) {
      throw new Error(
        "PROJECT_DIR is not set: set it in the environment (.env) or pass `projectDir` (or pass init:false)"
      );
    }

    const url = org
      ? `${GITHUB_API}/orgs/${encodeURIComponent(org)}/repos`
      : `${GITHUB_API}/user/repos`;

    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "projecthub",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: String(name).trim(),
          description: description ? String(description).trim() : undefined,
          private: !!isPrivate,
          auto_init: !!autoInit,
        }),
      });
    } catch (err) {
      // Network-level failure (offline, DNS, etc.) — never carries the token.
      throw new Error(`GitHub request failed: ${err.message}`);
    }

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      // GitHub error shape:
      //   { message, errors: [{ resource, field, code, message }], documentation_url }
      const detail =
        (Array.isArray(data.errors) &&
          data.errors
            .map((e) => e.message || [e.field, e.code].filter(Boolean).join(" "))
            .filter(Boolean)
            .join("; ")) ||
        data.message ||
        `HTTP ${res.status}`;

      // Hints for the usual suspects.
      const hint =
        res.status === 401
          ? " (check the token)"
          : res.status === 403
          ? " (token lacks permission, or rate-limited)"
          : res.status === 404 && org
          ? " (org not found, or the token can't see it)"
          : "";

      throw new Error(
        `GitHub repo creation failed [${res.status}]: ${detail}${hint}`
      );
    }

    const result = {
      success: true,
      message: `Created ${data.full_name}`,
      name: data.name,
      fullName: data.full_name,
      private: data.private,
      htmlUrl: data.html_url,
      cloneUrl: data.clone_url, // https://github.com/<owner>/<name>.git
      sshUrl: data.ssh_url, //     git@github.com:<owner>/<name>.git
      defaultBranch: data.default_branch,
    };

    // Local setup: create + git init the directory tracking the new remote.
    // Delegated to the git_init_repo tool (which uses the file-system tools).
    if (init) {
      const remoteUrl = ssh ? data.ssh_url : data.clone_url;
      const targetDir = path.resolve(localRoot, data.name);
      const local = await gitInitRepoTool.execute({
        dir: targetDir,
        remoteUrl,
        branch: data.default_branch || "main",
      });
      result.targetDir = local.dir;
      result.localRepo = local;
      result.message += ` → ${local.dir}`;
    }

    return result;
  },
};

module.exports = gitCreateRepoTool;
