// Anchored popovers: the hamburger menu and the inline delete confirm.
//
// Deliberately not `window.confirm`: a modal sheet in the middle of the screen
// for "delete this chat?" loses the thing you were pointing at, and in the
// WKWebView shell it blocks the whole window. These attach to the button that
// opened them, so the answer stays where the question was asked.

let openEl = null;
let onDocDown = null;

/** Close whatever popover is open. Safe to call when none is. */
export function closePopover() {
  if (onDocDown) {
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onDocDown, true);
    onDocDown = null;
  }
  if (openEl) {
    openEl.remove();
    openEl = null;
  }
}

function place(node, anchor) {
  document.body.appendChild(node);
  const r = anchor?.getBoundingClientRect?.();
  const box = node.getBoundingClientRect();
  const margin = 8;
  let left = r ? r.right - box.width : window.innerWidth / 2 - box.width / 2;
  let top = r ? r.bottom + 6 : window.innerHeight / 2;
  // Flip above / clamp inside the window rather than letting it hang off-screen.
  if (top + box.height > window.innerHeight - margin) {
    top = r ? Math.max(margin, r.top - box.height - 6) : margin;
  }
  left = Math.min(Math.max(margin, left), window.innerWidth - box.width - margin);
  node.style.left = `${Math.round(left)}px`;
  node.style.top = `${Math.round(top)}px`;
}

function arm(node, onClose) {
  openEl = node;
  onDocDown = (ev) => {
    if (ev.type === 'keydown') {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
    } else if (node.contains(ev.target)) {
      return;
    }
    closePopover();
    onClose?.();
  };
  document.addEventListener('mousedown', onDocDown, true);
  document.addEventListener('keydown', onDocDown, true);
}

/**
 * @param {HTMLElement} anchor
 * @param {Array<{type?:'sep'|'label', label?:string, icon?:string, danger?:boolean, disabled?:boolean, action?:()=>void}>} items
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
    btn.setAttribute('role', 'menuitem');
    const ico = document.createElement('span');
    ico.className = 'pop-ico';
    ico.textContent = item.icon || '';
    const text = document.createElement('span');
    text.textContent = item.label || '';
    btn.append(ico, text);
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
 * @returns {{node: HTMLElement, isOpen: () => boolean}}
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
  return { node, isOpen: () => openEl === node };
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
