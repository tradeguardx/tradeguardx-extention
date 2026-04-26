### TradeGuardX low‑level flow

This document describes what happens from the moment a trading page loads, through mapping, AI calls, and how selectors are stored and used.

---

### 1. Page load and content bootstrap

**Files**: `src/content/content.js`, `src/content/tradeMonitor.js`, `src/content/universalDetector.js`

- The content script (`content.js`) runs on matching pages.
- It creates a `TradeMonitor` and calls `await monitor.init()`.
- `TradeMonitor` constructor sets up:
  - `this.detector = window.TradeGuardX?.universalDetector` (DOM detection helpers from `universalDetector.js`).
  - Internal state: `accountState`, `_mappedSelectors`, `_loadedSelectors`, timers, etc.

`TradeMonitor.init()`:

1. Attaches runtime message handlers (`_attachRuntimeHandlers`).
2. Calls `loadSavedOrderIdentity()` which asks background for any saved selectors for this host (`TG_GET_SELECTORS` → `tradeGuardXSelectors[host]`).
3. If `OrderTableTracker` exists, it is created and seeded with any saved `order_profile`.
4. Checks `_hasSavedMappingForHost()`:
   - If **mapped** (`mapping_complete === true`):
     - Starts monitoring loops (`_startMonitoringLoops()` → `runFullScan()` + observers).
   - If **not mapped**:
     - Logs a console hint and returns — **no** automatic mapping overlay. The user starts mapping from the extension popup (**Map this host** → `TG_START_PLATFORM_MAPPING`).

---

### 2. Trading page context (no auto-prompt)

**File**: `src/content/tradeMonitor.js`

The extension does **not** infer “this is a broker” and pop the mapping UI automatically. After the user clicks **Map this host**, `content.js` handles `TG_START_PLATFORM_MAPPING` and calls `startGuidedPlatformMapping()`.

---

### 3. Where selectors live (local storage)

**Files**:
- `src/storage/storage.js`
- `src/background/background.js`

**Key**: `tradeGuardXSelectors` in `chrome.storage.local`

Shape:

```json
{
  "my.exness.com": {
    "mapping_complete": true,
    "mapping_version": 1,
    "positions_table": "<css>",
    "balance": "<css>",
    "equity": "<css>",
    "buy_button": "<css>",
    "sell_button": "<css>",
    "close_button": "<css>",
    "order_profile": { ... },
    "order_details_identity": { ... }
  },
  "other.broker.com": {
    "...": "..."
  }
}
```

**How it’s written**:

- `TradeMonitor` calls `_saveGuidedProfile(capture)` (manual mapper finalize).
- `_saveGuidedProfile` builds the `selectors` object and sends:

  ```js
  chrome.runtime.sendMessage(
    { type: 'TG_SAVE_SELECTORS', payload: { host, selectors } },
    ...
  );
  ```

- Background script (`background.js`) handles `TG_SAVE_SELECTORS` via `handleSaveSelectors`:
  - Calls `storage.updateSelectorsForHost(host, selectors)`.
  - `Storage.updateSelectorsForHost` merges that into `tradeGuardXSelectors[host]` in `chrome.storage.local`.

**How it’s read**:

- Background: `handleGetSelectors` answers `TG_GET_SELECTORS` from popup or content.
- Content (`TradeMonitor.loadSavedOrderIdentity`) uses that to seed `_loadedSelectors` and `OrderTableTracker`.

---

### 4. Manual mapper → AI → selectors flow

**Core functions** (all in `src/content/tradeMonitor.js` unless noted):

1. **`startGuidedPlatformMapping()`**
   - Shows the mapper bar at the bottom of the trading page.
   - Sets up:
     - Step list (balance, equity, buy button, container, row, symbol, side, prices, SL/TP, pnl, close button).
     - Event handlers for:
       - Start / Back / Pause / Dock / Minimize / Reopen.
       - Mouse move (highlight box).
       - Page clicks (capture).
   - Stores a `capture` object that accumulates all user clicks.

2. **`onClick(e)`** (inside `startGuidedPlatformMapping`)
   - Runs on each click while mapping is active:
     - Ignores clicks on the mapper UI itself.
     - For **container step**:
       - Finds a good positions container around the clicked element.
       - Saves `capture.containerEl`, `capture.containerSelector`, `capture.containerTag`.
     - For **row step**:
       - Ensures the clicked element is inside the container.
       - Chooses the best row candidate.
       - Saves `capture.rowEl`, `capture.rowSelector`, `capture.rowSelectorHint`.
     - For **field steps** (symbol, side, volume, prices, SL/TP, pnl, closeButton):
       - Builds a row-scoped selector with `_getExactSelector(el, capture.rowEl)`.
       - Stores in `capture.fields[key] = { selector, absolute, liveValue, ... }`.

3. **`finalize()`** (inside `startGuidedPlatformMapping`)
   - Called when all steps are done.
   - Ensures we have `containerSelector` and `rowSelector`.
   - Copies some fields to top-level:
     - `capture.balanceSelector`, `capture.equitySelector`, `capture.buyButtonSelector`, etc.
   - **AI enrichment (via DeepMapper + background + `/aiMapper`):**
     - Builds `manualSelections` from `capture.fields` via `_manualSelectionsFromCaptureFields`.
     - Calls `_runAiFieldMapping(capture.rowEl, manualSelections)`:
       - This wraps `DeepMapper.map(...)`.
       - `DeepMapper` sends `MAP_FIELDS` to background.
       - Background (`handleMapFields`) calls your backend `/aiMapper` with the prompt and brokerId.
       - `/aiMapper` returns the small JSON mapping.
       - `DeepMapper._validateAndScore` checks selectors against the DOM.
     - Returns `aiValidated` (mapping + `valid`, `value`, `warning`).
     - `_applyAiSelectorsToCapture(capture, aiValidated, { overwrite: true, rowEl })` merges AI selectors into the user-captured ones, normalizing things like brittle IDs.
   - If required fields still missing:
     - Runs a second AI pass with **broader context** and focus fields.
   - Builds canonical selectors via `_buildCanonicalSelectorsForStorage(capture)`:
     - `canonical.fieldBindings` (for `OrderTableTracker`).
     - `canonical.fieldSelectors` / `absoluteFieldSelectors`.
   - Validates canonical via `_validateCanonicalForSave(canonical)`:
     - Requires at least: `symbol`, `side`, one of `entryPrice|currentPrice`, and `volume`.
   - On success:
     - Fills `capture.fieldBindings`, `capture.fieldSelectors`, and `capture.absoluteFieldSelectors`.
     - Calls `_saveGuidedProfile(capture)` (see next section).
     - Updates `_loadedSelectors` / `_mappedSelectors` and starts monitoring immediately.

4. **`_runAiFieldMapping(clickedEl, manualSelections, options)`**
   - Thin wrapper:

     ```js
     const mapper = new window.DeepMapper();
     return mapper.map(clickedEl, { manualSelections, ...options });
     ```

   - Inside `DeepMapper` (`src/content/deep-mapper.js`):
     - Builds the prompt (`DeepMapper.buildPrompt(context)`).
     - Sends `MAP_FIELDS` to background.
     - Background calls `/aiMapper`.
     - Gets `mapping` back.
     - Validates selectors with `_validateAndScore(mapping, rowEl)`.

5. **`_applyAiSelectorsToCapture(capture, aiValidatedResult, options)`**
   - Takes `aiValidatedResult` (from `DeepMapper`).
   - For each field (symbol, side, volume, prices, SL/TP, pnl, closeButton):
     - If AI selector is valid:
       - Optionally overwrites user’s selector (based on `overwrite` and coarse-ness).
       - Normalizes brittle selectors (e.g. `symbol-EURUSD` → `symbol-*`, unstable row IDs).
   - Also applies:
     - `balanceSelector`, `equity`, `buyButton`, `sellButton`, `rowSelector` when present.

6. **`_buildCanonicalSelectorsForStorage(capture)`**
   - Converts `capture` into a shape suitable for storage:
     - `fieldBindings`: `{ fieldKey: { selector, confidence, source } }`
     - `fieldSelectors` / `absoluteFieldSelectors` for all relevant fields (row fields + balance, equity, buttons, container).

7. **`_saveGuidedProfile(capture)`**
   - Builds the final `selectors` object:
     - Top-level flags (`mapping_complete`, `mapping_version`, `positions_table`, `balance`, `equity`, etc.).
     - `order_profile` (consumed by `OrderTableTracker`).
     - `order_details_identity` (where to look for rows).
   - Sends to background via `TG_SAVE_SELECTORS`, which writes to `tradeGuardXSelectors[host]`.

---

### 5. Backend `/broker-mappings` flow (planned / partial)

**Idea**: on a trading page where `tradeGuardXSelectors[host]` is empty:

1. Call `GET /broker-mappings/{brokerId}` from background.
2. If it returns a previously saved **raw mapping** (same format as `/aiMapper`):
   - Use the same validation and canonical-building steps as above, but driven by backend mapping instead of fresh AI.
   - Save result into `tradeGuardXSelectors[host]`.
   - Start monitoring without showing manual mapper UI.
3. If backend returns “not found”:
   - Fall back to **manual mapper UI** path described in section 4.

This keeps the extension logic the same while allowing the backend to short-circuit mapping for brokers that are already known and approved.

