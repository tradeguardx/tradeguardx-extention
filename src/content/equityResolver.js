/* global window */

/**
 * Equity resolver — picks between live (DOM-read) and funded (computed) equity.
 *
 * Live mode: returns DOM equity/balance untouched (existing behavior).
 *
 * Funded mode: computes equity from the account's recorded daily-starting balance
 * plus today's realized P&L plus the floating P&L of currently open positions.
 * Used for prop firm accounts whose trading panel doesn't expose balance/equity.
 *
 *   balance = dailyStartingBalance + Σ today_closed_pnl
 *   equity  = balance + Σ today_floating_pnl
 *
 * If required funded state is missing (e.g. extension hasn't synced yet, or
 * reconcile is pending), we return source='pending' so callers can gate rules
 * instead of firing with wrong numbers.
 */

(function registerEquityResolver() {
  function sumFloatingPnl(positions) {
    if (!Array.isArray(positions)) return 0;
    let sum = 0;
    for (const p of positions) {
      const v = p && typeof p.profit === 'number' ? p.profit : Number(p?.profit);
      if (Number.isFinite(v)) sum += v;
    }
    return sum;
  }

  /**
   * @param {object} args
   * @param {'live'|'funded'} args.equityMode
   * @param {number|null} args.domEquity
   * @param {number|null} args.domBalance
   * @param {object|null} args.fundedState  { dailyStartingBalance, dailyStartingEquity, lastDailyResetAt, lastReconciledAt }
   * @param {number}       args.closedPnlToday
   * @param {Array}        args.positions
   * @returns {{ equity: number|null, balance: number|null, startingEquity: number|null, floatingLoss: number, source: 'dom'|'computed'|'pending' }}
   */
  function resolveEquity({
    equityMode,
    domEquity,
    domBalance,
    fundedState,
    closedPnlToday,
    positions
  }) {
    if (equityMode !== 'funded') {
      const equity = domEquity;
      const balance = domBalance;
      const startingEquity = equity != null ? equity : balance;
      const floatingLoss =
        startingEquity != null && equity != null && equity < startingEquity
          ? startingEquity - equity
          : 0;
      return { equity, balance, startingEquity, floatingLoss, source: 'dom' };
    }

    // Funded mode: require a dailyStartingBalance to compute anything meaningful.
    const dailyStartingBalance = Number(fundedState?.dailyStartingBalance);
    if (!Number.isFinite(dailyStartingBalance) || dailyStartingBalance <= 0) {
      return { equity: null, balance: null, startingEquity: null, floatingLoss: 0, source: 'pending' };
    }

    const closed = Number.isFinite(closedPnlToday) ? closedPnlToday : 0;
    const floating = sumFloatingPnl(positions);
    const balance = dailyStartingBalance + closed;
    const equity = balance + floating;

    // Starting equity for daily-loss rules: defaults to the configured daily starting equity
    // (equity snapshot at reset), but fall back to the daily starting balance.
    const startingEquity = Number.isFinite(Number(fundedState?.dailyStartingEquity))
      ? Number(fundedState.dailyStartingEquity)
      : dailyStartingBalance;

    const floatingLoss = equity < startingEquity ? startingEquity - equity : 0;

    return { equity, balance, startingEquity, floatingLoss, source: 'computed' };
  }

  window.TradeGuardXEquityResolver = { resolveEquity, sumFloatingPnl };
})();
