// MCP servers panel: catalog + live status + per-server on/off + reload.
//
// The host owns the truth — this module only renders snapshots from
// GET /api/mcp/servers, re-renders on the `mcp_servers` broadcast, and
// POSTs probe/toggle intents. First open auto-probes (statuses start as
// `unknown`); the panel never blocks the rest of the UI on that.

import { closePopover, openPanel } from './popover.js?v=0.4.2';

const STATUS_DOT = {
  connected: 'ok',
  failed: 'bad',
  disabled: 'off',
  unknown: 'idle',
};

const STATUS_TH = {
  connected: 'เชื่อมต่อแล้ว',
  failed: 'เชื่อมไม่ได้',
  disabled: 'ปิดอยู่',
  unknown: 'ยังไม่ตรวจ',
};

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return 'เมื่อสักครู่';
  if (s < 60) return `${s} วินาทีที่แล้ว`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} นาทีที่แล้ว`;
  return `${Math.floor(m / 60)} ชม. ที่แล้ว`;
}

export function createMcpPanel({ api, onSnapshot }) {
  let handle = null;
  let root = null;
  let snapshot = null;
  let probing = false;

  function dotClass(status) {
    return `dot ${STATUS_DOT[status] || 'idle'}`;
  }

  function renderHead() {
    const head = el('div', 'panel-head');
    const title = el('div', 'panel-title', 'MCP servers');
    const sub = el('div', 'panel-sub');
    if (snapshot?.error) {
      sub.textContent = snapshot.error;
      sub.classList.add('warn');
    } else if (probing || snapshot?.probing) {
      sub.textContent = 'กำลังตรวจสถานะ…';
    } else if (snapshot?.probedAt) {
      sub.textContent = `ตรวจล่าสุด ${timeAgo(snapshot.probedAt)}`;
    } else {
      sub.textContent = 'ยังไม่เคยตรวจ — กด ⟳ เพื่อตรวจ';
    }
    const actions = el('div', 'panel-actions');
    const reload = el('button', 'btn ghost sm', '⟳ ตรวจใหม่');
    reload.type = 'button';
    reload.title = 'Probe ทุก server ใหม่';
    reload.disabled = probing;
    reload.addEventListener('click', () => void probeAll());
    const close = el('button', 'btn ghost sm', '✕');
    close.type = 'button';
    close.title = 'ปิด';
    close.addEventListener('click', () => closePopover());
    actions.append(reload, close);
    head.append(title, actions);
    return { head, sub };
  }

  function renderRow(s) {
    const row = el('div', 'mcp-row');
    row.dataset.name = s.name;
    if (!s.enabled) row.classList.add('is-off');

    const dot = el('span', dotClass(s.status));
    dot.title = STATUS_TH[s.status] || s.status;
    const main = el('div', 'mcp-main');
    const name = el('div', 'mcp-name', s.name);
    const metaBits = [s.transport === 'http' ? `http${s.host ? ` · ${s.host}` : ''}` : 'stdio'];
    if (s.status === 'connected' && s.tools != null) metaBits.push(`${s.tools} tools`);
    if (s.status === 'connected' && s.latencyMs != null) metaBits.push(`${s.latencyMs}ms`);
    // Usage persists across restarts — "never used" after real use is the
    // trim signal (each idle server still costs ~0.7s of first-turn load).
    metaBits.push(s.lastUsedAt ? `ใช้ล่าสุด ${timeAgo(s.lastUsedAt)}` : 'ยังไม่เคยใช้');
    if (s.status === 'failed' && s.probeError) metaBits.push(s.probeError);
    const meta = el('div', 'mcp-meta', metaBits.join(' · '));
    if (s.status === 'failed' && s.probeError) meta.title = s.probeError;
    main.append(name, meta);

    const toggle = el('button', 'switch' + (s.enabled ? ' on' : ''));
    toggle.type = 'button';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', s.enabled ? 'true' : 'false');
    toggle.title = s.enabled ? `ปิด ${s.name}` : `เปิด ${s.name}`;
    toggle.setAttribute('aria-label', toggle.title);
    toggle.addEventListener('click', () => void flip(s.name, !s.enabled, toggle));
    row.append(dot, main, toggle);
    return row;
  }

  function render() {
    if (!root) return;
    root.textContent = '';
    const { head, sub } = renderHead();
    root.append(head, sub);
    const list = el('div', 'panel-list');
    const servers = snapshot?.servers || [];
    if (!servers.length && !snapshot?.error) {
      list.append(el('div', 'panel-empty', 'ไม่มี MCP server ใน settings'));
    }
    for (const s of servers) list.append(renderRow(s));
    root.append(list);
    const foot = el('div', 'panel-foot',
      'สวิตช์มีผลกับ session ใหม่ — แชทที่ agent รันอยู่ใช้ชุดเดิมจนกว่าจะปล่อย agent');
    root.append(foot);
  }

  async function probeAll() {
    if (probing) return;
    probing = true;
    render();
    try {
      const snap = await api('/api/mcp/probe', { method: 'POST', body: {} });
      applySnapshot(snap);
    } catch (err) {
      snapshot = { ...(snapshot || {}), error: err?.message || 'probe ล้มเหลว' };
      render();
    } finally {
      probing = false;
      render();
    }
  }

  async function flip(name, enabled, btn) {
    btn.disabled = true;
    try {
      await api(`/api/mcp/servers/${encodeURIComponent(name)}/enabled`, {
        method: 'POST',
        body: { enabled },
      });
      // The host broadcasts the fresh snapshot; the SSE handler applies it.
    } catch (err) {
      btn.disabled = false;
      btn.title = err?.message || 'toggle ล้มเหลว';
    }
  }

  function applySnapshot(snap) {
    if (!snap || !Array.isArray(snap.servers)) return;
    snapshot = snap;
    onSnapshot?.(snap);
    if (handle?.isOpen()) render();
  }

  return {
    applySnapshot,
    isOpen: () => !!handle?.isOpen(),
    open(anchor) {
      if (handle?.isOpen()) {
        closePopover();
        return;
      }
      root = el('div', 'panel mcp-panel');
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-label', 'MCP servers');
      handle = openPanel(anchor, root, {
        onClose: () => { handle = null; },
      });
      render();
      // Statuses start `unknown` — probe on first open so the panel earns
      // its keep immediately, without probing at app boot.
      if (!snapshot?.probedAt && !probing) void probeAll();
    },
  };
}
