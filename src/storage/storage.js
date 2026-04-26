/* global chrome */

/**
 * Simple wrapper around chrome.storage.local with sane defaults for
 * Trade GuardX configuration and runtime state.
 */
export class Storage {
  constructor() {
    this.storage = chrome.storage?.local;
    this.STATE_KEY = 'tradeGuardXState';
    this.CLEAR_COOLDOWN_KEY = 'tradeGuardXClearCooldownUntil';
    this.CONFIG_KEY = 'tradeGuardXConfig';
    this.SELECTORS_KEY = 'tradeGuardXSelectors';
    /** Last successful GET /rules payload (for Rules tab UI). */
    this.RULES_BUNDLE_CACHE_KEY = 'tradeGuardXRulesBundleCache';
  }

  async _remove(key) {
    return new Promise((resolve) => {
      this.storage.remove(key, () => {
        if (chrome.runtime.lastError) console.warn(chrome.runtime.lastError);
        resolve();
      });
    });
  }

  async _get(key) {
    return new Promise((resolve) => {
      this.storage.get(key, (result) => {
        if (chrome.runtime.lastError) {
          // Fallback to empty on error – extension should keep working.
          resolve(undefined);
          return;
        }
        resolve(result[key]);
      });
    });
  }

  async _set(key, value) {
    return new Promise((resolve) => {
      this.storage.set({ [key]: value }, () => {
        // Ignore storage errors in MVP; log for debugging only.
        // eslint-disable-next-line no-console
        if (chrome.runtime.lastError) console.warn(chrome.runtime.lastError);
        resolve();
      });
    });
  }

  /**
   * Global runtime state for a single browser session.
   * Includes session counters: sessionDate (YYYY-MM-DD), tradesOpenedToday, sessionLossCount.
   */
  async getState() {
    const data = await this._get(this.STATE_KEY);
    return data || { accounts: {}, sessionDate: null, tradesOpenedToday: 0, sessionLossCount: 0 };
  }

  /** Ensure session counters are for today; reset if new day. */
  async _ensureSessionDate(state) {
    const today = new Date().toISOString().slice(0, 10);
    if (state.sessionDate === today) return state;
    return {
      ...state,
      sessionDate: today,
      tradesOpenedToday: 0,
      sessionLossCount: 0
    };
  }

  /** Increment trades opened today by 1 (legacy; prefer incrementTradesOpenedTodayBy when counting actual opens). */
  async incrementTradesOpenedToday() {
    return this.incrementTradesOpenedTodayBy(1);
  }

  /** Increment trades opened today by delta (call when new positions are detected on the page). */
  async incrementTradesOpenedTodayBy(delta) {
    if (!Number.isFinite(delta) || delta < 1) return (await this.getState())?.session;
    const state = await this.getState();
    const next = await this._ensureSessionDate(state);
    next.tradesOpenedToday = (next.tradesOpenedToday || 0) + Math.floor(delta);
    await this.setState(next);
    return next;
  }

  /** Increment session loss count (call when a position is closed at a loss). */
  async incrementSessionLossCount() {
    const state = await this.getState();
    const next = await this._ensureSessionDate(state);
    next.sessionLossCount = (next.sessionLossCount || 0) + 1;
    await this.setState(next);
    return next;
  }

  async setState(state) {
    await this._set(this.STATE_KEY, state);
  }

  /** Cooldown (ms) after clear during which no state updates are persisted. Survives service worker restart. */
  static get STATE_CLEAR_COOLDOWN_MS() {
    // Previously this was 5 minutes, which caused the popup UI (and other
    // state that depends on lastHooked / lastAccountState) to stay \"stuck\"
    // after a clear. We now disable the cooldown so state can start
    // repopulating immediately after TG_CLEAR_STATE is used.
    return 0;
  }

  /** Clear runtime state: delete the state key and start a cooldown so it is not recreated immediately. */
  async clearState() {
    await this._remove(this.STATE_KEY);
    await this._set(this.CLEAR_COOLDOWN_KEY, Date.now() + Storage.STATE_CLEAR_COOLDOWN_MS);
  }

  async updateState(updater) {
    const current = await this.getState();
    const cooldownUntil = await this._get(this.CLEAR_COOLDOWN_KEY);
    const inCooldown = cooldownUntil != null && Date.now() < cooldownUntil;
    if (inCooldown) {
      return current;
    }
    if (cooldownUntil != null) {
      await this._remove(this.CLEAR_COOLDOWN_KEY);
    }
    const next = typeof updater === 'function' ? updater(current) : { ...current, ...updater };
    await this.setState(next);
    return next;
  }

  /**
   * User configuration for risk thresholds and rule toggles.
   * Stored in chrome.storage.local so it persists across extension reloads and browser restarts.
   * Every rule can be enabled/disabled; when enabled, its parameters apply.
   *
   * Daily loss: dailyLossLimitType 'percent' | 'amount'; dailyLossLimitAmount used when type is 'amount'.
   * Total loss: maxTotalLossEnabled, maxTotalLossType 'percent'|'amount', maxTotalLossPct, maxTotalLossAmount.
   * Stacking: maxStackingTradesEnabled, maxStackingTrades.
   * Max trades/day: maxTradesPerDayEnabled, maxTradesPerDay.
   * Close day after N losses: closeDayOnLossCountEnabled, closeDayOnLossCount.
   */
  async getConfig() {
    const raw = await this._get(this.CONFIG_KEY);
    const defaults = {
      dailyLossRuleEnabled: true,
      accountSize: 50000,
      dailyLossLimitType: 'percent',
      dailyLossLimitPct: 5,
      dailyLossLimitAmount: 2500,
      warningThresholdPct: 80,
      hedgingEnabled: true,
      maxTotalLossEnabled: false,
      maxTotalLossType: 'percent',
      maxTotalLossPct: 10,
      maxTotalLossAmount: 5000,
      maxStackingTradesEnabled: false,
      maxStackingTrades: 5,
      maxTradesPerDayEnabled: false,
      maxTradesPerDay: 10,
      closeDayOnLossCountEnabled: false,
      closeDayOnLossCount: 2,
      riskPerTradeEnabled: false,
      riskPerTradePercent: 1,
      stopLossAlertEnabled: true,
      stopLossAlertDelaySeconds: 30,
      minimumHoldEnabled: false,
      minimumHoldMinutes: 3,
      minimumHoldPlatformOverrides: null,
      htfMinimumEnabled: false,
      htfMinimumChartMinutes: 60
    };
    return { ...defaults, ...(raw || {}) };
  }

  /** Persist config to chrome.storage.local (survives reload and browser restart). */
  async setConfig(config) {
    const current = await this.getConfig();
    await this._set(this.CONFIG_KEY, { ...current, ...config });
  }

  /**
   * Persist AI-discovered selectors keyed by hostname.
   *
   * Shape:
   * {
   *   [hostname]: {
   *     buy_button: string,
   *     sell_button: string,
   *     open_positions_tab: string,    // optional
   *     pending_positions_tab: string, // optional
   *     closed_positions_tab: string,  // optional
   *     order_instrument: string, // optional: order-ticket pair label (hedging symbol)
   *     close_button: string,
   *     equity: string,
   *     positions_table: string,
   *     closed_trades_section: string // optional: rows inside never counted as open positions
   *   }
   * }
   */
  async getSelectors() {
    const raw = await this._get(this.SELECTORS_KEY);
    return raw || {};
  }

  async setSelectors(allSelectors) {
    await this._set(this.SELECTORS_KEY, allSelectors || {});
  }

  async updateSelectorsForHost(hostname, selectors) {
    if (!hostname || !selectors) return;
    const current = await this.getSelectors();
    current[hostname] = { ...(current[hostname] || {}), ...selectors };
    await this.setSelectors(current);
  }

  /**
   * Initialize config on first install / update if not present.
   */
  async ensureDefaults() {
    const config = await this._get(this.CONFIG_KEY);
    if (!config) await this.setConfig({});
  }

  /** Cached rules API bundle: { planSlug, maxRules, templates[], instances[] } */
  async getRulesBundleCache() {
    const raw = await this._get(this.RULES_BUNDLE_CACHE_KEY);
    return raw && typeof raw === 'object' ? raw : null;
  }

  async setRulesBundleCache(bundle) {
    if (!bundle || typeof bundle !== 'object') return;
    await this._set(this.RULES_BUNDLE_CACHE_KEY, bundle);
  }

  async clearRulesBundleCache() {
    await this._remove(this.RULES_BUNDLE_CACHE_KEY);
  }
}
