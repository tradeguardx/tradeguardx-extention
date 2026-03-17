/* global chrome, document, CSS */

/**
 * DomScanner discovers BUY/SELL/close/equity/positions elements via DOM inspection only.
 * No AI or network. Uses robust heuristics, confidence scoring, and stable selector generation.
 * Compatible with Exness, TradingView, DXTrade, MatchTrader, TradeLocker, cTrader Web, etc.
 */

// Symbol: BTCUSD, BTC-USDT, SOL-PERP, EUR/USD (2–12 chars, / or - separator)
const SCANNER_SYMBOL_REGEX = /\b([A-Z]{2,12}(?:[\/\-][A-Z]{2,12})?)\b/;
// Numbers: 49500, 49.5, etc.
const NUMERIC_REGEX = /\b\d+(\.\d+)?\b/;
const UNSTABLE_CLASS_PATTERN = /^(css-|jsx-|_[a-z0-9]{6,}$|[a-f0-9]{8,}$)/i;

const MIN_SCORE_THRESHOLD = 3;

/** Prefer instrument (BTC, BTCUSD) over quote currency (USD, EUR) when lengths tie. */
const SCANNER_QUOTE_CURRENCIES = new Set([
  'USD',
  'USDT',
  'USDC',
  'EUR',
  'GBP',
  'JPY',
  'AUD',
  'CHF',
  'CNY',
  'BTC'
]);

function normalizeSymbol(symbol) {
  return (symbol || '')
    .replace(/[\/.\-]/g, '')
    .toUpperCase();
}

function isStableId(id) {
  if (!id || typeof id !== 'string') return false;
  const s = id.trim();
  if (s.length < 2 || s.length > 80) return false;
  return !UNSTABLE_CLASS_PATTERN.test(s);
}

function isStableClassName(className) {
  if (!className || typeof className !== 'string') return false;
  return !UNSTABLE_CLASS_PATTERN.test(className);
}

/**
 * Build a stable CSS selector: prefer id, then data-testid, then stable class names, then tag.
 * Avoids css-, jsx-, and random-looking hashes so selectors survive React re-renders.
 */
function buildStableSelector(el) {
  if (!el || !el.tagName) return '';

  const tag = el.tagName.toLowerCase();

  if (el.id && isStableId(el.id)) {
    return `#${CSS.escape(el.id)}`;
  }

  const testId = el.getAttribute('data-testid');
  if (testId && isStableId(testId)) {
    return `${tag}[data-testid="${CSS.escape(testId)}"]`;
  }

  const classes = Array.from(el.classList || []).filter(isStableClassName);
  if (classes.length > 0) {
    const primary = classes[0];
    return `${tag}.${CSS.escape(primary)}`;
  }

  return tag;
}

function isVisible(el) {
  if (!(el instanceof HTMLElement)) return false;
  try {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  } catch (_) {
    return true;
  }
}

/**
 * Score a candidate element for a given role. Higher = better match.
 */
function scoreCandidate(el, options) {
  if (!(el instanceof HTMLElement)) return 0;
  let score = 0;
  const text = (el.innerText || el.textContent || '').trim().toLowerCase();
  const aria = (el.getAttribute('aria-label') || '').toLowerCase();
  const title = (el.getAttribute('title') || '').toLowerCase();
  const cls = (el.className || '').toLowerCase();
  const combined = `${text} ${aria} ${title} ${cls}`;

  if (options.keywords && options.keywords.some((k) => combined.includes(k.toLowerCase()))) {
    score += 2;
  }
  if (options.keywords && options.keywords.some((k) => cls.includes(k.toLowerCase()))) {
    score += 1;
  }
  if (el.tagName === 'BUTTON') score += 3;
  else if (el.getAttribute('role') === 'button' || el.getAttribute('role') === 'menuitem') score += 2;
  if (isVisible(el)) score += 1;
  return score;
}

/**
 * Targeted query: only scan likely elements to avoid full-DOM walk.
 * Includes input[type="button"] and input[type="submit"] used by some platforms.
 */
function queryClickables(root) {
  if (!root) return [];
  const selector =
    'button, input[type="button"], input[type="submit"], [role="button"], [role="menuitem"], [class*="button"], [class*="btn"], a[class*="trade"], a[class*="order"]';
  return Array.from(root.querySelectorAll(selector));
}

function queryContainers(root) {
  if (!root) return [];
  const selector =
    '[class*="position"],[class*="positions"],[id*="position"],[class*="trade"],[class*="trades"],[class*="order"],[class*="orders"],table';
  return Array.from(root.querySelectorAll(selector));
}

function queryEquityCandidates(root) {
  if (!root) return [];
  return Array.from(
    root.querySelectorAll(
      'span, div, strong, b, [class*="equity"], [id*="equity"], [class*="balance"], [id*="account"]'
    )
  );
}

function queryEquityOnlyCandidates(root) {
  if (!root) return [];
  return Array.from(
    root.querySelectorAll('span, div, strong, b, [class*="equity"], [id*="equity"]')
  );
}

function queryBalanceOnlyCandidates(root) {
  if (!root) return [];
  return Array.from(
    root.querySelectorAll('span, div, strong, b, [class*="balance"], [id*="balance"]')
  );
}

class DomScanner {
  constructor() {
    this.cachedSelectors = null;
    this.host = window.location.hostname;
  }

  async loadCachedSelectors() {
    if (this.cachedSelectors) return this.cachedSelectors;

    const selectors = await new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
        resolve(null);
        return;
      }
      chrome.runtime.sendMessage(
        { type: 'TG_GET_SELECTORS', payload: { host: this.host } },
        (response) => {
          resolve(response || null);
        }
      );
    });

    this.cachedSelectors = selectors;
    return selectors;
  }

  async saveSelectors(selectors) {
    this.cachedSelectors = selectors;
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return Promise.resolve();
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'TG_SAVE_SELECTORS', payload: { host: this.host, selectors } },
        () => resolve()
      );
    });
  }

  async getSelectors() {
    const cached = await this.loadCachedSelectors();
    if (cached && this.validateSelectors(cached)) {
      return cached;
    }

    const heuristics = this.findSelectorsHeuristically();
    if (this.validateSelectors(heuristics)) {
      await this.saveSelectors(heuristics);
      return heuristics;
    }

    const fallback = {
      buy_button: '',
      sell_button: '',
      close_button: '',
      equity: '',
      positions_table: ''
    };
    await this.saveSelectors(fallback);
    return fallback;
  }

  validateSelectors(selectors) {
    if (!selectors) return false;
    const hasAny =
      !!selectors.buy_button ||
      !!selectors.sell_button ||
      !!selectors.close_button ||
      !!selectors.equity ||
      !!selectors.positions_table;
    return hasAny;
  }

  findSelectorsHeuristically() {
    const body = document.body || document.documentElement;
    if (!body) {
      return { buy_button: '', sell_button: '', close_button: '', equity: '', positions_table: '' };
    }

    const buySelector = this.findBestBuyButton(body);
    const sellSelector = this.findBestSellButton(body, buySelector);
    const closeSelector = this.findBestCloseButton(body);
    const equitySelector = this.findBestEquityElement(body);
    const positionsSelector = this.findBestPositionsContainer(body);

    return {
      buy_button: buildStableSelector(buySelector),
      sell_button: buildStableSelector(sellSelector),
      close_button: buildStableSelector(closeSelector),
      equity: buildStableSelector(equitySelector),
      positions_table: buildStableSelector(positionsSelector)
    };
  }

  findBestBuyButton(root) {
    const keywords = ['buy', 'long'];
    const clickables = queryClickables(root);
    let best = null;
    let bestScore = 0;

    for (const el of clickables) {
      if (el.disabled) continue;
      const score = scoreCandidate(el, { keywords });
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return bestScore >= MIN_SCORE_THRESHOLD ? best : null;
  }

  findBestSellButton(root, excludeEl = null) {
    const keywords = ['sell', 'short'];
    const clickables = queryClickables(root);
    let best = null;
    let bestScore = 0;

    for (const el of clickables) {
      if (el.disabled) continue;
      if (excludeEl && el === excludeEl) continue;
      const score = scoreCandidate(el, { keywords });
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return bestScore >= MIN_SCORE_THRESHOLD ? best : null;
  }

  findBestCloseButton(root) {
    const keywords = ['close', 'close position', 'close all', 'exit', 'flatten'];
    const clickables = queryClickables(root);
    let best = null;
    let bestScore = 0;

    for (const el of clickables) {
      const text = (el.innerText || el.textContent || '').trim();
      let score = scoreCandidate(el, { keywords });
      if (text === '×' || text === '✕' || text === 'X' || /[\u00D7\u2715]/.test(text)) {
        score += 2;
      }
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return bestScore >= MIN_SCORE_THRESHOLD ? best : null;
  }

  /**
   * Find the element that contains the equity numeric value (not just the label).
   * Prefers "equity" context; falls back to "balance" only if no equity found (avoids picking Balance when Equity is present).
   */
  findBestEquityElement(root) {
    const equityBest = this.findBestEquityOrBalanceInCandidates(
      queryEquityOnlyCandidates(root),
      (text, el) => /equity/i.test(text) || /equity/i.test(el.className || '') || /equity/i.test(el.id || '')
    );
    if (equityBest) return equityBest;

    return this.findBestEquityOrBalanceInCandidates(
      queryBalanceOnlyCandidates(root),
      (text, el) => {
        if (/free margin/i.test(text)) return false;
        return /balance/i.test(text) || /balance/i.test(el.className || '') || /balance/i.test(el.id || '');
      }
    );
  }

  findBestEquityOrBalanceInCandidates(candidates, hasLabel) {
    let best = null;
    let bestScore = 0;

    for (const el of candidates) {
      const text = (el.innerText || el.textContent || '').trim();
      if (!text || text.length > 300) continue;
      if (!hasLabel(text, el)) continue;

      const container = el.closest('div, tr, section, [class*="account"], [class*="balance"]') || el;
      const containerText = (container.innerText || container.textContent || '').replace(/\s+/g, ' ');
      const numericMatch = containerText.match(NUMERIC_REGEX);
      if (!numericMatch || !numericMatch[0]) continue;

      const num = parseFloat(numericMatch[0].replace(/,/g, ''));
      if (!Number.isFinite(num) || num <= 0) continue;

      let valueEl = el;
      if (container !== el) {
        const valueSpan = container.querySelector('span, div, strong, b');
        if (
          valueSpan &&
          NUMERIC_REGEX.test(valueSpan.innerText || valueSpan.textContent || '') &&
          (valueSpan.innerText || valueSpan.textContent || '').length < 50
        ) {
          valueEl = valueSpan;
        } else {
          valueEl = container;
        }
      } else if (!NUMERIC_REGEX.test(el.innerText || el.textContent || '')) {
        const childWithNum = el.querySelector('span, div, strong, b');
        if (
          childWithNum &&
          NUMERIC_REGEX.test(childWithNum.innerText || childWithNum.textContent || '')
        ) {
          valueEl = childWithNum;
        }
      }

      let score = 1;
      if (NUMERIC_REGEX.test(valueEl.innerText || valueEl.textContent || '')) score += 2;
      if (isVisible(valueEl)) score += 1;
      if (valueEl.tagName === 'SPAN' || valueEl.tagName === 'STRONG') score += 1;
      if (score > bestScore) {
        bestScore = score;
        best = valueEl;
      }
    }
    return best;
  }

  /**
   * Find the positions/open trades container. Prefer elements that contain rows
   * with symbol (e.g. EURUSD) and buy/sell text.
   */
  findBestPositionsContainer(root) {
    const containers = queryContainers(root);
    let best = null;
    let bestScore = 0;

    for (const el of containers) {
      if (!(el instanceof HTMLElement) || !el.isConnected) continue;

      const fullText = (el.innerText || el.textContent || '').replace(/\s+/g, ' ');
      const hasSymbol = SCANNER_SYMBOL_REGEX.test(fullText);
      const hasSide = /\b(buy|sell|long|short)\b/i.test(fullText);

      let score = 0;
      if (hasSymbol) score += 2;
      if (hasSide) score += 1;
      if (isVisible(el)) score += 1;

      const rows = el.querySelectorAll('tr, [class*="row"], [class*="item"], li');
      let rowMatchCount = 0;
      rows.forEach((row) => {
        const rowText = (row.innerText || row.textContent || '').replace(/\s+/g, ' ');
        if (SCANNER_SYMBOL_REGEX.test(rowText) && /\b(buy|sell|long|short)\b/i.test(rowText)) {
          rowMatchCount += 1;
        }
      });
      if (rowMatchCount > 0) score += 3;

      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  /**
   * Extract open trades from a positions container (e.g. the element found as positions_table).
   * Each row should contain symbol + buy/sell + numeric value (volume).
   * Enables hedging detection, trade monitoring, SL/TP reminders.
   *
   * @param {HTMLElement} container - Positions table/list container
   * @returns {{ symbol: string, side: string, volume?: number }[]}
   */
  extractTrades(container) {
    if (!container || !(container instanceof HTMLElement) || !container.isConnected) return [];

    const rows = container.querySelectorAll('tr, [class*="row"], [class*="item"], li');
    const trades = [];
    const seen = new Set();

    for (const row of rows) {
      const rowText = (row.innerText || row.textContent || '').replace(/\s+/g, ' ').trim();
      if (!rowText || rowText.length > 400) continue;

      const symbolMatches = [...rowText.matchAll(new RegExp(SCANNER_SYMBOL_REGEX.source, 'g'))];
      const sideMatch = rowText.match(/\b(buy|sell|long|short)\b/i);
      if (!symbolMatches.length || !sideMatch) continue;

      const valid = [];
      for (const m of symbolMatches) {
        const s = normalizeSymbol(m[1] || m[0] || '');
        if (s.length < 3 || s.length > 20) continue;
        if (!/[A-Z]{3}/.test(s)) continue;
        if (/usdtt|usdtusd/.test(s)) continue;
        valid.push(s);
      }
      if (valid.length === 0) continue;
      valid.sort((a, b) => {
        if (b.length !== a.length) return b.length - a.length;
        const aQuote = SCANNER_QUOTE_CURRENCIES.has(a) ? 1 : 0;
        const bQuote = SCANNER_QUOTE_CURRENCIES.has(b) ? 1 : 0;
        return aQuote - bQuote;
      });
      const symbol = valid[0];
      const side = sideMatch[1].toUpperCase();
      const normalizedSide = /buy|long/i.test(side) ? 'BUY' : 'SELL';

      const key = `${symbol}|${normalizedSide}`;
      if (seen.has(key)) continue;
      seen.add(key);

      let volume;
      const numMatches = rowText.match(/\d+(?:\.\d+)?/g);
      if (numMatches && numMatches.length > 0) {
        for (const n of numMatches) {
          const v = parseFloat(n.replace(/,/g, ''));
          if (Number.isFinite(v) && v >= 0.001 && v <= 100000) {
            volume = v;
            break;
          }
        }
      }

      trades.push({ symbol, side: normalizedSide, volume });
    }

    return trades;
  }
}

window.DomScanner = DomScanner;
