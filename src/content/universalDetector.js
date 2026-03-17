/* global document */

/**
 * Universal Trade Detection Engine.
 * Detects structures and patterns from the DOM without platform-specific selectors.
 * No AI, no network. Uses a unified strategy map for Delta, Exness, Binance, Bybit, etc.
 */

// Symbol: BTCUSD, BTC-USDT, SOL-PERP, EUR/USD (2–12 chars, / or - separator)
const SYMBOL_REGEX = /\b([A-Z]{2,12}(?:[\/\-][A-Z]{2,12})?)\b/;
const SIDE_REGEX = /\b(buy|sell|long|short)\b/i;
const NUMBER_REGEX = /\b\d+(\.\d+)?\b/;

/** Unified strategy map: source of truth for side and field keywords (data-testid, class, innerText). */
const TRADE_CONFIG = {
  side: {
    buy: ['long', 'buy', 'positive', 'up-trend', 'success'],
    sell: ['short', 'sell', 'negative', 'down-trend', 'danger']
  },
  fields: {
    entryPrice: ['entry', 'open', 'price-open', 'entryprice'],
    currentPrice: [
      'mark',
      'market',
      'current',
      'last',
      'mark_price'
    ],
    pnl: ['pnl', 'unrealized', 'upnl', 'profit', 'gain', 'floating'],
    stopLoss: [
      'sl',
      'stop',
      'stoploss',
      'summary-stoploss',
      'summary-stoploss-trigger-price'
    ],
    takeProfit: [
      'tp',
      'take',
      'takeprofit',
      'summary-takeprofit',
      'summary-takeprofit-trigger-price'
    ]
  }
};

const ORDER_FIELD_KEYWORDS = {
  stopLoss: ['sl', 'stop', 'stop loss', 'stoploss', 's/l'],
  takeProfit: ['tp', 'take', 'take profit', 'takeprofit', 't/p'],
  entryPrice: ['entry', 'open', 'entry price', 'open price'],
  currentPrice: ['current', 'mark', 'market', 'mark price', 'markprice', 'last', 'bid', 'ask'],
  pnl: ['p&l', 'p/l', 'pnl', 'profit', 'unrealized', 'floating']
};

const ORDER_CONTAINER_MIN_SCORE = 6;
let preferredPositionsSelector = null;

/** Multi-source context: element + parent + closest td (labels on parent, value in child e.g. <td data-testid="entryPrice"><h5>67840.6</h5>). */
function getElementContext(el) {
  if (!el) return '';

  const parent = el.parentElement;
  const td = el.closest ? el.closest('td') : null;

  return (
    (el.getAttribute?.('data-testid') || '') +
    ' ' +
    (el.getAttribute?.('data-index') || '') +
    ' ' +
    (el.className || '') +
    ' ' +
    (el.innerText || '') +
    ' ' +
    (parent?.getAttribute?.('data-testid') || '') +
    ' ' +
    (parent?.className || '') +
    ' ' +
    (td?.getAttribute?.('data-testid') || '') +
    ' ' +
    (td?.getAttribute?.('data-index') || '')
  ).toLowerCase();
}

function normalizeSymbol(symbol) {
  return (symbol || '')
    .replace(/[\/.\-]/g, '')
    .toUpperCase();
}

function isStableToken(token) {
  if (!token || typeof token !== 'string') return false;
  if (token.length < 2 || token.length > 80) return false;
  if (/^(css-|jsx-|_[a-z0-9]{6,}$|[a-f0-9]{8,}$)/i.test(token)) return false;
  return true;
}

function buildStableSelector(el) {
  if (!el || !el.tagName) return '';
  const tag = el.tagName.toLowerCase();
  if (el.id && isStableToken(el.id) && window.CSS?.escape) {
    return `#${window.CSS.escape(el.id)}`;
  }

  const dataKeys = ['data-testid', 'data-test', 'data-qa', 'data-cy'];
  for (const key of dataKeys) {
    const value = el.getAttribute?.(key);
    if (value && isStableToken(value)) {
      return `${tag}[${key}="${value.replace(/"/g, '\\"')}"]`;
    }
  }

  const classList = Array.from(el.classList || []).filter(isStableToken);
  if (classList.length > 0 && window.CSS?.escape) {
    return `${tag}.${window.CSS.escape(classList[0])}`;
  }

  return tag;
}

function buildDomPath(el, maxDepth = 4) {
  if (!el || !el.tagName) return '';
  const parts = [];
  let current = el;
  let depth = 0;
  while (current && current !== document.body && depth < maxDepth) {
    const part = buildStableSelector(current);
    if (!part) break;
    parts.unshift(part);
    if (part.startsWith('#')) break;
    current = current.parentElement;
    depth += 1;
  }
  return parts.join(' > ');
}

function buildExactPathSegment(el) {
  if (!el || !el.tagName) return '';
  const tag = el.tagName.toLowerCase();
  if (el.id && isStableToken(el.id) && window.CSS?.escape) {
    return `#${window.CSS.escape(el.id)}`;
  }
  const dataKeys = ['data-testid', 'data-test', 'data-qa', 'data-cy'];
  for (const key of dataKeys) {
    const value = el.getAttribute?.(key);
    if (value && isStableToken(value)) {
      return `${tag}[${key}="${value.replace(/"/g, '\\"')}"]`;
    }
  }
  const parent = el.parentElement;
  if (!parent) return tag;
  const siblings = Array.from(parent.children).filter((n) => n.tagName === el.tagName);
  const index = siblings.indexOf(el);
  return `${tag}:nth-of-type(${index + 1})`;
}

function buildExactElementSelector(el, scope = null, maxDepth = 8) {
  if (!el || !el.tagName) return '';
  const parts = [];
  let current = el;
  let depth = 0;
  while (
    current &&
    current !== document.body &&
    current !== document.documentElement &&
    current !== scope &&
    depth < maxDepth
  ) {
    const seg = buildExactPathSegment(current);
    if (!seg) break;
    parts.unshift(seg);
    if (seg.startsWith('#')) break;
    current = current.parentElement;
    depth += 1;
  }
  return parts.join(' > ');
}

function parseNumericText(text) {
  if (!text) return null;
  const clean = String(text).replace(/[^0-9.+-]/g, '');
  if (!clean || clean === '-' || clean === '+') return null;
  const n = parseFloat(clean);
  return Number.isFinite(n) ? n : null;
}

/**
 * Given a container (e.g. TP div), get the numeric value from it.
 * Prefer single-number text so we don't pick the wrong value from "Entry X Current Y".
 * Returns number or null.
 */
function getNumericValueFromContainer(container) {
  if (!container || typeof container.innerText !== 'string') return null;
  const raw = (container.innerText || '').replace(/\s+/g, ' ').trim();
  const num = parseNumericText(raw);
  if (num == null) return null;
  const matches = raw.match(/\d[\d.,]*/g);
  if (matches && matches.length > 1 && raw.length > 25) return null;
  return num;
}

/**
 * Given any container (e.g. TP div > div > span), find the innermost element that holds the value.
 * Uses only structure (descendants) and text — no platform-specific attributes.
 * Very specific: prefers a single number in the node's text so we don't pick wrong/cross-field values.
 * Returns { element, value } or null.
 */
function getValueLeafInContainer(container) {
  if (!container || !container.querySelectorAll) return null;
  const all = [container, ...container.querySelectorAll('*')];
  let best = null;
  let bestScore = -1;
  for (const el of all) {
    if (!(el instanceof HTMLElement) || !el.isConnected) continue;
    const text = (el.innerText || el.textContent || '').trim();
    if (!text || text.length > 50) continue;
    const num = parseNumericText(text);
    if (num == null && !/^[+-]?\d[\d.,]*\s*%?$/.test(text)) continue;
    const childCount = el.childElementCount;
    const singleNumberOnly = /^[+\-]?\s*\d[\d.,\s]*%?$/.test(text.replace(/,/g, ''));
    const multipleNumbers = (text.match(/\d[\d.,]*/g) || []).length > 1;
    let score = 0;
    score += (childCount === 0 ? 10 : 0) - childCount;
    score += text.length <= 20 ? 2 : 0;
    if (singleNumberOnly && !multipleNumbers) score += 8;
    if (multipleNumbers) score -= 5;
    if (score > bestScore) {
      bestScore = score;
      best = { element: el, value: num != null ? num : parseNumericText(text.replace(/,/g, '')) };
    }
  }
  return best;
}

function pickBestFieldElement(root, keywords, excludePattern) {
  if (!root) return null;
  const nodes = root.querySelectorAll('td, span, div, p, strong, b, h5, [data-testid], [data-index]');
  let best = null;
  let bestScore = -1;
  for (const node of nodes) {
    if (!(node instanceof HTMLElement) || !node.isConnected) continue;
    if (node.children.length > 8) continue;
    const text = (node.innerText || '').trim();
    if (!text || text.length > 60) continue;
    const num = parseNumericText(text);
    if (!Number.isFinite(num)) continue;

    const context = getElementContext(node);
    if (excludePattern && excludePattern.test(context)) continue;
    if (!keywords.some((k) => context.includes(k))) continue;

    // Prefer leaf-like nodes and compact numeric text.
    let score = 0;
    score += 3;
    if (node.children.length === 0) score += 2;
    if (text.length <= 20) score += 1;
    if ((node.getAttribute('data-testid') || '').length > 0) score += 1;
    if ((node.getAttribute('data-index') || '').length > 0) score += 1;
    if (score > bestScore) {
      best = node;
      bestScore = score;
    }
  }
  return best;
}

function detectTradeFieldElements(row) {
  if (!row) {
    return {
      stopLoss: null,
      takeProfit: null,
      entryPrice: null,
      currentPrice: null,
      profit: null
    };
  }

  const stopLoss = pickBestFieldElement(
    row,
    TRADE_CONFIG.fields.stopLoss,
    /current|market|mark\b|entry|open/
  );
  const takeProfit = pickBestFieldElement(
    row,
    TRADE_CONFIG.fields.takeProfit,
    /current|market|mark\b|entry|open/
  );
  const entryPrice = pickBestFieldElement(row, TRADE_CONFIG.fields.entryPrice, /take|stop/);
  const currentPrice = pickBestFieldElement(row, TRADE_CONFIG.fields.currentPrice);
  const profit = pickBestFieldElement(row, TRADE_CONFIG.fields.pnl);

  return { stopLoss, takeProfit, entryPrice, currentPrice, profit };
}

function collectFieldHints(text) {
  const low = (text || '').toLowerCase();
  const hints = {};
  Object.entries(ORDER_FIELD_KEYWORDS).forEach(([field, words]) => {
    hints[field] = words.some((w) => low.includes(w));
  });
  return hints;
}

function scoreOrderDetailsContainer(container) {
  if (!(container instanceof HTMLElement) || !container.isConnected) return null;
  const text = (container.innerText || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length < 30 || text.length > 15000) return null;

  const hints = collectFieldHints(text);
  const fieldCount = Object.values(hints).filter(Boolean).length;
  const rowCount = container.querySelectorAll('tr, [role="row"], [class*="row"], li').length;
  const hasTable = container.tagName === 'TABLE' || container.querySelector('table, [role="table"]');
  const hasSymbol = SYMBOL_REGEX.test(text);
  const hasSide = SIDE_REGEX.test(text);
  const hasCloseAction = /\b(close|exit|flatten)\b/i.test(text);
  const numbers = text.match(/[+-]?\d+(?:\.\d+)?/g) || [];
  const orderPanelSignals =
    /\b(limit|market|maker|taker|quantity|available margin|funds|reduce only|bracket order|order value|best bid|best ask|payoff|calculator|max allowed|risk per trade)\b/i.test(
      text.toLowerCase()
    );
  const sampleRows = Array.from(
    container.querySelectorAll('tr, [role="row"], [class*="row"], li')
  ).slice(0, 12);
  const strongRowCount = sampleRows.filter((row) => {
    if (!(row instanceof HTMLElement)) return false;
    const rt = (row.innerText || '').replace(/\s+/g, ' ').trim();
    if (!rt || rt.length > 1500) return false;
    const tdCount = row.querySelectorAll('td').length;
    const sym = getBestSymbolFromText(rt);
    const hasField = /\b(tp|sl|entry|open|mark|current|p\/l|pnl|profit)\b/i.test(rt.toLowerCase());
    return !!sym && (tdCount >= 4 || hasField);
  }).length;

  let score = 0;
  score += fieldCount * 2;
  if (hasTable) score += 2;
  if (hasSymbol) score += 2;
  if (hasSide) score += 1;
  if (hasCloseAction) score += 1;
  if (rowCount >= 2) score += 2;
  if (numbers.length >= 5) score += 1;
  if (strongRowCount >= 1) score += 3;
  if (strongRowCount >= 2) score += 2;
  if (orderPanelSignals) score -= 4;

  if (score < ORDER_CONTAINER_MIN_SCORE) return null;
  return { score, hints, rowCount };
}

function getOrderDetailsCandidates(root) {
  if (!root) return [];
  const selector = [
    'table',
    '[role="table"]',
    '[class*="position"]',
    '[class*="positions"]',
    '[class*="trade"]',
    '[class*="trades"]',
    '[class*="order"]',
    '[class*="orders"]',
    '[id*="position"]',
    '[id*="trade"]',
    '[id*="order"]'
  ].join(',');
  const nodes = Array.from(root.querySelectorAll(selector));
  return nodes.filter((n) => n instanceof HTMLElement);
}

function detectOrderDetailsIdentity(root = document.body) {
  if (!root) return null;
  const candidates = getOrderDetailsCandidates(root);
  if (candidates.length === 0) return null;

  let best = null;
  let bestScore = -1;
  let bestMeta = null;

  for (const candidate of candidates) {
    const meta = scoreOrderDetailsContainer(candidate);
    if (!meta) continue;
    if (meta.score > bestScore) {
      best = candidate;
      bestScore = meta.score;
      bestMeta = meta;
    }
  }

  if (!best || !bestMeta) return null;
  const selector = buildDomPath(best) || buildStableSelector(best);
  if (!selector) return null;

  const sampleRow = best.querySelector('tr, [role="row"], [class*="row"], li');
  const fieldEls = detectTradeFieldElements(sampleRow || best);
  const fieldSelectors = {
    stopLoss: fieldEls.stopLoss ? buildExactElementSelector(fieldEls.stopLoss, best) : null,
    takeProfit: fieldEls.takeProfit ? buildExactElementSelector(fieldEls.takeProfit, best) : null,
    entryPrice: fieldEls.entryPrice ? buildExactElementSelector(fieldEls.entryPrice, best) : null,
    currentPrice: fieldEls.currentPrice ? buildExactElementSelector(fieldEls.currentPrice, best) : null,
    pnl: fieldEls.profit ? buildExactElementSelector(fieldEls.profit, best) : null
  };
  const absoluteFieldSelectors = {
    stopLoss: fieldEls.stopLoss ? buildExactElementSelector(fieldEls.stopLoss) : null,
    takeProfit: fieldEls.takeProfit ? buildExactElementSelector(fieldEls.takeProfit) : null,
    entryPrice: fieldEls.entryPrice ? buildExactElementSelector(fieldEls.entryPrice) : null,
    currentPrice: fieldEls.currentPrice ? buildExactElementSelector(fieldEls.currentPrice) : null,
    pnl: fieldEls.profit ? buildExactElementSelector(fieldEls.profit) : null
  };

  return {
    selector,
    tag: best.tagName.toLowerCase(),
    confidence: bestMeta.score,
    rowCount: bestMeta.rowCount,
    fieldsDetected: bestMeta.hints,
    fieldSelectors,
    absoluteFieldSelectors
  };
}

function getPreferredTradesRoot(root) {
  if (root && root !== document.body) return root;
  if (!preferredPositionsSelector || !document.body) return root;
  try {
    const preferred = document.querySelector(preferredPositionsSelector);
    if (preferred) return preferred;
  } catch (_err) {
    // ignore invalid selectors and fall back
  }
  return root;
}

/**
 * Detect side (BUY/SELL) from TRADE_CONFIG keywords in text + HTML (Delta colored divs, Exness text).
 */
function detectSide(node, text) {
  const textMatch = text.match(SIDE_REGEX);
  if (textMatch) {
    const s = textMatch[1].toUpperCase();
    return s === 'BUY' || s === 'LONG' ? 'BUY' : 'SELL';
  }

  const rowContext = (text + ' ' + (node.innerHTML || '')).toLowerCase();
  if (TRADE_CONFIG.side.buy.some((k) => rowContext.includes(k))) return 'BUY';
  if (TRADE_CONFIG.side.sell.some((k) => rowContext.includes(k))) return 'SELL';

  const attr = (
    (node.className || '') +
    ' ' +
    (node.getAttribute('data-side') || '') +
    ' ' +
    (node.getAttribute('data-direction') || '') +
    ' ' +
    (node.getAttribute('data-position') || '')
  ).toLowerCase();
  if (TRADE_CONFIG.side.buy.some((k) => attr.includes(k))) return 'BUY';
  if (TRADE_CONFIG.side.sell.some((k) => attr.includes(k))) return 'SELL';

  const indicator = node.querySelector(
    '[class*="long"],[class*="short"],[class*="buy"],[class*="sell"]'
  );
  if (indicator) {
    const c = (indicator.className || '').toLowerCase();
    if (/long|buy/.test(c)) return 'BUY';
    if (/short|sell/.test(c)) return 'SELL';
  }

  return null;
}

/** Common quote/currency labels: prefer instrument (BTC, BTCUSD) over these when lengths tie. */
const QUOTE_CURRENCIES = new Set([
  'USD',
  'USDT',
  'USDC',
  'EUR',
  'GBP',
  'JPY',
  'AUD',
  'CHF',
  'CNY'
]);
const INVALID_SYMBOL_TOKENS = new Set([
  'BUY',
  'SELL',
  'LONG',
  'SHORT',
  'TP',
  'SL',
  'TPSL',
  'SLTP',
  'PNL',
  'PL',
  'PANDL',
  'ENTRY',
  'OPEN',
  'CURRENT',
  'PRICE',
  'MARK',
  'CALCULATOR',
  'MARKET',
  'LIMIT',
  'MAKER',
  'TAKER'
]);

function symbolFeatureScore(symbol) {
  if (!symbol) return -100;
  let score = 0;
  if (/[\/\-]/.test(symbol)) score += 35;
  if (/\d/.test(symbol)) score += 30;
  if (symbol.length <= 6) score += 20;
  for (const quote of QUOTE_CURRENCIES) {
    if (symbol.endsWith(quote) && symbol.length > quote.length) {
      score += 50;
      break;
    }
  }
  if (symbol.endsWith('PERP') && symbol.length > 4) score += 45;
  if (symbol.length > 8) score -= 20;
  return score;
}

function isLikelyTradableSymbol(symbol) {
  if (!symbol) return false;
  if (/[\/\-]/.test(symbol)) return true;
  if (/\d/.test(symbol)) return true;
  if (symbol.endsWith('PERP') && symbol.length > 4) return true;
  for (const quote of QUOTE_CURRENCIES) {
    if (symbol.endsWith(quote) && symbol.length > quote.length) return true;
  }
  return symbol.length <= 6;
}

/**
 * From text, return the best valid symbol (BTC, BTCUSD, EUR/USD, etc.).
 * Prefers longest match so BTCUSD wins over USD; when tied, prefers instrument over quote currency.
 */
function getBestSymbolFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const searchText = text.toUpperCase();
  const allMatches = [...searchText.matchAll(new RegExp(SYMBOL_REGEX.source, 'g'))];
  const valid = [];
  for (const m of allMatches) {
    const s = normalizeSymbol((m[1] || m[0] || '').trim());
    if (s.length < 3 || s.length > 20) continue;
    if (!/[A-Z]{3}/.test(s)) continue;
    if (/usdtt|usdtusd/.test(s)) continue;
    if (QUOTE_CURRENCIES.has(s)) continue;
    if (INVALID_SYMBOL_TOKENS.has(s)) continue;
    if (!isLikelyTradableSymbol(s)) continue;
    valid.push(s);
  }
  if (valid.length === 0) return null;
  valid.sort((a, b) => {
    const scoreDiff = symbolFeatureScore(b) - symbolFeatureScore(a);
    if (scoreDiff !== 0) return scoreDiff;
    if (b.length !== a.length) return b.length - a.length;
    const aQuote = QUOTE_CURRENCIES.has(a) ? 1 : 0;
    const bQuote = QUOTE_CURRENCIES.has(b) ? 1 : 0;
    return aQuote - bQuote;
  });
  return valid[0];
}

/**
 * Find a numeric value near the word "equity" (avoids grabbing Free Margin etc).
 * Uses targeted query to avoid scanning entire DOM (10k+ nodes on trading platforms).
 */
function detectEquity(root = document.body) {
  if (!root) return null;
  const nodes = root.querySelectorAll(
    'span, div, strong, b, [class*="equity"], [class*="balance"], [id*="equity"], [id*="balance"]'
  );
  for (const node of nodes) {
    if (!(node instanceof HTMLElement)) continue;
    const text = (node.innerText || '').toLowerCase();
    if (!text || text.length > 200) continue;
    if (!text.includes('equity')) continue;
    const parent = node.closest('div, tr, section, [class*="account"], [class*="balance"]') || node.parentElement;
    const container = parent || node;
    const raw = (container.innerText || '').replace(/\s+/g, ' ');
    const numbers = raw.match(NUMBER_REGEX);
    if (numbers && numbers[0]) {
      const parsed = parseFloat(numbers[0].replace(/,/g, ''));
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

/**
 * Detect balance: numeric value near the word "balance".
 * Uses targeted query to avoid scanning entire DOM.
 */
function detectBalance(root = document.body) {
  if (!root) return null;

  const BALANCE_ATTR =
    /\b(balance|wallet|account|equity|portfolio|funds)\b/i;

  const nodes = root.querySelectorAll(
    'span, div, strong, b, button, [class*="wallet"], [class*="balance"], [id*="wallet"], [id*="balance"], [id*="account"]'
  );

  for (const node of nodes) {
    if (!(node instanceof HTMLElement)) continue;

    const attrs = (
      node.id +
      " " +
      node.className +
      " " +
      (node.getAttribute("aria-label") || "") +
      " " +
      (node.getAttribute("title") || "")
    ).toLowerCase();

    const text = (node.innerText || "").trim();

    if (!text || text.length > 100) continue;

    // detect wallet/account containers
    if (!BALANCE_ATTR.test(attrs) && !BALANCE_ATTR.test(text)) continue;

    const numbers = text.match(NUMBER_REGEX);

    if (!numbers) continue;

    for (const num of numbers) {
      const parsed = parseFloat(num.replace(/,/g, ""));
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

const columnMapCache = new WeakMap();

/**
 * Map table header labels to column indexes. Cached per table for speed.
 * Symbol | Type | Volume | Open/Entry | Current | TP | SL | P/L
 * (Entry = open price on Exness and many platforms.)
 */
function buildColumnMap(table) {
  if (columnMapCache.has(table)) return columnMapCache.get(table);

  const map = {
    symbol: null,
    side: null,
    volume: null,
    open: null,
    current: null,
    tp: null,
    sl: null,
    pnl: null
  };

  const headerRow = table.querySelector('thead tr') || table.querySelector('tr');
  if (!headerRow) return map;

  const headers = headerRow.querySelectorAll('th, td');
  headers.forEach((h, i) => {
    const text = (h.innerText || '').toLowerCase();
    if (text.includes('symbol') || text.includes('instrument')) map.symbol = i;
    if (text.includes('type') || text.includes('side')) map.side = i;
    if (text.includes('volume') || text.includes('size')) map.volume = i;
    if (text.includes('open') || text.includes('entry')) map.open = i; // entry = open price (e.g. Exness)
    if (
      text.includes('current') ||
      text.includes('mark') ||
      (text.includes('price') && !text.includes('take') && !text.includes('stop'))
    ) map.current = i;
    if (text.includes('tp') || text.includes('take')) map.tp = i;
    if (text.includes('sl') || text.includes('stop')) map.sl = i;
    if (text.includes('p/l') || text.includes('pnl') || text.includes('profit')) map.pnl = i;
  });

  columnMapCache.set(table, map);
  return map;
}

/**
 * Read SL, TP, P/L from a data row using column map. Returns null for "Add", "Modify", etc.
 */
function parseTradeRow(row, columnMap) {
  const cells = row.cells ? Array.from(row.cells) : [];

  const getNumber = (index) => {
    if (index == null || !cells[index]) return null;
    const text = (cells[index].innerText || '').trim();
    if (/^(add|modify|edit|—|-|)$/i.test(text)) return null;
    const cleanText = text.replace(/[^0-9.-]/g, '');
    const val = parseFloat(cleanText);
    return Number.isFinite(val) ? val : null;
  };

  const slVal = getNumber(columnMap.sl);
  const tpVal = getNumber(columnMap.tp);
  const pnlVal = getNumber(columnMap.pnl);
  const entryPrice = getNumber(columnMap.open);
  const currentPrice = getNumber(columnMap.current);

  return {
    stopLoss: slVal != null && slVal > 0 ? slVal : null,
    takeProfit: tpVal != null && tpVal > 0 ? tpVal : null,
    profit: pnlVal,
    entryPrice: entryPrice != null && entryPrice > 0 ? entryPrice : null,
    currentPrice: currentPrice != null && currentPrice > 0 ? currentPrice : null
  };
}

function isTradeGuardElement(el) {
  if (!(el instanceof HTMLElement)) return false;
  if (el.closest('#tg-warning-overlay, #tg-blocked-trade-overlay, #tg-warning-toast')) return true;
  const id = (el.id || '').toLowerCase();
  const cls = (el.className || '').toLowerCase();
  if (id.startsWith('tg-')) return true;
  if (/\btg-[a-z0-9_-]+\b/.test(cls)) return true;
  return false;
}

function parseSignedNumber(text) {
  if (!text) return null;
  const matches = String(text).match(/[+-]?\s*\d[\d,]*(?:\.\d+)?/g);
  if (!matches || matches.length === 0) return null;
  const preferred = matches.find((m) => /[+-]/.test(m)) || matches[0];
  const num = parseFloat(preferred.replace(/\s+/g, '').replace(/,/g, ''));
  return Number.isFinite(num) ? num : null;
}

function findDetachedPnlValue(row, scanRoot) {
  if (!row || !document.body) return null;
  const rowText = (row.innerText || '').toUpperCase();
  const rowSymbol = getBestSymbolFromText(rowText);
  const rowSide = detectSide(row, rowText) || null;
  const pnlKeyword = /\b(p\/l|pnl|profit|unrealized|upnl|floating)\b/i;
  const nonPnlContext = /\b(stop|sl|take|tp|entry|open|current|mark|price|risk|max allowed|calculator)\b/i;

  const localScope =
    row.closest?.('[class*="position"], [class*="trade"], [class*="order"], tbody, table, section, article') ||
    row.parentElement ||
    row;
  const scopes = [localScope];
  if (scanRoot && scanRoot !== localScope) scopes.push(scanRoot);
  if (document.body !== localScope && document.body !== scanRoot) scopes.push(document.body);

  const targetedSelector = [
    '[data-testid*="pnl"]',
    '[data-testid*="profit"]',
    '[data-test*="pnl"]',
    '[data-test*="profit"]',
    '[class*="pnl"]',
    '[class*="profit"]',
    '[id*="pnl"]',
    '[id*="profit"]',
    '[aria-label*="pnl"]',
    '[aria-label*="profit"]',
    '[title*="pnl"]',
    '[title*="profit"]'
  ].join(',');

  let best = null;
  let bestScore = -9999;
  for (let i = 0; i < scopes.length; i += 1) {
    const scope = scopes[i];
    if (!scope || typeof scope.querySelectorAll !== 'function') continue;
    const nodes = scope.querySelectorAll(targetedSelector);
    const limit = i === 0 ? 120 : 220;
    const candidates = Array.from(nodes).slice(0, limit);
    for (const el of candidates) {
      if (!(el instanceof HTMLElement) || !el.isConnected) continue;
      if (isTradeGuardElement(el)) continue;
      if (el === row || row.contains(el)) continue;
      const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 80) continue;
      const num = parseSignedNumber(text);
      if (!Number.isFinite(num)) continue;
      if (Math.abs(num) > 100000000) continue;

      const context = (
        getElementContext(el) +
        ' ' +
        (el.getAttribute('aria-label') || '') +
        ' ' +
        (el.getAttribute('title') || '') +
        ' ' +
        (el.getAttribute('data-label') || '') +
        ' ' +
        text
      ).toLowerCase();
      if (!pnlKeyword.test(context)) continue;
      if (nonPnlContext.test(context) && !/\b(p\/l|pnl|profit|unrealized|upnl|floating)\b/i.test(text)) {
        continue;
      }

      let score = 0;
      if (i === 0) score += 10; // prefer row-near scopes first
      if (/[+-]/.test(text)) score += 4;
      if ((el.getAttribute('data-testid') || '').toLowerCase().includes('pnl')) score += 6;
      if ((el.getAttribute('data-testid') || '').toLowerCase().includes('profit')) score += 4;
      if ((el.className || '').toLowerCase().includes('pnl')) score += 5;
      if ((el.className || '').toLowerCase().includes('profit')) score += 3;
      if (rowSymbol && context.includes(rowSymbol.toLowerCase())) score += 8;
      if (rowSide && context.includes(rowSide.toLowerCase())) score += 2;

      if (score > bestScore) {
        bestScore = score;
        best = num;
      }
    }
    if (best != null) return best;
  }
  return null;
}

/**
 * Extract numbers from a trade row (SL, TP, entry, current, P&L). Works for nested markup (e.g. div > div > span).
 * Order: (1) Table column map. (2) Context-based field element + getValueLeafInContainer. (3) Attribute-agnostic
 * container query + value leaf. (4) Cell scan by context. We only accept when specific (single value, right semantic).
 */
function detectStopLossTakeProfitAndProfit(row, scanRoot = document.body) {
  if (!row) return { stopLoss: null, takeProfit: null, profit: null, entryPrice: null, currentPrice: null };

  let stopLoss = null;
  let takeProfit = null;
  let profit = null;
  let entryPrice = null;
  let currentPrice = null;

  const table = row.closest && row.closest('table');

  if (table) {
    const columnMap = buildColumnMap(table);
    const tradeValues = parseTradeRow(row, columnMap);

    stopLoss = tradeValues.stopLoss;
    takeProfit = tradeValues.takeProfit;
    profit = tradeValues.profit;
    entryPrice = tradeValues.entryPrice;
    currentPrice = tradeValues.currentPrice;
  }

  // No platform-specific data-testid here; SL/TP come from exactFields (context/keywords) and cells loop below.

  const entryNode = row.querySelector?.(
    [
      '[data-testid*="entry"][data-testid*="price"]',
      '[data-testid*="open"][data-testid*="price"]',
      '[data-test*="entry"][data-test*="price"]',
      '[data-test*="open"][data-test*="price"]',
      '[id*="entry"][id*="price"]',
      '[id*="open"][id*="price"]',
      '[class*="entry"][class*="price"]',
      '[class*="open"][class*="price"]'
    ].join(', ')
  );
  if (entryNode && entryPrice === null) {
    const leaf = getValueLeafInContainer(entryNode);
    const v = leaf?.value ?? getNumericValueFromContainer(entryNode);
    if (Number.isFinite(v)) entryPrice = v;
  }
  const currentNode = row.querySelector?.(
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
    ].join(', ')
  );
  if (currentNode && currentPrice === null) {
    const leaf = getValueLeafInContainer(currentNode);
    const v = leaf?.value ?? getNumericValueFromContainer(currentNode);
    if (Number.isFinite(v)) currentPrice = v;
  }

  const exactFields = detectTradeFieldElements(row);
  // For each field we have a container (from context/keywords, no platform attr assumed). Drill to value leaf.
  if (stopLoss === null && exactFields.stopLoss) {
    const leaf = getValueLeafInContainer(exactFields.stopLoss);
    const v = leaf?.value ?? parseNumericText(exactFields.stopLoss.innerText || exactFields.stopLoss.textContent);
    if (Number.isFinite(v)) stopLoss = v;
  }
  if (takeProfit === null && exactFields.takeProfit) {
    const leaf = getValueLeafInContainer(exactFields.takeProfit);
    const v = leaf?.value ?? parseNumericText(exactFields.takeProfit.innerText || exactFields.takeProfit.textContent);
    if (Number.isFinite(v)) takeProfit = v;
  }
  if (entryPrice === null && exactFields.entryPrice) {
    const leaf = getValueLeafInContainer(exactFields.entryPrice);
    const v = leaf?.value ?? parseNumericText(exactFields.entryPrice.innerText || exactFields.entryPrice.textContent);
    if (Number.isFinite(v)) entryPrice = v;
  }
  if (currentPrice === null && exactFields.currentPrice) {
    const leaf = getValueLeafInContainer(exactFields.currentPrice);
    const v = leaf?.value ?? parseNumericText(exactFields.currentPrice.innerText || exactFields.currentPrice.textContent);
    if (Number.isFinite(v)) currentPrice = v;
  }
  if (profit === null && exactFields.profit) {
    const leaf = getValueLeafInContainer(exactFields.profit);
    const v = leaf?.value ?? parseNumericText(exactFields.profit.innerText || exactFields.profit.textContent);
    if (Number.isFinite(v)) profit = v;
  }

  const cells = row.querySelectorAll(
    'td, span, div, h5, p, b, strong, [data-testid], [data-index]'
  );
  cells.forEach((el) => {
    const text = (el.innerText || '').trim();
    if (!text) return;

    const context = (
      getElementContext(el) +
      ' ' +
      (el.getAttribute('aria-label') || '') +
      ' ' +
      (el.getAttribute('title') || '') +
      ' ' +
      (el.getAttribute('data-label') || '')
    ).toLowerCase();
    const direct = (
      (el.getAttribute('data-test') || '') +
      ' ' +
      (el.getAttribute('data-testid') || '') +
      ' ' +
      (el.getAttribute('data-index') || '') +
      ' ' +
      (el.className || '') +
      ' ' +
      (el.id || '')
    ).toLowerCase();

    const rawValue = text.replace(/[^0-9.-]/g, '');
    const num = parseFloat(rawValue);
    if (!Number.isFinite(num)) return;

    if (
      stopLoss === null &&
      TRADE_CONFIG.fields.stopLoss.some((k) => context.includes(k)) &&
      !/current|market|mark\b|entry|open/.test(context)
    ) {
      stopLoss = num;
    } else if (
      takeProfit === null &&
      TRADE_CONFIG.fields.takeProfit.some((k) => context.includes(k)) &&
      /\b(tp|take\s*profit|takeprofit|target)\b/i.test(direct) &&
      !/\b(current|currentprice|mark|markprice|market|entry|entryprice|open|openprice|sl|stoploss|stop\s*loss)\b/i.test(direct)
    ) {
      takeProfit = num;
    } else if (
      currentPrice === null &&
      TRADE_CONFIG.fields.currentPrice.some((k) => context.includes(k)) &&
      !/\b(tp|take\s*profit|takeprofit|sl|stop\s*loss|stoploss)\b/i.test(direct)
    ) {
      currentPrice = num;
    } else if (
      entryPrice === null &&
      TRADE_CONFIG.fields.entryPrice.some((k) => context.includes(k)) &&
      !/take|stop/.test(context)
    ) {
      entryPrice = num;
    } else if (
      profit === null &&
      (TRADE_CONFIG.fields.pnl.some((k) => context.includes(k)) || /^[+-]/.test(text))
    ) {
      profit = num;
    }
  });

  if (profit === null) {
    const detachedPnl = findDetachedPnlValue(row, scanRoot);
    if (Number.isFinite(detachedPnl)) profit = detachedPnl;
  }

  return { stopLoss, takeProfit, profit, entryPrice, currentPrice };
}

/**
 * Detect trade rows: elements (tr or div) that contain symbol + buy/sell.
 * Each trade includes stopLoss, takeProfit, and profit (floating P&L) from the row; updates with DOM.
 */
function detectTrades(root = document.body) {
  if (!root) return [];
  const preferredRoot = getPreferredTradesRoot(root);
  const strictPreferredMode =
    !!preferredPositionsSelector &&
    root === document.body &&
    preferredRoot &&
    preferredRoot !== document.body;
  const trades = [];
  const seen = new Set();

  const scanRows = (scanRoot) => {
    if (!scanRoot || typeof scanRoot.querySelectorAll !== 'function') return;
    const scopedRows = scanRoot.querySelectorAll(
      'tr[data-index], tr[data-row-expanded], tr, li, div[class*="row"], div[class*="position"], div[class*="trade"], div[class*="open"]'
    );
    scopedRows.forEach((node) => {
      if (!(node instanceof HTMLElement) || !node.isConnected) return;
      if (node.childElementCount > 50) return;

      const rect = node.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;

      const text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 2000) return;

      const lowerText = text.toLowerCase();
      const isTableRow = node.tagName === 'TR' || !!node.closest('table, [role="table"]');
      const hasFormControls = !!node.querySelector('input, select, textarea');
      if (isTableRow) {
        const tdCount = node.querySelectorAll('td').length;
        if (tdCount > 0 && tdCount < 3) return;
      }

      // Ignore rows that clearly represent closed/history/commission/swap entries (do not filter on 'profit' — many open rows show "Profit" as P&L label)
      if (
        lowerText.includes('closed') ||
        lowerText.includes('commission') ||
        lowerText.includes('swap')
      ) {
        return;
      }

      // Require at least one numeric value (volume/price) to consider this a live position row
      if (!/\b\d+(\.\d+)?\b/.test(text)) return;

      // Ignore pending rows (not active positions yet).
      // Do not exclude "order" globally since many platforms show "Order ID" in active positions.
      if (lowerText.includes('pending')) return;

      // Prefer rows with close/exit controls, but allow strong trade rows without explicit close control.
      const hasClose = rowHasCloseControl(node);
      const hasTradeFieldHint =
        /\b(sl|stop loss|tp|take profit|entry|open price|mark price|current|p&l|p\/l|pnl|profit)\b/i.test(lowerText);
      const orderPanelSignals =
        /\b(limit|market|maker|taker|quantity|available margin|funds|reduce only|bracket order|order value|best bid|best ask|payoff)\b/i.test(
          lowerText
        );
      const nonPositionWidgetSignals =
        /\b(rules for this trade|max allowed|risk per trade|status|calculator|trade\s*\d+)\b/i.test(lowerText);
      // Do not treat order-entry widgets as open positions.
      if (!hasClose && (hasFormControls || orderPanelSignals) && !isTableRow) return;
      if (!hasClose && nonPositionWidgetSignals && !isTableRow) return;
      if (!hasClose && !hasTradeFieldHint) return;

      const symbol = getBestSymbolFromText(text);
      if (!symbol) return;

      const side = detectSide(node, text) || 'UNKNOWN';

      const details = detectStopLossTakeProfitAndProfit(node, scanRoot);
      const exactFields = detectTradeFieldElements(node);

      let volume = null;
      const sizeNode = node.querySelector?.('[data-testid="size"], [data-index="size"]');
      if (sizeNode) {
        const m = (sizeNode.innerText || '').match(/[0-9.]+/);
        if (m) {
          const v = parseFloat(m[0]);
          if (Number.isFinite(v)) volume = v;
        }
      }
      if (volume === null) {
        const volumeNodes = node.querySelectorAll(
          '[data-testid*="size"], [data-testid*="volume"], [data-testid*="qty"], [data-testid*="quantity"], [data-testid*="lot"], [class*="size"], [class*="volume"], [class*="qty"], [class*="quantity"], [class*="lot"], [data-index*="size"], [data-index*="volume"]'
        );
        for (const el of volumeNodes) {
          if (!(el instanceof HTMLElement) || !el.isConnected) continue;
          const ctx = getElementContext(el);
          if (!/\b(volume|size|qty|quantity|lot|lots)\b/i.test(ctx)) continue;
          const parsed = parseNumericText(el.innerText || el.textContent || '');
          if (Number.isFinite(parsed) && parsed > 0 && parsed < 1000000) {
            volume = parsed;
            break;
          }
        }
      }

      const tdCount = node.querySelectorAll('td').length;
      const valueEvidence =
        (details.entryPrice != null ? 1 : 0) +
        (details.currentPrice != null ? 1 : 0) +
        (details.profit != null ? 1 : 0) +
        (volume != null ? 1 : 0);
      // Confidence gate: do not emit weakly-supported pseudo-rows.
      if (isTableRow) {
        if (tdCount > 0 && tdCount < 4) return;
        if (valueEvidence < 1) return;
      } else if (!hasClose || valueEvidence < 2) {
        return;
      }

      const key = `${symbol}-${side}-${volume ?? ''}`;
      if (seen.has(key)) return;
      seen.add(key);

      trades.push({
        symbol,
        side,
        volume,
        stopLoss: details.stopLoss,
        takeProfit: details.takeProfit,
        profit: details.profit,
        entryPrice: details.entryPrice ?? null,
        currentPrice: details.currentPrice ?? null,
        fieldIdentity: {
          scoped: {
            stopLoss: buildExactElementSelector(exactFields.stopLoss, node) || null,
            takeProfit: buildExactElementSelector(exactFields.takeProfit, node) || null,
            entryPrice: buildExactElementSelector(exactFields.entryPrice, node) || null,
            currentPrice: buildExactElementSelector(exactFields.currentPrice, node) || null,
            pnl: buildExactElementSelector(exactFields.profit, node) || null
          },
          absolute: {
            stopLoss: buildExactElementSelector(exactFields.stopLoss) || null,
            takeProfit: buildExactElementSelector(exactFields.takeProfit) || null,
            entryPrice: buildExactElementSelector(exactFields.entryPrice) || null,
            currentPrice: buildExactElementSelector(exactFields.currentPrice) || null,
            pnl: buildExactElementSelector(exactFields.profit) || null
          }
        },
        element: node
      });
    });
  };

  scanRows(preferredRoot || root);
  if (strictPreferredMode && trades.length > 0) {
    return trades;
  }
  if (trades.length === 0 && preferredRoot && preferredRoot !== root) {
    scanRows(root);
  }
  if (trades.length === 0 && root !== document.body) {
    scanRows(document.body);
  }

  return trades;
}

/**
 * BUY/SELL buttons: check text, class, aria-label, data attributes.
 */
function detectTradeButtons(root = document.body) {
  if (!root) return { buyButtons: [], sellButtons: [] };
  const candidates = root.querySelectorAll('button, [role="button"], [class*="button"], [class*="btn"], a[class*="trade"]');
  const buyButtons = [];
  const sellButtons = [];

  candidates.forEach((el) => {
    if (!(el instanceof HTMLElement) || !el.isConnected) return;
    if (el.disabled) return;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return;

    const text = (el.innerText || '').toLowerCase();
    const cls = (el.className || '').toLowerCase();
    const aria = (el.getAttribute('aria-label') || '').toLowerCase();
    const title = (el.getAttribute('title') || '').toLowerCase();
    const data = (el.getAttribute('data-side') || el.getAttribute('data-action') || '').toLowerCase();
    const combined = `${text} ${cls} ${aria} ${title} ${data}`;

    if (/\bbuy\b|long/.test(combined)) buyButtons.push(el);
    if (/\bsell\b|short/.test(combined)) sellButtons.push(el);
  });

  return { buyButtons, sellButtons };
}

/** True if the node contains a close/exit control (used to treat row as open position, not watchlist). */
function rowHasCloseControl(node) {
  if (!node || typeof node.querySelector !== 'function') return false;
  const candidates = node.querySelectorAll(
    'button, [role="button"], [class*="close"], [title*="lose"], [aria-label*="lose"], [class*="exit"]'
  );
  for (const el of candidates) {
    if (!(el instanceof HTMLElement) || !el.isConnected) continue;
    const text = (el.innerText || '').trim();
    const aria = (el.getAttribute('aria-label') || '').toLowerCase();
    const title = (el.getAttribute('title') || '').toLowerCase();
    const cls = (el.className || '').toLowerCase();
    if (/\b(close|exit|flatten)\b/.test(`${text} ${aria} ${title} ${cls}`)) return true;
    if (text === '×' || text === 'X' || text === '✕') return true;
  }
  return false;
}

/**
 * Close buttons: Close, Close position, Exit, ×, X, and class/aria.
 */
function detectCloseButtons(root = document.body) {
  if (!root) return [];
  const candidates = root.querySelectorAll(
    'button, [role="button"], [class*="close"], [title*="lose"], [aria-label*="lose"], [class*="exit"]'
  );
  const results = [];

  candidates.forEach((el) => {
    if (!(el instanceof HTMLElement) || !el.isConnected) return;
    const text = (el.innerText || '').trim();
    const aria = (el.getAttribute('aria-label') || '').toLowerCase();
    const title = (el.getAttribute('title') || '').toLowerCase();
    const cls = (el.className || '').toLowerCase();

    if (/\b(close|exit|flatten)\b/.test(`${text} ${aria} ${title} ${cls}`)) {
      results.push(el);
    }
    if (text === '×' || text === 'X' || text === '✕') {
      results.push(el);
    }
  });

  return results;
}

function detectStopLossTakeProfit(row) {
  const r = detectStopLossTakeProfitAndProfit(row);
  return { stopLoss: r.stopLoss, takeProfit: r.takeProfit };
}

/**
 * Observe a positions container and run detectTrades only when the DOM changes.
 * Avoids scanning the entire page every 2s; updates instantly when trades change.
 */
function observeTrades(container, onTradesChanged) {
  if (!container) return null;

  const detector = window.TradeGuardX?.universalDetector;
  if (!detector || typeof detector.detectTrades !== 'function') return null;

  const observer = new MutationObserver(() => {
    const trades = detector.detectTrades(container);
    onTradesChanged(trades);
  });

  observer.observe(container, {
    childList: true,
    subtree: true,
    characterData: true
  });

  return observer;
}

/**
 * Try to read pending order from the DOM (order form / panel): lot size, SL, entry/current price.
 * Searches near nearElement (e.g. the Buy/Sell button) then falls back to root.
 * Returns { volume, stopLoss, entryPrice, currentPrice } with numbers or null where not found.
 */
function getPendingOrderFromDOM(root = document.body, nearElement = null) {
  const result = { volume: null, stopLoss: null, entryPrice: null, currentPrice: null };
  let searchRoot = root;
  if (nearElement && nearElement.closest) {
    const container =
      nearElement.closest('[class*="order"],[class*="trade"],[class*="form"],form,section,[class*="panel"],[class*="deal"]') ||
      nearElement.closest('div[class*="content"],div[class*="widget"]') ||
      nearElement.parentElement?.parentElement?.parentElement;
    if (container) searchRoot = container;
  }

  const inputs = searchRoot.querySelectorAll(
    'input[type="number"],input[type="text"][inputmode="decimal"],input[type="text"][inputmode="numeric"],[role="spinbutton"],input:not([type="submit"]):not([type="button"]):not([type="hidden"])'
  );

  const volumeLabels = /\b(volume|lot|size|amount|quantity|qty)\b/i;
  const slLabels = /\b(sl|s\/l|stop\s*loss|stoploss)\b/i;
  /* Avoid "price" so we don't match Take Profit Price; use entry|open|market|bid|ask for entry field */
  const entryLabels = /\b(entry|open|market|bid|ask)\b/i;
  const currentLabels = /\b(current|market|bid|ask)\b/i;

  function getLabel(el) {
    const id = (el.id || '').toLowerCase();
    const name = (el.getAttribute('name') || '').toLowerCase();
    const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
    const aria = (el.getAttribute('aria-label') || '').toLowerCase();
    const title = (el.getAttribute('title') || '').toLowerCase();
    const dataTest = (el.getAttribute('data-testid') || el.getAttribute('data-test') || '').toLowerCase();
    const prev = (el.previousElementSibling?.textContent || '').toLowerCase();
    const parent = (el.closest('label')?.textContent || el.parentElement?.innerText || '').toLowerCase();
    return `${id} ${name} ${placeholder} ${aria} ${title} ${dataTest} ${prev} ${parent}`;
  }

  function parseNum(el) {
    const raw = (el.value != null ? el.value : el.textContent || '').toString().trim().replace(/,/g, '');
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : null;
  }

  for (const el of inputs) {
    if (!(el instanceof HTMLElement) || !el.isConnected) continue;
    const label = getLabel(el);
    const num = parseNum(el);
    if (num == null) continue;

    if (volumeLabels.test(label) && num > 0 && num < 10000) {
      if (result.volume == null) result.volume = num;
    }
    if (slLabels.test(label) && num > 0) {
      if (result.stopLoss == null) result.stopLoss = num;
    }
    if (entryLabels.test(label) && num > 0) {
      if (result.entryPrice == null) result.entryPrice = num;
    }
    if (currentLabels.test(label) && num > 0) {
      if (result.currentPrice == null) result.currentPrice = num;
    }
  }

  // Fallback: read entry/current price from visible DOM (span/div), not just inputs
  const priceSelectors =
    '[data-test*="price"],[data-testid*="price"],[class*="price"],[class*="bid"],[class*="ask"],[class*="market"]';
  const priceCandidates = searchRoot.querySelectorAll(priceSelectors);
  for (const el of priceCandidates) {
    if (!(el instanceof HTMLElement) || !el.isConnected) continue;
    const attr = (
      (el.getAttribute('data-test') || '') +
      (el.getAttribute('data-testid') || '') +
      (el.className || '')
    ).toLowerCase();
    if (/\b(profit|pnl|p\/l|sl|tp|take|stop)\b/.test(attr)) continue;
    const text = (el.innerText || el.textContent || '').trim();
    const cleanText = text.replace(/[^0-9.-]/g, '');
    const val = parseFloat(cleanText);
    if (!Number.isFinite(val) || val <= 0) continue;
    const isCurrent = /\b(current|market|bid|ask)\b/.test(attr);
    if (result.entryPrice == null) result.entryPrice = val;
    if (result.currentPrice == null && isCurrent) result.currentPrice = val;
    if (result.entryPrice != null && result.currentPrice != null) break;
  }

  return result;
}

window.TradeGuardX = window.TradeGuardX || {};
window.TradeGuardX.universalDetector = {
  detectEquity,
  detectBalance,
  detectStopLossTakeProfit,
  detectStopLossTakeProfitAndProfit,
  detectTrades,
  detectTradeButtons,
  detectCloseButtons,
  observeTrades,
  getPendingOrderFromDOM,
  detectOrderDetailsIdentity,
  detectTradeFieldElements,
  getExactElementSelector(el, scope) {
    return buildExactElementSelector(el, scope);
  },
  getNumericValueFromContainer,
  getValueLeafInContainer,
  setPreferredPositionsSelector(selector) {
    preferredPositionsSelector = typeof selector === 'string' ? selector.trim() : null;
  },
  getPreferredPositionsSelector() {
    return preferredPositionsSelector;
  },
  normalizeSymbol,
  getBestSymbolFromText,
  getElementContext,
  TRADE_CONFIG,
  SYMBOL_REGEX,
  SIDE_REGEX,
  NUMBER_REGEX
};
