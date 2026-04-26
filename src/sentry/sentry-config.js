/* global self, chrome */
/**
 * Sentry configuration for the TradeGuardX extension.
 *
 * This file is a CLASSIC script (not a module) so it runs in every extension
 * context where the vendored Sentry IIFE bundle has been loaded:
 *   - content scripts (via manifest.json content_scripts list)
 *   - popup (via <script> tag in popup.html)
 *
 * The release tag is derived from manifest.json's `version` field so bumping
 * the extension version automatically buckets Sentry events per release —
 * no manual sync between manifest.json and this file.
 *
 * When DSN is empty, sentry-init.js becomes a no-op — local dev stays quiet.
 */

(function attachConfig() {
  const root = typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis);

  let manifestVersion = 'unknown';
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getManifest === 'function') {
      const m = chrome.runtime.getManifest();
      if (m && typeof m.version === 'string' && m.version.length > 0) {
        manifestVersion = m.version;
      }
    }
  } catch (_e) { /* noop */ }

  root.TG_SENTRY_CONFIG = {
    // Paste your DSN from https://sentry.io → Project → Client Keys (DSN).
    // Leave empty to disable Sentry entirely.
    dsn: 'https://6e5b9e2a5998d76ac51d0db7c1355d3e@o4511279556919296.ingest.de.sentry.io/4511281926635600',
    // 'development' | 'staging' | 'production' — useful for filtering in
    // Sentry's UI between dev-mode noise and real production errors.
    environment: 'production',
    // Auto-derived from manifest.json so bumping the extension version
    // surfaces in Sentry without a separate edit here.
    release: `tradeguardx-extension@${manifestVersion}`,
  };
})();
