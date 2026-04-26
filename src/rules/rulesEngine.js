import { evaluateDailyLossRule } from './dailyLossRule.js';
import {
  evaluateStackingRule,
  evaluateMaxTradesPerDayRule,
  evaluateMaxTotalLossRule,
  evaluateCloseDayOnLossCountRule
} from './sessionRules.js';

/**
 * RulesEngine evaluates daily loss, stacking, max trades per day, max total loss, and close day after N losses.
 */
export class RulesEngine {
  constructor(storage) {
    this.storage = storage;
  }

  /**
   * Evaluate the current account state against configured rules.
   *
   * accountState: {
   *   equity,
   *   balance,
   *   floatingLoss,
   *   startingEquity,
   *   positions
   * }
   */
  async evaluateAccount(accountState) {
    const config = await this.storage.getConfig();
    const state = await this.storage.getState();

    // Session rules (BLOCK takes precedence)
    const stackingResult = evaluateStackingRule(accountState.positions || [], config);
    if (stackingResult?.decision === 'BLOCK') {
      await this._persistLastState(accountState, null, stackingResult);
      return stackingResult;
    }

    const maxTradesResult = evaluateMaxTradesPerDayRule(state.tradesOpenedToday || 0, config);
    if (maxTradesResult?.decision === 'BLOCK') {
      await this._persistLastState(accountState, null, maxTradesResult);
      return maxTradesResult;
    }

    const totalLossResult = evaluateMaxTotalLossRule(accountState, config);
    if (totalLossResult?.decision === 'BLOCK') {
      await this._persistLastState(accountState, null, totalLossResult);
      return totalLossResult;
    }

    const closeDayResult = evaluateCloseDayOnLossCountRule(state.sessionLossCount || 0, config);
    if (closeDayResult?.decision === 'BLOCK') {
      await this._persistLastState(accountState, null, closeDayResult);
      return closeDayResult;
    }

    const result = evaluateDailyLossRule(accountState, config);
    await this._persistLastState(accountState, result.metrics, result);
    return result;
  }

  async _persistLastState(accountState, metrics, decision) {
    await this.storage.updateState((current) => ({
      ...current,
      lastAccountState: { ...(current.lastAccountState || {}), ...accountState },
      lastMetrics: metrics,
      lastDecision: decision
        ? { decision: decision.decision, reason: decision.reason, at: Date.now() }
        : current.lastDecision
    }));
  }

  /**
   * Data for popup: metrics + config + session state.
   */
  async getPopupState() {
    const [config, state, rulesBundle] = await Promise.all([
      this.storage.getConfig(),
      this.storage.getState(),
      this.storage.getRulesBundleCache()
    ]);
    const metrics = state.lastMetrics || null;

    let enrichedMetrics = metrics;
    if (!metrics && state.lastAccountState && config) {
      enrichedMetrics = evaluateDailyLossRule(state.lastAccountState, config).metrics;
    }

    const accountState = state.lastAccountState || {};
    const lastHooked = state.lastHooked || null;
    const activeTrades = Array.isArray(state.activeTrades) ? state.activeTrades : [];

    const dailyLimitAmount =
      config.dailyLossLimitType === 'amount'
        ? Number(config.dailyLossLimitAmount) || 0
        : config.accountSize && config.dailyLossLimitPct
          ? (config.accountSize * config.dailyLossLimitPct) / 100
          : 0;

    return {
      config,
      rulesBundle,
      metrics: enrichedMetrics || {
        startingEquity: config.accountSize,
        equity: accountState.equity || null,
        floatingLoss: accountState.floatingLoss || 0,
        dailyLossLimitAmount: dailyLimitAmount,
        remainingLoss: null,
        lossPctOfLimit: null
      },
      lastHooked,
      activeTrades,
      lastTrade: activeTrades[0] || null,
      session: {
        sessionDate: state.sessionDate || null,
        tradesOpenedToday: state.tradesOpenedToday ?? 0,
        sessionLossCount: state.sessionLossCount ?? 0
      }
    };
  }
}

