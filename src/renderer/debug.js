// Debug page driver (BUG-071): live counters from /api/debug/stream with a
// one-shot /api/debug fallback, plus an in-browser API smoke suite.
(function () {
  var pillHost = document.getElementById('pill-host');
  var pillVersion = document.getElementById('pill-version');
  var pillSse = document.getElementById('pill-sse');
  var pillStream = document.getElementById('pill-stream');
  var counters = document.getElementById('counters');
  var smokeList = document.getElementById('smoke');

  // This page is a classic script (no module imports), so the two smoke
  // markers inline the shared family's check/x shapes by hand — same 24px
  // grid, stroke 1.8, round caps. icons.js is canonical; unit-test-icons
  // fails if these drift from the registry.
  var SVG_OPEN = '<svg class="ico ico-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" data-icon="';
  function smokeIcon(name, body) {
    return SVG_OPEN + name + '">' + body + '</svg>';
  }
  var CHECK_SVG = smokeIcon('check', '<path d="M4.5 12.5l5 5 10-11"/>');
  var X_SVG = smokeIcon('x', '<path d="M6 6l12 12M18 6L6 18"/>');

  function row(k, v) {
    return '<tr><td class="k">' + k + '</td><td class="v">' + String(v == null ? '—' : v) + '</td></tr>';
  }

  function render(s) {
    if (!s) return;
    pillHost.textContent = s.host + ':' + s.port + ' · pid ' + s.pid;
    pillHost.className = 'pill on';
    pillVersion.textContent = 'v' + s.version;
    pillSse.textContent = 'sse ' + (s.sse ? s.sse.clients : '?') + ' client';
    var sess = s.sessions || {};
    var sse = s.sse || {};
    counters.innerHTML =
      row('version', s.version + ' · ' + s.name) +
      row('uptime', Math.round((s.uptimeMs || 0) / 1000) + 's') +
      row('stateDir', s.stateDir) +
      row('sse.clients', sse.clients) +
      row('sse.seq', sse.seq) +
      row('sse.ring', sse.ringSize + ' / ' + sse.ringMax) +
      row('sse.ring ids', (sse.minId == null ? '—' : sse.minId) + ' … ' + (sse.maxId == null ? '—' : sse.maxId)) +
      row('chats / groups', sess.chats + ' / ' + sess.groups) +
      row('agents อุ่น (hot)', sess.hot + ' / ' + sess.maxHot) +
      row('เทิร์นที่กำลังรัน', sess.running) +
      row('interactions ค้าง', sess.pendingInteractions);
  }

  function markDead() {
    pillHost.textContent = 'host ไม่ตอบ';
    pillHost.className = 'pill off';
    pillStream.textContent = 'stream ขาด';
    pillStream.className = 'pill off';
  }

  function refreshOnce() {
    fetch('/api/debug', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(render)
      .catch(markDead);
  }

  // Live feed; EventSource reconnects on its own. If the stream endpoint is
  // missing entirely (old host), fall back to a 2s poll of /api/debug.
  var pollTimer = null;
  function startStream() {
    var es = new EventSource('/api/debug/stream');
    es.addEventListener('open', function () {
      pillStream.textContent = 'stream live';
      pillStream.className = 'pill on';
    });
    es.addEventListener('snapshot', function (ev) {
      try { render(JSON.parse(ev.data)); } catch { /* ignore a bad frame */ }
    });
    es.addEventListener('error', function () {
      pillStream.textContent = 'stream reconnect…';
      pillStream.className = 'pill';
      if (es.readyState === EventSource.CLOSED && !pollTimer) {
        pollTimer = setInterval(refreshOnce, 2000);
      }
    });
  }

  // ---- API smoke ---------------------------------------------------------
  var ENDPOINTS = ['/api/version', '/api/state', '/api/chats', '/api/groups', '/api/memory', '/api/debug'];

  function runSmoke() {
    smokeList.innerHTML = '';
    ENDPOINTS.forEach(function (path) {
      var li = document.createElement('li');
      li.className = 'pending';
      li.textContent = '… ' + path;
      smokeList.appendChild(li);
      var t0 = performance.now();
      fetch(path, { cache: 'no-store' })
        .then(function (r) {
          return r.json().then(function (j) {
            var ms = Math.round(performance.now() - t0);
            var good = r.ok && j.ok !== false;
            li.className = good ? 'ok' : 'fail';
            li.innerHTML =
              (good ? CHECK_SVG : X_SVG) + '<span>' + path + '</span>' +
              ' <span class="ms">' + r.status + ' · ' + ms + 'ms</span>';
          });
        })
        .catch(function (err) {
          li.className = 'fail';
          li.innerHTML = X_SVG + '<span></span>';
          li.querySelector('span').textContent = path + ' — ' + err;
        });
    });
  }

  document.getElementById('btn-refresh').addEventListener('click', refreshOnce);
  document.getElementById('btn-smoke').addEventListener('click', runSmoke);

  refreshOnce();
  startStream();
})();
