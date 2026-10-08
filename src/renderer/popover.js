// Anchored popovers: the hamburger menu and the inline delete confirm.
//
// Deliberately not `window.confirm`: a modal sheet in the middle of the screen
// for "delete this chat?" loses the thing you were pointing at, and in the
// WKWebView shell it blocks the whole window. These attach to the button that
// opened them, so the answer stays where the question was asked.

import { iconElement, isIconName } from './icons.js?v=1.0.0';

let openEl = null;
let onDocDown = null;
/** Cleanup for the open popover — runs on EVERY exit, including programmatic
 * closePopover() and replacement by another panel. Timers and state that only
 * cleaned up on outside-click leaked on every other path (1.1.30). */
let onCloseFn = null;
let onResize = null;

export const POPOVER_MARGIN = 8;

/**
 * Pure placement: anchor rect + measured box + viewport → clamped left/top.
 * The box MUST be measured with real content — placing an empty node and
 * filling it later is how a 560px popup landed at y=787 in a 900px window.
 * No top-level DOM touch — the node suite covers the flip/clamp matrix.
 */
export function computePlacement(anchorRect, box, viewport) {
  const margin = POPOVER_MARGIN;
  const vw = Math.max(1, viewport?.width || 0);
  const vh = Math.max(1, viewport?.height || 0);
  const w = Math.max(1, box?.width || 0);
  const h = Math.max(1, box?.height || 0);
  const r = anchorRect && Number.isFinite(anchorRect.right) ? anchorRect : null;
  let left = r ? r.right - w : vw / 2 - w / 2;
  let top = r ? r.bottom + 6 : vh / 2;
  // Flip above / clamp inside the window rather than letting it hang off-screen.
  if (top + h > vh - margin) {
    top = r ? Math.max(margin, r.top - h - 6) : margin;
  }
  left = Math.min(Math.max(margin, left), Math.max(margin, vw - w - margin));
  return { left: Math.round(left), top: Math.round(top) };
}

/**
 * Clamp-only reposition for an already-placed node: fixes viewport overflow
 * (content grew, window shrank) without ever yanking a fitting popup.
 * Pure — the node suite covers it.
 */
export function clampPlacement(current, box, viewport) {
  const margin = POPOVER_MARGIN;
  const vw = Math.max(1, viewport?.width || 0);
  const vh = Math.max(1, viewport?.height || 0);
  const w = Math.max(1, box?.width || 0);
  const h = Math.max(1, box?.height || 0);
  let left = Number(current?.left) || 0;
  let top = Number(current?.top) || 0;
  if (left + w > vw - margin) left = Math.max(margin, vw - w - margin);
  if (top + h > vh - margin) top = Math.max(margin, vh - h - margin);
  if (left < margin) left = margin;
  if (top < margin) top = margin;
  return { left: Math.round(left), top: Math.round(top) };
}

/** Close whatever popover is open. Safe to call when none is. */
export function closePopover() {
  if (onDocDown) {
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onDocDown, true);
    onDocDown = null;
  }
  if (onResize) {
    window.removeEventListener('resize', onResize);
    onResize = null;
  }
  if (openEl) {
    openEl.remove();
    openEl = null;
  }
  // Last: the owner's cleanup runs exactly once per open, on every exit path.
  const fn = onCloseFn;
  onCloseFn = null;
  fn?.();
}

function viewport() {
  return { width: window.innerWidth, height: window.innerHeight };
}

function place(node, anchor) {
  document.body.appendChild(node);
  const r = anchor?.getBoundingClientRect?.();
  const box = node.getBoundingClientRect();
  const { left, top } = computePlacement(
    r ? { right: r.right, bottom: r.bottom, top: r.top } : null,
    { width: box.width, height: box.height },
    viewport(),
  );
  node.style.left = `${left}px`;
  node.style.top = `${top}px`;
}

/** Shift an open node back inside the viewport when content growth or a
 * window resize pushed it out. No-op when it still fits. */
function reposition(node) {
  if (!node || openEl !== node) return;
  const box = node.getBoundingClientRect();
  const cur = {
    left: Number.parseFloat(node.style.left) || 0,
    top: Number.parseFloat(node.style.top) || 0,
  };
  // Unplaced nodes (no left/top yet) have nothing to clamp — and must not
  // be yanked to the margin corner.
  if (!node.style.left && !node.style.top) return;
  const { left, top } = clampPlacement(cur, { width: box.width, height: box.height }, viewport());
  node.style.left = `${left}px`;
  node.style.top = `${top}px`;
}

function arm(node, onClose) {
  openEl = node;
  onCloseFn = onClose || null;
  onDocDown = (ev) => {
    if (ev.type === 'keydown') {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
    } else if (node.contains(ev.target)) {
      return;
    }
    closePopover();
  };
  onResize = () => reposition(node);
  document.addEventListener('mousedown', onDocDown, true);
  document.addEventListener('keydown', onDocDown, true);
  window.addEventListener('resize', onResize);
}

/**
 * @param {HTMLElement} anchor
 * @param {Array<{type?:'sep'|'label', label?:string, icon?:string, checked?:boolean, danger?:boolean, disabled?:boolean, action?:()=>void}>} items
 * `icon` is a closed-vocabulary icons.js name (unknown → empty slot, never
 * caller text); an explicit boolean `checked` marks a single-choice option
 * (menuitemradio + boolean aria-checked, trailing check vector when true).
 */
export function openMenu(anchor, items) {
  closePopover();
  const menu = document.createElement('div');
  menu.className = 'pop menu';
  menu.setAttribute('role', 'menu');

  for (const item of items) {
    if (item.type === 'sep') {
      const hr = document.createElement('div');
      hr.className = 'pop-sep';
      menu.appendChild(hr);
      continue;
    }
    if (item.type === 'label') {
      const label = document.createElement('div');
      label.className = 'pop-label';
      label.textContent = item.label || '';
      label.title = item.label || '';
      menu.appendChild(label);
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pop-item' + (item.danger ? ' danger' : '');
    btn.disabled = !!item.disabled;
    // An explicit boolean `checked` is a radio option in a single-choice
    // group (theme, model, effort): menuitemradio with a boolean
    // aria-checked. Ordinary actions stay plain menuitems with no
    // aria-checked at all — presence alone would imply a toggle.
    const isRadio = item.checked === true || item.checked === false;
    btn.setAttribute('role', isRadio ? 'menuitemradio' : 'menuitem');
    const ico = document.createElement('span');
    ico.className = 'pop-ico';
    ico.setAttribute('aria-hidden', 'true');
    // Closed vocabulary only: a menu item's icon is a registry name, never
    // free text — an unknown name leaves the slot empty, not tofu.
    if (isIconName(item.icon)) {
      const svg = iconElement(item.icon, 'ico ico-sm');
      if (svg) ico.appendChild(svg);
    }
    const text = document.createElement('span');
    text.className = 'pop-text-label';
    text.textContent = item.label || '';
    btn.append(ico, text);
    if (isRadio) {
      btn.setAttribute('aria-checked', item.checked ? 'true' : 'false');
      if (item.checked) {
        const mark = iconElement('check', 'ico ico-sm pop-check');
        if (mark) {
          mark.setAttribute('aria-hidden', 'true');
          btn.appendChild(mark);
        }
      }
    }
    btn.addEventListener('click', () => {
      closePopover();
      item.action?.();
    });
    menu.appendChild(btn);
  }

  place(menu, anchor);
  arm(menu, () => anchor?.setAttribute?.('aria-expanded', 'false'));
  anchor?.setAttribute?.('aria-expanded', 'true');
  menu.querySelector('.pop-item:not(:disabled)')?.focus?.();
  return menu;
}

/**
 * Anchor an arbitrary rich node (MCP / subagent panels) with the standard
 * dismiss semantics: outside mousedown or Escape closes it. Callers keep
 * the node and re-render its contents in place on fresh data.
 *
 * Fill the node BEFORE calling: placement measures the live box, so an
 * empty node places for the wrong size and the filled panel overflows.
 * @returns {{node: HTMLElement, isOpen: () => boolean, reposition: () => void}}
 */
export function openPanel(anchor, node, { onClose = null } = {}) {
  closePopover();
  node.classList.add('pop');
  place(node, anchor);
  arm(node, () => {
    anchor?.setAttribute?.('aria-expanded', 'false');
    onClose?.();
  });
  anchor?.setAttribute?.('aria-expanded', 'true');
  return { node, isOpen: () => openEl === node, reposition: () => reposition(node) };
}

/**
 * Small yes/no anchored to the control that triggered it.
 * Resolves false on dismiss, so a stray click never destroys anything.
 * @returns {Promise<boolean>}
 */
export function miniConfirm(anchor, message, opts = {}) {
  closePopover();
  const { okLabel = 'ลบ', cancelLabel = 'ยกเลิก', danger = true, infoOnly = false } = opts;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      closePopover();
      resolve(value);
    };

    const pop = document.createElement('div');
    pop.className = 'pop confirm';
    pop.setAttribute('role', 'dialog');

    const text = document.createElement('div');
    text.className = 'pop-text';
    text.textContent = message;
    pop.appendChild(text);

    const row = document.createElement('div');
    row.className = 'pop-actions';

    if (cancelLabel && !infoOnly) {
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'btn';
      cancel.textContent = cancelLabel;
      cancel.addEventListener('click', () => finish(false));
      row.appendChild(cancel);
    }

    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'btn ' + (danger && !infoOnly ? 'danger' : 'primary');
    ok.textContent = infoOnly ? okLabel || 'ตกลง' : okLabel;
    ok.addEventListener('click', () => finish(!infoOnly ? true : false));
    row.appendChild(ok);

    pop.appendChild(row);
    place(pop, anchor);
    arm(pop, () => finish(false));
    ok.focus();
  });
}
