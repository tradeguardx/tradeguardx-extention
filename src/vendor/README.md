# Vendored third-party scripts

This directory holds prebuilt JS bundles loaded directly by the extension. They
are not edited by hand — replace the file when you upgrade the upstream version.

## sentry.bundle.min.js

Sentry's standalone IIFE browser bundle. Loaded as a classic script in every
extension context that runs `src/sentry/sentry-init.js`.

### Why vendor it instead of npm + bundler

The extension has no build step. A future migration to Vite/CRXJS/WXT (see
`docs/` for the discussion) lets us drop this file and `npm install` the SDK
normally. Until then, vendoring is the simplest path that complies with
Manifest V3's restriction on remotely-loaded code.

### How to install / upgrade

1. Pick a Sentry browser SDK version. Currently pinned: **8.45.0** (matches
   the `@sentry/react` version in `tradeguardx-web`).
2. Download the IIFE bundle:

   ```bash
   curl -L \
     -o src/vendor/sentry.bundle.min.js \
     https://browser.sentry-cdn.com/8.45.0/bundle.min.js
   ```

3. Verify the file size is roughly 70–90 KB (compressed) — anything much
   smaller means the download failed and you got an HTML error page.
4. Reload the extension in `chrome://extensions`.

### What this file does

When loaded, it attaches a global `Sentry` object to `window` (in popup /
content scripts). `src/sentry/sentry-init.js` then calls `Sentry.init(...)`
using the DSN from `src/sentry/sentry-config.js`.

### What's NOT covered

The MV3 service worker (`src/background/background.js`) is an ES module and
cannot consume an IIFE bundle. Sentry coverage for the service worker
requires a real build pipeline. Background-script errors will surface in the
service worker DevTools console until then.
