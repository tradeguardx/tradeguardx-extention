/* global chrome, window */

/**
 * Host-scoped snapshot of currently open positions, persisted to chrome.storage.local.
 *
 * Solves two problems:
 *  1. When the user switches to the Close / History / Pending tab, the broker DOM stops
 *     showing the active positions table. Without a cache, the scan reports zero trades
 *     and the popup / rules engine treat the account as "flat" — hedging prevention
 *     silently passes, funded-mode equity mis-computes because floating P&L is taken
 *     from the (empty) positions array.
 *  2. On page refresh, in-memory journal state resets. Every still-open trade looks
 *     "new" on the first scan, so we re-fire a journal OPEN event with a fresh
 *     `clientTradeId` — breaking server-side dedup.
 *
 * Snapshot shape (one entry per storage key, keyed by host):
 *   {
 *     updatedAt: <ms>,
 *     positions: [ {symbol, side, volume, stopLoss, takeProfit, profit,
 *                   entryPrice, currentPrice, rowId} ],
 *     firstSeenMs: { [positionKey]: <ms> },
 *     journalStates: { [journalKey]: {tradeUid, clientTradeId, openedAtMs, seq,
 *                                      symbol, side, last} }
 *   }
 *
 * Entries older than STALE_MS are treated as missing so we never resurrect positions
 * after a long idle period.
 */

(function registerPositionCache() {
  const STORAGE_PREFIX = 'tg_position_cache:';
  const STALE_MS = 30 * 60 * 1000; // 30 minutes

  function keyFor(host) {
    return `${STORAGE_PREFIX}${String(host || '').toLowerCase()}`;
  }

  function storageLocal() {
    if (typeof chrome === 'undefined') return null;
    return chrome.storage?.local || null;
  }

  async function load(host) {
    const local = storageLocal();
    if (!local || !host) return null;
    const k = keyFor(host);
    return new Promise((resolve) => {
      try {
        local.get(k, (items) => {
          const snap = items?.[k] || null;
          if (!snap || typeof snap !== 'object') return resolve(null);
          if (!Number.isFinite(snap.updatedAt)) return resolve(null);
          if (Date.now() - snap.updatedAt > STALE_MS) return resolve(null);
          resolve(snap);
        });
      } catch (_err) {
        resolve(null);
      }
    });
  }

  function save(host, snapshot) {
    const local = storageLocal();
    if (!local || !host) return;
    const k = keyFor(host);
    const payload = {
      updatedAt: Date.now(),
      positions: Array.isArray(snapshot?.positions) ? snapshot.positions : [],
      firstSeenMs: snapshot?.firstSeenMs && typeof snapshot.firstSeenMs === 'object' ? snapshot.firstSeenMs : {},
      journalStates: snapshot?.journalStates && typeof snapshot.journalStates === 'object' ? snapshot.journalStates : {}
    };
    try {
      local.set({ [k]: payload });
    } catch (_err) {
      /* ignore */
    }
  }

  function clear(host) {
    const local = storageLocal();
    if (!local || !host) return;
    try {
      local.remove(keyFor(host));
    } catch (_err) {
      /* ignore */
    }
  }

  /**
   * Strip non-serializable fields from a journal state map (Map) so it can be stored.
   * `timerId` is a setTimeout handle; `pending` may contain already-flushed events.
   */
  function serializeJournalStates(journalMap) {
    const out = {};
    if (!journalMap || typeof journalMap.forEach !== 'function') return out;
    journalMap.forEach((state, key) => {
      if (!state) return;
      out[key] = {
        key: state.key || key,
        tradeUid: state.tradeUid || null,
        clientTradeId: state.clientTradeId || null,
        openedAtMs: Number(state.openedAtMs) || null,
        seq: Number(state.seq) || 0,
        symbol: state.symbol || null,
        side: state.side || null,
        last: state.last && typeof state.last === 'object' ? { ...state.last } : null
      };
    });
    return out;
  }

  /** Serialize a Map<string, number> (_positionFirstSeenMs). */
  function serializeFirstSeen(firstSeenMap) {
    const out = {};
    if (!firstSeenMap || typeof firstSeenMap.forEach !== 'function') return out;
    firstSeenMap.forEach((ms, key) => {
      if (Number.isFinite(ms)) out[key] = ms;
    });
    return out;
  }

  /** Strip DOM element refs from positions so they can be stored. */
  function serializePositions(positions) {
    if (!Array.isArray(positions)) return [];
    return positions.map((p) => ({
      rowId: p?.rowId ?? null,
      symbol: p?.symbol ?? null,
      side: p?.side ?? null,
      volume: p?.volume ?? null,
      stopLoss: p?.stopLoss ?? null,
      takeProfit: p?.takeProfit ?? null,
      profit: p?.profit ?? null,
      entryPrice: p?.entryPrice ?? null,
      currentPrice: p?.currentPrice ?? null
    }));
  }

  window.TradeGuardXPositionCache = {
    load,
    save,
    clear,
    serializeJournalStates,
    serializeFirstSeen,
    serializePositions,
    STALE_MS
  };
})();
