### TradeGuardX – Trading Guardian Extension

TradeGuardX is a browser extension that sits on top of broker web terminals, reads open positions from the DOM, and applies configurable risk rules (daily loss, per‑trade risk, hedging prevention, auto‑close) while showing advisory overlays. It is **read‑only** with respect to the broker: it only intercepts clicks and drives the broker UI, it never sends orders directly.

---

### Extension lifecycle (how it works)

At a high level, the extension behaves like this:

1. **Install & popup**
   - The user installs TradeGuardX and opens the popup to configure:
     - Account size and daily loss limits (percentage or fixed amount).
     - Per‑trade risk limits, hedging toggle, and other guardrails.
     - Anthropic API key (for AI‑assisted mapping).
2. **Background boot**
   - The background script initializes `Storage` and the `RulesEngine`.
   - It listens for messages from popup/content (e.g. `TG_EVALUATE_ACCOUNT`, `TG_SAVE_CONFIG`, `TG_START_PLATFORM_MAPPING`, `MAP_FIELDS`).
3. **Content scripts attach to broker pages**
   - On trading websites, content scripts are injected:
     - `universalDetector` provides heuristics to find trade buttons, symbols, prices, SL/TP, and close buttons.
     - `OrderTableTracker` is prepared to read a positions table, but only once mapping exists.
     - `DeepMapper` handles AI‑assisted mapping.
     - `TradeMonitor` is created and `init()` is called for the current tab.
4. **Mapping (one-time per broker)**
   - From the popup, the user clicks “Map this platform”; the background forwards `TG_START_PLATFORM_MAPPING` to the tab.
   - `TradeMonitor` shows a mapping overlay and, with `DeepMapper`, asks the user to click on representative positions rows and fields.
   - DeepMapper captures DOM context, sends it to Anthropic (via the background), validates the returned selectors, and builds a mapping profile.
   - The background saves selectors per host; `OrderTableTracker.importProfile()` enables **strict mapped mode** for that broker.
5. **Live monitoring & risk checks**
   - With a mapping profile in place, `TradeMonitor`:
     - Uses mapped selectors to read balance, equity, floating loss.
     - Uses `OrderTableTracker.getTrades()` to maintain `accountState.positions`.
   - On each scan or significant change, `TradeMonitor` sends `TG_EVALUATE_ACCOUNT` to the background, which:
     - Loads config from `Storage`.
     - Runs the `RulesEngine` against the current account state and pending trade (if any).
     - Returns decisions (OK, warn, block, auto‑close) plus derived metrics.
6. **Intercepting Buy/Sell and showing overlays**
   - `TradeMonitor` locates Buy/Sell buttons (via `universalDetector`) and wraps them with its own click handler.
   - When the user clicks Buy or Sell:
     - TradeGuardX reads the symbol, side, volume, SL/TP, and prices from the DOM.
     - It checks hedging rules (no opposite‑side on same symbol when hedging is enabled).
     - It asks the background for a fresh risk evaluation including this pending trade.
   - Based on the response:
     - If **allowed**, the original click is re‑fired so the broker processes the order.
     - If **blocked/warned**, the click is suppressed and `warningOverlay.js` shows the relevant overlay (SL reminder, blocked trade, over‑risk warning, closed‑trade popup, etc.).
   - In some cases (daily loss exceeded, configured auto‑close behavior), `TradeMonitor` also clicks broker “close” buttons to flatten risk and then shows a “trade(s) closed” overlay.

For a deeper architectural reference, see `ARCHITECTURE.md`.

---

### Documentation

The core architecture and flows are documented in the repo:

- **High‑level overview**
  - `ARCHITECTURE.md` – overall extension architecture, runtime loops, and main diagrams.

- **End‑to‑end flows**
  - `docs/mapping-flow.md` – guided mapping flow and DeepMapper/Claude integration.
  - `docs/trade-tracking-flow.md` – how `OrderTableTracker` tracks the positions table in strict mapped mode.
  - `docs/risk-rules-and-hedging.md` – configuration, daily loss, per‑trade risk, hedging, auto‑close (when present).
  - `docs/overlays-and-ui.md` – warning, blocked trade, closed‑trade, and SL‑reminder overlays.

- **Per‑file developer references**
  - `docs/files-tradeMonitor.md`
  - `docs/files-orderTableTracker.md`
  - `docs/files-deep-mapper.md`
  - `docs/files-universalDetector.md`
  - `docs/files-background-and-popup.md`

- **Audience‑specific guides**
  - `docs/junior-getting-started.md` – how to run the extension and where to start in the code.
  - `docs/junior-tasks-examples.md` – small, guided tasks for new contributors.
  - `docs/design-decisions.md` – key architectural decisions and trade‑offs.
  - `docs/extensibility.md` – how to add support for a new broker platform.

As new features are added, prefer extending the relevant doc in `docs/` over duplicating explanations in multiple places.

