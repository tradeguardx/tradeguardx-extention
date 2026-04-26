/* global chrome */

import { Storage } from '../storage/storage.js';
import { RulesEngine } from '../rules/rulesEngine.js';
import {
  getAiMapperUrl,
  getBrokerMappingUrl,
  getBrokerMappingsPostUrl,
  getJournalEventsPostUrl,
  getJournalMediaPostUrl,
  getRulesUrl,
  getTradesPostUrl
} from '../config/api.js';
import { rulesBundleToExtensionConfigPatch } from './rulesSync.js';
import {
  exchangePairingCode,
  clearPairingSession,
  getPairingStateForPopup,
  getValidAccessToken,
  refreshPairingSession,
  loadPairingSession,
  schedulePairingRefreshAlarm
} from './pairingSession.js';
import {
  refreshAccountConfig,
  postReconcile,
  maybeApplyDailyReset
} from './accountSync.js';
import {
  getAccountConfig,
  recordClosedTrade,
  sumClosedPnlSince,
  getEffectiveDailyCounters,
  clearAccountConfig
} from '../storage/fundedAccountStore.js';
import { lastResetInstant, needsReconcile } from './dailyReset.js';

const storage = new Storage();
const rulesEngine = new RulesEngine(storage);
const PENDING_MAPPING_KIND_KEY = 'tradeGuardXPendingMappingKind';

async function getPendingMappingKind() {
  return new Promise((resolve) => {
    chrome.storage.local.get(PENDING_MAPPING_KIND_KEY, (result) => {
      const v = result?.[PENDING_MAPPING_KIND_KEY];
      resolve(v === 'funded' || v === 'live' ? v : null);
    });
  });
}

async function setPendingMappingKind(kind) {
  const normalized = kind === 'funded' || kind === 'live' ? kind : null;
  return new Promise((resolve) => {
    if (!normalized) {
      chrome.storage.local.remove(PENDING_MAPPING_KIND_KEY, () => resolve());
    } else {
      chrome.storage.local.set({ [PENDING_MAPPING_KIND_KEY]: normalized }, () => resolve());
    }
  });
}

async function clearPendingMappingKind() {
  return new Promise((resolve) => {
    chrome.storage.local.remove(PENDING_MAPPING_KIND_KEY, () => resolve());
  });
}
const CONTENT_SCRIPT_FILES = [
  'src/vendor/sentry.bundle.min.js',
  'src/sentry/sentry-config.js',
  'src/content/hostGate.js',
  'src/sentry/sentry-init.js',
  'src/overlay/warningOverlay.js',
  'src/content/equityResolver.js',
  'src/content/universalDetector.js',
  'src/content/deep-mapper.js',
  'src/adapters/baseAdapter.js',
  'src/adapters/universalAdapter.js',
  'src/content/domScanner.js',
  'src/content/orderTableTracker.js',
  'src/content/tradeMonitor.js',
  'src/content/content.js'
];
const ACCOUNT_REFRESH_ALARM_NAME = 'tgx-account-refresh';
const JOURNAL_QUEUE_KEY = 'tradeGuardXJournalQueue';
const JOURNAL_MEDIA_QUEUE_KEY = 'tradeGuardXJournalMediaQueue';
const CLOSED_TRADES_QUEUE_KEY = 'tradeGuardXClosedTradesQueue';
const JOURNAL_FLUSH_ALARM_NAME = 'tgx-journal-flush';
const JOURNAL_MAX_QUEUE_ITEMS = 1000;
let _journalFlushInFlight = false;

chrome.runtime.onInstalled.addListener((details) => {
  storage.ensureDefaults();
  if (details.reason === 'install') {
    storage.clearState();
  }
  loadPairingSession().then((s) => {
    if (s?.refreshToken) {
      schedulePairingRefreshAlarm();
      refreshAccountConfig().catch(() => {});
    }
  });
  chrome.alarms.create(JOURNAL_FLUSH_ALARM_NAME, { periodInMinutes: 1 });
  chrome.alarms.create(ACCOUNT_REFRESH_ALARM_NAME, { periodInMinutes: 5 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'tgx-pairing-refresh') {
    refreshPairingSession().catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('TradeGuardX: scheduled pairing refresh failed', err?.message || err);
    });
    return;
  }
  if (alarm.name === JOURNAL_FLUSH_ALARM_NAME) {
    flushClosedTradesQueue().catch(() => {});
    flushJournalQueue().catch(() => {});
  }
  if (alarm.name === ACCOUNT_REFRESH_ALARM_NAME) {
    refreshAccountConfig().catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return undefined;

  switch (message.type) {
    case 'TG_EVALUATE_ACCOUNT':
      handleEvaluateAccount(message.payload, sendResponse);
      return true; // async
    case 'TG_POSITIONS_OPENED':
      handlePositionsOpened(message.payload, sendResponse);
      return true; // async
    case 'TG_POSITION_CLOSED_LOSS':
      handlePositionClosedLoss(sendResponse);
      return true; // async
    case 'TG_GET_POPUP_STATE':
      handleGetPopupState(sendResponse);
      return true; // async
    case 'TG_GET_CONFIG':
      handleGetConfig(sendResponse);
      return true; // async
    case 'TG_SAVE_CONFIG':
      handleSaveConfig(message.payload, sendResponse);
      return true; // async
    case 'TG_GET_SELECTORS':
      handleGetSelectors(message.payload, sendResponse);
      return true; // async
    case 'TG_SAVE_SELECTORS':
      handleSaveSelectors(message.payload, sendResponse);
      return true; // async
    case 'TG_UI_HOOKED':
      handleUiHooked(message.payload, sender, sendResponse);
      return true; // async
    case 'TG_CLEAR_STATE':
      handleClearState(sendResponse);
      return true; // async
    case 'TG_START_PLATFORM_MAPPING':
      handleStartPlatformMapping(sendResponse);
      return true; // async
    case 'MAP_FIELDS':
      handleMapFields(message.payload, sendResponse);
      return true; // async
    case 'TG_DEBUG_MAPPING_DIAGNOSTICS':
      handleDebugMappingDiagnostics(sendResponse);
      return true; // async
    case 'TG_PAIRING_EXCHANGE':
      handlePairingExchange(message.payload, sendResponse);
      return true;
    case 'TG_PAIRING_DISCONNECT':
      handlePairingDisconnect(sendResponse);
      return true;
    case 'TG_GET_PAIRING_STATE':
      handleGetPairingState(sendResponse);
      return true;
    case 'TG_SYNC_RULES_FROM_SERVER':
      handleSyncRulesFromServer(sendResponse);
      return true;
    case 'TG_SYNC_CLOSED_TRADE':
      handleSyncClosedTrade(message.payload, sendResponse);
      return true;
    case 'TG_SYNC_JOURNAL_EVENTS':
      handleSyncJournalEvents(message.payload, sendResponse);
      return true;
    case 'TG_CAPTURE_AND_SYNC_JOURNAL_MEDIA':
      handleCaptureAndSyncJournalMedia(message.payload, sender, sendResponse);
      return true;
    case 'TG_GET_ACCOUNT_CONFIG':
      handleGetAccountConfig(sendResponse);
      return true;
    case 'TG_RECONCILE_ACCOUNT':
      handleReconcileAccount(message.payload, sendResponse);
      return true;
    case 'TG_UPDATE_DECLARED_BALANCE':
      handleUpdateDeclaredBalance(message.payload, sendResponse);
      return true;
    case 'TG_REFRESH_ACCOUNT_CONFIG':
      handleRefreshAccountConfig(sendResponse);
      return true;
    case 'TG_MAYBE_APPLY_DAILY_RESET':
      handleMaybeApplyDailyReset(message.payload, sendResponse);
      return true;
    case 'TG_SET_PENDING_MAPPING_KIND':
      setPendingMappingKind(message.payload?.accountKind).then(() => sendResponse({ success: true }));
      return true;
    default:
      break;
  }

  return undefined;
});

async function handleEvaluateAccount(payload, sendResponse) {
  try {
    const { accountState, activeTrades } = payload || {};
    if (!accountState) {
      sendResponse(null);
      return;
    }
    const config = await storage.getConfig();
    const result = await rulesEngine.evaluateAccount(accountState);

    const sourceTrades = Array.isArray(activeTrades)
      ? activeTrades
      : (Array.isArray(accountState.positions) ? accountState.positions : []);
    await storage.updateState((current) => ({
      ...current,
      activeTrades: sourceTrades.map((t) => ({
        symbol: t.symbol,
        side: t.side,
        volume: t.volume ?? null,
        stopLoss: t.stopLoss ?? null,
        takeProfit: t.takeProfit ?? null,
        profit: t.profit ?? null,
        entryPrice: t.entryPrice ?? null,
        currentPrice: t.currentPrice ?? null
      }))
    }));

    sendResponse({ ...result, config });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Trade GuardX: account evaluation failed', err);
    sendResponse(null);
  }
}

async function handlePositionsOpened(payload, sendResponse) {
  try {
    const delta = Number(payload?.delta) || 1;
    await storage.incrementTradesOpenedTodayBy(delta);
    sendResponse({ success: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Trade GuardX: failed to increment trades opened', err);
    sendResponse({ success: false });
  }
}

async function handlePositionClosedLoss(sendResponse) {
  try {
    await storage.incrementSessionLossCount();
    sendResponse({ success: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Trade GuardX: failed to increment session loss count', err);
    sendResponse({ success: false });
  }
}

async function syncRulesFromServer() {
  try {
    const token = await getValidAccessToken();
    if (!token) {
      return { success: false, error: 'not_paired' };
    }
    const res = await fetch(getRulesUrl(), {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json'
      }
    });
    let json = null;
    try {
      json = await res.json();
    } catch (_e) {
      json = null;
    }
    if (!res.ok || !json?.success) {
      return {
        success: false,
        error: json?.error?.message || res.statusText || 'rules_fetch_failed'
      };
    }
    const bundle = json.data;
    await storage.setRulesBundleCache(bundle);
    const current = await storage.getConfig();
    const patch = rulesBundleToExtensionConfigPatch(bundle);
    await storage.setConfig({ ...current, ...patch });
    return { success: true, appliedKeys: Object.keys(patch) };
  } catch (err) {
    return { success: false, error: err?.message || 'sync_failed' };
  }
}

async function handleSyncRulesFromServer(sendResponse) {
  const out = await syncRulesFromServer();
  sendResponse(out);
}

async function handlePairingExchange(payload, sendResponse) {
  try {
    const code = payload?.code;
    await exchangePairingCode(code);
    // Wipe stale per-host metrics/positions/account state from any previous pairing
    // so the popup doesn't briefly render a nonsense Total P&L computed against
    // another account's dailyStartingBalance while fresh data is still syncing.
    await storage.clearState();
    await storage.clearRulesBundleCache();
    await _clearJournalQueues();
    const rulesSync = await syncRulesFromServer();
    // Notify all broker tabs so their TradeMonitor instances reload funded state
    // and config without requiring a page refresh.
    broadcastToAllTabs({ type: 'TG_PAIRING_CHANGED' });
    notifyPopup({ type: 'TG_PAIRING_CHANGED' });
    // Kick off account fetch in the background — when it completes, push a
    // TG_ACCOUNT_REFRESHED message so the popup re-renders without waiting
    // on its 2-second poll (which previously left the user looking at stale
    // defaults until a hard refresh).
    refreshAccountConfig()
      .then(() => {
        broadcastToAllTabs({ type: 'TG_ACCOUNT_REFRESHED' });
        notifyPopup({ type: 'TG_ACCOUNT_REFRESHED' });
      })
      .catch(() => {});
    sendResponse({ success: true, rulesSync });
  } catch (err) {
    sendResponse({ success: false, error: err?.message || 'Pairing failed' });
  }
}

/**
 * Send a runtime message that the popup (if open) will receive. Tabs receive
 * via broadcastToAllTabs; the popup itself listens on chrome.runtime.onMessage,
 * which is a separate channel.
 */
function notifyPopup(message) {
  try {
    chrome.runtime.sendMessage(message, () => {
      // Swallow lastError — popup may be closed; that's expected.
      void chrome.runtime?.lastError;
    });
  } catch (_) { /* noop */ }
}

function broadcastToAllTabs(message) {
  try {
    chrome.tabs.query({}, (tabs) => {
      if (chrome.runtime?.lastError) return;
      for (const tab of tabs || []) {
        if (!tab?.id) continue;
        try {
          chrome.tabs.sendMessage(tab.id, message, () => {
            // Swallow lastError — many tabs won't have the content script injected.
            void chrome.runtime?.lastError;
          });
        } catch (_) { /* noop */ }
      }
    });
  } catch (_) { /* noop */ }
}

async function handlePairingDisconnect(sendResponse) {
  try {
    const priorAccountId = await getActiveAccountId();
    await clearPairingSession();
    await storage.clearRulesBundleCache();
    await _clearJournalQueues();
    if (priorAccountId) await clearAccountConfig(priorAccountId);
    broadcastToAllTabs({ type: 'TG_PAIRING_CHANGED' });
    sendResponse({ success: true });
  } catch (_err) {
    sendResponse({ success: false });
  }
}

async function handleGetPairingState(sendResponse) {
  try {
    const state = await getPairingStateForPopup();
    sendResponse(state);
  } catch (_err) {
    sendResponse({ connected: false, tradingAccountId: null, userId: null, accessExpiresAtMs: null });
  }
}

function buildTradePayloadForApi(p) {
  const closedAtMs = Number(p.closedAt) || Date.now();
  const closedAt = new Date(closedAtMs).toISOString();
  const explicitOpenedAtMs = p.openedAt ? new Date(p.openedAt).getTime() : NaN;
  const openedAt = Number.isFinite(explicitOpenedAtMs)
    ? new Date(explicitOpenedAtMs).toISOString()
    : new Date(Math.max(0, closedAtMs - 300000)).toISOString(); // fallback 5m if unknown
  const sym = (p.symbol || 'unknown').toString();
  const side = (p.side || '').toString();
  const providedClientTradeId = typeof p.clientTradeId === 'string' ? p.clientTradeId.trim() : '';
  const clientTradeId = (providedClientTradeId || `tgx_${sym}_${side}_${p.entryPrice || 0}_${closedAtMs}`).slice(0, 200);
  const pnl = p.pnl != null && Number.isFinite(Number(p.pnl)) ? Number(p.pnl) : null;
  return {
    clientTradeId,
    symbol: p.symbol || null,
    side: p.side || null,
    quantity: p.volume ?? null,
    entryPrice: p.entryPrice ?? null,
    exitPrice: p.exitPrice ?? p.currentPrice ?? null,
    openedAt,
    closedAt,
    pnl,
    currency: p.currency || 'USD',
    raw: { source: 'extension' }
  };
}

async function _getJournalQueue() {
  return new Promise((resolve) => {
    chrome.storage.local.get([JOURNAL_QUEUE_KEY], (result) => {
      if (chrome.runtime?.lastError) {
        resolve([]);
        return;
      }
      const q = result?.[JOURNAL_QUEUE_KEY];
      resolve(Array.isArray(q) ? q : []);
    });
  });
}

async function _setJournalQueue(queue) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [JOURNAL_QUEUE_KEY]: Array.isArray(queue) ? queue : [] }, () => {
      resolve();
    });
  });
}

async function _getJournalMediaQueue() {
  return new Promise((resolve) => {
    chrome.storage.local.get([JOURNAL_MEDIA_QUEUE_KEY], (result) => {
      if (chrome.runtime?.lastError) {
        resolve([]);
        return;
      }
      const q = result?.[JOURNAL_MEDIA_QUEUE_KEY];
      resolve(Array.isArray(q) ? q : []);
    });
  });
}

async function _setJournalMediaQueue(queue) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [JOURNAL_MEDIA_QUEUE_KEY]: Array.isArray(queue) ? queue : [] }, () => {
      resolve();
    });
  });
}

async function _getClosedTradesQueue() {
  return new Promise((resolve) => {
    chrome.storage.local.get([CLOSED_TRADES_QUEUE_KEY], (result) => {
      if (chrome.runtime?.lastError) {
        resolve([]);
        return;
      }
      const q = result?.[CLOSED_TRADES_QUEUE_KEY];
      resolve(Array.isArray(q) ? q : []);
    });
  });
}

async function _setClosedTradesQueue(queue) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [CLOSED_TRADES_QUEUE_KEY]: Array.isArray(queue) ? queue : [] }, () => {
      resolve();
    });
  });
}

async function _enqueueClosedTradePayload(trade) {
  if (!trade || typeof trade !== 'object') return { queued: false };
  const row = buildTradePayloadForApi(trade);
  if (!row?.clientTradeId || !row?.symbol || !row?.side || !row?.openedAt || !row?.closedAt) {
    return { queued: false };
  }
  const queue = await _getClosedTradesQueue();
  queue.push({
    queuedAt: Date.now(),
    row
  });
  if (queue.length > JOURNAL_MAX_QUEUE_ITEMS) {
    queue.splice(0, queue.length - JOURNAL_MAX_QUEUE_ITEMS);
  }
  await _setClosedTradesQueue(queue);
  chrome.alarms.create(JOURNAL_FLUSH_ALARM_NAME, { periodInMinutes: 1 });
  return { queued: true, size: queue.length };
}

async function flushClosedTradesQueue() {
  const token = await getValidAccessToken();
  if (!token) return { success: true, skipped: 'not_paired' };
  const queue = await _getClosedTradesQueue();
  if (!Array.isArray(queue) || queue.length === 0) return { success: true, flushed: 0 };
  let flushed = 0;
  while (queue.length > 0) {
    const item = queue[0];
    const row = item?.row;
    if (!row) {
      queue.shift();
      continue;
    }
    let res = null;
    try {
      res = await fetch(getTradesPostUrl(), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json'
        },
        body: JSON.stringify({ trades: [row] })
      });
    } catch (_err) {
      break;
    }
    if (res && res.ok) {
      queue.shift();
      flushed += 1;
      continue;
    }
    if (res && [400, 401, 403, 404, 409, 422].includes(res.status)) {
      queue.shift();
      continue;
    }
    break;
  }
  await _setClosedTradesQueue(queue);
  return { success: true, flushed, pending: queue.length };
}

function _normalizeJournalPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const tradeUid = typeof payload.tradeUid === 'string' ? payload.tradeUid.trim() : '';
  const events = Array.isArray(payload.events) ? payload.events : [];
  if (!tradeUid || events.length === 0) return null;
  return {
    tradeUid,
    clientTradeId: typeof payload.clientTradeId === 'string' ? payload.clientTradeId : null,
    symbol: typeof payload.symbol === 'string' ? payload.symbol : null,
    side: typeof payload.side === 'string' ? payload.side : null,
    currency: typeof payload.currency === 'string' ? payload.currency : 'USD',
    source: typeof payload.source === 'string' ? payload.source : 'extension',
    captureQuality: typeof payload.captureQuality === 'string' ? payload.captureQuality : 'full',
    metadata:
      payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
        ? payload.metadata
        : {},
    events: events
      .map((e) => ({
        eventType: String(e?.eventType || '').trim().toUpperCase(),
        eventAt: String(e?.eventAt || '').trim(),
        sequence: Number.isFinite(Number(e?.sequence)) ? Number(e.sequence) : 0,
        idempotencyKey: typeof e?.idempotencyKey === 'string' ? e.idempotencyKey : null,
        quantity: e?.quantity ?? null,
        entryPrice: e?.entryPrice ?? null,
        currentPrice: e?.currentPrice ?? null,
        exitPrice: e?.exitPrice ?? null,
        pnl: e?.pnl ?? null,
        slBefore: e?.slBefore ?? null,
        slAfter: e?.slAfter ?? null,
        tpBefore: e?.tpBefore ?? null,
        tpAfter: e?.tpAfter ?? null,
        payload:
          e?.payload && typeof e.payload === 'object' && !Array.isArray(e.payload)
            ? e.payload
            : {}
      }))
      .filter((e) => e.eventType && e.eventAt)
  };
}

async function _enqueueJournalPayload(payload) {
  const normalized = _normalizeJournalPayload(payload);
  if (!normalized) return { queued: false };
  const queue = await _getJournalQueue();
  queue.push({
    queuedAt: Date.now(),
    payload: normalized
  });
  if (queue.length > JOURNAL_MAX_QUEUE_ITEMS) {
    queue.splice(0, queue.length - JOURNAL_MAX_QUEUE_ITEMS);
  }
  await _setJournalQueue(queue);
  chrome.alarms.create(JOURNAL_FLUSH_ALARM_NAME, { periodInMinutes: 1 });
  return { queued: true, size: queue.length };
}

function _normalizeJournalMediaPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const tradeUid = typeof payload.tradeUid === 'string' ? payload.tradeUid.trim() : '';
  const eventType = typeof payload.eventType === 'string' ? payload.eventType.trim().toUpperCase() : '';
  const capturedAt = typeof payload.capturedAt === 'string' ? payload.capturedAt.trim() : new Date().toISOString();
  const imageDataUrl = typeof payload.imageDataUrl === 'string' ? payload.imageDataUrl : '';
  if (!tradeUid || !eventType || !imageDataUrl.startsWith('data:image/')) return null;
  return {
    tradeUid,
    eventType,
    capturedAt,
    source: 'extension',
    width: Number.isFinite(Number(payload.width)) ? Number(payload.width) : null,
    height: Number.isFinite(Number(payload.height)) ? Number(payload.height) : null,
    imageDataUrl
  };
}

async function _enqueueJournalMediaPayload(payload) {
  const normalized = _normalizeJournalMediaPayload(payload);
  if (!normalized) return { queued: false };
  const queue = await _getJournalMediaQueue();
  queue.push({
    queuedAt: Date.now(),
    payload: normalized
  });
  if (queue.length > JOURNAL_MAX_QUEUE_ITEMS) {
    queue.splice(0, queue.length - JOURNAL_MAX_QUEUE_ITEMS);
  }
  await _setJournalMediaQueue(queue);
  return { queued: true, size: queue.length };
}

async function flushJournalQueue() {
  if (_journalFlushInFlight) return { success: true, skipped: 'in_flight' };
  _journalFlushInFlight = true;
  try {
    const token = await getValidAccessToken();
    if (!token) return { success: true, skipped: 'not_paired' };
    const queue = await _getJournalQueue();
    if (!Array.isArray(queue) || queue.length === 0) return { success: true, flushed: 0 };
    let flushed = 0;
    while (queue.length > 0) {
      const item = queue[0];
      const body = item?.payload;
      if (!body || !body.tradeUid || !Array.isArray(body.events) || body.events.length === 0) {
        queue.shift();
        continue;
      }
      let res = null;
      try {
        res = await fetch(getJournalEventsPostUrl(), {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            accept: 'application/json'
          },
          body: JSON.stringify(body)
        });
      } catch (_err) {
        break;
      }
      if (res && res.ok) {
        queue.shift();
        flushed += 1;
        continue;
      }
      // Drop hard validation/auth errors to avoid infinite poison queue.
      if (res && [400, 401, 403, 404, 409, 422].includes(res.status)) {
        queue.shift();
        continue;
      }
      // Transient/server errors -> keep and retry later.
      break;
    }
    await _setJournalQueue(queue);
    await flushJournalMediaQueue();
    return { success: true, flushed, pending: queue.length };
  } finally {
    _journalFlushInFlight = false;
  }
}

async function flushJournalMediaQueue() {
  const token = await getValidAccessToken();
  if (!token) return { success: true, skipped: 'not_paired' };
  const queue = await _getJournalMediaQueue();
  if (!Array.isArray(queue) || queue.length === 0) return { success: true, flushed: 0 };
  let flushed = 0;
  while (queue.length > 0) {
    const item = queue[0];
    const body = item?.payload;
    if (!body || !body.tradeUid || !body.imageDataUrl) {
      queue.shift();
      continue;
    }
    let res = null;
    try {
      res = await fetch(getJournalMediaPostUrl(), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json'
        },
        body: JSON.stringify(body)
      });
    } catch (_err) {
      break;
    }
    if (res && res.ok) {
      queue.shift();
      flushed += 1;
      continue;
    }
    if (res && [400, 401, 403, 404, 409, 413, 422].includes(res.status)) {
      queue.shift();
      continue;
    }
    break;
  }
  await _setJournalMediaQueue(queue);
  return { success: true, flushed, pending: queue.length };
}

async function handleSyncJournalEvents(payload, sendResponse) {
  try {
    const enq = await _enqueueJournalPayload(payload);
    if (!enq.queued) {
      sendResponse({ success: false, error: 'invalid_payload' });
      return;
    }
    const shouldForce = payload?.force === true;
    if (shouldForce) {
      const out = await flushJournalQueue();
      sendResponse({ success: true, queued: enq.size || 0, flush: out });
      return;
    }
    flushJournalQueue().catch(() => {});
    sendResponse({ success: true, queued: enq.size || 0 });
  } catch (err) {
    sendResponse({ success: false, error: err?.message || 'journal_sync_failed' });
  }
}

async function handleCaptureAndSyncJournalMedia(payload, sender, sendResponse) {
  try {
    const tabWindowId = sender?.tab?.windowId;
    let imageDataUrl = null;
    if (Number.isFinite(Number(tabWindowId))) {
      imageDataUrl = await chrome.tabs.captureVisibleTab(Number(tabWindowId), {
        format: 'jpeg',
        quality: 55
      });
    } else {
      imageDataUrl = await chrome.tabs.captureVisibleTab(undefined, {
        format: 'jpeg',
        quality: 55
      });
    }
    const withImage = {
      ...(payload || {}),
      imageDataUrl
    };
    const enq = await _enqueueJournalMediaPayload(withImage);
    if (!enq.queued) {
      sendResponse({ success: false, error: 'invalid_payload' });
      return;
    }
    flushJournalMediaQueue().catch(() => {});
    sendResponse({ success: true, queued: enq.size || 0 });
  } catch (err) {
    sendResponse({ success: false, error: err?.message || 'capture_failed' });
  }
}

async function handleSyncClosedTrade(payload, sendResponse) {
  try {
    const trade = payload?.trade;
    const enq = await _enqueueClosedTradePayload(trade);
    if (!enq.queued) {
      sendResponse({ success: false, error: 'missing_trade' });
      return;
    }
    // Mirror into per-account funded store so today's realized P&L is computable
    // without round-tripping the backend.
    try {
      const cached = await getActiveAccountId();
      if (cached) {
        const closedAtMs = trade?.closedAt ? Number(trade.closedAt) : Date.now();
        await recordClosedTrade(cached, {
          clientTradeId: trade?.clientTradeId,
          symbol: trade?.symbol,
          side: trade?.side,
          pnl: Number(trade?.pnl),
          closedAt: Number.isFinite(closedAtMs) ? closedAtMs : Date.now()
        });
      }
    } catch (_e) { /* ignore local mirror errors */ }
    const out = await flushClosedTradesQueue();
    sendResponse({ success: true, queued: enq.size || 0, flush: out });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('TradeGuardX: sync closed trade failed', err);
    sendResponse({ success: false, error: err?.message || 'sync_failed' });
  }
}

async function getActiveAccountId() {
  const state = await getPairingStateForPopup().catch(() => null);
  return state?.tradingAccountId || null;
}

async function handleGetAccountConfig(sendResponse) {
  try {
    const accountId = await getActiveAccountId();
    if (!accountId) {
      sendResponse({
        success: true,
        account: null,
        accountId: null,
        closedPnlToday: 0,
        closedTradesToday: 0,
        dailyWindowStartMs: null
      });
      return;
    }
    const account = await getAccountConfig(accountId);
    let closedPnlToday = 0;
    let closedTradesToday = 0;
    let dailyWindowStartMs = null;
    if (account && account.equityMode === 'funded' && account.timezone && account.dailyResetTimeLocal) {
      const since = lastResetInstant(account.timezone, account.dailyResetTimeLocal);
      if (Number.isFinite(since)) {
        dailyWindowStartMs = since;
        // Stricter-wins merge of server seed + local ring buffer.
        const counters = await getEffectiveDailyCounters(accountId, since);
        closedPnlToday = Number(counters?.closedPnlToday) || 0;
        closedTradesToday = Number(counters?.closedTradesToday) || 0;
      }
    }
    sendResponse({
      success: true,
      accountId,
      account: account || null,
      closedPnlToday,
      closedTradesToday,
      dailyWindowStartMs,
      needsReconcile: account ? needsReconcile(account) : false
    });
  } catch (err) {
    sendResponse({ success: false, error: err?.message || 'get_account_config_failed' });
  }
}

async function handleUpdateDeclaredBalance(payload, sendResponse) {
  try {
    const accountId = await getActiveAccountId();
    if (!accountId) {
      sendResponse({ success: false, error: 'not_paired' });
      return;
    }
    const newBalance = Number(payload?.balance);
    if (!Number.isFinite(newBalance) || newBalance <= 0) {
      sendResponse({ success: false, error: 'invalid_balance' });
      return;
    }
    // Route through the same reconcile endpoint the web dashboard uses so there's
    // one canonical balance-update path: server derives daily baselines, creates
    // an audit entry, and bumps lastReconciledAt (which the dashboard displays).
    const account = await postReconcile(accountId, { declaredBalance: newBalance });
    sendResponse({ success: true, account: account || null });
  } catch (err) {
    sendResponse({ success: false, error: err?.message || 'update_balance_failed' });
  }
}

async function handleReconcileAccount(payload, sendResponse) {
  try {
    const accountId = await getActiveAccountId();
    if (!accountId) {
      sendResponse({ success: false, error: 'not_paired' });
      return;
    }
    const declaredBalance = Number(payload?.declaredBalance);
    if (!Number.isFinite(declaredBalance) || declaredBalance <= 0) {
      sendResponse({ success: false, error: 'invalid_balance' });
      return;
    }
    const account = await postReconcile(accountId, {
      declaredBalance,
      closedPnlToday: Number.isFinite(Number(payload?.closedPnlToday)) ? Number(payload.closedPnlToday) : undefined,
      floatingPnl: Number.isFinite(Number(payload?.floatingPnl)) ? Number(payload.floatingPnl) : undefined
    });
    sendResponse({ success: true, account });
  } catch (err) {
    sendResponse({ success: false, error: err?.message || 'reconcile_failed' });
  }
}

async function handleRefreshAccountConfig(sendResponse) {
  try {
    const account = await refreshAccountConfig();
    sendResponse({ success: true, account });
  } catch (err) {
    sendResponse({ success: false, error: err?.message || 'refresh_failed' });
  }
}

async function handleMaybeApplyDailyReset(payload, sendResponse) {
  try {
    const accountId = await getActiveAccountId();
    if (!accountId) {
      sendResponse({ success: false, error: 'not_paired' });
      return;
    }
    const floatingPnl = Number(payload?.floatingPnl);
    const closedPnlToday = Number(payload?.closedPnlToday);
    const account = await maybeApplyDailyReset(
      accountId,
      Number.isFinite(floatingPnl) ? floatingPnl : 0,
      Number.isFinite(closedPnlToday) ? closedPnlToday : 0
    );
    sendResponse({ success: true, account });
  } catch (err) {
    sendResponse({ success: false, error: err?.message || 'reset_failed' });
  }
}

async function handleGetPopupState(sendResponse) {
  try {
    const popupState = await rulesEngine.getPopupState();
    sendResponse(popupState);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Trade GuardX: failed to get popup state', err);
    sendResponse(null);
  }
}

async function handleGetConfig(sendResponse) {
  try {
    const config = await storage.getConfig();
    sendResponse(config);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Trade GuardX: failed to get config', err);
    sendResponse(null);
  }
}

async function handleSaveConfig(payload, sendResponse) {
  try {
    if (!payload || typeof payload !== 'object') {
      sendResponse({ success: false });
      return;
    }
    await storage.setConfig(payload);
    sendResponse({ success: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Trade GuardX: failed to update config', err);
    sendResponse({ success: false });
  }
}

// Hosts that are clearly not broker trading pages — skip backend lookup for these.
const NON_BROKER_HOST_PATTERNS = [
  /^(www\.)?(google|bing|yahoo|duckduckgo|baidu)\./,
  /^(www\.)?(youtube|twitter|x\.com|reddit|facebook|instagram|linkedin|tiktok)\./,
  /^(www\.)?(github|gitlab|stackoverflow|medium|dev\.to|hashnode)\./,
  /^(www\.)?(amazon|ebay|flipkart|shopify|etsy)\./,
  /^(www\.)?(wikipedia|wikimedia)\./,
  /^(mail|outlook|gmail)\./,
  /^localhost$/,
  /^127\.0\.0\.1$/,
  /^(www\.)?cursor\./,
];

function isLikelyBrokerHost(host) {
  if (!host || typeof host !== 'string') return false;
  if (NON_BROKER_HOST_PATTERNS.some((p) => p.test(host))) return false;
  // Must look like a real domain (has a dot, not a plain local name)
  return host.includes('.');
}

async function handleGetSelectors(payload, sendResponse) {
  try {
    const host = payload?.host;
    if (!host) {
      sendResponse(null);
      return;
    }
    const all = await storage.getSelectors();
    if (all[host]) {
      sendResponse(all[host]);
      return;
    }

    // Only call backend if host looks like a broker/trading page.
    if (!isLikelyBrokerHost(host)) {
      sendResponse(null);
      return;
    }

    // Gate the backend lookup on pairing + host-lock. If the user isn't paired,
    // or is browsing a host other than the one their trading account is bound
    // to, there's no need to hit the backend — we already know the answer.
    const session = await loadPairingSession();
    if (!session?.accessToken) {
      sendResponse(null);
      return;
    }
    const boundHost = (session.brokerHost || '').toLowerCase();
    if (!boundHost || boundHost !== host.toLowerCase()) {
      sendResponse(null);
      return;
    }

    const accessToken = await getValidAccessToken();
    if (!accessToken) {
      sendResponse(null);
      return;
    }

    // No local mapping for this host; try backend broker-mappings/{brokerId}
    try {
      const res = await fetch(getBrokerMappingUrl(host), {
        method: 'GET',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
      });
      if (res.ok) {
        const data = await res.json();
        const mapping = data?.data?.mapping;
        if (data?.success && mapping && typeof mapping === 'object') {
          // Always stamp mapping_complete so the content script starts
          // monitoring immediately without requiring a re-map.
          const stamped = Object.prototype.hasOwnProperty.call(mapping, 'mapping_complete')
            ? mapping
            : { ...mapping, mapping_complete: true };
          await storage.updateSelectorsForHost(host, stamped);
          sendResponse(stamped);
          return;
        }
      }
    } catch (_err) {
      // backend unavailable or mapping not found; fall through and return null
    }

    sendResponse(null);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Trade GuardX: failed to get selectors', err);
    sendResponse(null);
  }
}

async function handleSaveSelectors(payload, sendResponse) {
  try {
    const { host, selectors, accountKind: explicitAccountKind } = payload || {};
    if (!host || !selectors) {
      sendResponse({ success: false });
      return;
    }
    // Always keep the local selector cache fresh so the active tab can use
    // refinements immediately regardless of who is paired.
    await storage.updateSelectorsForHost(host, selectors);

    // Only admins push mappings to the backend. For everyone else the local
    // save is authoritative for their own session — the server won't accept
    // writes without an admin JWT anyway (Phase 3 server-side gate).
    const session = await loadPairingSession();
    if (!session?.accessToken || session.role !== 'admin') {
      sendResponse({ success: true, synced: false });
      return;
    }

    const pendingKind = await getPendingMappingKind();
    const accountKind =
      explicitAccountKind === 'funded' || explicitAccountKind === 'live'
        ? explicitAccountKind
        : pendingKind ||
          (session.accountKind === 'funded' ? 'funded' : 'live');

    const accessToken = await getValidAccessToken();
    if (!accessToken) {
      sendResponse({ success: true, synced: false, error: 'Session expired' });
      return;
    }

    try {
      const res = await fetch(getBrokerMappingsPostUrl(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          brokerId: host,
          accountKind,
          mapping: selectors,
        }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        sendResponse({
          success: true,
          synced: false,
          error: `Backend rejected save: ${res.status} ${errText?.slice(0, 240) || ''}`.trim(),
        });
        return;
      }
    } catch (err) {
      sendResponse({ success: true, synced: false, error: err?.message || 'Network error' });
      return;
    }

    // Server accepted the save; clear the one-shot accountKind override so
    // subsequent saves fall back to the session-bound kind.
    await clearPendingMappingKind();

    sendResponse({ success: true, synced: true, accountKind });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Trade GuardX: failed to save selectors', err);
    sendResponse({ success: false });
  }
}

async function handleClearState(sendResponse) {
  try {
    await storage.clearState();
    await _clearJournalQueues();
    sendResponse({ success: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Trade GuardX: failed to clear state', err);
    sendResponse({ success: false });
  }
}

async function _clearJournalQueues() {
  await _setJournalQueue([]);
  await _setJournalMediaQueue([]);
  await _setClosedTradesQueue([]);
}

async function handleUiHooked(payload, sender, sendResponse) {
  try {
    const { host, url, at } = payload || {};
    if (!host) {
      sendResponse?.({ success: false });
      return;
    }

    await storage.updateState((current) => ({
      ...current,
      lastHooked: {
        host,
        url: url || sender?.tab?.url || null,
        at: at || Date.now()
      }
    }));

    sendResponse?.({ success: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Trade GuardX: failed to record UI hook info', err);
    sendResponse?.({ success: false });
  }
}

async function handleStartPlatformMapping(sendResponse) {
  try {
    // Mapping is admin-only — even if the popup UI is bypassed, refuse here.
    const session = await loadPairingSession();
    if (!session || session.role !== 'admin') {
      sendResponse?.({ success: false, error: 'Mapping requires an admin role' });
      return;
    }
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs && tabs[0];
    if (!activeTab?.id) {
      sendResponse?.({ success: false, error: 'No active tab found' });
      return;
    }
    await chrome.tabs.update(activeTab.id, { active: true });
    const sendStart = () =>
      new Promise((resolve) => {
        // frameId: 0 ensures only the top frame's listener fires — without it, every frame
        // with a TradeMonitor listener (post-allFrames injection) starts its own overlay.
        chrome.tabs.sendMessage(
          activeTab.id,
          { type: 'TG_START_PLATFORM_MAPPING' },
          { frameId: 0 },
          (response) => {
            if (chrome.runtime?.lastError) {
              resolve({ success: false, error: chrome.runtime.lastError.message || 'Unable to start mapping' });
              return;
            }
            resolve(response && typeof response === 'object' ? response : { success: true });
          }
        );
      });

    // Probe all frames for terminal-likeness and pick the single best one to host the
    // mapping overlay. Starting in every frame used to fan out duplicate overlays on
    // broker pages whose charts live in iframes (e.g., Exness, TradingView-embedded UIs).
    const startInBestFrame = async () => {
      try {
        const probes = await chrome.scripting.executeScript({
          target: { tabId: activeTab.id, allFrames: true },
          func: () => {
            const hasMonitor = !!window.__tradeGuardXMonitor;
            const hasMonitorClass = typeof window.TradeMonitor === 'function';
            let tradeTermHits = 0;
            try {
              const els = document.querySelectorAll('button, [role="button"]');
              for (const el of els) {
                const t = (el.innerText || el.textContent || '').trim().toLowerCase();
                if (!t || t.length > 40) continue;
                if (/\b(buy|sell|long|short|place order|execute)\b/.test(t)) tradeTermHits++;
              }
            } catch (_err) {}
            return {
              hasMonitor,
              hasMonitorClass,
              tradeTermHits,
              href: window.location.href,
              area: (document.body?.scrollWidth || 0) * (document.body?.scrollHeight || 0)
            };
          }
        });

        const candidates = (probes || []).filter((p) => p?.result);
        if (!candidates.length) return { success: false, error: 'No reachable frame' };

        const eligible = candidates.filter(
          (p) => p.result.hasMonitor || p.result.hasMonitorClass
        );
        const pool = eligible.length ? eligible : candidates;
        pool.sort((a, b) => {
          const hit = (b.result.tradeTermHits || 0) - (a.result.tradeTermHits || 0);
          if (hit !== 0) return hit;
          return (b.result.area || 0) - (a.result.area || 0);
        });
        const best = pool[0];

        const started = await chrome.scripting.executeScript({
          target: { tabId: activeTab.id, frameIds: [best.frameId] },
          func: async () => {
            try {
              let monitor = window.__tradeGuardXMonitor || null;
              if (!monitor && typeof window.TradeMonitor === 'function') {
                monitor = new window.TradeMonitor();
                window.__tradeGuardXMonitor = monitor;
                if (typeof monitor.init === 'function') await monitor.init();
              }
              if (!monitor || typeof monitor.startGuidedPlatformMapping !== 'function') {
                return { started: false, reason: 'monitor_missing' };
              }
              await monitor.startGuidedPlatformMapping();
              const active = typeof monitor._isMappingActive === 'function'
                ? monitor._isMappingActive()
                : true;
              return { started: !!active, reason: active ? 'ok' : 'overlay_not_active' };
            } catch (err) {
              return { started: false, reason: err?.message || 'start_failed' };
            }
          }
        });

        const r = started?.[0]?.result;
        if (r?.started) return { success: true };
        return { success: false, error: r?.reason || 'Unable to start mapping in selected frame' };
      } catch (err) {
        return { success: false, error: err?.message || 'Frame mapping start failed' };
      }
    };

    let result = await sendStart();
    if (!result?.success) {
      // Some SPA/terminal pages miss auto-injection; inject scripts then retry once.
      try {
        await chrome.scripting.executeScript({
          target: { tabId: activeTab.id, allFrames: true },
          files: CONTENT_SCRIPT_FILES
        });
        result = await sendStart();
        if (!result?.success) {
          // Exness-like web terminals host the app in nested frames — probe and pick one.
          result = await startInBestFrame();
        }
      } catch (injectErr) {
        sendResponse?.({
          success: false,
          error: injectErr?.message || result?.error || 'Unable to start mapping'
        });
        return;
      }
    } else if (!result?.success) {
      result = await startInBestFrame();
    }
    sendResponse?.(result?.success ? result : { success: false, error: result?.error || 'Unable to start mapping' });
  } catch (err) {
    sendResponse?.({ success: false, error: err?.message || 'Failed to start mapping' });
  }
}

async function handleMapFields(payload, sendResponse) {
  try {
    const prompt = typeof payload?.prompt === 'string' ? payload.prompt : '';
    if (!prompt.trim()) {
      sendResponse?.({ success: false, error: 'Missing prompt' });
      return;
    }

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs && tabs[0];
    const url = activeTab?.url || '';
    let brokerId = '';
    try {
      if (url) {
        const parsed = new URL(url);
        brokerId = parsed.hostname || '';
      }
    } catch (_err) {
      brokerId = '';
    }

    // First try to fetch a cached mapping for this broker from backend.
    let cachedMapping = null;
    if (brokerId) {
      try {
        const cachedRes = await fetch(getBrokerMappingUrl(brokerId), {
          method: 'GET',
          headers: { 'content-type': 'application/json' }
        });
        if (cachedRes.ok) {
          const cachedData = await cachedRes.json();
          if (cachedData?.success && cachedData?.data?.mapping) {
            cachedMapping = cachedData.data.mapping;
          }
        }
      } catch (_err) {
        // Ignore cache fetch errors; we'll fall back to live AI.
      }
    }

    if (cachedMapping) {
      sendResponse?.({ success: true, mapping: cachedMapping });
      return;
    }

    // No cached mapping found; fall back to live AI mapper (admin-gated server-side).
    const accessToken = await getValidAccessToken();
    if (!accessToken) {
      sendResponse?.({ success: false, error: 'Not paired — re-pair the extension to run AI mapping' });
      return;
    }

    const response = await fetch(getAiMapperUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        brokerId: brokerId || 'unknown',
        prompt
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      sendResponse?.({
        success: false,
        error: `aiMapper API error: ${response.status} ${errText?.slice(0, 240) || ''}`.trim()
      });
      return;
    }

    const data = await response.json();
    const mapping = data?.data?.mapping || {};

    sendResponse?.({ success: true, mapping });
  } catch (err) {
    sendResponse?.({ success: false, error: err?.message || 'MAP_FIELDS failed' });
  }
}

async function handleDebugMappingDiagnostics(sendResponse) {
  try {
    // Diagnostics fires TG_START_PLATFORM_MAPPING under the hood, so it is
    // admin-only — same gate as handleStartPlatformMapping.
    const session = await loadPairingSession();
    if (!session || session.role !== 'admin') {
      sendResponse?.({ success: false, error: 'Diagnostics requires an admin role' });
      return;
    }
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs && tabs[0];
    if (!activeTab?.id) {
      sendResponse?.({ success: false, error: 'No active tab found' });
      return;
    }

    const directMessage = await new Promise((resolve) => {
      chrome.tabs.sendMessage(
        activeTab.id,
        { type: 'TG_START_PLATFORM_MAPPING' },
        { frameId: 0 },
        (response) => {
          if (chrome.runtime?.lastError) {
            resolve({
              ok: false,
              error: chrome.runtime.lastError.message || 'sendMessage failed'
            });
            return;
          }
          resolve({ ok: true, response });
        }
      );
    });

    const frameProbe = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id, allFrames: true },
      func: () => {
        const monitor = window.__tradeGuardXMonitor || null;
        const overlay =
          document.getElementById('tg-guided-mapper') ||
          document.getElementById('tg-mapper-bar');
        return {
          href: window.location.href,
          host: window.location.hostname,
          readyState: document.readyState,
          frameType: window.top === window.self ? 'top' : 'child',
          hasTradeMonitorClass: typeof window.TradeMonitor === 'function',
          hasMonitorInstance: !!monitor,
          hasDetector: !!(monitor && monitor.detector),
          hasOverlay: !!overlay,
          mappingSessionActive:
            !!(monitor && typeof monitor._isMappingActive === 'function' && monitor._isMappingActive()),
          requiresMapping: !!(monitor && monitor._requiresMapping === true),
          mappedMode: !!(monitor && typeof monitor._isMappedCrawlMode === 'function' && monitor._isMappedCrawlMode())
        };
      }
    });

    sendResponse?.({
      success: true,
      diagnostics: {
        tab: {
          id: activeTab.id,
          url: activeTab.url || null,
          title: activeTab.title || null
        },
        directMessage,
        frames: frameProbe.map((x) => ({
          frameId: x.frameId,
          ...x.result
        }))
      }
    });
  } catch (err) {
    sendResponse?.({ success: false, error: err?.message || 'Diagnostics failed' });
  }
}

