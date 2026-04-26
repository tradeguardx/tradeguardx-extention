/* global TradeMonitor, chrome */

let initialized = false;
/** @type {TradeMonitor|null} */
let monitorInstance = null;

/**
 * Fresh, non-cached read of the paired-host check directly from chrome.storage.
 * Used after TG_PAIRING_CHANGED arrives — the cached __TG_HOST_GATE__ Promise
 * resolved before pairing happened, so we can't trust it for re-init decisions.
 */
async function isPairedHostFresh() {
  return new Promise((resolve) => {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        resolve(false);
        return;
      }
      chrome.storage.local.get('tradeGuardXPairingSession', (result) => {
        if (chrome.runtime?.lastError) { resolve(false); return; }
        const session = result && result.tradeGuardXPairingSession;
        if (!session || !session.accessToken || !session.brokerHost) { resolve(false); return; }
        const cur = String(window.location?.hostname || '').toLowerCase().trim();
        const broker = String(session.brokerHost).toLowerCase().trim();
        if (!cur || !broker) { resolve(false); return; }
        resolve(cur === broker || cur.endsWith('.' + broker));
      });
    } catch (_e) { resolve(false); }
  });
}

async function ensureMonitorReady() {
  if (monitorInstance) return monitorInstance;
  // Don't spin up a TradeMonitor on non-paired hosts even if a message
  // arrives (e.g. popup sends TG_START_PLATFORM_MAPPING) — the user must
  // be on the broker their account is paired to. Fresh read (not cached
  // gate) so a freshly-paired tab works without a reload.
  const allowed = await isPairedHostFresh();
  if (!allowed) return null;
  try {
    const monitor = new TradeMonitor();
    monitorInstance = monitor;
    window.__tradeGuardXMonitor = monitor;
    await monitor.init();
    return monitor;
  } catch (_err) {
    return null;
  }
}

// React to pairing changes broadcast from the background. Without this,
// content scripts that loaded BEFORE pairing have a cached host-gate of
// `false` and would never construct TradeMonitor — forcing the user to
// reload the broker tab. On TG_PAIRING_CHANGED we re-check storage fresh
// and lazily init TradeMonitor if the gate now passes.
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'TG_PAIRING_CHANGED') return undefined;
    (async () => {
      // eslint-disable-next-line no-console
      console.log('[TradeGuardX] TG_PAIRING_CHANGED received on', window.location.hostname, '— monitorInstance=', !!monitorInstance);
      if (monitorInstance) return; // already up; existing handler in tradeMonitor.js does the live refresh
      const allowed = await isPairedHostFresh();
      // eslint-disable-next-line no-console
      console.log('[TradeGuardX] post-pair host gate:', allowed ? 'PASS' : 'FAIL', '— constructing monitor:', allowed);
      if (!allowed) return;
      // Re-arm init() — it short-circuits on `initialized` so we reset that flag.
      initialized = false;
      try { await init(); } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[TradeGuardX] post-pair init failed', e);
      }
    })();
    return undefined;
  });
}

// Handle Map platform from popup as soon as script runs; use monitorInstance when set.
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'TG_START_PLATFORM_MAPPING') return undefined;
    (async () => {
      const m = (monitorInstance || window.__tradeGuardXMonitor) || (await ensureMonitorReady());
      if (!m || typeof m.startGuidedPlatformMapping !== 'function') {
        sendResponse?.({ success: false, error: 'This page is not your paired broker host' });
        return;
      }
      if (!m.detector) {
        sendResponse?.({
          success: false,
          error: 'Detector unavailable on this page. Try opening the broker terminal tab directly.'
        });
        return;
      }
      try {
        await m.startGuidedPlatformMapping();
        const started = typeof m._isMappingActive === 'function' ? m._isMappingActive() : true;
        if (!started) {
          sendResponse?.({ success: false, error: 'Mapping UI did not start on this page' });
          return;
        }
        sendResponse?.({ success: true });
      } catch (err) {
        sendResponse?.({ success: false, error: err?.message || 'Failed to start mapping' });
      }
    })();
    return true;
  });
}

async function init() {
  if (initialized) return;
  initialized = true;

  // Self-gate on paired broker host. On non-paired pages we leave the
  // module loaded but don't construct TradeMonitor — no DOM scanning,
  // no event listeners, no rule evaluation. Manifest still matches
  // <all_urls> so we don't need a Web Store review for every new broker
  // added in the DB; gating happens at runtime.
  //
  // Use the fresh storage read (not cached __TG_HOST_GATE__) so the
  // post-pair TG_PAIRING_CHANGED handler can re-arm init() without a
  // page reload — the cached gate resolved before pairing happened.
  const allowed = await isPairedHostFresh();
  if (!allowed) {
    initialized = false; // allow a future TG_PAIRING_CHANGED to retry
    return;
  }

  try {
    const monitor = new TradeMonitor();
    monitorInstance = monitor;
    window.__tradeGuardXMonitor = monitor;
    await monitor.init();
    // eslint-disable-next-line no-console
    console.log('[TradeGuardX] content script ready', window.location.href);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Trade GuardX: failed to initialize trade monitor', err);
  }
}

if (document.readyState === 'complete' || document.readyState === 'interactive') {
  init();
} else {
  window.addEventListener('DOMContentLoaded', () => init(), { once: true });
}

