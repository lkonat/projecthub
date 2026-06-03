import { projectsRepository } from './projects.repository.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { registry } from '../../extensions/registry.js';
import { getDb } from '../../db/connection.js';
import { validateAndCoerce } from './fields.js';

// Build the context object passed to every emitted lifecycle event.
// Resolved lazily because services.js and realtime/index.js participate in
// import cycles with this module — they're only imported when an emit happens,
// by which point both modules have finished evaluating.
async function buildCtx() {
  const db = getDb();
  const { services } = await import('../../services.js');
  let realtime;
  try { ({ realtime } = await import('../../realtime/index.js')); }
  catch { realtime = { broadcast() {}, isStarted() { return false; } }; }
  return { db, log: console, services, realtime };
}

const PRIORITIES = ['low', 'medium', 'high', 'critical'];
const STATUSES = ['active', 'paused', 'completed', 'archived'];

function validatePriority(p) {
  if (p !== undefined && !PRIORITIES.includes(p)) {
    throw new ValidationError(`priority must be one of: ${PRIORITIES.join(', ')}`);
  }
}
function validateStatus(s) {
  if (s !== undefined && !STATUSES.includes(s)) {
    throw new ValidationError(`status must be one of: ${STATUSES.join(', ')}`);
  }
}
function validateType(t) {
  if (t === undefined || t === null || t === '') return;
  if (!registry.hasType(t)) {
    const known = registry.listTypes().map((x) => x.id).join(', ') || '(none registered)';
    throw new ValidationError(`unknown project type '${t}'. Known: ${known}`);
  }
}

// `meta` is free-form (no schema). All we enforce is that it's a plain
// object — not an array, primitive, or function — so it can round-trip
// through JSON cleanly.
function validateMeta(m) {
  if (m === undefined || m === null) return;
  if (typeof m !== 'object' || Array.isArray(m)) {
    throw new ValidationError('meta must be a plain object');
  }
}

// Drop keys whose value is null or undefined. Used by updateMeta so callers
// can pass `{ foo: null }` to remove a key.
function dropNullish(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

export const projectsService = {
  PRIORITIES,
  STATUSES,

  list(filters) {
    if (filters.priority) validatePriority(filters.priority);
    if (filters.status)   validateStatus(filters.status);
    return projectsRepository.list(filters);
  },

  get(id) {
    const project = projectsRepository.findById(id);
    if (!project) throw new NotFoundError('Project');
    return project;
  },

  async create({ name, description, priority, status, type, fields, meta }) {
    if (!name || !name.trim()) throw new ValidationError('name is required');
    validateType(type);
    validateMeta(meta);

    // Apply type defaults for any field the caller didn't specify.
    const typeDef = type ? registry.getType(type) : null;
    const defaults = typeDef?.defaults ?? {};
    const fieldDefs = typeDef?.fields ?? [];
    const input = {
      name: name.trim(),
      description: description?.trim() || null,
      priority: priority ?? defaults.priority,
      status:   status   ?? defaults.status,
      type:     type     || null,
      fields:   fieldDefs.length > 0 ? validateAndCoerce(fieldDefs, fields) : null,
      meta:     meta ? dropNullish(meta) : null,
    };

    validatePriority(input.priority);
    validateStatus(input.status);

    const db = getDb();
    const ctx = await buildCtx();

    // before-create + insert run in one transaction so a hook can cancel cleanly.
    // We can't use db.transaction(fn) because it doesn't await async functions —
    // it would commit before async hooks resolve.
    db.exec('BEGIN');
    let project;
    try {
      await registry.emit('project.before-create', { input }, ctx);
      project = projectsRepository.create(input);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    // after-create fires post-commit; errors are logged but don't fail the request.
    await registry.emit('project.after-create', { project, input }, ctx);

    return project;
  },

  async update(id, patch) {
    const existing = this.get(id); // throws if missing
    if (patch.name !== undefined) {
      if (!patch.name || !patch.name.trim()) throw new ValidationError('name cannot be empty');
      patch.name = patch.name.trim();
    }
    if (patch.description !== undefined) {
      patch.description = patch.description?.trim() || null;
    }
    validatePriority(patch.priority);
    validateStatus(patch.status);
    validateType(patch.type);
    if (patch.meta !== undefined) {
      validateMeta(patch.meta);
      // null/undefined patch.meta means "clear it"; pass through.
      if (patch.meta) patch.meta = dropNullish(patch.meta);
    }

    // Validate fields against whichever type the project will have after this update.
    // If type changes, existing fields don't carry over — caller must resend them.
    if (patch.fields !== undefined || patch.type !== undefined) {
      const effectiveType = patch.type !== undefined ? patch.type : existing.type;
      const typeDef = effectiveType ? registry.getType(effectiveType) : null;
      // Guard: a project references a type that isn't registered (e.g. its
      // extension file was deleted). Refuse to touch the fields rather than
      // silently wiping them. The user can restore the type file or change
      // the project's `type` first.
      if (effectiveType && !typeDef) {
        throw new ValidationError(
          `Project's type '${effectiveType}' is not currently registered. ` +
          `Restore the type or change the project's type before updating fields.`
        );
      }
      const fieldDefs = typeDef?.fields ?? [];
      if (fieldDefs.length > 0) {
        const source = patch.fields !== undefined
          ? patch.fields
          : (patch.type === existing.type ? existing.fields : {});
        patch.fields = validateAndCoerce(fieldDefs, source);
      } else {
        patch.fields = null;
      }
    }

    const updated = projectsRepository.update(id, patch);
    await registry.emit('project.after-update', { project: updated, before: existing }, await buildCtx());
    return updated;
  },

  async remove(id) {
    const existing = this.get(id); // throws if missing
    const removed = projectsRepository.remove(id);
    await registry.emit('project.after-delete', { id, project: existing }, await buildCtx());
    return removed;
  },

  // Partial update for the `fields` object. Pass only the keys you want to
  // change — existing keys are preserved. Pass `null` for a key to clear it
  // (subject to required-field validation against the project's type).
  //
  //   projectsService.updateFields(id, { gitClone: '/Users/.../onboarding' });
  //
  // Delegates to `update()` so all validation/coercion still applies.
  async updateFields(id, partial) {
    if (!partial || typeof partial !== 'object') {
      throw new ValidationError('updateFields requires an object of field values');
    }
    const existing = this.get(id);
    const merged = { ...(existing.fields || {}), ...partial };
    return this.update(id, { fields: merged });
  },

  // Partial update for the `meta` object — free-form metadata not bound to
  // the type's field schema. Pass only the keys you want to change;
  // existing keys are preserved. Pass `null` for a key to clear it.
  //
  //   projectsService.updateMeta(id, { lastClonedAt: new Date().toISOString() });
  //   projectsService.updateMeta(id, { tempFlag: null });   // remove tempFlag
  async updateMeta(id, partial) {
    if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
      throw new ValidationError('updateMeta requires a plain object');
    }
    const existing = this.get(id);
    const merged = dropNullish({ ...(existing.meta || {}), ...partial });
    return this.update(id, { meta: merged });
  },
};
