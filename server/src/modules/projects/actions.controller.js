import { projectsService } from './projects.service.js';
import { access } from '../../access/access.service.js';
import { userActor } from '../../access/actor.js';
import { parseId } from '../../middleware/validate.js';
import { registry } from '../../extensions/registry.js';
import { validateAndCoerce } from './fields.js';
import { NotFoundError, AppError } from '../../utils/errors.js';

export const actionsController = {
  // GET /api/projects/:id/actions — buttons applicable to THIS project, with
  // each one's resolved { disabled, disabledReason }. Hidden buttons are
  // omitted. This is what the client renders.
  list(req, res) {
    const projectId = parseId(req.params.id, 'project id');
    const project = access.authorize(userActor(req.user.id), projectId, 'action.view');
    res.json({ data: registry.resolveButtonsForProject(project) });
  },

  // POST /api/projects/:id/actions/:buttonId
  async run(req, res) {
    const projectId = parseId(req.params.id, 'project id');
    const buttonId = req.params.buttonId;

    // Authorize the project first, then resolve the button for its type —
    // buttons are keyed by (type, id), so getButton needs the project's type.
    const project = access.authorize(userActor(req.user.id), projectId, 'action.run');

    const button = registry.getButton(project.type, buttonId);
    if (!button) throw new NotFoundError(`Button '${buttonId}'`);

    // Re-evaluate visibility/disabled server-side — the client's rendered
    // state is advisory; this is the enforcement boundary.
    const { visible, disabled, disabledReason } = registry.evaluateButton(button, project);
    if (!visible) {
      throw new AppError(
        `Button '${buttonId}' is not available for this project`,
        404,
        'BUTTON_NOT_AVAILABLE'
      );
    }
    if (disabled) {
      throw new AppError(
        `Button '${buttonId}' is disabled${disabledReason ? `: ${disabledReason}` : ''}`,
        409,
        'BUTTON_DISABLED'
      );
    }

    // Collect + validate the button's declared inputs from the request body.
    // validateAndCoerce throws ValidationError (→ 400) on bad/missing-required
    // values and strips anything not declared. Buttons with no inputs get {}.
    const input = (button.inputs && button.inputs.length)
      ? validateAndCoerce(button.inputs, req.body || {})
      : {};

    const ctx = await registry.getContext();
    // This type's settings (if any), handed to the handler as the 3rd arg.
    const settings = registry.getSettings(project.type);
    let result;
    try {
      result = await button.handler({ project, input }, ctx, settings);
    } catch (err) {
      // Bubble up domain errors as-is; wrap unexpected ones.
      if (err instanceof AppError) throw err;
      throw new AppError(
        `Button '${buttonId}' failed: ${err.message}`,
        500,
        'BUTTON_HANDLER_ERROR'
      );
    }

    // Return whatever the handler returned, or a sensible default.
    res.json({
      data: {
        button: buttonId,
        project: projectsService.get(projectId), // fresh state after any mutations (already authorized)
        result: result === undefined ? { ok: true } : result,
      },
    });
  },
};
