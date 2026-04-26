/* global self, Sentry */
/**
 * Initializes Sentry in every extension context where this script runs.
 * Loads AFTER:
 *   1. src/vendor/sentry.bundle.min.js (provides global `Sentry`)
 *   2. src/sentry/sentry-config.js     (provides `TG_SENTRY_CONFIG`)
 *   3. src/content/hostGate.js         (provides `__TG_HOST_GATE__` Promise)
 *
 * Both content scripts and the popup pull this in. Init is idempotent —
 * a guard at the top prevents duplicate registration if the script gets
 * injected twice (which can happen on dynamic content-script reinjection).
 *
 * Safe degradation:
 *   - If the vendored Sentry bundle didn't load, this script does nothing.
 *   - If the DSN in sentry-config.js is empty, Sentry init is skipped.
 *   - If the host gate resolves false (non-paired host), init is skipped —
 *     the SDK stays loaded but dormant; no events leave the page.
 *
 * Anything that throws here is swallowed — error reporting itself must
 * never break the host page or the extension UI.
 */

(function initSentry() {
  const root = typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis);

  if (root.__TG_SENTRY_READY === true) return;
  root.__TG_SENTRY_READY = true;

  try {
    if (typeof Sentry === 'undefined' || !Sentry || typeof Sentry.init !== 'function') return;

    const cfg = root.TG_SENTRY_CONFIG || {};
    const dsn = typeof cfg.dsn === 'string' ? cfg.dsn.trim() : '';
    if (!dsn) return;

    // Defer real init until the host gate resolves. On non-paired hosts
    // the gate resolves false and we never call Sentry.init(), so no
    // breadcrumbs are collected and no events leave the page.
    const gate = root.__TG_HOST_GATE__ || Promise.resolve(false);
    gate.then(function (allowed) {
      if (!allowed) return;
      try {
        runSentryInit();
      } catch (_e) { /* noop */ }
    }).catch(function () { /* noop */ });
  } catch (_e) {
    // Never let Sentry init failures bubble out — the extension must keep
    // working even if reporting is broken.
  }

  function runSentryInit() {
    const cfg = root.TG_SENTRY_CONFIG || {};
    const dsn = typeof cfg.dsn === 'string' ? cfg.dsn.trim() : '';
    if (!dsn) return;

    Sentry.init({
      dsn,
      environment: cfg.environment || 'production',
      release: cfg.release || undefined,
      // No performance tracing — keep noise / cost down.
      tracesSampleRate: 0,
      // Default integrations stay ON so unhandled errors + promise rejections
      // in content scripts surface automatically. We filter the noisier ones
      // (console capture) via beforeBreadcrumb below.
      ignoreErrors: [
        'ResizeObserver loop limit exceeded',
        'ResizeObserver loop completed with undelivered notifications',
        'Non-Error promise rejection captured',
      ],
      beforeBreadcrumb(breadcrumb) {
        // Drop console breadcrumbs — broker pages log P&L, account IDs,
        // and session tokens to console. We keep navigation / xhr / click
        // breadcrumbs which are less sensitive and more useful for debugging.
        if (breadcrumb?.category === 'console') return null;
        return breadcrumb;
      },
      beforeSend(event) {
        // Strip URL query strings — broker URLs often carry session tokens
        // / account IDs as query params.
        try {
          if (event?.request?.url) {
            event.request.url = String(event.request.url).split('?')[0];
          }
        } catch (_e) { /* noop */ }
        return event;
      },
    });

    // Tag the extension surface so we can filter content-script vs popup
    // errors in the Sentry UI.
    const surface =
      typeof window !== 'undefined' && window.location && window.location.protocol === 'chrome-extension:'
        ? 'popup'
        : 'content-script';
    Sentry.setTag('surface', surface);

    // Capture the broker hostname for content-script errors so we can spot
    // broker-specific regressions ("everything broke on exness.com").
    try {
      if (surface === 'content-script' && typeof window !== 'undefined' && window.location?.hostname) {
        Sentry.setTag('broker_host', window.location.hostname);
      }
    } catch (_e) { /* noop */ }
  }
})();
