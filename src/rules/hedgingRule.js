/**
 * Hedging prevention rule – blocks opening an opposite-side position on the same symbol.
 */

export const hedgingRules = [
  {
    id: 'hedgingPrevention',
    displayName: 'Hedging Prevention',
    description: 'Prevents opening an opposite-side position on the same symbol.',
    enabledByDefault: true,

    /**
     * Called for each trade attempt.
     * ctx: { trade, accountState }
     */
    async evaluateTrade(ctx) {
      const { trade, accountState } = ctx;
      const symbol = (trade.symbol || '').toString();
      const side = (trade.side || '').toUpperCase();

      if (!symbol || (side !== 'BUY' && side !== 'SELL')) {
        return { allowed: true };
      }

      const oppositeSide = side === 'BUY' ? 'SELL' : 'BUY';
      const openPositions = Array.isArray(accountState?.openPositions) ? accountState.openPositions : [];

      const hasOpposite = openPositions.some((pos) => {
        const posSymbol = (pos.symbol || '').toString();
        const posSide = (pos.side || '').toUpperCase();
        return posSymbol === symbol && posSide === oppositeSide;
      });

      if (hasOpposite) {
        return {
          allowed: false,
          message: `Hedging blocked: you already have a ${oppositeSide} position on ${symbol}.`
        };
      }

      return { allowed: true };
    }
  }
];

