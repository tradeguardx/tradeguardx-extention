/* global self, chrome, window */
/**
 * TradeGuardX host gate.
 *
 * Resolves to true only when:
 *   - We're running inside the popup (chrome-extension://), OR
 *   - The user has a paired session AND window.location.hostname matches
 *     session.brokerHost (exact or subdomain match).
 *
 * All optional features (Sentry init, TradeMonitor, universalDetector,
 * deep-mapper, overlay) read this gate before activating so the extension
 * stays dormant on non-broker pages even though manifest content_scripts
 * matches "<all_urls>".
 *
 * Exposed as a CACHED Promise on the global root:
 *   self.__TG_HOST_GATE__ = Promise<boolean>
 *
 * Loaded BEFORE sentry-init.js and content.js so both can await the gate.
 */

(function attachHostGate() {
  const root = typeof self !== 'undefined'
    ? self
    : (typeof window !== 'undefined' ? window : globalThis);

  if (root.__TG_HOST_GATE__) return;

  const PAIRING_KEY = 'tradeGuardXPairingSession';

  function hostMatches(currentHost, brokerHost) {
    if (!brokerHost) return false;
    const a = String(currentHost || '').toLowerCase().trim();
    const b = String(brokerHost).toLowerCase().trim();
    if (!a || !b) return false;
    return a === b || a.endsWith('.' + b);
  }

  // Popup runs on chrome-extension://; always allow there so the popup UI
  // and its error reporting work regardless of pairing state.
  const isPopupContext = typeof window !== 'undefined'
    && window.location
    && window.location.protocol === 'chrome-extension:';

  root.__TG_HOST_GATE__ = new Promise((resolve) => {
    try {
      if (isPopupContext) {
        resolve(true);
        return;
      }
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        resolve(false);
        return;
      }
      chrome.storage.local.get(PAIRING_KEY, (result) => {
        if (chrome.runtime && chrome.runtime.lastError) {
          resolve(false);
          return;
        }
        const session = result && result[PAIRING_KEY];
        if (!session || !session.accessToken || !session.brokerHost) {
          resolve(false);
          return;
        }
        const currentHost = (typeof window !== 'undefined' && window.location && window.location.hostname) || '';
        resolve(hostMatches(currentHost, session.brokerHost));
      });
    } catch (_e) {
      resolve(false);
    }
  });
})();
