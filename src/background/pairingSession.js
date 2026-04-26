/* global chrome */

import { getPairingExchangeUrl, getPairingRefreshUrl } from '../config/api.js';

export const PAIRING_STORAGE_KEY = 'tradeGuardXPairingSession';
export const PAIRING_ALARM_NAME = 'tgx-pairing-refresh';

/** Refresh access token this many ms before expiry. */
const ACCESS_SKEW_MS = 60_000;

let refreshMutex = Promise.resolve();

function withRefreshLock(fn) {
  const run = refreshMutex.then(() => fn());
  refreshMutex = run.catch(() => {});
  return run;
}

function unwrapJsonPayload(json) {
  if (json && json.success && json.data != null) return json.data;
  return json;
}

async function storageGet(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (result) => {
      if (chrome.runtime.lastError) resolve(undefined);
      else resolve(result[key]);
    });
  });
}

async function storageSet(key, value) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, () => resolve());
  });
}

async function storageRemove(key) {
  return new Promise((resolve) => {
    chrome.storage.local.remove(key, () => resolve());
  });
}

/**
 * @returns {Promise<{
 *   accessToken: string,
 *   refreshToken: string,
 *   accessExpiresAtMs: number,
 *   tradingAccountId: string,
 *   userId: string,
 *   role: 'user' | 'admin',
 *   brokerHost: string | null,
 *   accountKind: 'live' | 'funded',
 *   mappingApproved: boolean,
 * } | null>}
 */
export async function loadPairingSession() {
  const raw = await storageGet(PAIRING_STORAGE_KEY);
  if (!raw || typeof raw !== 'object') return null;
  if (!raw.accessToken || !raw.refreshToken || !raw.tradingAccountId) return null;
  return raw;
}

function normalizeRole(value) {
  return value === 'admin' ? 'admin' : 'user';
}

function normalizeAccountKind(value) {
  return value === 'funded' ? 'funded' : 'live';
}

function normalizeBrokerHost(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed || null;
}

export async function savePairingSession(session) {
  await storageSet(PAIRING_STORAGE_KEY, session);
}

export async function clearPairingSession() {
  await storageRemove(PAIRING_STORAGE_KEY);
  try {
    await chrome.alarms.clear(PAIRING_ALARM_NAME);
  } catch (_e) {
    /* ignore */
  }
}

export function schedulePairingRefreshAlarm() {
  try {
    chrome.alarms.create(PAIRING_ALARM_NAME, { periodInMinutes: 4 });
  } catch (_e) {
    /* ignore */
  }
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch (_e) {
    json = null;
  }
  if (!res.ok) {
    const msg = json?.error?.message || json?.message || res.statusText || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

/**
 * Exchange one-time pairing code for tokens (from web app).
 * @param {string} code
 */
export async function exchangePairingCode(code) {
  const trimmed = String(code || '')
    .trim()
    .replace(/\s+/g, '');
  if (!trimmed) {
    throw new Error('Pairing code is required');
  }

  const json = await postJson(getPairingExchangeUrl(), { code: trimmed });
  const data = unwrapJsonPayload(json);
  if (!data?.accessToken || !data?.refreshToken) {
    throw new Error('Invalid pairing response');
  }

  const expiresInSec = Number(data.expiresIn) || 300;
  const accessExpiresAtMs = Date.now() + expiresInSec * 1000;

  const session = {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    accessExpiresAtMs,
    tradingAccountId: data.tradingAccountId,
    userId: data.userId,
    role: normalizeRole(data.role),
    brokerHost: normalizeBrokerHost(data.brokerHost),
    accountKind: normalizeAccountKind(data.accountKind),
    mappingApproved: Boolean(data.mappingApproved),
  };

  await savePairingSession(session);
  schedulePairingRefreshAlarm();
  return session;
}

async function refreshWithToken(refreshToken) {
  const json = await postJson(getPairingRefreshUrl(), { refreshToken });
  const data = unwrapJsonPayload(json);
  if (!data?.accessToken || !data?.refreshToken) {
    throw new Error('Invalid refresh response');
  }
  const expiresInSec = Number(data.expiresIn) || 300;
  const accessExpiresAtMs = Date.now() + expiresInSec * 1000;
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    accessExpiresAtMs,
    tradingAccountId: data.tradingAccountId,
    userId: data.userId,
    role: normalizeRole(data.role),
    brokerHost: normalizeBrokerHost(data.brokerHost),
    accountKind: normalizeAccountKind(data.accountKind),
    mappingApproved: Boolean(data.mappingApproved),
  };
}

/**
 * Rotate refresh token and persist new session.
 */
export async function refreshPairingSession() {
  const cur = await loadPairingSession();
  if (!cur?.refreshToken) {
    throw new Error('Not paired');
  }
  const next = await refreshWithToken(cur.refreshToken);
  const session = {
    ...next,
  };
  await savePairingSession(session);
  return session;
}

/**
 * Returns a valid access JWT, refreshing if needed. Null if not paired.
 */
export async function getValidAccessToken() {
  const s = await loadPairingSession();
  if (!s?.accessToken) return null;

  if (Date.now() < s.accessExpiresAtMs - ACCESS_SKEW_MS) {
    return s.accessToken;
  }

  return withRefreshLock(async () => {
    const cur = await loadPairingSession();
    if (!cur?.refreshToken) return null;
    if (Date.now() < cur.accessExpiresAtMs - ACCESS_SKEW_MS) {
      return cur.accessToken;
    }
    try {
      const next = await refreshWithToken(cur.refreshToken);
      await savePairingSession(next);
      return next.accessToken;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('TradeGuardX: pairing refresh failed', err);
      await clearPairingSession();
      return null;
    }
  });
}

export async function getPairingStateForPopup() {
  const s = await loadPairingSession();
  if (!s?.tradingAccountId) {
    return {
      connected: false,
      tradingAccountId: null,
      userId: null,
      accessExpiresAtMs: null,
      role: 'user',
      brokerHost: null,
      accountKind: 'live',
      mappingApproved: false,
    };
  }
  return {
    connected: true,
    tradingAccountId: s.tradingAccountId,
    userId: s.userId || null,
    accessExpiresAtMs: s.accessExpiresAtMs || null,
    role: normalizeRole(s.role),
    brokerHost: normalizeBrokerHost(s.brokerHost),
    accountKind: normalizeAccountKind(s.accountKind),
    mappingApproved: Boolean(s.mappingApproved),
  };
}
