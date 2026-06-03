import { sshRepository } from './ssh.repository.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import sshRunTool from '../../../../extensions/shared/ssh/run.js';

function validateHost(host) {
  if (!host || !host.trim()) throw new ValidationError('host is required');
}

function validatePort(port) {
  if (port === undefined || port === null) return;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ValidationError('port must be an integer between 1 and 65535');
  }
}

export const sshService = {
  list() {
    return sshRepository.list();
  },

  get(id) {
    const conn = sshRepository.findById(id);
    if (!conn) throw new NotFoundError('SSH connection');
    return conn;
  },

  create({ name, host, port, username, identityFile }) {
    if (!name || !name.trim()) throw new ValidationError('name is required');
    validateHost(host);
    validatePort(port);
    if (sshRepository.findByName(name.trim())) {
      throw new ValidationError(`an SSH connection named '${name.trim()}' already exists`);
    }
    return sshRepository.create({
      name: name.trim(),
      host: host.trim(),
      port: port ?? 22,
      username: username?.trim() || null,
      identityFile: identityFile?.trim() || null,
    });
  },

  update(id, patch) {
    this.get(id); // throws if missing
    if (patch.name !== undefined) {
      if (!patch.name || !patch.name.trim()) throw new ValidationError('name cannot be empty');
      patch.name = patch.name.trim();
      const clash = sshRepository.findByName(patch.name);
      if (clash && clash.id !== id) {
        throw new ValidationError(`an SSH connection named '${patch.name}' already exists`);
      }
    }
    if (patch.host !== undefined) { validateHost(patch.host); patch.host = patch.host.trim(); }
    if (patch.port !== undefined) validatePort(patch.port);
    if (patch.username !== undefined) patch.username = patch.username?.trim() || null;
    if (patch.identityFile !== undefined) patch.identityFile = patch.identityFile?.trim() || null;
    return sshRepository.update(id, patch);
  },

  remove(id) {
    this.get(id); // throws if missing
    return sshRepository.remove(id);
  },

  // Run a command against a saved connection.
  async run(id, command) {
    const conn = this.get(id);
    return this.runAdhoc({
      host: conn.host,
      port: conn.port,
      username: conn.username,
      identityFile: conn.identity_file,
      command,
    });
  },

  // Run a command against a host described inline, without saving it.
  async runAdhoc({ host, command, username, port, identityFile, timeoutMs, strictHostKeyChecking }) {
    validateHost(host);
    validatePort(port);
    if (!command || !command.trim()) throw new ValidationError('command is required');
    return sshRunTool.execute({
      host,
      command,
      username: username || undefined,
      port: port || undefined,
      identityFile: identityFile || undefined,
      timeoutMs: timeoutMs || undefined,
      strictHostKeyChecking: strictHostKeyChecking || undefined,
    });
  },
};
