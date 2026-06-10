import fs from 'node:fs';
import path from 'node:path';
import { projectsService } from './projects.service.js';
import { access } from '../../access/access.service.js';
import { userActor } from '../../access/actor.js';
import { parseId, pickFields } from '../../middleware/validate.js';
import { registry } from '../../extensions/registry.js';
import gitStatusTool from '../../../../extensions/shared/git/status.js';
import gitDiffTool from '../../../../extensions/shared/git/diff.js';
import gitRevertHunkTool from '../../../../extensions/shared/git/revert.js';

const PROJECT_FIELDS = ['name', 'description', 'priority', 'status', 'type', 'fields', 'meta'];

// Controllers are the WEB adapter: translate req → actor, delegate to services
// (which authorize via the policy), and shape the HTTP response. Git endpoints
// are web actions with no domain service, so they authorize inline via `access`.
export const projectsController = {
  list(req, res) {
    const { priority, status, sort } = req.query;
    res.json({ data: projectsService.list(userActor(req.user.id), { priority, status, sort }) });
  },

  getOne(req, res) {
    const id = parseId(req.params.id);
    const actor = userActor(req.user.id);
    const project = projectsService.view(actor, id); // authorizes project.view
    // Ship the per-project capability map so the client renders affordances
    // from the same policy the server enforces. `canEdit` kept for convenience.
    const capabilities = access.capabilitiesFor(actor, project);
    res.json({ data: { ...project, canEdit: capabilities['project.edit'], capabilities } });
  },

  async create(req, res) {
    const body = pickFields(req.body, PROJECT_FIELDS);
    const project = await projectsService.create(userActor(req.user.id), body);
    res.status(201).json({ data: project });
  },

  async update(req, res) {
    const id = parseId(req.params.id);
    const patch = pickFields(req.body, PROJECT_FIELDS);
    res.json({ data: await projectsService.update(userActor(req.user.id), id, patch) });
  },

  async remove(req, res) {
    const id = parseId(req.params.id);
    await projectsService.remove(userActor(req.user.id), id);
    res.status(204).end();
  },

  // GET /api/projects/:id/git/status
  // Returns live git status for the project's cloned repo.
  // Response always has `available`. When available: branch / upstream /
  // ahead / behind / clean / modifiedFiles. When not: a `reason` string.
  // Never throws to the client — `available: false` is the explicit
  // "no git here" signal.
  async getGitStatus(req, res) {
    const id = parseId(req.params.id);
    const project = access.authorize(userActor(req.user.id), id, 'git.read');

    const gitClone = project?.fields?.gitClone;
    if (!gitClone) {
      return res.json({ data: { available: false, reason: 'no gitClone field set' } });
    }

    // Resolve relative paths the same way the clone button + tool do, so
    // the existence check lands on the same directory.
    const cwd = path.resolve(process.cwd(), gitClone);
    if (!fs.existsSync(cwd)) {
      return res.json({ data: { available: false, reason: `path does not exist: ${cwd}` } });
    }
    if (!fs.existsSync(path.join(cwd, '.git'))) {
      return res.json({ data: { available: false, reason: `not a git repository: ${cwd}` } });
    }

    try {
      const status = await gitStatusTool.execute({ cwd, modifiedFiles: true });
      return res.json({
        data: {
          available:     true,
          path:          cwd,
          branch:        status.branch,
          upstream:      status.upstream,
          ahead:         status.ahead,
          behind:        status.behind,
          clean:         status.clean,
          modifiedFiles: status.modifiedFiles,
        },
      });
    } catch (err) {
      return res.json({ data: { available: false, reason: err.message } });
    }
  },

  // GET /api/projects/:id/git/diff?file=<repo-relative path>
  // Returns the unified `git diff` (vs HEAD) for a single file in the
  // project's cloned repo. Same `available: false` contract as getGitStatus —
  // never throws to the client for the "no git / bad path" cases.
  async getGitDiff(req, res) {
    const id = parseId(req.params.id);
    const project = access.authorize(userActor(req.user.id), id, 'git.read');

    const file = req.query.file;
    if (!file || typeof file !== 'string') {
      return res.json({ data: { available: false, reason: 'file query param is required' } });
    }

    const gitClone = project?.fields?.gitClone;
    if (!gitClone) {
      return res.json({ data: { available: false, reason: 'no gitClone field set' } });
    }

    const cwd = path.resolve(process.cwd(), gitClone);
    if (!fs.existsSync(path.join(cwd, '.git'))) {
      return res.json({ data: { available: false, reason: `not a git repository: ${cwd}` } });
    }

    try {
      const result = await gitDiffTool.execute({ cwd, file });
      return res.json({
        data: {
          available: true,
          file:      result.file,
          diff:      result.diff,
          empty:     result.empty,
        },
      });
    } catch (err) {
      return res.json({ data: { available: false, reason: err.message } });
    }
  },

  // POST /api/projects/:id/git/revert  { file, hunkIndex }
  // Discards a single hunk of a file's working-tree changes (restores those
  // lines to HEAD). Destructive — the client confirms first. Same
  // `available: false` no-throw contract as the other git endpoints.
  async revertGitHunk(req, res) {
    const id = parseId(req.params.id);
    const project = access.authorize(userActor(req.user.id), id, 'git.write');

    const { file, hunkIndex } = req.body || {};
    if (!file || typeof file !== 'string') {
      return res.json({ data: { available: false, reason: 'file is required' } });
    }
    if (!Number.isInteger(hunkIndex) || hunkIndex < 0) {
      return res.json({ data: { available: false, reason: 'hunkIndex must be a non-negative integer' } });
    }

    const gitClone = project?.fields?.gitClone;
    if (!gitClone) {
      return res.json({ data: { available: false, reason: 'no gitClone field set' } });
    }
    const cwd = path.resolve(process.cwd(), gitClone);
    if (!fs.existsSync(path.join(cwd, '.git'))) {
      return res.json({ data: { available: false, reason: `not a git repository: ${cwd}` } });
    }

    try {
      const result = await gitRevertHunkTool.execute({ cwd, file, hunkIndex });
      return res.json({ data: { available: true, reverted: true, file: result.file, hunkIndex } });
    } catch (err) {
      return res.json({ data: { available: false, reason: err.message } });
    }
  },

  // GET /api/projects/:id/meta
  // Returns the stored `meta` JSON plus whatever hooks listening to
  // `project.meta-request` choose to add. Hooks mutate `response` in place
  // — multiple hooks can contribute different keys without colliding.
  async getMeta(req, res) {
    const id = parseId(req.params.id);
    const project = projectsService.view(userActor(req.user.id), id);

    // Start with the project's own stored meta as a baseline.
    const response = { ...(project.meta || {}) };

    await registry.emit('project.meta-request', { project, response });

    res.json({ data: response });
  },

  meta(req, res) {
    res.json({
      data: {
        priorities: projectsService.PRIORITIES,
        statuses: projectsService.STATUSES,
        types: registry.listTypes(),
        buttons: registry.listButtons(),
      },
    });
  },
};
