import { projectsService } from './projects.service.js';
import { parseId } from '../../middleware/validate.js';
import { registry } from '../../extensions/registry.js';
import { NotFoundError, AppError } from '../../utils/errors.js';
import { getDb } from '../../db/connection.js';
import { services } from '../../services.js';

export const actionsController = {
  // POST /api/projects/:id/actions/:buttonId
  async run(req, res) {
    const projectId = parseId(req.params.id, 'project id');
    const buttonId = req.params.buttonId;

    const button = registry.getButton(buttonId);
    if (!button) throw new NotFoundError(`Button '${buttonId}'`);

    const project = projectsService.get(projectId); // throws if missing

    if (button.type && button.type !== project.type) {
      throw new AppError(
        `Button '${buttonId}' is only available for projects of type '${button.type}'`,
        400,
        'BUTTON_NOT_APPLICABLE'
      );
    }

    const ctx = { db: getDb(), log: console, services };
    let result;
    try {
      result = await button.handler({ project }, ctx);
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
        project: projectsService.get(projectId), // fresh state after any mutations
        result: result === undefined ? { ok: true } : result,
      },
    });
  },
};
