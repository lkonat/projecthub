// Tiny registry: project types + hookable lifecycle events.
//
// Types are pure-data definitions: { id, label, defaults?, description? }
// Hooks are { event, type?, handler(payload, ctx) }
//
// Supported events:
//   'project.before-create' — payload = { input },         mutate input.* or throw to cancel.
//                             Runs inside the same DB transaction as the insert.
//   'project.after-create'  — payload = { project, input } side-effects only.
//                             Runs after commit; errors are logged, request still succeeds.

// Events that MUST be emitted with project context in the payload.
// The registry rejects emit() for these events if `project`, `input.type`,
// `projectId`, or `projectType` is missing — turns the otherwise-silent
// "fall through to globals only" misroute into a loud, throw-at-call-site
// bug.
const PROJECT_SCOPED_EVENTS = new Set([
  'project.before-create',
  'project.after-create',
  'project.after-update',
  'project.after-delete',
  // Fired when the first client subscribes to `project:<id>` (room goes 0→1)
  // and when the last leaves (1→0). Useful for starting/stopping
  // per-project work (file watching, polling, etc.).
  'project.activate',
  'project.deactivate',
  // Fired by projectDirTracker for each file/dir change in a tracked repo.
  'project.file-changed',
  // Request/response style event. Fired by GET /api/projects/:id/meta.
  // Hooks mutate `payload.response` to add type-specific live data
  // (e.g. fresh git status). The endpoint returns whatever ends up
  // in `response`.
  'project.meta-request',
  'comment.after-create',
  'comment.after-delete',
]);

// All known events. Currently every event is project-scoped; system-level
// events (`server.started`, etc.) would slot in here and not in the set above.
const VALID_EVENTS = new Set([...PROJECT_SCOPED_EVENTS]);
const VALID_FIELD_TYPES = new Set(['text', 'textarea', 'number', 'date', 'select', 'boolean']);

function validateFieldDefs(typeId, fields, source) {
  if (fields === undefined) return [];
  if (!Array.isArray(fields)) {
    throw new Error(`Type '${typeId}' in ${source}: 'fields' must be an array`);
  }
  const seen = new Set();
  for (const f of fields) {
    if (!f || typeof f !== 'object') {
      throw new Error(`Type '${typeId}' in ${source}: each field must be an object`);
    }
    if (!f.key || typeof f.key !== 'string' || !/^[a-z][a-z0-9_]*$/i.test(f.key)) {
      throw new Error(`Type '${typeId}' in ${source}: field key '${f.key}' must match /^[a-z][a-z0-9_]*$/i`);
    }
    if (seen.has(f.key)) {
      throw new Error(`Type '${typeId}' in ${source}: duplicate field key '${f.key}'`);
    }
    seen.add(f.key);
    if (!f.label || typeof f.label !== 'string') {
      throw new Error(`Type '${typeId}' in ${source}: field '${f.key}' missing label`);
    }
    if (!VALID_FIELD_TYPES.has(f.type)) {
      throw new Error(`Type '${typeId}' in ${source}: field '${f.key}' has invalid type '${f.type}'. Valid: ${[...VALID_FIELD_TYPES].join(', ')}`);
    }
    if (f.type === 'select') {
      if (!Array.isArray(f.options) || f.options.length === 0) {
        throw new Error(`Type '${typeId}' in ${source}: select field '${f.key}' needs non-empty 'options' array`);
      }
      for (const opt of f.options) {
        if (typeof opt !== 'string') {
          throw new Error(`Type '${typeId}' in ${source}: select field '${f.key}' options must be strings`);
        }
      }
    }
  }
  return fields;
}

const types = new Map();
const buttons = new Map();

// Hook storage:
//   `hooks`   — flat list in registration order; powers listHooks() and
//               provides the stable insertion-order tiebreak via `seq`.
//   `byEvent` — index for O(1) dispatch lookup:
//
//                 byEvent: Map<event, { any: Set<hook>, typed: Map<type, Set<hook>> }>
//
//   `any` is hooks with no type filter (run for every project type).
//   `typed.get(t)` is hooks scoped to that type.
//   At emit time we union `any` with `typed.get(projectType)` and sort the
//   resulting subset by `seq`. Dispatch cost is O(K log K) over the
//   matching hooks — independent of the total registered hook count.
const hooks = [];
const byEvent = new Map();
let hookSeq = 0;

function bucketFor(event) {
  let b = byEvent.get(event);
  if (!b) { b = { any: new Set(), typed: new Map() }; byEvent.set(event, b); }
  return b;
}

function indexHook(hook) {
  const bucket = bucketFor(hook.event);
  if (hook.type) {
    let set = bucket.typed.get(hook.type);
    if (!set) { set = new Set(); bucket.typed.set(hook.type, set); }
    set.add(hook);
  } else {
    bucket.any.add(hook);
  }
}

function payloadHasProjectContext(payload) {
  return Boolean(
    payload?.project ||
    payload?.input?.type ||
    payload?.projectId ||
    payload?.projectType
  );
}

function resolveProjectType(payload) {
  return (
    payload?.project?.type ??
    payload?.input?.type ??
    payload?.projectType ??
    null
  );
}

export const registry = {
  // ---- types ----
  registerType(def, source = '<unknown>') {
    if (!def || typeof def !== 'object') throw new Error(`Type from ${source} must export an object`);
    const { id, label } = def;
    if (!id || typeof id !== 'string') throw new Error(`Type from ${source} missing string 'id'`);
    if (!label || typeof label !== 'string') throw new Error(`Type '${id}' from ${source} missing 'label'`);
    if (types.has(id)) throw new Error(`Duplicate type id '${id}' (from ${source})`);
    validateFieldDefs(id, def.fields, source);
    types.set(id, { ...def, fields: def.fields ?? [], _source: source });
  },

  listTypes() {
    return Array.from(types.values()).map(({ _source, ...t }) => t);
  },

  getType(id) {
    if (!id) return null;
    const t = types.get(id);
    if (!t) return null;
    const { _source, ...rest } = t;
    return rest;
  },

  hasType(id) {
    return types.has(id);
  },

  // ---- hooks ----
  registerHook(def, source = '<unknown>') {
    if (!def || typeof def !== 'object') throw new Error(`Hook from ${source} must export an object`);
    const { event, handler, type } = def;
    if (!VALID_EVENTS.has(event)) {
      throw new Error(`Hook from ${source} has invalid event '${event}'. Valid: ${[...VALID_EVENTS].join(', ')}`);
    }
    if (typeof handler !== 'function') throw new Error(`Hook from ${source} missing 'handler' function`);
    if (type !== undefined && type !== null && typeof type !== 'string') {
      throw new Error(`Hook from ${source} has non-string 'type' filter`);
    }
    const hook = { event, type: type || null, handler, source, seq: hookSeq++ };
    hooks.push(hook);
    indexHook(hook);
  },

  listHooks() {
    return hooks.map(({ event, type, source }) => ({ event, type, source }));
  },

  async emit(event, payload, ctx) {
    if (!VALID_EVENTS.has(event)) throw new Error(`Unknown event '${event}'`);

    // STRICT: project-scoped events must carry project context. Falling
    // through to "globals only" silently — as we used to — masks bugs.
    if (PROJECT_SCOPED_EVENTS.has(event) && !payloadHasProjectContext(payload)) {
      throw new Error(
        `Event '${event}' is project-scoped — payload must include one of: ` +
        `'project', 'input.type', 'projectId', 'projectType'`
      );
    }

    const bucket = byEvent.get(event);
    if (!bucket) return;  // no hooks registered for this event

    const projectType = resolveProjectType(payload);

    // Union the globals with the type-specific hooks for this projectType,
    // then sort by registration order for deterministic dispatch.
    const matching = [];
    for (const h of bucket.any) matching.push(h);
    if (projectType) {
      const typed = bucket.typed.get(projectType);
      if (typed) for (const h of typed) matching.push(h);
    }
    matching.sort((a, b) => a.seq - b.seq);

    for (const h of matching) {
      try {
        await h.handler(payload, ctx);
      } catch (err) {
        // before-* hooks bubble up (cancel the operation).
        // after-* hooks are best-effort: log and continue.
        if (event.includes('before')) throw err;
        console.error(`[hook ${h.source}] ${event} failed:`, err.message);
      }
    }
  },

  // ---- buttons ----
  // A button is an on-demand action attached to a project. Shape:
  //   { id, label, type?, confirm?, destructive?, async handler({project}, ctx) }
  registerButton(def, source = '<unknown>') {
    if (!def || typeof def !== 'object') throw new Error(`Button from ${source} must export an object`);
    const { id, label, handler, type, confirm, destructive } = def;
    if (!id || typeof id !== 'string' || !/^[a-z][a-z0-9_-]*$/i.test(id)) {
      throw new Error(`Button from ${source}: 'id' must match /^[a-z][a-z0-9_-]*$/i (got '${id}')`);
    }
    if (!label || typeof label !== 'string') throw new Error(`Button '${id}' from ${source} missing 'label'`);
    if (typeof handler !== 'function') throw new Error(`Button '${id}' from ${source} missing 'handler' function`);
    if (type !== undefined && typeof type !== 'string') throw new Error(`Button '${id}' from ${source} has non-string 'type' filter`);
    if (confirm !== undefined && typeof confirm !== 'string') throw new Error(`Button '${id}' from ${source} 'confirm' must be a string`);
    if (buttons.has(id)) throw new Error(`Duplicate button id '${id}' (from ${source})`);
    buttons.set(id, {
      id, label, handler,
      type: type || null,
      confirm: confirm || null,
      destructive: !!destructive,
      _source: source,
    });
  },

  // Returns the public shape (no handler, no _source).
  listButtons(projectType = undefined) {
    const out = [];
    for (const b of buttons.values()) {
      if (projectType !== undefined && b.type && b.type !== projectType) continue;
      const { handler, _source, ...rest } = b;
      out.push(rest);
    }
    return out;
  },

  // Internal: returns the full button incl. handler. Used by the endpoint.
  getButton(id) {
    return buttons.get(id) || null;
  },

  // Test/dev helper — wipes everything. Only used by reload paths.
  _reset() {
    types.clear();
    hooks.length = 0;
    byEvent.clear();
    hookSeq = 0;
    buttons.clear();
  },
};
