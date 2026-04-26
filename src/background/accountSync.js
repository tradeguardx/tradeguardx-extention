/**
 * Background helpers for funded-account state sync:
 *   - Fetch the current trading account (bound via pairing token) from the user service
 *   - Cache it locally for content-script consumption
 *   - Push balance/reset snapshot changes back to the server
 *   - Post user-declared balance reconciliation
 */

import {
  getTradingAccountsListUrl,
  getTradingAccountPatchUrl,
  getTradingAccountReconcileUrl,
  getTradesDailySummaryUrl,
} from '../config/api.js';
import { getValidAccessToken } from './pairingSession.js';
import { saveAccountConfig, getAccountConfig } from '../storage/fundedAccountStore.js';
import { hasResetPassed, lastResetInstant } from './dailyReset.js';

function unwrap(json) {
  if (json && json.success && json.data != null) return json.data;
  return json;
}

async function authedFetch(url, init = {}) {
  const token = await getValidAccessToken();
  if (!token) throw new Error('Pairing session missing');
  const res = await fetch(url, {
    ...init,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
  }
  const json = await res.json().catch(() => ({}));
  return unwrap(json);
}

/**
 * Fetch the server's timezone-aware daily summary — closed-trade count and P&L
 * since the account's last reset instant. Used to seed local counters so a
 * disconnect/reconnect can't reset max-trades-per-day or daily-loss rules.
 * Returns null on failure; rule evaluation falls back to the local ring buffer.
 */
export async function fetchTradesDailySummary() {
  try {
    const data = await authedFetch(getTradesDailySummaryUrl(), { method: 'GET' });
    if (!data || typeof data !== 'object') return null;
    return {
      closedTradesToday: Number(data.closedTradesToday) || 0,
      closedPnlToday: Number(data.closedPnlToday) || 0,
      dailyWindowStart: data.dailyWindowStart || null,
      dailyWindowSource: data.dailyWindowSource || null,
      asOf: data.asOf || new Date().toISOString(),
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('TradeGuardX: fetchTradesDailySummary failed', err?.message || err);
    return null;
  }
}

/**
 * Fetch the extension's bound trading account and persist to local cache.
 * Also fetches the server-side daily summary (trade count + P&L since last reset)
 * and merges it into the cached config under `serverDailySummary` so rule
 * evaluation can combine it with the local closed-trade ring buffer.
 * Returns the cached config (or null if fetch failed).
 */
export async function refreshAccountConfig() {
  try {
    const data = await authedFetch(getTradingAccountsListUrl(), { method: 'GET' });
    const account = Array.isArray(data?.accounts) ? data.accounts[0] : null;
    if (!account || !account.id) return null;
    const summary = await fetchTradesDailySummary();
    const merged = summary ? { ...account, serverDailySummary: summary } : account;
    await saveAccountConfig(account.id, merged);
    return merged;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('TradeGuardX: refreshAccountConfig failed', err?.message || err);
    return null;
  }
}

export async function syncAccountBalanceState(accountId, updates) {
  if (!accountId || !updates || typeof updates !== 'object') return null;
  const body = {};
  if (updates.currentBalance !== undefined) body.currentBalance = updates.currentBalance;
  if (updates.dailyStartingBalance !== undefined) body.dailyStartingBalance = updates.dailyStartingBalance;
  if (updates.dailyStartingEquity !== undefined) body.dailyStartingEquity = updates.dailyStartingEquity;
  if (updates.lastDailyResetAt !== undefined) body.lastDailyResetAt = updates.lastDailyResetAt;
  if (Object.keys(body).length === 0) return null;

  try {
    const data = await authedFetch(getTradingAccountPatchUrl(accountId), {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    const account = data?.account;
    if (account?.id) await saveAccountConfig(account.id, account);
    return account || null;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('TradeGuardX: syncAccountBalanceState failed', err?.message || err);
    return null;
  }
}

export async function postReconcile(accountId, { declaredBalance, closedPnlToday, floatingPnl }) {
  if (!accountId) throw new Error('accountId required');
  const body = { declaredBalance };
  if (closedPnlToday !== undefined) body.closedPnlToday = closedPnlToday;
  if (floatingPnl !== undefined) body.floatingPnl = floatingPnl;

  const data = await authedFetch(getTradingAccountReconcileUrl(accountId), {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const account = data?.account;
  if (account?.id) await saveAccountConfig(account.id, account);
  return account || null;
}

/**
 * If a scheduled reset has passed since we last snapshotted, push a new daily baseline.
 * Caller supplies today's observed floating P&L at reset time (best-effort — may be stale
 * if the extension was offline across the reset instant; that's OK, the reconcile prompt
 * corrects for it).
 */
export async function maybeApplyDailyReset(accountId, floatingPnlAtReset, closedPnlToday) {
  const config = await getAccountConfig(accountId);
  if (!config || !hasResetPassed(config)) return null;

  const dailyStartingBalance =
    Number(config.currentBalance ?? config.dailyStartingBalance ?? 0) + Number(closedPnlToday || 0);
  const floating = Number.isFinite(floatingPnlAtReset) ? floatingPnlAtReset : 0;
  const dailyStartingEquity = dailyStartingBalance + floating;
  const resetInstant = lastResetInstant(config.timezone, config.dailyResetTimeLocal);

  return syncAccountBalanceState(accountId, {
    currentBalance: dailyStartingBalance,
    dailyStartingBalance,
    dailyStartingEquity,
    lastDailyResetAt: resetInstant ? new Date(resetInstant).toISOString() : new Date().toISOString(),
  });
}
