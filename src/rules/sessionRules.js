/**
 * Session-based rules: stacking trades, max trades per day, max total loss, close day after N losses.
 * Each returns { decision, reason } or null (no block). BLOCK takes precedence.
 */

/**
 * Block if open positions count >= maxStackingTrades.
 */
export function evaluateStackingRule(positions = [], config) {
  if (!config || config.maxStackingTradesEnabled !== true) return null;
  const max = Number(config.maxStackingTrades) || 0;
  if (max <= 0) return null;
  const count = Array.isArray(positions) ? positions.length : 0;
  if (count >= max) {
    return {
      decision: 'BLOCK',
      reason: `Maximum open positions (${max}) reached. Close some trades before opening new ones.`
    };
  }
  return null;
}

/**
 * Block if trades opened today >= maxTradesPerDay.
 */
export function evaluateMaxTradesPerDayRule(tradesOpenedToday = 0, config) {
  if (!config || config.maxTradesPerDayEnabled !== true) return null;
  const max = Number(config.maxTradesPerDay) || 0;
  if (max <= 0) return null;
  const count = Number(tradesOpenedToday) || 0;
  if (count >= max) {
    return {
      decision: 'BLOCK',
      reason: `Maximum trades per day (${max}) reached. Trading blocked for today.`
    };
  }
  return null;
}

/**
 * Block if total loss (from starting equity) >= max total loss (amount or %).
 */
export function evaluateMaxTotalLossRule(accountState, config) {
  if (!config || config.maxTotalLossEnabled !== true) return null;
  const startingEquity = Number(accountState?.startingEquity || 0);
  const equity = Number(accountState?.equity ?? accountState?.balance ?? 0);
  if (!startingEquity || !equity) return null;
  const totalLoss = startingEquity - equity;
  if (totalLoss <= 0) return null;

  const type = config.maxTotalLossType === 'amount' ? 'amount' : 'percent';
  if (type === 'amount') {
    const limit = Number(config.maxTotalLossAmount) || 0;
    if (limit > 0 && totalLoss >= limit) {
      return {
        decision: 'BLOCK',
        reason: `Max total loss (${limit}) reached. No new trades until equity recovers.`
      };
    }
  } else {
    const limitPct = Number(config.maxTotalLossPct) || 0;
    if (limitPct > 0) {
      const pct = (totalLoss / startingEquity) * 100;
      if (pct >= limitPct) {
        return {
          decision: 'BLOCK',
          reason: `Max total loss (${limitPct}%) reached. No new trades until equity recovers.`
        };
      }
    }
  }
  return null;
}

/**
 * Block if session loss count (closed losing trades) >= closeDayOnLossCount.
 */
export function evaluateCloseDayOnLossCountRule(sessionLossCount = 0, config) {
  if (!config || config.closeDayOnLossCountEnabled !== true) return null;
  const max = Number(config.closeDayOnLossCount) || 0;
  if (max <= 0) return null;
  const count = Number(sessionLossCount) || 0;
  if (count >= max) {
    return {
      decision: 'BLOCK',
      reason: `Day closed after ${count} losing trade(s). No more trades today.`
    };
  }
  return null;
}
