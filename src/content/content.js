/* global TradeMonitor, chrome */

let initialized = false;
/** @type {TradeMonitor|null} */
let monitorInstance = null;

async function ensureMonitorReady() {
  if (monitorInstance) return monitorInstance;
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

// Handle Map platform from popup as soon as script runs; use monitorInstance when set.
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'TG_START_PLATFORM_MAPPING') return undefined;
    (async () => {
      const m = (monitorInstance || window.__tradeGuardXMonitor) || (await ensureMonitorReady());
      if (!m || typeof m.startGuidedPlatformMapping !== 'function') {
        sendResponse?.({ success: false, error: 'Monitor unavailable on this page' });
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

  try {
    const monitor = new TradeMonitor();
    monitorInstance = monitor;
    window.__tradeGuardXMonitor = monitor;
    await monitor.init();
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

