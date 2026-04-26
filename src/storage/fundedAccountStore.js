/* global chrome */

/**
 * Per-account storage for funded-mode state:
 *   - Account config cache (equityMode, dailyStartingBalance, timezone, dailyResetTimeLocal, etc.)
 *   - Closed-trade ring buffer (for summing today's realized P&L)
 *   - Daily reset bookkeeping (lastDailyResetAt, lastReconciledAt)
 *
 * The service worker is the single writer; content scripts read via TG_GET_ACCOUNT_CONFIG.
 * Keys are namespaced per tradingAccountId so multiple accounts coexist in one browser.
 *
 * Kept separate from the main Storage class because this state is driven by
 * pairing-session sync rather than user config, and is only relevant for
 * accounts in funded mode.
 */

const CONFIG_KEY_PREFIX = 'tradeGuardXAccountConfig:';
const CLOSED_TRADES_KEY_PREFIX = 'tradeGuardXClosedTrades:';
const CLOSED_TRADES_RETENTION_DAYS = 30;
const CLOSED_TRADES_MAX_ROWS = 500;

function configKey(accountId) {
  return `${CONFIG_KEY_PREFIX}${accountId}`;
}

function closedTradesKey(accountId) {
  return `${CLOSED_TRADES_KEY_PREFIX}${accountId}`;
}

function localGet(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (result) => {
      if (chrome.runtime.lastError) resolve(undefined);
      else resolve(result[key]);
    });
  });
}

function localSet(key, value) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, () => resolve());
  });
}

function localRemove(key) {
  return new Promise((resolve) => {
    chrome.storage.local.remove(key, () => resolve());
  });
}

export async function getAccountConfig(accountId) {
  if (!accountId) return null;
  const raw = await localGet(configKey(accountId));
  return raw && typeof raw === 'object' ? raw : null;
}

export async function saveAccountConfig(accountId, config) {
  if (!accountId || !config || typeof config !== 'object') return;
  const existing = (await getAccountConfig(accountId)) || {};
  await localSet(configKey(accountId), { ...existing, ...config, accountId });
}

export async function clearAccountConfig(accountId) {
  if (!accountId) return;
  await localRemove(configKey(accountId));
  await localRemove(closedTradesKey(accountId));
}

export async function recordClosedTrade(accountId, trade) {
  if (!accountId || !trade) return;
  const closedAt = typeof trade.closedAt === 'number' ? trade.closedAt : Date.now();
  const pnl = Number(trade.pnl);
  if (!Number.isFinite(pnl)) return;

  const existing = (await localGet(closedTradesKey(accountId))) || [];
  const cutoff = Date.now() - CLOSED_TRADES_RETENTION_DAYS * 86_400_000;
  const trimmed = existing.filter((t) => typeof t.closedAt === 'number' && t.closedAt >= cutoff);

  trimmed.push({
    id: trade.clientTradeId || `${closedAt}_${trade.symbol || '?'}`,
    symbol: trade.symbol || null,
    side: trade.side || null,
    pnl,
    closedAt
  });

  // Bound growth — drop oldest if over cap.
  if (trimmed.length > CLOSED_TRADES_MAX_ROWS) {
    trimmed.splice(0, trimmed.length - CLOSED_TRADES_MAX_ROWS);
  }

  await localSet(closedTradesKey(accountId), trimmed);
}

export async function listClosedTrades(accountId) {
  if (!accountId) return [];
  const raw = await localGet(closedTradesKey(accountId));
  return Array.isArray(raw) ? raw : [];
}

/**
 * Sum realized P&L for trades closed on or after `sinceMs`.
 * Callers pass the day's reset instant as `sinceMs`.
 */
export async function sumClosedPnlSince(accountId, sinceMs) {
  const trades = await listClosedTrades(accountId);
  const floor = Number.isFinite(sinceMs) ? sinceMs : 0;
  let sum = 0;
  for (const t of trades) {
    if (typeof t.closedAt === 'number' && t.closedAt >= floor && Number.isFinite(t.pnl)) {
      sum += t.pnl;
    }
  }
  return sum;
}

/**
 * Count trades closed on or after `sinceMs`.
 */
export async function countClosedSince(accountId, sinceMs) {
  const trades = await listClosedTrades(accountId);
  const floor = Number.isFinite(sinceMs) ? sinceMs : 0;
  let count = 0;
  for (const t of trades) {
    if (typeof t.closedAt === 'number' && t.closedAt >= floor) count += 1;
  }
  return count;
}

/**
 * Combine the server-side daily summary with the local closed-trade ring buffer.
 * Stricter-wins: `trades = max(server, local)`, `pnl = min(server, local)` (more
 * negative loss dominates). The server seed protects against disconnect/reconnect
 * resetting counters; local additions protect against journaling latency.
 *
 * Returns { closedTradesToday, closedPnlToday, windowStartMs, source }.
 *   source: 'server-and-local' | 'local-only' (when server seed is missing/stale)
 */
export async function getEffectiveDailyCounters(accountId, windowStartMs) {
  const config = await getAccountConfig(accountId);
  const summary = config?.serverDailySummary;
  const localCount = await countClosedSince(accountId, windowStartMs);
  const localPnl = await sumClosedPnlSince(accountId, windowStartMs);

  if (!summary || typeof summary !== 'object') {
    return {
      closedTradesToday: localCount,
      closedPnlToday: localPnl,
      windowStartMs,
      source: 'local-only',
    };
  }

  const serverCount = Number(summary.closedTradesToday) || 0;
  const serverPnl = Number(summary.closedPnlToday) || 0;

  return {
    closedTradesToday: Math.max(serverCount, localCount),
    closedPnlToday: Math.min(serverPnl, localPnl),
    windowStartMs,
    source: 'server-and-local',
  };
}
