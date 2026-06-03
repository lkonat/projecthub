// Thin client over the REST API. All business logic lives on the server.

import { realtime } from './lib/realtime.js';
import { createGitView } from './lib/gitView.js';
import { createRouter, route } from './lib/router.js';

const API = '/api';

// Set in main() once routes are wired. Used wherever the app changes pages.
let router;

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data.data;
}

const state = {
  projects: [],
  selectedId: null,
  meta: { priorities: [], statuses: [] },
  filters: { priority: '', status: '' },
};

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
  container.innerHTML = '';
  const t = typeById(typeId);
  if (!t || !t.fields || t.fields.length === 0) return;

  for (const f of t.fields) {
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

// Render action buttons applicable to this project (no type filter, or matching type).
function renderActions(project) {
  const container = $('#actions');
  container.innerHTML = '';
  const buttons = (state.meta.buttons || []).filter(
    (b) => !b.type || b.type === project.type
  );
  for (const b of buttons) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'action' + (b.destructive ? ' destructive' : '');
    btn.textContent = b.label;
    btn.dataset.buttonId = b.id;
    btn.addEventListener('click', () => runAction(b, btn));
    container.appendChild(btn);
  }
}

async function runAction(button, btnEl) {
  if (!state.selectedId) return;
  if (button.confirm && !confirm(button.confirm)) return;

  btnEl.disabled = true;
  const result = $('#action-result');
  result.hidden = false;
  result.textContent = 'Running...';

  try {
    const data = await api(
      'POST',
      `/projects/${state.selectedId}/actions/${encodeURIComponent(button.id)}`
    );
    result.textContent = data.result?.message || 'Done.';
    // Refresh both the list (priorities/status may have changed) and the detail panel.
    await loadProjects();
    await refreshSelectedProject();
    // refreshSelectedProject resets the action-result, so show the message again briefly.
    result.hidden = false;
    result.textContent = data.result?.message || 'Done.';
    setTimeout(() => { result.hidden = true; result.textContent = ''; }, 3000);
  } catch (err) {
    result.textContent = `Error: ${err.message}`;
  } finally {
    btnEl.disabled = false;
  }
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
}

// Route: /  — the projects list.
async function listView() {
  showView('list');
  state.selectedId = null;
  state.selectedProject = null;
  realtime.setActiveProject(null); // leave any project room
  await loadProjects();
}

// Route: /projects/:id  — a single project's page.
async function projectView({ id }) {
  showView('project');
  await selectProject(Number(id));
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
  $('#detail-notfound').hidden = true;
  $('#detail').hidden = false;
  renderDetail(p);
  renderActions(p);
  $('#action-result').hidden = true;
  $('#action-result').textContent = '';
  await loadComments(id);

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
  for (const c of comments) {
    const li = document.createElement('li');
    li.className = 'comment';
    const body = document.createElement('div'); body.className = 'body'; body.textContent = c.body;
    const ts   = document.createElement('span'); ts.className = 'ts'; ts.textContent = fmtDate(c.created_at);
    const del  = document.createElement('button'); del.type = 'button'; del.textContent = '×';
    del.title = 'Delete comment';
    del.addEventListener('click', async () => {
      await api('DELETE', `/comments/${c.id}`);
      await loadComments(projectId);
    });
    li.append(body, ts, del);
    ul.appendChild(li);
  }
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
  wireEvents();
  wireRealtime();
  await loadMeta();

  // Wire up client-side routing, then render whatever URL we loaded on.
  router = createRouter(
    [
      route('/', listView),
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
