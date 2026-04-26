/* global chrome, showWarningOverlay, showNoStopLossOverlay, showBlockedTradeOverlay, showTradeClosedOverlay, showToast, flashScreen, TradeGuardXPositionSource, TradeGuardXPositionState, TradeGuardXPositionTransitions, TradeGuardXMappingQuality, TradeGuardXMappingStore */

function debounce(func, wait) {
  let timeout;
  return function (...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

/** DevTools: filter by `TradeGuardX` — uses console.log so “Default levels” always shows it. */
function tgHedgingLog(phase, payload) {
  try {
    console.log('[TradeGuardX][Hedging]', phase, payload !== undefined ? payload : '');
  } catch (_e) {
    /* ignore */
  }
}

/** Host suffixes where the content script may run but no broker mapping is expected (quiet console). */
const _TG_NON_BROKER_HOST_SUFFIXES = [
  'localhost',
  '127.0.0.1',
  'amazonaws.com',
  'cursor.com',
  'authenticator.cursor.sh',
  'accounts.google.com',
  'claude.ai',
  'anthropic.com',
  'openai.com',
  'chatgpt.com',
  'notion.so',
  'notion.site',
  'tradezella.com'
];

/** Hosts where we skip the loud “no mapping” warning (tools, not broker terminals). */
function _tgSkipNoMappingConsoleWarn(host) {
  const h = String(host || '').toLowerCase();
  if (
    /jsonformatter|curiousconcept\.com$|^(www\.)?google\.|^github\.com$|stackoverflow\.com$|^s3[.-]|^cdn\.|^assets\./i.test(h)
  ) {
    return true;
  }
  if (/^localhost(?::\d+)?$/.test(h) || /^127\.0\.0\.1(?::\d+)?$/.test(h)) return true;
  if (h.includes('journal-media.s3.') || h.includes('.s3.') || h.endsWith('.amazonaws.com')) return true;
  for (const suf of _TG_NON_BROKER_HOST_SUFFIXES) {
    if (h === suf || h.endsWith('.' + suf)) return true;
  }
  return false;
}

/**
 * TradeMonitor
 * - Central coordinator for reading trades from the page, applying risk / hedging rules,
 *   and triggering UI overlays (warnings, blocked trade, closed-trade popup).
 * - Uses the universalDetector for page understanding plus OrderTableTracker for mapped rows.
 */
class TradeMonitor {
  constructor() {
    this.detector = window.TradeGuardX?.universalDetector;
    this.accountState = {
      equity: null,
      balance: null,
      floatingLoss: 0,
      startingEquity: null,
      positions: [] // activeTrades: [{ symbol, side, element? }]
    };
    this.slTpReminderId = null;
    /** First SL reminder fires after rule delay; avoids spam when refreshAccountState runs often. */
    this._slTpFirstTimeoutId = null;
    /** When set, reminder timers match this key — skip rescheduling if unchanged. */
    this._slTpScheduleKey = null;
    this.hooked = false;
    this._scanIntervalId = null;
    this._observer = null;
    this._positionsContainer = null;
    this._profitWatcherActive = false;
    this._lastPositionsCount = null;
    this._lastEquity = null;
    this._lastTradeAllowedAt = 0;
    this._lastSavedOrderSelector = null;
    this._lastOrderIdentitySavedAt = 0;
    this._identityLocked = false;
    this._identityMissingSince = null;
    this._orderTracker = null;
    this._lastTradesDigest = '';
    this._loadedSelectors = null;
    this._lastProfileSavedAt = 0;
    this._emptyTradesStreak = 0;
    this._trackerEmptyStreak = 0;
    this._lastNonEmptyTradesAt = 0;
    this._messageHandler = null;
    this._mappingSession = null;
    this._requiresMapping = false;
    this._monitoringStarted = false;
    this._mappedSelectors = null;
    this._lastScanPositions = [];
    /** Dedupes the trade-closed overlay when the broker UI flickers the row back briefly. */
    this._closedPopupRecent = new Map();
    this._buyButtonEl = null;
    this._sellButtonEl = null;
    this._dailyLossAutoCloseTriggered = false;
    /** First time we saw an open position (by stable key) — for minimum-hold rule. */
    this._positionFirstSeenMs = new Map();
    /** Last config from background; refreshed often for synchronous close interception. */
    this._cachedRiskConfig = null;
    this._minimumHoldGuardAttached = false;
    /** Avoid noisy repeated warnings for the same host mapping diagnostics. */
    this._mappingQualityWarnedHosts = new Set();
    /** Journal runtime state (per open position key): uid, sequence, pending events, last snapshot. */
    this._journalPositionState = new Map();
    this._journalDebounceMs = 1800;
    /** Prevent snapshot spam if OPEN/CLOSE gets retriggered rapidly for same tradeUid. */
    this._journalLastSnapshotAt = new Map();
    /** Funded-mode cache from background: { accountId, account, closedPnlToday, needsReconcile, fetchedAt } */
    this._fundedAccountState = null;
    this._fundedAccountFetchInflight = null;
    this._fundedRefreshIntervalId = null;
    /** Whether the extension is currently paired to an account. All user-visible
     *  toasts/overlays must check this — when false, the content script should be
     *  silent (no "trade closed" popup, no "rules enforced" toast, etc.). */
    this._isPaired = false;
    /** Post-refresh hydration gate: when we restore cached positions on init we
     *  must not declare phantom closes until the broker DOM has had a chance to
     *  catch up. The gate clears either when a live scan returns positions
     *  (DOM is up) or after HYDRATION_GRACE_MS (legit closes during the refresh
     *  gap can still fire eventually). Without this, every page refresh on a
     *  slow-hydrating broker SPA fires a fake TG_SYNC_CLOSED_TRADE. */
    this._cachedHydrationCount = 0;
    this._cachedHydrationAt = 0;
    this._domHydrationConfirmed = true;
    /** Last tab the user explicitly clicked on (open/closed/pending). Used as the authoritative
     *  tab-context signal because DOM active-state detection fails on brokers that style tabs
     *  without aria/data/class markers (e.g. The Funded Room). */
    this._lastTabClickContext = null;
    this._tabClickListener = null;
    /** In-memory mirror of the last persisted positions snapshot for this host.
     *  Used to keep accountState.positions populated when the user is on the Close/History
     *  tab (scan returns empty) so hedging checks and funded-mode equity remain correct. */
    this._cachedPositionsSnapshot = null;
  }

  // Initialize message listeners, load mapping/profile, then start monitoring if host is mapped.
  async init() {
    if (!this.detector) {
      console.warn(
        '[TradeGuardX] TradeMonitor init stopped: universalDetector missing (script order issue?)'
      );
      return;
    }
    this._attachRuntimeHandlers();
    await this.loadSavedOrderIdentity();
    if (window.OrderTableTracker && !this._orderTracker) {
      this._orderTracker = new window.OrderTableTracker(this.detector, {
        host: window.location.hostname
      });
      if (this._loadedSelectors?.order_profile) {
        this._orderTracker.importProfile(this._loadedSelectors.order_profile);
      }
    }
    // Consider mapping present if flagged complete OR if we got any loaded selectors
    // (e.g. restored from backend where mapping_complete may not have been stamped yet).
    const hasMapping = this._hasSavedMappingForHost() ||
      (this._loadedSelectors != null && typeof this._loadedSelectors === 'object' &&
        Object.keys(this._loadedSelectors).length > 0);
    this._requiresMapping = !hasMapping;
    if (this._requiresMapping) {
      const host = window.location.hostname;
      const quietHost = _tgSkipNoMappingConsoleWarn(host);
      if (!quietHost) {
        console.warn(
          '[TradeGuardX] No platform mapping for this site yet — Buy/Sell click hooks are NOT attached. ' +
            'Open the extension popup and use “Map this host” when you are on the broker terminal, then reload if needed. ' +
            `host=${host}`
        );
      }
      return;
    }
    console.log(
      '[TradeGuardX] Monitoring started (mapping present) — hedging logs appear on Buy/Sell click.',
      window.location.hostname
    );
    this._loadPairingState().catch(() => {});
    this._loadFundedAccountState().catch(() => {});
    // Hydrate per-host position cache BEFORE the first scan so refreshed trades keep their
    // original openedAtMs / clientTradeId (no duplicate journal OPEN on refresh) and so the
    // first scan on the Close tab has something to show.
    await this._hydratePositionCache();
    this._startMonitoringLoops();
    if (!this._fundedRefreshIntervalId) {
      this._fundedRefreshIntervalId = window.setInterval(
        () => this._loadFundedAccountState().catch(() => {}),
        60_000
      );
    }
  }

  _startMonitoringLoops() {
    if (this._monitoringStarted) return;
    this._monitoringStarted = true;
    // Kick off one scan and then keep state in sync via DOM mutations + interval polling.
    this.runFullScan();
    // Inform background/popup that a trading UI monitor is now active for this host,
    // so the \"active trading page\" indicator can flip immediately even before we
    // have seen positions/equity data.
    if (chrome?.runtime?.id && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({
        type: 'TG_UI_HOOKED',
        payload: { host: window.location.hostname, url: window.location.href, at: Date.now() }
      });
    }
    this._maybeAutoRemapIfUnhooked();

    if (document.body && !this._observer) {
      const debouncedScan = debounce(() => this.runFullScan(), 300);
      this._observer = new MutationObserver(() => {
        debouncedScan();
      });
      this._observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
      });
    }

    this.startTradesObservation();
    if (!this._scanIntervalId) {
      // Fallback: if no DOM mutations fire (e.g. no re-renders), still refresh trade state every 2s.
      this._scanIntervalId = window.setInterval(() => this.runFullScan(), 2000);
    }
    this.startProfitWatcher();
    if (!this._overRiskReminderId) {
      setTimeout(() => this.checkOverRiskReminder(), 8000);
      this._overRiskReminderId = window.setInterval(() => this.checkOverRiskReminder(), 60000);
    }
    this.attachTradeButtons();
    this._attachMinimumHoldGuard();
    this.getConfig().then((c) => {
      this._cachedRiskConfig = c;
    });
  }

  _hasSavedMappingForHost() {
    const s = this._loadedSelectors || {};
    return s.mapping_complete === true;
  }

  _isMappedCrawlMode() {
    const s = this._mappedSelectors || this._loadedSelectors || {};
    // Mapped-only rule: once mapping is marked complete, do not fallback to heuristics.
    return s.mapping_complete === true;
  }

  _maybeAutoRemapIfUnhooked() {
    // Disabled by design:
    // If host is already mapped, do not auto-show mapping again.
    // Remapping should be user-initiated from popup.
  }

  _attachRuntimeHandlers() {
    // TG_START_PLATFORM_MAPPING is handled in content.js with a bound monitor reference.
    if (!chrome?.runtime?.id || !chrome.runtime.onMessage || this._messageHandler) return;
    this._messageHandler = (message, _sender, _sendResponse) => {
      if (message?.type === 'TG_PAIRING_CHANGED') {
        // Session flipped (new pairing or disconnect): drop cached funded state
        // + risk config so the next trade click reads a fresh world without a
        // page refresh. Also reset `hooked` so the "TradeGuardX active. Rules
        // enforced." toast can fire on the next scan now that pairing is real
        // (it was suppressed during the unpaired window).
        this._fundedAccountState = null;
        this._cachedRiskConfig = null;
        this.hooked = false;
        this._loadPairingState().catch(() => {});
        this._loadFundedAccountState().catch(() => {});
        this.getConfig().then((c) => { this._cachedRiskConfig = c; }).catch(() => {});
        // Re-fetch the broker mapping too — when the user pairs to a different
        // broker, or when the mapping wasn't cached yet at monitor construction
        // time, the cached _loadedSelectors are stale/empty. Without this,
        // hasMapping stays false and the monitor never enters the active loop.
        this.loadSavedOrderIdentity()
          .then(() => {
            const hasMapping = this._hasSavedMappingForHost() ||
              (this._loadedSelectors != null && typeof this._loadedSelectors === 'object' &&
                Object.keys(this._loadedSelectors).length > 0);
            if (hasMapping && !this._monitoringStarted) {
              this._requiresMapping = false;
              this._startMonitoringLoops();
            }
          })
          .catch(() => {});
        return undefined;
      }
      if (message?.type === 'TG_ACCOUNT_REFRESHED') {
        // Server-side account data just arrived. Reload funded state so
        // daily-loss / max-trades rules pick up the fresh server counters
        // immediately — without waiting for the 60s _fundedRefreshIntervalId.
        this._loadFundedAccountState().catch(() => {});
        return undefined;
      }
      return undefined;
    };
    chrome.runtime.onMessage.addListener(this._messageHandler);
  }

  _isMappingActive() {
    if (!this._mappingSession) return false;
    const overlay = this._mappingSession.overlay;
    if (!(overlay instanceof HTMLElement) || !overlay.isConnected) {
      this._mappingSession = null;
      return false;
    }
    return true;
  }

  _getExactSelector(el, scope = null) {
    if (!el || !this.detector?.getExactElementSelector) return null;
    return this.detector.getExactElementSelector(el, scope || null);
  }

  _readMappedNumber(selector) {
    if (!selector || typeof selector !== 'string') return null;
    try {
      const el = document.querySelector(selector);
      if (!el) return null;
      const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) return null;
      const match = text.match(/[+-]?\d[\d,]*(?:\.\d+)?/);
      if (!match) return null;
      const num = parseFloat(match[0].replace(/,/g, ''));
      return Number.isFinite(num) ? num : null;
    } catch (_err) {
      return null;
    }
  }

  _queryMappedElements(selector) {
    if (!selector || typeof selector !== 'string') return [];
    try {
      return Array.from(document.querySelectorAll(selector)).filter(
        (el) => el instanceof HTMLElement && el.isConnected
      );
    } catch (_err) {
      return [];
    }
  }

  /**
   * Read instrument label from mapped order-ticket selector (preferred for hedging vs scraping nearby text).
   */
  _readMappedOrderInstrumentText(selector) {
    if (!selector || typeof selector !== 'string') return null;
    try {
      const el = document.querySelector(selector);
      if (!el) return null;
      const raw = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!raw) return null;
      if (this.detector?.getBestSymbolFromText) {
        const sym = this.detector.getBestSymbolFromText(raw);
        if (sym) return sym;
      }
      const first = raw.split(/[\s/]+/).find((t) => t && /^[A-Za-z]{2,12}/.test(t));
      return first ? this.detector?.normalizeSymbol?.(first) || String(first).toUpperCase() : null;
    } catch (_err) {
      return null;
    }
  }

  _setButtonBlocked(btn, reason, opts = {}) {
    if (!btn || !(btn instanceof HTMLElement)) return;
    const { symbol = null, side = null, ruleSlug = 'hedging' } = opts || {};
    btn.dataset.tgBlocked = 'true';
    btn.dataset.tgBlockedReason = reason || '';
    btn.disabled = true;
    btn.style.opacity = '0.5';
    btn.style.cursor = 'not-allowed';
    if (btn.__tgBlockHandler) return;
    btn.__tgBlockHandler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._journalEmitRuleBlock({
        side,
        symbol,
        reason: reason || 'Hedging prevention',
        title: 'Hedging blocked',
        ruleSlug
      });
      this.showBlockedReason(
        reason ||
          'Hedging is disabled. Opposite-side trades on the same instrument are blocked by your rules.',
        null,
        { title: 'Hedging blocked' }
      );
    };
    btn.addEventListener('click', btn.__tgBlockHandler, true);
  }

  _clearBlockedButtons() {
    const clearOne = (btn) => {
      if (!btn || !(btn instanceof HTMLElement)) return;
      btn.disabled = false;
      btn.style.opacity = '';
      btn.style.cursor = '';
      if (btn.__tgBlockHandler) {
        btn.removeEventListener('click', btn.__tgBlockHandler, true);
        delete btn.__tgBlockHandler;
      }
      if (btn.dataset) {
        delete btn.dataset.tgBlocked;
        delete btn.dataset.tgBlockedReason;
      }
    };
    clearOne(this._buyButtonEl);
    clearOne(this._sellButtonEl);
  }

  _manualSelectionsFromCaptureFields(fields) {
    const out = {};
    Object.entries(fields || {}).forEach(([k, v]) => {
      if (v?.selector && typeof v.selector === 'string') {
        out[k] = {
          selector: v.selector,
          liveValue: typeof v.liveValue === 'string' ? v.liveValue : null
        };
      }
    });
    return out;
  }

  async _runAiFieldMapping(clickedEl, manualSelections = null, options = null) {
    if (!window.DeepMapper) {
      throw new Error('DeepMapper not available');
    }
    const mapper = new window.DeepMapper();
    return mapper.map(clickedEl, { manualSelections: manualSelections || {}, ...(options || {}) });
  }

  _normalizeAiSelector(selector, field) {
    if (!selector || typeof selector !== 'string') return selector;
    let s = selector.trim();
    s = s
      .replace(/\[data-test="symbol-[^"]+"\]/g, '[data-test^="symbol-"]')
      .replace(/\[data-testid="symbol-[^"]+"\]/g, '[data-testid^="symbol-"]')
      .replace(/\[data-test="order-panel-[^"]+"\]/g, '[data-test^="order-panel-"]')
      .replace(/\[data-testid="order-panel-[^"]+"\]/g, '[data-testid^="order-panel-"]')
      .replace(/\[data-test="account-button-[^"]+"\]/g, '[data-test^="account-button-"]')
      .replace(/\[data-testid="account-button-[^"]+"\]/g, '[data-testid^="account-button-"]');
    s = s.replace(/(\.[A-Za-z0-9_-]*__[A-Za-z0-9_-]{6,})/g, '');
    s = s.replace(/\s{2,}/g, ' ').replace(/\s*>\s*/g, ' > ').trim();

    if (field === 'side' && /IconOrderType_icon__/i.test(selector)) {
      return 'span[data-test="type"]';
    }
    return s;
  }

  _normalizeMappedSelectorPayload(selectors) {
    const src = selectors && typeof selectors === 'object' ? selectors : {};
    const out = { ...src };
    const normalizeTopLevel = (key, field) => {
      if (typeof out[key] !== 'string' || !out[key]) return;
      out[key] = this._normalizeAiSelector(out[key], field);
    };
    normalizeTopLevel('buy_button', 'buyButtonSelector');
    normalizeTopLevel('sell_button', 'sellButtonSelector');
    normalizeTopLevel('order_instrument', 'orderInstrumentSelector');
    normalizeTopLevel('open_positions_tab', 'openTabSelector');
    normalizeTopLevel('pending_positions_tab', 'pendingTabSelector');
    normalizeTopLevel('closed_positions_tab', 'closedTabSelector');
    normalizeTopLevel('closed_trades_section', 'closedTradesContainerSelector');

    if (out.order_details_identity && typeof out.order_details_identity === 'object') {
      const odi = { ...out.order_details_identity };
      if (odi.fieldSelectors && typeof odi.fieldSelectors === 'object') {
        const fs = { ...odi.fieldSelectors };
        if (typeof fs.buyButton === 'string') fs.buyButton = this._normalizeAiSelector(fs.buyButton, 'buyButtonSelector');
        if (typeof fs.sellButton === 'string') fs.sellButton = this._normalizeAiSelector(fs.sellButton, 'sellButtonSelector');
        if (typeof fs.orderInstrument === 'string') fs.orderInstrument = this._normalizeAiSelector(fs.orderInstrument, 'orderInstrumentSelector');
        odi.fieldSelectors = fs;
      }
      if (odi.absoluteFieldSelectors && typeof odi.absoluteFieldSelectors === 'object') {
        const afs = { ...odi.absoluteFieldSelectors };
        if (typeof afs.buyButton === 'string') afs.buyButton = this._normalizeAiSelector(afs.buyButton, 'buyButtonSelector');
        if (typeof afs.sellButton === 'string') afs.sellButton = this._normalizeAiSelector(afs.sellButton, 'sellButtonSelector');
        if (typeof afs.orderInstrument === 'string') afs.orderInstrument = this._normalizeAiSelector(afs.orderInstrument, 'orderInstrumentSelector');
        odi.absoluteFieldSelectors = afs;
      }
      out.order_details_identity = odi;
    }
    return out;
  }

  _selectorLooksCoarse(rowEl, selector, field) {
    if (!rowEl || !selector || typeof selector !== 'string') return false;
    try {
      const el = rowEl.querySelector(selector);
      // If selector does not resolve in row scope, treat as coarse/invalid so AI can correct it.
      if (!(el instanceof HTMLElement)) return true;
      if (field === 'closeButton') return false;
      if (el.childElementCount === 0) return false;
      const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      const numCount = (text.match(/[+-]?\d[\d,]*(?:\.\d+)?/g) || []).length;
      if (field === 'symbol' || field === 'side') {
        return text.length > 30 || numCount > 0;
      }
      // Numeric fields should point to leaf/single value node.
      return numCount > 1 || text.length > 40;
    } catch (_err) {
      // Invalid selector syntax should be replaced by AI.
      return true;
    }
  }

  _applyAiSelectorsToCapture(capture, aiValidatedResult, options = {}) {
    if (!capture || !aiValidatedResult || typeof aiValidatedResult !== 'object') return;
    const overwrite = options.overwrite === true;
    const overwriteCoarseOnly = options.overwriteCoarseOnly === true;
    const rowEl = options.rowEl || capture.rowEl || null;
    const rowFieldMap = [
      { aiKeys: ['symbol'], capKey: 'symbol' },
      { aiKeys: ['side'], capKey: 'side' },
      { aiKeys: ['volume', 'size', 'qty'], capKey: 'volume' },
      { aiKeys: ['entryPrice', 'openPrice'], capKey: 'entryPrice' },
      { aiKeys: ['currentPrice', 'markPrice', 'marketPrice'], capKey: 'currentPrice' },
      { aiKeys: ['takeProfit', 'tp'], capKey: 'takeProfit' },
      { aiKeys: ['stopLoss', 'sl'], capKey: 'stopLoss' },
      { aiKeys: ['pnl', 'profit', 'pl'], capKey: 'pnl' },
      { aiKeys: ['closeButton', 'close'], capKey: 'closeButton' }
    ];

    rowFieldMap.forEach(({ aiKeys, capKey }) => {
      const item = aiKeys.map((k) => aiValidatedResult[k]).find((v) => v?.valid && v?.selector) || null;
      if (!item?.valid || !item.selector) return;
      const existingSelector = capture.fields?.[capKey]?.selector || null;
      if (!overwrite && existingSelector) {
        if (overwriteCoarseOnly) {
          const coarse = this._selectorLooksCoarse(rowEl, existingSelector, capKey);
          if (!coarse) return;
        } else {
          return;
        }
      }
      const normalizedSelector = this._normalizeAiSelector(item.selector, capKey);
      capture.fields[capKey] = {
        selector: normalizedSelector,
        absolute: normalizedSelector,
        source: 'guided_mapping_ai',
        confidence: 0.99
      };
    });

    const balanceItem = aiValidatedResult.balanceSelector || aiValidatedResult.balance;
    if (
      balanceItem?.valid &&
      balanceItem.selector &&
      (overwrite || !capture.fields.balance?.selector)
    ) {
      const normalizedBalance = this._normalizeAiSelector(balanceItem.selector, 'balance');
      capture.fields.balance = {
        selector: normalizedBalance,
        absolute: normalizedBalance,
        source: 'guided_mapping_ai',
        confidence: 0.99
      };
    }

    const rowItem = aiValidatedResult.rowSelector || aiValidatedResult.row;
    if (rowItem?.valid && rowItem.selector && (overwrite || !capture.rowSelector)) {
      const normalizedRowSelector = this._normalizeAiSelector(rowItem.selector, 'row');
      // Keep row selector scoped to mapped container; ignore document-absolute selectors.
      try {
        const scopedHit = capture?.containerEl?.querySelector?.(normalizedRowSelector);
        if (scopedHit) {
          capture.rowSelector = normalizedRowSelector;
        }
      } catch (_err) {
        // Ignore invalid/non-scoped AI row selector and preserve existing row selector.
      }
    }

    const globalFieldMap = [
      { aiKeys: ['equity', 'equitySelector'], assign: 'equitySelector' },
      { aiKeys: ['buyButton', 'buy'], assign: 'buyButtonSelector' },
      { aiKeys: ['sellButton', 'sell'], assign: 'sellButtonSelector' },
      { aiKeys: ['orderInstrument', 'orderInstrumentSelector'], assign: 'orderInstrumentSelector' },
      { aiKeys: ['openTab', 'open_positions_tab'], assign: 'openTabSelector' },
      { aiKeys: ['pendingTab', 'pending_positions_tab'], assign: 'pendingTabSelector' },
      { aiKeys: ['closedTab', 'closed_positions_tab'], assign: 'closedTabSelector' },
      { aiKeys: ['closedTradesContainer', 'closed_trades_section'], assign: 'closedTradesContainerSelector' }
    ];
    globalFieldMap.forEach(({ aiKeys, assign }) => {
      const item = aiKeys.map((k) => aiValidatedResult[k]).find((v) => v?.valid && v?.selector) || null;
      if (!item?.valid || !item.selector) return;
      if (!overwrite && capture[assign]) return;
      const normalized = this._normalizeAiSelector(item.selector, assign);
      capture[assign] = normalized;
    });
  }

  _mappingStatus(text, tone = 'info') {
    if (!this._mappingSession?.statusEl) return;
    const statusEl = this._mappingSession.statusEl;
    const palette = {
      info: '#93c5fd',
      warn: '#fbbf24',
      error: '#fca5a5',
      success: '#86efac'
    };
    statusEl.style.color = palette[tone] || palette.info;
    statusEl.textContent = text || '';
  }

  _mappingFieldLabel(key) {
    const labels = {
      balance: 'Balance',
      equity: 'Equity',
      buyButton: 'Buy Button',
      sellButton: 'Sell Button',
      orderInstrument: 'Order Instrument',
      openTab: 'Open Tab',
      pendingTab: 'Pending Tab',
      closedTab: 'Closed Tab',
      container: 'Positions Container',
      closedTradesContainer: 'Closed Trades Container',
      row: 'Active Position Row',
      symbol: 'Symbol',
      side: 'Side',
      volume: 'Volume',
      entryPrice: 'Entry Price',
      currentPrice: 'Current Price',
      stopLoss: 'Stop Loss',
      takeProfit: 'Take Profit',
      pnl: 'P&L',
      closeButton: 'Close Button'
    };
    return labels[key] || key;
  }

  _mappingStepGuidance(step) {
    if (!step) return '';
    const tips = {
      container: 'Pick the main positions table so scanning stays scoped and fast.',
      row: 'Pick one live/open position row from that table (not header).',
      symbol: 'Click the exact symbol text inside the row.',
      side: 'Click Buy/Sell or Long/Short text/icon cell.',
      volume: 'Click lot/size/quantity value.',
      entryPrice: 'Click the open or entry price value.',
      currentPrice: 'Click the current/mark price value.',
      openTab: 'Map tab labels to avoid false close/open signals.',
      pendingTab: 'Map pending tab so pending orders are not treated as active trades.',
      closedTab: 'Map closed/history tab to ignore historical positions.',
      closedTradesContainer: 'Optional but recommended if closed and open rows share similar DOM.'
    };
    return tips[step.key] || 'Click the exact value element (avoid wrappers if possible).';
  }

  _setMappingAiHint(text, visible = true) {
    const aiEl = this._mappingSession?.aiHintEl;
    if (!(aiEl instanceof HTMLElement)) return;
    aiEl.textContent = text || '';
    aiEl.style.display = visible ? 'block' : 'none';
  }

  _isVisibleMapperRow(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (!el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    return text.length >= 4;
  }

  _looksHeaderLikeRow(rowEl) {
    if (!(rowEl instanceof HTMLElement)) return false;
    if (rowEl.querySelector('th,[role="columnheader"]')) return true;
    const text = (rowEl.innerText || rowEl.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!text) return false;
    const hasHeaderWords = /\b(symbol|type|side|volume|open|entry|current|price|p\/?l|profit|position|time)\b/.test(text);
    const numericCount = (text.match(/[+-]?\d[\d,]*(?:\.\d+)?/g) || []).length;
    return hasHeaderWords && numericCount === 0;
  }

  _isLikelyTradeRowForVerify(rowEl, capture) {
    if (!(rowEl instanceof HTMLElement)) return false;
    if (this._looksHeaderLikeRow(rowEl)) return false;
    const selectors = [
      capture?.fields?.symbol?.selector,
      capture?.fields?.side?.selector,
      capture?.fields?.volume?.selector,
      capture?.fields?.currentPrice?.selector || capture?.fields?.entryPrice?.selector
    ].filter((s) => typeof s === 'string' && s.length > 0);
    if (selectors.length === 0) return true;
    let matched = 0;
    selectors.forEach((sel) => {
      const value = this._readScopedText(rowEl, sel);
      if (value && value.length > 0) matched += 1;
    });
    return matched >= Math.min(2, selectors.length);
  }

  _readScopedText(scopeEl, selector) {
    if (!(scopeEl instanceof HTMLElement) || !selector || typeof selector !== 'string') return null;
    try {
      const node = scopeEl.querySelector(selector);
      if (!(node instanceof HTMLElement)) return null;
      return (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim() || null;
    } catch (_err) {
      return null;
    }
  }

  _verifyMappingRows(capture, maxRows = 3) {
    const checks = [];
    const container = capture?.containerEl instanceof HTMLElement ? capture.containerEl : null;
    const rowSelector = capture?.rowSelector;
    if (!container || !rowSelector) {
      checks.push({
        id: 'rows.available',
        label: 'Visible rows sampled',
        passed: false,
        details: 'Container/row selector missing',
        blocking: true
      });
      return checks;
    }

    let rows = [];
    try {
      rows = Array.from(container.querySelectorAll(rowSelector)).filter((r) => this._isVisibleMapperRow(r));
      const likelyRows = rows.filter((r) => this._isLikelyTradeRowForVerify(r, capture));
      if (likelyRows.length > 0) rows = likelyRows;
    } catch (_err) {
      rows = [];
    }
    const sampleRows = rows.slice(0, Math.max(1, maxRows));
    checks.push({
      id: 'rows.available',
      label: 'Visible rows sampled',
      passed: sampleRows.length > 0,
      details: `${sampleRows.length}/${Math.min(rows.length || sampleRows.length, maxRows)} rows`,
      blocking: true
    });
    if (sampleRows.length === 0) return checks;

    const symbolSelector = capture?.fields?.symbol?.selector || null;
    const sideSelector = capture?.fields?.side?.selector || null;
    const priceSelector =
      capture?.fields?.currentPrice?.selector || capture?.fields?.entryPrice?.selector || null;
    const requiredPasses = Math.min(2, sampleRows.length);

    const symbolPasses = sampleRows.reduce((acc, row) => {
      const value = this._readScopedText(row, symbolSelector);
      if (!value) return acc;
      return /^[A-Z0-9._:/-]{3,24}$/.test(value.replace(/\s+/g, '')) ? acc + 1 : acc;
    }, 0);
    checks.push({
      id: 'rows.symbol',
      label: 'Symbol sanity',
      passed: symbolPasses >= requiredPasses,
      details: `${symbolPasses}/${sampleRows.length} rows`,
      blocking: true
    });

    const sidePasses = sampleRows.reduce((acc, row) => {
      const value = this._readScopedText(row, sideSelector);
      if (!value) return acc;
      return /\b(buy|sell|long|short)\b/i.test(value) ? acc + 1 : acc;
    }, 0);
    checks.push({
      id: 'rows.side',
      label: 'Side sanity',
      passed: sidePasses >= requiredPasses,
      details: `${sidePasses}/${sampleRows.length} rows`,
      blocking: true
    });

    const pricePasses = sampleRows.reduce((acc, row) => {
      const value = this._readScopedText(row, priceSelector);
      if (!value) return acc;
      return /[+-]?\d[\d,]*(?:\.\d+)?/.test(value) ? acc + 1 : acc;
    }, 0);
    checks.push({
      id: 'rows.price',
      label: 'Price sanity',
      passed: pricePasses >= requiredPasses,
      details: `${pricePasses}/${sampleRows.length} rows`,
      blocking: true
    });

    return checks;
  }

  _verifyMappingTabs(capture) {
    const checks = [];
    const openSel = capture?.openTabSelector || null;
    const closedSel = capture?.closedTabSelector || null;
    const pendingSel = capture?.pendingTabSelector || null;
    const closedContainerSel = capture?.closedTradesContainerSelector || null;
    const openContainerSel = capture?.containerSelector || null;

    const openResolved = openSel ? document.querySelector(openSel) : null;
    const closedResolved = closedSel ? document.querySelector(closedSel) : null;
    const pendingResolved = pendingSel ? document.querySelector(pendingSel) : null;
    const tabsDisambiguateOpenClosed =
      !!openSel &&
      !!closedSel &&
      openSel !== closedSel &&
      !!openResolved &&
      !!closedResolved &&
      openResolved !== closedResolved;

    checks.push({
      id: 'tabs.openClosedDistinct',
      label: 'Open/Closed tabs distinct',
      passed:
        !openSel ||
        !closedSel ||
        (openSel !== closedSel && openResolved !== closedResolved && !!openResolved && !!closedResolved),
      details: openSel && closedSel ? 'both mapped and distinct' : 'optional mapping not fully provided',
      blocking: false
    });

    checks.push({
      id: 'tabs.pendingDistinct',
      label: 'Pending tab distinct',
      passed:
        !pendingSel ||
        (!openSel || pendingSel !== openSel) ||
        (!closedSel || pendingSel !== closedSel),
      details: pendingSel ? (pendingResolved ? 'resolved' : 'selector did not resolve') : 'not provided',
      blocking: false
    });

    const closedWrapsOpen = this._closedTradesSectionWrapsOpenContainer(closedContainerSel, openContainerSel);
    const closedContainerConflictAllowed = !!closedWrapsOpen && tabsDisambiguateOpenClosed;
    checks.push({
      id: 'tabs.closedContainerSafe',
      label: 'Closed container does not wrap open',
      passed: !closedContainerSel || !closedWrapsOpen || closedContainerConflictAllowed,
      details: !closedContainerSel
        ? 'not provided'
        : closedContainerConflictAllowed
          ? 'shared container allowed because open/closed tabs are mapped'
          : closedWrapsOpen
            ? 'conflict detected'
            : 'safe',
      blocking: !!closedContainerSel && !!closedWrapsOpen && !closedContainerConflictAllowed
    });

    return checks;
  }

  _verifyMappingBeforeSave(capture) {
    const checks = [...this._verifyMappingRows(capture, 3), ...this._verifyMappingTabs(capture)];
    const blockingFailures = checks.filter((c) => c.blocking && !c.passed).map((c) => c.id);
    return {
      ok: blockingFailures.length === 0,
      checks,
      blockingFailures
    };
  }

  _formatVerificationMatrix(verification, heading = '') {
    const checks = Array.isArray(verification?.checks) ? verification.checks : [];
    const passedCount = checks.filter((c) => c.passed).length;
    const lines = [];
    if (heading) lines.push(heading);
    lines.push(`Verification: ${passedCount}/${checks.length} checks passed`);
    checks.forEach((c) => {
      lines.push(`${c.passed ? '[PASS]' : '[FAIL]'} ${c.label} - ${c.details || 'n/a'}`);
    });
    if (Array.isArray(verification?.blockingFailures) && verification.blockingFailures.length > 0) {
      lines.push('Next step: remap failed required fields, then run verify again.');
    }
    return lines.join('\n');
  }

  _rowFieldKeys() {
    return [
      'symbol',
      'side',
      'volume',
      'entryPrice',
      'currentPrice',
      'stopLoss',
      'takeProfit',
      'pnl',
      'closeButton'
    ];
  }

  /** Exness-style row ids in data-test — normalize before persisting order_profile.rowSelector. */
  _normalizeCapturedRowSelectorForSave(capture) {
    if (!capture?.rowSelector || typeof window.OrderTableTracker?.normalizeDynamicRowSelector !== 'function') {
      return;
    }
    capture.rowSelector = window.OrderTableTracker.normalizeDynamicRowSelector(capture.rowSelector);
  }

  _buildCanonicalSelectorsForStorage(capture) {
    const rowFields = this._rowFieldKeys();
    const fieldBindings = {};
    const fieldSelectors = {};
    const absoluteFieldSelectors = {};

    rowFields.forEach((k) => {
      const v = capture?.fields?.[k];
      if (!v?.selector) return;
      fieldBindings[k] = {
        selector: v.selector,
        confidence: v.confidence || 0.95,
        source: v.source || 'guided_mapping'
      };
      fieldSelectors[k] = v.selector;
      absoluteFieldSelectors[k] = v.absolute || v.selector;
    });

    if (capture?.balanceSelector) fieldSelectors.balance = capture.balanceSelector;
    if (capture?.equitySelector) fieldSelectors.equity = capture.equitySelector;
    if (capture?.buyButtonSelector) fieldSelectors.buyButton = capture.buyButtonSelector;
    if (capture?.sellButtonSelector) fieldSelectors.sellButton = capture.sellButtonSelector;
    if (capture?.openTabSelector) fieldSelectors.openTab = capture.openTabSelector;
    if (capture?.pendingTabSelector) fieldSelectors.pendingTab = capture.pendingTabSelector;
    if (capture?.closedTabSelector) fieldSelectors.closedTab = capture.closedTabSelector;
    if (capture?.closeButtonSelector) fieldSelectors.closeButton = capture.closeButtonSelector;
    if (capture?.containerSelector) fieldSelectors.container = capture.containerSelector;
    if (capture?.orderInstrumentSelector) fieldSelectors.orderInstrument = capture.orderInstrumentSelector;

    if (capture?.balanceSelector) absoluteFieldSelectors.balance = capture.balanceSelector;
    if (capture?.equitySelector) absoluteFieldSelectors.equity = capture.equitySelector;
    if (capture?.buyButtonSelector) absoluteFieldSelectors.buyButton = capture.buyButtonSelector;
    if (capture?.sellButtonSelector) absoluteFieldSelectors.sellButton = capture.sellButtonSelector;
    if (capture?.openTabSelector) absoluteFieldSelectors.openTab = capture.openTabSelector;
    if (capture?.pendingTabSelector) absoluteFieldSelectors.pendingTab = capture.pendingTabSelector;
    if (capture?.closedTabSelector) absoluteFieldSelectors.closedTab = capture.closedTabSelector;
    if (capture?.closeButtonSelector) absoluteFieldSelectors.closeButton = capture.closeButtonSelector;
    if (capture?.containerSelector) absoluteFieldSelectors.container = capture.containerSelector;
    if (capture?.orderInstrumentSelector) absoluteFieldSelectors.orderInstrument = capture.orderInstrumentSelector;

    return { fieldBindings, fieldSelectors, absoluteFieldSelectors };
  }

  _validateCanonicalForSave(canonical) {
    const bindings = canonical?.fieldBindings || {};
    // Minimum required row fields for reliable mapped-only crawl.
    const required = ['symbol', 'side'];
    const priceEither = !!(bindings.entryPrice?.selector || bindings.currentPrice?.selector);
    const hasVolume = !!bindings.volume?.selector;
    const missing = required.filter((k) => !bindings[k]?.selector);
    if (!priceEither) missing.push('entry/current price');
    if (!hasVolume) missing.push('volume');
    return {
      ok: missing.length === 0,
      missing
    };
  }

  _teardownMapping() {
    const s = this._mappingSession;
    if (!s) return;
    if (s.cleanupFns) s.cleanupFns.forEach((fn) => fn());
    if (s.overlay?.isConnected) s.overlay.remove();
    if (s.backdrop?.isConnected) s.backdrop.remove();
    this._mappingSession = null;
  }

  async _saveGuidedProfile(capture) {
    if (!chrome?.runtime?.id || !chrome.runtime.sendMessage) return false;
    const host = window.location.hostname;
    const canonical = this._buildCanonicalSelectorsForStorage(capture);
    const selectors = {
      mapping_complete: true,
      mapping_version: 1,
      positions_table: capture.containerSelector,
      ...(capture.balanceSelector ? { balance: capture.balanceSelector } : {}),
      ...(capture.equitySelector ? { equity: capture.equitySelector } : {}),
      ...(capture.buyButtonSelector ? { buy_button: capture.buyButtonSelector } : {}),
      ...(capture.sellButtonSelector ? { sell_button: capture.sellButtonSelector } : {}),
      ...(capture.openTabSelector ? { open_positions_tab: capture.openTabSelector } : {}),
      ...(capture.pendingTabSelector ? { pending_positions_tab: capture.pendingTabSelector } : {}),
      ...(capture.closedTabSelector ? { closed_positions_tab: capture.closedTabSelector } : {}),
      ...(capture.closeButtonSelector ? { close_button: capture.closeButtonSelector } : {}),
      ...(capture.orderInstrumentSelector ? { order_instrument: capture.orderInstrumentSelector } : {}),
      ...(capture.closedTradesContainerSelector
        ? { closed_trades_section: capture.closedTradesContainerSelector }
        : {}),
      order_profile: {
        version: 1,
        host,
        strictMappedMode: true,
        rowSelector: capture.rowSelector || null,
        rowSelectorHint: capture.rowSelectorHint || null,
        headerAliases: {},
        headerMap: {},
        fieldBindings: canonical.fieldBindings,
        negativeRowPatterns: [],
        source: 'guided_mapping',
        lastVerifiedAt: Date.now()
      },
      order_details_identity: {
        selector: capture.containerSelector,
        tag: capture.containerTag || 'div',
        confidence: 999,
        rowCount: 1,
        fieldsDetected: {},
        fieldSelectors: canonical.fieldSelectors,
        absoluteFieldSelectors: canonical.absoluteFieldSelectors,
        host,
        url: window.location.href,
        capturedAt: Date.now(),
        source: 'guided_mapping'
      }
    };
    const normalizedSelectors = this._normalizeMappedSelectorPayload(selectors);
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'TG_SAVE_SELECTORS', payload: { host, selectors: normalizedSelectors } },
        (res) => resolve(!!res?.success)
      );
    });
  }

  _createMapperOverlay() {
    if (!document.getElementById('tg-mapper-styles')) {
      const style = document.createElement('style');
      style.id = 'tg-mapper-styles';
      style.textContent = `
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Outfit:wght@400;500;600;700;800;900&display=swap');
        @keyframes tg-scan {0%{transform:translateY(-100%);opacity:0}10%{opacity:.06}90%{opacity:.06}100%{transform:translateY(400%);opacity:0}}
        @keyframes tg-slide-up {from{transform:translateY(32px);opacity:0}to{transform:translateY(0);opacity:1}}
        @keyframes tg-glow-pulse {0%,100%{box-shadow:0 0 0 0 rgba(0,255,160,0)}50%{box-shadow:0 0 18px 3px rgba(0,255,160,.22)}}
        #tg-mapper-bar * { box-sizing: border-box; }
        #tg-guided-mapper * { font-family: 'Outfit', system-ui, sans-serif; }
        #tg-guided-mapper .tgm-mono { font-family: 'IBM Plex Mono', monospace !important; }
      `;
      document.head.appendChild(style);
    }

    const backdrop = document.createElement('div');
    backdrop.id = 'tg-guided-mapper-backdrop';
    Object.assign(backdrop.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483640',
      pointerEvents: 'none',
      background: 'transparent'
    });
    document.documentElement.appendChild(backdrop);

    const overlay = document.createElement('div');
    // Keep legacy id for compatibility with existing probes/assumptions.
    overlay.id = 'tg-guided-mapper';
    overlay.setAttribute('data-tg-mapper-style', 'bar');
    Object.assign(overlay.style, {
      position: 'fixed',
      bottom: '0',
      left: '0',
      right: '0',
      zIndex: '2147483647',
      fontFamily: '"Outfit", system-ui, sans-serif',
      animation: 'tg-slide-up 0.3s ease both',
      pointerEvents: 'auto'
    });

    const inner = document.createElement('div');
    Object.assign(inner.style, {
      margin: '0 auto',
      background: 'linear-gradient(160deg, rgba(6,12,26,0.97) 0%, rgba(2,6,18,0.99) 100%)',
      borderTop: '1px solid rgba(0,255,160,0.18)',
      borderLeft: '1px solid rgba(0,255,160,0.08)',
      borderRight: '1px solid rgba(0,255,160,0.08)',
      borderRadius: '14px 14px 0 0',
      boxShadow: '0 -12px 60px rgba(0,0,0,0.55)',
      overflow: 'hidden',
      position: 'relative'
    });
    const scanWrap = document.createElement('div');
    scanWrap.style.cssText =
      'position:absolute;inset:0;pointer-events:none;overflow:hidden;border-radius:14px 14px 0 0;';
    const scan = document.createElement('div');
    scan.style.cssText =
      'position:absolute;left:0;right:0;height:40%;background:linear-gradient(180deg,transparent,rgba(0,255,160,0.04),transparent);animation:tg-scan 4s linear infinite;';
    scanWrap.appendChild(scan);
    inner.appendChild(scanWrap);

    const progressTrack = document.createElement('div');
    progressTrack.style.cssText = 'height:2px;background:rgba(255,255,255,0.06);';
    const progressBar = document.createElement('div');
    progressBar.style.cssText =
      'height:100%;width:0%;background:linear-gradient(90deg,#00ffa0,#00d4ff);transition:width .35s ease;';
    progressTrack.appendChild(progressBar);
    inner.appendChild(progressTrack);

    const rowTop = document.createElement('div');
    rowTop.style.cssText =
      'display:flex;align-items:center;padding:11px 18px 10px;border-bottom:1px solid rgba(255,255,255,0.05);gap:0;';
    const brand = document.createElement('div');
    brand.style.cssText = 'display:flex;align-items:center;gap:10px;flex-shrink:0;';
    const logoWrap = document.createElement('div');
    logoWrap.style.cssText =
      'width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#00ffa0,#00c8ff);display:flex;align-items:center;justify-content:center;overflow:hidden;box-shadow:0 0 16px rgba(0,255,160,0.3);flex-shrink:0;';
    const logo = document.createElement('img');
    logo.alt = 'TradeGuardX';
    logo.src =
      chrome?.runtime?.id && typeof chrome.runtime.getURL === 'function'
        ? chrome.runtime.getURL('icons/icon128.png')
        : '';
    logo.style.cssText = 'width:100%;height:100%;object-fit:cover;';
    logo.addEventListener('error', () => {
      logoWrap.textContent = '⚡';
      logoWrap.style.color = '#001a0e';
      logoWrap.style.fontWeight = '800';
      logoWrap.style.fontSize = '16px';
    });
    logoWrap.appendChild(logo);
    const btxt = document.createElement('div');
    btxt.innerHTML =
      '<div style="font-size:15px;font-weight:900;color:#f0fdf8;letter-spacing:-0.01em;line-height:1;font-family:\'Outfit\',system-ui,sans-serif;">Trade<span style="color:#00ffa0;">Guard</span>X</div>'
      + '<div style="font-size:8.5px;font-family:\'IBM Plex Mono\',monospace;color:#2a8060;letter-spacing:0.16em;margin-top:4px;font-weight:600;">AI FIELD MAPPER</div>';
    brand.appendChild(logoWrap);
    brand.appendChild(btxt);
    const div1 = document.createElement('div');
    div1.style.cssText = 'width:1px;height:32px;background:rgba(255,255,255,0.08);margin:0 14px;flex-shrink:0;';
    const stepInfo = document.createElement('div');
    stepInfo.style.cssText = 'flex:1;min-width:0;';
    const badgeRow = document.createElement('div');
    badgeRow.style.cssText = 'display:flex;align-items:center;gap:7px;margin-bottom:3px;';
    const stepReq = document.createElement('div');
    stepReq.style.cssText =
      'font-size:8.5px;font-weight:700;letter-spacing:0.12em;font-family:\'IBM Plex Mono\',monospace;padding:2px 8px;border-radius:5px;background:rgba(6,78,59,.5);border:1px solid rgba(0,255,160,.3);color:#6ee7b7;';
    stepReq.textContent = 'REQUIRED';
    const stepMeta = document.createElement('div');
    stepMeta.style.cssText =
      'font-size:9px;color:#2a6050;font-family:\'IBM Plex Mono\',monospace;letter-spacing:0.1em;font-weight:600;';
    stepMeta.textContent = 'Step 1 / 20';
    badgeRow.appendChild(stepReq);
    badgeRow.appendChild(stepMeta);
    const step = document.createElement('div');
    step.style.cssText =
      'font-size:15px;font-weight:800;color:#d8f5ec;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.25;font-family:\'Outfit\',system-ui,sans-serif;letter-spacing:-0.01em;';
    step.textContent = 'Set up your broker mapping';
    const stepHint = document.createElement('div');
    stepHint.style.cssText =
      'font-size:10.5px;color:#2a6050;margin-top:3px;font-family:\'IBM Plex Mono\',monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:0.03em;';
    stepHint.textContent = '→ Click Start Mapping, then follow each guided step.';
    stepInfo.appendChild(badgeRow);
    stepInfo.appendChild(step);
    stepInfo.appendChild(stepHint);
    const div2 = document.createElement('div');
    div2.style.cssText = 'width:1px;height:32px;background:rgba(255,255,255,0.08);margin:0 14px;flex-shrink:0;';
    const statusWrap = document.createElement('div');
    statusWrap.style.cssText = 'flex-shrink:0;text-align:right;max-width:190px;';
    const status = document.createElement('div');
    status.style.cssText = 'font-size:10.5px;color:#2a6050;font-family:\'IBM Plex Mono\',monospace;line-height:1.4;letter-spacing:0.04em;white-space:pre-line;max-height:140px;overflow:auto;';
    status.textContent = 'Welcome to guided mapping. We will verify everything before save.';
    const captured = document.createElement('div');
    captured.style.cssText =
      'font-size:11px;font-weight:700;color:#00ffa0;font-family:\'IBM Plex Mono\',monospace;margin-top:3px;letter-spacing:0.04em;';
    captured.textContent = '0 of 20 fields captured';
    statusWrap.appendChild(status);
    statusWrap.appendChild(captured);
    const div3 = document.createElement('div');
    div3.style.cssText = 'width:1px;height:32px;background:rgba(255,255,255,0.08);margin:0 14px;flex-shrink:0;';
    const controls = document.createElement('div');
    controls.style.cssText = 'display:flex;gap:6px;flex-shrink:0;';
    const miniBtn = document.createElement('button');
    miniBtn.textContent = '–';
    miniBtn.style.cssText =
      'width:28px;height:28px;border-radius:7px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.04);color:#6a8a80;cursor:pointer;font-size:13px;';
    const dockBtn = document.createElement('button');
    dockBtn.textContent = 'Dock';
    dockBtn.style.cssText =
      'height:28px;padding:0 8px;border-radius:7px;border:1px solid rgba(148,163,184,.2);background:rgba(255,255,255,.04);color:#8ca3a0;cursor:pointer;font-size:11px;display:none;';
    controls.appendChild(dockBtn);
    controls.appendChild(miniBtn);
    rowTop.appendChild(brand);
    rowTop.appendChild(div1);
    rowTop.appendChild(stepInfo);
    rowTop.appendChild(div2);
    rowTop.appendChild(statusWrap);
    rowTop.appendChild(div3);
    rowTop.appendChild(controls);
    inner.appendChild(rowTop);

    const rowBottom = document.createElement('div');
    rowBottom.style.cssText = 'display:flex;align-items:center;padding:9px 16px 11px;';
    const stepsRail = document.createElement('div');
    stepsRail.style.cssText = 'display:flex;gap:4px;flex:1;min-width:0;align-items:center;margin-right:16px;';
    const segmentEls = [];
    const capturedChips = {};
    const chipMeta = [
      ['balance', 'Balance'],
      ['equity', 'Equity'],
      ['buyButton', 'Buy Btn'],
      ['sellButton', 'Sell Btn'],
      ['orderInstrument', 'Order Symbol'],
      ['openTab', 'Open tab'],
      ['pendingTab', 'Pending tab'],
      ['closedTab', 'Closed tab'],
      ['container', 'Positions Section'],
      ['row', 'Row'],
      ['symbol', 'Symbol'],
      ['side', 'Side'],
      ['volume', 'Volume'],
      ['entryPrice', 'Entry'],
      ['currentPrice', 'Mark'],
      ['stopLoss', 'SL'],
      ['takeProfit', 'TP'],
      ['pnl', 'P&L'],
      ['closeButton', 'Close']
    ];
    chipMeta.forEach(([key, label]) => {
      const seg = document.createElement('div');
      seg.style.cssText = 'flex:1;height:4px;border-radius:99px;background:rgba(255,255,255,.07);';
      seg.title = label;
      segmentEls.push(seg);
      stepsRail.appendChild(seg);
      const chip = document.createElement('div');
      chip.style.cssText =
        'padding:4px 10px;border-radius:20px;font-size:9.5px;font-weight:600;font-family:\'IBM Plex Mono\',monospace;letter-spacing:.06em;border:1px solid rgba(255,255,255,.07);background:rgba(6,12,26,.85);color:rgba(255,255,255,.18);cursor:pointer;';
      chip.textContent = `• ${label}`;
      capturedChips[key] = chip;
    });
    stepMeta.textContent = `1 / ${chipMeta.length}`;
    captured.textContent = `0 / ${chipMeta.length} captured`;

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:7px;flex-shrink:0;align-items:center;';
    const backBtn = document.createElement('button');
    backBtn.textContent = '← Back';
    backBtn.disabled = true;
    backBtn.style.cssText =
      'height:34px;padding:0 14px;border-radius:9px;border:1px solid rgba(148,163,184,.18);background:rgba(15,23,42,.6);color:#3a5060;cursor:not-allowed;font-size:12px;font-weight:700;font-family:\'Outfit\',system-ui,sans-serif;opacity:.45;letter-spacing:0.01em;';
    const skipBtn = document.createElement('button');
    skipBtn.textContent = 'Skip →';
    skipBtn.style.cssText =
      'height:34px;padding:0 14px;border-radius:9px;display:none;border:1px solid rgba(59,130,246,.32);background:rgba(30,58,138,.22);color:#93c5fd;cursor:pointer;font-size:12px;font-weight:700;font-family:\'Outfit\',system-ui,sans-serif;letter-spacing:0.01em;';
    const pauseBtn = document.createElement('button');
    pauseBtn.textContent = '⏸ Pause';
    pauseBtn.disabled = true;
    pauseBtn.style.cssText =
      'height:34px;padding:0 14px;border-radius:9px;border:1px solid rgba(251,191,36,.28);background:rgba(120,53,15,.18);color:#fbbf24;cursor:not-allowed;font-size:12px;font-weight:700;font-family:\'Outfit\',system-ui,sans-serif;opacity:.5;letter-spacing:0.01em;';
    const startBtn = document.createElement('button');
    startBtn.textContent = '▶  Start Guided Mapping';
    startBtn.style.cssText =
      'height:36px;padding:0 20px;border-radius:10px;border:none;background:linear-gradient(135deg,#00ffa0,#00d4aa);color:#001a0e;cursor:pointer;font-size:13px;font-weight:900;font-family:\'Outfit\',system-ui,sans-serif;letter-spacing:0.01em;box-shadow:0 4px 18px rgba(0,255,160,.3);animation:tg-glow-pulse 2.5s ease-in-out infinite;';
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = '✕';
    cancelBtn.style.cssText =
      'height:36px;padding:0 13px;border-radius:10px;border:1px solid rgba(239,68,68,.22);background:rgba(127,29,29,.16);color:#f87171;cursor:pointer;font-size:13px;font-weight:700;font-family:\'Outfit\',system-ui,sans-serif;';
    actions.appendChild(backBtn);
    actions.appendChild(skipBtn);
    actions.appendChild(pauseBtn);
    actions.appendChild(startBtn);
    actions.appendChild(cancelBtn);
    rowBottom.appendChild(stepsRail);
    rowBottom.appendChild(actions);
    inner.appendChild(rowBottom);

    const aiHint = document.createElement('div');
    aiHint.style.cssText =
      'display:none;padding:10px 18px;border-top:1px solid rgba(167,139,250,.14);background:rgba(76,29,149,.1);font-size:11.5px;color:#c4b5fd;font-family:\'IBM Plex Mono\',monospace;letter-spacing:0.04em;';
    aiHint.textContent = 'TradeGuardX AI assistant: validating selectors and filling safe gaps...';
    inner.appendChild(aiHint);

    overlay.appendChild(inner);
    document.documentElement.appendChild(overlay);

    const reopenBtn = document.createElement('button');
    reopenBtn.type = 'button';
    reopenBtn.innerHTML = '<span style="font-size:13px;line-height:1;">⚡</span><span style="font-family:\'Outfit\',system-ui,sans-serif;font-size:12px;font-weight:800;letter-spacing:0.02em;">Resume Guided Mapping</span>';
    reopenBtn.style.cssText =
      'position:fixed;bottom:18px;right:18px;z-index:2147483647;display:none;padding:9px 16px;background:linear-gradient(135deg,rgba(6,12,26,.98),rgba(2,6,18,.99));border:1px solid rgba(0,255,160,.32);border-radius:24px;color:#00ffa0;font-size:12px;font-weight:800;cursor:pointer;box-shadow:0 8px 28px rgba(0,0,0,.55),0 0 0 1px rgba(0,255,160,.08);gap:7px;display:none;align-items:center;';
    document.documentElement.appendChild(reopenBtn);

    const subtitle = document.createElement('div');
    subtitle.style.display = 'none';
    const helper = document.createElement('div');
    helper.style.display = 'none';
    const stepReqEl = stepReq;
    const progressSegmentsEl = stepsRail;

    return {
      backdrop,
      overlay,
      stepEl: step,
      stepHintEl: stepHint,
      stepReqEl,
      stepMetaEl: stepMeta,
      progressEl: progressBar,
      progressSegEls: segmentEls,
      statusEl: status,
      subtitleEl: subtitle,
      progressSegmentsEl,
      aiHintEl: aiHint,
      chipsWrapEl: null,
      helperEl: null,
      capturedEl: captured,
      capturedChips,
      dragHandle: rowTop,
      startBtn,
      backBtn,
      pauseBtn,
      dockBtn,
      miniBtn,
      cancelBtn,
      skipBtn,
      reopenBtn
    };
  }

  startGuidedPlatformMapping() {
    if (!document.body) return Promise.reject(new Error('Document body not ready'));
    if (!this.detector) return Promise.reject(new Error('Detector unavailable'));
    const ensureMapperBeacon = (overlayEl, reopenBtnEl) => {
      const isVisible = () => {
        if (!(overlayEl instanceof HTMLElement) || !overlayEl.isConnected) return false;
        const style = window.getComputedStyle(overlayEl);
        const r = overlayEl.getBoundingClientRect();
        return !(
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          Number(style.opacity || '1') === 0 ||
          r.width < 40 ||
          r.height < 20
        );
      };
      const ensureBeaconButton = () => {
        let beacon = document.getElementById('tg-mapper-visibility-beacon');
        if (!beacon) {
          beacon = document.createElement('button');
          beacon.id = 'tg-mapper-visibility-beacon';
          beacon.innerHTML = '<span style="all:initial!important;font-size:13px!important;line-height:1!important">⚡</span><span style="all:initial!important;font-family:Outfit,system-ui,sans-serif!important;font-size:12px!important;font-weight:800!important;letter-spacing:0.01em!important">Open Mapper</span>';
          beacon.style.cssText = [
            'all: initial !important',
            'position: fixed !important',
            'right: 18px !important',
            'bottom: 64px !important',
            'left: auto !important',
            'top: auto !important',
            'transform: none !important',
            'z-index: 2147483647 !important',
            'display: flex !important',
            'align-items: center !important',
            'gap: 7px !important',
            'font-family: Outfit,system-ui,sans-serif !important',
            'font-size: 12px !important',
            'font-weight: 800 !important',
            'color: #001a0e !important',
            'background: linear-gradient(135deg,#00ffa0 0%,#00d4ff 100%) !important',
            'border: none !important',
            'border-radius: 12px !important',
            'padding: 9px 15px !important',
            'cursor: pointer !important',
            'box-shadow: 0 8px 28px rgba(0,255,160,0.28), 0 2px 8px rgba(0,0,0,0.5) !important',
            'letter-spacing: 0.01em !important'
          ].join(';');
          beacon.addEventListener('click', () => {
            if (overlayEl instanceof HTMLElement) {
              resetMapperLayout(overlayEl);
              overlayEl.style.display = 'block';
              overlayEl.style.visibility = 'visible';
              overlayEl.style.opacity = '1';
            }
            if (reopenBtnEl instanceof HTMLElement) reopenBtnEl.style.display = 'none';
            beacon.remove();
          });
          document.documentElement.appendChild(beacon);
        }
      };
      setTimeout(() => {
        const visibleNow = isVisible();
        if (!visibleNow) {
          if (reopenBtnEl instanceof HTMLElement) reopenBtnEl.style.display = 'block';
          ensureBeaconButton();
        } else {
          const beacon = document.getElementById('tg-mapper-visibility-beacon');
          if (beacon) beacon.remove();
          if (reopenBtnEl instanceof HTMLElement) reopenBtnEl.style.display = 'none';
        }
      }, 120);
    };
    const resetMapperLayout = (overlayEl) => {
      if (!(overlayEl instanceof HTMLElement)) return;
      overlayEl.style.left = '0';
      overlayEl.style.right = '0';
      overlayEl.style.top = 'auto';
      overlayEl.style.bottom = '0';
      overlayEl.style.transform = 'translateY(0)';
      overlayEl.style.width = 'auto';
      overlayEl.style.maxWidth = 'none';
      overlayEl.style.maxHeight = 'none';
      overlayEl.style.opacity = '1';
      overlayEl.style.visibility = 'visible';
    };
    if (this._mappingSession) {
      const overlay = this._mappingSession.overlay;
      if (overlay instanceof HTMLElement && overlay.isConnected) {
        try {
          const rect = overlay.getBoundingClientRect();
          const style = window.getComputedStyle(overlay);
          const isEffectivelyHidden =
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            Number(style.opacity || '1') === 0 ||
            rect.width < 40 ||
            rect.height < 20;
          if (isEffectivelyHidden) {
            this._teardownMapping();
          } else {
          resetMapperLayout(overlay);
          // If mapper exists but is minimized/hidden, force it visible.
          overlay.style.display = 'block';
          if (this._mappingSession.backdrop instanceof HTMLElement) {
            this._mappingSession.backdrop.style.display = 'block';
          }
          if (this._mappingSession.reopenBtn instanceof HTMLElement) {
            this._mappingSession.reopenBtn.style.display = 'none';
          }
          if (this._mappingSession.guide instanceof HTMLElement) {
            this._mappingSession.guide.style.display = 'block';
          }
          overlay.scrollIntoView({ block: 'nearest' });
          overlay.style.outline = '2px solid rgba(34,211,238,0.9)';
          setTimeout(() => {
            if (overlay.isConnected) overlay.style.outline = '';
          }, 900);
          ensureMapperBeacon(overlay, this._mappingSession.reopenBtn);
          return Promise.resolve();
          }
        } catch (_err) {
          // If visibility probing fails, rebuild mapper from scratch.
          this._teardownMapping();
        }
      }
      if (this._mappingSession) this._teardownMapping();
    }
    return new Promise((resolve) => {
      const mappingReadyResolve = resolve;
    const ui = this._createMapperOverlay();
    resetMapperLayout(ui.overlay);
    const highlight = document.createElement('div');
    Object.assign(highlight.style, {
      position: 'fixed',
      zIndex: '2147483646',
      pointerEvents: 'none',
      border: '2px solid #22d3ee',
      background: 'rgba(34,211,238,0.08)',
      borderRadius: '8px',
      display: 'none'
    });
    document.documentElement.appendChild(highlight);

    const guide = document.createElement('button');
    guide.type = 'button';
    guide.style.cssText = [
      'all: initial !important',
      'position: fixed !important',
      'left: 50% !important',
      'top: 16px !important',
      'transform: translateX(-50%) !important',
      'z-index: 2147483647 !important',
      'max-width: 88vw !important',
      'font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif !important',
      'border: 1px solid rgba(56,189,248,0.34) !important',
      'background: linear-gradient(180deg, rgba(2,6,23,0.95), rgba(15,23,42,0.95)) !important',
      'color: #e2e8f0 !important',
      'border-radius: 12px !important',
      'padding: 8px 12px !important',
      'cursor: pointer !important',
      'box-shadow: 0 12px 30px rgba(0,0,0,0.45) !important',
      'display: none !important'
    ].join(';');
    const guideTitle = document.createElement('div');
    guideTitle.style.cssText = 'font-size:11px;color:#67e8f9;letter-spacing:0.08em;font-weight:700;';
    guideTitle.textContent = 'GUIDED MAPPING';
    const guideStep = document.createElement('div');
    guideStep.style.cssText = 'font-size:13px;font-weight:700;color:#e2e8f0;margin-top:2px;';
    const guideHint = document.createElement('div');
    guideHint.style.cssText = 'font-size:11px;color:#93c5fd;margin-top:2px;';
    guide.appendChild(guideTitle);
    guide.appendChild(guideStep);
    guide.appendChild(guideHint);
    document.documentElement.appendChild(guide);

    const steps = [
      { key: 'balance', label: 'Point to wallet/balance value', required: false, scope: 'global' },
      { key: 'equity', label: 'Point to equity value (optional)', required: false, scope: 'global' },
      { key: 'buyButton', label: 'Point to BUY button (optional)', required: false, scope: 'global' },
      { key: 'sellButton', label: 'Point to SELL button (optional)', required: false, scope: 'global' },
      {
        key: 'orderInstrument',
        label:
          'Point to order-ticket instrument (e.g. ETH near Buy/Sell) — optional; avoids wrong symbol from nearby labels',
        required: false,
        scope: 'global'
      },
      {
        key: 'openTab',
        label:
          'Point to the OPEN POSITIONS tab button — required so we know when you are viewing active positions vs. history.',
        required: true,
        scope: 'global'
      },
      {
        key: 'pendingTab',
        label: 'Point to PENDING tab button (optional; avoids counting pending rows as open trades)',
        required: false,
        scope: 'global'
      },
      {
        key: 'closedTab',
        label:
          'Point to the CLOSED TRADES / HISTORY tab button — required so switching to history does not fire a false close event.',
        required: true,
        scope: 'global'
      },
      {
        key: 'container',
        label:
          'Point to the section that lists your ACTIVE positions — every other table on this page (open orders, closed trades, order history) will be ignored.',
        required: true,
        scope: 'global'
      },
      { key: 'row', label: 'Point to one active position row in that container', required: true, scope: 'container' },
      { key: 'symbol', label: 'Point to Symbol value in that row', required: false, scope: 'row' },
      { key: 'side', label: 'Point to Side value in that row', required: false, scope: 'row' },
      { key: 'volume', label: 'Point to Volume/Size value in that row', required: false, scope: 'row' },
      { key: 'entryPrice', label: 'Point to Entry/Open price value in that row', required: false, scope: 'row' },
      { key: 'currentPrice', label: 'Point to Current/Mark price value in that row', required: false, scope: 'row' },
      { key: 'stopLoss', label: 'Point to Stop Loss value (optional)', required: false, scope: 'row' },
      { key: 'takeProfit', label: 'Point to Take Profit value (optional)', required: false, scope: 'row' },
      { key: 'pnl', label: 'Point to P&L value (optional)', required: false, scope: 'row' },
      { key: 'closeButton', label: 'Point to Close button in row (optional)', required: false, scope: 'row' }
    ];
    const capture = { fields: {} };
    let stepIdx = 0;
    let captureActive = false;
    let capturePaused = false;
    let isMinimized = false;
    let isDocked = false;
    const rowLikeSelector =
      'tr,[role="row"],li,[data-row],[data-row-id],div[role="row"],div[class*="row"],div[data-index]';
    const containerHintSelector = 'table,tbody,[role="table"],[class*="positions"],[class*="position"],[class*="trades"],[class*="trade"],[class*="orders"],[class*="order"],section,div';

    const cleanupFns = [];
    const countCapturedFields = () =>
      Object.values(capture.fields || {}).filter((v) => !!(v && v.selector)).length;

    const isStepCaptured = (key) => {
      if (key === 'container') return !!capture.containerSelector;
      if (key === 'closedTradesContainer') return !!capture.closedTradesContainerSelector;
      if (key === 'row') return !!capture.rowSelector;
      return !!capture.fields?.[key]?.selector;
    };

    const clearStepCapture = (key) => {
      if (!key) return;
      if (key === 'container') {
        capture.containerEl = null;
        capture.containerSelector = null;
        capture.containerTag = null;
        capture.closedTradesContainerEl = null;
        capture.closedTradesContainerSelector = null;
        capture.rowEl = null;
        capture.rowSelector = null;
        capture.rowSelectorHint = null;
        return;
      }
      if (key === 'closedTradesContainer') {
        capture.closedTradesContainerEl = null;
        capture.closedTradesContainerSelector = null;
        return;
      }
      if (key === 'row') {
        capture.rowEl = null;
        capture.rowSelector = null;
        capture.rowSelectorHint = null;
        return;
      }
      capture.fields[key] = null;
    };

    const syncControls = () => {
      const s = steps[stepIdx];
      if (!s) return;
      ui.skipBtn.style.display = !captureActive || s.required ? 'none' : 'inline-block';
      ui.skipBtn.textContent = s.required ? 'Skip' : 'Skip Optional';
      ui.backBtn.disabled = !captureActive || stepIdx === 0;
      ui.backBtn.style.opacity = ui.backBtn.disabled ? '0.5' : '1';
      ui.pauseBtn.disabled = !captureActive;
      ui.pauseBtn.style.opacity = ui.pauseBtn.disabled ? '0.5' : '1';
      ui.pauseBtn.style.cursor = ui.pauseBtn.disabled ? 'not-allowed' : 'pointer';
      ui.pauseBtn.textContent = capturePaused ? 'Resume Mapping' : 'Pause Mapping';
      ui.capturedEl.textContent = `${countCapturedFields()} of ${steps.length} fields captured`;
      if (capturePaused) {
        ui.pauseBtn.style.borderColor = 'rgba(34,197,94,0.55)';
        ui.pauseBtn.style.background = 'rgba(22,163,74,0.2)';
        ui.pauseBtn.style.color = '#bbf7d0';
      } else {
        ui.pauseBtn.style.borderColor = 'rgba(245,158,11,0.55)';
        ui.pauseBtn.style.background = 'rgba(146,64,14,0.2)';
        ui.pauseBtn.style.color = '#fde68a';
      }
      if (ui.dockBtn) {
        ui.dockBtn.textContent = isDocked ? 'Expand View' : 'Dock View';
      }
      // During active capture, keep page visible and interactive.
      ui.backdrop.style.display = captureActive && !capturePaused && !isMinimized ? 'none' : 'block';
      if (ui.capturedChips) {
        steps.forEach((st, idx) => {
          const chip = ui.capturedChips[st.key];
          if (!chip) return;
          const done = isStepCaptured(st.key);
          const active = idx === stepIdx && captureActive && !capturePaused;
          if (done) {
            chip.style.background = 'rgba(5,150,105,0.22)';
            chip.style.borderColor = 'rgba(16,185,129,0.5)';
            chip.style.color = '#6ee7b7';
            chip.style.opacity = '1';
          } else if (active) {
            chip.style.background = 'rgba(14,116,144,0.24)';
            chip.style.borderColor = 'rgba(34,211,238,0.55)';
            chip.style.color = '#67e8f9';
            chip.style.opacity = '1';
          } else {
            chip.style.background = 'rgba(15,23,42,0.38)';
            chip.style.borderColor = 'rgba(148,163,184,0.2)';
            chip.style.color = '#94a3b8';
            chip.style.opacity = '0.72';
          }
        });
      }
    };

    const applyDockMode = (nextDocked) => {
      isDocked = !!nextDocked;
      if (isDocked) {
        ui.overlay.style.left = 'auto';
        ui.overlay.style.top = '14px';
        ui.overlay.style.right = '14px';
        ui.overlay.style.transform = 'none';
        ui.overlay.style.width = '360px';
        ui.overlay.style.maxHeight = '78vh';
        ui.overlay.style.opacity = '0.97';
        if (ui.progressSegmentsEl) ui.progressSegmentsEl.style.display = 'none';
        if (ui.aiHintEl) ui.aiHintEl.style.display = 'none';
        if (ui.chipsWrapEl) {
          ui.chipsWrapEl.style.display = 'grid';
          ui.chipsWrapEl.style.gridTemplateColumns = 'repeat(2,minmax(0,1fr))';
        }
        if (ui.helperEl) ui.helperEl.style.display = 'none';
        if (ui.subtitleEl) ui.subtitleEl.style.display = 'none';
      } else {
        ui.overlay.style.left = '50%';
        ui.overlay.style.top = '50%';
        ui.overlay.style.right = 'auto';
        ui.overlay.style.transform = 'translate(-50%, -50%)';
        ui.overlay.style.width = '680px';
        ui.overlay.style.maxHeight = '88vh';
        ui.overlay.style.opacity = '1';
        if (ui.progressSegmentsEl) ui.progressSegmentsEl.style.display = 'grid';
        if (ui.aiHintEl) ui.aiHintEl.style.display = 'block';
        if (ui.chipsWrapEl) {
          ui.chipsWrapEl.style.display = 'grid';
          ui.chipsWrapEl.style.gridTemplateColumns = 'repeat(3,minmax(0,1fr))';
        }
        if (ui.helperEl) ui.helperEl.style.display = 'block';
        if (ui.subtitleEl) ui.subtitleEl.style.display = 'block';
      }
      syncControls();
    };

    const setMinimized = (next) => {
      isMinimized = !!next;
      if (isMinimized) {
        ui.overlay.style.display = 'none';
        ui.backdrop.style.display = 'none';
        ui.reopenBtn.style.display = 'block';
        guide.style.display = 'block';
        highlight.style.display = 'none';
        capturePaused = true;
      } else {
        ui.overlay.style.display = 'block';
        ui.backdrop.style.display = 'block';
        ui.reopenBtn.style.display = 'none';
        if (captureActive) guide.style.display = 'block';
      }
      syncControls();
    };

    const setStepText = () => {
      const s = steps[stepIdx];
      if (!s) return;
      const modeLabel = !captureActive ? 'Ready' : capturePaused ? 'Paused' : 'Capturing';
      ui.stepMetaEl.textContent = `Step ${stepIdx + 1} / ${steps.length} · ${modeLabel}`;
      ui.stepReqEl.textContent = s.required ? 'REQUIRED' : 'OPTIONAL';
      ui.stepReqEl.style.color = s.required ? '#6ee7b7' : '#93c5fd';
      ui.stepReqEl.style.background = s.required ? 'rgba(6,78,59,0.35)' : 'rgba(30,64,175,0.22)';
      ui.stepReqEl.style.borderColor = s.required ? 'rgba(52,211,153,0.35)' : 'rgba(59,130,246,0.35)';
      const shortLabel = this._mappingFieldLabel(s.key);
      const label = String(s.label || '').replace(/^Point to\s*/i, '');
      ui.stepEl.textContent = shortLabel;
      ui.stepHintEl.textContent = `→ ${this._mappingStepGuidance(s)}`;
      guideStep.textContent = `${s.required ? 'Required' : 'Optional'} · ${label}`;
      guideHint.textContent = capturePaused
        ? 'Paused. Click Resume Mapping when you are ready.'
        : `Step ${stepIdx + 1}/${steps.length} · Click the exact element on the broker page.`;
      const pct = Math.max(0, Math.min(100, ((stepIdx + 1) / steps.length) * 100));
      ui.progressEl.style.width = `${pct}%`;
      if (Array.isArray(ui.progressSegEls)) {
        ui.progressSegEls.forEach((seg, idx) => {
          if (idx < stepIdx + 1) {
            seg.style.background = idx === stepIdx ? '#22d3ee' : 'rgba(16,185,129,0.95)';
          } else {
            seg.style.background = 'rgba(100,116,139,0.35)';
          }
        });
      }
      syncControls();
    };
    setStepText();
    this._mappingStatus('Click "Start Guided Mapping" to begin.', 'info');

    const updateHighlight = (el) => {
      if (!(el instanceof HTMLElement) || !el.isConnected) {
        highlight.style.display = 'none';
        return;
      }
      const r = el.getBoundingClientRect();
      highlight.style.left = `${r.left}px`;
      highlight.style.top = `${r.top}px`;
      highlight.style.width = `${r.width}px`;
      highlight.style.height = `${r.height}px`;
      highlight.style.display = 'block';
    };
    // Use a lightweight rAF throttle for highlight movement so the
    // selector box tracks the cursor smoothly, especially on Windows.
    let highlightRafId = null;
    let lastMouseEvent = null;
    let lastHighlightX = null;
    let lastHighlightY = null;

    const processHighlightMove = () => {
      highlightRafId = null;
      const evt = lastMouseEvent;
      lastMouseEvent = null;
      if (!evt) return;
      if (!this._mappingSession) return;
      // Skip heavy highlight work while dragging the mapper bar,
      // otherwise dragging can feel laggy/janky.
      if (dragActive) return;
      if (!captureActive) return;
      if (capturePaused || isMinimized) return;
      const el = document.elementFromPoint(evt.clientX, evt.clientY);
      if (el && !ui.overlay.contains(el) && el !== highlight) {
        updateHighlight(el);
      } else {
        // When hovering near or over the mapper popup itself (overlay),
        // hide the selector instead of leaving it stuck on an old element,
        // which can look like it "jumps far away" from the cursor.
        updateHighlight(null);
      }
      lastHighlightX = evt.clientX;
      lastHighlightY = evt.clientY;
    };

    const onMouseMove = (e) => {
      lastMouseEvent = e;
      if (highlightRafId == null) {
        highlightRafId = window.requestAnimationFrame(processHighlightMove);
      }
    };

    // Draggable mapper bar (drag from top row)
    let dragActive = false;
    let dragMoved = false;
    let userMovedOverlay = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragOverlayLeft = 0;
    let dragOverlayTop = 0;
    let suppressMappingClickUntil = 0;
    const DRAG_THRESHOLD_PX = 3;

    const onDragMove = (e) => {
      if (!dragActive) return;
      // Prevent page text selection / native drag for smoother movement (notably on Windows)
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      if (!dragMoved) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        dragMoved = true;
      }
      ui.overlay.style.left = `${dragOverlayLeft + dx}px`;
      ui.overlay.style.top = `${dragOverlayTop + dy}px`;
      ui.overlay.style.right = 'auto';
      ui.overlay.style.bottom = 'auto';
    };

    const onDragUp = () => {
      if (!dragActive) return;
      if (dragMoved) {
        userMovedOverlay = true;
        // After a real drag, ignore the next capture click caused by mouseup.
        suppressMappingClickUntil = Date.now() + 320;
      }
      dragActive = false;
      dragMoved = false;
      document.removeEventListener('mousemove', onDragMove, true);
      document.removeEventListener('mouseup', onDragUp, true);
    };

    const onDragDown = (e) => {
      if (e.button !== 0) return;
      const target = e.target;
      if (
        target instanceof HTMLElement &&
        target.closest('button, a, input, select, textarea, [role="button"], [data-no-drag="true"]')
      ) {
        return;
      }
      // Avoid text selection and other default behaviors while starting drag
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      dragActive = true;
      dragMoved = false;
      const rect = ui.overlay.getBoundingClientRect();
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      dragOverlayLeft = rect.left;
      dragOverlayTop = rect.top;
      ui.overlay.style.left = `${rect.left}px`;
      ui.overlay.style.top = `${rect.top}px`;
      ui.overlay.style.right = 'auto';
      ui.overlay.style.bottom = '0';
      ui.overlay.style.transform = 'none';
      document.addEventListener('mousemove', onDragMove, true);
      document.addEventListener('mouseup', onDragUp, true);
    };

    const advance = () => {
      stepIdx += 1;
      if (stepIdx >= steps.length) {
        finalize();
        return;
      }
      setStepText();
      this._mappingStatus('', 'info');
    };

    const onStart = () => {
      if (captureActive) return;
      captureActive = true;
      // Preserve current user-adjusted panel size/position instead of forcing full-width reset.
      if (!userMovedOverlay && !isDocked) {
        resetMapperLayout(ui.overlay);
      }
      // After starting, visually de‑emphasize Start and enable Pause
      ui.startBtn.disabled = true;
      ui.startBtn.style.opacity = '0.6';
      ui.startBtn.style.cursor = 'default';
      ui.startBtn.textContent = 'Mapping In Progress';
      guide.style.display = 'block';
      this._mappingStatus(
        'Guided mapping started. Click the highlighted field on your broker page.',
        'info'
      );
      setStepText();
    };

    const onBack = () => {
      if (!captureActive || stepIdx <= 0) return;
      const prev = steps[stepIdx - 1];
      if (prev) clearStepCapture(prev.key);
      stepIdx -= 1;
      this._mappingStatus(
        `Moved back to ${this._mappingFieldLabel(steps[stepIdx].key)}. Click again to update it.`,
        'info'
      );
      setStepText();
    };

    const onPause = () => {
      if (!captureActive) return;
      capturePaused = !capturePaused;
      highlight.style.display = 'none';
      this._mappingStatus(
        capturePaused
          ? 'Mapping paused. You can interact with the page now.'
          : 'Mapping resumed. Click the exact value for this step.'
        ,
        capturePaused ? 'warn' : 'info'
      );
      setStepText();
    };

    const onMinimize = () => {
      if (!captureActive) return;
      setMinimized(true);
      this._mappingStatus('Mapper minimized. Use "Resume Mapping" to continue.', 'warn');
    };

    const onReopen = () => {
      setMinimized(false);
      this._mappingStatus('Mapper restored. Continue from your current step.', 'info');
      if (captureActive) {
        capturePaused = false;
      }
      guide.style.display = captureActive ? 'block' : 'none';
      setStepText();
    };

    const jumpToStepForEdit = (key) => {
      if (!captureActive) return;
      const idx = steps.findIndex((s) => s.key === key);
      if (idx < 0) return;
      stepIdx = idx;
      capturePaused = false;
      setMinimized(false);
      applyDockMode(true);
      const human = String(steps[idx].label || key).replace(/^Point to\s*/i, '');
      this._mappingStatus(`Editing ${human}. Click a new element to replace this mapping.`, 'info');
      setStepText();
    };

    const onToggleDock = () => {
      if (!captureActive) return;
      applyDockMode(!isDocked);
      this._mappingStatus(
        isDocked
          ? 'Docked view enabled. Page is visible for easier selection.'
          : 'Expanded mode enabled.'
        ,
        'info'
      );
    };

    const resolveContainerCandidate = (startEl) => {
      if (!(startEl instanceof HTMLElement)) return null;
      let current = startEl;
      let depth = 0;
      while (current && current !== document.body && depth < 12) {
        if (ui.overlay.contains(current) || current.id === 'tg-guided-mapper') {
          current = current.parentElement;
          depth += 1;
          continue;
        }
        const rowCount = current.querySelectorAll?.(rowLikeSelector)?.length || 0;
        const hinted =
          current.matches?.(containerHintSelector) ||
          /\b(position|positions|trade|trades|order|orders|table|tbody)\b/i.test(
            `${current.className || ''} ${current.id || ''}`
          );
        if (rowCount >= 1 && hinted) return current;
        current = current.parentElement;
        depth += 1;
      }
      return null;
    };

    const scoreRowCandidate = (row) => {
      if (!(row instanceof HTMLElement)) return -999;
      const text = (row.innerText || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length < 4 || text.length > 1800) return -999;
      const tdCount = row.querySelectorAll?.('td')?.length || 0;
      const hasSymbol = !!(this.detector?.getBestSymbolFromText ? this.detector.getBestSymbolFromText(text) : null);
      const hasTradeHints = /\b(buy|sell|long|short|tp|sl|entry|open|mark|current|pnl|p\/l|profit)\b/i.test(text);
      let score = 0;
      if (tdCount >= 3) score += 12;
      if (hasSymbol) score += 10;
      if (hasTradeHints) score += 6;
      if (row.tagName === 'TR') score += 8;
      if ((row.getAttribute('role') || '').toLowerCase() === 'row') score += 4;
      if (row.childElementCount >= 3 && row.childElementCount <= 80) score += 2;
      return score;
    };

    const resolveRowCandidate = (el, containerEl) => {
      if (!(el instanceof HTMLElement)) return null;
      const candidates = [];
      let current = el;
      let depth = 0;
      while (current && current !== document.body && depth < 16) {
        if (!containerEl || containerEl.contains(current)) {
          if (current.matches?.(rowLikeSelector)) candidates.push({ row: current, depth });
        }
        if (containerEl && current === containerEl) break;
        current = current.parentElement;
        depth += 1;
      }
      if (candidates.length === 0 && containerEl?.contains(el)) {
        const nested = el.querySelector?.(rowLikeSelector);
        if (nested) candidates.push({ row: nested, depth: 99 });
      }
      if (candidates.length === 0) return null;
      candidates.sort((a, b) => {
        const scoreDiff = scoreRowCandidate(b.row) - scoreRowCandidate(a.row);
        if (scoreDiff !== 0) return scoreDiff;
        return a.depth - b.depth;
      });
      return candidates[0].row;
    };

    const onClick = (e) => {
      if (!this._mappingSession) return;
      if (!captureActive) return;
      if (capturePaused || isMinimized) return;
      if (Date.now() < suppressMappingClickUntil) return;
      const el = e.target;
      if (!(el instanceof HTMLElement)) return;
      if (ui.overlay.contains(el)) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const step = steps[stepIdx];
      if (!step) return;

      if (step.key === 'container') {
        const resolvedContainer = resolveContainerCandidate(el) || el;
        capture.containerEl = resolvedContainer;
        capture.containerSelector = this._getExactSelector(resolvedContainer);
        capture.containerTag = resolvedContainer.tagName.toLowerCase();
        if (!capture.containerSelector) {
          this._mappingStatus('Could not map container selector. Try clicking a more specific container element.', 'error');
          return;
        }
        advance();
        return;
      }
      if (step.key === 'closedTradesContainer') {
        const resolvedClosed = resolveContainerCandidate(el) || el;
        capture.closedTradesContainerEl = resolvedClosed;
        capture.closedTradesContainerSelector = this._getExactSelector(resolvedClosed);
        if (!capture.closedTradesContainerSelector) {
          this._mappingStatus('Could not map closed-trades container. Try clicking inside its table area.', 'error');
          return;
        }
        advance();
        return;
      }
      if (step.scope === 'global') {
        const selector = this._getExactSelector(el);
        if (!selector) {
          this._mappingStatus('Could not map this selector. Click the exact value element (not wrapper).', 'error');
          return;
        }
        const liveValue = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        capture.fields[step.key] = {
          selector,
          absolute: selector,
          liveValue,
          source: 'guided_mapping',
          confidence: 0.99
        };
        advance();
        return;
      }
      if (step.key === 'row') {
        if (!capture.containerEl?.contains(el)) {
          const correctedContainer = resolveContainerCandidate(el);
          if (correctedContainer) {
            capture.containerEl = correctedContainer;
            capture.containerSelector = this._getExactSelector(correctedContainer);
            capture.containerTag = correctedContainer.tagName.toLowerCase();
            this._mappingStatus('Container auto-updated from your click. Continue with row mapping.', 'info');
          } else {
            this._mappingStatus('Selected row must be inside the mapped positions container.', 'error');
            return;
          }
        }
        capture.rowEl = resolveRowCandidate(el, capture.containerEl);
        if (!capture.rowEl || !capture.containerEl.contains(capture.rowEl)) {
          this._mappingStatus('Could not resolve a valid row in the selected container.', 'error');
          return;
        }
        capture.rowSelector = this._getExactSelector(capture.rowEl, capture.containerEl);
        capture.rowSelectorHint = capture.rowEl.tagName === 'TR' ? 'tr' : null;
        if (!capture.rowSelector) {
          this._mappingStatus('Could not map row selector. Click the row again, closer to a value cell.', 'error');
          return;
        }
        // Continue manual mapping steps; Claude verification runs at finalize.
        this._mappingStatus('Row mapped successfully. Continue mapping field values.', 'success');
        advance();
        return;
      }

      if (!capture.rowEl?.contains(el)) {
        const correctedRow = resolveRowCandidate(el, capture.containerEl);
        if (correctedRow && capture.containerEl?.contains(correctedRow)) {
          capture.rowEl = correctedRow;
          capture.rowSelector =
            this._getExactSelector(correctedRow, capture.containerEl) || capture.rowSelector;
          capture.rowSelectorHint = correctedRow.tagName === 'TR' ? 'tr' : capture.rowSelectorHint;
          this._mappingStatus('Auto-corrected to nearest valid row from your click.', 'warn');
        } else {
          this._mappingStatus('Click an element inside the selected active row.', 'error');
          return;
        }
      }
      const selector = this._getExactSelector(el, capture.rowEl);
      if (!selector) {
        this._mappingStatus('Could not map this field selector. Try a more specific value element.', 'error');
        return;
      }
      const liveValue = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      capture.fields[step.key] = {
        selector,
        absolute: this._getExactSelector(el),
        liveValue,
        source: 'guided_mapping',
        confidence: 0.99
      };
      this._mappingStatus(`Captured ${this._mappingFieldLabel(step.key)}.`, 'success');
      advance();
    };

    const onCancel = () => {
      guide.style.display = 'none';
      this._teardownMapping();
      showToast?.('Guided mapping cancelled. No changes were saved.', 'warn');
    };

    const onSkip = () => {
      const step = steps[stepIdx];
      if (!step) return;
      if (step.required) {
        this._mappingStatus('This is a required step and cannot be skipped.', 'warn');
        return;
      }
      if (step.key === 'closedTradesContainer') {
        capture.closedTradesContainerEl = null;
        capture.closedTradesContainerSelector = null;
      } else {
        capture.fields[step.key] = null;
      }
      advance();
    };

    const finalize = async () => {
      if (!capture.containerSelector || !capture.rowSelector) {
        this._mappingStatus('Positions container and active row are required before save.', 'error');
        return;
      }
      capture.balanceSelector = capture.fields.balance?.selector || null;
      capture.equitySelector = capture.fields.equity?.selector || null;
      capture.buyButtonSelector = capture.fields.buyButton?.selector || null;
      capture.sellButtonSelector = capture.fields.sellButton?.selector || null;
      capture.orderInstrumentSelector = capture.fields.orderInstrument?.selector || null;
      capture.openTabSelector = capture.fields.openTab?.selector || null;
      capture.pendingTabSelector = capture.fields.pendingTab?.selector || null;
      capture.closedTabSelector = capture.fields.closedTab?.selector || null;
      capture.closeButtonSelector = capture.fields.closeButton?.absolute || null;

      // User-first flow: after user completes mapping, run Claude once to enrich missing fields.
      if (window.DeepMapper && capture.rowEl) {
        this._setMappingAiHint('TradeGuardX AI assistant: validating your mapped fields...');
        this._mappingStatus('Running AI validation on your mapping...', 'info');
        try {
          const manualSelections = this._manualSelectionsFromCaptureFields(capture.fields);
          const aiValidated = await this._runAiFieldMapping(capture.rowEl, manualSelections);
          // AI-refine flow: keep user-captured fields as fallback; replace only with valid AI selectors.
          this._applyAiSelectorsToCapture(capture, aiValidated, {
            overwrite: true,
            overwriteCoarseOnly: false,
            rowEl: capture.rowEl
          });
          capture.balanceSelector = capture.fields.balance?.selector || capture.balanceSelector;
          capture.equitySelector = capture.fields.equity?.selector || capture.equitySelector;
          capture.buyButtonSelector = capture.fields.buyButton?.selector || capture.buyButtonSelector;
          capture.sellButtonSelector = capture.fields.sellButton?.selector || capture.sellButtonSelector;
          capture.orderInstrumentSelector =
            capture.fields.orderInstrument?.selector || capture.orderInstrumentSelector;
          capture.openTabSelector = capture.fields.openTab?.selector || capture.openTabSelector;
          capture.pendingTabSelector = capture.fields.pendingTab?.selector || capture.pendingTabSelector;
          capture.closedTabSelector = capture.fields.closedTab?.selector || capture.closedTabSelector;
          capture.closeButtonSelector = capture.fields.closeButton?.absolute || capture.closeButtonSelector;
          this._mappingStatus('AI validation completed. Running required checks...', 'success');
        } catch (_err) {
          // Continue saving user mapping even if Claude verification fails.
          this._mappingStatus('AI validation unavailable. Continuing with your mapped selectors.', 'warn');
        } finally {
          this._setMappingAiHint('', false);
        }
      }
      this._normalizeCapturedRowSelectorForSave(capture);
      let canonical = this._buildCanonicalSelectorsForStorage(capture);
      let canonicalCheck = this._validateCanonicalForSave(canonical);
      if (!canonicalCheck.ok && window.DeepMapper && capture.rowEl) {
        this._setMappingAiHint('TradeGuardX AI assistant: running deeper pass for missing required fields...');
        this._mappingStatus(
          `Required fields missing (${canonicalCheck.missing.join(', ')}). Running deeper AI pass...`,
          'warn'
        );
        try {
          const manualSelections = this._manualSelectionsFromCaptureFields(capture.fields);
          const aiWide = await this._runAiFieldMapping(capture.containerEl || capture.rowEl, manualSelections, {
            broadContext: true,
            focusFields: canonicalCheck.missing,
            forcedRowEl: capture.rowEl
          });
          this._applyAiSelectorsToCapture(capture, aiWide, {
            overwrite: true,
            overwriteCoarseOnly: false,
            rowEl: capture.rowEl
          });
          capture.balanceSelector = capture.fields.balance?.selector || capture.balanceSelector;
          capture.equitySelector = capture.fields.equity?.selector || capture.equitySelector;
          capture.buyButtonSelector = capture.fields.buyButton?.selector || capture.buyButtonSelector;
          capture.sellButtonSelector = capture.fields.sellButton?.selector || capture.sellButtonSelector;
          capture.orderInstrumentSelector =
            capture.fields.orderInstrument?.selector || capture.orderInstrumentSelector;
          capture.openTabSelector = capture.fields.openTab?.selector || capture.openTabSelector;
          capture.pendingTabSelector = capture.fields.pendingTab?.selector || capture.pendingTabSelector;
          capture.closedTabSelector = capture.fields.closedTab?.selector || capture.closedTabSelector;
          capture.closeButtonSelector = capture.fields.closeButton?.absolute || capture.closeButtonSelector;
          this._normalizeCapturedRowSelectorForSave(capture);
          canonical = this._buildCanonicalSelectorsForStorage(capture);
          canonicalCheck = this._validateCanonicalForSave(canonical);
        } catch (_err) {
          // keep existing message path below
        } finally {
          this._setMappingAiHint('', false);
        }
      }
      if (!canonicalCheck.ok) {
        const verifyFail = this._verifyMappingBeforeSave(capture);
        this._mappingStatus(this._formatVerificationMatrix(
          verifyFail,
          `Required fields still missing: ${canonicalCheck.missing.join(', ')}. Please remap and verify again.`
        ), 'error');
        return;
      }
      const verification = this._verifyMappingBeforeSave(capture);
      if (!verification.ok) {
        this._mappingStatus(this._formatVerificationMatrix(
          verification,
          'Verification did not pass. Fix failed required checks before saving.'
        ), 'error');
        return;
      }
      this._mappingStatus(
        this._formatVerificationMatrix(verification, 'Verification passed. Saving mapping profile...'),
        'success'
      );
      capture.fieldBindings = canonical.fieldBindings;
      capture.fieldSelectors = canonical.fieldSelectors;
      capture.absoluteFieldSelectors = canonical.absoluteFieldSelectors;

      const saved = await this._saveGuidedProfile(capture);
      if (!saved) {
        this._mappingStatus('Could not save mapping profile. Please retry.', 'error');
        return;
      }
      this._lastSavedOrderSelector = capture.containerSelector;
      this._identityLocked = true;
      this._requiresMapping = false;
      this._loadedSelectors = this._normalizeMappedSelectorPayload({
        ...(this._loadedSelectors || {}),
        mapping_complete: true,
        mapping_version: 1,
        positions_table: capture.containerSelector,
        ...(capture.balanceSelector ? { balance: capture.balanceSelector } : {}),
        ...(capture.equitySelector ? { equity: capture.equitySelector } : {}),
        ...(capture.buyButtonSelector ? { buy_button: capture.buyButtonSelector } : {}),
        ...(capture.sellButtonSelector ? { sell_button: capture.sellButtonSelector } : {}),
        ...(capture.openTabSelector ? { open_positions_tab: capture.openTabSelector } : {}),
        ...(capture.pendingTabSelector ? { pending_positions_tab: capture.pendingTabSelector } : {}),
        ...(capture.closedTabSelector ? { closed_positions_tab: capture.closedTabSelector } : {}),
        ...(capture.closeButtonSelector ? { close_button: capture.closeButtonSelector } : {}),
        ...(capture.orderInstrumentSelector ? { order_instrument: capture.orderInstrumentSelector } : {}),
        ...(capture.closedTradesContainerSelector
          ? { closed_trades_section: capture.closedTradesContainerSelector }
          : {}),
        order_profile: {
          version: 1,
          host: window.location.hostname,
          strictMappedMode: true,
          rowSelector: capture.rowSelector || null,
          rowSelectorHint: capture.rowSelectorHint || null,
          headerAliases: {},
          headerMap: {},
          fieldBindings: capture.fieldBindings || {},
          negativeRowPatterns: [],
          source: 'guided_mapping',
          lastVerifiedAt: Date.now()
        },
        order_details_identity: {
          selector: capture.containerSelector,
          tag: capture.containerTag || 'div',
          confidence: 999,
          rowCount: 1,
          fieldsDetected: {},
          fieldSelectors: capture.fieldSelectors || {},
          absoluteFieldSelectors: capture.absoluteFieldSelectors || {},
          host: window.location.hostname,
          url: window.location.href,
          capturedAt: Date.now(),
          source: 'guided_mapping'
        }
      });
      this._mappedSelectors = this._loadedSelectors;
      if (typeof this.detector.setPreferredPositionsSelector === 'function') {
        this.detector.setPreferredPositionsSelector(capture.containerSelector);
      }
      if (typeof this.detector.setClosedTradesSectionSelector === 'function') {
        this.detector.setClosedTradesSectionSelector(capture.closedTradesContainerSelector || null);
      }
      if (typeof this.detector.setTradeTabSelectors === 'function') {
        this.detector.setTradeTabSelectors({
          open: capture.openTabSelector || null,
          pending: capture.pendingTabSelector || null,
          closed: capture.closedTabSelector || null
        });
      }
      this._installTabClickTracking({
        open: capture.openTabSelector || null,
        pending: capture.pendingTabSelector || null,
        closed: capture.closedTabSelector || null
      });
      if (this._orderTracker) {
        this._orderTracker.importProfile({
          version: 1,
          host: window.location.hostname,
          strictMappedMode: true,
          rowSelector: capture.rowSelector || null,
          rowSelectorHint: capture.rowSelectorHint || null,
          headerAliases: {},
          headerMap: {},
          fieldBindings: capture.fieldBindings
        });
        this._orderTracker.bind(capture.containerEl);
      }
      this._teardownMapping();
      guide.style.display = 'none';
      this._startMonitoringLoops();
      this.runFullScan();
      showToast?.('Mapping saved successfully. TradeGuardX is now running in mapped mode.', 'info');
    };

    const onGuideClick = () => {
      if (!captureActive) return;
      if (isMinimized) {
        onReopen();
        return;
      }
      applyDockMode(!isDocked);
      this._mappingStatus(isDocked ? 'Docked view enabled.' : 'Expanded view enabled.', 'info');
    };

    ui.startBtn.addEventListener('click', onStart);
    ui.backBtn.addEventListener('click', onBack);
    ui.pauseBtn.addEventListener('click', onPause);
    ui.dockBtn.addEventListener('click', onToggleDock);
    ui.miniBtn.addEventListener('click', onMinimize);
    ui.reopenBtn.addEventListener('click', onReopen);
    guide.addEventListener('click', onGuideClick);
    const chipClickHandlers = [];
    Object.entries(ui.capturedChips || {}).forEach(([key, chip]) => {
      const handler = () => jumpToStepForEdit(key);
      chip.addEventListener('click', handler);
      chipClickHandlers.push(() => chip.removeEventListener('click', handler));
    });
    ui.cancelBtn.addEventListener('click', onCancel);
    ui.dragHandle.addEventListener('mousedown', onDragDown);
    ui.skipBtn.addEventListener('click', onSkip);
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('click', onClick, true);
    cleanupFns.push(
      () => ui.startBtn.removeEventListener('click', onStart),
      () => ui.backBtn.removeEventListener('click', onBack),
      () => ui.pauseBtn.removeEventListener('click', onPause),
      () => ui.dockBtn.removeEventListener('click', onToggleDock),
      () => ui.miniBtn.removeEventListener('click', onMinimize),
      () => ui.reopenBtn.removeEventListener('click', onReopen),
      () => guide.removeEventListener('click', onGuideClick),
      ...chipClickHandlers,
      () => ui.cancelBtn.removeEventListener('click', onCancel),
      () => ui.dragHandle.removeEventListener('mousedown', onDragDown),
      () => ui.skipBtn.removeEventListener('click', onSkip),
      () => document.removeEventListener('mousemove', onMouseMove, true),
      () => document.removeEventListener('click', onClick, true),
      () => highlight.remove(),
      () => guide.remove(),
      () => ui.reopenBtn.remove()
    );

    this._mappingSession = {
      backdrop: ui.backdrop,
      overlay: ui.overlay,
      reopenBtn: ui.reopenBtn,
      guide,
      statusEl: ui.statusEl,
      cleanupFns
    };
    ensureMapperBeacon(ui.overlay, ui.reopenBtn);
    // Resolve so message handler can sendResponse immediately (overlay is visible).
    mappingReadyResolve();
    });
  }

  startProfitWatcher() {
    if (this._profitWatcherActive || !this.detector) return;
    this._profitWatcherActive = true;
    const throttleMs = 500;
    let lastRun = 0;

    const tick = () => {
      if (!this._profitWatcherActive) return;
      const now = Date.now();
      if (now - lastRun >= throttleMs) {
        lastRun = now;
        const trades = this._stabilizeTrades(this.getLiveTrades());
        const digest = this._buildTradesDigest(trades);
        const currentCount = Array.isArray(this.accountState.positions) ? this.accountState.positions.length : 0;
        if (digest === this._lastTradesDigest && currentCount === trades.length) {
          requestAnimationFrame(tick);
          return;
        }
        this._lastTradesDigest = digest;
        this._syncPositionOpenTimes(trades);
        this.accountState.positions = trades.map((t) => ({
          symbol: t.symbol,
          side: t.side,
          volume: t.volume ?? null,
          stopLoss: t.stopLoss ?? null,
          takeProfit: t.takeProfit ?? null,
          profit: t.profit ?? null,
          entryPrice: t.entryPrice ?? null,
          currentPrice: t.currentPrice ?? null
        }));
        if (!this._isMappingActive()) {
          this.updateSlTpReminder(trades);
          this.evaluateAndReact('PASSIVE');
        }
      }
      requestAnimationFrame(tick);
    };
    tick();
  }

  startTradesObservation() {
    if (this._requiresMapping) return;
    if (this._tradesObserver) return;
    if (this._ensureOrderTrackerBound()) return;
    const sourceHelper = window.TradeGuardXPositionSource;
    let container = null;
    if (sourceHelper && typeof sourceHelper.resolveObservationContainer === 'function') {
      container = sourceHelper.resolveObservationContainer({
        detector: this.detector,
        resolveIdentityContainer: () => this._resolveIdentityContainer(),
        isMappedCrawlMode: this._isMappedCrawlMode()
      });
    } else {
      container = this._resolveIdentityContainer();
      if (!container && this._isMappedCrawlMode()) return;
      if (!container) {
        const trades = this.detector.detectTrades(document.body);
        if (!trades.length) return;
        container = trades[0].element?.closest(
          '[class*="positions"],[class*="position"],[class*="trades"],table'
        );
        if (!container) {
          container = trades[0].element?.parentElement?.parentElement;
        }
      }
    }
    if (!container) return;

    this._positionsContainer = container;

    const observer = this.detector.observeTrades(container, (newTrades) => {
      const stableTrades = this._stabilizeTrades(newTrades);
      this._syncPositionOpenTimes(stableTrades);
      this.accountState.positions = stableTrades.map((t) => ({
        rowId: t.rowId ?? null,
        symbol: t.symbol,
        side: t.side,
        volume: t.volume ?? null,
        stopLoss: t.stopLoss ?? null,
        takeProfit: t.takeProfit ?? null,
        profit: t.profit ?? null,
        entryPrice: t.entryPrice ?? null,
        currentPrice: t.currentPrice ?? null
      }));
      this.updateSlTpReminder(stableTrades);
      this.evaluateAndReact('PASSIVE');
    });
    if (observer) this._tradesObserver = observer;
  }

  runFullScan() {
    if (this._requiresMapping) return;
    this._clearBlockedButtons();
    this.refreshAccountState();
    this.evaluateAndReact('PASSIVE');
  }

  getLiveTrades() {
    const sourceHelper = window.TradeGuardXPositionSource;
    if (sourceHelper && typeof sourceHelper.getLiveTrades === 'function') {
      const result = sourceHelper.getLiveTrades({
        detector: this.detector,
        orderTracker: this._orderTracker,
        getTradesScanRoot: () => this._getTradesScanRoot(),
        trackerEmptyStreak: this._trackerEmptyStreak,
        identityLocked: this._identityLocked
      });
      this._trackerEmptyStreak = Number(result?.trackerEmptyStreak) || 0;
      if (typeof result?.identityLocked === 'boolean') {
        this._identityLocked = result.identityLocked;
      }
      return Array.isArray(result?.trades) ? result.trades : [];
    }
    if (this._orderTracker?.isBound()) {
      const tracked = this._orderTracker.getTrades();
      if (tracked.length > 0) {
        this._trackerEmptyStreak = 0;
        return tracked;
      }
      this._trackerEmptyStreak += 1;
      // Order: mapped OrderTableTracker first, then heuristic detectTrades if empty.
      const fallback = this.detector.detectTrades(this._getTradesScanRoot());
      if (fallback.length > 0) {
        this._trackerEmptyStreak = 0;
        return fallback;
      }
      if (this._trackerEmptyStreak >= 4) {
        this._identityLocked = false;
      }
      return [];
    }
    // No bound tracker: still prefer running heuristics after mapped path failed to bind.
    return this.detector.detectTrades(this._getTradesScanRoot());
  }

  _stabilizeTrades(trades) {
    const helper = window.TradeGuardXPositionState;
    if (helper && typeof helper.stabilizeTrades === 'function') {
      const result = helper.stabilizeTrades(trades, this.accountState.positions, {
        emptyTradesStreak: this._emptyTradesStreak,
        lastNonEmptyTradesAt: this._lastNonEmptyTradesAt
      });
      this._emptyTradesStreak = result?.state?.emptyTradesStreak ?? this._emptyTradesStreak;
      this._lastNonEmptyTradesAt = result?.state?.lastNonEmptyTradesAt ?? this._lastNonEmptyTradesAt;
      return Array.isArray(result?.trades) ? result.trades : [];
    }
    const list = Array.isArray(trades) ? trades : [];
    if (list.length > 0) {
      this._emptyTradesStreak = 0;
      this._lastNonEmptyTradesAt = Date.now();
      return list;
    }
    this._emptyTradesStreak += 1;
    const ageMs = Date.now() - (this._lastNonEmptyTradesAt || 0);
    if (
      this._emptyTradesStreak < 2 &&
      ageMs < 1200 &&
      Array.isArray(this.accountState.positions) &&
      this.accountState.positions.length > 0
    ) {
      return this.accountState.positions.map((p) => ({
        symbol: p.symbol,
        side: p.side,
        volume: p.volume,
        stopLoss: p.stopLoss,
        takeProfit: p.takeProfit,
        profit: p.profit,
        entryPrice: p.entryPrice,
        currentPrice: p.currentPrice
      }));
    }
    return [];
  }

  _buildTradesDigest(trades) {
    const helper = window.TradeGuardXPositionState;
    if (helper && typeof helper.buildTradesDigest === 'function') {
      return helper.buildTradesDigest(trades);
    }
    if (!Array.isArray(trades) || trades.length === 0) return 'none';
    return trades
      .map((t) =>
        [
          t.rowId || '',
          t.symbol || '',
          t.side || '',
          t.volume ?? '',
          t.entryPrice ?? '',
          t.currentPrice ?? '',
          t.stopLoss ?? '',
          t.takeProfit ?? '',
          t.profit ?? ''
        ].join('|')
      )
      .join('~');
  }

  _positionKey(pos) {
    const helper = window.TradeGuardXPositionState;
    if (helper && typeof helper.positionKey === 'function') {
      return helper.positionKey(pos);
    }
    if (!pos) return 'na';
    const symbol = (pos.symbol || '').toUpperCase();
    const side = (pos.side || '').toUpperCase();
    const entryNum = Number(pos.entryPrice);
    const entry = Number.isFinite(entryNum) ? Number(entryNum.toFixed(6)) : '';
    // Keep key stable: volume can change due partial closes/formatting.
    return [symbol, side, entry].join('|');
  }

  async _hydratePositionCache() {
    const cache = window.TradeGuardXPositionCache;
    if (!cache || typeof cache.load !== 'function') return;
    const host = window.location.hostname;
    try {
      const snap = await cache.load(host);
      if (!snap) return;
      this._cachedPositionsSnapshot = snap;
      // Restore the baseline the transitions evaluator compares against so a close
      // that happened during the refresh gap still fires a TG_SYNC_CLOSED_TRADE event
      // (nextPositions empty vs cached previousPositions non-empty → real close).
      // Also pre-seed accountState.positions and _lastNonEmptyTradesAt so that if the
      // broker DOM is still hydrating when the first scan fires, _stabilizeTrades'
      // grace window preserves the cached positions instead of surfacing a phantom close.
      if (Array.isArray(snap.positions) && snap.positions.length > 0) {
        const restored = snap.positions.slice();
        this._lastScanPositions = restored;
        this._lastPositionsCount = restored.length;
        this.accountState.positions = restored;
        this._lastNonEmptyTradesAt = Date.now();
        // Engage hydration gate: until the live broker DOM confirms these
        // positions (or the grace window expires), suppress close transitions
        // so a slow-loading SPA can't trigger phantom closes on every refresh.
        this._cachedHydrationCount = restored.length;
        this._cachedHydrationAt = Date.now();
        this._domHydrationConfirmed = false;
      }
      // Restore first-seen timestamps so _stableClientTradeIdForPosition / openedAtMs
      // match what we used before the refresh.
      if (snap.firstSeenMs && typeof snap.firstSeenMs === 'object') {
        for (const [key, ms] of Object.entries(snap.firstSeenMs)) {
          if (Number.isFinite(ms)) this._positionFirstSeenMs.set(key, ms);
        }
      }
      // Restore journal state so _captureJournalPositionEvents doesn't re-fire OPEN
      // events for already-known positions after a refresh.
      if (snap.journalStates && typeof snap.journalStates === 'object') {
        for (const [key, state] of Object.entries(snap.journalStates)) {
          if (!state || typeof state !== 'object') continue;
          this._journalPositionState.set(key, {
            key: state.key || key,
            tradeUid: state.tradeUid || null,
            clientTradeId: state.clientTradeId || null,
            openedAtMs: Number(state.openedAtMs) || Date.now(),
            seq: Number(state.seq) || 0,
            pending: [],
            timerId: null,
            symbol: state.symbol || null,
            side: state.side || null,
            last: state.last && typeof state.last === 'object' ? { ...state.last } : {}
          });
        }
      }
    } catch (_err) {
      /* ignore cache hydration failures — fresh session is still correct, just less efficient */
    }
  }

  _persistPositionCache(positions) {
    const cache = window.TradeGuardXPositionCache;
    if (!cache || typeof cache.save !== 'function') return;
    const host = window.location.hostname;
    const snapshot = {
      positions: cache.serializePositions(positions),
      firstSeenMs: cache.serializeFirstSeen(this._positionFirstSeenMs),
      journalStates: cache.serializeJournalStates(this._journalPositionState)
    };
    this._cachedPositionsSnapshot = { ...snapshot, updatedAt: Date.now() };
    cache.save(host, snapshot);
  }

  _findClosedPositions(previousPositions, currentPositions) {
    const helper = window.TradeGuardXPositionState;
    if (helper && typeof helper.findClosedPositions === 'function') {
      return helper.findClosedPositions(previousPositions, currentPositions);
    }
    const prev = Array.isArray(previousPositions) ? previousPositions : [];
    const cur = Array.isArray(currentPositions) ? currentPositions : [];
    const currentCounts = new Map();
    cur.forEach((p) => {
      const key = this._positionKey(p);
      currentCounts.set(key, (currentCounts.get(key) || 0) + 1);
    });
    const closed = [];
    prev.forEach((p) => {
      const key = this._positionKey(p);
      const remaining = currentCounts.get(key) || 0;
      if (remaining > 0) {
        currentCounts.set(key, remaining - 1);
      } else {
        closed.push(p);
      }
    });
    return closed;
  }

  _showTradeClosedPopup(trade, resolvedPnl) {
    if (!trade) return;
    // Don't bother an unpaired user with trade-closed overlays — the extension
    // has no rules loaded and no journal target, so the popup is just noise.
    if (!this._isPaired) return;

    // Dedupe: some brokers flicker the positions row (disappear → reappear → disappear)
    // while finalizing a close, which would otherwise surface two overlays back-to-back
    // for the same trade. Suppress within a short window keyed on the stable position key.
    const dedupeKey = this._positionKey(trade);
    const now = Date.now();
    const DEDUPE_WINDOW_MS = 60_000;
    const last = this._closedPopupRecent.get(dedupeKey);
    if (last != null && now - last < DEDUPE_WINDOW_MS) {
      return;
    }
    this._closedPopupRecent.set(dedupeKey, now);
    // Evict stale entries so the map doesn't grow unbounded on long sessions.
    for (const [k, ts] of this._closedPopupRecent) {
      if (now - ts >= DEDUPE_WINDOW_MS) this._closedPopupRecent.delete(k);
    }

    // Caller passes the sign-corrected P&L from positionTransitions.syncClosedTradePnl
    // (which already handles the funded-account reconciliation-lag sign-flip). Fall back
    // to the row's own profit column if caller passed null.
    const fallbackPnl = Number.isFinite(Number(trade.profit)) ? Number(trade.profit) : null;
    const resolved = Number.isFinite(Number(resolvedPnl)) ? Number(resolvedPnl) : null;
    const pnlValue = resolved != null ? resolved : fallbackPnl;
    const outcome = pnlValue == null ? 'CLOSED' : pnlValue > 0 ? 'PROFIT' : pnlValue < 0 ? 'LOSS' : 'CLOSED';
    const payload = {
      outcome,
      symbol: trade.symbol || null,
      side: trade.side || null,
      volume: trade.volume ?? null,
      entryPrice: trade.entryPrice ?? null,
      currentPrice: trade.currentPrice ?? null,
      stopLoss: trade.stopLoss ?? null,
      takeProfit: trade.takeProfit ?? null,
      pnl: pnlValue,
      closedAt: Date.now()
    };
    if (typeof showTradeClosedOverlay === 'function') {
      showTradeClosedOverlay(payload);
      return;
    }
    if (typeof showToast === 'function') {
      const prefix = outcome === 'LOSS' ? 'Trade closed in loss' : outcome === 'PROFIT' ? 'Trade closed in profit' : 'Trade closed';
      const sym = payload.symbol ? ` (${payload.symbol})` : '';
      showToast(`${prefix}${sym}.`, outcome === 'LOSS' ? 'warn' : 'info');
    }
  }

  refreshAccountState() {
    if (!this.detector) return;
    const previousPositions = Array.isArray(this._lastScanPositions) ? this._lastScanPositions : [];
    const openSeenBeforeScan = new Map(this._positionFirstSeenMs);

    const identityContainer = this._resolveIdentityContainer();
    if (identityContainer) {
      this._positionsContainer = identityContainer;
      this._identityMissingSince = null;
    } else if (this._identityLocked && this._lastSavedOrderSelector) {
      this._identityMissingSince = this._identityMissingSince || Date.now();
      // If locked selector is gone for a while, allow rediscovery.
      if (Date.now() - this._identityMissingSince > 5000) {
        this._identityLocked = false;
      }
    }

    const mapped = this._mappedSelectors || {};
    // Mapped selectors first; detector only when mapped read returns null (same for all hosts).
    const domEquity =
      this._readMappedNumber(mapped.equity) ??
      (typeof this.detector.detectEquity === 'function' ? this.detector.detectEquity(document.body) : null);
    const domBalance =
      this._readMappedNumber(mapped.balance) ??
      (typeof this.detector.detectBalance === 'function' ? this.detector.detectBalance(document.body) : null);

    if (!this._tradesObserver) {
      this.startTradesObservation();
    }

    this._ensureOrderTrackerBound();

    // Compute tab context up front so we can substitute cached positions when the user
    // is viewing Close/History/Pending (where the scan returns empty). Without the
    // substitution, hedging prevention silently passes and funded-mode equity
    // under-reports floating loss.
    let tradeTabContext =
      typeof this.detector.getTradeTabContext === 'function'
        ? this.detector.getTradeTabContext(this._getTradesScanRoot())
        : 'unknown';
    if (this._lastTabClickContext) {
      tradeTabContext = this._lastTabClickContext.ctx;
    }
    const suppressPositionTransitions = tradeTabContext === 'closed' || tradeTabContext === 'pending';

    // Capture the raw DOM scan result before _stabilizeTrades substitutes from
    // cache — only the raw result tells us whether the broker DOM has finished
    // hydrating after a page refresh. The post-stabilize result can be cached
    // positions filling in for an empty live scan, which would falsely look
    // like "DOM is up" to the post-refresh hydration gate below.
    const rawLiveTrades = this.getLiveTrades();
    const liveScanFoundPositions = Array.isArray(rawLiveTrades) && rawLiveTrades.length > 0;
    let activeTrades = this._stabilizeTrades(rawLiveTrades);
    // On the Close/Pending tab, the tracker's row discovery can pick up closed-trade
    // rows mid-render (detector's DOM-based getTradeTabContext is unreliable on brokers
    // that don't mark active tabs with aria/data/class). Our click-tracked signal is
    // authoritative — when it says "closed/pending", anything the scan produces is
    // noise. Always prefer the cached snapshot.
    if (
      suppressPositionTransitions &&
      Array.isArray(this._cachedPositionsSnapshot?.positions) &&
      this._cachedPositionsSnapshot.positions.length > 0
    ) {
      activeTrades = this._cachedPositionsSnapshot.positions.slice();
    }
    this._syncPositionOpenTimes(activeTrades);
    if (!Array.isArray(activeTrades) || activeTrades.length === 0) {
      this._lastTradesDigest = 'none';
    }

    if (!this._isMappedCrawlMode()) {
      this.captureAndPersistOrderIdentity();
      this.persistOrderProfileIfNeeded();
    }

    const fundedAccount = this._fundedAccountState?.account || null;
    const fundedClosedPnlToday = Number(this._fundedAccountState?.closedPnlToday) || 0;
    const positionsForResolver = activeTrades;
    const resolver = window.TradeGuardXEquityResolver;
    const resolved = (resolver && typeof resolver.resolveEquity === 'function')
      ? resolver.resolveEquity({
          equityMode: fundedAccount?.equityMode || 'live',
          domEquity,
          domBalance,
          fundedState: fundedAccount,
          closedPnlToday: fundedClosedPnlToday,
          positions: positionsForResolver
        })
      : null;

    const equity = resolved?.equity ?? domEquity;
    const balance = resolved?.balance ?? domBalance;
    const startingEquity = resolved?.startingEquity
      ?? this.accountState.startingEquity
      ?? (equity != null ? equity : balance)
      ?? this.accountState.startingEquity;

    const floatingLoss = resolved?.floatingLoss ?? this.estimateFloatingLoss(equity, balance, startingEquity);

    const nextPositions = activeTrades.map((t) => ({
      rowId: t.rowId ?? null,
      symbol: t.symbol,
      side: t.side,
      volume: t.volume ?? null,
      stopLoss: t.stopLoss ?? null,
      takeProfit: t.takeProfit ?? null,
      profit: t.profit ?? null,
      entryPrice: t.entryPrice ?? null,
      currentPrice: t.currentPrice ?? null
    }));
    this._lastScanPositions = nextPositions;
    this.accountState.positions = nextPositions;

    const effectiveEquity = equity ?? balance;

    // Post-refresh hydration gate. After init we restored cached positions into
    // _lastScanPositions; if the broker SPA hasn't repopulated the DOM yet,
    // _stabilizeTrades' 1.2s grace window expires and nextPositions becomes []
    // which would otherwise look like a close. Suppress transitions until:
    //   - the RAW live DOM scan returns ANY positions (DOM truly caught up;
    //     do NOT use nextPositions because stabilize may have substituted
    //     cached positions for an empty raw scan), OR
    //   - HYDRATION_GRACE_MS has elapsed (allow legitimate closes during the
    //     refresh gap to fire eventually).
    const HYDRATION_GRACE_MS = 30_000;
    if (!this._domHydrationConfirmed) {
      if (liveScanFoundPositions) {
        this._domHydrationConfirmed = true;
      } else if (Date.now() - this._cachedHydrationAt > HYDRATION_GRACE_MS) {
        this._domHydrationConfirmed = true;
      }
    }
    const suppressByHydration =
      !this._domHydrationConfirmed &&
      this._cachedHydrationCount > 0 &&
      nextPositions.length === 0;

    const transitions = window.TradeGuardXPositionTransitions?.evaluatePositionTransitions?.({
      previousPositions,
      nextPositions,
      lastPositionsCount: this._lastPositionsCount,
      lastEquity: this._lastEquity,
      effectiveEquity,
      suppressPositionTransitions: suppressPositionTransitions || suppressByHydration
    }) || {
      positionsCount: Array.isArray(activeTrades) ? activeTrades.length : 0,
      shouldUpdateLastPositionsCount: !suppressPositionTransitions,
      sendClosedLossSignal: false,
      closedTrade: null,
      realizedDelta: null,
      syncClosedTradePnl: null,
      openedDelta: 0
    };
    const closedJournalState = transitions.closedTrade
      ? this._findJournalStateForPosition(transitions.closedTrade)
      : null;
    // Pass the combined suppression flag so journal CLOSE events also pause
    // during the post-refresh hydration window — otherwise we'd still send
    // TG_SYNC_CLOSED_TRADE to the backend even though the transition path
    // above is gated, producing phantom dashboard rows on every refresh.
    this._captureJournalPositionEvents(
      previousPositions,
      nextPositions,
      suppressPositionTransitions || suppressByHydration
    );

    if (transitions.sendClosedLossSignal && chrome?.runtime?.id && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ type: 'TG_POSITION_CLOSED_LOSS' });
    }
    if (transitions.closedTrade && chrome?.runtime?.id && chrome.runtime.sendMessage) {
      try {
        const closedKey = this._positionKey(transitions.closedTrade);
        const openedAtMs =
          openSeenBeforeScan.get(closedKey) ||
          closedJournalState?.openedAtMs ||
          this._positionFirstSeenMs.get(closedKey) ||
          null;
        const dedupeClientTradeId =
          closedJournalState?.clientTradeId ||
          this._stableClientTradeIdForPosition(transitions.closedTrade, openedAtMs);
        chrome.runtime.sendMessage({
          type: 'TG_SYNC_CLOSED_TRADE',
          payload: {
            trade: {
              clientTradeId: dedupeClientTradeId,
              symbol: transitions.closedTrade.symbol,
              side: transitions.closedTrade.side,
              volume: transitions.closedTrade.volume,
              entryPrice: transitions.closedTrade.entryPrice,
              currentPrice: transitions.closedTrade.currentPrice,
              pnl: transitions.syncClosedTradePnl,
              openedAt: openedAtMs ? new Date(openedAtMs).toISOString() : null,
              closedAt: Date.now()
            }
          }
        });
      } catch (_e) {
        /* ignore */
      }
      // Funded mode: refresh closedPnlToday so the resolver picks up the new realized P&L
      // before the next scan tick.
      if (this._fundedAccountState?.account?.equityMode === 'funded') {
        this._loadFundedAccountState().catch(() => {});
      }
      this._showTradeClosedPopup(transitions.closedTrade, transitions.syncClosedTradePnl);
    }
    if (transitions.openedDelta > 0 && chrome?.runtime?.id && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ type: 'TG_POSITIONS_OPENED', payload: { delta: transitions.openedDelta } });
    }
    if (transitions.shouldUpdateLastPositionsCount) {
      this._lastPositionsCount = transitions.positionsCount;
    }
    this._lastEquity = effectiveEquity != null ? effectiveEquity : this._lastEquity;

    this.accountState = {
      ...this.accountState,
      equity,
      balance,
      floatingLoss,
      startingEquity
    };

    if (!this._isMappingActive()) {
      this.updateSlTpReminder(activeTrades);
    }
    const mappedBuyButtons = this._queryMappedElements(mapped.buy_button);
    const mappedSellButtons = this._queryMappedElements(mapped.sell_button);
    const detectorButtons =
      (typeof this.detector.detectTradeButtons === 'function'
        ? this.detector.detectTradeButtons(document.body)
        : null) || { buyButtons: [], sellButtons: [] };
    const buyButtons = mappedBuyButtons.length > 0 ? mappedBuyButtons : detectorButtons.buyButtons;
    const sellButtons = mappedSellButtons.length > 0 ? mappedSellButtons : detectorButtons.sellButtons;
    const hasTradeButtons = (buyButtons?.length || 0) + (sellButtons?.length || 0) > 0;
    const hasPositions = Array.isArray(activeTrades) && activeTrades.length > 0;
    this.notifyHookedIfNeeded(equity, balance, hasPositions, hasTradeButtons);

    this.getConfig().then((c) => {
      this._cachedRiskConfig = c;
    });

    // Persist the trusted snapshot so next reload or tab-switch can restore it.
    // We only write on non-suppressed ticks:
    //   - viewing the Close tab never wipes the cache (a genuine close is
    //     observed on the Open tab via positionsCount dropping)
    //   - during the post-refresh hydration window we MUST NOT overwrite the
    //     cached [trade] with [] — otherwise the next refresh would have
    //     nothing to gate against and phantom closes would return.
    if (!suppressPositionTransitions && !suppressByHydration) {
      this._persistPositionCache(nextPositions);
    }
  }

  _logMappingQuality(host, selectors) {
    if (!host || this._mappingQualityWarnedHosts.has(host)) return;
    const assess = window.TradeGuardXMappingQuality?.assessSelectors;
    if (typeof assess !== 'function') return;
    const report = assess(selectors);
    if (!report || report.ok !== false || !Array.isArray(report.warnings) || report.warnings.length === 0) return;
    this._mappingQualityWarnedHosts.add(host);
    const lines = report.warnings.map((w) => `  - [${w.severity}] ${w.code}: ${w.message}`);
    console.warn(`[TradeGuardX] Mapping quality warnings for ${host}:\n${lines.join('\n')}`);
  }

  async loadSavedOrderIdentity() {
    if (!chrome?.runtime?.id || !chrome.runtime.sendMessage || !this.detector) return;
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'TG_GET_SELECTORS', payload: { host: window.location.hostname } }, (selectors) => {
        if (chrome.runtime?.lastError || !selectors) {
          resolve();
          return;
        }
        const normalizedSelectors = this._normalizeMappedSelectorPayload(selectors);
        this._loadedSelectors = normalizedSelectors;
        this._mappedSelectors = normalizedSelectors;
        this._logMappingQuality(window.location.hostname, normalizedSelectors);
        const mapHelper = window.TradeGuardXMappingStore;
        const containerSelector =
          mapHelper?.getContainerSelector?.(normalizedSelectors) ||
          normalizedSelectors.order_details_identity?.selector ||
          normalizedSelectors.positions_table ||
          null;
        if (containerSelector && typeof this.detector.setPreferredPositionsSelector === 'function') {
          this.detector.setPreferredPositionsSelector(containerSelector);
          this._lastSavedOrderSelector = containerSelector;
          this._identityLocked = true;
        }
        const closedSel = normalizedSelectors.closed_trades_section;
        const openSel = containerSelector;
        const badClosed =
          closedSel &&
          openSel &&
          this._closedTradesSectionWrapsOpenContainer(closedSel, openSel);
        if (badClosed && typeof this.detector.setClosedTradesSectionSelector === 'function') {
          this.detector.setClosedTradesSectionSelector(null);
        } else if (closedSel && !badClosed && typeof this.detector.setClosedTradesSectionSelector === 'function') {
          this.detector.setClosedTradesSectionSelector(closedSel);
        } else if (typeof this.detector.setClosedTradesSectionSelector === 'function') {
          this.detector.setClosedTradesSectionSelector(null);
        }
        const tabSelectors = mapHelper?.getTradeTabSelectors?.(normalizedSelectors) || {
          open: normalizedSelectors.open_positions_tab || null,
          pending: normalizedSelectors.pending_positions_tab || null,
          closed: normalizedSelectors.closed_positions_tab || null
        };
        if (typeof this.detector.setTradeTabSelectors === 'function') {
          this.detector.setTradeTabSelectors(tabSelectors);
        }
        this._installTabClickTracking(tabSelectors);
        const mergedProfile =
          mapHelper?.mergeOrderProfileFromIdentity?.({
            selectors: this._loadedSelectors,
            rowFieldKeys: this._rowFieldKeys(),
            host: window.location.hostname
          }) || null;
        if (mergedProfile) this._loadedSelectors.order_profile = mergedProfile;
        resolve();
      });
    });
  }

  _installTabClickTracking(tabSelectors) {
    if (this._tabClickListener) {
      document.removeEventListener('click', this._tabClickListener, true);
      this._tabClickListener = null;
    }
    const open = tabSelectors?.open || null;
    const closed = tabSelectors?.closed || null;
    const pending = tabSelectors?.pending || null;
    if (!open && !closed && !pending) return;
    const matches = (el, sel) => {
      if (!sel) return false;
      try {
        return !!el.closest(sel);
      } catch (_err) {
        return false;
      }
    };
    const listener = (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      let ctx = null;
      if (matches(target, open)) ctx = 'open';
      else if (matches(target, closed)) ctx = 'closed';
      else if (matches(target, pending)) ctx = 'pending';
      if (ctx) this._lastTabClickContext = { ctx, at: Date.now() };
    };
    this._tabClickListener = listener;
    document.addEventListener('click', listener, true);
  }

  captureAndPersistOrderIdentity() {
    if (!this.detector || typeof this.detector.detectOrderDetailsIdentity !== 'function') return;

    // Sticky mode: when identity is locked and still present, do not re-detect/rewrite.
    if (this._identityLocked && this._resolveIdentityContainer()) return;

    const identity = this.detector.detectOrderDetailsIdentity(document.body);
    if (!identity?.selector) return;
    if (
      this._lastSavedOrderSelector === identity.selector &&
      Date.now() - this._lastOrderIdentitySavedAt < 10000
    ) {
      return;
    }

    if (typeof this.detector.setPreferredPositionsSelector === 'function') {
      this.detector.setPreferredPositionsSelector(identity.selector);
    }
    this._ensureOrderTrackerBound();

    this._lastSavedOrderSelector = identity.selector;
    this._lastOrderIdentitySavedAt = Date.now();
    this._identityLocked = true;
    this._identityMissingSince = null;

    if (!chrome?.runtime?.id || !chrome.runtime.sendMessage) return;
    const orderProfile = this._orderTracker?.exportProfile ? this._orderTracker.exportProfile() : null;
    chrome.runtime.sendMessage({
      type: 'TG_SAVE_SELECTORS',
      payload: {
        host: window.location.hostname,
        selectors: {
          positions_table: identity.selector,
          ...(orderProfile ? { order_profile: orderProfile } : {}),
          order_details_identity: {
            ...identity,
            host: window.location.hostname,
            url: window.location.href,
            capturedAt: Date.now()
          }
        }
      }
    });
  }

  persistOrderProfileIfNeeded() {
    if (!chrome?.runtime?.id || !chrome.runtime.sendMessage) return;
    if (!this._orderTracker?.isBound() || !this._orderTracker.exportProfile) return;
    const now = Date.now();
    if (now - this._lastProfileSavedAt < 30000) return;
    const profile = this._orderTracker.exportProfile();
    if (!profile) return;
    this._lastProfileSavedAt = now;
    chrome.runtime.sendMessage({
      type: 'TG_SAVE_SELECTORS',
      payload: {
        host: window.location.hostname,
        selectors: {
          ...(this._lastSavedOrderSelector ? { positions_table: this._lastSavedOrderSelector } : {}),
          order_profile: profile
        }
      }
    });
  }

  /**
   * Saved "closed trades" mapping must not equal or wrap the open positions container,
   * or every row would be treated as closed history.
   */
  _closedTradesSectionWrapsOpenContainer(closedSel, openSel) {
    if (!closedSel || !openSel || typeof closedSel !== 'string' || typeof openSel !== 'string') return false;
    const a = closedSel.trim();
    const b = openSel.trim();
    if (!a || !b || a === b) return true;
    try {
      const c = document.querySelector(a);
      const o = document.querySelector(b);
      if (!c || !o) return false;
      return c === o || c.contains(o);
    } catch (_e) {
      return false;
    }
  }

  _resolveIdentityContainer() {
    const selector =
      this._lastSavedOrderSelector ||
      (typeof this.detector.getPreferredPositionsSelector === 'function'
        ? this.detector.getPreferredPositionsSelector()
        : null);
    if (!selector) return null;
    try {
      const el = document.querySelector(selector);
      return el || null;
    } catch (_err) {
      return null;
    }
  }

  _ensureOrderTrackerBound() {
    if (!this._orderTracker) return false;
    const container = this._resolveIdentityContainer();
    if (!container) return false;
    if (this._orderTracker.isBound() && this._orderTracker.root === container) return true;
    return this._orderTracker.bind(container);
  }

  estimateFloatingLoss(equity, balance, startingEquity) {
    const start = startingEquity != null ? startingEquity : (balance != null ? balance : equity);
    if (start == null || equity == null) return 0;
    const pnl = equity - start;
    return pnl < 0 ? -pnl : 0;
  }

  async _loadPairingState() {
    if (!chrome?.runtime?.id || !chrome.runtime.sendMessage) {
      this._isPaired = false;
      return false;
    }
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'TG_GET_PAIRING_STATE' }, (resp) => {
          if (chrome.runtime?.lastError) {
            this._isPaired = false;
            resolve(false);
            return;
          }
          this._isPaired = !!resp?.connected;
          resolve(this._isPaired);
        });
      } catch (_e) {
        this._isPaired = false;
        resolve(false);
      }
    });
  }

  async _loadFundedAccountState() {
    if (!chrome?.runtime?.id || !chrome.runtime.sendMessage) return null;
    if (this._fundedAccountFetchInflight) return this._fundedAccountFetchInflight;
    const p = new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'TG_GET_ACCOUNT_CONFIG' }, (resp) => {
          if (chrome.runtime?.lastError || !resp || resp.success === false) {
            resolve(null);
            return;
          }
          this._fundedAccountState = {
            accountId: resp.accountId || null,
            account: resp.account || null,
            closedPnlToday: Number.isFinite(Number(resp.closedPnlToday)) ? Number(resp.closedPnlToday) : 0,
            closedTradesToday: Number.isFinite(Number(resp.closedTradesToday)) ? Number(resp.closedTradesToday) : 0,
            dailyWindowStartMs: Number.isFinite(Number(resp.dailyWindowStartMs)) ? Number(resp.dailyWindowStartMs) : null,
            needsReconcile: !!resp.needsReconcile,
            fetchedAt: Date.now()
          };
          this._maybeApplyDailyReset().catch(() => {});
          resolve(this._fundedAccountState);
        });
      } catch (_e) {
        resolve(null);
      }
    });
    this._fundedAccountFetchInflight = p;
    p.finally(() => { this._fundedAccountFetchInflight = null; });
    return p;
  }

  async _maybeApplyDailyReset() {
    const state = this._fundedAccountState;
    const account = state?.account;
    if (!account || account.equityMode !== 'funded') return;
    if (!chrome?.runtime?.id || !chrome.runtime.sendMessage) return;
    const floatingPnl = this._sumFloatingPnl(this.accountState?.positions);
    const closedPnlToday = Number(state.closedPnlToday) || 0;
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'TG_MAYBE_APPLY_DAILY_RESET', payload: { floatingPnl, closedPnlToday } },
        (resp) => {
          if (chrome.runtime?.lastError || !resp || resp.success === false) {
            resolve(null);
            return;
          }
          if (resp.account) {
            this._fundedAccountState = {
              ...this._fundedAccountState,
              account: resp.account,
              closedPnlToday: 0
            };
          }
          resolve(resp.account || null);
        }
      );
    });
  }

  _sumFloatingPnl(positions) {
    if (!Array.isArray(positions)) return 0;
    let sum = 0;
    for (const p of positions) {
      const v = Number(p?.profit);
      if (Number.isFinite(v)) sum += v;
    }
    return sum;
  }

  /**
   * Compute the absolute-dollar limit for a percent/amount rule, given a base.
   * Returns null when the rule is disabled or the numbers don't resolve.
   */
  _resolveLimitAmount({ enabled, type, pct, amount, base }) {
    if (enabled !== true) return null;
    if (type === 'amount') {
      const v = Number(amount);
      return Number.isFinite(v) && v > 0 ? v : null;
    }
    const p = Number(pct);
    const b = Number(base);
    if (!Number.isFinite(p) || p <= 0) return null;
    if (!Number.isFinite(b) || b <= 0) return null;
    return (b * p) / 100;
  }

  /**
   * Remaining loss capacity for the pre-trade prompt.
   *
   * Both limits are computed off the current (user-declared) balance so they
   * scale whenever the user updates it — a $4,987.06 balance with 5% / 10%
   * rules yields $249.35 daily and $498.71 total, and updating balance to
   * $5,000 immediately rebumps both to $250 / $500.
   *
   * For fixed-amount rules the configured dollar value is still used as-is.
   * Floating loss (from open positions) is subtracted from the daily cap so
   * the number reflects what the user can still lose right now.
   *
   *   daily = max(0, (balance × dailyPct / 100 OR dailyAmount) - floatingLoss)
   *   total = balance × totalPct / 100 OR totalAmount
   */
  _computeRemainingLimits(config, balance, _accountSize, floatingLoss) {
    const baseBalance = Number(balance) > 0 ? Number(balance) : 0;
    const rawDaily = this._resolveLimitAmount({
      enabled: config?.dailyLossRuleEnabled,
      type: config?.dailyLossLimitType,
      pct: config?.dailyLossLimitPct,
      amount: config?.dailyLossLimitAmount,
      base: baseBalance
    });
    const rawTotal = this._resolveLimitAmount({
      enabled: config?.maxTotalLossEnabled,
      type: config?.maxTotalLossType,
      pct: config?.maxTotalLossPct,
      amount: config?.maxTotalLossAmount,
      base: baseBalance
    });
    const flLoss = Number(floatingLoss) > 0 ? Number(floatingLoss) : 0;
    return {
      dailyLossLimit: rawDaily != null ? Math.max(0, rawDaily - flLoss) : null,
      totalLossLimit: rawTotal != null ? Math.max(0, rawTotal) : null,
    };
  }

  /**
   * Show the pre-trade confirmation overlay. Resolves with 'confirm' | 'cancel'.
   * Only the confirm path re-fires the click (via __tgPreTradeConfirmed + __tgAllowNextClick),
   * so rule evaluation still runs on the re-fire.
   */
  _runPreTradeConfirmation(targetEl, side, symbol, config) {
    return new Promise((resolve) => {
      if (typeof window === 'undefined' || typeof window.showPreTradeConfirmation !== 'function') {
        resolve('confirm');
        return;
      }

      const state = this._fundedAccountState;
      const account = state?.account || null;
      const isFunded = account?.equityMode === 'funded';

      const balance = isFunded
        ? Number(account?.currentBalance ?? account?.dailyStartingBalance ?? 0) || null
        : (this.accountState?.balance ?? this.accountState?.equity ?? null);

      const accountSize = Number(config?.accountSize) || Number(account?.accountSize) || balance || 0;
      const floatingLoss = Number(this.accountState?.floatingLoss) || 0;

      const { dailyLossLimit, totalLossLimit } =
        this._computeRemainingLimits(config, balance, accountSize, floatingLoss);

      const maxTradesPerDay =
        config?.maxTradesPerDayEnabled === true && Number(config?.maxTradesPerDay) > 0
          ? Number(config.maxTradesPerDay)
          : null;

      const tradesToday = Number(state?.closedTradesToday) || 0;
      const closedPnlToday = Number(state?.closedPnlToday) || 0;

      window.showPreTradeConfirmation({
        side,
        symbol,
        balance,
        dailyLossLimit,
        totalLossLimit,
        maxTradesPerDay,
        tradesToday,
        closedPnlToday,
        allowBalanceEdit: isFunded,
        onConfirm: () => resolve('confirm'),
        onCancel: () => resolve('cancel'),
        onUpdateBalance: async (newBalance) => {
          if (!chrome?.runtime?.id || !chrome.runtime.sendMessage) {
            throw new Error('Extension not connected');
          }
          const updatedAccount = await new Promise((res, rej) => {
            try {
              chrome.runtime.sendMessage(
                { type: 'TG_UPDATE_DECLARED_BALANCE', payload: { balance: newBalance } },
                (resp) => {
                  if (chrome.runtime?.lastError) {
                    rej(new Error(chrome.runtime.lastError.message || 'Could not save'));
                    return;
                  }
                  if (!resp || resp.success === false) {
                    rej(new Error(resp?.error || 'Could not save balance'));
                    return;
                  }
                  res(resp.account || null);
                }
              );
            } catch (e) {
              rej(e);
            }
          });

          if (updatedAccount) {
            this._fundedAccountState = {
              ...this._fundedAccountState,
              account: updatedAccount,
              fetchedAt: Date.now()
            };
          }

          const refreshedAccount = updatedAccount || this._fundedAccountState?.account;
          const newBal = Number(refreshedAccount?.currentBalance ?? newBalance) || newBalance;
          const newAccountSize = Number(config?.accountSize) || Number(refreshedAccount?.accountSize) || newBal;
          const newFloatingLoss = Number(this.accountState?.floatingLoss) || 0;
          const remaining = this._computeRemainingLimits(config, newBal, newAccountSize, newFloatingLoss);
          return {
            balance: newBal,
            dailyLossLimit: remaining.dailyLossLimit,
            totalLossLimit: remaining.totalLossLimit,
            maxTradesPerDay,
            tradesToday,
            closedPnlToday,
          };
        }
      });

      void targetEl;
    });
  }

  notifyHookedIfNeeded(equity, balance, hasPositions = false, hasTradeButtons = false) {
    if (this.hooked) return;
    const hasEquityOrBalance = equity != null || balance != null;
    if (!hasEquityOrBalance && !hasPositions && !hasTradeButtons) return;
    this.hooked = true;
    // Only surface the "active" toast when the user is actually paired —
    // otherwise we'd be claiming to enforce rules that aren't loaded.
    if (this._isPaired && typeof showToast === 'function') {
      showToast('TradeGuardX active. Rules enforced.', 'info');
    }
    if (chrome?.runtime?.id && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({
        type: 'TG_UI_HOOKED',
        payload: { host: window.location.hostname, url: window.location.href, at: Date.now() }
      });
    }
  }

  /**
   * Keep only innermost elements: if A contains B and both are in the list, remove A.
   * Prevents one click (on B) from firing both B's and A's handlers and double-counting.
   */
  _innermostOnly(elements) {
    if (!Array.isArray(elements) || elements.length <= 1) return elements;
    return elements.filter(
      (el) => !elements.some((other) => other !== el && el.contains(other))
    );
  }

  attachTradeButtons() {
    const bind = () => {
      if (!this.detector) return;
      const mapped = this._mappedSelectors || {};
      const mappedBuyButtons = this._queryMappedElements(mapped.buy_button);
      const mappedSellButtons = this._queryMappedElements(mapped.sell_button);
      const detected =
        (typeof this.detector.detectTradeButtons === 'function'
          ? this.detector.detectTradeButtons(document.body)
          : null) || { buyButtons: [], sellButtons: [] };
      let buyButtons = mappedBuyButtons.length > 0 ? mappedBuyButtons : detected.buyButtons;
      let sellButtons = mappedSellButtons.length > 0 ? mappedSellButtons : detected.sellButtons;
      buyButtons = this._innermostOnly(buyButtons);
      sellButtons = this._innermostOnly(sellButtons);

      const attach = (el, side) => {
        if (!(el instanceof HTMLElement) || el.__tgBound) return;
        el.__tgBound = true;
        if (side === 'BUY') this._buyButtonEl = el;
        if (side === 'SELL') this._sellButtonEl = el;
        tgHedgingLog('bind_trade_button', {
          side,
          tag: el.tagName,
          id: el.id || null,
          className: typeof el.className === 'string' ? el.className.slice(0, 120) : null
        });
        el.addEventListener(
          'click',
          (e) => this.onTradeClick(e, side),
          true
        );
      };

      tgHedgingLog('attachTradeButtons_summary', {
        mappingComplete: this._isMappedCrawlMode(),
        buyFromMapped: mappedBuyButtons.length,
        sellFromMapped: mappedSellButtons.length,
        buyBound: buyButtons.length,
        sellBound: sellButtons.length
      });

      buyButtons.forEach((el) => attach(el, 'BUY'));
      sellButtons.forEach((el) => attach(el, 'SELL'));
    };

    bind();
    if (document.body && !this._buttonObserver) {
      this._buttonObserver = new MutationObserver(bind);
      this._buttonObserver.observe(document.body, { childList: true, subtree: true });
    }
  }

  /**
   * Risk = |Entry - StopLoss| × Volume (universal approximation for rule protection).
   */
  calculateTradeRisk(trade) {
    if (!trade || trade.stopLoss == null) return null;
    const entry = trade.entryPrice ?? trade.currentPrice;
    const sl = trade.stopLoss;
    const volume = trade.volume || 0;
    if (!entry || !sl || !volume) return null;
    const distance = Math.abs(entry - sl);
    return distance * volume;
  }

  /** Max risk allowed from balance (balance × riskPercent / 100). */
  getMaxRisk(balance, riskPercent = 1) {
    if (!balance || !Number.isFinite(riskPercent)) return null;
    return balance * (riskPercent / 100);
  }

  /** Max lot size allowed so risk does not exceed balance × riskPercent. */
  calculateMaxAllowedVolume(balance, entry, stopLoss, riskPercent = 1) {
    if (!balance || !entry || !stopLoss) return null;
    const maxRisk = balance * (riskPercent / 100);
    const distance = Math.abs(entry - stopLoss);
    if (distance === 0) return null;
    return maxRisk / distance;
  }

  /** Check if any open position is over risk and show a reminder every 1 min. */
  async checkOverRiskReminder() {
    if (this._isMappingActive()) return;
    if (!this.detector || typeof showWarningOverlay !== 'function') return;
    this.refreshAccountState();
    const config = await this.getConfig();
    if (!config || config.riskPerTradeEnabled !== true) return;
    const balance = this.accountState.balance ?? this.accountState.equity;
    const riskPercent = Number(config.riskPerTradePercent) || 1;
    const maxRisk = this.getMaxRisk(balance, riskPercent);
    if (maxRisk == null) return;

    const positions = this.accountState.positions || [];
    for (const trade of positions) {
      const risk = this.calculateTradeRisk(trade);
      if (risk == null || maxRisk == null || risk <= maxRisk) continue;
      const symbol = trade.symbol || 'Position';
      const maxVol = trade.entryPrice != null && trade.stopLoss != null
        ? this.calculateMaxAllowedVolume(balance, trade.entryPrice, trade.stopLoss, riskPercent)
        : null;
      const maxVolStr = maxVol != null ? ` Use at most ${maxVol.toFixed(2)} lots for this SL.` : '';
      this._journalEmitRuleBlock({
        side: trade.side || null,
        symbol: trade.symbol || null,
        reason: `Over risk reminder: ${symbol} risks ${risk.toFixed(2)} > allowed ${maxRisk.toFixed(2)} (${riskPercent}% of balance).`,
        title: 'Over risk reminder',
        ruleSlug: 'risk-per-trade'
      });
      showWarningOverlay({
        title: 'Risk too high',
        message: `${symbol} risks $${risk.toFixed(2)} — your limit is $${maxRisk.toFixed(2)} (${riskPercent}% of balance). Risk exceeded by ${((risk / maxRisk) * 100 - 100).toFixed(0)}%. Reduce size or tighten SL now.${maxVolStr}`,
        highlight: true
      });
      return;
    }
  }

  /** Root for trade scanning: positions container when known, else full document (avoids 10k+ node scans). */
  _getTradesScanRoot() {
    return this._positionsContainer || document.body;
  }

  /** When multiple trades exist, pick the one matching pending symbol from context; else first. */
  _getRelevantTrade(trades, pendingSymbol) {
    if (!Array.isArray(trades) || trades.length === 0) return null;
    if (!pendingSymbol || !this.detector?.normalizeSymbol) return trades[0];
    const norm = this.detector.normalizeSymbol.bind(this.detector);
    return trades.find((t) => norm(t.symbol) === norm(pendingSymbol)) || trades[0];
  }

  /** Infer symbol for the pending order from DOM context near the clicked button. */
  getPendingSymbol(clickedEl) {
    if (!clickedEl || !this.detector) return null;
    const container = clickedEl.closest('div[class*="order"], div[class*="trade"], form, section') || clickedEl.parentElement;
    const root = container || document.body;
    const text = (root.innerText || '').replace(/\s+/g, ' ');
    if (this.detector.getBestSymbolFromText) {
      return this.detector.getBestSymbolFromText(text);
    }
    const match = text.match(this.detector.SYMBOL_REGEX);
    return match ? (this.detector.normalizeSymbol ? this.detector.normalizeSymbol(match[1] || match[0]) : match[1]) : null;
  }

  /**
   * If DOM scraping picked a column label (PROFIT, VOLUME) or nothing, align with open positions /
   * wider page text — same source of truth as the popup (tracker positions), not DB mapping.
   */
  _refineSymbolForHedging(candidate) {
    const det = this.detector;
    const isJunk = (s) =>
      !s ||
      (typeof det?.isInvalidSymbolToken === 'function' && det.isInvalidSymbolToken(s));
    const pos = Array.isArray(this.accountState.positions) ? this.accountState.positions : [];
    if (!isJunk(candidate)) return candidate;
    if (pos.length === 1 && pos[0].symbol) {
      tgHedgingLog('resolve_symbol_refine', {
        reason: 'ignored_junk_used_single_open_position',
        was: candidate || null,
        now: pos[0].symbol
      });
      return pos[0].symbol;
    }
    if (typeof det?.getBestSymbolFromText === 'function') {
      const wide = det.getBestSymbolFromText(
        (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 20000)
      );
      if (wide && !isJunk(wide)) {
        tgHedgingLog('resolve_symbol_refine', {
          reason: 'wide_body_text',
          was: candidate || null,
          now: wide
        });
        return wide;
      }
    }
    return candidate;
  }

  /**
   * Symbol for hedging checks: order panel first, then walk up DOM (brokers vary where instrument is shown).
   */
  _resolveSymbolForOrderClick(clickedEl) {
    const mapped = this._mappedSelectors || {};
    if (mapped.order_instrument) {
      const fromMap = this._readMappedOrderInstrumentText(mapped.order_instrument);
      if (fromMap) {
        const refined = this._refineSymbolForHedging(fromMap);
        const sym = refined || fromMap;
        tgHedgingLog('resolve_symbol', {
          source: 'mapped_order_instrument',
          symbol: sym,
          raw: fromMap
        });
        return sym;
      }
    }

    const direct = this.getPendingSymbol(clickedEl);
    if (direct) {
      const refined = this._refineSymbolForHedging(direct);
      tgHedgingLog('resolve_symbol', { source: 'getPendingSymbol', symbol: refined, raw: direct });
      return refined;
    }
    if (!clickedEl || !this.detector?.getBestSymbolFromText) {
      tgHedgingLog('resolve_symbol', {
        source: 'none',
        symbol: null,
        reason: !clickedEl ? 'no_clickedEl' : 'no_getBestSymbolFromText'
      });
      return null;
    }
    let el = clickedEl;
    for (let i = 0; i < 10 && el instanceof HTMLElement; i++) {
      const chunk = (el.innerText || '').replace(/\s+/g, ' ').slice(0, 800);
      const sym = this.detector.getBestSymbolFromText(chunk);
      if (sym) {
        const refined = this._refineSymbolForHedging(sym);
        tgHedgingLog('resolve_symbol', {
          source: `ancestor_depth_${i}`,
          symbol: refined,
          raw: sym
        });
        return refined;
      }
      el = el.parentElement;
    }
    const fallback = this._refineSymbolForHedging(null);
    if (fallback) {
      tgHedgingLog('resolve_symbol', { source: 'refine_only', symbol: fallback });
      return fallback;
    }
    tgHedgingLog('resolve_symbol', { source: 'none', symbol: null, reason: 'walk_exhausted' });
    return null;
  }

  _normalizeOrderSide(side) {
    const s = String(side || '').toUpperCase();
    if (s === 'LONG' || s === 'BUY') return 'BUY';
    if (s === 'SHORT' || s === 'SELL') return 'SELL';
    return null;
  }

  /** Get current config from background (for hedging toggle etc.). */
  getConfig() {
    return new Promise((resolve) => {
      if (!chrome?.runtime?.id || !chrome.runtime.sendMessage) {
        resolve(null);
        return;
      }
      chrome.runtime.sendMessage({ type: 'TG_GET_CONFIG' }, (c) => {
        if (chrome.runtime?.lastError) {
          resolve(null);
          return;
        }
        resolve(c || null);
      });
    });
  }

  /**
   * Show overlay explaining why the trade was blocked, plus current rule configuration.
   * If config is not provided (e.g. hedging block), fetches it from the extension.
   */
  showBlockedReason(reason, config, options) {
    if (typeof showBlockedTradeOverlay !== 'function') return;
    if (config != null) {
      showBlockedTradeOverlay(reason, config, options);
      return;
    }
    if (!chrome?.runtime?.id || !chrome.runtime.sendMessage) {
      showBlockedTradeOverlay(reason, null, options);
      return;
    }
    chrome.runtime.sendMessage({ type: 'TG_GET_POPUP_STATE' }, (state) => {
      if (chrome.runtime?.lastError || !state) {
        showBlockedTradeOverlay(reason, null, options);
        return;
      }
      showBlockedTradeOverlay(reason, state.config || null, options);
    });
  }

  /**
   * Hedging prevention: block opening opposite side on the same symbol as an open position.
   * Uses the same symbol normalization as the rest of the detector (strips / . -).
   */
  checkHedging(side, symbol) {
    const desiredSide = this._normalizeOrderSide(side);
    if (!desiredSide) {
      tgHedgingLog('check_skip', { why: 'side_not_buy_sell', side });
      return { allowed: true };
    }

    const norm =
      this.detector?.normalizeSymbol ||
      ((s) => String(s || '').replace(/[\/.\-]/g, '').toUpperCase());
    const normSymbol = symbol ? norm(symbol) : '';
    if (!normSymbol) {
      tgHedgingLog('check_skip', {
        why: 'no_symbol',
        desiredSide,
        rawSymbol: symbol || null,
        hint: 'Cannot compare to open positions without instrument text near click.'
      });
      return { allowed: true };
    }

    const opposite = desiredSide === 'BUY' ? 'SELL' : 'BUY';
    const open = Array.isArray(this.accountState.positions) ? this.accountState.positions : [];
    const positionRows = open.map((p) => ({
      symbol: p.symbol,
      symbolNorm: norm(p.symbol),
      sideRaw: p.side,
      sideNorm: this._normalizeOrderSide(p.side),
      oppositeOfClick: this._normalizeOrderSide(p.side) === opposite
    }));
    tgHedgingLog('check_positions_snapshot', {
      clickSide: desiredSide,
      needOpposite: opposite,
      normSymbol,
      positionCount: open.length,
      positions: positionRows
    });

    const conflict = open.find((p) => {
      const pSymNorm = norm(p.symbol);
      const pSide = this._normalizeOrderSide(p.side);
      if (!pSymNorm || !pSide || pSide !== opposite) return false;
      return pSymNorm === normSymbol;
    });
    if (!conflict) {
      tgHedgingLog('check_allow', {
        normSymbol,
        desiredSide,
        detail: 'No open position with same norm symbol and opposite side.'
      });
      return { allowed: true };
    }
    tgHedgingLog('check_block', {
      normSymbol,
      desiredSide,
      conflict: {
        symbol: conflict.symbol,
        side: conflict.side,
        norm: norm(conflict.symbol)
      }
    });
    return {
      allowed: false,
      reason: `Hedging prevention: you already have a ${conflict.side} on ${conflict.symbol || symbol}; opening a ${desiredSide} on the same instrument is blocked by your rules.`
    };
  }

  async onTradeClick(domEvent, side) {
    const t =
      domEvent.target && domEvent.target instanceof HTMLElement ? domEvent.target : null;
    tgHedgingLog('click', {
      side,
      targetTag: t?.tagName,
      targetId: t?.id || null,
      phase: domEvent.eventPhase === 1 ? 'capture' : domEvent.eventPhase === 2 ? 'target' : 'bubble'
    });

    if (domEvent.target && domEvent.target.__tgAllowNextClick === true) {
      domEvent.target.__tgAllowNextClick = false;
      tgHedgingLog('click_bypass', { side, reason: '__tgAllowNextClick' });
      return;
    }

    this.refreshAccountState();
    const inferredSymbol = this._resolveSymbolForOrderClick(domEvent.target);

    // Pre-trade confirmation: gate every click on a quick "is this balance still
    // current?" prompt before the rules engine runs. Confirm re-fires the click so
    // rule evaluation happens on the second pass; cancel simply swallows the click.
    // A __tgPreTradeConfirmed flag (separate from __tgAllowNextClick) means the click
    // has already been confirmed, so we skip this gate but still run rules below.
    const hasOpenPositions = Array.isArray(this.accountState?.positions)
      && this.accountState.positions.length > 0;
    const targetEl = domEvent.target instanceof HTMLElement ? domEvent.target : null;
    if (targetEl && targetEl.__tgPreTradeConfirmed === true) {
      targetEl.__tgPreTradeConfirmed = false;
    } else if (targetEl && window.showPreTradeConfirmation && !hasOpenPositions) {
      // Block the broker default synchronously before any await — awaits yield
      // to the event loop and Chrome will fire the default click action if we
      // haven't called preventDefault by then.
      domEvent.preventDefault();
      domEvent.stopPropagation();
      domEvent.stopImmediatePropagation?.();
      const preConfig = await this.getConfig();
      await this._loadFundedAccountState().catch(() => {});
      const isFunded = this._fundedAccountState?.account?.equityMode === 'funded';
      const hasLossRules =
        preConfig?.dailyLossRuleEnabled === true ||
        preConfig?.maxTotalLossEnabled === true;
      // Skip the prompt entirely when it would have nothing to show:
      //  - live accounts (no user-declared balance flow)
      //  - funded accounts still mid-pairing / rules not yet configured
      // Re-fire via __tgPreTradeConfirmed so the rules engine still runs.
      if (!isFunded || !hasLossRules) {
        targetEl.__tgPreTradeConfirmed = true;
        targetEl.click();
        return;
      }
      const outcome = await this._runPreTradeConfirmation(
        targetEl,
        side,
        inferredSymbol,
        preConfig
      );
      if (outcome === 'confirm') {
        targetEl.__tgPreTradeConfirmed = true;
        targetEl.click();
      }
      return;
    }

    const posAfterRefresh = Array.isArray(this.accountState.positions)
      ? this.accountState.positions.length
      : 0;
    tgHedgingLog('after_refreshAccountState', {
      positionsCount: posAfterRefresh,
      host: typeof window !== 'undefined' ? window.location.hostname : ''
    });

    // Evaluate this click against user risk / hedging configuration before letting it reach the broker.
    const config = await this.getConfig();
    if (!config) {
      tgHedgingLog('config', { ok: false, hedgingSkipped: true, reason: 'getConfig_returned_null' });
    } else {
      tgHedgingLog('config', {
        ok: true,
        hedgingEnabled: config.hedgingEnabled,
        hedgingWillRun: config.hedgingEnabled !== false
      });
    }

    if (config && config.hedgingEnabled !== false) {
      const symbol = inferredSymbol;
      const hedging = this.checkHedging(side, symbol);
      if (!hedging.allowed) {
        tgHedgingLog('outcome', { side, symbol, blocked: true, reason: hedging.reason });
        domEvent.preventDefault();
        domEvent.stopPropagation();
        domEvent.stopImmediatePropagation?.();
        const btnToBlock = side === 'BUY' ? this._buyButtonEl : this._sellButtonEl;
        this._setButtonBlocked(
          btnToBlock,
          hedging.reason ||
            `Hedging prevention: you already have an open ${side === 'BUY' ? 'SELL' : 'BUY'} on ${symbol ||
              'this instrument'}.`,
          { symbol, side, ruleSlug: 'hedging' }
        );
        this._journalEmitRuleBlock({
          side,
          symbol,
          reason: hedging.reason,
          title: 'Hedging blocked',
          ruleSlug: 'hedging'
        });
        this.showBlockedReason(hedging.reason, config, { title: 'Hedging blocked' });
        return;
      }
      tgHedgingLog('outcome', {
        side,
        symbol,
        blocked: false,
        hedgingAllowed: true
      });
    } else if (config) {
      tgHedgingLog('hedging_skipped', {
        hedgingEnabled: config.hedgingEnabled,
        reason: 'hedgingEnabled is false — prevention off or dashboard sync turned it off'
      });
    }

    if (
      config &&
      config.htfMinimumEnabled === true &&
      Number(config.htfMinimumChartMinutes) > 0 &&
      typeof this.detector?.detectChartTimeframeMinutes === 'function'
    ) {
      const tf = this.detector.detectChartTimeframeMinutes(document);
      const minM = Number(config.htfMinimumChartMinutes);
      if (tf != null && tf < minM) {
        domEvent.preventDefault();
        domEvent.stopPropagation();
        domEvent.stopImmediatePropagation?.();
        this._journalEmitRuleBlock({
          side,
          symbol: inferredSymbol,
          reason: `Chart timeframe ${tf}m below minimum ${minM}m`,
          title: 'Chart timeframe too low',
          ruleSlug: 'htf-minimum'
        });
        this.showBlockedReason(
          `Higher timeframe rule: the active chart interval looks like ~${tf} minute(s), but your rule requires at least ${minM} minutes (e.g. switch to 1H or higher). If the wrong interval was detected, adjust the rule or trade on a platform where the timeframe control is visible.`,
          config,
          { title: 'Chart timeframe too low' }
        );
        return;
      }
    }

    const pending = this.detector.getPendingOrderFromDOM(document.body, domEvent.target);
    const trades = this._stabilizeTrades(this.getLiveTrades());
    const pendingSymbol = this.getPendingSymbol(domEvent.target);
    const relevantTrade = this._getRelevantTrade(trades, pendingSymbol);
    const balance = this.accountState.balance ?? this.accountState.equity;
    const floatingLoss = Number(this.accountState.floatingLoss) || 0;
    const entry = pending.entryPrice ?? (relevantTrade && (relevantTrade.currentPrice ?? relevantTrade.entryPrice)) ?? null;
    const volume = pending.volume;
    const sl = pending.stopLoss;
    const canComputeRisk = volume != null && entry != null && sl != null && sl > 0;
    const risk = canComputeRisk ? Math.abs(entry - sl) * volume : null;

    if (config && canComputeRisk) {
      const dailyLimitType = config.dailyLossLimitType === 'amount' ? 'amount' : 'percent';
      const accountSize = Number(config.accountSize) || (balance ?? 0);
      const dailyLimitAmount =
        dailyLimitType === 'amount'
          ? Number(config.dailyLossLimitAmount) || 0
          : (accountSize * (Number(config.dailyLossLimitPct) || 0)) / 100;
      const wouldExceedDaily =
        config.dailyLossRuleEnabled !== false &&
        dailyLimitAmount > 0 &&
        (floatingLoss + risk) > dailyLimitAmount;
      const riskPercent = Number(config.riskPerTradePercent) || 1;
      const maxRiskPerTrade = balance != null ? this.getMaxRisk(balance, riskPercent) : null;
      const wouldExceedPerTrade =
        config.riskPerTradeEnabled === true &&
        maxRiskPerTrade != null &&
        risk != null &&
        risk > maxRiskPerTrade;

      if (wouldExceedDaily || wouldExceedPerTrade) {
        const parts = [];
        if (wouldExceedDaily) {
          parts.push(`This trade would exceed your daily loss limit (current floating loss $${floatingLoss.toFixed(2)} + trade risk $${risk.toFixed(2)} = $${(floatingLoss + risk).toFixed(2)} > limit $${dailyLimitAmount.toFixed(2)}).`);
        }
        if (wouldExceedPerTrade) {
          parts.push(`This trade would exceed your per-trade risk limit (risk $${risk.toFixed(2)} > allowed $${maxRiskPerTrade.toFixed(2)}).`);
        }
        const reason = parts.join(' ');
        const targetEl = domEvent.target;
        domEvent.preventDefault();
        domEvent.stopPropagation();
        const limitRuleSlug =
          wouldExceedDaily && wouldExceedPerTrade
            ? 'daily-loss,risk-per-trade'
            : wouldExceedDaily
              ? 'daily-loss'
              : 'risk-per-trade';
        this._journalEmitRuleBlock({
          side,
          symbol: pendingSymbol || inferredSymbol,
          reason,
          title: 'Limit would be exceeded',
          ruleSlug: limitRuleSlug
        });
        this.showBlockedReason(reason, config, {
          title: 'Limit would be exceeded',
          confirmMode: true,
          onContinue: () => {
            const overlay = document.getElementById('tg-blocked-trade-overlay');
            if (overlay) overlay.remove();
            targetEl.__tgAllowNextClick = true;
            targetEl.click();
          }
        });
        return;
      }
    }

    if (config && config.riskPerTradeEnabled === true) {
      const tradesForRisk = this.getLiveTrades();
      const balance = this.accountState.balance ?? this.accountState.equity;
      const riskPercent = Number(config.riskPerTradePercent) || 1;
      const trade = this._getRelevantTrade(tradesForRisk, pendingSymbol);
      if (trade && balance != null) {
        const maxRisk = this.getMaxRisk(balance, riskPercent);
        const entry = trade.entryPrice ?? trade.currentPrice;
        const sl = trade.stopLoss;
        const volume = trade.volume;

        if (sl == null || sl === 0) {
          domEvent.preventDefault();
          domEvent.stopPropagation();
          this._journalEmitRuleBlock({
            side,
            symbol: pendingSymbol || trade?.symbol || inferredSymbol,
            reason: 'Risk per trade enabled without stop loss.',
            title: 'Stop loss required',
            ruleSlug: 'risk-per-trade'
          });
          this.showBlockedReason(
            'Risk per trade is enabled but no stop loss is set. Set a stop loss so risk can be checked, or turn off risk per trade in settings.',
            config
          );
          return;
        }

        const risk = this.calculateTradeRisk(trade);
        if (risk != null && maxRisk != null && risk > maxRisk) {
          domEvent.preventDefault();
          domEvent.stopPropagation();
          const maxVol = entry != null && sl != null
            ? this.calculateMaxAllowedVolume(balance, entry, sl, riskPercent)
            : null;
          const isSlTooFar = maxVol != null && maxVol < 0.01;
          const reasonTitle = isSlTooFar ? 'SL too far away' : 'Risk exceeds limit';
          const hint = isSlTooFar
            ? ' Your stop loss is very far from entry. Move SL closer or increase max risk % in settings.'
            : ` Use at most ${(maxVol ?? 0).toFixed(2)} lots for this SL, or move SL closer.`;
          this._journalEmitRuleBlock({
            side,
            symbol: pendingSymbol || trade?.symbol || inferredSymbol,
            reason: `${reasonTitle}: risk ${risk.toFixed(2)} > allowed ${maxRisk.toFixed(2)}`,
            title: reasonTitle,
            ruleSlug: 'risk-per-trade'
          });
          this.showBlockedReason(
            `${reasonTitle}: trade risk $${risk.toFixed(2)} exceeds allowed $${maxRisk.toFixed(2)} (${riskPercent}% of balance).${hint}`,
            config,
            isSlTooFar ? { title: 'SL too far away' } : undefined
          );
          return;
        }
        if (entry != null && sl != null && volume != null) {
          const maxVolume = this.calculateMaxAllowedVolume(balance, entry, sl, riskPercent);
          if (maxVolume != null && volume > maxVolume) {
            domEvent.preventDefault();
            domEvent.stopPropagation();
            this._journalEmitRuleBlock({
              side,
              symbol: pendingSymbol || trade?.symbol || inferredSymbol,
              reason: `Lot size ${Number(volume).toFixed(2)} > allowed ${maxVolume.toFixed(2)}`,
              title: 'Lot size too large',
              ruleSlug: 'risk-per-trade'
            });
            this.showBlockedReason(
              `Lot size ${Number(volume).toFixed(2)} exceeds max ${maxVolume.toFixed(2)} lots for your ${riskPercent}% risk rule. Reduce size or tighten SL.`,
              config
            );
            return;
          }
        }
      }
    }

    const decision = await this.evaluateAndReact('ACTIVE');

    // When unpaired, the extension is dormant — rule decisions must not
    // produce user-facing effects (no "allowed" toast, no BLOCK overlay, no
    // auto-close). The TG_EVALUATE_ACCOUNT call still ran so the popup gets
    // fresh activeTrades, but we drop the decision here.
    if (!this._isPaired) return;

    if (!decision || decision.decision === 'ALLOW') {
      if (typeof showToast === 'function') {
        showToast('All rules passed. Trade allowed.', 'info');
      }
      return;
    }

    if (decision.decision === 'BLOCK') {
      domEvent.preventDefault();
      domEvent.stopPropagation();
      const reason =
        decision.reason ||
        'Your estimated floating loss has reached the configured daily loss limit. Close or reduce positions before opening new trades.';
      const ruleSlug = decision.ruleSlug || 'daily-loss';
      this._journalEmitRuleBlock({
        side,
        symbol: inferredSymbol,
        reason,
        title: 'Trade blocked',
        ruleSlug
      });
      this.showBlockedReason(reason, decision.config);
      return;
    }

    if (decision.decision === 'WARN' || decision.decision === 'CLOSE_TRADES') {
      const reason =
        decision.reason ||
        'Floating loss is close to your daily loss limit. Trade GuardX recommends you stop trading.';
      const ruleSlug = decision.ruleSlug || 'daily-loss';
      this._journalEmitRuleBlock({
        side,
        symbol: inferredSymbol,
        reason,
        title: decision.decision === 'CLOSE_TRADES' ? 'Risk: close trades' : 'Risk warning',
        ruleSlug
      });
      this.showBlockedReason(reason, decision.config);
      return;
    }
  }

  _journalPositionKey(pos) {
    if (!pos || typeof pos !== 'object') return 'na';
    const symbol = (pos.symbol || '').toUpperCase();
    const side = (pos.side || '').toUpperCase();
    const entry = this._journalNormalizeNumber(pos.entryPrice);
    // Keep key stable for same position across volume/partial-close changes.
    return [symbol, side, entry].join('|');
  }

  _journalNormalizeNumber(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Number(n.toFixed(8));
  }

  _journalTradeUidForPosition(pos, openedAtMs) {
    const sym = String(pos?.symbol || 'unknown').toUpperCase();
    const side = String(pos?.side || 'NA').toUpperCase();
    const entry = this._journalNormalizeNumber(pos?.entryPrice);
    const openTs = Number(openedAtMs) || Date.now();
    const base = `${sym}|${side}|${entry ?? 'na'}|${openTs}`;
    return `tgx_j_${base}`.slice(0, 180);
  }

  _stableClientTradeIdForPosition(pos, openedAtMs) {
    const key = this._positionKey(pos);
    const openTs = Number(openedAtMs) || 0;
    return `tgx_${key}_${openTs}`
      .replace(/[^a-zA-Z0-9:_-]/g, '')
      .slice(0, 190);
  }

  _journalLifecycleMatchKey(pos) {
    if (!pos || typeof pos !== 'object') return '';
    const symbol = String(pos.symbol || '').toUpperCase();
    const side = String(pos.side || '').toUpperCase();
    const entry = this._journalNormalizeNumber(pos.entryPrice);
    if (!symbol || !side || entry == null) return '';
    return `${symbol}|${side}|${Number(entry).toFixed(3)}`;
  }

  _findJournalStateForPosition(pos) {
    const direct = this._journalPositionState.get(this._journalPositionKey(pos));
    if (direct) return direct;
    const target = this._journalLifecycleMatchKey(pos);
    if (!target) return null;
    for (const state of this._journalPositionState.values()) {
      const candidate = this._journalLifecycleMatchKey({
        symbol: state.symbol,
        side: state.side,
        entryPrice: state?.last?.entryPrice
      });
      if (candidate && candidate === target) return state;
    }
    return null;
  }

  _findJournalStateForSymbolSide(symbol, side) {
    const sym = String(symbol || '').toUpperCase();
    const sd = String(side || '').toUpperCase();
    if (!sym) return null;
    let best = null;
    for (const state of this._journalPositionState.values()) {
      const stateSym = String(state?.symbol || '').toUpperCase();
      const stateSide = String(state?.side || '').toUpperCase();
      if (!stateSym || stateSym !== sym) continue;
      if (sd && stateSide && stateSide !== sd) continue;
      if (!best || Number(state?.openedAtMs || 0) > Number(best?.openedAtMs || 0)) {
        best = state;
      }
    }
    return best;
  }

  _journalBuildEvent(state, eventType, extra = {}) {
    state.seq = (Number(state.seq) || 0) + 1;
    const eventAt = extra.eventAt || new Date().toISOString();
    return {
      eventType,
      eventAt,
      sequence: state.seq,
      idempotencyKey: `${state.tradeUid}:${state.seq}`,
      quantity: extra.quantity ?? null,
      entryPrice: extra.entryPrice ?? null,
      currentPrice: extra.currentPrice ?? null,
      exitPrice: extra.exitPrice ?? null,
      pnl: extra.pnl ?? null,
      slBefore: extra.slBefore ?? null,
      slAfter: extra.slAfter ?? null,
      tpBefore: extra.tpBefore ?? null,
      tpAfter: extra.tpAfter ?? null,
      payload: extra.payload && typeof extra.payload === 'object' ? extra.payload : {}
    };
  }

  _journalQueueEvents(state, events, immediate = false) {
    if (!state || !Array.isArray(events) || events.length === 0) return;
    state.pending = Array.isArray(state.pending) ? state.pending : [];
    state.pending.push(...events);
    if (immediate) {
      if (state.timerId) {
        clearTimeout(state.timerId);
        state.timerId = null;
      }
      this._journalFlushState(state, true);
      return;
    }
    if (state.timerId) return;
    state.timerId = setTimeout(() => {
      state.timerId = null;
      this._journalFlushState(state, false);
    }, this._journalDebounceMs);
  }

  _journalFlushState(state, force = false) {
    if (!state || !Array.isArray(state.pending) || state.pending.length === 0) return;
    if (!chrome?.runtime?.id || !chrome.runtime.sendMessage) return;
    const payload = {
      tradeUid: state.tradeUid,
      clientTradeId: state.clientTradeId || null,
      symbol: state.symbol || null,
      side: state.side || null,
      currency: 'USD',
      source: 'extension',
      captureQuality: 'full',
      metadata: {
        host: window.location.hostname
      },
      events: state.pending.splice(0)
    };
    try {
      chrome.runtime.sendMessage({
        type: 'TG_SYNC_JOURNAL_EVENTS',
        payload: {
          ...payload,
          force: !!force
        }
      });
    } catch (_err) {
      // ignore — background queue handles retries when available
    }
  }

  _journalEmitRuleBlock({
    side = null,
    symbol = null,
    reason = null,
    title = null,
    tradeUid = null,
    clientTradeId = null,
    ruleSlug = null
  } = {}) {
    if (!chrome?.runtime?.id || !chrome.runtime.sendMessage) return;
    const now = Date.now();
    const linkedState =
      this._findJournalStateForSymbolSide(symbol, side) ||
      this._findJournalStateForSymbolSide(symbol, null);
    const resolvedTradeUid =
      tradeUid ||
      linkedState?.tradeUid ||
      `tgx_rule_block_${String(symbol || 'NA').toUpperCase()}_${String(side || 'NA').toUpperCase()}_${now}`;
    const resolvedClientTradeId =
      clientTradeId ||
      linkedState?.clientTradeId ||
      null;
    const payload = {
      tradeUid: resolvedTradeUid,
      clientTradeId: resolvedClientTradeId,
      symbol: symbol || null,
      side: side || null,
      currency: 'USD',
      source: 'extension',
      captureQuality: 'partial',
      metadata: {
        host: window.location.hostname,
        reason: reason || null,
        title: title || null,
        ruleSlug: ruleSlug || null
      },
      events: [
        {
          eventType: 'RULE_BLOCK',
          eventAt: new Date(now).toISOString(),
          sequence: 1,
          idempotencyKey: `${resolvedTradeUid}:RULE_BLOCK:${ruleSlug || 'rule'}:${now}`,
          payload: {
            side: side || null,
            reason: reason || null,
            title: title || null,
            ruleSlug: ruleSlug || null
          }
        }
      ]
    };
    try {
      chrome.runtime.sendMessage({ type: 'TG_SYNC_JOURNAL_EVENTS', payload });
    } catch (_err) {
      // ignore
    }
  }

  _journalCaptureSnapshot(eventType, state) {
    if (!state?.tradeUid) return;
    if (!chrome?.runtime?.id || !chrome.runtime.sendMessage) return;
    const key = `${state.tradeUid}:${String(eventType || '').toUpperCase()}`;
    const now = Date.now();
    const last = this._journalLastSnapshotAt.get(key) || 0;
    if (now - last < 15000) return; // 15s cooldown per trade/event type
    this._journalLastSnapshotAt.set(key, now);
    try {
      chrome.runtime.sendMessage({
        type: 'TG_CAPTURE_AND_SYNC_JOURNAL_MEDIA',
        payload: {
          tradeUid: state.tradeUid,
          eventType,
          capturedAt: new Date().toISOString()
        }
      });
    } catch (_err) {
      // ignore
    }
  }

  _captureJournalPositionEvents(previousPositions, nextPositions, suppressPositionTransitions = false) {
    if (suppressPositionTransitions) return;
    const prev = Array.isArray(previousPositions) ? previousPositions : [];
    const next = Array.isArray(nextPositions) ? nextPositions : [];
    const nowIso = new Date().toISOString();

    for (const p of next) {
      const key = this._journalPositionKey(p);
      let state = this._journalPositionState.get(key);
      if (!state) {
        const openedAtMs = this._positionFirstSeenMs.get(this._positionKey(p)) || Date.now();
        state = {
          key,
          tradeUid: this._journalTradeUidForPosition(p, openedAtMs),
          clientTradeId: this._stableClientTradeIdForPosition(p, openedAtMs),
          openedAtMs,
          seq: 0,
          pending: [],
          timerId: null,
          symbol: p.symbol || null,
          side: p.side || null,
          last: {
            quantity: this._journalNormalizeNumber(p.volume),
            entryPrice: this._journalNormalizeNumber(p.entryPrice),
            currentPrice: this._journalNormalizeNumber(p.currentPrice),
            pnl: this._journalNormalizeNumber(p.profit),
            stopLoss: this._journalNormalizeNumber(p.stopLoss),
            takeProfit: this._journalNormalizeNumber(p.takeProfit)
          }
        };
        this._journalPositionState.set(key, state);
        this._journalQueueEvents(state, [
          this._journalBuildEvent(state, 'OPEN', {
            eventAt: new Date(openedAtMs).toISOString(),
            quantity: state.last.quantity,
            entryPrice: state.last.entryPrice,
            currentPrice: state.last.currentPrice,
            pnl: state.last.pnl,
            slAfter: state.last.stopLoss,
            tpAfter: state.last.takeProfit
          })
        ]);
        this._journalCaptureSnapshot('OPEN', state);
        continue;
      }

      state.symbol = p.symbol || state.symbol;
      state.side = p.side || state.side;
      const cur = {
        quantity: this._journalNormalizeNumber(p.volume),
        entryPrice: this._journalNormalizeNumber(p.entryPrice),
        currentPrice: this._journalNormalizeNumber(p.currentPrice),
        pnl: this._journalNormalizeNumber(p.profit),
        stopLoss: this._journalNormalizeNumber(p.stopLoss),
        takeProfit: this._journalNormalizeNumber(p.takeProfit)
      };
      const events = [];
      if (cur.stopLoss !== state.last.stopLoss) {
        events.push(this._journalBuildEvent(state, 'SL_UPDATE', {
          eventAt: nowIso,
          slBefore: state.last.stopLoss,
          slAfter: cur.stopLoss,
          quantity: cur.quantity,
          entryPrice: cur.entryPrice,
          currentPrice: cur.currentPrice,
          pnl: cur.pnl
        }));
      }
      if (cur.takeProfit !== state.last.takeProfit) {
        events.push(this._journalBuildEvent(state, 'TP_UPDATE', {
          eventAt: nowIso,
          tpBefore: state.last.takeProfit,
          tpAfter: cur.takeProfit,
          quantity: cur.quantity,
          entryPrice: cur.entryPrice,
          currentPrice: cur.currentPrice,
          pnl: cur.pnl
        }));
      }
      if (cur.quantity !== state.last.quantity) {
        events.push(this._journalBuildEvent(state, 'SIZE_UPDATE', {
          eventAt: nowIso,
          quantity: cur.quantity,
          entryPrice: cur.entryPrice,
          currentPrice: cur.currentPrice,
          pnl: cur.pnl
        }));
      }
      if (events.length > 0) this._journalQueueEvents(state, events);
      state.last = cur;
    }

    const closed = this._findClosedPositions(prev, next);
    for (const p of closed) {
      const key = this._journalPositionKey(p);
      const state = this._journalPositionState.get(key);
      if (!state) continue;
      const closeEvent = this._journalBuildEvent(state, 'CLOSE', {
        eventAt: nowIso,
        quantity: this._journalNormalizeNumber(p.volume),
        entryPrice: this._journalNormalizeNumber(p.entryPrice),
        exitPrice: this._journalNormalizeNumber(p.currentPrice),
        currentPrice: this._journalNormalizeNumber(p.currentPrice),
        pnl: this._journalNormalizeNumber(p.profit),
        slAfter: this._journalNormalizeNumber(p.stopLoss),
        tpAfter: this._journalNormalizeNumber(p.takeProfit)
      });
      this._journalCaptureSnapshot('CLOSE', state);
      this._journalQueueEvents(state, [closeEvent], true);
      if (state.timerId) {
        clearTimeout(state.timerId);
      }
      this._journalPositionState.delete(key);
    }
  }

  _syncPositionOpenTimes(trades) {
    const list = Array.isArray(trades) ? trades : [];
    const seen = new Set();
    const now = Date.now();
    for (const t of list) {
      const key = this._positionKey(t);
      seen.add(key);
      if (!this._positionFirstSeenMs.has(key)) {
        this._positionFirstSeenMs.set(key, now);
      }
    }
    for (const key of [...this._positionFirstSeenMs.keys()]) {
      if (!seen.has(key)) this._positionFirstSeenMs.delete(key);
    }
  }

  _getEffectiveMinimumHoldMinutes(config) {
    if (!config || config.minimumHoldEnabled !== true) return null;
    const fallback = Math.max(0, Number(config.minimumHoldMinutes) || 0);
    const host = (window.location.hostname || '').toLowerCase();
    const raw = config.minimumHoldPlatformOverrides;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw)) {
        if (String(k).toLowerCase() !== host) continue;
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0) return n;
      }
    }
    return fallback;
  }

  _attachMinimumHoldGuard() {
    if (this._minimumHoldGuardAttached) return;
    this._minimumHoldGuardAttached = true;
    document.addEventListener('click', (e) => this._onPossibleCloseClick(e), true);
  }

  /**
   * Intercepts position close clicks:
   * - HTF: config `htfMinimumChartMinutes` = minimum minutes the position must stay open before close (no override).
   * - Minimum hold: separate rule with optional override.
   */
  _onPossibleCloseClick(domEvent) {
    if (this._isMappingActive()) return;
    const target = domEvent.target;
    if (!(target instanceof HTMLElement)) return;

    const config = this._cachedRiskConfig;
    if (!config) return;

    const htfCloseOn =
      config.htfMinimumEnabled === true && Number(config.htfMinimumChartMinutes) > 0;
    const htfNeedMin = htfCloseOn ? Math.max(1, Number(config.htfMinimumChartMinutes)) : 0;

    const minHoldOn = config.minimumHoldEnabled === true;
    const minMin = minHoldOn ? this._getEffectiveMinimumHoldMinutes(config) : null;
    const minHoldActive = minHoldOn && minMin != null && minMin > 0;

    if (!htfCloseOn && !minHoldActive) return;

    const trades = this._stabilizeTrades(this.getLiveTrades()) || [];
    for (const t of trades) {
      if (!t.element || !t.closeSelector) continue;
      let closeBtn = null;
      try {
        closeBtn = t.element.querySelector(t.closeSelector);
      } catch (_err) {
        continue;
      }
      if (!closeBtn || !(closeBtn instanceof HTMLElement)) continue;
      if (target !== closeBtn && !closeBtn.contains(target)) continue;

      const skipMinimumHoldOnce = closeBtn.__tgAllowNextClose === true;
      if (skipMinimumHoldOnce) {
        closeBtn.__tgAllowNextClose = false;
      }

      const key = this._positionKey(t);
      const first = this._positionFirstSeenMs.get(key);

      if (htfCloseOn) {
        const needMs = htfNeedMin * 60 * 1000;
        const elapsed = first != null ? Date.now() - first : needMs;
        if (elapsed < needMs) {
          const remainSec = Math.ceil((needMs - elapsed) / 1000);
          domEvent.preventDefault();
          domEvent.stopPropagation();
          if (typeof domEvent.stopImmediatePropagation === 'function') domEvent.stopImmediatePropagation();
          const sym = t.symbol || 'this position';
          const msg = `Higher timeframe rule: ${sym} must stay open at least ${htfNeedMin} minute(s) from your config. Wait ~${remainSec}s before closing — the trade will not close until then.`;
          this._journalEmitRuleBlock({
            side: t.side || null,
            symbol: t.symbol || null,
            reason: msg,
            title: 'HTF: close not allowed yet',
            ruleSlug: 'htf-minimum'
          });
          this.showBlockedReason(msg, config, { title: 'HTF: close not allowed yet' });
          return;
        }
      }

      if (skipMinimumHoldOnce || !minHoldActive) return;

      const needMs = minMin * 60 * 1000;
      const elapsed = first != null ? Date.now() - first : needMs;
      if (elapsed >= needMs) return;

      const remainSec = Math.ceil((needMs - elapsed) / 1000);
      domEvent.preventDefault();
      domEvent.stopPropagation();
      if (typeof domEvent.stopImmediatePropagation === 'function') domEvent.stopImmediatePropagation();

      const sym = t.symbol || 'this position';
      const msg = `Minimum hold (${minMin} min): wait ~${remainSec}s before closing ${sym}.`;
      this._journalEmitRuleBlock({
        side: t.side || null,
        symbol: t.symbol || null,
        reason: msg,
        title: 'Close blocked',
        ruleSlug: 'minimum-hold'
      });
      this.showBlockedReason(msg, config, {
        title: 'Close blocked',
        confirmMode: true,
        onContinue: () => {
          closeBtn.__tgAllowNextClose = true;
          closeBtn.click();
        }
      });
      return;
    }
  }

  _clearSlTpReminder() {
    if (this.slTpReminderId) {
      clearInterval(this.slTpReminderId);
      this.slTpReminderId = null;
    }
    if (this._slTpFirstTimeoutId) {
      clearTimeout(this._slTpFirstTimeoutId);
      this._slTpFirstTimeoutId = null;
    }
    this._slTpScheduleKey = null;
  }

  updateSlTpReminder(activeTrades) {
    if (this._isMappingActive()) return;

    this.getConfig().then((config) => {
      if (!config || config.stopLossAlertEnabled !== true) {
        this._clearSlTpReminder();
        return;
      }

      const hasOpenTrade = Array.isArray(activeTrades) && activeTrades.length > 0;
      if (!hasOpenTrade) {
        this._clearSlTpReminder();
        return;
      }

      const trades = this._stabilizeTrades(this.getLiveTrades()) || [];
      if (trades.length === 0) {
        this._clearSlTpReminder();
        return;
      }

      const needsSlReminder = trades.some((t) => {
        const sl = t.stopLoss;
        return !(sl != null && Number(sl) > 0);
      });
      if (!needsSlReminder) {
        this._clearSlTpReminder();
        return;
      }

      // Seconds from dashboard rule (`alertDelaySeconds` → storage `stopLossAlertDelaySeconds` via rules sync)
      const delaySecRaw = Number(config.stopLossAlertDelaySeconds);
      const delaySec = Number.isFinite(delaySecRaw) && delaySecRaw > 0 ? delaySecRaw : 30;
      const delayMs = Math.max(5000, delaySec * 1000);
      const delayLabel = Math.round(delayMs / 1000);

      const noSlKey = trades
        .filter((t) => !(t.stopLoss != null && Number(t.stopLoss) > 0))
        .map((t) => `${String(t.symbol || '').toUpperCase()}|${String(t.side || '').toUpperCase()}`)
        .sort()
        .join(',');
      const scheduleKey = `${delayMs}|${noSlKey}`;

      if (
        this._slTpScheduleKey === scheduleKey &&
        (this.slTpReminderId != null || this._slTpFirstTimeoutId != null)
      ) {
        return;
      }

      this._clearSlTpReminder();
      this._slTpScheduleKey = scheduleKey;

      const runSlTpTick = () => {
        const cur = this._stabilizeTrades(this.getLiveTrades()) || [];
        if (cur.length === 0) {
          this._clearSlTpReminder();
          return;
        }
        const stillNeed = cur.some((t) => {
          const sl = t.stopLoss;
          return !(sl != null && Number(sl) > 0);
        });
        if (!stillNeed) {
          this._clearSlTpReminder();
          return;
        }
        const primaryNoSlTrade =
          cur.find((t) => {
            const sl = t?.stopLoss;
            return !(sl != null && Number(sl) > 0);
          }) || cur[0];
        const lines = cur.map((t) => {
          const sl = t.stopLoss != null && Number(t.stopLoss) > 0 ? String(t.stopLoss) : '0';
          const tp = t.takeProfit != null && Number(t.takeProfit) > 0 ? String(t.takeProfit) : '0';
          return `${t.symbol || '?'} — SL: ${sl}, TP: ${tp}`;
        });
        const detail = lines.join(' · ');
        this._journalEmitRuleBlock({
          side: primaryNoSlTrade?.side || null,
          symbol: primaryNoSlTrade?.symbol || null,
          reason: `Stop loss reminder (advisory): ${detail}`,
          title: 'No stop loss detected',
          ruleSlug: 'stop-loss-alert'
        });
        if (typeof showNoStopLossOverlay === 'function') {
          showNoStopLossOverlay({
            symbol: primaryNoSlTrade?.symbol || '?',
            stopLoss: primaryNoSlTrade?.stopLoss,
            takeProfit: primaryNoSlTrade?.takeProfit,
            message: `Current: ${detail}`,
            repeatIntervalSeconds: delayLabel,
            onSetStopLoss: () => this._focusStopLossControl(primaryNoSlTrade)
          });
          return;
        }
        if (typeof showWarningOverlay === 'function') {
          showWarningOverlay({
            title: 'Set stop loss (reminder)',
            message: `Current: ${detail}. Where SL is 0, please set a stop loss. Repeats every ${delayLabel}s while the dashboard rule is on. Advisory only.`,
            highlight: false
          });
        }
      };

      // First prompt after rule delay, then repeat at same interval (not on every DOM refresh)
      this._slTpFirstTimeoutId = setTimeout(() => {
        this._slTpFirstTimeoutId = null;
        runSlTpTick();
        this.slTpReminderId = setInterval(runSlTpTick, delayMs);
      }, delayMs);
    });
  }

  _focusStopLossControl(trade) {
    if (!trade?.element || !(trade.element instanceof HTMLElement)) return;
    const row = trade.element;
    try {
      row.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    } catch (_err) {
      // ignore
    }
    const prevOutline = row.style.outline;
    const prevOffset = row.style.outlineOffset;
    row.style.outline = '2px solid rgba(245,158,11,0.9)';
    row.style.outlineOffset = '2px';
    setTimeout(() => {
      row.style.outline = prevOutline;
      row.style.outlineOffset = prevOffset;
    }, 2200);
    const stopLossSelector = trade?.fieldIdentity?.scoped?.stopLoss;
    if (!stopLossSelector) return;
    try {
      const target = row.querySelector(stopLossSelector);
      if (target instanceof HTMLElement) {
        target.click();
      }
    } catch (_err) {
      // selector can be stale; visual focus on row is still useful
    }
  }

  async evaluateAndReact(mode) {
    // Ask background risk engine for a decision (ALLOW / WARN / BLOCK / CLOSE_TRADES)
    // based on current accountState and active positions. We always fire this —
    // even when unpaired — because TG_EVALUATE_ACCOUNT is the only path that
    // persists `activeTrades` to chrome.storage for the popup to render. The
    // user-facing side effects (toasts, overlays, auto-close) are gated on
    // _isPaired at their individual call sites instead.
    return new Promise((resolve) => {
      if (!chrome?.runtime?.id || !chrome.runtime.sendMessage) {
        resolve(null);
        return;
      }
      try {
        chrome.runtime.sendMessage(
          {
            type: 'TG_EVALUATE_ACCOUNT',
            payload: {
              accountState: this.accountState,
              activeTrades: this.accountState.positions
            }
          },
          (decision) => {
            if (chrome.runtime?.lastError) {
              resolve(null);
              return;
            }
            if (!decision) {
              resolve(null);
              return;
            }
            const { decision: status, metrics } = decision;
            // PASSIVE side-effects (WARN toast, auto-close) only fire for
            // paired users — unpaired clients still send TG_EVALUATE_ACCOUNT
            // to refresh the popup's activeTrades, but rule outcomes must
            // stay invisible.
            if (this._isPaired && !this._isMappingActive() && mode === 'PASSIVE') {
              if (status === 'WARN' && typeof showToast === 'function') {
                showToast(
                  `Daily loss at ${((Number(metrics?.floatingLoss) / Number(metrics?.dailyLossLimitAmount)) * 100).toFixed(0)}% of limit. $${formatCurrency(Number(metrics?.dailyLossLimitAmount) - Number(metrics?.floatingLoss))} remaining before hard stop.`,
                  'warn'
                );
              }
              // Auto-close safeguard: if floating loss reaches >=95% of configured daily loss limit,
              // attempt to close open trades once using mapped close buttons.
              const loss = Number(metrics?.floatingLoss);
              const limit = Number(metrics?.dailyLossLimitAmount);
              if (
                !this._dailyLossAutoCloseTriggered &&
                Number.isFinite(loss) &&
                Number.isFinite(limit) &&
                limit > 0 &&
                loss / limit >= 0.95
              ) {
                this._dailyLossAutoCloseTriggered = true;
                this.tryAutoCloseTrades(metrics);
              }
            }
            if (status === 'CLOSE_TRADES') {
              this.tryAutoCloseTrades(metrics);
            }
            resolve(decision);
          }
        );
      } catch (err) {
        resolve(null);
      }
    });
  }

  tryAutoCloseTrades(metrics) {
    if (!this.detector) return;
    if (this._orderTracker?.isBound()) {
      const trades = this._orderTracker.getTrades();
      let clickedRowClose = false;
      for (const t of trades) {
        if (!t?.element || !t?.closeSelector) continue;
        try {
          const btn = t.element.querySelector(t.closeSelector);
          if (btn instanceof HTMLElement) {
            btn.click();
            clickedRowClose = true;
          }
        } catch (_err) {
          // ignore invalid selector; fallback below
        }
      }
      if (clickedRowClose) {
        if (typeof showToast === 'function') {
          showToast('Attempted to close open trades from tracked order rows.', 'warn');
        }
        return;
      }
    }
    const root =
      this._resolveIdentityContainer() ||
      this._getTradesScanRoot() ||
      document.body;
    let closeButtons = this.detector.detectCloseButtons(root);
    if ((!closeButtons || closeButtons.length === 0) && root !== document.body) {
      closeButtons = this.detector.detectCloseButtons(document.body);
    }
    let didClick = false;
    closeButtons.forEach((el) => {
      if (el instanceof HTMLElement) {
        el.click();
        didClick = true;
      }
    });
    if (!didClick && typeof showWarningOverlay === 'function') {
      this._journalEmitRuleBlock({
        side: null,

        symbol: null,
        reason: `Auto-close warning: could not find close button. Floating loss ${formatCurrency(metrics?.floatingLoss)} vs limit ${formatCurrency(metrics?.dailyLossLimitAmount)}.`,
        title: 'Risk: close manually',
        ruleSlug: 'daily-loss'
      });
      showWarningOverlay({
        title: 'Daily loss limit reached — close all positions',
        message: `Floating loss: $${formatCurrency(metrics?.floatingLoss)} has hit your $${formatCurrency(metrics?.dailyLossLimitAmount)} daily limit. Close all positions now. Further trading will deepen losses.`,
        highlight: true
      });
      if (typeof flashScreen === 'function') flashScreen();
    } else if (didClick && typeof showToast === 'function') {
      showToast('Attempted to close open trades. Execution is not guaranteed.', 'warn');
    }
  }
}

function formatCurrency(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '–';
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

window.TradeMonitor = TradeMonitor;
