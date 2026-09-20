// Agent-wide model/thinking catalog cache (BUG-079).
//
// The configOptions a live session advertises are a property of the CLI
// install, not of one chat — only `currentValue` is per-chat. So a catalog
// learned from ANY live session can serve the pickers of a cold chat that
// never spawned. Persisted next to the session store so a host restart keeps
// the pills usable; a corrupt or missing file simply means "learn on the
// next live session".

import fs from 'node:fs';
import path from 'node:path';

import { stateDir } from './session-store.js';

export class ConfigCatalog {
  constructor({ file = path.join(stateDir(), 'config-catalog.json') } = {}) {
    this.file = file;
    this.model = null;
    this.thinking = null;
    this.fetchedAt = 0;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw?.model) {
        this.model = raw.model;
        this.thinking = raw.thinking ?? null;
        this.fetchedAt = Number(raw.fetchedAt) || 0;
      }
    } catch {
      /* first run or a corrupt file — start empty */
    }
  }

  get empty() {
    return !this.model;
  }

  /** Learn the selects a live client advertises (MspClient.configSelects() shape). */
  update(selects) {
    if (!selects?.model) return;
    this.model = selects.model;
    this.thinking = selects.thinking ?? null;
    this.fetchedAt = Date.now();
    try {
      fs.writeFileSync(
        this.file,
        JSON.stringify(
          { model: this.model, thinking: this.thinking, fetchedAt: this.fetchedAt },
          null,
          2,
        ),
      );
    } catch {
      /* the cache is a nicety, never a failure */
    }
  }

  /** The cached catalog in the configSelects() shape, or null when never learned. */
  selects() {
    if (!this.model) return null;
    return { model: this.model, thinking: this.thinking };
  }
}
