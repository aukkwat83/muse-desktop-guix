// Resizable right rail: a gutter on the rail's left edge drags --rightbar-w,
// persists it to localStorage, and restores it on the next boot. Mirrors
// sidebar-resize.js — same pure-math / DOM-init split, same keyboard model.
//
// Pure: clampRightbarWidth / widthFromClientXRight / parseStoredRightbarWidth
// (unit suite pins them); initRightbarResize only touches the DOM and is a
// no-op when there is no document (node import for tests). The gutter itself
// hides with the rail (body.rb-open gates it in CSS).

export const RIGHTBAR_MIN_PX = 220;
export const RIGHTBAR_MAX_PX = 520;
// The result column must keep at least this much room — the rail can never
// be dragged so wide it squeezes the transcript off-screen.
export const RIGHTBAR_MAIN_MIN_PX = 300;
export const RIGHTBAR_KEY_STEP_PX = 12;
export const RIGHTBAR_STORAGE_KEY = 'muse.rightbarWidthPx';

/**
 * Clamp a rail width into [MIN, MAX], additionally capped so the window
 * keeps MAIN_MIN for the result column after the left sidebar takes its
 * share. sidebarPx is the measured live sidebar width.
 */
export function clampRightbarWidth(px, viewportW, sidebarW) {
  const vw = Number.isFinite(viewportW) && viewportW > 0 ? viewportW : 1024;
  const side = Number.isFinite(sidebarW) && sidebarW > 0 ? sidebarW : 256;
  const upper = Math.min(RIGHTBAR_MAX_PX, Math.max(RIGHTBAR_MIN_PX, vw - side - RIGHTBAR_MAIN_MIN_PX));
  if (!Number.isFinite(px)) return RIGHTBAR_MIN_PX;
  return Math.min(upper, Math.max(RIGHTBAR_MIN_PX, Math.round(px)));
}

/** Width implied by a pointer x, relative to the app's right edge. */
export function widthFromClientXRight(clientX, appRight, viewportW, sidebarW) {
  return clampRightbarWidth(appRight - clientX, viewportW, sidebarW);
}

/**
 * Validate a stored width (localStorage string or number). Anything
 * unparseable or out of range returns null — the caller then falls back
 * to the stylesheet default instead of applying garbage.
 */
export function parseStoredRightbarWidth(raw) {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw >= RIGHTBAR_MIN_PX && raw <= RIGHTBAR_MAX_PX ? raw : null;
  }
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= RIGHTBAR_MIN_PX && n <= RIGHTBAR_MAX_PX ? n : null;
}

function safeStorageGet(storage, key) {
  try {
    return storage ? storage.getItem(key) : null;
  } catch {
    return null;
  }
}

function safeStorageSet(storage, key, value) {
  try {
    storage?.setItem(key, value);
  } catch {
    /* private mode / blocked storage: resizing still works for the session */
  }
}

function safeStorageRemove(storage, key) {
  try {
    storage?.removeItem(key);
  } catch {
    /* ignore */
  }
}

/**
 * Wire the #rightbar-gutter separator: drag to resize, double-click to
 * reset to the stylesheet default, arrow keys / Home / End for keyboards.
 * Returns { setWidth, resetWidth } for tests and future prefs UI.
 */
export function initRightbarResize(opts = {}) {
  const doc = opts.document ?? globalThis.document;
  if (!doc) return null;
  const gutter = doc.getElementById('rightbar-gutter');
  const appEl = doc.getElementById('app');
  const sidebarEl = doc.getElementById('sidebar');
  if (!gutter || !appEl) return null;
  const win = opts.window ?? globalThis.window;
  const storage = opts.storage ?? globalThis.localStorage;
  const root = doc.documentElement;

  gutter.setAttribute('aria-valuemin', String(RIGHTBAR_MIN_PX));
  gutter.setAttribute('aria-valuemax', String(RIGHTBAR_MAX_PX));

  const sidebarPx = () => Math.round(sidebarEl?.getBoundingClientRect?.().width || 256);

  const apply = (px, persist = true) => {
    const w = clampRightbarWidth(px, win?.innerWidth, sidebarPx());
    root.style.setProperty('--rightbar-w', `${w}px`);
    gutter.setAttribute('aria-valuenow', String(w));
    if (persist) safeStorageSet(storage, RIGHTBAR_STORAGE_KEY, String(w));
    return w;
  };

  const resetWidth = () => {
    root.style.removeProperty('--rightbar-w');
    gutter.removeAttribute('aria-valuenow');
    safeStorageRemove(storage, RIGHTBAR_STORAGE_KEY);
  };

  const stored = parseStoredRightbarWidth(safeStorageGet(storage, RIGHTBAR_STORAGE_KEY));
  if (stored !== null) apply(stored, false);

  let appRight = 0;
  const onMove = (e) => {
    apply(widthFromClientXRight(e.clientX, appRight, win?.innerWidth, sidebarPx()));
  };
  const onUp = () => {
    doc.body.classList.remove('rightbar-resizing');
    gutter.classList.remove('dragging');
    doc.removeEventListener('pointermove', onMove);
    doc.removeEventListener('pointerup', onUp);
    doc.removeEventListener('pointercancel', onUp);
  };

  gutter.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    const box = appEl.getBoundingClientRect();
    appRight = box.right;
    doc.body.classList.add('rightbar-resizing');
    gutter.classList.add('dragging');
    doc.addEventListener('pointermove', onMove);
    doc.addEventListener('pointerup', onUp);
    doc.addEventListener('pointercancel', onUp);
  });

  gutter.addEventListener('dblclick', (e) => {
    e.preventDefault();
    resetWidth();
  });

  gutter.addEventListener('keydown', (e) => {
    const cur = parseStoredRightbarWidth(root.style.getPropertyValue('--rightbar-w').replace(/px\s*$/, ''));
    // Inline style absent (stylesheet default) → measure the live box.
    const base = cur ?? Math.round(
      appEl.getBoundingClientRect().right - gutter.getBoundingClientRect().left,
    );
    let next = null;
    // The gutter sits on the rail's LEFT edge: Left widens, Right narrows.
    if (e.key === 'ArrowLeft') next = base + RIGHTBAR_KEY_STEP_PX;
    else if (e.key === 'ArrowRight') next = base - RIGHTBAR_KEY_STEP_PX;
    else if (e.key === 'Home') next = RIGHTBAR_MIN_PX;
    else if (e.key === 'End') next = RIGHTBAR_MAX_PX;
    else return;
    e.preventDefault();
    apply(next);
  });

  return { setWidth: (px) => apply(px), resetWidth };
}
