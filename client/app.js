// Thin client over the REST API. All business logic lives on the server.

import { realtime } from './lib/realtime.js';
import { createGitView } from './lib/gitView.js';
import { createRouter, route } from './lib/router.js';
import { ASSIGNMENT_STATUS, DONE_STATUSES, RUN_ACTIVE_STATUSES, EXECUTION_STATE } from './lib/assignmentStates.mjs';

const API = '/api';

// Set in main() once routes are wired. Used wherever the app changes pages.
let router;

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    credentials: 'include', // send the auth cookie
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    // Session missing/expired — drop back to the login overlay.
    showAuth();
    throw new Error('Not authenticated');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data.data;
}

const state = {
  user: null,
  projects: [],
  selectedId: null,
  canEditSelected: true, // false when viewing a project you're assigned to but don't own
  caps: {}, // per-project capability map from GET /projects/:id (project-scoped affordances)
  meta: { priorities: [], statuses: [] },
  filters: { priority: '', status: '' },
};

// ─── Capabilities ─────────────────────────────────────────────────────────
// The server is ALWAYS the enforcement boundary; these only decide which
// affordances to show. Project-scoped affordances come from the capability map;
// per-ROW affordances come from server-computed booleans on each row (canDelete,
// canUpdate) — the server evaluates the policy (including conditional rules it
// can't ship to the client) and the UI just reads the result.
function can(action) { return !!(state.caps && state.caps[action]); }

// ─── Auth ───────────────────────────────────────────────────────────────
function showAuth() { $('#auth-view').hidden = false; }
function hideAuth() { $('#auth-view').hidden = true; }
function showAuthError(msg) { const el = $('#auth-error'); el.textContent = msg; el.hidden = false; }
function hideAuthError() { $('#auth-error').hidden = true; }

async function fetchMe() {
  try {
    const res = await fetch(API + '/auth/me', { credentials: 'include' });
    if (!res.ok) return null;
    return (await res.json()).data;
  } catch { return null; }
}

let authMode = 'login';
function wireAuth() {
  const form = $('#auth-form');
  const toggle = $('#auth-toggle');

  toggle.addEventListener('click', (e) => {
    e.preventDefault();
    authMode = authMode === 'login' ? 'register' : 'login';
    const login = authMode === 'login';
    $('#auth-title').textContent = login ? 'Log in' : 'Register';
    $('#auth-submit').textContent = login ? 'Log in' : 'Register';
    $('#auth-toggle-text').textContent = login ? 'No account?' : 'Have an account?';
    toggle.textContent = login ? 'Register' : 'Log in';
    form.elements.password.autocomplete = login ? 'current-password' : 'new-password';
    hideAuthError();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAuthError();
    const username = form.elements.username.value.trim();
    const password = form.elements.password.value;
    try {
      const res = await fetch(API + '/auth/' + authMode, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || 'Authentication failed');
      location.reload(); // re-init cleanly as the logged-in user
    } catch (err) {
      showAuthError(err.message);
    }
  });

  $('#logout-btn').addEventListener('click', async () => {
    try { await fetch(API + '/auth/logout', { method: 'POST', credentials: 'include' }); }
    finally { location.reload(); }
  });
}

const $ = (sel) => document.querySelector(sel);

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  return d.toLocaleString();
}

function populateSelect(el, values, { includeAll = false } = {}) {
  el.innerHTML = '';
  if (includeAll) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = 'All';
    el.appendChild(o);
  }
  for (const v of values) {
    const o = document.createElement('option');
    o.value = v; o.textContent = v;
    el.appendChild(o);
  }
}

function populateTypeSelect(el, types, { allowNone = false } = {}) {
  el.innerHTML = '';
  if (allowNone) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = '(none)';
    el.appendChild(o);
  }
  for (const t of types) {
    const o = document.createElement('option');
    o.value = t.id;
    o.textContent = t.label;
    if (t.description) o.title = t.description;
    el.appendChild(o);
  }
}

function applyTypeDefaults(typeId, prioritySel, statusSel) {
  const t = state.meta.types.find((x) => x.id === typeId);
  const d = t?.defaults || {};
  if (d.priority) prioritySel.value = d.priority;
  if (d.status)   statusSel.value   = d.status;
}

function typeById(id) {
  return state.meta.types.find((t) => t.id === id) || null;
}

// Render the custom-field inputs for the given type into `container`.
// `values` is a map of key -> current value used to pre-fill the inputs.
function renderFields(container, typeId, values = {}) {
  renderFieldDefs(container, typeById(typeId)?.fields || [], values);
}

// Render an arbitrary array of field definitions into `container`. Shared by
// the create-project form (a type's fields) and the action-input modal (a
// button's inputs). `values` pre-fills inputs by key.
function renderFieldDefs(container, defs, values = {}) {
  container.innerHTML = '';
  if (!defs || defs.length === 0) return;

  for (const f of defs) {
    const wrap = document.createElement('label');
    const current = values[f.key];
    const name = `field:${f.key}`;

    if (f.type === 'boolean') {
      wrap.className = 'checkbox-row';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.name = name;
      input.dataset.fieldType = f.type;
      input.dataset.fieldKey = f.key;
      if (current === true) input.checked = true;
      wrap.append(input, document.createTextNode(f.label));
      container.appendChild(wrap);
      continue;
    }

    const labelText = document.createElement('span');
    labelText.textContent = f.label;
    if (f.required) {
      const star = document.createElement('span');
      star.className = 'required-star';
      star.textContent = '*';
      labelText.appendChild(star);
    }
    wrap.appendChild(labelText);

    let input;
    if (f.type === 'textarea') {
      input = document.createElement('textarea');
      input.rows = 3;
    } else if (f.type === 'select') {
      input = document.createElement('select');
      if (!f.required) {
        const empty = document.createElement('option');
        empty.value = ''; empty.textContent = '(none)';
        input.appendChild(empty);
      }
      for (const opt of f.options) {
        const o = document.createElement('option');
        o.value = opt; o.textContent = opt;
        input.appendChild(o);
      }
    } else {
      input = document.createElement('input');
      if (f.type === 'number') input.type = 'number';
      else if (f.type === 'date') input.type = 'date';
      else input.type = 'text';
    }
    input.name = name;
    input.dataset.fieldType = f.type;
    input.dataset.fieldKey = f.key;
    if (f.required) input.required = true;
    if (current !== undefined && current !== null) input.value = current;

    wrap.appendChild(input);
    container.appendChild(wrap);
  }
}

// Render the action buttons the server resolved for this project. The server
// already filtered by type and dropped hidden buttons; each remaining button
// carries { disabled, disabledReason }.
function renderActions(buttons) {
  const container = $('#actions');
  container.innerHTML = '';
  for (const b of buttons) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'action' + (b.destructive ? ' destructive' : '');
    btn.textContent = b.label;
    btn.dataset.buttonId = b.id;
    if (b.disabled) {
      btn.disabled = true;
      btn.classList.add('is-disabled');
      if (b.disabledReason) btn.title = b.disabledReason;
    } else {
      btn.addEventListener('click', () => runAction(b, btn));
    }
    container.appendChild(btn);
  }
}

// Fetch the buttons applicable to this project (visibility + disabled state
// are computed server-side) and render them.
async function loadActions(id) {
  try {
    const buttons = await api('GET', `/projects/${id}/actions`);
    if (state.selectedId !== id) return; // user switched projects mid-flight
    renderActions(buttons);
  } catch (err) {
    console.warn('loadActions failed:', err.message);
    $('#actions').innerHTML = '';
  }
}

async function runAction(button, btnEl) {
  if (!state.selectedId) return;
  // Buttons that declare inputs prompt for them first (the modal acts as the
  // confirmation). Otherwise fall back to the optional confirm() prompt.
  if (button.inputs && button.inputs.length) {
    openActionModal(button);
    return;
  }
  if (button.confirm && !confirm(button.confirm)) return;
  await doRunAction(button, undefined, btnEl);
}

// Actually POST the action, optionally with a collected-input body, and
// surface the result. `btnEl` (if given) is disabled while in flight.
async function doRunAction(button, body, btnEl) {
  if (!state.selectedId) return;
  if (btnEl) btnEl.disabled = true;
  const result = $('#action-result');
  result.hidden = false;
  result.textContent = 'Running...';

  try {
    const data = await api(
      'POST',
      `/projects/${state.selectedId}/actions/${encodeURIComponent(button.id)}`,
      body
    );
    const msg = data.result?.message || 'Done.';
    result.textContent = msg;
    // Refresh both the list (priorities/status may have changed) and the detail panel.
    await loadProjects();
    await refreshSelectedProject();
    // refreshSelectedProject resets the action-result, so show the message again briefly.
    result.hidden = false;
    result.textContent = msg;
    setTimeout(() => { result.hidden = true; result.textContent = ''; }, 3000);
  } catch (err) {
    result.hidden = false;
    result.textContent = `Error: ${err.message}`;
  } finally {
    if (btnEl) btnEl.disabled = false;
  }
}

// ── Action-input modal ──────────────────────────────────────────────────
function openActionModal(button) {
  state.actionButton = button;
  $('#action-modal-title').textContent = button.label;
  // Pre-fill from each input's resolved `default` (the server already
  // evaluated any function defaults against this project).
  const values = {};
  for (const f of button.inputs) if (f.default !== undefined) values[f.key] = f.default;
  renderFieldDefs($('#action-fields'), button.inputs, values);
  $('#action-modal').hidden = false;
  $('#action-fields').querySelector('input, textarea, select')?.focus();
}

function closeActionModal() {
  $('#action-modal').hidden = true;
  $('#action-fields').innerHTML = '';
  state.actionButton = null;
}

// Collect values from rendered field inputs into a plain object suitable for
// the API. Booleans always emit true/false. Empty/blank strings are skipped
// so the server treats them as "not provided" (and applies its own validation).
function collectFields(container) {
  const out = {};
  for (const el of container.querySelectorAll('[data-field-key]')) {
    const key = el.dataset.fieldKey;
    const type = el.dataset.fieldType;
    if (type === 'boolean') {
      out[key] = el.checked;
    } else {
      const v = el.value;
      if (v !== '' && v !== null && v !== undefined) out[key] = v;
    }
  }
  return out;
}

async function loadMeta() {
  state.meta = await api('GET', '/projects/meta');
  populateSelect($('#filter-priority'), state.meta.priorities, { includeAll: true });
  populateSelect($('#filter-status'),   state.meta.statuses,   { includeAll: true });
  populateSelect($('#create-priority'), state.meta.priorities);
  populateSelect($('#create-status'),   state.meta.statuses);
  populateTypeSelect($('#create-type'), state.meta.types);
  // Initial defaults for the create form match the first type (already selected).
  if (state.meta.types.length > 0) {
    applyTypeDefaults(state.meta.types[0].id, $('#create-priority'), $('#create-status'));
    renderFields($('#create-fields'), state.meta.types[0].id);
  } else {
    $('#create-priority').value = 'medium';
    $('#create-status').value   = 'active';
  }
}

async function loadProjects() {
  const params = new URLSearchParams();
  if (state.filters.priority) params.set('priority', state.filters.priority);
  if (state.filters.status)   params.set('status',   state.filters.status);
  const qs = params.toString();
  state.projects = await api('GET', '/projects' + (qs ? '?' + qs : ''));
  renderList();
}

function renderList() {
  const ul = $('#project-list');
  ul.innerHTML = '';
  if (state.projects.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No projects yet.';
    ul.appendChild(li);
    return;
  }
  for (const p of state.projects) {
    const li = document.createElement('li');
    li.className = 'project-item' + (p.id === state.selectedId ? ' active' : '');
    li.innerHTML = `
      <span class="pill ${p.priority}">${p.priority}</span>
      <span class="name"></span>
      <span class="status"></span>
    `;
    li.querySelector('.name').textContent = p.name;
    li.querySelector('.status').textContent = p.status;
    li.addEventListener('click', () => router.navigate(`/projects/${p.id}`));
    ul.appendChild(li);
  }
}

// ─── Page views ─────────────────────────────────────────────────────────

// Show exactly one top-level view. Routes call this before rendering.
function showView(name) {
  $('#view-list').hidden = name !== 'list';
  $('#view-project').hidden = name !== 'project';
  $('#view-tasks').hidden = name !== 'tasks';
  $('#view-settings').hidden = name !== 'settings';
}

// Highlight the active top-nav link for the given pathname.
function setActiveNav(pathname) {
  for (const a of document.querySelectorAll('#topnav a[data-nav]')) {
    a.classList.toggle('active', a.dataset.nav === pathname);
  }
}

// Route: /  — the projects list.
async function listView() {
  showView('list');
  setActiveNav('/');
  state.selectedId = null;
  state.selectedProject = null;
  realtime.setActiveProject(null); // leave any project room
  await loadProjects();
}

// Route: /projects/:id  — a single project's page.
async function projectView({ id }) {
  showView('project');
  setActiveNav(null);
  await selectProject(Number(id));
}

// Routes: /assignments (current) and /tasks (all) — the logged-in user's
// assignments across every project, grouped by project.
async function tasksView(scope) {
  showView('tasks');
  setActiveNav(scope === 'current' ? '/assignments' : '/tasks');
  state.selectedId = null;
  state.selectedProject = null;
  realtime.setActiveProject(null);

  $('#tasks-title').textContent = scope === 'current' ? 'Current assignments' : 'All tasks';
  $('#tasks-subtitle').textContent = scope === 'current'
    ? 'Open assignments in each project’s active phase — what to work on now.'
    : 'Every assignment assigned to you, across all projects.';

  let tasks = [];
  try {
    tasks = await api('GET', `/me/assignments${scope === 'current' ? '?scope=current' : ''}`);
  } catch (err) {
    $('#tasks-list').innerHTML = '';
    return;
  }
  renderTasks(tasks);
}

// Route: /settings — the logged-in user's own profile (name, email, phone, and
// preferred contact method). Loads fresh from /auth/me, fills the form, and
// PATCHes on save.
let settingsWired = false;
async function settingsView() {
  showView('settings');
  setActiveNav('/settings');
  state.selectedId = null;
  state.selectedProject = null;
  realtime.setActiveProject(null);

  const me = (await fetchMe()) || state.user || {};
  const form = $('#settings-form');
  form.elements.username.value = me.username || '';
  form.elements.name.value = me.name || '';
  form.elements.email.value = me.email || '';
  form.elements.phone.value = me.phone || '';
  form.elements.contact_preference.value = me.contactPreference || 'none';
  setSettingsMsg('', null);

  // Wire the submit handler once — the form element persists across visits.
  if (settingsWired) return;
  settingsWired = true;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      name: form.elements.name.value,
      email: form.elements.email.value,
      phone: form.elements.phone.value,
      contact_preference: form.elements.contact_preference.value,
    };
    try {
      const updated = await api('PATCH', '/auth/me', payload);
      state.user = updated;
      $('#user-name').textContent = updated.name || updated.username;
      setSettingsMsg('Saved.', 'ok');
    } catch (err) {
      setSettingsMsg(err.message, 'error');
    }
  });
}

function setSettingsMsg(text, kind) {
  const el = $('#settings-msg');
  el.textContent = text;
  el.className = 'settings-msg' + (kind ? ' ' + kind : '');
  el.hidden = !text;
}

// Render tasks grouped by their project. Each project is a card listing its
// assignments; clicking a row opens that project.
function renderTasks(tasks) {
  const root = $('#tasks-list');
  root.innerHTML = '';
  $('#tasks-count').textContent = tasks.length
    ? `${tasks.length} assignment${tasks.length === 1 ? '' : 's'}`
    : '';

  if (tasks.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Nothing assigned to you here.';
    root.appendChild(empty);
    return;
  }

  // Group by project (rows arrive ordered by project name already).
  const groups = new Map();
  for (const t of tasks) {
    if (!groups.has(t.project_id)) groups.set(t.project_id, []);
    groups.get(t.project_id).push(t);
  }

  for (const [projectId, items] of groups) {
    const head = items[0];
    const card = document.createElement('div');
    card.className = 'task-group';

    const title = document.createElement('a');
    title.className = 'task-project';
    title.href = `/projects/${projectId}`;
    title.setAttribute('data-link', '');
    const owned = state.user && head.project_owner_id === state.user.id;
    title.innerHTML = `<span class="task-project-name"></span>
      <span class="task-project-status">${head.project_status}</span>
      ${owned ? '' : '<span class="task-badge">assigned</span>'}`;
    title.querySelector('.task-project-name').textContent = head.project_name;
    card.appendChild(title);

    const ul = document.createElement('ul');
    ul.className = 'task-items';
    for (const t of items) {
      const li = document.createElement('li');
      li.className = 'task-item';

      const dot = document.createElement('span');
      dot.className = `a-dot ${t.status}`;

      const ttl = document.createElement('span');
      ttl.className = 'task-item-title' + (ASSIGNMENT_DONE.includes(t.status) ? ' done' : '');
      ttl.textContent = t.title;

      const phase = document.createElement('span');
      phase.className = 'task-phase';
      phase.textContent = t.phase_name + (t.phase_status === 'done' ? ' · done' : '');

      const st = document.createElement('span');
      st.className = `assignment-status ${t.status}`;
      st.textContent = t.status;

      li.append(dot, ttl, phase, st);
      li.addEventListener('click', () => router.navigate(`/projects/${projectId}`));
      ul.appendChild(li);
    }
    card.appendChild(ul);
    root.appendChild(card);
  }
}

// Route: anything else — a not-found page (reuses the project shell).
function notFoundView() {
  showView('project');
  state.selectedId = null;
  $('#detail').hidden = true;
  $('#detail-notfound').hidden = false;
  realtime.setActiveProject(null);
}

// Opens a project on the project page. Fetches the project shell, then
// conditionally pulls git status if the project has a `gitClone` field set.
// The gitView module owns the file section now.
async function selectProject(id) {
  state.selectedId = id;

  let p;
  try {
    p = await api('GET', `/projects/${id}`);
  } catch (err) {
    // Missing/invalid id → show the not-found state on the project page.
    state.selectedProject = null;
    $('#detail').hidden = true;
    $('#detail-notfound').hidden = false;
    realtime.setActiveProject(null);
    return;
  }

  state.selectedProject = p;
  // Capability map drives every affordance below — same rules the server
  // enforces (server/src/access/policy.js).
  state.caps = p.capabilities || {};
  const owns = can('project.edit'); // owner, regardless of project status

  // Content is editable only when you may edit-content: owner AND project active.
  // A closed (done/cancelled) project is frozen — the inline editors go
  // read-only and a banner explains why. (Comments + lifecycle buttons stay.)
  state.canEditSelected = can('project.edit-content');
  $('#detail').classList.toggle('read-only', !state.canEditSelected);
  const banner = $('#readonly-banner');
  banner.hidden = state.canEditSelected;
  if (!state.canEditSelected) {
    banner.textContent = owns
      ? `This project is ${p.status}. Reactivate it (Set active) to make changes.`
      : "You’re assigned to this project but don’t own it — you can comment and update your own assignments.";
  }

  // Gate the static, owner-only affordances. Assignees keep the comment form.
  $('#delete-project-btn').hidden = !owns;
  // Lifecycle buttons (owner-only). An active project can be completed or
  // cancelled; a non-active one (done/cancelled) can be set back to active.
  $('#complete-project-btn').hidden = !owns || p.status !== 'active';
  $('#cancel-project-btn').hidden   = !owns || p.status !== 'active';
  $('#activate-project-btn').hidden = !owns || p.status === 'active';
  $('#add-phase-btn').hidden = !can('phase.manage');
  $('#checklist-form').hidden = !can('checklist.manage');
  $('#comment-form').hidden = !can('comment.create');

  $('#detail-notfound').hidden = true;
  $('#detail').hidden = false;
  renderDetail(p);
  await loadActions(id);
  $('#action-result').hidden = true;
  $('#action-result').textContent = '';
  await loadComments(id);
  await loadPhases(id);
  await loadChecklist(id);

  // Subscribe to project-scoped realtime events. setActiveProject leaves
  // the previous room first.
  realtime.setActiveProject(id);

  // Pull live git status if the project has a clone to talk to. Fire-and-
  // forget — the file section appears as soon as the response lands; the
  // rest of the UI doesn't wait.
  if (p?.fields?.gitClone) {
    loadGitStatus(id);
  } else {
    // No gitClone → hide the git section (it may still be visible from a
    // previous selection).
    getGitView()?.clear();
  }
}

// Re-fetch and re-render the currently-selected project. Used by realtime,
// post-save, post-action refresh paths.
async function refreshSelectedProject() {
  if (!state.selectedId) return;
  return selectProject(state.selectedId);
}

// Fetch /git/status and hand the result to the gitView. The single
// function the rest of the app calls when it wants the git section to
// reflect on-disk state.
async function loadGitStatus(id) {
  try {
    const status = await api('GET', `/projects/${id}/git/status`);
    // Guard against stale responses (user switched projects mid-flight).
    if (state.selectedId !== id) return status;
    state.selectedGitStatus = status;
    getGitView()?.update(status);
    return status;
  } catch (err) {
    console.warn('loadGitStatus failed:', err.message);
    return null;
  }
}

// ─── GitHub-style detail ────────────────────────────────────────────────

// Lazy-init: the DOM container exists once, and we keep the view across
// selections (its `update()` swaps the contents in place).
let gitView = null;
function getGitView() {
  if (gitView) return gitView;
  const container = $('#git-view');
  const section = $('#git-view-section');
  if (!container || !section) return null;
  gitView = createGitView({
    container,
    onVisible: (visible) => { section.hidden = !visible; },
    // Reads state.selectedId at call-time, so it always targets the
    // currently-viewed project even though the view is created once.
    fetchDiff: (file) =>
      api('GET', `/projects/${state.selectedId}/git/diff?file=${encodeURIComponent(file)}`),
    revertHunk: (file, hunkIndex) =>
      api('POST', `/projects/${state.selectedId}/git/revert`, { file, hunkIndex }),
    // After a successful revert, re-pull git status so the file list (and
    // its diffs) reflect the new on-disk state.
    onChanged: () => loadGitStatus(state.selectedId),
  });
  return gitView;
}

function renderDetail(p) {
  renderTitle(p);
  renderMeta(p);
  renderDescription(p);
  renderProperties(p);
  // Git section is rendered by loadGitStatus() — decoupled so the project
  // shell renders immediately even before the git status request returns.
}

function renderTitle(p) {
  const el = $('#d-name');
  setEditableText(el, p.name, {
    type: 'text',
    placeholder: 'Project name',
    onSave: async (val) => {
      if (!val || !val.trim()) throw new Error('Name cannot be empty');
      await api('PATCH', `/projects/${p.id}`, { name: val.trim() });
      await loadProjects();
      await refreshSelectedProject();
    },
  });
}

function renderMeta(p) {
  const el = $('#d-meta');
  el.innerHTML = '';

  const id = document.createElement('span'); id.className = 'id'; id.textContent = `#${p.id}`;
  el.appendChild(id);

  // Type — click to switch the project to a different type.
  const t = typeById(p.type);
  const typeBadge = document.createElement('span');
  typeBadge.className = 'badge';
  el.appendChild(typeBadge);
  setEditableText(typeBadge, t?.label || p.type || '', {
    type: 'select',
    options: state.meta.types.map((x) => ({ value: x.id, label: x.label })),
    currentValue: p.type || '',
    onSave: async (val) => {
      // Changing type clears existing custom fields server-side.
      await api('PATCH', `/projects/${p.id}`, { type: val, fields: {} });
      await loadProjects();
      await refreshSelectedProject();
    },
  });

  // Priority and Status — click to change.
  const priBadge = document.createElement('span');
  priBadge.className = 'badge';
  el.appendChild(priBadge);
  setEditableText(priBadge, p.priority, {
    type: 'select',
    options: state.meta.priorities.map((v) => ({ value: v, label: v })),
    currentValue: p.priority,
    onSave: async (val) => {
      await api('PATCH', `/projects/${p.id}`, { priority: val });
      await loadProjects();
      await refreshSelectedProject();
    },
  });

  const stBadge = document.createElement('span');
  stBadge.className = 'badge';
  el.appendChild(stBadge);
  setEditableText(stBadge, p.status, {
    type: 'select',
    options: state.meta.statuses.map((v) => ({ value: v, label: v })),
    currentValue: p.status,
    onSave: async (val) => {
      await api('PATCH', `/projects/${p.id}`, { status: val });
      await loadProjects();
      await refreshSelectedProject();
    },
  });
}

function renderDescription(p) {
  setEditableText($('#d-description'), p.description || '', {
    type: 'textarea',
    placeholder: 'Add a description…',
    onSave: async (val) => {
      await api('PATCH', `/projects/${p.id}`, { description: val });
      await refreshSelectedProject();
    },
  });
}

function renderProperties(p) {
  const root = $('#d-properties');
  const section = root.closest('.page-section');
  root.innerHTML = '';
  const t = typeById(p.type);
  const customFields = t?.fields || [];

  // Hide the whole section if this type defines no custom fields.
  if (section) section.hidden = customFields.length === 0;
  if (customFields.length === 0) return;

  for (const f of customFields) {
    const raw = p.fields?.[f.key];
    const display = f.type === 'boolean'
      ? (raw === true ? 'Yes' : raw === false ? 'No' : '')
      : (raw ?? '');
    addProp(root, f.label + (f.required ? ' *' : ''), display, {
      type: f.type === 'textarea' ? 'textarea' : f.type,
      options: f.type === 'select'
        ? f.options.map((v) => ({ value: v, label: v }))
        : undefined,
      currentValue: raw,
      onSave: async (val) => {
        // Merge with existing custom fields so other keys aren't wiped.
        const merged = { ...(p.fields || {}), [f.key]: val };
        await api('PATCH', `/projects/${p.id}`, { fields: merged });
        await refreshSelectedProject();
      },
    });
  }
}

function addProp(root, label, display, opts) {
  const l = document.createElement('div');
  l.className = 'prop-label';
  l.textContent = label;
  const v = document.createElement('div');
  v.className = 'prop-value';
  root.append(l, v);
  setEditableText(v, display, opts);
}

// ─── Inline edit helper ─────────────────────────────────────────────────

// Make `host` show `display` as plain text; on click, swap to an editor.
// opts.type:        'text' | 'textarea' | 'select' | 'date' | 'number' | 'boolean'
// opts.options:     for select — [{ value, label }, ...]
// opts.currentValue: raw value used in the editor (defaults to `display`)
// opts.onSave(val):  async, throws to keep the editor open with an error
// opts.placeholder:  shown grayed-out when the value is empty
function setEditableText(host, display, opts) {
  // Read-only viewer (assignee, not owner): render plain text, no edit affordance.
  if (state.selectedId && state.canEditSelected === false) {
    host.classList.remove('editable', 'editing', 'placeholder');
    host.onclick = null;
    const isEmpty = (display === '' || display === null || display === undefined);
    host.classList.toggle('placeholder', isEmpty);
    host.textContent = isEmpty ? (opts.placeholder || '—') : String(display);
    return;
  }

  host.classList.add('editable');
  host.classList.remove('editing');
  host.innerHTML = '';
  const empty = (display === '' || display === null || display === undefined);
  host.classList.toggle('placeholder', empty);
  host.textContent = empty ? (opts.placeholder || '—') : String(display);

  // Default the editor's starting value to whatever we just rendered, unless
  // the caller wants something else (e.g. raw boolean for a checkbox).
  if (opts.currentValue === undefined) opts.currentValue = display ?? '';

  // Replace any existing click handler.
  const handler = () => enterEdit(host, opts);
  host.onclick = handler;
}

function enterEdit(host, opts) {
  if (host.classList.contains('editing')) return;
  host.classList.add('editing');
  host.classList.remove('placeholder');
  host.onclick = null;
  host.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.className = 'inline-editor';

  let input;
  const t = opts.type;
  const cur = opts.currentValue;

  if (t === 'textarea') {
    input = document.createElement('textarea');
    input.rows = 5;
    input.value = cur ?? '';
  } else if (t === 'select') {
    input = document.createElement('select');
    // Allow clearing optional selects with a blank option, unless required.
    if (!opts.required) {
      const o = document.createElement('option');
      o.value = ''; o.textContent = '(none)';
      input.appendChild(o);
    }
    for (const o of opts.options || []) {
      const el = document.createElement('option');
      el.value = o.value; el.textContent = o.label;
      input.appendChild(el);
    }
    input.value = cur ?? '';
  } else if (t === 'boolean') {
    input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!cur;
  } else {
    input = document.createElement('input');
    input.type = t === 'date' ? 'date' : t === 'number' ? 'number' : 'text';
    input.value = cur ?? '';
  }
  wrap.appendChild(input);

  const actions = document.createElement('div');
  actions.className = 'inline-actions';
  const save = document.createElement('button');
  save.type = 'button'; save.className = 'primary'; save.textContent = 'Save';
  const cancel = document.createElement('button');
  cancel.type = 'button'; cancel.textContent = 'Cancel';
  const msg = document.createElement('span'); msg.className = 'muted';
  actions.append(save, cancel, msg);
  wrap.appendChild(actions);
  host.appendChild(wrap);

  setTimeout(() => input.focus(), 0);
  if (input.select && t !== 'textarea' && t !== 'boolean') input.select?.();

  const restore = () => host.dispatchEvent(new CustomEvent('inline-restore'));
  host.addEventListener('inline-restore', () => {
    // Caller's onSave triggers re-render via selectProject, which rewrites
    // host's contents — so we don't need to manually restore on success.
  }, { once: true });

  cancel.addEventListener('click', () => {
    // Discard in-flight edit by re-rendering from saved state.
    // Don't notify focus — the user is already on the page.
    refreshSelectedProject();
  });

  const doSave = async () => {
    save.disabled = true;
    msg.textContent = 'Saving…';
    let val;
    if (t === 'boolean') val = input.checked;
    else if (t === 'number') val = input.value === '' ? null : Number(input.value);
    else if (t === 'select') val = input.value === '' ? null : input.value;
    else val = input.value;
    try {
      await opts.onSave(val);
      // onSave normally re-renders this host so the editor goes away on success.
    } catch (err) {
      msg.textContent = '';
      save.disabled = false;
      alert(err.message);
    }
  };

  save.addEventListener('click', doSave);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); cancel.click(); }
    else if (e.key === 'Enter' && t !== 'textarea') { e.preventDefault(); doSave(); }
  });
}

// Builds the <li> for a single comment row (top-level or reply). `onReply`,
// when provided, adds a Reply affordance that toggles an inline reply form.
function commentNode(c, projectId, onReply) {
  const li = document.createElement('li');
  li.className = 'comment';
  const body = document.createElement('div'); body.className = 'body'; body.textContent = c.body;

  const meta = document.createElement('span'); meta.className = 'ts';
  const who = c.author || 'unknown';
  meta.textContent = `${who} · ${fmtDate(c.created_at)}`;

  li.append(body, meta);

  if (onReply) {
    const reply = document.createElement('button'); reply.type = 'button';
    reply.className = 'reply-btn'; reply.textContent = 'Reply';
    reply.title = 'Reply to this comment';
    reply.addEventListener('click', () => onReply(li));
    li.appendChild(reply);
  }

  // Server-computed from the policy; no rule duplicated on the client.
  if (c.canDelete) {
    const del = document.createElement('button'); del.type = 'button'; del.textContent = '×';
    del.className = 'del-btn'; del.title = 'Delete comment';
    del.addEventListener('click', async () => {
      await api('DELETE', `/comments/${c.id}`);
      await loadComments(projectId);
    });
    li.appendChild(del);
  }
  return li;
}

async function loadComments(projectId) {
  const comments = await api('GET', `/projects/${projectId}/comments`);
  const ul = $('#comment-list');
  ul.innerHTML = '';
  if (comments.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.style.padding = '8px';
    li.textContent = 'No comments.';
    ul.appendChild(li);
    return;
  }

  // Server returns a flat list newest-first. Split into top-level threads and
  // replies keyed by parent; render replies oldest-first so a thread reads top
  // to bottom under its parent.
  const tops = comments.filter((c) => c.parent_id == null);
  const repliesByParent = new Map();
  for (const c of comments) {
    if (c.parent_id == null) continue;
    if (!repliesByParent.has(c.parent_id)) repliesByParent.set(c.parent_id, []);
    repliesByParent.get(c.parent_id).push(c);
  }

  for (const c of tops) {
    // Toggling the inline reply form for this thread.
    const openReplyForm = (afterEl) => {
      if (thread.querySelector('.reply-form')) return; // already open
      const form = document.createElement('form');
      form.className = 'comment-form reply-form';
      const ta = document.createElement('textarea');
      ta.rows = 2; ta.placeholder = 'Write a reply…'; ta.required = true;
      const send = document.createElement('button');
      send.className = 'primary'; send.type = 'submit'; send.textContent = 'Reply';
      form.append(ta, send);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const val = ta.value.trim();
        if (!val) return;
        try {
          await api('POST', `/projects/${projectId}/comments`, { body: val, parentId: c.id });
          await loadComments(projectId);
        } catch (err) { alert(err.message); }
      });
      afterEl.after(form);
      ta.focus();
    };

    const thread = document.createElement('li');
    thread.className = 'comment-thread';
    const head = commentNode(c, projectId, openReplyForm);
    thread.appendChild(head);

    const replies = repliesByParent.get(c.id) || [];
    if (replies.length) {
      const sub = document.createElement('ul');
      sub.className = 'comment-list reply-list';
      for (const r of replies.slice().reverse()) {
        sub.appendChild(commentNode(r, projectId, null));
      }
      thread.appendChild(sub);
    }
    ul.appendChild(thread);
  }
}

// Tracks the row currently being dragged in the checklist. Module-scoped so
// the (once-bound) delegated DnD handlers in wireEvents can share it.
let clDragEl = null;

async function loadChecklist(projectId) {
  const items = await api('GET', `/projects/${projectId}/checklist`);
  const ul = $('#checklist');
  ul.innerHTML = '';

  const done = items.filter((i) => i.done).length;
  $('#checklist-progress').textContent = items.length ? `${done}/${items.length} done` : '';

  if (items.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.style.padding = '8px';
    li.textContent = 'No checklist items.';
    ul.appendChild(li);
    return;
  }

  const manage = can('checklist.manage'); // owner-only; assignees see it read-only
  for (const it of items) {
    const li = document.createElement('li');
    li.className = 'checklist-item' + (it.done ? ' done' : '');
    li.draggable = manage;
    li.dataset.id = it.id;

    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = !!it.done;
    cb.disabled = !manage;
    if (manage) {
      cb.addEventListener('change', async () => {
        try {
          await api('PATCH', `/checklist/${it.id}`, { done: cb.checked });
          await loadChecklist(projectId);
        } catch (err) {
          cb.checked = !cb.checked; // revert on failure
          alert(err.message);
        }
      });
    }

    const text = document.createElement('span');
    text.className = 'cl-text'; text.textContent = it.text;

    li.append(cb, text);

    if (manage) {
      const handle = document.createElement('span');
      handle.className = 'drag-handle'; handle.textContent = '⠿'; handle.title = 'Drag to reorder';
      li.prepend(handle);

      const del = document.createElement('button');
      del.type = 'button'; del.className = 'cl-del'; del.textContent = '×'; del.title = 'Delete item';
      del.addEventListener('click', async () => {
        try { await api('DELETE', `/checklist/${it.id}`); await loadChecklist(projectId); }
        catch (err) { alert(err.message); }
      });
      li.appendChild(del);
    }

    ul.appendChild(li);
  }
}

// Given the pointer Y, find the row the dragged item should be inserted
// before (or null to append at the end).
function checklistDropTarget(ul, y) {
  const rows = [...ul.querySelectorAll('.checklist-item:not(.dragging)')];
  let closest = { offset: Number.NEGATIVE_INFINITY, el: null };
  for (const child of rows) {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) closest = { offset, el: child };
  }
  return closest.el;
}

// ─── Phases + assignments ───────────────────────────────────────────────

// An assignment is "done" when it's completed or cancelled (shared constant).
const ASSIGNMENT_DONE = DONE_STATUSES;

// Truncate long text for display — agent result/error can be paragraphs; the row
// (and its tooltip) should never show a wall of text. Returns a short snippet.
function clip(text, max = 80) {
  if (typeof text !== 'string') return '';
  const s = text.trim();
  return s.length > max ? `${s.slice(0, max).trimEnd()}…` : s;
}

// Registered accounts, cached for the assignee picker. Loaded on demand.
let usersCache = null;
async function getUsers() {
  if (usersCache) return usersCache;
  try { usersCache = await api('GET', '/users'); }
  catch { usersCache = []; }
  return usersCache;
}
function usernameById(id) {
  return (usersCache || []).find((u) => u.id === id)?.username || null;
}

// Registered, assignable agents, cached for the assignee picker. Loaded on demand.
let agentsCache = null;
async function getAgents() {
  if (agentsCache) return agentsCache;
  try { agentsCache = await api('GET', '/agents'); }
  catch { agentsCache = []; }
  return agentsCache;
}

// Monotonic token: a slow load can't clobber a newer one, and two overlapping
// loads (e.g. POST callback + realtime echo) can't double-render. The earlier
// duplicate-phase bug came from awaiting BETWEEN clearing and appending — so
// we now fetch everything first and do the clear+render in one sync block.
let phasesLoadSeq = 0;

async function loadPhases(projectId) {
  const seq = ++phasesLoadSeq;

  let phases, current, assignmentsByPhase;
  try {
    const res = await fetch(`${API}/projects/${projectId}/phases`, { credentials: 'include' });
    if (!res.ok) return;
    ({ data: phases, current } = await res.json());
    assignmentsByPhase = await Promise.all(
      phases.map((ph) => api('GET', `/phases/${ph.id}/assignments`).catch(() => []))
    );
    await getUsers(); // resolve user-type assignees by id at render time
  } catch { return; }

  // Drop this render if a newer load started or the user navigated away.
  if (seq !== phasesLoadSeq || state.selectedId !== projectId) return;

  const ol = $('#phases');
  ol.innerHTML = ''; // from here on: no awaits, so renders never interleave

  const doneCount = phases.filter((p) => p.status === 'done').length;
  $('#phases-progress').textContent = phases.length ? `${doneCount}/${phases.length} done` : '';

  if (phases.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty'; li.style.padding = '8px 2px';
    li.textContent = 'No phases yet.';
    ol.appendChild(li);
    return;
  }

  phases.forEach((ph, i) => {
    const isCurrent = current && current.id === ph.id;
    ol.appendChild(renderPhase(projectId, ph, assignmentsByPhase[i], isCurrent));
  });
}

// A small icon button used for the subtle, hover-revealed row actions.
function iconBtn(glyph, title, onClick, extraClass = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = ('icon-btn ' + extraClass).trim();
  b.textContent = glyph;
  b.title = title;
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return b;
}

// Map the three phase states to a CSS class + label. 'active' reuses the
// existing "current" styling; 'idle' has no decoration (base look).
const PHASE_TONE = {
  active: { cls: 'current', label: 'Active' },
  done:   { cls: 'done',    label: 'Done' },
  idle:   { cls: 'idle',    label: 'Idle' },
};

function renderPhase(projectId, phase, assignments, isCurrent) {
  const tone = PHASE_TONE[phase.status] || PHASE_TONE.idle;
  const li = document.createElement('li');
  li.className = 'phase ' + tone.cls;
  li.dataset.id = phase.id;

  const head = document.createElement('div');
  head.className = 'phase-head';

  const name = document.createElement('span');
  name.className = 'phase-name';
  name.textContent = phase.name;

  const doneN = assignments.filter((a) => ASSIGNMENT_DONE.includes(a.status)).length;
  const count = document.createElement('span');
  count.className = 'phase-count';
  count.textContent = `${doneN}/${assignments.length}`;

  const badge = document.createElement('span');
  badge.className = 'phase-status ' + tone.cls;
  badge.textContent = tone.label;

  head.append(name, count, badge);
  // Go backward: owner-only, shown only on passed (done) phases. Moves the
  // project back to this phase so it can be edited again.
  if (phase.canReopen) {
    head.appendChild(iconBtn('↩', 'Reopen phase (go backward)', async () => {
      if (!confirm(`Reopen "${phase.name}"? This moves the project back to this phase.`)) return;
      try { await api('POST', `/phases/${phase.id}/reopen`); await loadPhases(projectId); await refreshSelectedProject(); }
      catch (err) { alert(err.message); }
    }));
  }
  // `canDelete` is server-computed: false once the phase is passed (done), so a
  // frozen phase can't be deleted until it's reopened.
  if (phase.canDelete) {
    head.appendChild(iconBtn('×', 'Delete phase', async () => {
      if (!confirm(`Delete phase "${phase.name}" and its assignments?`)) return;
      try { await api('DELETE', `/phases/${phase.id}`); await loadPhases(projectId); await refreshSelectedProject(); }
      catch (err) { alert(err.message); }
    }, 'danger'));
  }
  li.appendChild(head);

  if (phase.description) {
    const desc = document.createElement('div');
    desc.className = 'phase-desc';
    desc.textContent = phase.description;
    li.appendChild(desc);
  }

  const ul = document.createElement('ul');
  ul.className = 'assignments';
  for (const a of assignments) ul.appendChild(renderAssignment(projectId, a));
  li.appendChild(ul);

  // Open phases get a subtle add-assignment trigger (owner only). `canAddAssignment`
  // is server-computed: false once the phase is passed (done), so frozen phases
  // can't be assigned to until reopened.
  if (phase.canAddAssignment) {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'add-assignment-btn';
    add.textContent = '+ Add assignment';
    add.addEventListener('click', () => openAssignmentModal(projectId, phase.id, phase.name));
    li.appendChild(add);
  }

  return li;
}

// Enqueue an agent run, then poll for live status until it settles.
async function runAgent(a, projectId) {
  try {
    await api('POST', `/assignments/${a.id}/run`, {});
  } catch (err) { alert(err.message); return; }
  await loadPhases(projectId);                    // reflect 'accepted' immediately
  pollAgentRun(projectId, a.phase_id, a.id);
}

// An agent run is in flight while the queue has accepted it or it's executing.
// Status now lives on the assignment itself (no separate run_status).
const RUN_ACTIVE = new Set(RUN_ACTIVE_STATUSES);
// Poll a single assignment's run until terminal, re-rendering the phase each
// tick. Bounded, and stops if the user navigates away. (Run state isn't pushed
// over realtime — it's written by the queue worker — so we poll.)
async function pollAgentRun(projectId, phaseId, assignmentId, tries = 0) {
  if (tries >= 20) return;                         // ~30s cap
  await new Promise((r) => setTimeout(r, 1500));
  if (state.selectedId !== projectId) return;      // navigated away
  let list;
  try { list = await api('GET', `/phases/${phaseId}/assignments`); }
  catch { return; }
  if (state.selectedId === projectId) await loadPhases(projectId);
  const cur = list.find((x) => x.id === assignmentId);
  if (cur && RUN_ACTIVE.has(cur.status)) {
    pollAgentRun(projectId, phaseId, assignmentId, tries + 1);
  }
}

function renderAssignment(projectId, a) {
  const li = document.createElement('li');
  const done = ASSIGNMENT_DONE.includes(a.status);
  li.className = 'assignment' + (done ? ` ${a.status}` : '');

  const dot = document.createElement('span');
  dot.className = `a-dot ${a.status}`;
  // For a cancelled assignment, surface WHY on hover; otherwise just the status.
  dot.title = a.status === ASSIGNMENT_STATUS.CANCELLED && a.cancel_reason
    ? `cancelled: ${a.cancel_reason}`
    : a.status;

  const title = document.createElement('span');
  title.className = 'assignment-title';
  title.textContent = a.title;
  if (a.description) title.title = a.description;

  // For user assignees, show the registered username (resolved by id, with the
  // stored label as a fallback). For agents/bots, show the free-text name.
  const who = document.createElement('span');
  who.className = `assignee assignee-${a.assignee_type}`;
  who.textContent = a.assignee_type === 'user'
    ? (usernameById(a.assignee_user_id) || a.assignee_label || 'user')
    : (a.assignee_label || a.assignee_type);
  who.title = a.assignee_type;

  // Server-computed from the policy. Resolve (mark own work done) is reserved to
  // the assignee — a separate capability from canUpdate (cancel/reopen/edit,
  // available to the owner too).
  const mayResolve = a.canResolve;
  const mayUpdate = a.canUpdate;
  const mayDelete = a.canDelete;

  const controls = document.createElement('span');
  controls.className = 'assignment-controls';
  const patchStatus = async (body) => {
    try { await api('PATCH', `/assignments/${a.id}`, body); await loadPhases(projectId); await refreshSelectedProject(); }
    catch (err) { alert(err.message); }
  };
  // Cancelling requires a reason — prompt for it and abort if none given.
  const cancelWithReason = () => {
    const reason = prompt('Why are you cancelling this assignment?');
    if (reason === null) return;                 // user dismissed the prompt
    if (!reason.trim()) { alert('A reason is required to cancel.'); return; }
    patchStatus({ status: ASSIGNMENT_STATUS.CANCELLED, cancel_reason: reason.trim() });
  };
  if (!done) {
    // Complete: assignee only. Cancel: owner or assignee (with a reason).
    if (mayResolve) controls.append(iconBtn('✓', 'Complete', () => patchStatus({ status: ASSIGNMENT_STATUS.COMPLETED }), 'ok'));
    if (mayUpdate)  controls.append(iconBtn('⊘', 'Cancel', cancelWithReason));
  } else if (mayUpdate) {
    controls.append(iconBtn('↺', 'Reopen', () => patchStatus({ status: ASSIGNMENT_STATUS.PENDING })));
  }
  if (mayDelete) {
    controls.append(iconBtn('×', 'Delete assignment', async () => {
      try { await api('DELETE', `/assignments/${a.id}`); await loadPhases(projectId); await refreshSelectedProject(); }
      catch (err) { alert(err.message); }
    }, 'danger'));
  }

  // Agent run: a status badge + a Run button (owner only). The run state IS the
  // assignment status now; the 1:1 extension (`a.agent`) carries result/error.
  let runBadge = null;
  if (a.assignee_type === 'agent') {
    const st = a.status;
    runBadge = document.createElement('span');
    runBadge.className = `run-status run-${st}`;
    runBadge.textContent = st;
    if (st === ASSIGNMENT_STATUS.FAILED && a.agent?.error) runBadge.title = clip(a.agent.error);
    else if (st === ASSIGNMENT_STATUS.COMPLETED && a.agent?.result) runBadge.title = clip(a.agent.result);
    // The agent's internal run-loop state (planning / waiting_tool / …) is a
    // finer axis than the status — surface it on the tooltip when meaningful.
    const exec = a.agent?.execution_state;
    if (exec && exec !== EXECUTION_STATE.IDLE) runBadge.title = (runBadge.title ? `${runBadge.title} · ` : '') + `execution: ${exec}`;

    const inFlight = RUN_ACTIVE.has(st);
    if (a.canRun && !inFlight) {
      controls.append(iconBtn('▶', st === ASSIGNMENT_STATUS.PENDING ? 'Run agent' : 'Run again', () => runAgent(a, projectId), 'run'));
    }
  }

  li.append(dot, title, who);
  if (runBadge) li.append(runBadge);
  // Show the cancellation reason inline (muted), so the record explains itself.
  if (a.status === ASSIGNMENT_STATUS.CANCELLED && a.cancel_reason) {
    const reason = document.createElement('span');
    reason.className = 'cancel-reason';
    reason.textContent = a.cancel_reason;
    reason.title = a.cancel_reason;
    li.append(reason);
  }
  // The agent's result/error is NOT shown inline — the 'failed'/'completed'
  // badge conveys the outcome, and the (clipped) text is available on the badge's
  // tooltip (hover). This keeps a failed run from spilling an error into the row.
  li.append(controls);
  return li;
}

// ── Phase modal ──
let phaseModalProjectId = null;
function openPhaseModal(projectId) {
  phaseModalProjectId = projectId;
  const form = $('#phase-form');
  form.reset();
  $('#phase-modal').hidden = false;
  form.elements.name.focus();
}
function closePhaseModal() {
  $('#phase-modal').hidden = true;
  $('#phase-form').reset();
  phaseModalProjectId = null;
}

// ── Assignment modal ──
let assignmentModalCtx = null; // { projectId, phaseId }
async function openAssignmentModal(projectId, phaseId, phaseName) {
  assignmentModalCtx = { projectId, phaseId };
  const form = $('#assignment-form');
  form.reset();
  $('#assignment-modal-title').textContent = `New assignment · ${phaseName}`;

  // Populate the user picker from the registered accounts.
  const users = await getUsers();
  const sel = $('#assignee-user');
  sel.innerHTML = '';
  if (users.length === 0) {
    const opt = document.createElement('option');
    opt.value = ''; opt.textContent = '(no users)';
    sel.appendChild(opt);
  }
  for (const u of users) {
    const opt = document.createElement('option');
    opt.value = String(u.id); opt.textContent = u.username;
    sel.appendChild(opt);
  }

  // Populate the agent picker from the registered, assignable agents.
  const agents = await getAgents();
  const asel = $('#assignee-agent');
  asel.innerHTML = '';
  if (agents.length === 0) {
    const opt = document.createElement('option');
    opt.value = ''; opt.textContent = '(no agents)';
    asel.appendChild(opt);
  }
  for (const ag of agents) {
    const opt = document.createElement('option');
    opt.value = String(ag.id); opt.textContent = ag.title; // display title; submits id
    asel.appendChild(opt);
  }

  syncAssigneeFields();
  $('#assignment-modal').hidden = false;
  form.elements.title.focus();
}
function closeAssignmentModal() {
  $('#assignment-modal').hidden = true;
  $('#assignment-form').reset();
  assignmentModalCtx = null;
}
// Show the field that matches the assignee type: a user dropdown, an agent
// dropdown, or a free-text name (bot).
function syncAssigneeFields() {
  const type = $('#assignee-type').value;
  $('#assignee-user-field').hidden  = type !== 'user';
  $('#assignee-agent-field').hidden = type !== 'agent';
  $('#assignee-label-field').hidden = type !== 'bot';
}

function openModal()  { $('#modal').hidden = false; $('#create-form').elements.name.focus(); }
function closeModal() {
  $('#modal').hidden = true;
  $('#create-form').reset();
  if (state.meta.types.length > 0) {
    $('#create-type').value = state.meta.types[0].id;
    applyTypeDefaults(state.meta.types[0].id, $('#create-priority'), $('#create-status'));
    renderFields($('#create-fields'), state.meta.types[0].id);
  }
}

function wireEvents() {
  $('#filter-priority').addEventListener('change', (e) => { state.filters.priority = e.target.value; loadProjects(); });
  $('#filter-status').addEventListener('change',   (e) => { state.filters.status   = e.target.value; loadProjects(); });

  $('#new-project-btn').addEventListener('click', openModal);
  $('#cancel-create').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

  // Action-input modal: collect a button's declared inputs, then run it.
  $('#action-cancel').addEventListener('click', closeActionModal);
  $('#action-modal').addEventListener('click', (e) => { if (e.target.id === 'action-modal') closeActionModal(); });
  $('#action-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = state.actionButton;
    if (!button) return;
    const body = collectFields($('#action-fields'));
    closeActionModal();
    await doRunAction(button, body);
  });


  // Picking a type pre-fills the priority/status from that type's defaults
  // and re-renders the custom-field inputs for that type.
  $('#create-type').addEventListener('change', (e) => {
    applyTypeDefaults(e.target.value, $('#create-priority'), $('#create-status'));
    renderFields($('#create-fields'), e.target.value);
  });

  $('#create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      name:        e.target.elements.name.value,
      description: e.target.elements.description.value,
      type:        e.target.elements.type.value,
      priority:    e.target.elements.priority.value,
      status:      e.target.elements.status.value,
      fields:      collectFields($('#create-fields')),
    };
    try {
      const p = await api('POST', '/projects', payload);
      closeModal();
      router.navigate(`/projects/${p.id}`);
    } catch (err) {
      alert(err.message);
    }
  });

  $('#delete-project-btn').addEventListener('click', async () => {
    if (!state.selectedId) return;
    if (!confirm('Delete this project and all its comments?')) return;
    await api('DELETE', `/projects/${state.selectedId}`);
    router.navigate('/');
  });

  // Project lifecycle: complete / cancel / reactivate. Each patches status,
  // then refreshes the list and detail so the badge and buttons re-render.
  const setProjectStatus = async (status, confirmMsg) => {
    if (!state.selectedId) return;
    if (confirmMsg && !confirm(confirmMsg)) return;
    try {
      await api('PATCH', `/projects/${state.selectedId}`, { status });
      await loadProjects();
      await refreshSelectedProject();
    } catch (err) { alert(err.message); }
  };
  $('#complete-project-btn').addEventListener('click', () => setProjectStatus('done'));
  $('#cancel-project-btn').addEventListener('click',
    () => setProjectStatus('cancelled', 'Cancel this project?'));
  $('#activate-project-btn').addEventListener('click', () => setProjectStatus('active'));

  $('#comment-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.selectedId) return;
    const body = e.target.elements.body.value;
    if (!body.trim()) return;
    try {
      await api('POST', `/projects/${state.selectedId}/comments`, { body });
      e.target.reset();
      await loadComments(state.selectedId);
    } catch (err) {
      alert(err.message);
    }
  });

  // Phases: the header button opens a panel; submit posts and closes.
  $('#add-phase-btn').addEventListener('click', () => {
    if (state.selectedId) openPhaseModal(state.selectedId);
  });
  $('#phase-cancel').addEventListener('click', closePhaseModal);
  $('#phase-modal').addEventListener('click', (e) => { if (e.target.id === 'phase-modal') closePhaseModal(); });
  $('#phase-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const projectId = phaseModalProjectId;
    if (!projectId) return;
    const name = e.target.elements.name.value;
    const description = e.target.elements.description.value;
    if (!name.trim()) return;
    try {
      await api('POST', `/projects/${projectId}/phases`, { name, description });
      closePhaseModal();
      await loadPhases(projectId);
    } catch (err) {
      alert(err.message);
    }
  });

  // Assignments: panel opened per-phase by the add-assignment button.
  $('#assignee-type').addEventListener('change', syncAssigneeFields);
  $('#assignment-cancel').addEventListener('click', closeAssignmentModal);
  $('#assignment-modal').addEventListener('click', (e) => { if (e.target.id === 'assignment-modal') closeAssignmentModal(); });
  $('#assignment-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const ctx = assignmentModalCtx;
    if (!ctx) return;
    const f = e.target.elements;
    const title = f.title.value.trim();
    if (!title) return;
    const type = f.assignee_type.value;
    const payload = { title, description: f.description.value.trim() || null, assignee_type: type };
    if (type === 'user') {
      const uid = Number(f.assignee_user_id.value);
      if (uid) {
        payload.assignee_user_id = uid;
        payload.assignee_label = usernameById(uid); // denormalize username for display
      }
    } else if (type === 'agent') {
      const aid = Number(f.assignee_agent_id.value);
      if (aid) payload.assignee_agent_id = aid; // server stamps the label from the agent's title
    } else {
      payload.assignee_label = f.assignee_label.value.trim() || null;
    }
    try {
      await api('POST', `/phases/${ctx.phaseId}/assignments`, payload);
      closeAssignmentModal();
      await loadPhases(ctx.projectId);
    } catch (err) {
      alert(err.message);
    }
  });

  $('#checklist-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.selectedId) return;
    const text = e.target.elements.text.value;
    if (!text.trim()) return;
    try {
      await api('POST', `/projects/${state.selectedId}/checklist`, { text });
      e.target.reset();
      await loadChecklist(state.selectedId);
    } catch (err) {
      alert(err.message);
    }
  });

  // Drag-to-reorder. Bound once via delegation on the (persistent) <ul>;
  // rows are recreated on every loadChecklist but the listeners live on the
  // container, so they never accumulate.
  const cl = $('#checklist');
  cl.addEventListener('dragstart', (e) => {
    const li = e.target.closest('.checklist-item');
    if (!li) return;
    clDragEl = li;
    li.classList.add('dragging');
  });
  cl.addEventListener('dragover', (e) => {
    if (!clDragEl) return;
    e.preventDefault();
    const before = checklistDropTarget(cl, e.clientY);
    if (before) cl.insertBefore(clDragEl, before);
    else cl.appendChild(clDragEl);
  });
  cl.addEventListener('dragend', async (e) => {
    const li = e.target.closest('.checklist-item');
    if (!li) return;
    li.classList.remove('dragging');
    clDragEl = null;
    const orderedIds = [...cl.querySelectorAll('.checklist-item')].map((el) => Number(el.dataset.id));
    if (!state.selectedId || orderedIds.length === 0) return;
    try {
      await api('POST', `/projects/${state.selectedId}/checklist/reorder`, { orderedIds });
    } catch (err) {
      alert(err.message);
      await loadChecklist(state.selectedId); // restore server order on failure
    }
  });
}

// Realtime subscriptions. Debounce per-project refreshes so a burst of
// events (e.g. file watcher → many comment.created in a row) collapses to
// a single refresh.
const pendingRefreshes = new Map(); // id → timeout handle
function debounceRefreshProject(id, delay = 80) {
  clearTimeout(pendingRefreshes.get(id));
  pendingRefreshes.set(id, setTimeout(() => {
    pendingRefreshes.delete(id);
    // Critical: realtime-driven refresh must NOT notify focus, or hooks
    // that mutate state (e.g. project-focused.js writing to meta) would
    // emit project.updated, which arrives back as another refresh, which
    // notifies focus, which… infinite loop.
    if (state.selectedId === id) refreshSelectedProject();
  }, delay));
}

function wireRealtime() {
  // Project-level changes on the currently-viewed project → refresh detail.
  realtime.on('project:*', 'project.updated', ({ project }) => {
    debounceRefreshProject(project.id);
    // Also keep the list in sync since priority/status pills there might change.
    loadProjects();
  });

  // File watcher broadcast (debounced server-side ~250ms). Treat as a
  // notification — re-fetch /meta and rerender just the file section.
  // No full project refresh needed.
  realtime.on('project:*', 'project.file-changed', ({ projectId }) => {
    if (state.selectedId === projectId) loadGitStatus(projectId);
  });

  // Comment churn on the currently-viewed project → refresh comments.
  realtime.on('project:*', 'comment.created', ({ projectId }) => {
    if (state.selectedId === projectId) loadComments(projectId);
  });
  realtime.on('project:*', 'comment.deleted', ({ projectId }) => {
    if (state.selectedId === projectId) loadComments(projectId);
  });

  // Checklist churn on the currently-viewed project → refresh the checklist.
  // Skip refresh mid-drag so an incoming event can't yank the row out from
  // under the pointer.
  for (const ev of ['checklist.created', 'checklist.updated', 'checklist.deleted', 'checklist.reordered']) {
    realtime.on('project:*', ev, ({ projectId }) => {
      if (state.selectedId === projectId && !clDragEl) loadChecklist(projectId);
    });
  }

  // Phase/assignment churn on the currently-viewed project → reload phases.
  // phase.completed may also flip the project to completed, so refresh detail.
  for (const ev of ['phase.created', 'phase.updated', 'phase.deleted', 'phase.reordered', 'phase.completed',
                    'assignment.created', 'assignment.updated', 'assignment.deleted']) {
    realtime.on('project:*', ev, ({ projectId }) => {
      if (state.selectedId === projectId) loadPhases(projectId);
    });
  }

  // List-level changes — always update the left pane.
  realtime.on('projects', 'project.created', () => loadProjects());
  realtime.on('projects', 'project.deleted', ({ id }) => {
    // If we're viewing the project that just got deleted, bounce to the list;
    // otherwise just refresh the list in the background.
    if (state.selectedId === id) router.navigate('/');
    else loadProjects();
  });
  // project.updated also broadcasts to the global `projects` room so the
  // list re-sorts when a non-viewed project's priority changes.
  realtime.on('projects', 'project.updated', () => loadProjects());
}

async function main() {
  wireAuth();

  // Gate on auth: no session → show the login overlay and stop here. The app
  // (and the realtime socket) only initialize once logged in.
  const user = await fetchMe();
  if (!user) { showAuth(); return; }

  state.user = user;
  $('#user-name').textContent = user.name || user.username;
  $('#user-area').hidden = false;
  $('#topnav').hidden = false;
  hideAuth();

  wireEvents();
  wireRealtime();
  await loadMeta();

  // Wire up client-side routing, then render whatever URL we loaded on.
  router = createRouter(
    [
      route('/', listView),
      route('/assignments', () => tasksView('current')),
      route('/tasks', () => tasksView('all')),
      route('/settings', settingsView),
      route('/projects/:id', projectView),
    ],
    notFoundView
  );
  router.start();
}

main().catch((err) => {
  console.error(err);
  alert('Failed to load: ' + err.message);
});
