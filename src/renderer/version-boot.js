// Paint the version badge as early as possible, standalone: even if app.js
// fails to load or dies during boot, the user still sees which host build is
// serving — or that the host is unreachable — instead of a silent static
// shell (BUG-066). Ported from grok-desktop's inline paintVersionEarly()
// (index.html:427-485); kept in an external file because the CSP
// (script-src 'self') forbids inline scripts. Deliberately uses no ES-module
// features so it can never be blocked by a module-graph failure.
(function paintVersionEarly() {
  var el = document.getElementById('version-badge');
  if (!el) return;
  var done = false;
  function set(version, name) {
    if (!version || done) return;
    done = true;
    el.textContent = 'v' + version;
    el.title = (name || 'Muse Desktop') + ' v' + version;
    el.classList.remove('is-missing', 'is-loading');
  }
  function fail() {
    if (done) return;
    done = true;
    el.textContent = '?';
    el.title = 'host unreachable';
    el.classList.add('is-missing');
    el.classList.remove('is-loading');
  }
  el.classList.add('is-loading');
  el.textContent = '…';
  var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  var to = setTimeout(function () {
    try { if (ctrl) ctrl.abort(); } catch (e) { /* ignore */ }
    fail();
  }, 4000);
  var opts = { cache: 'no-store' };
  if (ctrl) opts.signal = ctrl.signal;
  fetch('/api/version', opts)
    .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
    .then(function (j) {
      clearTimeout(to);
      set(j.version, j.name);
      if (!done) fail();
    })
    .catch(function () {
      // Fallback: /api/state carries the same version/name fields.
      fetch('/api/state', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
        .then(function (s) {
          clearTimeout(to);
          set(s.version, s.name);
          if (!done) fail();
        })
        .catch(function () {
          clearTimeout(to);
          fail();
        });
    });
})();
