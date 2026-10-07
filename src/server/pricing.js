// Session cost estimates for the right-bar calculator.
//
// The MSP wire reports cumulative prompt/output tokens per session
// (`session/tokenUsage`) but no prices, so the desktop owns a small static
// rate table: USD per 1M tokens, converted to THB for display. Rates are
// labelled with their effective date and source — a stale table that
// pretends to be exact is worse than one that says it is an estimate.
//
// Operators pin real rates with MUSE_DESKTOP_PRICE_JSON:
//   {"effective":"2026-09-01","source":"finops sheet",
//    "models":{"my-model":{"input":1.2,"output":6.0}}}
// which replaces the built-in table wholesale (missing models fall back to
// `default`, still flagged estimated). THB/USD via MUSE_DESKTOP_THB_PER_USD.

const BUILTIN = {
  effective: '2026-09-22',
  source: 'Meta Model API public pricing — standard $1.25/$4.25, contributor $0.10/$0.20 per 1M in/out',
  currency: 'USD-per-1M-tokens',
  models: {
    // Real IDs from the agent's advertised model/list; rates from Meta's
    // public Model API pricing (identical for 1.2 and 1.3). The contributor
    // tier trades data (Meta may train on the traffic) for ~10-20x cheaper
    // tokens — it must never share the standard row again.
    // NOTE: cached-input has its own price ($0.15 std / $0.002 contributor)
    // but MSP reports no cached split, so promptTokens bills at the full
    // input rate: the estimate is an upper bound, never below the bill.
    'muse-spark-1.3': { input: 1.25, output: 4.25 },
    'muse-spark-1.3-contributor': { input: 0.10, output: 0.20 },
    'muse-spark-1.2': { input: 1.25, output: 4.25 },
    'muse-spark-1.2-contributor': { input: 0.10, output: 0.20 },
    'muse-spark': { input: 1.25, output: 4.25 },
    'meta-muse-spark': { input: 1.25, output: 4.25 },
    default: { input: 1.25, output: 4.25 },
  },
};

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Active rate table: env override wins wholesale, else the built-in one. */
export function priceTable() {
  const raw = process.env.MUSE_DESKTOP_PRICE_JSON;
  if (raw) {
    try {
      const doc = JSON.parse(raw);
      const models = doc?.models && typeof doc.models === 'object' ? doc.models : {};
      const clean = {};
      for (const [id, r] of Object.entries(models)) {
        clean[String(id)] = { input: num(r?.input, 0), output: num(r?.output, 0) };
      }
      if (!clean.default) clean.default = { ...BUILTIN.models.default };
      return {
        effective: String(doc?.effective || 'env override'),
        source: String(doc?.source || 'MUSE_DESKTOP_PRICE_JSON'),
        currency: BUILTIN.currency,
        models: clean,
        override: true,
      };
    } catch {
      // A malformed override must never break the cost bar — fall through.
    }
  }
  return { ...BUILTIN, models: { ...BUILTIN.models }, override: false };
}

export function thbPerUsd() {
  return num(process.env.MUSE_DESKTOP_THB_PER_USD, 35);
}

/**
 * Resolve the rate row for a model id. Matching is forgiving on purpose:
 * exact id → suffix after the last `/` (provider/model aliases) → the id's
 * lowercase form → lowercase suffix → `default`. The last step matters:
 * without it `Meta/Muse-Spark` matches nothing (suffix keeps its case,
 * lowercase keeps the prefix) and silently falls back to default.
 * The returned `matched` tells the UI whether the number is model-specific
 * or a fallback.
 */
export function rateFor(modelId, table = priceTable()) {
  const models = table?.models || {};
  const raw = String(modelId || '').trim();
  const base = raw ? raw.split('/').filter(Boolean).pop() : '';
  const candidates = raw ? [raw, base, raw.toLowerCase(), (base || '').toLowerCase()] : [];
  for (const c of candidates) {
    if (c && models[c]) return { rate: models[c], matched: c, estimated: false };
  }
  return { rate: models.default || BUILTIN.models.default, matched: 'default', estimated: true };
}

/**
 * Session-total cost from cumulative MSP tokens.
 * @returns {{ usd, thb, promptTokens, outputTokens, totalTokens, rate, matched, estimated, effective, source }}
 */
export function sessionCost({ promptTokens, outputTokens, totalTokens, model } = {}) {
  const table = priceTable();
  const { rate, matched, estimated } = rateFor(model, table);
  const p = Math.max(0, Math.round(Number(promptTokens) || 0));
  const o = Math.max(0, Math.round(Number(outputTokens) || 0));
  const t = Number.isFinite(Number(totalTokens)) && Number(totalTokens) >= 0
    ? Math.round(Number(totalTokens))
    : p + o;
  const usd = (p * rate.input + o * rate.output) / 1_000_000;
  const thb = usd * thbPerUsd();
  return {
    usd,
    thb,
    promptTokens: p,
    outputTokens: o,
    totalTokens: t,
    rate: { ...rate },
    matched,
    estimated: estimated || !table.override,
    effective: table.effective,
    source: table.source,
  };
}

export function formatThb(n) {
  return `฿${Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatUsd(n) {
  return `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;
}
