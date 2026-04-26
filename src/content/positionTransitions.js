/* global window */

/**
 * Pure position-transition evaluation:
 * derives opened/closed deltas and close/loss side-signal conditions.
 */

function evaluatePositionTransitions({
  previousPositions,
  nextPositions,
  lastPositionsCount,
  lastEquity,
  effectiveEquity,
  suppressPositionTransitions = false
} = {}) {
  const prev = Array.isArray(previousPositions) ? previousPositions : [];
  const next = Array.isArray(nextPositions) ? nextPositions : [];
  const positionsCount = next.length;

  if (suppressPositionTransitions) {
    return {
      positionsCount,
      shouldUpdateLastPositionsCount: false,
      sendClosedLossSignal: false,
      closedTrade: null,
      realizedDelta: null,
      syncClosedTradePnl: null,
      openedDelta: 0
    };
  }

  const hasPreviousCount = lastPositionsCount != null;
  const realizedDelta =
    lastEquity != null && effectiveEquity != null ? effectiveEquity - lastEquity : null;

  const wentDown = hasPreviousCount && positionsCount < lastPositionsCount;
  const wentUp = hasPreviousCount && positionsCount > lastPositionsCount;
  const sendClosedLossSignal =
    hasPreviousCount &&
    lastEquity != null &&
    effectiveEquity != null &&
    wentDown &&
    effectiveEquity < lastEquity;

  const findClosed = window.TradeGuardXPositionState?.findClosedPositions;
  const closed = typeof findClosed === 'function' ? findClosed(prev, next) : [];
  const hasClosedByDiff = closed.length > 0;

  let closedTrade = null;
  let syncClosedTradePnl = null;
  if (wentDown || hasClosedByDiff) {
    closedTrade = closed[0] || prev[0] || null;
    if (closedTrade) {
      const fallbackPnl = Number.isFinite(Number(closedTrade.profit)) ? Number(closedTrade.profit) : null;
      const deltaIsMeaningful = realizedDelta != null && Math.abs(realizedDelta) >= 0.01;
      const fallbackIsMeaningful = fallbackPnl != null && Math.abs(fallbackPnl) >= 0.01;
      // Equity-delta can transiently sign-flip on funded accounts while the
      // backend reconciliation of closedPnlToday lags the row disappearing.
      // When the row's own P&L column disagrees in sign with the delta, trust
      // the row — it's what the broker literally showed the user.
      const signsDisagree =
        deltaIsMeaningful &&
        fallbackIsMeaningful &&
        Math.sign(realizedDelta) !== Math.sign(fallbackPnl);
      if (signsDisagree) {
        syncClosedTradePnl = fallbackPnl;
      } else {
        syncClosedTradePnl = deltaIsMeaningful ? realizedDelta : fallbackPnl;
      }
    }
  }

  return {
    positionsCount,
    shouldUpdateLastPositionsCount: true,
    sendClosedLossSignal,
    closedTrade,
    realizedDelta,
    syncClosedTradePnl,
    openedDelta: wentUp ? positionsCount - lastPositionsCount : 0
  };
}

window.TradeGuardXPositionTransitions = {
  evaluatePositionTransitions
};

