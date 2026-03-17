/* global chrome, showWarningOverlay, showNoStopLossOverlay, showBlockedTradeOverlay, showTradeClosedOverlay, showToast, flashScreen */

function debounce(func, wait) {
  let timeout;
  return function (...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
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
    this._autoMappingChecked = false;
    this._autoRemapChecked = false;
    this._requiresMapping = false;
    this._monitoringStarted = false;
    this._mappedSelectors = null;
    this._mappingEligibilityTimer = null;
    this._mappingPromptedOnce = false;
    this._lastScanPositions = [];
    this._buyButtonEl = null;
    this._sellButtonEl = null;
    this._dailyLossAutoCloseTriggered = false;
  }

  // Initialize message listeners, load mapping/profile, then start monitoring if host is mapped.
  async init() {
    if (!this.detector) return;
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
    this._requiresMapping = !this._hasSavedMappingForHost();
    if (this._requiresMapping) {
      this._startMappingEligibilityWatcher();
      return;
    }
    this._stopMappingEligibilityWatcher();
    this._startMonitoringLoops();
  }

  _startMonitoringLoops() {
    if (this._monitoringStarted) return;
    this._monitoringStarted = true;
    // Kick off one scan and then keep state in sync via DOM mutations + interval polling.
    this.runFullScan();
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
  }

  _hasSavedMappingForHost() {
    const s = this._loadedSelectors || {};
    return s.mapping_complete === true;
  }

  _hasChartSignals() {
    try {
      const chartSelector = [
        'canvas',
        'svg',
        '[id*="chart"]',
        '[class*="chart"]',
        '[class*="tradingview"]',
        '[data-test*="chart"]',
        '[data-testid*="chart"]'
      ].join(',');
      const nodes = document.querySelectorAll(chartSelector);
      return nodes.length >= 2;
    } catch (_err) {
      return false;
    }
  }

  _isLikelyBrokerTradingPage() {
    if (!this.detector) return false;
    const buttons = this.detector.detectTradeButtons?.(document.body) || { buyButtons: [], sellButtons: [] };
    const hasTradeButtons = (buttons.buyButtons?.length || 0) + (buttons.sellButtons?.length || 0) > 0;
    const hasOrderIdentity = !!this.detector.detectOrderDetailsIdentity?.(document.body);
    const hasChart = this._hasChartSignals();
    return (hasTradeButtons && hasChart) || (hasTradeButtons && hasOrderIdentity);
  }

  _startMappingEligibilityWatcher() {
    if (this._mappingEligibilityTimer) return;
    if (!/^https?:/i.test(window.location.protocol || '')) return;
    if (this._hasSavedMappingForHost()) return;

    const tick = () => {
      if (this._hasSavedMappingForHost()) {
        this._requiresMapping = false;
        this._stopMappingEligibilityWatcher();
        return;
      }
      if (this._isMappingActive()) return;
      if (!this._isLikelyBrokerTradingPage()) return;
      if (this._mappingPromptedOnce) return;

      this._mappingPromptedOnce = true;
      this.startGuidedPlatformMapping().catch(() => {
        // allow one retry cycle from watcher if first start fails due to SPA timing
        this._mappingPromptedOnce = false;
      });
      if (typeof showToast === 'function') {
        showToast('Broker terminal detected. Map this platform once to start detection.', 'info');
      }
    };

    tick();
    this._mappingEligibilityTimer = window.setInterval(tick, 2000);
  }

  _stopMappingEligibilityWatcher() {
    if (!this._mappingEligibilityTimer) return;
    clearInterval(this._mappingEligibilityTimer);
    this._mappingEligibilityTimer = null;
  }

  _isMappedCrawlMode() {
    const s = this._mappedSelectors || this._loadedSelectors || {};
    // Mapped-only rule: once mapping is marked complete, do not fallback to heuristics.
    return s.mapping_complete === true;
  }

  _maybeAutoStartGuidedMapping() {
    if (this._autoMappingChecked) return;
    this._autoMappingChecked = true;
    if (this._hasSavedMappingForHost()) return;
    if (!/^https?:/i.test(window.location.protocol || '')) return;
    window.setTimeout(() => {
      if (this._mappingSession) return;
      this.startGuidedPlatformMapping();
      if (typeof showToast === 'function') {
        showToast('First time on this platform: click elements to map fields.', 'info');
      }
    }, 1200);
  }

  _maybeAutoRemapIfUnhooked() {
    // Disabled by design:
    // If host is already mapped, do not auto-show mapping again.
    // Remapping should be user-initiated from popup.
  }

  _attachRuntimeHandlers() {
    // TG_START_PLATFORM_MAPPING is handled in content.js with a bound monitor reference.
    if (!chrome?.runtime?.id || !chrome.runtime.onMessage || this._messageHandler) return;
    this._messageHandler = (_message, _sender, _sendResponse) => {
      // Other message types can be handled here if needed.
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

  _setButtonBlocked(btn, reason) {
    if (!btn || !(btn instanceof HTMLElement)) return;
    btn.dataset.tgBlocked = 'true';
    btn.dataset.tgBlockedReason = reason || '';
    btn.disabled = true;
    btn.style.opacity = '0.5';
    btn.style.cursor = 'not-allowed';
    if (btn.__tgBlockHandler) return;
    btn.__tgBlockHandler = (e) => {
      e.preventDefault();
      e.stopPropagation();
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

    const balanceItem = aiValidatedResult.balanceSelector;
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

    const rowItem = aiValidatedResult.rowSelector;
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
  }

  _mappingStatus(text) {
    if (!this._mappingSession?.statusEl) return;
    this._mappingSession.statusEl.textContent = text || '';
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
    if (capture?.closeButtonSelector) fieldSelectors.closeButton = capture.closeButtonSelector;
    if (capture?.containerSelector) fieldSelectors.container = capture.containerSelector;

    if (capture?.balanceSelector) absoluteFieldSelectors.balance = capture.balanceSelector;
    if (capture?.equitySelector) absoluteFieldSelectors.equity = capture.equitySelector;
    if (capture?.buyButtonSelector) absoluteFieldSelectors.buyButton = capture.buyButtonSelector;
    if (capture?.sellButtonSelector) absoluteFieldSelectors.sellButton = capture.sellButtonSelector;
    if (capture?.closeButtonSelector) absoluteFieldSelectors.closeButton = capture.closeButtonSelector;
    if (capture?.containerSelector) absoluteFieldSelectors.container = capture.containerSelector;

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
      ...(capture.closeButtonSelector ? { close_button: capture.closeButtonSelector } : {}),
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
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'TG_SAVE_SELECTORS', payload: { host, selectors } },
        (res) => resolve(!!res?.success)
      );
    });
  }

  _createMapperOverlay() {
    if (!document.getElementById('tg-mapper-styles')) {
      const style = document.createElement('style');
      style.id = 'tg-mapper-styles';
      style.textContent = `
        @keyframes tg-scan {0%{transform:translateY(-100%);opacity:0}10%{opacity:.06}90%{opacity:.06}100%{transform:translateY(400%);opacity:0}}
        @keyframes tg-slide-up {from{transform:translateY(32px);opacity:0}to{transform:translateY(0);opacity:1}}
        @keyframes tg-glow-pulse {0%,100%{box-shadow:0 0 0 0 rgba(0,255,160,0)}50%{box-shadow:0 0 18px 3px rgba(0,255,160,.22)}}
        #tg-mapper-bar * { box-sizing: border-box; }
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
      'display:flex;align-items:center;padding:10px 16px 8px;border-bottom:1px solid rgba(255,255,255,0.05);gap:0;';
    const brand = document.createElement('div');
    brand.style.cssText = 'display:flex;align-items:center;gap:8px;flex-shrink:0;';
    const logoWrap = document.createElement('div');
    logoWrap.style.cssText =
      'width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,#00ffa0,#00c8ff);display:flex;align-items:center;justify-content:center;overflow:hidden;';
    const logo = document.createElement('img');
    logo.alt = 'TradeGuardX';
    logo.src = chrome?.runtime?.getURL ? chrome.runtime.getURL('icons/logo.png') : '';
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
      '<div style="font-size:12px;font-weight:800;color:#e8f8f2;letter-spacing:0.03em;line-height:1;">TradeGuarX</div><div style="font-size:9px;font-family:\'IBM Plex Mono\',monospace;color:#00ffa0;letter-spacing:0.12em;margin-top:1px;">AI MAPPER</div>';
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
      'font-size:9px;font-weight:700;letter-spacing:0.1em;font-family:"IBM Plex Mono",monospace;padding:2px 7px;border-radius:4px;background:rgba(6,78,59,.5);border:1px solid rgba(0,255,160,.3);color:#6ee7b7;';
    stepReq.textContent = 'REQUIRED';
    const stepMeta = document.createElement('div');
    stepMeta.style.cssText =
      'font-size:9px;color:#4a7060;font-family:"IBM Plex Mono",monospace;letter-spacing:0.08em;';
    stepMeta.textContent = '1 / 15';
    badgeRow.appendChild(stepReq);
    badgeRow.appendChild(stepMeta);
    const step = document.createElement('div');
    step.style.cssText =
      'font-size:15px;font-weight:700;color:#e2f8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.2;';
    step.textContent = 'Press Start to begin';
    const stepHint = document.createElement('div');
    stepHint.style.cssText =
      'font-size:11px;color:#4a7060;margin-top:2px;font-family:"IBM Plex Mono",monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    stepHint.textContent = '→ Click Start to begin mapping your broker';
    stepInfo.appendChild(badgeRow);
    stepInfo.appendChild(step);
    stepInfo.appendChild(stepHint);
    const div2 = document.createElement('div');
    div2.style.cssText = 'width:1px;height:32px;background:rgba(255,255,255,0.08);margin:0 14px;flex-shrink:0;';
    const statusWrap = document.createElement('div');
    statusWrap.style.cssText = 'flex-shrink:0;text-align:right;max-width:190px;';
    const status = document.createElement('div');
    status.style.cssText = 'font-size:11px;color:#4a7060;font-family:"IBM Plex Mono",monospace;line-height:1.4;';
    status.textContent = 'Ready';
    const captured = document.createElement('div');
    captured.style.cssText =
      'font-size:10px;font-weight:600;color:#00ffa0;font-family:"IBM Plex Mono",monospace;margin-top:2px;';
    captured.textContent = '0 / 15 captured';
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
      ['container', 'Container'],
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
        'padding:4px 9px;border-radius:20px;font-size:10px;font-weight:600;font-family:"IBM Plex Mono",monospace;letter-spacing:.05em;border:1px solid rgba(255,255,255,.08);background:rgba(6,12,26,.85);color:rgba(255,255,255,.2);cursor:pointer;';
      chip.textContent = `• ${label}`;
      capturedChips[key] = chip;
    });

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:7px;flex-shrink:0;align-items:center;';
    const backBtn = document.createElement('button');
    backBtn.textContent = '← Back';
    backBtn.disabled = true;
    backBtn.style.cssText =
      'height:34px;padding:0 13px;border-radius:8px;border:1px solid rgba(148,163,184,.2);background:rgba(15,23,42,.6);color:#4a6070;cursor:not-allowed;font-size:12px;font-weight:600;opacity:.5;';
    const skipBtn = document.createElement('button');
    skipBtn.textContent = 'Skip →';
    skipBtn.style.cssText =
      'height:34px;padding:0 13px;border-radius:8px;display:none;border:1px solid rgba(59,130,246,.35);background:rgba(30,58,138,.25);color:#93c5fd;cursor:pointer;font-size:12px;font-weight:600;';
    const pauseBtn = document.createElement('button');
    pauseBtn.textContent = '⏸ Pause';
    pauseBtn.disabled = true;
    pauseBtn.style.cssText =
      'height:34px;padding:0 13px;border-radius:8px;border:1px solid rgba(251,191,36,.3);background:rgba(120,53,15,.2);color:#fbbf24;cursor:not-allowed;font-size:12px;font-weight:600;opacity:.5;';
    const startBtn = document.createElement('button');
    startBtn.textContent = '▶ Start';
    startBtn.style.cssText =
      'height:34px;padding:0 18px;border-radius:8px;border:none;background:linear-gradient(135deg,#00ffa0,#00d4aa);color:#001a0e;cursor:pointer;font-size:13px;font-weight:800;box-shadow:0 4px 18px rgba(0,255,160,.28);animation:tg-glow-pulse 2.5s ease-in-out infinite;';
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = '✕';
    cancelBtn.style.cssText =
      'height:34px;padding:0 11px;border-radius:8px;border:1px solid rgba(239,68,68,.25);background:rgba(127,29,29,.18);color:#f87171;cursor:pointer;font-size:13px;font-weight:700;';
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
      'display:none;padding:10px 16px;border-top:1px solid rgba(167,139,250,.15);background:rgba(76,29,149,.12);font-size:12px;color:#c4b5fd;';
    aiHint.textContent = 'Claude AI is analyzing your mapping...';
    inner.appendChild(aiHint);

    overlay.appendChild(inner);
    document.documentElement.appendChild(overlay);

    const reopenBtn = document.createElement('button');
    reopenBtn.type = 'button';
    reopenBtn.textContent = '⚡ Resume mapping';
    reopenBtn.style.cssText =
      'position:fixed;bottom:18px;right:18px;z-index:2147483647;display:none;padding:8px 14px;background:linear-gradient(135deg,rgba(6,12,26,.97),rgba(2,6,18,.99));border:1px solid rgba(0,255,160,.35);border-radius:22px;color:#00ffa0;font-size:12px;font-weight:700;cursor:pointer;box-shadow:0 6px 24px rgba(0,0,0,.5);';
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
          beacon.textContent = 'Open Mapper';
          beacon.style.cssText = [
            'all: initial !important',
            'position: fixed !important',
            'right: 18px !important',
            'bottom: 64px !important',
            'left: auto !important',
            'top: auto !important',
            'transform: none !important',
            'z-index: 2147483647 !important',
            'font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif !important',
            'font-size: 12px !important',
            'font-weight: 700 !important',
            'color: #001a0e !important',
            'background: linear-gradient(135deg,#00ffa0,#00d4ff) !important',
            'border: none !important',
            'border-radius: 10px !important',
            'padding: 8px 12px !important',
            'cursor: pointer !important',
            'box-shadow: 0 10px 28px rgba(0,0,0,0.45) !important'
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
    guideTitle.textContent = 'MAPPING GUIDE';
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
      { key: 'container', label: 'Point to positions table/container', required: true, scope: 'global' },
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
      if (key === 'row') return !!capture.rowSelector;
      return !!capture.fields?.[key]?.selector;
    };

    const clearStepCapture = (key) => {
      if (!key) return;
      if (key === 'container') {
        capture.containerEl = null;
        capture.containerSelector = null;
        capture.containerTag = null;
        capture.rowEl = null;
        capture.rowSelector = null;
        capture.rowSelectorHint = null;
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
      ui.skipBtn.textContent = s.required ? 'Skip' : 'Skip optional';
      ui.backBtn.disabled = !captureActive || stepIdx === 0;
      ui.backBtn.style.opacity = ui.backBtn.disabled ? '0.5' : '1';
      ui.pauseBtn.disabled = !captureActive;
      ui.pauseBtn.style.opacity = ui.pauseBtn.disabled ? '0.5' : '1';
      ui.pauseBtn.style.cursor = ui.pauseBtn.disabled ? 'not-allowed' : 'pointer';
      ui.pauseBtn.textContent = capturePaused ? 'Resume' : 'Pause';
      ui.capturedEl.textContent = `Captured: ${countCapturedFields()} fields`;
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
        ui.dockBtn.textContent = isDocked ? 'Expand' : 'Dock';
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
      const modeLabel = !captureActive ? 'Not started' : capturePaused ? 'Paused' : 'Capturing';
      ui.stepMetaEl.textContent = `Step ${stepIdx + 1} / ${steps.length} · ${modeLabel}`;
      ui.stepReqEl.textContent = s.required ? 'REQUIRED' : 'OPTIONAL';
      ui.stepReqEl.style.color = s.required ? '#6ee7b7' : '#93c5fd';
      ui.stepReqEl.style.background = s.required ? 'rgba(6,78,59,0.35)' : 'rgba(30,64,175,0.22)';
      ui.stepReqEl.style.borderColor = s.required ? 'rgba(52,211,153,0.35)' : 'rgba(59,130,246,0.35)';
      const label = String(s.label || '').replace(/^Point to\s*/i, '');
      ui.stepEl.textContent = label;
      ui.stepHintEl.textContent = `→ ${s.label}`;
      guideStep.textContent = `${s.required ? 'Required' : 'Optional'} · ${label}`;
      guideHint.textContent = capturePaused
        ? 'Paused: use Resume to continue mapping.'
        : `Step ${stepIdx + 1}/${steps.length} · Click exact element on page.`;
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
    this._mappingStatus('Press "Start mapping" to begin.');

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
    let dragStartX = 0;
    let dragStartY = 0;
    let dragOverlayLeft = 0;
    let dragOverlayTop = 0;

    const onDragMove = (e) => {
      if (!dragActive) return;
      // Prevent page text selection / native drag for smoother movement (notably on Windows)
      e.preventDefault();
      e.stopPropagation();
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      ui.overlay.style.left = `${dragOverlayLeft + dx}px`;
      ui.overlay.style.top = `${dragOverlayTop + dy}px`;
      ui.overlay.style.right = 'auto';
      ui.overlay.style.bottom = 'auto';
    };

    const onDragUp = () => {
      if (!dragActive) return;
      dragActive = false;
      document.removeEventListener('mousemove', onDragMove, true);
      document.removeEventListener('mouseup', onDragUp, true);
    };

    const onDragDown = (e) => {
      if (e.button !== 0) return;
      // Avoid text selection and other default behaviors while starting drag
      e.preventDefault();
      e.stopPropagation();
      dragActive = true;
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
      this._mappingStatus('');
    };

    const onStart = () => {
      if (captureActive) return;
      captureActive = true;
      resetMapperLayout(ui.overlay);
      // After starting, visually de‑emphasize Start and enable Pause
      ui.startBtn.disabled = true;
      ui.startBtn.style.opacity = '0.6';
      ui.startBtn.style.cursor = 'default';
      guide.style.display = 'block';
      this._mappingStatus('Mapping started. Panel docked so you can see page. Click exact element for this step.');
      setStepText();
    };

    const onBack = () => {
      if (!captureActive || stepIdx <= 0) return;
      const prev = steps[stepIdx - 1];
      if (prev) clearStepCapture(prev.key);
      stepIdx -= 1;
      this._mappingStatus(`Went back to ${steps[stepIdx].key}. Click again to update it.`);
      setStepText();
    };

    const onPause = () => {
      if (!captureActive) return;
      capturePaused = !capturePaused;
      highlight.style.display = 'none';
      this._mappingStatus(
        capturePaused
          ? 'Mapping paused. You can interact with broker UI. Click Resume when ready.'
          : 'Mapping resumed. Click the exact value for this step.'
      );
      setStepText();
    };

    const onMinimize = () => {
      if (!captureActive) return;
      setMinimized(true);
      this._mappingStatus('Mapper minimized. Use "Resume mapping" button to continue.');
    };

    const onReopen = () => {
      setMinimized(false);
      this._mappingStatus('Mapper restored. Continue from current step.');
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
      this._mappingStatus(`Editing ${human}. Click the new element to replace previous mapping.`);
      setStepText();
    };

    const onToggleDock = () => {
      if (!captureActive) return;
      applyDockMode(!isDocked);
      this._mappingStatus(
        isDocked
          ? 'Docked mode enabled. Page is visible for element selection.'
          : 'Expanded mode enabled.'
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
      const el = e.target;
      if (!(el instanceof HTMLElement)) return;
      if (ui.overlay.contains(el)) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const step = steps[stepIdx];
      if (!step) return;

      if (step.scope === 'global') {
        const selector = this._getExactSelector(el);
        if (!selector) {
          this._mappingStatus('Could not build selector. Click the exact value element.');
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

      if (step.key === 'container') {
        const resolvedContainer = resolveContainerCandidate(el) || el;
        capture.containerEl = resolvedContainer;
        capture.containerSelector = this._getExactSelector(resolvedContainer);
        capture.containerTag = resolvedContainer.tagName.toLowerCase();
        if (!capture.containerSelector) {
          this._mappingStatus('Could not build selector for container. Try another element.');
          return;
        }
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
            this._mappingStatus('Container updated from your click. Continue selecting row.');
          } else {
            this._mappingStatus('Row must be inside selected container.');
            return;
          }
        }
        capture.rowEl = resolveRowCandidate(el, capture.containerEl);
        if (!capture.rowEl || !capture.containerEl.contains(capture.rowEl)) {
          this._mappingStatus('Could not resolve row in selected container.');
          return;
        }
        capture.rowSelector = this._getExactSelector(capture.rowEl, capture.containerEl);
        capture.rowSelectorHint = capture.rowEl.tagName === 'TR' ? 'tr' : null;
        if (!capture.rowSelector) {
          this._mappingStatus('Could not build row selector. Click row again.');
          return;
        }
        // Continue manual mapping steps; Claude verification runs at finalize.
        this._mappingStatus('Row captured. Continue mapping fields.');
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
          this._mappingStatus('Row auto-corrected from your click.');
        } else {
          this._mappingStatus('Please click an element inside the selected row.');
          return;
        }
      }
      const selector = this._getExactSelector(el, capture.rowEl);
      if (!selector) {
        this._mappingStatus('Could not build field selector. Try another element.');
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
      this._mappingStatus(`Captured ${step.key}.`);
      advance();
    };

    const onCancel = () => {
      guide.style.display = 'none';
      this._teardownMapping();
      showToast?.('Platform mapping cancelled.', 'warn');
    };

    const onSkip = () => {
      const step = steps[stepIdx];
      if (!step) return;
      if (step.required) {
        this._mappingStatus('This step is required.');
        return;
      }
      capture.fields[step.key] = null;
      advance();
    };

    const finalize = async () => {
      if (!capture.containerSelector || !capture.rowSelector) {
        this._mappingStatus('Container and row are required.');
        return;
      }
      capture.balanceSelector = capture.fields.balance?.selector || null;
      capture.equitySelector = capture.fields.equity?.selector || null;
      capture.buyButtonSelector = capture.fields.buyButton?.selector || null;
      capture.sellButtonSelector = capture.fields.sellButton?.selector || null;
      capture.closeButtonSelector = capture.fields.closeButton?.absolute || null;

      // User-first flow: after user completes mapping, run Claude once to enrich missing fields.
      if (window.DeepMapper && capture.rowEl) {
        this._mappingStatus('Running Claude verification on your completed mapping...');
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
          capture.closeButtonSelector = capture.fields.closeButton?.absolute || capture.closeButtonSelector;
        } catch (_err) {
          // Continue saving user mapping even if Claude verification fails.
        }
      }
      let canonical = this._buildCanonicalSelectorsForStorage(capture);
      let canonicalCheck = this._validateCanonicalForSave(canonical);
      if (!canonicalCheck.ok && window.DeepMapper && capture.rowEl) {
        this._mappingStatus(
          `Required fields missing (${canonicalCheck.missing.join(', ')}). Asking Claude with broader context...`
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
          capture.closeButtonSelector = capture.fields.closeButton?.absolute || capture.closeButtonSelector;
          canonical = this._buildCanonicalSelectorsForStorage(capture);
          canonicalCheck = this._validateCanonicalForSave(canonical);
        } catch (_err) {
          // keep existing message path below
        }
      }
      if (!canonicalCheck.ok) {
        this._mappingStatus(
          `Mapped selectors missing required fields: ${canonicalCheck.missing.join(', ')}. Please remap row.`
        );
        return;
      }
      capture.fieldBindings = canonical.fieldBindings;
      capture.fieldSelectors = canonical.fieldSelectors;
      capture.absoluteFieldSelectors = canonical.absoluteFieldSelectors;

      const saved = await this._saveGuidedProfile(capture);
      if (!saved) {
        this._mappingStatus('Failed to save profile.');
        return;
      }
      this._lastSavedOrderSelector = capture.containerSelector;
      this._identityLocked = true;
      this._requiresMapping = false;
      this._loadedSelectors = {
        ...(this._loadedSelectors || {}),
        mapping_complete: true,
        mapping_version: 1,
        positions_table: capture.containerSelector,
        ...(capture.balanceSelector ? { balance: capture.balanceSelector } : {}),
        ...(capture.equitySelector ? { equity: capture.equitySelector } : {}),
        ...(capture.buyButtonSelector ? { buy_button: capture.buyButtonSelector } : {}),
        ...(capture.sellButtonSelector ? { sell_button: capture.sellButtonSelector } : {}),
        ...(capture.closeButtonSelector ? { close_button: capture.closeButtonSelector } : {}),
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
      };
      this._mappedSelectors = this._loadedSelectors;
      if (typeof this.detector.setPreferredPositionsSelector === 'function') {
        this.detector.setPreferredPositionsSelector(capture.containerSelector);
      }
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
      showToast?.('Platform mapping saved. Using mapped selectors now.', 'info');
    };

    const onGuideClick = () => {
      if (!captureActive) return;
      if (isMinimized) {
        onReopen();
        return;
      }
      applyDockMode(!isDocked);
      this._mappingStatus(isDocked ? 'Docked panel opened.' : 'Expanded panel opened.');
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
    let container = this._resolveIdentityContainer();
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
      if (!container) return;
    }

    this._positionsContainer = container;

    const observer = this.detector.observeTrades(container, (newTrades) => {
      this.accountState.positions = newTrades.map((t) => ({
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
      this.updateSlTpReminder(newTrades);
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
    if (this._orderTracker?.isBound()) {
      const tracked = this._orderTracker.getTrades();
      if (tracked.length > 0) {
        this._trackerEmptyStreak = 0;
        return tracked;
      }
      this._trackerEmptyStreak += 1;
      if (this._isMappedCrawlMode()) {
        // Mapping-complete mode: avoid heuristic fallback to prevent drift.
        return [];
      }
      const fallback = this.detector.detectTrades(this._getTradesScanRoot());
      if (fallback.length > 0) {
        this._trackerEmptyStreak = 0;
        return fallback;
      }
      // If tracker stays empty for multiple cycles, unlock identity to allow rebinding/relearn.
      if (this._trackerEmptyStreak >= 4) {
        this._identityLocked = false;
      }
      return [];
    }
    if (this._isMappedCrawlMode()) return [];
    return this.detector.detectTrades(this._getTradesScanRoot());
  }

  _stabilizeTrades(trades) {
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
    if (!pos) return 'na';
    if (pos.rowId) return `row:${pos.rowId}`;
    const symbol = (pos.symbol || '').toUpperCase();
    const side = (pos.side || '').toUpperCase();
    const vol = pos.volume ?? '';
    const entry = pos.entryPrice ?? '';
    return [symbol, side, vol, entry].join('|');
  }

  _findClosedPositions(previousPositions, currentPositions) {
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

  _showTradeClosedPopup(trade, realizedDelta) {
    if (!trade) return;
    const fallbackPnl = Number.isFinite(Number(trade.profit)) ? Number(trade.profit) : null;
    const delta = Number.isFinite(Number(realizedDelta)) ? Number(realizedDelta) : null;
    const deltaIsMeaningful = delta != null && Math.abs(delta) >= 0.01;
    const pnlValue = deltaIsMeaningful ? delta : fallbackPnl;
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
    const mappedOnly = this._isMappedCrawlMode();
    const equity = mappedOnly
      ? this._readMappedNumber(mapped.equity)
      : (this._readMappedNumber(mapped.equity) ?? this.detector.detectEquity(document.body));
    const balance = mappedOnly
      ? this._readMappedNumber(mapped.balance)
      : (this._readMappedNumber(mapped.balance) ?? this.detector.detectBalance(document.body));

    if (!this._tradesObserver) {
      this.startTradesObservation();
    }

    this._ensureOrderTrackerBound();

    const activeTrades = this._stabilizeTrades(this.getLiveTrades());
    if (!Array.isArray(activeTrades) || activeTrades.length === 0) {
      this._lastTradesDigest = 'none';
    }

    if (!this._isMappedCrawlMode()) {
      this.captureAndPersistOrderIdentity();
      this.persistOrderProfileIfNeeded();
    }

    const startingEquity =
      this.accountState.startingEquity || (equity != null ? equity : balance) || this.accountState.startingEquity;

    const floatingLoss = this.estimateFloatingLoss(equity, balance, startingEquity);

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
    const positionsCount = Array.isArray(activeTrades) ? activeTrades.length : 0;

    if (
      this._lastPositionsCount != null &&
      this._lastEquity != null &&
      effectiveEquity != null &&
      positionsCount < this._lastPositionsCount &&
      effectiveEquity < this._lastEquity
    ) {
      if (chrome?.runtime?.id && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: 'TG_POSITION_CLOSED_LOSS' });
      }
    }
    if (this._lastPositionsCount != null && positionsCount < this._lastPositionsCount) {
      const closed = this._findClosedPositions(previousPositions, nextPositions);
      const realizedDelta =
        this._lastEquity != null && effectiveEquity != null ? effectiveEquity - this._lastEquity : null;
      this._showTradeClosedPopup(closed[0] || previousPositions[0] || null, realizedDelta);
    }
    if (
      this._lastPositionsCount != null &&
      positionsCount > this._lastPositionsCount &&
      chrome?.runtime?.id &&
      chrome.runtime.sendMessage
    ) {
      const delta = positionsCount - this._lastPositionsCount;
      chrome.runtime.sendMessage({ type: 'TG_POSITIONS_OPENED', payload: { delta } });
    }
    this._lastPositionsCount = positionsCount;
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
    const detectorButtons = !mappedOnly
      ? (this.detector.detectTradeButtons(document.body) || { buyButtons: [], sellButtons: [] })
      : { buyButtons: [], sellButtons: [] };
    const buyButtons = mappedBuyButtons.length > 0 ? mappedBuyButtons : detectorButtons.buyButtons;
    const sellButtons = mappedSellButtons.length > 0 ? mappedSellButtons : detectorButtons.sellButtons;
    const hasTradeButtons = (buyButtons?.length || 0) + (sellButtons?.length || 0) > 0;
    const hasPositions = Array.isArray(activeTrades) && activeTrades.length > 0;
    this.notifyHookedIfNeeded(equity, balance, hasPositions, hasTradeButtons);
  }

  async loadSavedOrderIdentity() {
    if (!chrome?.runtime?.id || !chrome.runtime.sendMessage || !this.detector) return;
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'TG_GET_SELECTORS', payload: { host: window.location.hostname } }, (selectors) => {
        if (chrome.runtime?.lastError || !selectors) {
          resolve();
          return;
        }
        this._loadedSelectors = selectors;
        this._mappedSelectors = selectors;
        const identity = selectors.order_details_identity;
        const containerSelector =
          identity?.selector ||
          selectors.positions_table ||
          (identity?.fieldSelectors?.container ? identity.fieldSelectors.container : null);
        if (containerSelector && typeof this.detector.setPreferredPositionsSelector === 'function') {
          this.detector.setPreferredPositionsSelector(containerSelector);
          this._lastSavedOrderSelector = containerSelector;
          this._identityLocked = true;
        }
        // Ensure/repair order_profile field bindings from identity field selectors when missing.
        if (identity?.fieldSelectors) {
          const rowFields = new Set(this._rowFieldKeys());
          const aliases = {
            pnl: 'pnl',
            profit: 'pnl',
            pl: 'pnl',
            closeButton: 'closeButton',
            close: 'closeButton',
            stopLoss: 'stopLoss',
            sl: 'stopLoss',
            takeProfit: 'takeProfit',
            tp: 'takeProfit',
            currentPrice: 'currentPrice',
            markPrice: 'currentPrice',
            entryPrice: 'entryPrice',
            openPrice: 'entryPrice',
            volume: 'volume',
            size: 'volume',
            qty: 'volume',
            side: 'side',
            symbol: 'symbol'
          };
          const currentProfile = this._loadedSelectors.order_profile || {
            version: 1,
            host: window.location.hostname,
            strictMappedMode: true,
            rowSelector: null,
            rowSelectorHint: null,
            headerAliases: {},
            headerMap: {},
            fieldBindings: {},
            negativeRowPatterns: [],
            source: 'guided_mapping',
            lastVerifiedAt: Date.now()
          };
          const mergedBindings = { ...(currentProfile.fieldBindings || {}) };
          for (const [k, v] of Object.entries(identity.fieldSelectors)) {
            const key = aliases[k] || k;
            if (!rowFields.has(key) || !v || typeof v !== 'string') continue;
            if (!mergedBindings[key]?.selector) {
              mergedBindings[key] = { selector: v, confidence: 0.95, source: 'guided_mapping' };
            }
          }
          this._loadedSelectors.order_profile = {
            ...currentProfile,
            strictMappedMode: true,
            fieldBindings: mergedBindings,
            lastVerifiedAt: Date.now()
          };
        }
        resolve();
      });
    });
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

  notifyHookedIfNeeded(equity, balance, hasPositions = false, hasTradeButtons = false) {
    if (this.hooked) return;
    const hasEquityOrBalance = equity != null || balance != null;
    if (!hasEquityOrBalance && !hasPositions && !hasTradeButtons) return;
    this.hooked = true;
    if (typeof showToast === 'function') {
      showToast('Trade GuardX: trading UI detected, applying rules.', 'info');
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
      const mappedOnly = this._isMappedCrawlMode();
      const mappedBuyButtons = this._queryMappedElements(mapped.buy_button);
      const mappedSellButtons = this._queryMappedElements(mapped.sell_button);
      const detected = !mappedOnly
        ? (this.detector.detectTradeButtons(document.body) || { buyButtons: [], sellButtons: [] })
        : { buyButtons: [], sellButtons: [] };
      let buyButtons = mappedBuyButtons.length > 0 ? mappedBuyButtons : detected.buyButtons;
      let sellButtons = mappedSellButtons.length > 0 ? mappedSellButtons : detected.sellButtons;
      buyButtons = this._innermostOnly(buyButtons);
      sellButtons = this._innermostOnly(sellButtons);

      const attach = (el, side) => {
        if (!(el instanceof HTMLElement) || el.__tgBound) return;
        el.__tgBound = true;
        if (side === 'BUY') this._buyButtonEl = el;
        if (side === 'SELL') this._sellButtonEl = el;
        el.addEventListener(
          'click',
          (e) => this.onTradeClick(e, side),
          false
        );
      };

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
      showWarningOverlay({
        title: 'Over risk reminder',
        message: `Your current position (${symbol}) risks $${risk.toFixed(2)}, which exceeds your max allowed $${maxRisk.toFixed(2)} (${riskPercent}% of balance). Consider: reducing lot size, moving SL closer to entry, or closing the position.${maxVolStr} This reminder repeats every minute until risk is within your limit.`,
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

  checkHedging(side, symbol) {
    const positions = this.accountState.positions || [];
    if (!symbol) return { allowed: true }; // Cannot verify hedging without symbol
    const norm = this.detector?.normalizeSymbol || ((s) => (s || '').replace(/\//g, '').toUpperCase());
    const symbolNorm = norm(symbol);
    const oppositeSide = side === 'BUY' ? 'SELL' : 'BUY';
    for (const pos of positions) {
      if (norm(pos.symbol) === symbolNorm && pos.side === oppositeSide) {
        return {
          allowed: false,
          reason: `Hedging not allowed. You have an open ${pos.side} on ${pos.symbol}. Close it first.`
        };
      }
    }
    return { allowed: true };
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
   * Hedging rule: when hedging is disabled in config, block opening an
   * opposite-direction trade on the same symbol while a position is open.
   */
  checkHedging(side, symbol) {
    const normSymbol = this.detector?.normalizeSymbol
      ? this.detector.normalizeSymbol(symbol || '')
      : (symbol || '').toUpperCase();
    if (!normSymbol || !side) {
      return { allowed: true };
    }
    const desiredSide = String(side).toUpperCase();
    const opposite = desiredSide === 'BUY' ? 'SELL' : desiredSide === 'SELL' ? 'BUY' : null;
    if (!opposite) return { allowed: true };
    const open = Array.isArray(this.accountState.positions) ? this.accountState.positions : [];
    const conflict = open.find((p) => {
      const pSym = this.detector?.normalizeSymbol
        ? this.detector.normalizeSymbol(p.symbol || '')
        : (p.symbol || '').toUpperCase();
      const pSide = String(p.side || '').toUpperCase();
      return pSym && pSym === normSymbol && pSide === opposite;
    });
    if (!conflict) return { allowed: true };
    return {
      allowed: false,
      reason: `Hedging is disabled. You already have a ${conflict.side} on ${symbol || normSymbol}; opening a ${desiredSide} on the same instrument is blocked by your rules.`
    };
  }

  async onTradeClick(domEvent, side) {
    if (domEvent.target && domEvent.target.__tgAllowNextClick === true) {
      domEvent.target.__tgAllowNextClick = false;
      return;
    }

    this.refreshAccountState();

    // Evaluate this click against user risk / hedging configuration before letting it reach the broker.
    const config = await this.getConfig();
    if (config && config.hedgingEnabled === true) {
      const symbol = this.getPendingSymbol(domEvent.target);
      const hedging = this.checkHedging(side, symbol);
      if (!hedging.allowed) {
        domEvent.preventDefault();
        domEvent.stopPropagation();
        const btnToBlock = side === 'BUY' ? this._buyButtonEl : this._sellButtonEl;
        this._setButtonBlocked(
          btnToBlock,
          hedging.reason ||
            `Hedging is disabled. You already have an open ${side === 'BUY' ? 'SELL' : 'BUY'} on ${symbol ||
              'this instrument'}.`
        );
        this.showBlockedReason(hedging.reason, config, { title: 'Hedging blocked' });
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
            this.showBlockedReason(
              `Lot size too large. Allowed max: ${maxVolume.toFixed(2)} lots (${riskPercent}% risk). Move SL closer or reduce lot size.`,
              config
            );
            return;
          }
        }
      }
    }

    const decision = await this.evaluateAndReact('ACTIVE');

    if (!decision || decision.decision === 'ALLOW') {
      if (typeof showToast === 'function') {
        showToast('Within daily loss limits. Trade allowed by policy – execution not guaranteed.', 'info');
      }
      return;
    }

    if (decision.decision === 'BLOCK') {
      domEvent.preventDefault();
      domEvent.stopPropagation();
      const reason =
        decision.reason ||
        'Your estimated floating loss has reached the configured daily loss limit. Close or reduce positions before opening new trades.';
      this.showBlockedReason(reason, decision.config);
      return;
    }

    if (decision.decision === 'WARN' || decision.decision === 'CLOSE_TRADES') {
      const reason =
        decision.reason ||
        'Floating loss is close to your daily loss limit. Trade GuardX recommends you stop trading.';
      this.showBlockedReason(reason, decision.config);
      return;
    }
  }

  updateSlTpReminder(activeTrades) {
    if (this._isMappingActive()) {
      if (this.slTpReminderId) {
        clearInterval(this.slTpReminderId);
        this.slTpReminderId = null;
      }
      return;
    }
    const hasOpenTrade = Array.isArray(activeTrades) && activeTrades.length > 0;
    if (!hasOpenTrade && this.slTpReminderId) {
      clearInterval(this.slTpReminderId);
      this.slTpReminderId = null;
      return;
    }
    if (!hasOpenTrade) return;
    if (this.slTpReminderId) return;
    this.slTpReminderId = setInterval(() => {
      const trades = this._stabilizeTrades(this.getLiveTrades()) || [];
      if (trades.length === 0) {
        clearInterval(this.slTpReminderId);
        this.slTpReminderId = null;
        return;
      }
      const needsSlReminder = trades.some((t) => {
        const sl = t.stopLoss;
        const slSet = sl != null && Number(sl) > 0;
        return !slSet;
      });
      if (!needsSlReminder) return;
      const primaryNoSlTrade = trades.find((t) => {
        const sl = t?.stopLoss;
        return !(sl != null && Number(sl) > 0);
      }) || trades[0];
      const lines = trades.map((t) => {
        const sl = t.stopLoss != null && Number(t.stopLoss) > 0 ? String(t.stopLoss) : '0';
        const tp = t.takeProfit != null && Number(t.takeProfit) > 0 ? String(t.takeProfit) : '0';
        return `${t.symbol || '?'} — SL: ${sl}, TP: ${tp}`;
      });
      const detail = lines.join(' · ');
      if (typeof showNoStopLossOverlay === 'function') {
        showNoStopLossOverlay({
          symbol: primaryNoSlTrade?.symbol || '?',
          stopLoss: primaryNoSlTrade?.stopLoss,
          takeProfit: primaryNoSlTrade?.takeProfit,
          message: `Current: ${detail}`,
          onSetStopLoss: () => this._focusStopLossControl(primaryNoSlTrade)
        });
        return;
      }
      if (typeof showWarningOverlay === 'function') {
        showWarningOverlay({
          title: 'Set stop loss (reminder)',
          message: `Current: ${detail}. Where SL is 0, please set a stop loss. This reminder repeats every 30s. Advisory only.`,
          highlight: false
        });
      }
    }, 30000);
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
    // based on current accountState and active positions.
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
            if (!this._isMappingActive() && mode === 'PASSIVE') {
              if (status === 'WARN' && typeof showToast === 'function') {
                showToast(
                  `Daily loss warning: floating loss ${formatCurrency(metrics?.floatingLoss)} vs limit ${formatCurrency(metrics?.dailyLossLimitAmount)}`,
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
      showWarningOverlay({
        title: 'CLOSE YOUR TRADE NOW – RISK LIMIT NEAR',
        message: `Trade GuardX could not locate a close button. Floating loss: ${formatCurrency(metrics?.floatingLoss)}, limit: ${formatCurrency(metrics?.dailyLossLimitAmount)}. Please close positions manually if appropriate.`,
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
