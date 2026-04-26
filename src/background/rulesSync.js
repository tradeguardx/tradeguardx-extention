/**
 * Maps user-service GET /rules bundle (templates + instances) into extension storage config keys.
 *
 * Dashboard RulesTerminal treats a rule as configured only when `instances` has a row for that
 * template (`hasSavedInstance: Boolean(inst)`). Catalog `templates` alone are suggestions until saved.
 *
 * We mirror that: every sync first turns off all extension-mapped rule toggles, then applies only
 * rows from `instances` (using each row’s `enabled` flag). Slugs with no saved row do not run in
 * the extension, even if local storage still had older defaults enabled.
 *
 * Instance `config` is merged with the matching template’s `definition.fields` defaults so prompts
 * and timings match the dashboard/catalog when the API omits optional keys.
 */

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Dashboard stores daily loss as % of account and "warning" as % of account; extension uses
 * warningThresholdPct as % of the daily loss limit. Convert when warning looks like a fraction of limit.
 */
function mapWarningThreshold(dailyLossPct, warningPct) {
  const daily = num(dailyLossPct, 0);
  const w = num(warningPct, 80);
  if (!daily || !Number.isFinite(w)) return Math.min(100, w);
  if (w > daily * 2) return Math.min(100, w);
  return Math.min(100, Math.round((w / daily) * 1000) / 10);
}

/**
 * Merge saved instance config with template field defaults (same shape as RulesTerminal `buildFields`).
 * Instance values override template defaults.
 *
 * @param {object} bundle - API `data` from GET /rules (includes `templates`)
 * @param {string} templateSlug
 * @param {{ config?: object } | null | undefined} instanceRow
 */
function resolveInstanceConfig(bundle, templateSlug, instanceRow) {
  const templates = bundle?.templates;
  const template = Array.isArray(templates) ? templates.find((t) => t.slug === templateSlug) : null;
  const defaults = {};
  const fields = template?.definition?.fields;
  if (Array.isArray(fields)) {
    for (const f of fields) {
      if (f && typeof f.key === 'string' && Object.prototype.hasOwnProperty.call(f, 'value')) {
        defaults[f.key] = f.value;
      }
    }
  }
  const inst =
    instanceRow?.config && typeof instanceRow.config === 'object' && !Array.isArray(instanceRow.config)
      ? instanceRow.config
      : {};
  return { ...defaults, ...inst };
}

/** Must match template slugs we map — all off until an instance enables them. */
const RULE_TOGGLES_OFF = {
  dailyLossRuleEnabled: false,
  hedgingEnabled: false,
  riskPerTradeEnabled: false,
  maxTotalLossEnabled: false,
  maxStackingTradesEnabled: false,
  maxTradesPerDayEnabled: false,
  closeDayOnLossCountEnabled: false,
  minimumHoldEnabled: false,
  htfMinimumEnabled: false
};

/**
 * @param {object} bundle - API `data` from GET /rules
 * @returns {Record<string, unknown>} patch to merge: `storage.setConfig({ ...current, ...patch })`
 */
export function rulesBundleToExtensionConfigPatch(bundle) {
  const instances = bundle?.instances;
  const patch = { ...RULE_TOGGLES_OFF };

  if (!Array.isArray(instances) || instances.length === 0) {
    return {
      ...patch,
      stopLossAlertEnabled: true,
      stopLossAlertDelaySeconds: 30
    };
  }

  const bySlug = new Map(instances.map((i) => [i.templateSlug, i]));

  const dl = bySlug.get('daily-loss');
  if (dl) {
    patch.dailyLossRuleEnabled = dl.enabled !== false;
    const c = resolveInstanceConfig(bundle, 'daily-loss', dl);
    if (c.accountSize != null) patch.accountSize = num(c.accountSize, undefined);
    if (c.dailyLossPct != null) {
      patch.dailyLossLimitPct = num(c.dailyLossPct, 5);
      patch.dailyLossLimitType = 'percent';
    }
    if (c.warningPct != null) {
      patch.warningThresholdPct = mapWarningThreshold(
        c.dailyLossPct ?? patch.dailyLossLimitPct,
        c.warningPct
      );
    }
  }

  const hg = bySlug.get('hedging');
  if (hg) {
    const c = resolveInstanceConfig(bundle, 'hedging', hg);
    const toggle = Object.prototype.hasOwnProperty.call(c, 'enabled') ? c.enabled !== false : true;
    patch.hedgingEnabled = hg.enabled !== false && toggle;
  }

  const rt = bySlug.get('risk-per-trade');
  if (rt) {
    patch.riskPerTradeEnabled = rt.enabled !== false;
    const c = resolveInstanceConfig(bundle, 'risk-per-trade', rt);
    if (c.maxRiskPct != null) patch.riskPerTradePercent = num(c.maxRiskPct, 1);
  }

  const mt = bySlug.get('max-total-loss');
  if (mt) {
    patch.maxTotalLossEnabled = mt.enabled !== false;
    patch.maxTotalLossType = 'percent';
    const c = resolveInstanceConfig(bundle, 'max-total-loss', mt);
    if (c.maxDrawdownPct != null) patch.maxTotalLossPct = num(c.maxDrawdownPct, 10);
  }

  const st = bySlug.get('stacking');
  if (st) {
    patch.maxStackingTradesEnabled = st.enabled !== false;
    const c = resolveInstanceConfig(bundle, 'stacking', st);
    if (c.maxPositions != null) patch.maxStackingTrades = num(c.maxPositions, 5);
  }

  const mtd = bySlug.get('max-trades-day');
  if (mtd) {
    patch.maxTradesPerDayEnabled = mtd.enabled !== false;
    const c = resolveInstanceConfig(bundle, 'max-trades-day', mtd);
    if (c.maxTrades != null) patch.maxTradesPerDay = num(c.maxTrades, 10);
  }

  const cal = bySlug.get('close-after-losses');
  if (cal) {
    patch.closeDayOnLossCountEnabled = cal.enabled !== false;
    const c = resolveInstanceConfig(bundle, 'close-after-losses', cal);
    if (c.consecutiveLosses != null) patch.closeDayOnLossCount = num(c.consecutiveLosses, 2);
  }

  const sla = bySlug.get('stop-loss-alert');
  if (sla) {
    patch.stopLossAlertEnabled = sla.enabled !== false;
    const c = resolveInstanceConfig(bundle, 'stop-loss-alert', sla);
    // Catalog field: alertDelaySeconds (template default + instance override)
    patch.stopLossAlertDelaySeconds = Math.max(5, num(c.alertDelaySeconds, 30));
  } else {
    // No saved dashboard instance: keep SL reminders on by default (advisory)
    patch.stopLossAlertEnabled = true;
    patch.stopLossAlertDelaySeconds = 30;
  }

  const mh = bySlug.get('minimum-hold');
  if (mh) {
    patch.minimumHoldEnabled = mh.enabled !== false;
    const c = resolveInstanceConfig(bundle, 'minimum-hold', mh);
    if (c.minHoldMinutes != null) patch.minimumHoldMinutes = num(c.minHoldMinutes, 3);
    let overrides = null;
    if (typeof c.platformOverridesJson === 'string' && c.platformOverridesJson.trim()) {
      try {
        const parsed = JSON.parse(c.platformOverridesJson);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) overrides = parsed;
      } catch (_e) {
        overrides = null;
      }
    }
    patch.minimumHoldPlatformOverrides = overrides;
  }

  const htf = bySlug.get('htf-minimum');
  if (htf) {
    patch.htfMinimumEnabled = htf.enabled !== false;
    const c = resolveInstanceConfig(bundle, 'htf-minimum', htf);
    patch.htfMinimumChartMinutes = Math.max(1, num(c.minChartMinutes, 60));
  }

  return patch;
}
