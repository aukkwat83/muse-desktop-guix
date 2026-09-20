// Session mode model (kept from the kimi/grok lineage, useful for UI cycle)
//   Normal (ask) → Plan → Always-approve → Normal
//
// MSP mapping (muse serve speaks no ACP): the three UI modes resolve onto
// the closed ApprovalMode vocabulary (schema: allowAll | promptUnmatched |
// onRequest | denyUnmatched):
//   always → allowAll        (yolo: everything is allowed)
//   normal → promptUnmatched (ask: unmatched tools prompt a card)
//   plan   → denyUnmatched   (explore freely, change nothing: matched reads
//                             still pass, unmatched writes are denied without
//                             a prompt — the closest native plan-mode shape)

/** @typedef {'normal'|'plan'|'always'} SessionMode */
/** @typedef {'inactive'|'pending'|'active'} PlanState */

/** @type {SessionMode[]} */
export const SESSION_MODE_CYCLE = ['normal', 'plan', 'always'];

export function normalizeSessionMode(raw) {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
  if (v === 'plan' || v === 'planning') return 'plan';
  if (
    v === 'always' ||
    v === 'always-approve' ||
    v === 'alwaysapprove' ||
    v === 'bypass' ||
    v === 'bypasspermissions' ||
    v === 'yolo' ||
    v === 'auto'
  ) {
    return 'always';
  }
  return 'normal';
}

export function sessionModeToMspApprovalMode(mode) {
  const m = normalizeSessionMode(mode);
  if (m === 'always') return 'allowAll';
  if (m === 'plan') return 'denyUnmatched';
  return 'promptUnmatched';
}

export function mspApprovalModeToSessionMode(modeId) {
  const v = String(modeId ?? '').trim();
  if (v === 'allowAll') return 'always';
  if (v === 'denyUnmatched') return 'plan';
  return 'normal';
}

export function sessionModeAlwaysApprove(mode, yoloArmed = false) {
  const m = normalizeSessionMode(mode);
  if (m === 'always') return true;
  if (m === 'plan') return !!yoloArmed;
  return false;
}

/**
 * MSP applies mode changes live via `session/setApprovalMode` — no process
 * restart exists on this path. Kept as a function (not deleted) so callers
 * keep one place to ask; the answer is always false.
 */
export function sessionModeNeedsProcessRestart() {
  return false;
}

export function cycleSessionMode(current) {
  const m = normalizeSessionMode(current);
  const i = SESSION_MODE_CYCLE.indexOf(m);
  return SESSION_MODE_CYCLE[(i < 0 ? 0 : i + 1) % SESSION_MODE_CYCLE.length];
}

export function sessionModeLabel(mode, opts = {}) {
  const m = normalizeSessionMode(mode);
  if (m === 'plan') {
    const st = opts.planState || 'inactive';
    const yolo = opts.yoloArmed ? '+yolo' : '';
    if (st === 'pending') return `plan${yolo} (pending)`;
    return `plan${yolo}`;
  }
  if (m === 'always') return 'always-approve';
  return 'ask';
}

export function sessionModePill(mode, opts = {}) {
  const m = normalizeSessionMode(mode);
  if (m === 'plan') {
    const y = opts.yoloArmed ? '+yolo' : '';
    const p = opts.planState === 'pending' ? '…' : '';
    return `plan${p}${y}`;
  }
  if (m === 'always') return 'yolo';
  return 'ask';
}
