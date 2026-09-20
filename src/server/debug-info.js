// Debug snapshot for GET /api/debug and the /api/debug/stream feed (BUG-071).
// Kept as a pure function so the payload shape is unit-testable without
// booting the HTTP host. Only counters that genuinely exist are reported —
// a made-up metric here reads as a working one on the debug page.

/**
 * @param {object} args
 * @param {import('./sse-wire.js').SseWire} args.wire
 * @param {{ stats: () => object }} args.sessions
 * @param {{ version: string, productName?: string, name: string }} args.pkg
 * @param {number} args.port
 * @param {string} args.host
 * @param {string} args.stateDir
 */
export function debugSnapshot({ wire, sessions, pkg, port, host, stateDir }) {
  const ring = wire.ring;
  return {
    pid: process.pid,
    port,
    host,
    version: pkg.version,
    name: pkg.productName || pkg.name,
    uptimeMs: Math.round(process.uptime() * 1000),
    stateDir,
    sse: {
      clients: wire.clientCount,
      seq: wire.seq,
      ringSize: ring.length,
      ringMax: wire.ringSize,
      minId: ring.length ? ring[0].id : null,
      maxId: ring.length ? ring[ring.length - 1].id : null,
    },
    sessions: sessions.stats(),
  };
}
