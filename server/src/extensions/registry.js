import { getDb } from '../db/connection.js';

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
  // before-create is scoped, but the project doesn't exist yet, so its context
  // check is relaxed — see PENDING_ENTITY_EVENTS below.
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
  'checklist.after-create',
  'checklist.after-update',
  'checklist.after-delete',
  'checklist.after-reorder',
  'phase.after-create',
  'phase.after-update',
  'phase.after-delete',
  'phase.after-reorder',
  // A phase becomes the current one through forward progress (idle -> active):
  // the first phase created, or the next idle phase promoted when the active
  // one completes. Distinct from phase.after-reopen below.
  'phase.after-activate',
  'phase.after-complete',
  // A done phase is REACTIVATED via "go backward" (done -> active). Differs from
  // phase.after-activate, which is the normal forward advance.
  'phase.after-reopen',
  'project.after-close',
  'assignment.after-create',
  'assignment.after-update',
  // An assignment was cancelled (status -> cancelled). Distinct from the generic
  // after-update so hooks can react specifically to dropped work.
  'assignment.after-cancel',
  'assignment.after-delete',
]);

// Project-scoped events fired BEFORE the project row exists. There is no
// `project`/`projectId` yet — the only context is the pending `input`, and an
// untyped project legitimately has `input.type === null`. For these we relax
// the strict context check: require the `input` object to be present (which
// still catches a genuinely contextless call) but do NOT require a type.
// Routing to globals-only when there's no type is the correct behavior here,
// not a misroute, so it must not throw.
const PENDING_ENTITY_EVENTS = new Set([
  'project.before-create',
]);

// All known events. Currently every event is project-scoped; system-level
// events (`server.started`, etc.) would slot in here and not in the set above.
const VALID_EVENTS = new Set([...PROJECT_SCOPED_EVENTS]);
const VALID_FIELD_TYPES = new Set(['text', 'textarea', 'number', 'date', 'select', 'boolean']);

// Validates an array of field definitions (used by both project types and
// button inputs). `label` is a context prefix for error messages, e.g.
// "Type 'client-work'" or "Button 'create-repo' inputs".
function validateFieldDefs(fields, source, label) {
  if (fields === undefined) return [];
  if (!Array.isArray(fields)) {
    throw new Error(`${label} in ${source}: must be an array`);
  }
  const seen = new Set();
  for (const f of fields) {
    if (!f || typeof f !== 'object') {
      throw new Error(`${label} in ${source}: each field must be an object`);
    }
    if (!f.key || typeof f.key !== 'string' || !/^[a-z][a-z0-9_]*$/i.test(f.key)) {
      throw new Error(`${label} in ${source}: field key '${f.key}' must match /^[a-z][a-z0-9_]*$/i`);
    }
    if (seen.has(f.key)) {
      throw new Error(`${label} in ${source}: duplicate field key '${f.key}'`);
    }
    seen.add(f.key);
    if (!f.label || typeof f.label !== 'string') {
      throw new Error(`${label} in ${source}: field '${f.key}' missing label`);
    }
    if (!VALID_FIELD_TYPES.has(f.type)) {
      throw new Error(`${label} in ${source}: field '${f.key}' has invalid type '${f.type}'. Valid: ${[...VALID_FIELD_TYPES].join(', ')}`);
    }
    if (f.type === 'select') {
      if (!Array.isArray(f.options) || f.options.length === 0) {
        throw new Error(`${label} in ${source}: select field '${f.key}' needs non-empty 'options' array`);
      }
      for (const opt of f.options) {
        if (typeof opt !== 'string') {
          throw new Error(`${label} in ${source}: select field '${f.key}' options must be strings`);
        }
      }
    }
    // `default` (optional) may be a literal or a function(project) — evaluated
    // per project when the button is resolved. `required`/`options` already
    // handled above; anything else is passed through untouched.
    if (f.default !== undefined && typeof f.default === 'function' && f.default.length > 1) {
      throw new Error(`${label} in ${source}: field '${f.key}' default function takes (project)`);
    }
  }
  return fields;
}

const types = new Map();
const buttons = new Map();
// Per-type settings objects (from types/<id>/settings/settings.js), passed to
// that type's hook/button handlers as the 3rd arg. Keyed by type id.
const typeSettings = new Map();

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

// The client-facing shape of a button: drops the handler, the visibility
// predicates, and internal bookkeeping. `visible`/`disabled` are server-only
// (they're functions). `inputs` is added back contextually (sanitized or
// resolved against a project) by the callers below.
function publicButton(b) {
  const { handler, visible, disabled, inputs, _source, ...rest } = b;
  return rest;
}

// Input field defs as sent to a client with NO project context (e.g. the
// global meta list). A `default` that's a function can't be evaluated without
// a project, so it's dropped here.
function sanitizeButtonInputs(inputs) {
  return (inputs || []).map((f) => {
    if (typeof f.default === 'function') {
      const { default: _drop, ...rest } = f;
      return rest;
    }
    return f;
  });
}

// Input field defs resolved against a specific project: a function `default`
// is invoked as default(project) to produce the concrete prefill value the
// client renders. A throwing default just yields no prefill.
function resolveButtonInputs(inputs, project) {
  return (inputs || []).map((f) => {
    if (typeof f.default !== 'function') return f;
    const { default: fn, ...rest } = f;
    let value;
    try { value = fn(project); }
    catch (err) { console.error(`[button input ${f.key}] default() threw: ${err.message}`); }
    return value === undefined ? rest : { ...rest, default: value };
  });
}

// Buttons are keyed by (type, id), so the same id can exist for different
// types (e.g. a library button reused across types). `type: null` = global.
function buttonKey(type, id) {
  return `${type || ''} ${id}`;
}

// The buttons applicable to a project type: globals (type: null) plus the
// type's own buttons, with a typed button shadowing a global one of the same
// id. Returns the internal button objects (handlers intact).
function buttonsForType(type) {
  const byId = new Map();
  for (const b of buttons.values()) if (b.type === null) byId.set(b.id, b);
  if (type) for (const b of buttons.values()) if (b.type === type) byId.set(b.id, b);
  return [...byId.values()];
}

// ---- hook/button context ----
//
// The `ctx` passed to every hook and button handler is assembled here, once.
// Its parts — the db handle, the services registry, and the realtime
// broadcaster — are all process-wide singletons, so the ctx is effectively
// constant and we memoize it. `services` and `realtime` are imported lazily to
// avoid an evaluation cycle (services.js → *.service.js → this module); that
// import runs on the first emit, by which point everything has evaluated.
const NOOP_REALTIME = {
  broadcast() {}, broadcastAll() {}, isStarted() { return false; },
};

let cachedCtx = null;

async function buildContext() {
  if (cachedCtx) return cachedCtx;
  const { services } = await import('../services.js');
  let realtime = NOOP_REALTIME;
  try { ({ realtime } = await import('../realtime/index.js')); }
  catch { /* realtime unavailable (e.g. some tests) — use the no-op */ }
  cachedCtx = {
    log: console,
    services,
    realtime,
    // A getter, not a captured handle: getDb() is a singleton (it never opens
    // a second connection), but a test may closeDb()/getDb() to swap it.
    get db() { return getDb(); },
  };
  return cachedCtx;
}

export const registry = {
  // ---- types ----
  registerType(def, source = '<unknown>') {
    if (!def || typeof def !== 'object') throw new Error(`Type from ${source} must export an object`);
    const { id, label } = def;
    if (!id || typeof id !== 'string') throw new Error(`Type from ${source} missing string 'id'`);
    if (!label || typeof label !== 'string') throw new Error(`Type '${id}' from ${source} missing 'label'`);
    if (types.has(id)) throw new Error(`Duplicate type id '${id}' (from ${source})`);
    if (def.buttons !== undefined && !Array.isArray(def.buttons)) {
      throw new Error(`Type '${id}' in ${source}: 'buttons' must be an array of button objects`);
    }
    validateFieldDefs(def.fields, source, `Type '${id}'`);
    // `buttons` are registered separately (scoped to this type) by the loader;
    // keep them out of the stored type record so listTypes() stays pure data.
    const { buttons: _libButtons, ...rest } = def;
    types.set(id, { ...rest, fields: def.fields ?? [], _source: source });
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

  // ---- per-type settings ----
  // The settings object (from types/<id>/settings/settings.js) handed to that
  // type's hook/button handlers as the 3rd arg. Optional per type.
  registerSettings(typeId, settings) {
    if (!typeId || typeof typeId !== 'string') {
      throw new Error('registerSettings requires a string typeId');
    }
    typeSettings.set(typeId, settings ?? null);
  },

  getSettings(typeId) {
    return (typeId && typeSettings.get(typeId)) || null;
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

  // emit owns the ctx: handlers receive a single, memoized context (see
  // buildContext). Callers just pass the event + payload — no ctx threading.
  async emit(event, payload) {
    console.log(`[event]-${event}`, payload)
    if (!VALID_EVENTS.has(event)) throw new Error(`Unknown event '${event}'`);

    // STRICT: project-scoped events must carry project context. Falling
    // through to "globals only" silently — as we used to — masks bugs.
    // EXCEPTION: pending-entity events (before-create) have no project yet, so
    // they only need the `input` object — an untyped project (input.type ===
    // null) routes to globals-only, which is correct, not a misroute.
    if (PROJECT_SCOPED_EVENTS.has(event)) {
      if (PENDING_ENTITY_EVENTS.has(event)) {
        if (!payload || typeof payload.input !== 'object' || payload.input === null) {
          throw new Error(
            `Event '${event}' fires before the project exists — payload must include an 'input' object`
          );
        }
      } else if (!payloadHasProjectContext(payload)) {
        throw new Error(
          `Event '${event}' is project-scoped — payload must include one of: ` +
          `'project', 'input.type', 'projectId', 'projectType'`
        );
      }
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
    if (matching.length === 0) return;  // nothing to run — skip building ctx
    matching.sort((a, b) => a.seq - b.seq);

    const ctx = await buildContext();
    // This type's settings (if any), handed to handlers as the 3rd arg.
    const settings = projectType ? typeSettings.get(projectType) ?? null : null;
    for (const h of matching) {
      try {
        await h.handler(payload, ctx, settings);
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
  //   {
  //     id, label, type?, confirm?, destructive?,
  //     visible?(project): boolean,           // default true; false => hidden
  //     disabled?(project): boolean | string, // default false; string => reason
  //     inputs?: FieldDef[],                  // prompt the user before running
  //     async handler({project, input}, ctx),
  //   }
  // `visible`/`disabled` are pure, synchronous predicates of the project; they
  // gate display only — the action endpoint re-evaluates them before running.
  // `inputs` use the same shape as a type's `fields` (text/textarea/number/
  // date/select/boolean, + required/options/default). A field `default` may be
  // a literal or a function(project) evaluated when the button is resolved.
  registerButton(def, source = '<unknown>') {
    if (!def || typeof def !== 'object') throw new Error(`Button from ${source} must export an object`);
    const { id, label, handler, type, confirm, destructive, visible, disabled, inputs } = def;
    if (!id || typeof id !== 'string' || !/^[a-z][a-z0-9_-]*$/i.test(id)) {
      throw new Error(`Button from ${source}: 'id' must match /^[a-z][a-z0-9_-]*$/i (got '${id}')`);
    }
    if (!label || typeof label !== 'string') throw new Error(`Button '${id}' from ${source} missing 'label'`);
    if (typeof handler !== 'function') throw new Error(`Button '${id}' from ${source} missing 'handler' function`);
    if (type !== undefined && typeof type !== 'string') throw new Error(`Button '${id}' from ${source} has non-string 'type' filter`);
    if (confirm !== undefined && typeof confirm !== 'string') throw new Error(`Button '${id}' from ${source} 'confirm' must be a string`);
    if (visible !== undefined && typeof visible !== 'function') throw new Error(`Button '${id}' from ${source}: 'visible' must be a function`);
    if (disabled !== undefined && typeof disabled !== 'function') throw new Error(`Button '${id}' from ${source}: 'disabled' must be a function`);
    // Identity is (type, id), so the same id can be reused across types.
    const key = buttonKey(type, id);
    if (buttons.has(key)) {
      throw new Error(
        `Duplicate button id '${id}'${type ? ` for type '${type}'` : ' (global)'} (from ${source})`
      );
    }
    buttons.set(key, {
      id, label, handler,
      type: type || null,
      confirm: confirm || null,
      destructive: !!destructive,
      visible: visible || null,
      disabled: disabled || null,
      inputs: validateFieldDefs(inputs, source, `Button '${id}' inputs`),
      _source: source,
    });
  },

  // Returns the public shape (no handler, no predicates, no _source). Function
  // defaults on inputs are dropped (no project to evaluate them against).
  // With a projectType, returns just that type's effective buttons (globals +
  // typed); without one, every registered button (each carries its `type`).
  listButtons(projectType = undefined) {
    const list = projectType === undefined ? [...buttons.values()] : buttonsForType(projectType);
    return list.map((b) => ({ ...publicButton(b), inputs: sanitizeButtonInputs(b.inputs) }));
  },

  // Evaluate one button's visibility/disabled state against a project. A
  // throwing `visible` predicate hides the button (safe default); a throwing
  // `disabled` predicate disables it with a generic reason. Both are logged.
  evaluateButton(b, project) {
    let visible = true;
    if (b.visible) {
      try { visible = !!b.visible(project); }
      catch (err) {
        console.error(`[button ${b.id}] visible() threw: ${err.message} — hiding`);
        visible = false;
      }
    }
    let disabled = false, disabledReason = null;
    if (b.disabled) {
      try {
        const d = b.disabled(project);
        disabled = !!d;
        if (typeof d === 'string') disabledReason = d;
      } catch (err) {
        console.error(`[button ${b.id}] disabled() threw: ${err.message} — disabling`);
        disabled = true;
        disabledReason = 'unavailable';
      }
    }
    return { visible, disabled, disabledReason };
  },

  // Public buttons applicable to a project (globals + its type's buttons),
  // hidden ones dropped, each carrying its computed { disabled, disabledReason }.
  resolveButtonsForProject(project) {
    const out = [];
    for (const b of buttonsForType(project.type)) {
      const state = this.evaluateButton(b, project);
      if (!state.visible) continue;
      out.push({
        ...publicButton(b),
        inputs: resolveButtonInputs(b.inputs, project),
        disabled: state.disabled,
        disabledReason: state.disabledReason,
      });
    }
    return out;
  },

  // Internal: the full button (incl. handler) for a project type + id — a
  // typed button shadows a global one of the same id. Used by the endpoint.
  getButton(type, id) {
    return buttons.get(buttonKey(type, id)) || buttons.get(buttonKey(null, id)) || null;
  },

  // The memoized hook/button context. emit() uses this internally; exposed
  // for the one handler kind NOT dispatched through emit — buttons, which
  // actions.controller invokes directly.
  getContext() {
    return buildContext();
  },

  // Test/dev helper — wipes everything. Only used by reload paths.
  _reset() {
    types.clear();
    hooks.length = 0;
    byEvent.clear();
    hookSeq = 0;
    buttons.clear();
    typeSettings.clear();
    cachedCtx = null;
  },
};
