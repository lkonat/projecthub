import { sshService } from './ssh.service.js';
import { parseId, pickFields } from '../../middleware/validate.js';

const CONNECTION_FIELDS = ['name', 'host', 'port', 'username', 'identityFile'];

export const sshController = {
  list(req, res) {
    res.json({ data: sshService.list() });
  },

  getOne(req, res) {
    const id = parseId(req.params.id);
    res.json({ data: sshService.get(id) });
  },

  create(req, res) {
    const body = pickFields(req.body, CONNECTION_FIELDS);
    res.status(201).json({ data: sshService.create(body) });
  },

  update(req, res) {
    const id = parseId(req.params.id);
    const patch = pickFields(req.body, CONNECTION_FIELDS);
    res.json({ data: sshService.update(id, patch) });
  },

  remove(req, res) {
    const id = parseId(req.params.id);
    sshService.remove(id);
    res.status(204).end();
  },

  // POST /api/ssh/:id/run  — run a command against a saved connection.
  async run(req, res) {
    const id = parseId(req.params.id);
    const { command } = pickFields(req.body, ['command']);
    res.json({ data: await sshService.run(id, command) });
  },

  // POST /api/ssh/run  — run a command against an inline host (nothing saved).
  async runAdhoc(req, res) {
    const body = pickFields(req.body, [
      'host', 'command', 'username', 'port', 'identityFile', 'timeoutMs', 'strictHostKeyChecking',
    ]);
    res.json({ data: await sshService.runAdhoc(body) });
  },
};
