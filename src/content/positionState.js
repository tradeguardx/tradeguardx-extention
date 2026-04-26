/* global window */

/**
 * Pure helpers for trade-position state transitions.
 * Keep this file side-effect free so behavior is easy to test/reason about.
 */

function _toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function _normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

function _hasMeaningfulSymbol(symbol) {
  const s = _normalizeSymbol(symbol);
  if (!s) return false;
  if (s === '-' || s === '—' || s === '--') return false;
  if (s === 'N/A' || s === 'NA' || s === 'NULL' || s === 'UNKNOWN') return false;
  return true;
}

function _hasMeaningfulSide(side) {
  const s = String(side || '').trim().toUpperCase();
  return s === 'BUY' || s === 'SELL' || s === 'LONG' || s === 'SHORT';
}

function isMeaningfulTrade(trade) {
  if (!trade || typeof trade !== 'object') return false;
  if (!_hasMeaningfulSymbol(trade.symbol)) return false;
  if (!_hasMeaningfulSide(trade.side)) return false;
  const volume = _toNumber(trade.volume);
  const entry = _toNumber(trade.entryPrice);
  const current = _toNumber(trade.currentPrice);
  const pnl = _toNumber(trade.profit);
  const sl = _toNumber(trade.stopLoss);
  const tp = _toNumber(trade.takeProfit);
  // Require at least one market value so we don't ingest shell/header/placeholder rows.
  return (
    (volume != null && volume > 0) ||
    entry != null ||
    current != null ||
    pnl != null ||
    sl != null ||
    tp != null
  );
}

function sanitizeTrades(trades) {
  if (!Array.isArray(trades)) return [];
  return trades.filter(isMeaningfulTrade);
}

function buildTradesDigest(trades) {
  const list = sanitizeTrades(trades);
  if (list.length === 0) return 'none';
  return list
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

function positionKey(pos) {
  if (!pos) return 'na';
  const symbol = (pos.symbol || '').toUpperCase();
  const side = (pos.side || '').toUpperCase();
  const entryNum = _toNumber(pos.entryPrice);
  const entry = entryNum == null ? '' : Number(entryNum.toFixed(6));
  // Do not include volume: partial closes / broker formatting changes can churn volume
  // and create false close/open transitions for the same live position.
  return [symbol, side, entry].join('|');
}

function findClosedPositions(previousPositions, currentPositions) {
  const prev = Array.isArray(previousPositions) ? previousPositions : [];
  const cur = Array.isArray(currentPositions) ? currentPositions : [];
  const currentCounts = new Map();
  cur.forEach((p) => {
    const key = positionKey(p);
    currentCounts.set(key, (currentCounts.get(key) || 0) + 1);
  });
  const closed = [];
  prev.forEach((p) => {
    const key = positionKey(p);
    const remaining = currentCounts.get(key) || 0;
    if (remaining > 0) {
      currentCounts.set(key, remaining - 1);
    } else {
      closed.push(p);
    }
  });
  return closed;
}

function stabilizeTrades(trades, accountPositions, state) {
  const list = sanitizeTrades(trades);
  const now = Date.now();
  const next = {
    emptyTradesStreak: Number(state?.emptyTradesStreak) || 0,
    lastNonEmptyTradesAt: Number(state?.lastNonEmptyTradesAt) || 0
  };
  if (list.length > 0) {
    next.emptyTradesStreak = 0;
    next.lastNonEmptyTradesAt = now;
    return { trades: list, state: next };
  }
  next.emptyTradesStreak += 1;
  const ageMs = now - (next.lastNonEmptyTradesAt || 0);
  if (
    next.emptyTradesStreak < 2 &&
    ageMs < 1200 &&
    Array.isArray(accountPositions) &&
    accountPositions.length > 0
  ) {
    return {
      trades: sanitizeTrades(accountPositions).map((p) => ({
        symbol: p.symbol,
        side: p.side,
        volume: p.volume,
        stopLoss: p.stopLoss,
        takeProfit: p.takeProfit,
        profit: p.profit,
        entryPrice: p.entryPrice,
        currentPrice: p.currentPrice
      })),
      state: next
    };
  }
  return { trades: [], state: next };
}

window.TradeGuardXPositionState = {
  buildTradesDigest,
  isMeaningfulTrade,
  sanitizeTrades,
  positionKey,
  findClosedPositions,
  stabilizeTrades
};

