/* global window, document */

/**
 * PositionSource
 * Keeps "where trades come from" policy in one place:
 * 1) mapped OrderTableTracker first
 * 2) detector fallback when mapped source is empty/unavailable
 */

function getLiveTrades({
  detector,
  orderTracker,
  getTradesScanRoot,
  trackerEmptyStreak = 0,
  identityLocked = false
} = {}) {
  const sanitize = (rows) => {
    const helper = window.TradeGuardXPositionState;
    if (helper && typeof helper.sanitizeTrades === 'function') {
      return helper.sanitizeTrades(rows);
    }
    return Array.isArray(rows) ? rows : [];
  };

  const safeDetectTrades = () => {
    if (!detector || typeof detector.detectTrades !== 'function') return [];
    const root = typeof getTradesScanRoot === 'function' ? getTradesScanRoot() : document.body;
    return sanitize(detector.detectTrades(root || document.body));
  };

  if (orderTracker?.isBound?.() && typeof orderTracker.getTrades === 'function') {
    const tracked = sanitize(orderTracker.getTrades());
    if (tracked.length > 0) {
      return { trades: tracked, trackerEmptyStreak: 0, identityLocked };
    }
    const nextStreak = (Number(trackerEmptyStreak) || 0) + 1;
    const fallback = safeDetectTrades();
    if (fallback.length > 0) {
      return { trades: fallback, trackerEmptyStreak: 0, identityLocked };
    }
    return {
      trades: [],
      trackerEmptyStreak: nextStreak,
      identityLocked: nextStreak >= 4 ? false : identityLocked
    };
  }

  return {
    trades: safeDetectTrades(),
    trackerEmptyStreak,
    identityLocked
  };
}

function resolveObservationContainer({
  detector,
  resolveIdentityContainer,
  isMappedCrawlMode = false
} = {}) {
  let container = typeof resolveIdentityContainer === 'function' ? resolveIdentityContainer() : null;
  if (!container && isMappedCrawlMode) return null;
  if (!container && detector?.detectTrades) {
    const trades = detector.detectTrades(document.body);
    if (!trades.length) return null;
    container = trades[0].element?.closest('[class*="positions"],[class*="position"],[class*="trades"],table');
    if (!container) container = trades[0].element?.parentElement?.parentElement || null;
  }
  return container || null;
}

window.TradeGuardXPositionSource = {
  getLiveTrades,
  resolveObservationContainer
};

