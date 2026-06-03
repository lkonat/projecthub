// Tiny History-API router.
//
// Usage:
//   const router = createRouter([
//     route('/',              listView),
//     route('/projects/:id',  projectView),   // params.id passed to handler
//   ], notFoundView);
//   router.start();                 // render whatever URL we loaded on
//   router.navigate('/projects/3'); // programmatic navigation
//
// Any <a href="/..." data-link> click is intercepted and routed without a
// full page reload. The browser back/forward buttons work via popstate.

// Compile a path pattern like "/projects/:id" into a regex with named
// groups. Trailing slash is optional.
export function route(pattern, handler) {
  const regex = new RegExp(
    '^' + pattern.replace(/:[^/]+/g, (m) => `(?<${m.slice(1)}>[^/]+)`) + '/?$'
  );
  return { regex, handler };
}

export function createRouter(routes, notFound) {
  function match(path) {
    for (const r of routes) {
      const m = path.match(r.regex);
      if (m) return { handler: r.handler, params: m.groups || {} };
    }
    return null;
  }

  async function render() {
    const path = location.pathname || '/';
    const matched = match(path);
    if (matched) await matched.handler(matched.params);
    else if (notFound) await notFound({ path });
  }

  function navigate(path, { replace = false } = {}) {
    if (path === location.pathname) return render();
    history[replace ? 'replaceState' : 'pushState']({}, '', path);
    return render();
  }

  // Intercept in-app link clicks (plain left-clicks only — let modified
  // clicks open new tabs, etc.).
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest('a[data-link]');
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href || !href.startsWith('/')) return;
    e.preventDefault();
    navigate(href);
  });

  window.addEventListener('popstate', render);

  return { start: render, render, navigate };
}
