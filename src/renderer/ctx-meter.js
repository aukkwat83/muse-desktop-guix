// Context-window meter helpers — grok-desktop ctx-meter.js parity, minus the
// invented default: when the host reports no window limit, the limit part is
// omitted, never fabricated (MSP schema tdd SS4.6.6). Pure — no DOM.

export function formatTokensK(n) {
  const x = Math.max(0, Number(n) || 0);
  if (x >= 1_000_000) return `${(x / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (x >= 1000) return `${(x / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(Math.round(x));
}

const PRESSURE_LEVEL = { normal: 'ok', warning: 'warn', blocked: 'danger' };

/**
 * @param {number} used counted-once occupancy
 * @param {number|null} max effective window, or null when the basis has none
 * @param {string} [pressure] server level (normal|warning|blocked)
 * @param {{promptTokens:number|null,outputTokens:number|null,totalTokens:number|null}|null} [tokens]
 * @returns {{text:string, level:'ok'|'warn'|'danger'|'idle', usedPct:number|null, title:string}}
 */
export function formatCtxMeter(used, max, pressure = 'normal', tokens = null) {
  const u = Math.max(0, Number(used) || 0);
  const m = Number.isFinite(Number(max)) && Number(max) > 0 ? Number(max) : null;
  const remainingPct = m == null ? null : Math.max(0, Math.min(100, ((m - u) / m) * 100));
  const usedPct = remainingPct == null ? null : Math.max(0, Math.min(100, 100 - remainingPct));
  // The server's pressure wins when present; otherwise grok's remaining
  // thresholds (<25% warn, <10% danger); no limit at all stays idle.
  let level = 'idle';
  if (PRESSURE_LEVEL[pressure]) {
    level = PRESSURE_LEVEL[pressure];
  } else if (remainingPct != null) {
    level = remainingPct < 10 ? 'danger' : remainingPct < 25 ? 'warn' : 'ok';
  }
  const text = m == null ? `${formatTokensK(u)} / —` : `${formatTokensK(u)} / ${formatTokensK(m)} (${Math.round(usedPct)}%)`;
  let title = m == null
    ? `Context ที่ใช้ ${u.toLocaleString()} tokens (host ไม่บอก limit)`
    : `Context window\n${u.toLocaleString()} / ${m.toLocaleString()} tokens ` +
      `(${usedPct.toFixed(1)}% ใช้ · ${remainingPct.toFixed(1)}% เหลือ)`;
  if (tokens && (tokens.totalTokens != null || tokens.promptTokens != null)) {
    const t = tokens.totalTokens != null ? tokens.totalTokens.toLocaleString() : '—';
    const p = tokens.promptTokens != null ? tokens.promptTokens.toLocaleString() : '—';
    const o = tokens.outputTokens != null ? tokens.outputTokens.toLocaleString() : '—';
    title += `\nSession นี้รวม ${t} tokens (prompt ${p} · output ${o})`;
  }
  return { text, level, usedPct, title };
}

export default formatCtxMeter;
