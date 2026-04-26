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
      reason: `Position limit hit. You have ${count}/${max} open positions. Close one before opening another.`,
      ruleSlug: 'stacking'
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
      reason: `Trade limit hit. You've opened ${count}/${max} trades today. This one is blocked. Step away.`,
      ruleSlug: 'max-trades-day'
    };
  }
  return null;
}

/**
 * Block if total loss (from challenge starting balance) >= max total loss (amount or %).
 *
 * Baseline priority: config.accountSize (challenge size, server-enriched for funded accounts)
 * → accountState.startingEquity (daily start, or DOM-captured start for live). This ensures
 * funded accounts are measured against the immutable challenge balance, not the daily reset.
 */
export function evaluateMaxTotalLossRule(accountState, config) {
  if (!config || config.maxTotalLossEnabled !== true) return null;
  const baseline = Number(config.accountSize) || Number(accountState?.startingEquity) || 0;
  const equity = Number(accountState?.equity ?? accountState?.balance ?? 0);
  if (!baseline || !equity) return null;
  const totalLoss = baseline - equity;
  if (totalLoss <= 0) return null;

  const type = config.maxTotalLossType === 'amount' ? 'amount' : 'percent';
  if (type === 'amount') {
    const limit = Number(config.maxTotalLossAmount) || 0;
    if (limit > 0 && totalLoss >= limit) {
      return {
        decision: 'BLOCK',
        reason: `Max drawdown breached. Loss: $${totalLoss.toFixed(2)} exceeds your $${limit.toFixed(2)} limit. Stop trading immediately.`,
        ruleSlug: 'max-total-loss'
      };
    }
  } else {
    const limitPct = Number(config.maxTotalLossPct) || 0;
    if (limitPct > 0) {
      const pct = (totalLoss / baseline) * 100;
      if (pct >= limitPct) {
        return {
          decision: 'BLOCK',
          reason: `Max drawdown breached. Down ${pct.toFixed(1)}% from challenge balance (limit: ${limitPct}%). Stop trading immediately.`,
          ruleSlug: 'max-total-loss'
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
      reason: `Loss streak limit. ${count} consecutive losses hit your ${max}-loss safety rail. Next trade is blocked. Step away.`,
      ruleSlug: 'close-after-losses'
    };
  }
  return null;
}
