// Renders live git status fetched from GET /api/projects/:id/git/status.
//
// Initial scope: branch header + ahead/behind + a list of modified files.
// Designed to grow — future expansions (recent commits, diff preview,
// stash list, etc.) all live here.
//
// Usage:
//
//   import { createGitView } from './lib/gitView.js';
//
//   const view = createGitView({
//     container,
//     onVisible: (visible) => { sectionEl.hidden = !visible; },
//   });
//
//   view.update(gitStatus);   // shape returned by GET /:id/git/status
//   view.clear();             // wipe contents, mark not-visible
//
// Input shape (`available: false` is an explicit "nothing to show"):
//
//   { available: false, reason: '...' }
//   {
//     available: true,
//     path, branch, upstream,
//     ahead, behind, clean,
//     modifiedFiles: [{ path, x, y, description?, mtime?, mtimeMs?, renamedTo? }, ...],
//   }

class GitView {
  constructor({ container, onVisible, fetchDiff, revertHunk, onChanged } = {}) {
    if (!container) throw new Error('createGitView: container is required');
    this.container = container;
    this.onVisible = onVisible || (() => {});
    // fetchDiff(file) → Promise<{ available, diff, empty, reason? }>.
    // Injected so this view stays decoupled from the API layer.
    this.fetchDiff = fetchDiff || null;
    // revertHunk(file, hunkIndex) → Promise<{ available, reverted, reason? }>.
    this.revertHunk = revertHunk || null;
    // onChanged() — called after a successful revert so the host can refresh
    // git status (which re-renders this view with the updated file list).
    this.onChanged = onChanged || (() => {});
    container.classList.add('git-view');
  }

  update(status) {
    this._render(status);
  }

  clear() {
    this.container.innerHTML = '';
    this.onVisible(false);
  }

  // ── internals ────────────────────────────────────────────────────

  _render(status) {
    if (!status || !status.available) {
      this.container.innerHTML = '';
      this._filesUl = null;
      this.onVisible(false);
      return;
    }

    const header = this._renderHeader(status);
    const files = status.modifiedFiles || [];

    if (files.length === 0) {
      // Clean tree — drop the file list entirely (no open diffs to keep).
      this.container.innerHTML = '';
      this._filesUl = null;
      this.container.appendChild(header);
      const clean = document.createElement('div');
      clean.className = 'gv-clean';
      clean.textContent = '✓ working tree clean';
      this.container.appendChild(clean);
      this.onVisible(true);
      return;
    }

    // Reconcile the file list in place so open diffs survive the update.
    const ul = this._reconcileFiles(files);

    // Recompose the container. Clearing it only detaches `ul` from the DOM;
    // because we hold a JS reference, the node (and its expanded panels)
    // stays alive and is re-attached intact below.
    this.container.innerHTML = '';
    this.container.appendChild(header);
    this.container.appendChild(ul);

    this.onVisible(true);
  }

  // Update the <ul> of files to match `files`, preserving as much existing
  // DOM as possible:
  //   • file unchanged (same mtime)  → reuse its node verbatim (open diff
  //                                     and all), no refetch
  //   • file changed (mtime differs) → rebuild the row; if it was open,
  //                                     re-expand it and refetch its diff
  //   • file gone                    → drop its node
  //   • new file                     → add a collapsed row
  _reconcileFiles(files) {
    let ul = this._filesUl;
    if (!ul) {
      ul = document.createElement('ul');
      ul.className = 'gv-files';
      this._filesUl = ul;
    }

    // Index existing rows by the file path they represent.
    const existing = new Map();
    for (const li of Array.from(ul.children)) existing.set(li.dataset.file, li);

    const frag = document.createDocumentFragment();
    for (const f of files) {
      const key = f.renamedTo || f.path;
      const newMtime = String(f.mtimeMs ?? '');
      const old = existing.get(key);

      if (old && old.dataset.mtime === newMtime) {
        // Unchanged → reuse as-is (this is what keeps an open diff open).
        existing.delete(key);
        frag.appendChild(old);
        continue;
      }

      // Changed or new → fresh row. Carry over the open state if it changed.
      const wasOpen = old ? old.classList.contains('open') : false;
      if (old) existing.delete(key);
      const li = this._renderFile(f);
      frag.appendChild(li);
      if (wasOpen) {
        li._gv.setOpen(true);
        li._gv.ensureLoaded(); // file changed → fetch the fresh diff
      }
    }

    // Whatever's still in `existing` no longer appears — let it be dropped.
    ul.innerHTML = '';
    ul.appendChild(frag);
    return ul;
  }

  _renderHeader(status) {
    const head = document.createElement('div');
    head.className = 'gv-head';

    const branch = document.createElement('span');
    branch.className = 'gv-branch';
    branch.textContent = status.branch || '(no branch)';
    head.appendChild(branch);

    if (status.upstream) {
      const tracking = document.createElement('span');
      tracking.className = 'gv-tracking';
      let txt = `→ ${status.upstream}`;
      if (status.ahead || status.behind) {
        txt += `  ↑${status.ahead}  ↓${status.behind}`;
      }
      tracking.textContent = txt;
      head.appendChild(tracking);
    }

    return head;
  }

  _renderFile(f) {
    const li = document.createElement('li');
    li.className = 'gv-file';
    // Identity + change-detection keys used by _reconcileFiles.
    li.dataset.file = f.renamedTo || f.path;
    li.dataset.mtime = String(f.mtimeMs ?? '');

    // Clickable header row. The diff panel expands below it.
    const row = document.createElement('div');
    row.className = 'gv-file-row';

    const caret = document.createElement('span');
    caret.className = 'gv-caret';
    caret.textContent = '▸';
    row.appendChild(caret);

    const code = document.createElement('span');
    code.className = 'gv-code';
    code.textContent = `${f.x || ' '}${f.y || ' '}`.replace(/ /g, '·');
    if (f.description) code.title = f.description;
    row.appendChild(code);

    const pathEl = document.createElement('span');
    pathEl.className = 'gv-path';
    pathEl.textContent = f.renamedTo ? `${f.path} → ${f.renamedTo}` : f.path;
    row.appendChild(pathEl);

    if (f.mtime) {
      const t = document.createElement('span');
      t.className = 'gv-mtime';
      t.title = f.mtime;
      t.textContent = formatRelative(f.mtime);
      row.appendChild(t);
    }

    li.appendChild(row);

    // Diff panel — created collapsed, loaded lazily on first expand.
    const panel = document.createElement('div');
    panel.className = 'gv-diff';
    panel.hidden = true;
    li.appendChild(panel);

    // The path git knows the file by now (renames live at renamedTo).
    const filePath = f.renamedTo || f.path;
    let loaded = false;

    const setOpen = (open) => {
      panel.hidden = !open;
      caret.textContent = open ? '▾' : '▸';
      li.classList.toggle('open', open);
    };
    const ensureLoaded = async () => {
      if (loaded) return;
      loaded = true;
      await this._loadDiff(panel, filePath);
    };

    row.addEventListener('click', async () => {
      const willOpen = panel.hidden;
      setOpen(willOpen);
      if (willOpen) await ensureLoaded();
    });

    // Exposed so _reconcileFiles can re-open a changed file and (re)load
    // its diff without going through a user click.
    li._gv = { setOpen, ensureLoaded };

    return li;
  }

  // Fetch + render the diff for `file` into `panel`. Resets `loaded` via the
  // caller; on error we leave a retry-able message.
  async _loadDiff(panel, file) {
    panel.innerHTML = '';
    if (!this.fetchDiff) {
      panel.appendChild(this._diffMessage('Diff unavailable (no fetcher configured).'));
      return;
    }

    const loading = this._diffMessage('Loading diff…');
    panel.appendChild(loading);

    try {
      const res = await this.fetchDiff(file);
      panel.innerHTML = '';
      if (!res || !res.available) {
        panel.appendChild(this._diffMessage(res?.reason || 'Diff unavailable.'));
        return;
      }
      if (res.empty || !res.diff?.trim()) {
        panel.appendChild(this._diffMessage('No textual diff (binary file or no changes vs HEAD).'));
        return;
      }
      panel.appendChild(this._renderDiff(res.diff, file));
    } catch (err) {
      panel.innerHTML = '';
      panel.appendChild(this._diffMessage(`Failed to load diff: ${err.message}`));
    }
  }

  _diffMessage(text) {
    const el = document.createElement('div');
    el.className = 'gv-diff-msg';
    el.textContent = text;
    return el;
  }

  // Render unified-diff text as colored lines.
  _renderDiff(text, file) {
    return this._renderDiffByHunk(text, file);
  }

  // Render unified-diff text grouped by hunk, with a per-hunk Revert button.
  // Hunk indices here match the server's parse of `git diff HEAD -- file`
  // (both count @@ lines in order), so `hunkIndex` round-trips correctly.
  _renderDiffByHunk(text, file) {
    const wrap = document.createElement('div');
    wrap.className = 'gv-diff-wrap';

    const lines = text.split('\n');
    let i = 0;

    // File header (everything before the first hunk) → muted block.
    const header = document.createElement('pre');
    header.className = 'gv-diff-pre gv-diff-headlines';
    while (i < lines.length && !lines[i].startsWith('@@')) {
      header.appendChild(this._diffLine(lines[i]));
      i++;
    }
    if (header.childNodes.length) wrap.appendChild(header);

    // Each hunk: a bar (header text + Revert button) then its body lines.
    let hunkIndex = -1;
    while (i < lines.length) {
      hunkIndex++;
      const idx = hunkIndex;

      const bar = document.createElement('div');
      bar.className = 'gv-hunk-bar';
      const hdr = document.createElement('span');
      hdr.className = 'gv-hunk-hdr';
      hdr.textContent = lines[i];
      bar.appendChild(hdr);

      if (this.revertHunk) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'gv-revert-btn';
        btn.textContent = '⤺ Revert';
        btn.title = 'Discard this change (restore these lines to the last commit)';
        btn.addEventListener('click', (e) => {
          e.stopPropagation(); // don't collapse the file panel
          this._revert(file, idx, btn);
        });
        bar.appendChild(btn);
      }
      wrap.appendChild(bar);
      i++;

      const pre = document.createElement('pre');
      pre.className = 'gv-diff-pre';
      while (i < lines.length && !lines[i].startsWith('@@')) {
        pre.appendChild(this._diffLine(lines[i]));
        i++;
      }
      wrap.appendChild(pre);
    }

    return wrap;
  }

  _diffLine(line) {
    const div = document.createElement('div');
    div.className = 'gv-dl ' + diffLineClass(line);
    div.textContent = line === '' ? ' ' : line;
    return div;
  }

  // Confirm, POST the revert, then let the host refresh git status.
  async _revert(file, hunkIndex, btn) {
    const ok = window.confirm(
      'Discard this change?\n\nThis restores the affected lines to the last commit ' +
      'and cannot be undone.'
    );
    if (!ok) return;

    const prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Reverting…';
    try {
      const res = await this.revertHunk(file, hunkIndex);
      if (!res || !res.available) {
        window.alert('Revert failed: ' + (res?.reason || 'unknown error'));
        btn.disabled = false;
        btn.textContent = prev;
        return;
      }
      // Success — refresh status; that re-renders this view with the file
      // gone (or with one fewer hunk).
      this.onChanged();
    } catch (err) {
      window.alert('Revert failed: ' + err.message);
      btn.disabled = false;
      btn.textContent = prev;
    }
  }
}

// Classify a unified-diff line for coloring. Order matters: the +++/---
// file headers must be caught before the generic +/- add/remove case.
function diffLineClass(line) {
  if (line.startsWith('+++') || line.startsWith('---')) return 'dl-meta';
  if (line.startsWith('@@')) return 'dl-hunk';
  if (line.startsWith('diff ') || line.startsWith('index ') ||
      line.startsWith('new file') || line.startsWith('deleted file') ||
      line.startsWith('rename ') || line.startsWith('similarity ')) return 'dl-meta';
  if (line.startsWith('+')) return 'dl-add';
  if (line.startsWith('-')) return 'dl-del';
  return 'dl-ctx';
}

function formatRelative(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diffSec = Math.floor((Date.now() - t) / 1000);
  if (diffSec < 0)     return 'in the future';
  if (diffSec < 5)     return 'just now';
  if (diffSec < 60)    return `${diffSec}s ago`;
  if (diffSec < 3600)  return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

export function createGitView(opts) {
  return new GitView(opts);
}

export default createGitView;
