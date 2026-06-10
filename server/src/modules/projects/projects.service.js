import { projectsRepository } from './projects.repository.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { registry } from '../../extensions/registry.js';
import { getDb } from '../../db/connection.js';
import { validateAndCoerce } from './fields.js';
import { access } from '../../access/access.service.js';

const PRIORITIES = ['low', 'medium', 'high', 'critical'];
const STATUSES = ['active', 'cancelled', 'done'];

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

  // The actor's own projects (ownership-filtered list).
  list(actor, filters) {
    if (filters.priority) validatePriority(filters.priority);
    if (filters.status)   validateStatus(filters.status);
    return projectsRepository.list(actor.id, filters);
  },

  // Authorized single-project read (owner OR assignee). Returns the project.
  view(actor, id) {
    return access.authorize(actor, id, 'project.view');
  },

  // Lookup by id WITHOUT an authorization check — the trusted internal lane,
  // for service-to-service calls and existence checks on an already-authorized
  // project (hooks, cascades, comments/checklist/phases services). Anything a
  // PRINCIPAL initiates must go through an actor-authorized method instead;
  // the policy table (server/src/access/) is the single source of truth.
  get(id) {
    const project = projectsRepository.findById(id);
    if (!project) throw new NotFoundError('Project');
    return project;
  },

  async create(actor, { name, description, priority, status, type, fields, meta }) {
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

    // before-create + insert run in one transaction so a hook can cancel cleanly.
    // We can't use db.transaction(fn) because it doesn't await async functions —
    // it would commit before async hooks resolve.
    db.exec('BEGIN');
    let project;
    try {
      await registry.emit('project.before-create', { input });
      project = projectsRepository.create({ ...input, userId: actor.id });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    // after-create fires post-commit; errors are logged but don't fail the request.
    await registry.emit('project.after-create', { project, input });

    return project;
  },

  async update(actor, id, patch) {
    const existing = this.get(id); // throws if missing
    access.authorize(actor, id, 'project.edit', {}, existing); // owner; SYSTEM bypasses (e.g. auto-close)
    // A closed (non-active) project is a frozen record: the status field may
    // still change (complete / cancel / reactivate), but content edits require
    // the project to be active. Reactivate it first to edit. SYSTEM bypasses.
    const CONTENT_FIELDS = ['name', 'description', 'priority', 'type', 'fields', 'meta'];
    if (CONTENT_FIELDS.some((f) => patch[f] !== undefined)) {
      access.authorize(actor, id, 'project.edit-content', {}, existing);
    }
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
    await registry.emit('project.after-update', { project: updated, before: existing });
    return updated;
  },

  async remove(actor, id) {
    const existing = this.get(id); // throws if missing
    access.authorize(actor, id, 'project.delete', {}, existing);
    const removed = projectsRepository.remove(id);
    await registry.emit('project.after-delete', { id, project: existing });
    return removed;
  },

  // Partial update for the `fields` object. Pass only the keys you want to
  // change — existing keys are preserved. Pass `null` for a key to clear it
  // (subject to required-field validation against the project's type).
  //
  //   projectsService.updateFields(actor, id, { gitClone: '/Users/.../onboarding' });
  //
  // Delegates to `update()` so all validation/coercion (and authorization) apply.
  async updateFields(actor, id, partial) {
    if (!partial || typeof partial !== 'object') {
      throw new ValidationError('updateFields requires an object of field values');
    }
    const existing = this.get(id);
    const merged = { ...(existing.fields || {}), ...partial };
    return this.update(actor, id, { fields: merged });
  },

  // Partial update for the `meta` object — free-form metadata not bound to
  // the type's field schema. Pass only the keys you want to change;
  // existing keys are preserved. Pass `null` for a key to clear it.
  //
  //   projectsService.updateMeta(actor, id, { lastClonedAt: ... });
  //   projectsService.updateMeta(actor, id, { tempFlag: null });   // remove tempFlag
  async updateMeta(actor, id, partial) {
    if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
      throw new ValidationError('updateMeta requires a plain object');
    }
    const existing = this.get(id);
    const merged = dropNullish({ ...(existing.meta || {}), ...partial });
    return this.update(actor, id, { meta: merged });
  },
};
