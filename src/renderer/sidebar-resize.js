// Resizable left sidebar: a gutter on the sidebar edge drags --sidebar-w,
// persists it to localStorage, and restores it on the next boot.
//
// The math is pure (clampSidebarWidth / widthFromClientX / parseStoredWidth)
// so the unit suite can pin it; initSidebarResize only touches the DOM and
// is a no-op when there is no document (node import for tests).

export const SIDEBAR_MIN_PX = 200;
export const SIDEBAR_MAX_PX = 480;
// The result column must keep at least this much room — the sidebar can
// never be dragged so wide it squeezes the transcript off-screen.
export const SIDEBAR_MAIN_MIN_PX = 300;
export const SIDEBAR_KEY_STEP_PX = 12;
export const SIDEBAR_STORAGE_KEY = 'muse.sidebarWidthPx';

/**
 * Clamp a sidebar width into [MIN, MAX], additionally capped so a narrow
 * window always keeps SIDEBAR_MAIN_MIN_PX for the result column.
 */
export function clampSidebarWidth(px, viewportW) {
  const vw = Number.isFinite(viewportW) && viewportW > 0 ? viewportW : 1024;
  const upper = Math.min(SIDEBAR_MAX_PX, Math.max(SIDEBAR_MIN_PX, vw - SIDEBAR_MAIN_MIN_PX));
  if (!Number.isFinite(px)) return SIDEBAR_MIN_PX;
  return Math.min(upper, Math.max(SIDEBAR_MIN_PX, Math.round(px)));
}

/** Width implied by a pointer x, relative to the app's left edge. */
export function widthFromClientX(clientX, appLeft, viewportW) {
  return clampSidebarWidth(clientX - appLeft, viewportW);
}

/**
 * Validate a stored width (localStorage string or number). Anything
 * unparseable or out of range returns null — the caller then falls back
 * to the stylesheet default instead of applying garbage.
 */
export function parseStoredWidth(raw) {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw >= SIDEBAR_MIN_PX && raw <= SIDEBAR_MAX_PX ? raw : null;
  }
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= SIDEBAR_MIN_PX && n <= SIDEBAR_MAX_PX ? n : null;
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
 * Wire the #sidebar-gutter separator: drag to resize, double-click to
 * reset to the stylesheet default, arrow keys / Home / End for keyboards.
 * Returns { setWidth, resetWidth } for tests and future prefs UI.
 */
export function initSidebarResize(opts = {}) {
  const doc = opts.document ?? globalThis.document;
  if (!doc) return null;
  const gutter = doc.getElementById('sidebar-gutter');
  const appEl = doc.getElementById('app');
  if (!gutter || !appEl) return null;
  const win = opts.window ?? globalThis.window;
  const storage = opts.storage ?? globalThis.localStorage;
  const root = doc.documentElement;

  gutter.setAttribute('aria-valuemin', String(SIDEBAR_MIN_PX));
  gutter.setAttribute('aria-valuemax', String(SIDEBAR_MAX_PX));

  const apply = (px, persist = true) => {
    const w = clampSidebarWidth(px, win?.innerWidth);
    root.style.setProperty('--sidebar-w', `${w}px`);
    gutter.setAttribute('aria-valuenow', String(w));
    if (persist) safeStorageSet(storage, SIDEBAR_STORAGE_KEY, String(w));
    return w;
  };

  const resetWidth = () => {
    root.style.removeProperty('--sidebar-w');
    gutter.removeAttribute('aria-valuenow');
    safeStorageRemove(storage, SIDEBAR_STORAGE_KEY);
  };

  const stored = parseStoredWidth(safeStorageGet(storage, SIDEBAR_STORAGE_KEY));
  if (stored !== null) apply(stored, false);

  let appLeft = 0;
  const onMove = (e) => {
    apply(widthFromClientX(e.clientX, appLeft, win?.innerWidth));
  };
  const onUp = () => {
    doc.body.classList.remove('sidebar-resizing');
    gutter.classList.remove('dragging');
    doc.removeEventListener('pointermove', onMove);
    doc.removeEventListener('pointerup', onUp);
    doc.removeEventListener('pointercancel', onUp);
  };

  gutter.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    appLeft = appEl.getBoundingClientRect().left;
    doc.body.classList.add('sidebar-resizing');
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
    const cur = parseStoredWidth(root.style.getPropertyValue('--sidebar-w').replace(/px\s*$/, ''));
    // Inline style absent (stylesheet default) → measure the live box.
    const base = cur ?? Math.round(gutter.getBoundingClientRect().left - appEl.getBoundingClientRect().left);
    let next = null;
    if (e.key === 'ArrowLeft') next = base - SIDEBAR_KEY_STEP_PX;
    else if (e.key === 'ArrowRight') next = base + SIDEBAR_KEY_STEP_PX;
    else if (e.key === 'Home') next = SIDEBAR_MIN_PX;
    else if (e.key === 'End') next = SIDEBAR_MAX_PX;
    else return;
    e.preventDefault();
    apply(next);
  });

  return { setWidth: (px) => apply(px), resetWidth };
}
