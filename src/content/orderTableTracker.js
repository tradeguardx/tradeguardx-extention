/* global MutationObserver */

const PROFILE_VERSION = 1;
const FIELD_KEYS = [
  'symbol',
  'side',
  'size',
  'volume',
  'entryPrice',
  'currentPrice',
  'stopLoss',
  'takeProfit',
  'pnl',
  'closeButton'
];
const NEGATIVE_ROW_PATTERNS = [
  /\b(summary|totals?|subtotal|overview|balance)\b/i,
  /\b(commission|swap|fee|fees)\b/i,
  /\b(settings?|preferences?)\b/i,
  /\b(modify|edit|add|add tp|add sl)\b/i,
  /\b(tpsl|sltp)\b/i
];

class OrderTableTracker {
  constructor(detector, options = {}) {
    this.detector = detector;
    this.host = options.host || window.location.hostname;
    this.root = null;
    this.rowsRoot = null;
    this.observer = null;
    this.profiles = new Map();
    this.lastSnapshot = [];
    this._debounceTimer = null;
    this._headerMap = null;
    this._profileSeed = null;
    this._rowSelectorHint = null;
    this._rowSelector = null;
    this._strictMappedMode = false;
    this._negativePatterns = [...NEGATIVE_ROW_PATTERNS];
    this._lastDiscoveryStats = null;
  }

  importProfile(profile) {
    if (!profile || profile.version !== PROFILE_VERSION) return;
    const cleanedBindings = {};
    const rawBindings = profile.fieldBindings || {};
    FIELD_KEYS.forEach((key) => {
      const b = rawBindings[key];
      if (!b || typeof b.selector !== 'string' || !b.selector.trim()) return;
      cleanedBindings[key] = {
        selector: b.selector.trim(),
        confidence: Number.isFinite(Number(b.confidence)) ? Number(b.confidence) : 0.8,
        source: b.source || profile.source || 'profile_seed'
      };
    });
    this._profileSeed = {
      ...profile,
      fieldBindings: cleanedBindings
    };
    const hasSeedBindings = Object.keys(cleanedBindings).length > 0;
    this._strictMappedMode =
      profile.strictMappedMode === true ||
      profile.source === 'guided_mapping' ||
      hasSeedBindings;
    if (Array.isArray(profile.negativeRowPatterns)) {
      this._negativePatterns = [
        ...NEGATIVE_ROW_PATTERNS,
        ...profile.negativeRowPatterns
          .map((p) => {
            try {
              return new RegExp(p, 'i');
            } catch (_err) {
              return null;
            }
          })
          .filter(Boolean)
      ];
    }
    this._rowSelectorHint = profile.rowSelectorHint || null;
    this._rowSelector = profile.rowSelector || null;
  }

  exportProfile() {
    const bestBindings = {};
    const bestByField = {};
    for (const profile of this.profiles.values()) {
      for (const key of FIELD_KEYS) {
        const b = profile.bindings?.[key];
        if (!b || !b.selector || b.confidence <= 0) continue;
        if (!bestByField[key] || b.confidence > bestByField[key].confidence) {
          bestByField[key] = { ...b };
        }
      }
    }
    Object.entries(bestByField).forEach(([k, b]) => {
      bestBindings[k] = {
        selector: b.selector,
        confidence: b.confidence,
        source: b.source
      };
    });

    return {
      version: PROFILE_VERSION,
      host: this.host,
      strictMappedMode: this._strictMappedMode === true,
      rowSelector: this._rowSelector || null,
      rowSelectorHint: this._rowSelectorHint || (this.rowsRoot?.tagName === 'TBODY' ? 'tr' : null),
      headerAliases: this._headerMap?.aliases || {},
      headerMap: this._headerMap?.map || {},
      fieldBindings: bestBindings,
      negativeRowPatterns: this._negativePatterns.map((r) => r.source),
      lastVerifiedAt: Date.now()
    };
  }

  bind(rootEl) {
    if (!(rootEl instanceof HTMLElement)) return false;
    if (this.root === rootEl) return true;
    this.disconnect();
    this.root = rootEl;
    this.rowsRoot = rootEl.querySelector('tbody') || rootEl;
    this._rowSelectorHint = this._profileSeed?.rowSelectorHint || (this.rowsRoot?.tagName === 'TBODY' ? 'tr' : null);
    this._rowSelector = this._profileSeed?.rowSelector || this._rowSelector || null;
    this._headerMap = this._learnHeaderMap(rootEl);
    this._refreshNow();
    this._startObserver();
    return true;
  }

  disconnect() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    this.root = null;
    this.rowsRoot = null;
    this.profiles.clear();
    this.lastSnapshot = [];
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
  }

  isBound() {
    return !!(this.root && this.rowsRoot);
  }

  getTrades() {
    if (!this.isBound()) return [];
    this._refreshNow();
    return this.lastSnapshot;
  }

  _startObserver() {
    if (!this.rowsRoot) return;
    this.observer = new MutationObserver(() => {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(() => this._refreshNow(), 120);
    });
    this.observer.observe(this.rowsRoot, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  _refreshNow() {
    if (!this.rowsRoot) return;
    const rows = this._discoverRows(this.rowsRoot);
    const seen = new Set();
    const rowById = new Map();

    rows.forEach((row, idx) => {
      const rowId = this._getRowId(row, idx);
      seen.add(rowId);
      rowById.set(rowId, row);
      const existing = this.profiles.get(rowId);
      if (!existing) {
        this.profiles.set(rowId, this._createProfile(row, rowId));
      } else {
        existing.missingCount = 0;
        existing.rowSelector = this._selector(row) || existing.rowSelector;
        this._refreshProfileBindings(existing, row);
      }
    });

    for (const [rowId, profile] of this.profiles.entries()) {
      if (!seen.has(rowId)) {
        profile.missingCount = (profile.missingCount || 0) + 1;
        if (profile.missingCount >= 3) this.profiles.delete(rowId);
      }
    }

    const snapshot = [];
    for (const profile of this.profiles.values()) {
      const rowEl = rowById.get(profile.rowId) || this._resolveRow(profile);
      if (!rowEl) continue;
      const trade = this._readTradeFromRow(profile, rowEl);
      if (!trade) continue;
      snapshot.push(trade);
    }
    this.lastSnapshot = snapshot;
  }

  _learnHeaderMap(root) {
    const table = root.tagName === 'TABLE' ? root : root.querySelector('table');
    if (!table) return null;
    const headerRow = table.querySelector('thead tr') || table.querySelector('tr');
    if (!headerRow) return null;
    const cells = Array.from(headerRow.querySelectorAll('th, td'));
    if (cells.length === 0) return null;

    const map = {};
    const aliases = {};
    cells.forEach((cell, idx) => {
      const label = (cell.innerText || '').trim().toLowerCase();
      if (!label) return;
      aliases[idx] = label;
      const field = this._fieldFromHeader(label);
      if (field && map[field] == null) map[field] = idx;
    });
    return { map, aliases };
  }

  _fieldFromHeader(label) {
    const l = (label || '').toLowerCase();
    if (/(symbol|instrument|pair)/.test(l)) return 'symbol';
    if (/(side|type|direction)/.test(l)) return 'side';
    if (/(volume|size|qty|quantity|lot)/.test(l)) return 'volume';
    if (/(entry|open)/.test(l)) return 'entryPrice';
    if (/(current|mark|market|last)/.test(l)) return 'currentPrice';
    if (/(take|tp)/.test(l)) return 'takeProfit';
    if (/(stop|sl)/.test(l)) return 'stopLoss';
    if (/(p&l|p\/l|pnl|profit|unrealized)/.test(l)) return 'pnl';
    return null;
  }

  _discoverRows(root) {
    if (!root) return [];
    if (this._strictMappedMode) {
      const strictSelector = this._rowSelector || this._rowSelectorHint;
      const normalizeRows = (nodes) =>
        Array.from(nodes || []).filter((row) => row instanceof HTMLElement && row.isConnected);
      if (strictSelector) {
        try {
          const strictRows = normalizeRows(root.querySelectorAll(strictSelector));
          if (strictRows.length > 0) return strictRows;
        } catch (_err) {
          // continue to mapped-only fallback below
        }
      }

      // Mapped-only fallback: discover rows inside mapped container and keep only rows
      // where mapped field selectors resolve. No full-page heuristics.
      const mappedSelectors = Object.values(this._profileSeed?.fieldBindings || {})
        .map((b) => b?.selector)
        .filter((s) => typeof s === 'string' && s.trim());
      if (mappedSelectors.length === 0) return [];
      const candidates = normalizeRows(
        root.querySelectorAll('tr, [role="row"], [data-row], [data-position-id], [data-order-id], div, li')
      );
      return candidates.filter((row) => {
        try {
          const hitCount = mappedSelectors.reduce((n, sel) => {
            try {
              return n + (row.querySelector(sel) ? 1 : 0);
            } catch (_e) {
              return n;
            }
          }, 0);
          // Require at least two mapped fields to match in this row.
          return hitCount >= 2;
        } catch (_err) {
          return false;
        }
      });
    }
    const selector = this._rowSelectorHint || 'tr[data-index], tr[data-row-expanded], tbody tr, tr, [role="row"], div[class*="row"], li';
    const rows = root.querySelectorAll(selector);
    const stats = {
      total: rows.length,
      accepted: 0,
      rejected: {
        disconnected: 0,
        emptyOrLong: 0,
        headerLike: 0,
        negativePattern: 0,
        noNumber: 0,
        weakSignal: 0
      }
    };
    const filtered = Array.from(rows).filter((row) => {
      if (!(row instanceof HTMLElement) || !row.isConnected) {
        stats.rejected.disconnected += 1;
        return false;
      }
      const text = (row.innerText || '').trim();
      const low = text.toLowerCase();
      const isTableRow = row.tagName === 'TR' || !!row.closest('table, [role="table"]');
      const hasFormControls = !!row.querySelector('input, select, textarea');
      const orderPanelSignals =
        /\b(limit|market|maker|taker|quantity|available margin|funds|reduce only|bracket order|order value|best bid|best ask|payoff)\b/i.test(
          low
        );
      if (!text || text.length > 2000) {
        stats.rejected.emptyOrLong += 1;
        return false;
      }
      if (/^(symbol|instrument|type|side|volume|entry|open|current|tp|sl|p\/l|pnl)$/i.test(text)) {
        stats.rejected.headerLike += 1;
        return false;
      }
      if (this._negativePatterns.some((p) => p.test(low))) {
        const hasSymbol = this.detector?.getBestSymbolFromText
          ? !!this.detector.getBestSymbolFromText(text)
          : false;
        if (!hasSymbol) {
          stats.rejected.negativePattern += 1;
          return false;
        }
      }
      if (!/\d/.test(text)) {
        stats.rejected.noNumber += 1;
        return false;
      }
      const hasSymbol = this.detector?.getBestSymbolFromText
        ? !!this.detector.getBestSymbolFromText(text)
        : false;
      const hasTradeTerms = /\b(tp|sl|entry|open|current|p&l|p\/l|pnl|profit|buy|sell|long|short)\b/i.test(text);
      if (!isTableRow && (hasFormControls || orderPanelSignals)) {
        stats.rejected.negativePattern += 1;
        return false;
      }
      if (!hasSymbol && !hasTradeTerms) {
        stats.rejected.weakSignal += 1;
        return false;
      }
      stats.accepted += 1;
      return true;
    });
    this._lastDiscoveryStats = stats;
    return filtered;
  }

  _emptyBinding() {
    return {
      selector: null,
      confidence: 0,
      source: null,
      failCount: 0,
      lastSuccessAt: 0
    };
  }

  _createProfile(row, rowId) {
    const bindings = {};
    FIELD_KEYS.forEach((k) => {
      bindings[k] = this._emptyBinding();
      const seed = this._profileSeed?.fieldBindings?.[k];
      if (seed?.selector) {
        const seedSource = seed.source || 'profile_seed';
        const seedConfidence = Number(seed.confidence || 0.6);
        const cappedSeedConfidence =
          seedSource === 'guided_mapping'
            ? Math.min(0.995, Math.max(0.9, seedConfidence))
            : Math.min(0.85, seedConfidence);
        bindings[k] = {
          ...bindings[k],
          selector: seed.selector,
          confidence: cappedSeedConfidence,
          source: seedSource
        };
      }
    });

    const profile = {
      rowId,
      rowSelector: this._selector(row),
      bindings,
      missingCount: 0
    };
    if (!this._strictMappedMode) this._refreshProfileBindings(profile, row);
    return profile;
  }

  _refreshProfileBindings(profile, row) {
    if (this._strictMappedMode) return;
    if (!this.detector || !row) return;
    const tableRow = row.tagName === 'TR' ? row : row.querySelector('tr');
    if (tableRow && this._headerMap?.map) {
      Object.entries(this._headerMap.map).forEach(([field, idx]) => {
        const cell = tableRow.querySelector(`td:nth-of-type(${idx + 1})`);
        if (!cell) return;
        const leaf = this._pickExactLeafInCell(cell, field);
        this._setBinding(profile, field, this._selector(leaf || cell, row), 0.95, 'header_map');
      });
    }

    const fieldEls = this.detector.detectTradeFieldElements
      ? this.detector.detectTradeFieldElements(row)
      : null;
    const symbolEl = row.querySelector('[data-testid*="symbol"],[class*="symbol"],td:first-child,span');
    const sideEl = row.querySelector('[data-testid*="side"],[class*="side"],[class*="direction"]');
    const volumeEl = row.querySelector('[data-testid*="size"],[data-testid*="volume"],[class*="size"],[class*="volume"]');
    const currentEl = row.querySelector(
      [
        '[data-testid*="mark"][data-testid*="price"]',
        '[data-testid*="current"][data-testid*="price"]',
        '[data-testid*="market"][data-testid*="price"]',
        '[data-test*="mark"][data-test*="price"]',
        '[data-test*="current"][data-test*="price"]',
        '[data-test*="market"][data-test*="price"]',
        '[id*="mark"][id*="price"]',
        '[id*="current"][id*="price"]',
        '[id*="market"][id*="price"]',
        '[class*="mark"][class*="price"]',
        '[class*="current"][class*="price"]',
        '[class*="market"][class*="price"]',
        '[aria-label*="mark"][aria-label*="price"]',
        '[aria-label*="current"][aria-label*="price"]',
        '[title*="mark"][title*="price"]',
        '[title*="current"][title*="price"]'
      ].join(',')
    );
    const closeEl = row.querySelector(
      'button[class*="close"],button[aria-label*="lose"],button[title*="lose"],[role="button"][aria-label*="lose"],[role="button"][title*="lose"],button[class*="exit"],[role="button"][class*="exit"]'
    );

    this._setBinding(profile, 'symbol', this._selector(symbolEl, row), 0.72, 'heuristic');
    this._setBinding(profile, 'side', this._selector(sideEl, row), 0.7, 'heuristic');
    this._setBinding(profile, 'volume', this._selector(volumeEl, row), 0.68, 'heuristic');
    this._setBinding(profile, 'stopLoss', this._selector(fieldEls?.stopLoss, row), 0.72, 'heuristic');
    this._setBinding(profile, 'takeProfit', this._selector(fieldEls?.takeProfit, row), 0.72, 'heuristic');
    this._setBinding(profile, 'entryPrice', this._selector(fieldEls?.entryPrice, row), 0.74, 'heuristic');
    this._setBinding(profile, 'currentPrice', this._selector(currentEl, row), 0.9, 'attr_hint');
    this._setBinding(profile, 'currentPrice', this._selector(fieldEls?.currentPrice, row), 0.74, 'heuristic');
    this._setBinding(profile, 'pnl', this._selector(fieldEls?.profit, row), 0.74, 'heuristic');
    this._setBinding(profile, 'closeButton', this._selector(closeEl, row), 0.8, 'heuristic');
  }

  _fieldKeywords(field) {
    switch (field) {
      case 'symbol':
        return ['symbol', 'instrument', 'pair'];
      case 'side':
        return ['side', 'type', 'direction', 'buy', 'sell', 'long', 'short'];
      case 'volume':
        return ['volume', 'size', 'qty', 'quantity', 'lot'];
      case 'entryPrice':
        return ['entry', 'open', 'entryprice', 'openprice'];
      case 'currentPrice':
        return ['current', 'mark', 'market', 'last', 'bid', 'ask', 'currentprice', 'markprice'];
      case 'takeProfit':
        return ['tp', 'take', 'takeprofit', 'take profit'];
      case 'stopLoss':
        return ['sl', 'stop', 'stoploss', 'stop loss'];
      case 'pnl':
        return ['pnl', 'p&l', 'p/l', 'profit', 'unrealized', 'floating'];
      default:
        return [];
    }
  }

  _fieldNegativeKeywords(field) {
    if (field === 'takeProfit') return ['sl', 'stop', 'current', 'mark', 'entry', 'open'];
    if (field === 'stopLoss') return ['tp', 'take', 'current', 'mark', 'entry', 'open'];
    if (field === 'currentPrice') return ['tp', 'take', 'sl', 'stop'];
    if (field === 'entryPrice') return ['tp', 'take', 'sl', 'stop', 'current', 'mark'];
    return [];
  }

  _fieldPositiveRegex(field) {
    switch (field) {
      case 'takeProfit':
        return /\b(tp|take\s*profit|takeprofit|target)\b/i;
      case 'stopLoss':
        return /\b(sl|stop\s*loss|stoploss)\b/i;
      case 'currentPrice':
        return /\b(current|currentprice|mark|markprice|market|last|bid|ask)\b/i;
      case 'entryPrice':
        return /\b(entry|entryprice|open|openprice)\b/i;
      default:
        return null;
    }
  }

  _fieldNegativeRegex(field) {
    switch (field) {
      case 'takeProfit':
        return /\b(current|currentprice|mark|markprice|market|entry|entryprice|open|openprice|sl|stoploss|stop\s*loss)\b/i;
      case 'stopLoss':
        return /\b(current|currentprice|mark|markprice|market|entry|entryprice|open|openprice|tp|takeprofit|take\s*profit)\b/i;
      case 'currentPrice':
        return /\b(tp|takeprofit|take\s*profit|sl|stoploss|stop\s*loss)\b/i;
      case 'entryPrice':
        return /\b(tp|takeprofit|take\s*profit|sl|stoploss|stop\s*loss|current|currentprice|mark|markprice|market)\b/i;
      default:
        return null;
    }
  }

  _pickExactLeafInCell(cell, field) {
    if (!cell) return null;
    const candidates = this._collectCellCandidates(cell);
    const wanted = this._fieldKeywords(field);
    const avoid = this._fieldNegativeKeywords(field);
    let best = null;
    let bestScore = -9999;

    for (const el of candidates) {
      if (!(el instanceof HTMLElement) || !el.isConnected) continue;
      if (el.childElementCount > 8) continue;
      const text = (el.innerText || '').trim();
      const hasNumber = this._num(text) != null;
      const ctx = (
        (el.id || '') +
        ' ' +
        (el.className || '') +
        ' ' +
        (el.getAttribute('data-testid') || '') +
        ' ' +
        (el.getAttribute('data-index') || '') +
        ' ' +
        (el.getAttribute('aria-label') || '') +
        ' ' +
        (el.getAttribute('title') || '') +
        ' ' +
        (el.previousElementSibling?.textContent || '') +
        ' ' +
        (el.parentElement?.textContent || '')
      ).toLowerCase();
      const dataTest = (el.getAttribute('data-test') || el.getAttribute('data-testid') || '').toLowerCase();
      const cls = (el.className || '').toLowerCase();

      let score = 0;
      if (el === cell) score -= 2;
      if (el.childElementCount === 0) score += 2;
      if (hasNumber) score += 2;
      if (text.length > 0 && text.length < 30) score += 1;
      if (el.id) score += 2;
      if (el.getAttribute('data-testid')) score += 2;
      if (el.getAttribute('data-test')) score += 3;

      const hasWanted = wanted.some((k) => ctx.includes(k));
      const hasAvoid = avoid.some((k) => ctx.includes(k));
      if (hasWanted) score += 5;
      if (hasAvoid) score -= 6;

      const positiveRe = this._fieldPositiveRegex(field);
      const negativeRe = this._fieldNegativeRegex(field);
      if (positiveRe && (positiveRe.test(ctx) || positiveRe.test(dataTest))) score += 6;
      if (negativeRe && (negativeRe.test(ctx) || negativeRe.test(dataTest))) score -= 10;

      // Strong prefer exact attribute/class semantic hits on the leaf element itself.
      if (positiveRe && (positiveRe.test(dataTest) || positiveRe.test(cls))) score += 12;
      if (negativeRe && (negativeRe.test(dataTest) || negativeRe.test(cls))) score -= 18;

      // TP/SL can be unset; still prefer labeled leaf over unlabeled numeric.
      if ((field === 'takeProfit' || field === 'stopLoss') && /not set|add/i.test(text) && hasWanted) {
        score += 3;
      }

      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }

    return best;
  }

  _collectCellCandidates(cell) {
    // Generic candidate collection: no broker/tag hardcoding.
    // We inspect all descendants and then score only useful leaves.
    const all = Array.from(cell.querySelectorAll('*'));
    const limited = all.length > 400 ? all.slice(0, 400) : all;
    return [cell, ...limited].filter((el) => {
      if (!(el instanceof HTMLElement) || !el.isConnected) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      return true;
    });
  }

  _setBinding(profile, field, selector, confidence, source) {
    if (!profile?.bindings?.[field] || !selector) return;
    const current = profile.bindings[field];
    if (!current.selector || confidence >= current.confidence) {
      profile.bindings[field] = {
        ...current,
        selector,
        confidence,
        source: source || current.source,
        failCount: 0
      };
    }
  }

  _selector(el, scope) {
    if (!el || !this.detector?.getExactElementSelector) return null;
    return this.detector.getExactElementSelector(el, scope || this.rowsRoot);
  }

  _resolveRow(profile) {
    if (!this.rowsRoot || !profile) return null;
    if (!profile.rowSelector) return null;
    try {
      return this.rowsRoot.querySelector(profile.rowSelector);
    } catch (_err) {
      return null;
    }
  }

  _hash(text) {
    let h = 0;
    for (let i = 0; i < text.length; i += 1) {
      h = ((h << 5) - h + text.charCodeAt(i)) | 0;
    }
    return Math.abs(h).toString(36);
  }

  _getRowId(row, index) {
    const attrs = [
      row.getAttribute('data-position-id'),
      row.getAttribute('data-order-id'),
      row.getAttribute('data-id'),
      row.getAttribute('data-key'),
      row.getAttribute('id')
    ].filter(Boolean);
    if (attrs.length > 0) return `rid:${attrs[0]}`;

    const text = (row.innerText || '').replace(/\s+/g, ' ').trim();
    const symbol = this.detector?.getBestSymbolFromText ? this.detector.getBestSymbolFromText(text) : null;
    const side = this._sideFromText(text) || this._sideFromAttrs(row) || 'UNK';
    const volume = this._volumeFromText(text) ?? 'na';
    if (symbol) return `sym:${symbol}:${side}:${volume}`;

    const structural = `${row.tagName}:${row.childElementCount}:${row.className || ''}:${text.slice(0, 40)}`;
    return `idx:${index}:${this._hash(structural)}`;
  }

  _readText(row, selector) {
    if (!selector) return null;
    try {
      const el = row.querySelector(selector);
      if (!el) return null;
      return (el.innerText || el.textContent || '').trim();
    } catch (_err) {
      return null;
    }
  }

  _num(text) {
    if (!text) return null;
    const raw = String(text).trim();
    if (!raw) return null;
    const normalized = raw
      .replace(/\u2212/g, '-') // Unicode minus
      .replace(/[\u00a0\s]+/g, ' ') // normalize spaces
      .replace(/,/g, '');
    const isParenNegative = /^\s*\(.*\)\s*$/.test(normalized);
    const match = normalized.match(/[+-]?\d*\.?\d+(?:[eE][+-]?\d+)?/);
    if (!match) return null;
    let n = parseFloat(match[0]);
    if (isParenNegative && !/^[+-]/.test(match[0])) n = -Math.abs(n);
    return Number.isFinite(n) ? n : null;
  }

  _sideFromText(text) {
    const low = (text || '').toLowerCase();
    if (/\b(buy|long)\b/.test(low)) return 'BUY';
    if (/\b(sell|short)\b/.test(low)) return 'SELL';
    return null;
  }

  _sideFromAttrs(row) {
    if (!row) return null;
    const combined = (
      (row.className || '') +
      ' ' +
      (row.getAttribute('data-side') || '') +
      ' ' +
      (row.getAttribute('data-direction') || '') +
      ' ' +
      row.innerHTML
    ).toLowerCase();
    if (/long|buy/.test(combined)) return 'BUY';
    if (/short|sell/.test(combined)) return 'SELL';
    return null;
  }

  _volumeFromText(text) {
    const nums = (text || '').match(/\d+(?:\.\d+)?/g);
    if (!nums) return null;
    const vals = nums.map(Number).filter((v) => Number.isFinite(v) && v > 0 && v < 100000);
    return vals.find((v) => v < 5) ?? vals[0] ?? null;
  }

  _isUnsetFieldText(text) {
    return /^(add|not set|none|n\/a|na|--|—|-|)$/i.test((text || '').trim());
  }

  _selectorContextText(row, selector) {
    if (!row || !selector) return '';
    try {
      const el = row.querySelector(selector);
      if (!el) return '';
      const parent = el.parentElement;
      const td = el.closest ? el.closest('td') : null;
      return (
        (el.getAttribute('data-testid') || '') +
        ' ' +
        (el.getAttribute('data-test') || '') +
        ' ' +
        (el.getAttribute('data-index') || '') +
        ' ' +
        (el.getAttribute('aria-label') || '') +
        ' ' +
        (el.getAttribute('title') || '') +
        ' ' +
        (el.className || '') +
        ' ' +
        (parent?.getAttribute?.('data-testid') || '') +
        ' ' +
        (parent?.getAttribute?.('data-test') || '') +
        ' ' +
        (parent?.className || '') +
        ' ' +
        (td?.getAttribute?.('data-testid') || '') +
        ' ' +
        (td?.getAttribute?.('data-test') || '') +
        ' ' +
        (td?.getAttribute?.('data-index') || '') +
        ' ' +
        (el.previousElementSibling?.textContent || '') +
        ' ' +
        (parent?.previousElementSibling?.textContent || '')
      ).toLowerCase();
    } catch (_err) {
      return '';
    }
  }

  _selectorDirectMeta(row, selector) {
    if (!row || !selector) return '';
    try {
      const el = row.querySelector(selector);
      if (!el) return '';
      return (
        (el.getAttribute('data-test') || '') +
        ' ' +
        (el.getAttribute('data-testid') || '') +
        ' ' +
        (el.getAttribute('data-index') || '') +
        ' ' +
        (el.getAttribute('aria-label') || '') +
        ' ' +
        (el.getAttribute('title') || '') +
        ' ' +
        (el.className || '') +
        ' ' +
        (el.id || '')
      ).toLowerCase();
    } catch (_err) {
      return '';
    }
  }

  _validateFieldValue(field, text, rowText, row, binding) {
    const hasSelector = typeof binding?.selector === 'string' && !!binding.selector.trim();

    // Selector-first mode: once a field is mapped/bound, prefer that value with minimal checks.
    if (hasSelector) {
      if (field === 'closeButton') return true;
      if (field === 'symbol') return !!(text || '').trim();
      if (field === 'side') return true;
      if (field === 'stopLoss' || field === 'takeProfit') {
        const trimmed = (text || '').trim();
        if (!trimmed || this._isUnsetFieldText(trimmed)) return true;
        return this._num(trimmed) != null;
      }
      if (field === 'volume' || field === 'pnl' || field === 'entryPrice' || field === 'currentPrice') {
        return this._num(text) != null;
      }
      return true;
    }

    // Legacy fallback path (non-mapped fields only).
    if (field === 'closeButton') return true;
    if (field === 'symbol') {
      return !!(this.detector?.getBestSymbolFromText
        ? this.detector.getBestSymbolFromText(text || rowText)
        : null);
    }
    if (field === 'side') {
      return /\b(buy|sell|long|short)\b/i.test((text || rowText || '').toLowerCase());
    }
    if (field === 'volume') {
      if (this._num(text) == null) return false;
      const ctx = this._selectorContextText(row, binding?.selector);
      const direct = this._selectorDirectMeta(row, binding?.selector);
      const combined = `${direct} ${ctx}`;
      if (!combined.trim()) return false;
      if (/\b(pnl|p\/l|p&l|profit|tp|take|sl|stop)\b/i.test(direct)) return false;
      if (/\b(volume|size|qty|quantity|lot|lots)\b/i.test(combined)) return true;
      return binding?.source === 'header_map';
    }
    if (field === 'pnl') {
      if (this._num(text) == null) return false;
      const ctx = this._selectorContextText(row, binding?.selector);
      const direct = this._selectorDirectMeta(row, binding?.selector);
      const combined = `${direct} ${ctx}`;
      const positive = /\b(pnl|p\/l|p&l|pl|profit|unrealized|upnl|floating)\b/i;
      const negative = /\b(tp|take|sl|stop|entry|open|current|mark|volume|size|qty)\b/i;
      if (negative.test(direct) && !positive.test(direct)) return false;
      if (!combined.trim()) return false;
      return positive.test(combined) || /^[+-]/.test((text || '').trim());
    }
    if (field === 'stopLoss' || field === 'takeProfit') {
      const trimmed = (text || '').trim();
      if (!trimmed || this._isUnsetFieldText(trimmed)) return true;
      if (this._num(trimmed) == null) return false;
      const ctx = this._selectorContextText(row, binding?.selector);
      const direct = this._selectorDirectMeta(row, binding?.selector);
      const positiveRe = this._fieldPositiveRegex(field);
      const negativeRe = this._fieldNegativeRegex(field);
      if (!ctx && !direct) return false;
      if (negativeRe && (negativeRe.test(direct) || negativeRe.test(ctx))) return false;
      if (positiveRe && !positiveRe.test(direct)) return false;
      if (positiveRe && (positiveRe.test(direct) || positiveRe.test(ctx))) return true;
      if (field === 'takeProfit') {
        const tpLike = /\b(tp|take\s*profit|takeprofit)\b/i.test(ctx);
        const wrongLike = /\b(sl|stop\s*loss|stoploss|current|mark|market|entry|open)\b/i.test(ctx);
        return tpLike && !wrongLike;
      }
      const slLike = /\b(sl|stop\s*loss|stoploss)\b/i.test(ctx);
      const wrongLike = /\b(tp|take\s*profit|takeprofit|current|mark|market|entry|open)\b/i.test(ctx);
      return slLike && !wrongLike;
    }
    if (field === 'currentPrice' || field === 'entryPrice') {
      if (this._num(text) == null) return false;
      const ctx = this._selectorContextText(row, binding?.selector);
      const direct = this._selectorDirectMeta(row, binding?.selector);
      const combined = `${direct} ${ctx}`;
      if (!ctx && !direct) return binding?.source === 'header_map';
      const positiveRe = this._fieldPositiveRegex(field);
      const negativeRe = this._fieldNegativeRegex(field);
      if (negativeRe && negativeRe.test(direct)) return false;
      if (positiveRe && positiveRe.test(combined)) return true;
      return binding?.source === 'header_map';
    }
    return true;
  }

  _readFieldWithConfidence(profile, row, field, rowText) {
    const binding = profile.bindings[field];
    if (!binding) return null;
    const text = this._readText(row, binding.selector);

    // In strict mapped mode, do not degrade/relearn mapped selectors.
    if (this._strictMappedMode && binding.selector) {
      return this._validateFieldValue(field, text, rowText, row, binding) ? text : null;
    }

    const ok = this._validateFieldValue(field, text, rowText, row, binding);
    if (ok) {
      binding.failCount = 0;
      binding.lastSuccessAt = Date.now();
      binding.confidence = Math.min(1, (binding.confidence || 0) + 0.02);
      return text;
    }
    binding.failCount = (binding.failCount || 0) + 1;
    binding.confidence = Math.max(0, (binding.confidence || 0) - 0.15);
    if (binding.confidence < 0.35 || binding.failCount >= 2) {
      this._relearnWeakField(profile, row, field);
      const retry = this._readText(row, profile.bindings[field]?.selector);
      return this._validateFieldValue(field, retry, rowText, row, profile.bindings[field]) ? retry : null;
    }
    return null;
  }

  _relearnWeakField(profile, row, field) {
    if (!profile || !row) return;
    if (field === 'closeButton') return;
    if (this._strictMappedMode) return;
    if (profile.bindings?.[field]?.source === 'guided_mapping') return;
    const tmp = { ...profile, bindings: { ...profile.bindings, [field]: this._emptyBinding() } };
    this._refreshProfileBindings(tmp, row);
    const updated = tmp.bindings[field];
    if (updated?.selector) {
      profile.bindings[field] = {
        ...updated,
        confidence: Math.max(updated.confidence, 0.55),
        source: updated.source || 'relearned'
      };
    }
  }

  _readTradeFromRow(profile, row) {
    const rowText = (row.innerText || '').replace(/\s+/g, ' ').trim();
    const symbolText = this._readFieldWithConfidence(profile, row, 'symbol', rowText) || '';
    const symbolFromBinding = this.detector?.getBestSymbolFromText
      ? this.detector.getBestSymbolFromText(symbolText)
      : null;
    const symbolFromRow = this.detector?.getBestSymbolFromText
      ? this.detector.getBestSymbolFromText(rowText)
      : null;
    const symbol = this._strictMappedMode
      ? symbolFromBinding
      : (symbolFromRow || symbolFromBinding);
    const sideText = this._readFieldWithConfidence(profile, row, 'side', rowText) || rowText;
    const side = this._sideFromText(sideText) || this._sideFromAttrs(row) || 'UNKNOWN';
    if (!symbol) return null;

    const stopLossText = this._readFieldWithConfidence(profile, row, 'stopLoss', rowText);
    const takeProfitText = this._readFieldWithConfidence(profile, row, 'takeProfit', rowText);
    const entryPriceText = this._readFieldWithConfidence(profile, row, 'entryPrice', rowText);
    const currentPriceText = this._readFieldWithConfidence(profile, row, 'currentPrice', rowText);
    const stopLoss = this._num(stopLossText);
    let takeProfit = this._num(takeProfitText);
    const entryPrice = this._num(entryPriceText);
    const currentPrice = this._num(currentPriceText);
    const profit = this._num(this._readFieldWithConfidence(profile, row, 'pnl', rowText));
    const volumeText = this._readFieldWithConfidence(profile, row, 'volume', rowText);
    const volume = this._num(volumeText);

    // Guard against TP drifting to current-price element.
    const tpSelector = profile.bindings.takeProfit?.selector || '';
    const currentSelector = profile.bindings.currentPrice?.selector || '';
    const tpCtx = this._selectorContextText(row, tpSelector);
    const currentCtx = this._selectorContextText(row, currentSelector);
    const tpUnset = this._isUnsetFieldText(takeProfitText || '');
    const tpLooksLikeCurrent =
      tpSelector &&
      currentSelector &&
      tpSelector === currentSelector;
    const tpNumericEqualsCurrent =
      takeProfit != null &&
      currentPrice != null &&
      Math.abs(takeProfit - currentPrice) < 1e-9;
    const tpCtxMissingTpSignals = !/\b(tp|take\s*profit|takeprofit|target)\b/i.test(tpCtx || '');
    const currentCtxHasCurrentSignals = /\b(current|currentprice|mark|markprice|market|last|bid|ask)\b/i.test(
      currentCtx || ''
    );
    if (
      !tpUnset &&
      (tpLooksLikeCurrent || (tpNumericEqualsCurrent && tpCtxMissingTpSignals && currentCtxHasCurrentSignals))
    ) {
      takeProfit = null;
      if (!this._strictMappedMode) this._relearnWeakField(profile, row, 'takeProfit');
    }

    return {
      rowId: profile.rowId,
      symbol,
      side,
      volume,
      stopLoss,
      takeProfit,
      entryPrice,
      currentPrice,
      profit,
      bindingConfidence: {
        symbol: profile.bindings.symbol?.confidence ?? 0,
        stopLoss: profile.bindings.stopLoss?.confidence ?? 0,
        takeProfit: profile.bindings.takeProfit?.confidence ?? 0,
        entryPrice: profile.bindings.entryPrice?.confidence ?? 0,
        currentPrice: profile.bindings.currentPrice?.confidence ?? 0,
        pnl: profile.bindings.pnl?.confidence ?? 0
      },
      fieldIdentity: {
        scoped: {
          stopLoss: profile.bindings.stopLoss?.selector || null,
          takeProfit: profile.bindings.takeProfit?.selector || null,
          entryPrice: profile.bindings.entryPrice?.selector || null,
          currentPrice: profile.bindings.currentPrice?.selector || null,
          pnl: profile.bindings.pnl?.selector || null
        }
      },
      closeSelector: profile.bindings.closeButton?.selector || null,
      element: row
    };
  }
}

window.OrderTableTracker = OrderTableTracker;

