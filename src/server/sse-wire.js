// SSE wire for Muse Desktop.
//
// Design notes (carried over from grok-desktop's wire v2, which was rebuilt
// after a class of "UI misses the end of a turn" bugs):
//   - every event carries a monotonic `id`, so a reconnecting client can
//     replay what it missed via `Last-Event-ID`
//   - a bounded ring keeps recent events for that replay
//   - back-pressure never drops a *terminal* event (`turn_done`, `error`,
//     `interaction`) — dropping those is what strands a UI in "running"
//     forever; deltas coalesce latest-per-chat instead, chatter drops
//   - clients may subscribe to a subset of chats; unfiltered clients see all

const RING_SIZE = 2000;

export class SseWire {
  constructor({ ringSize = RING_SIZE } = {}) {
    this.ringSize = ringSize;
    /** @type {{id:number, chatId:string|null, type:string, payload:any}[]} */
    this.ring = [];
    this.seq = 0;
    /** @type {Map<string, {res:any, chatIds:Set<string>|null, alive:boolean}>} */
    this.clients = new Map();
  }

  /** Events that must never be dropped by back-pressure. */
  static isTerminal(type) {
    return (
      type === 'turn_done' ||
      type === 'turn_error' ||
      type === 'interaction' ||
      type === 'interaction_resolved' ||
      type === 'chat_removed' ||
      type === 'auth_required' ||
      type === 'agent_exit'
    );
  }

  /**
   * Coalesced under back-pressure (latest per chat wins). Lossless because
   * every payload carries the running-total `text` — skipping intermediate
   * frames loses no characters.
   */
  static isCoalescible(type) {
    return type === 'message_delta' || type === 'thought_delta';
  }

  /** Pure chatter — dropped outright while a client is backed up. */
  static isDroppable(type) {
    return type === 'agent_stderr' || type === 'agent_update_other';
  }

  addClient(clientId, res, { chatIds = null, lastEventId = null } = {}) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const entry = {
      res,
      chatIds: chatIds && chatIds.length ? new Set(chatIds) : null,
      alive: true,
    };
    this.clients.set(clientId, entry);

    res.write(`retry: 1500\n\n`);
    // `hello` is deliberately id-less. Giving it the *current* seq would make
    // the browser store that id as Last-Event-ID before the replay below has
    // run — so a drop right after connect would resume past every event we
    // were about to replay, losing them permanently.
    this._writeTo(entry, {
      id: null,
      chatId: null,
      type: 'hello',
      payload: { clientId, seq: this.seq },
    });

    const since = Number.parseInt(String(lastEventId ?? ''), 10);
    if (Number.isFinite(since) && since >= 0) {
      // Cursor older than the ring's oldest frame = the events it missed were
      // evicted; replay can never fill that gap. Signal a resync with a real
      // (advancing, unstored) id so the client's cursor moves past the gap —
      // grok-desktop does the same (index.js:529-534). Without this the client
      // silently misses turn_done/interaction and spins until a full reload.
      const evicted =
        since < this.seq && (this.ring.length === 0 || this.ring[0].id > since + 1);
      if (evicted) {
        this._writeTo(entry, { id: ++this.seq, chatId: null, type: 'resync', payload: {} });
      } else {
        for (const ev of this.ring) {
          if (ev.id > since && this._matches(entry, ev)) this._writeTo(entry, ev);
        }
      }
    }

    const ping = setInterval(() => {
      if (!entry.alive) return;
      try {
        res.write(`: ping ${Date.now()}\n\n`);
      } catch {
        this.removeClient(clientId);
      }
    }, 20_000);
    ping.unref?.();
    entry.ping = ping;

    res.on('close', () => this.removeClient(clientId));
    return entry;
  }

  removeClient(clientId) {
    const entry = this.clients.get(clientId);
    if (!entry) return;
    entry.alive = false;
    if (entry.ping) clearInterval(entry.ping);
    try {
      entry.res.end();
    } catch {
      /* already gone */
    }
    this.clients.delete(clientId);
  }

  subscribe(clientId, chatIds) {
    const entry = this.clients.get(clientId);
    if (!entry) return false;
    entry.chatIds = Array.isArray(chatIds) && chatIds.length ? new Set(chatIds) : null;
    return true;
  }

  _matches(entry, ev) {
    if (!entry.chatIds) return true;
    if (!ev.chatId) return true; // host-level events always pass
    return entry.chatIds.has(ev.chatId);
  }

  _writeTo(entry, ev, { force = false } = {}) {
    if (!entry.alive) return;
    if (!force && entry.backpressure) {
      if (SseWire.isCoalescible(ev.type)) {
        if (!entry.coalesce) entry.coalesce = new Map();
        entry.coalesce.set(`${ev.type}::${ev.chatId || '_'}`, ev);
        return;
      }
      if (SseWire.isDroppable(ev.type)) return;
      // Terminal and any other must-deliver frame: flush coalesced deltas
      // first — they are older and must never be overtaken on the wire.
      this._flushCoalesce(entry);
    }
    this._writeFrame(entry, ev);
  }

  /** Raw write; returns res.write()'s back-pressure signal. */
  _writeFrame(entry, ev) {
    try {
      const line =
        (ev.id == null ? '' : `id: ${ev.id}\n`) +
        `event: ${ev.type}\n` +
        `data: ${JSON.stringify({ chatId: ev.chatId, type: ev.type, ...ev.payload })}\n\n`;
      const ok = entry.res.write(line);
      if (!ok) {
        entry.backpressure = true;
        if (!entry.drainHooked) {
          entry.drainHooked = true;
          entry.res.on('drain', () => {
            entry.drainHooked = false;
            this._flushCoalesce(entry);
          });
        }
      }
      return ok;
    } catch {
      entry.alive = false;
      return false;
    }
  }

  /**
   * Drain handler: write out the coalesced latest-per-chat frames. A write()
   * that returns false has still accepted the data into the stream's userland
   * buffer (order preserved) — it only means "call back on drain", so every
   * queued frame is flushed here; back-pressure simply stays armed.
   */
  _flushCoalesce(entry) {
    if (!entry.alive) return;
    const map = entry.coalesce;
    if (!map || !map.size) {
      entry.backpressure = false;
      return;
    }
    const frames = [...map.values()];
    map.clear();
    let allOk = true;
    for (const ev of frames) {
      if (!this._writeFrame(entry, ev)) allOk = false;
      if (!entry.alive) return;
    }
    if (allOk) entry.backpressure = false;
  }

  /**
   * Broadcast one event.
   * @param {string|null} chatId
   * @param {string} type
   * @param {object} payload
   */
  emit(chatId, type, payload = {}) {
    const ev = { id: ++this.seq, chatId: chatId || null, type, payload };
    this.ring.push(ev);
    if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize);
    for (const [clientId, entry] of [...this.clients]) {
      if (!entry.alive) {
        this.removeClient(clientId);
        continue;
      }
      if (this._matches(entry, ev)) this._writeTo(entry, ev);
    }
    return ev.id;
  }

  get clientCount() {
    return this.clients.size;
  }

  closeAll() {
    for (const id of [...this.clients.keys()]) this.removeClient(id);
  }
}
