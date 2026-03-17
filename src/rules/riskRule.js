/**
 * Risk-based rules:
 * - Max risk per trade (based on SL distance vs equity)
 * - Revenge trading protection (cooldown after X consecutive losses)
 */

export const riskRules = [
  {
    id: 'maxRiskPerTrade',
    displayName: 'Max Risk Per Trade',
    description: 'Blocks trades whose risk (distance to SL vs equity) exceeds configured percentage.',
    enabledByDefault: true,

    /**
     * ctx: { trade, accountState, config }
     */
    async evaluateTrade(ctx) {
      const { trade, accountState, config } = ctx;
      const equity = Number(accountState?.equity || 0);

      if (!equity || !config.maxRiskPerTradePct) {
        return { allowed: true };
      }

      const size = Number(trade.size || trade.volume || 0);
      const entryPrice = Number(trade.entryPrice || 0);
      const stopLossPrice = Number(trade.stopLossPrice || 0);

      if (!size || !entryPrice || !stopLossPrice) {
        // Not enough data to compute risk – be permissive in MVP.
        return { allowed: true };
      }

      const priceRisk = Math.abs(entryPrice - stopLossPrice);

      // Simplified risk model: riskAmount = price distance * size.
      // Real adapters can override by providing trade.riskAmount.
      const riskAmount = Number.isFinite(trade.riskAmount)
        ? Number(trade.riskAmount)
        : priceRisk * size;

      if (!riskAmount || riskAmount <= 0) {
        return { allowed: true };
      }

      const riskPct = (riskAmount / equity) * 100;

      if (riskPct > config.maxRiskPerTradePct) {
        return {
          allowed: false,
          message: `Trade risk (${riskPct.toFixed(
            2
          )}%) exceeds max allowed ${config.maxRiskPerTradePct}%.`
        };
      }

      return { allowed: true };
    }
  },
  {
    id: 'revengeTrading',
    displayName: 'Revenge Trading Protection',
    description: 'After X losing trades in a row, disables trading for a cooldown period.',
    enabledByDefault: true,

    /**
     * ctx: { accountState, config, now }
     *
     * Note: the loss streak and cooldown timestamps are maintained by the engine
     * via trade result events. This rule simply enforces the cooldown window.
     */
    async evaluateTrade(ctx) {
      const { accountState, config, now } = ctx;
      if (!config.revengeLossStreak || !config.revengeCooldownMinutes) {
        return { allowed: true };
      }

      const cooldownUntil = Number(accountState?.revengeCooldownUntil || 0);
      if (cooldownUntil && cooldownUntil > now) {
        const remainingMs = cooldownUntil - now;
        const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60000));
        return {
          allowed: false,
          message: `Trading disabled for cooldown after a loss streak. Try again in ~${remainingMinutes} minute(s).`
        };
      }

      return { allowed: true };
    }
  }
];

