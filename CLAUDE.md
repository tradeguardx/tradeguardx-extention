# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chrome extension (Manifest V3) — an in-browser risk rules engine that monitors broker trading UIs, intercepts trade button clicks, evaluates user-configured risk rules, and shows warning/block overlays.

**No build step** — pure vanilla JS loaded directly by Chrome. No npm, no TypeScript, no bundler.

## Architecture

See `ARCHITECTURE.md` for full message flow diagrams and component interaction. See `docs/mapping-flow.md` and `docs/trade-tracking-flow.md` for specific sub-flows.

### Component Roles

| Component | Role |
|-----------|------|
| `background/serviceWorker.js` | Central hub. Owns config storage, RulesEngine, extension session. Routes messages between content scripts and external APIs. |
| `content/tradeMonitor.js` | Main orchestrator injected into broker pages. Intercepts Buy/Sell button clicks. Coordinates position detection and rule evaluation before allowing trades. |
| `content/universalDetector.js` | Heuristic DOM scanner that finds trade buttons, symbols, prices, SL/TP fields without requiring a pre-configured mapping. |
| `content/orderTableTracker.js` | Strict-mode tracker for open positions table using pre-configured CSS selectors from broker mappings. Tracks live P&L changes. |
| `content/deep-mapper.js` | Sends DOM context to the brokermapping service for AI-assisted selector generation when strict mode is first enabled. |
| `content/warningOverlay.js` | Renders warning/block UI overlays. Called by tradeMonitor when a rule is violated. |
| `popup/` | Extension popup UI for configuring risk limits, entering pairing codes, and toggling mapping mode. |
| `adapters/universalAdapter.js` | Adapts the universal detector output to the format expected by tradeMonitor. |

### Two Detection Modes
1. **Universal mode** (default): `universalDetector.js` uses heuristics to find trade elements. Lower precision, works on any broker without setup.
2. **Strict/mapped mode**: `orderTableTracker.js` uses broker-specific CSS selectors fetched from the brokermapping service. Higher precision for position tracking. Requires AI mapping to be run first via `deep-mapper.js`.

### Rules Engine (`background/rulesEngine.js`)
Evaluates rules against current trade state. Rules come from the user service (`GET /user/rules`). Supported rule types:
- Daily max loss
- Per-trade risk % of account
- Hedging prevention (no opposing positions)
- Auto-close on drawdown threshold

### Pairing Flow
User enters pairing code in popup → popup sends message to service worker → service worker calls `POST /user/pairing/exchange` → session token stored in `chrome.storage.local` → subsequent API calls use this token.

### Message Passing
All cross-component communication uses `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage`. The service worker is the message broker — content scripts never call external APIs directly.

## Key Files

- `manifest.json` — permissions, content script injection rules, background registration
- `background/serviceWorker.js` — start here to understand the data flow
- `content/tradeMonitor.js` — start here to understand the trade interception flow
- `ARCHITECTURE.md` — detailed sequence diagrams

## Development

Load as unpacked extension from Chrome's `chrome://extensions` page (Developer mode on). After any JS change, click the reload icon on the extension card — no build needed.

Chrome DevTools for debugging:
- **Popup**: Right-click popup → "Inspect"
- **Service worker**: `chrome://extensions` → "Service Worker" link
- **Content scripts**: Main page DevTools → Sources → Content Scripts
