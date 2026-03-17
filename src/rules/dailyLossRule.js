/**
 * Daily loss guard for funded accounts.
 *
 * Input:
 * - accountState: { equity, balance, floatingLoss, startingEquity }
 * - config: { accountSize, dailyLossLimitPct, warningThresholdPct }
 *
 * Output:
 * - { decision: 'ALLOW' | 'WARN' | 'BLOCK' | 'CLOSE_TRADES', reason, metrics }
 */

export function evaluateDailyLossRule(accountState, config) {
  if (config && config.dailyLossRuleEnabled === false) {
    const startingEquity = Number(accountState?.startingEquity || config.accountSize || 0);
    return {
      decision: 'ALLOW',
      reason: 'Daily loss rule is disabled',
      metrics: {
        startingEquity,
        equity: accountState?.equity ?? null,
        floatingLoss: accountState?.floatingLoss ?? 0,
        dailyLossLimitAmount: 0,
        remainingLoss: null,
        lossPctOfLimit: null
      }
    };
  }

  const equity = Number(accountState?.equity || 0);
  const balance = Number(accountState?.balance || 0);
  const startingEquity = Number(accountState?.startingEquity || config.accountSize || 0);

  if (!startingEquity) {
    return {
      decision: 'ALLOW',
      reason: 'Starting equity not set',
      metrics: null
    };
  }

  const dailyLossLimitType = config.dailyLossLimitType === 'amount' ? 'amount' : 'percent';
  const dailyLossLimitPct = Number(config.dailyLossLimitPct || 0);
  const dailyLossLimitAmountConfig = Number(config.dailyLossLimitAmount || 0);
  const warningThresholdPct = Number(config.warningThresholdPct || 0);

  const effectiveEquity = equity || balance || startingEquity;
  const dailyLossLimitAmount =
    dailyLossLimitType === 'amount'
      ? dailyLossLimitAmountConfig
      : (dailyLossLimitPct / 100) * startingEquity;

  let floatingLoss = accountState?.floatingLoss;
  if (floatingLoss === undefined || floatingLoss === null) {
    const pnl = effectiveEquity - startingEquity;
    floatingLoss = pnl < 0 ? -pnl : 0;
  } else {
    floatingLoss = Number(floatingLoss || 0);
  }

  const remainingLoss = Math.max(0, dailyLossLimitAmount - floatingLoss);
  const lossPctOfLimit = dailyLossLimitAmount > 0 ? (floatingLoss / dailyLossLimitAmount) * 100 : 0;

  const metrics = {
    startingEquity,
    equity: effectiveEquity,
    floatingLoss,
    dailyLossLimitAmount,
    remainingLoss,
    lossPctOfLimit
  };

  if (!dailyLossLimitAmount) {
    return {
      decision: 'ALLOW',
      reason: 'Daily loss limit not configured',
      metrics
    };
  }

  if (floatingLoss >= dailyLossLimitAmount) {
    return {
      decision: 'BLOCK',
      reason: 'Daily loss limit reached. Further trading blocked.',
      metrics
    };
  }

  if (lossPctOfLimit >= warningThresholdPct) {
    return {
      decision: 'CLOSE_TRADES',
      reason: `Floating loss is above warning threshold (${warningThresholdPct}% of daily limit).`,
      metrics
    };
  }

  if (lossPctOfLimit >= Math.max(50, warningThresholdPct * 0.5)) {
    return {
      decision: 'WARN',
      reason: 'Floating loss is significant relative to your daily limit.',
      metrics
    };
  }

  return {
    decision: 'ALLOW',
    reason: 'Within daily loss limits',
    metrics
  };
}


