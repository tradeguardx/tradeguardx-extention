/* global chrome */

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      resolve(response);
    });
  });
}

function startMappingOnActiveTab() {
  return new Promise((resolve) => {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const activeTab = tabs && tabs[0];
        if (!activeTab?.id) {
          resolve({ success: false, error: 'No active tab found' });
          return;
        }
        // Focus the tab first so the mapping overlay on the page is visible when it appears.
        chrome.tabs.update(activeTab.id, { active: true });
        // frameId: 0 restricts delivery to the top frame — without it, every frame with a
        // listener (after an allFrames injection) starts its own mapping overlay.
        chrome.tabs.sendMessage(activeTab.id, { type: 'TG_START_PLATFORM_MAPPING' }, { frameId: 0 }, (response) => {
          if (chrome.runtime?.lastError) {
            resolve({ success: false, error: chrome.runtime.lastError.message || 'Unable to reach tab' });
            return;
          }
          resolve(response && typeof response === 'object' ? response : { success: true });
        });
      });
    } catch (err) {
      resolve({ success: false, error: err?.message || 'Failed to start mapping' });
    }
  });
}

function getActiveTabInfo() {
  return new Promise((resolve) => {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const activeTab = tabs && tabs[0];
        if (!activeTab) {
          resolve({ host: null, tabId: null });
          return;
        }
        try {
          const host = activeTab.url ? new URL(activeTab.url).hostname : null;
          resolve({ host, tabId: activeTab.id || null });
        } catch (_err) {
          resolve({ host: null, tabId: activeTab.id || null });
        }
      });
    } catch (_err) {
      resolve({ host: null, tabId: null });
    }
  });
}

function formatCurrency(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '–';
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '–';
  return `${value.toFixed(2)}%`;
}

function setStatus(text, tone = 'neutral') {
  const el = document.getElementById('tg-status');
  const dot = document.getElementById('tg-status-dot');
  if (el) el.textContent = text;
  if (dot) {
    dot.classList.remove('tg-status-dot-ready', 'tg-status-dot-error');
    if (tone === 'error') dot.classList.add('tg-status-dot-error');
    else if (text && text !== 'Loading…') dot.classList.add('tg-status-dot-ready');
  }
}

function setMetricTone(tileEl, tone) {
  if (!tileEl) return;
  tileEl.classList.remove('tg-metric-profit', 'tg-metric-loss');
  if (tone === 'profit') tileEl.classList.add('tg-metric-profit');
  else if (tone === 'loss') tileEl.classList.add('tg-metric-loss');
}

function formatSignedCurrency(value) {
  if (value === null || value === undefined || Number.isNaN(value) || !Number.isFinite(value)) {
    return '–';
  }
  const abs = Math.abs(value);
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}$${formatCurrency(abs)}`;
}

function formatSignedPercent(value) {
  if (value === null || value === undefined || Number.isNaN(value) || !Number.isFinite(value)) {
    return '–';
  }
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${Math.abs(value).toFixed(2)}%`;
}

/**
 * Resolve the rule limit + the percent-of-baseline that produced it.
 * Handles both amount-based and percent-based rule configs.
 */
function resolveRuleLimit({ enabled, type, pct, amount, baseline }) {
  if (!enabled) return { amount: 0, pct: 0 };
  const base = Number(baseline) || 0;
  if (type === 'amount') {
    const amt = Number(amount) || 0;
    return { amount: amt, pct: base > 0 && amt > 0 ? (amt / base) * 100 : 0 };
  }
  const p = Number(pct) || 0;
  return { amount: base > 0 && p > 0 ? (p / 100) * base : 0, pct: p };
}

function renderMetrics(metrics, config, accountMode) {
  const totalPnlEl = document.getElementById('tg-total-pnl');
  const totalPnlCaptionEl = document.getElementById('tg-total-pnl-caption');
  const totalPnlTile = document.getElementById('tg-metric-total-pnl');
  const totalPnlLabelEl = totalPnlTile?.querySelector('.tg-metric-label') || null;
  const accountSizeEl = document.getElementById('tg-account-size');
  const accountSizeCaptionEl = document.getElementById('tg-account-size-caption');
  const accountSizeTile = accountSizeEl?.closest('.tg-metric') || null;
  const maxTotalLossEl = document.getElementById('tg-max-total-loss-limit');
  const maxTotalLossCaptionEl = document.getElementById('tg-max-total-loss-caption');
  const maxTotalLossTile = maxTotalLossEl?.closest('.tg-metric') || null;
  const dailyLossLimitEl = document.getElementById('tg-daily-loss-limit');
  const dailyLossCaptionEl = document.getElementById('tg-daily-loss-caption');
  const dailyLossTile = dailyLossLimitEl?.closest('.tg-metric') || null;
  const progressWrap = document.getElementById('tg-progress-wrap');
  const progressBar = document.getElementById('tg-progress-bar');

  if (accountSizeTile) accountSizeTile.classList.remove('tg-metric-warn');

  if (!metrics) {
    if (totalPnlLabelEl) totalPnlLabelEl.textContent = 'Total P&L';
    if (totalPnlEl) totalPnlEl.textContent = '–';
    if (totalPnlCaptionEl) totalPnlCaptionEl.textContent = '–';
    setMetricTone(totalPnlTile, null);
    if (accountSizeEl) accountSizeEl.textContent = '–';
    if (accountSizeCaptionEl) accountSizeCaptionEl.textContent = '–';
    if (maxTotalLossEl) maxTotalLossEl.textContent = '–';
    if (maxTotalLossCaptionEl) maxTotalLossCaptionEl.textContent = '–';
    if (dailyLossLimitEl) dailyLossLimitEl.textContent = '–';
    if (dailyLossCaptionEl) dailyLossCaptionEl.textContent = '–';
    if (progressWrap) progressWrap.style.display = 'none';
    return;
  }

  const startingEquity = Number(metrics.startingEquity) || 0;
  const equity = Number(metrics.equity) || 0;
  const floatingLoss = Number(metrics.floatingLoss) || 0;
  const configAccountSize = Number(config?.accountSize) || 0;
  // Account size: funded accounts use the server-enriched challenge size; live
  // accounts use the actual broker DOM balance (user-saved configAccountSize is
  // just a preference and often stale — preferring it here produced nonsense
  // "Total P&L" on live accounts where it was treated as a challenge baseline).
  const accountSize = accountMode === 'live'
    ? (startingEquity > 0 ? startingEquity : configAccountSize)
    : (configAccountSize > 0 ? configAccountSize : startingEquity);

  // Hero tile swaps label + meaning based on account mode:
  //  - funded: Total P&L (equity vs challenge starting balance)
  //  - live:   Balance / equity straight from the broker DOM (no reliable
  //            challenge baseline exists for live accounts).
  if (accountMode === 'live') {
    if (totalPnlLabelEl) totalPnlLabelEl.textContent = 'Balance';
    if (totalPnlEl) totalPnlEl.textContent = equity > 0 ? `$${formatCurrency(equity)}` : '–';
    if (totalPnlCaptionEl) {
      totalPnlCaptionEl.textContent = floatingLoss > 0
        ? `Floating −$${formatCurrency(floatingLoss)}`
        : 'Live account';
    }
    setMetricTone(totalPnlTile, floatingLoss > 0 ? 'loss' : null);
  } else {
    if (totalPnlLabelEl) totalPnlLabelEl.textContent = 'Total P&L';
    const totalPnl = equity && accountSize ? equity - accountSize : null;
    const totalPnlPct = totalPnl != null && accountSize > 0 ? (totalPnl / accountSize) * 100 : null;
    if (totalPnlEl) {
      totalPnlEl.textContent = totalPnl == null ? '–' : formatSignedCurrency(totalPnl);
    }
    if (totalPnlCaptionEl) {
      totalPnlCaptionEl.textContent = totalPnlPct == null ? '–' : formatSignedPercent(totalPnlPct);
    }
    setMetricTone(
      totalPnlTile,
      totalPnl == null ? null : totalPnl > 0 ? 'profit' : totalPnl < 0 ? 'loss' : null
    );
  }

  // Account size tile caption:
  //  - funded: daily start (from server-enriched state)
  //  - live: current broker balance (accountSize already reflects DOM here)
  if (accountSizeEl) accountSizeEl.textContent = accountSize > 0 ? `$${formatCurrency(accountSize)}` : '–';
  if (accountSizeCaptionEl) {
    if (
      accountMode === 'funded' &&
      startingEquity > 0 &&
      Math.abs(startingEquity - accountSize) >= 0.01
    ) {
      accountSizeCaptionEl.textContent = `Daily start $${formatCurrency(startingEquity)}`;
    } else if (equity > 0) {
      accountSizeCaptionEl.textContent = `Balance $${formatCurrency(equity)}`;
    } else {
      accountSizeCaptionEl.textContent = 'Starting balance';
    }
  }

  // Max total loss: show REMAINING drawdown capacity + remaining % of challenge size as caption.
  const maxTotal = resolveRuleLimit({
    enabled: config?.maxTotalLossEnabled === true,
    type: config?.maxTotalLossType,
    pct: config?.maxTotalLossPct,
    amount: config?.maxTotalLossAmount,
    baseline: accountSize
  });
  const currentTotalDrawdown =
    accountSize > 0 && equity > 0 ? Math.max(0, accountSize - equity) : 0;
  const maxTotalRemaining = Math.max(0, maxTotal.amount - currentTotalDrawdown);
  const maxTotalRemainingPct =
    accountSize > 0 && maxTotal.amount > 0 ? (maxTotalRemaining / accountSize) * 100 : 0;
  if (maxTotalLossEl) {
    maxTotalLossEl.textContent = maxTotal.amount > 0 ? `$${formatCurrency(maxTotalRemaining)}` : 'Off';
  }
  if (maxTotalLossCaptionEl) {
    maxTotalLossCaptionEl.textContent =
      maxTotal.amount > 0 ? `${maxTotalRemainingPct.toFixed(2)}% loss allowed` : 'Rule not enabled';
  }
  setMetricTone(maxTotalLossTile, maxTotal.amount > 0 && maxTotalRemaining <= 0 ? 'loss' : null);

  // Daily loss: show REMAINING daily capacity + remaining % of daily start as caption.
  // Percent rules resolve against today's starting balance so the headline scales
  // with the user-declared balance (same baseline the caption percentage uses).
  const dailyBaseline = startingEquity > 0 ? startingEquity : accountSize;
  const dailyRule = resolveRuleLimit({
    enabled: config?.dailyLossRuleEnabled !== false,
    type: config?.dailyLossLimitType,
    pct: config?.dailyLossLimitPct,
    amount: config?.dailyLossLimitAmount,
    baseline: dailyBaseline
  });
  const dailyLimitAmount =
    dailyRule.amount > 0 ? dailyRule.amount : Number(metrics.dailyLossLimitAmount) || 0;
  const dailyRemaining = Math.max(0, dailyLimitAmount - floatingLoss);
  const dailyRemainingPct =
    dailyBaseline > 0 && dailyLimitAmount > 0 ? (dailyRemaining / dailyBaseline) * 100 : 0;
  if (dailyLossLimitEl) {
    dailyLossLimitEl.textContent = dailyLimitAmount > 0 ? `$${formatCurrency(dailyRemaining)}` : 'Off';
  }
  if (dailyLossCaptionEl) {
    dailyLossCaptionEl.textContent =
      dailyLimitAmount > 0 ? `${dailyRemainingPct.toFixed(2)}% loss allowed` : 'Rule not configured';
  }
  setMetricTone(dailyLossTile, dailyLimitAmount > 0 && dailyRemaining <= 0 ? 'loss' : null);

  // Progress bar: today's loss vs daily limit.
  if (progressWrap && progressBar && dailyLimitAmount > 0) {
    progressWrap.style.display = '';
    const pct = Math.min(100, (floatingLoss / dailyLimitAmount) * 100);
    progressBar.style.width = `${pct}%`;
    progressWrap.classList.remove('tg-progress-warn', 'tg-progress-danger');
    if (pct >= 100) progressWrap.classList.add('tg-progress-danger');
    else if (pct >= 80) progressWrap.classList.add('tg-progress-warn');
  } else if (progressWrap) {
    progressWrap.style.display = 'none';
  }
}

function renderConfig(config) {
  if (!config) return;
  const dailyEnabledEl = document.getElementById('tg-input-daily-loss-enabled');
  const accountEl = document.getElementById('tg-input-account-size');
  const dailyTypeEl = document.getElementById('tg-input-daily-loss-type');
  const dailyEl = document.getElementById('tg-input-daily-loss');
  const dailyAmountEl = document.getElementById('tg-input-daily-loss-amount');
  const warnEl = document.getElementById('tg-input-warning-threshold');
  const hedgeEl = document.getElementById('tg-input-hedging-enabled');

  if (dailyEnabledEl) dailyEnabledEl.checked = config.dailyLossRuleEnabled !== false;
  if (accountEl) accountEl.value = config.accountSize ?? '';
  if (dailyTypeEl) dailyTypeEl.value = config.dailyLossLimitType === 'amount' ? 'amount' : 'percent';
  if (dailyEl) dailyEl.value = config.dailyLossLimitPct ?? '';
  if (dailyAmountEl) dailyAmountEl.value = config.dailyLossLimitAmount ?? '';
  if (warnEl) warnEl.value = config.warningThresholdPct ?? '';
  if (hedgeEl) hedgeEl.checked = config.hedgingEnabled !== false;

  const riskPerTradeEnabledEl = document.getElementById('tg-input-risk-per-trade-enabled');
  const riskPerTradePctEl = document.getElementById('tg-input-risk-per-trade-pct');
  if (riskPerTradeEnabledEl) riskPerTradeEnabledEl.checked = config.riskPerTradeEnabled === true;
  if (riskPerTradePctEl) riskPerTradePctEl.value = config.riskPerTradePercent ?? '';

  toggleDailyLossTypeVisibility(dailyTypeEl?.value);
  toggleTotalLossTypeVisibility(document.getElementById('tg-input-max-total-loss-type')?.value);

  const maxTotalEnabled = document.getElementById('tg-input-max-total-loss-enabled');
  const maxTotalType = document.getElementById('tg-input-max-total-loss-type');
  const maxTotalPct = document.getElementById('tg-input-max-total-loss-pct');
  const maxTotalAmount = document.getElementById('tg-input-max-total-loss-amount');
  if (maxTotalEnabled) maxTotalEnabled.checked = config.maxTotalLossEnabled === true;
  if (maxTotalType) maxTotalType.value = config.maxTotalLossType === 'amount' ? 'amount' : 'percent';
  if (maxTotalPct) maxTotalPct.value = config.maxTotalLossPct ?? '';
  if (maxTotalAmount) maxTotalAmount.value = config.maxTotalLossAmount ?? '';

  const maxStackEnabled = document.getElementById('tg-input-max-stacking-enabled');
  const maxStackTrades = document.getElementById('tg-input-max-stacking-trades');
  if (maxStackEnabled) maxStackEnabled.checked = config.maxStackingTradesEnabled === true;
  if (maxStackTrades) maxStackTrades.value = config.maxStackingTrades ?? '';

  const maxTradesEnabled = document.getElementById('tg-input-max-trades-per-day-enabled');
  const maxTradesPerDay = document.getElementById('tg-input-max-trades-per-day');
  if (maxTradesEnabled) maxTradesEnabled.checked = config.maxTradesPerDayEnabled === true;
  if (maxTradesPerDay) maxTradesPerDay.value = config.maxTradesPerDay ?? '';

  const closeDayEnabled = document.getElementById('tg-input-close-day-enabled');
  const closeDayCount = document.getElementById('tg-input-close-day-loss-count');
  if (closeDayEnabled) closeDayEnabled.checked = config.closeDayOnLossCountEnabled === true;
  if (closeDayCount) closeDayCount.value = config.closeDayOnLossCount ?? '';
}

function toggleDailyLossTypeVisibility(type) {
  const pctLabel = document.getElementById('tg-label-daily-loss-pct');
  const amountLabel = document.getElementById('tg-label-daily-loss-amount');
  if (!pctLabel || !amountLabel) return;
  if (type === 'amount') {
    pctLabel.classList.add('tg-field-hidden');
    amountLabel.classList.remove('tg-field-hidden');
  } else {
    pctLabel.classList.remove('tg-field-hidden');
    amountLabel.classList.add('tg-field-hidden');
  }
}

function toggleTotalLossTypeVisibility(type) {
  const pctLabel = document.getElementById('tg-label-total-loss-pct');
  const amountLabel = document.getElementById('tg-label-total-loss-amount');
  if (!pctLabel || !amountLabel) return;
  if (type === 'amount') {
    pctLabel.classList.add('tg-field-hidden');
    amountLabel.classList.remove('tg-field-hidden');
  } else {
    pctLabel.classList.remove('tg-field-hidden');
    amountLabel.classList.add('tg-field-hidden');
  }
}

function buildRuleFieldsForDisplay(template, instance) {
  const raw = Array.isArray(template?.definition?.fields) ? template.definition.fields : [];
  const cfg =
    instance?.config && typeof instance.config === 'object' && !Array.isArray(instance.config)
      ? instance.config
      : {};
  return raw.map((f) => ({
    ...f,
    displayValue: Object.prototype.hasOwnProperty.call(cfg, f.key) ? cfg[f.key] : f.value
  }));
}

function formatRuleFieldValue(field, value) {
  if (field.type === 'toggle') {
    return value === true || value === 'true' ? 'On' : 'Off';
  }
  if (value === '' || value == null) return '—';
  const s = String(value);
  const pre = field.prefix || '';
  const suf = field.suffix || '';
  return `${pre}${s}${suf}`;
}

/**
 * Rules tab: render user-service bundle (templates + instances) like the dashboard catalog.
 */
function renderRulesFromApi(rulesBundle) {
  const listEl = document.getElementById('tg-rules-list');
  const metaEl = document.getElementById('tg-rules-api-meta');
  if (!listEl) return;

  if (metaEl) {
    if (!rulesBundle || typeof rulesBundle !== 'object') {
      metaEl.innerHTML = `
        <div class="tg-rules-api-meta-inner tg-rules-api-meta-empty">
          No API snapshot yet. Close and reopen the popup, or wait a few seconds after linking — rules sync in the background.
        </div>
      `;
    } else {
      const plan = escapeHtml(rulesBundle.planSlug ?? '—');
      const maxR = rulesBundle.maxRules != null ? escapeHtml(String(rulesBundle.maxRules)) : '—';
      const tmpl = Array.isArray(rulesBundle.templates) ? rulesBundle.templates.length : 0;
      const inst = Array.isArray(rulesBundle.instances) ? rulesBundle.instances.length : 0;
      const enabled = Array.isArray(rulesBundle.instances)
        ? rulesBundle.instances.filter((i) => i.enabled !== false).length
        : 0;
      metaEl.innerHTML = `
        <div class="tg-rules-api-meta-inner">
          <div class="tg-rules-api-meta-row">
            <span class="tg-rules-api-meta-k">Plan</span>
            <span class="tg-rules-api-meta-v">${plan}</span>
          </div>
          <div class="tg-rules-api-meta-row">
            <span class="tg-rules-api-meta-k">Max rules</span>
            <span class="tg-rules-api-meta-v">${maxR}</span>
          </div>
          <div class="tg-rules-api-meta-row">
            <span class="tg-rules-api-meta-k">Catalog</span>
            <span class="tg-rules-api-meta-v">${tmpl} templates</span>
          </div>
          <div class="tg-rules-api-meta-row">
            <span class="tg-rules-api-meta-k">Saved</span>
            <span class="tg-rules-api-meta-v">${inst} instance(s) · ${enabled} enabled</span>
          </div>
        </div>
      `;
    }
  }

  listEl.innerHTML = '';

  if (!rulesBundle || !Array.isArray(rulesBundle.templates) || rulesBundle.templates.length === 0) {
    const li = document.createElement('li');
    li.className = 'tg-rule-item tg-rule-item-empty';
    li.textContent = 'When the API returns templates, each rule appears here with slug, saved state, and field values.';
    listEl.appendChild(li);
    return;
  }

  const instanceBySlug = new Map(
    (Array.isArray(rulesBundle.instances) ? rulesBundle.instances : []).map((i) => [
      i.templateSlug,
      i
    ])
  );

  const sorted = [...rulesBundle.templates].sort(
    (a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0) || String(a.slug).localeCompare(String(b.slug))
  );

  sorted.forEach((t) => {
    const slug = t.slug || '—';
    const inst = instanceBySlug.get(slug);
    const hasSaved = Boolean(inst);
    const eligible = t.eligible !== false;

    let statusClass = 'tg-rule-api-badge-muted';
    let statusLabel = 'Not saved';
    if (!eligible) {
      statusClass = 'tg-rule-api-badge-locked';
      statusLabel = 'Plan';
    } else if (hasSaved) {
      statusClass = inst.enabled !== false ? 'tg-rule-api-badge-on' : 'tg-rule-api-badge-off';
      statusLabel = inst.enabled !== false ? 'Saved · on' : 'Saved · off';
    }

    const fields = buildRuleFieldsForDisplay(t, inst);
    const fieldsHtml = fields.length
      ? fields
          .map((f) => {
            const v = formatRuleFieldValue(f, f.displayValue);
            return `<div class="tg-rule-api-field"><span class="tg-rule-api-field-k">${escapeHtml(f.label || f.key)}</span><span class="tg-rule-api-field-v">${escapeHtml(v)}</span></div>`;
          })
          .join('')
      : '<div class="tg-rule-api-field tg-rule-api-field-note">No fields in template definition</div>';

    const li = document.createElement('li');
    li.className = 'tg-rule-item tg-rule-api-card';
    li.innerHTML = `
      <div class="tg-rule-api-card-top">
        <div class="tg-rule-api-card-titles">
          <div class="tg-rule-item-title">${escapeHtml(t.name || slug)}</div>
          <div class="tg-rule-api-slug">${escapeHtml(slug)}</div>
        </div>
        <span class="tg-rule-api-badge ${statusClass}">${escapeHtml(statusLabel)}</span>
      </div>
      <div class="tg-rule-item-desc">${escapeHtml(t.description || '')}</div>
      <div class="tg-rule-api-fields">${fieldsHtml}</div>
    `;
    listEl.appendChild(li);
  });
}

function renderSession(session) {
  const tradesEl = document.getElementById('tg-trades-opened-today');
  const lossEl = document.getElementById('tg-session-loss-count');
  if (tradesEl) tradesEl.textContent = session?.tradesOpenedToday ?? '–';
  if (lossEl) lossEl.textContent = session?.sessionLossCount ?? '–';
}

function renderOverviewTradeSummary(activeTrades, lastTrade) {
  const el = document.getElementById('tg-overview-trade-summary');
  if (!el) return;

  const count = Array.isArray(activeTrades) ? activeTrades.length : 0;
  if (count === 0) {
    el.className = 'tg-overview-trade-summary';
    el.innerHTML =
      'No open positions. Check the <button type="button" class="tg-inline-link" id="tg-goto-trades">Trades</button> tab when you have a position.';
    const btn = document.getElementById('tg-goto-trades');
    if (btn) btn.addEventListener('click', () => switchToPanel('trades'));
    return;
  }

  el.classList.add('tg-has-positions');
  const t = lastTrade || (activeTrades && activeTrades[0]);
  const symbol = t?.symbol || '?';
  const side = t?.side || '?';
  const pnl = t?.profit != null && Number.isFinite(Number(t.profit)) ? String(t.profit) : '–';
  const line =
    count === 1
      ? `${symbol} ${side} · P&L ${pnl}`
      : `${count} positions · Latest: ${symbol} ${side} · P&L ${pnl}`;
  el.innerHTML = `${line} — <button type="button" class="tg-inline-link" id="tg-goto-trades">View in Trades</button>`;
  const gotoBtn = document.getElementById('tg-goto-trades');
  if (gotoBtn) gotoBtn.addEventListener('click', () => switchToPanel('trades'));
}

/**
 * Compute trade risk ($) and status for one position (same logic as single-trade block).
 */
function getTradeRiskAndStatus(pos, balance, riskPercent) {
  const slSet = pos.stopLoss != null && Number(pos.stopLoss) > 0;
  const entry = pos.entryPrice ?? pos.currentPrice;
  const sl = pos.stopLoss;
  const vol = pos.volume ?? pos.size;
  let tradeRisk = null;
  if (slSet && entry != null && sl != null && vol != null) {
    tradeRisk = Math.abs(entry - sl) * vol;
  }
  const maxRisk = balance != null && Number.isFinite(riskPercent)
    ? balance * (riskPercent / 100)
    : null;
  let statusText = '–';
  let statusOver = false;
  if (tradeRisk != null && maxRisk != null) {
    if (tradeRisk > maxRisk) {
      statusText = 'OVER RISK ⚠️';
      statusOver = true;
    } else {
      statusText = 'SAFE';
    }
  } else if (slSet && (entry == null || vol == null)) {
    statusText = 'Entry/size not detected';
  } else if (!slSet && pos.symbol) {
    statusText = 'Set SL to see';
  }
  return { tradeRisk, maxRisk, statusText, statusOver };
}

/**
 * Build rules list for one trade: what is followed vs not (for display in each card).
 */
function getRulesForTrade(pos, metrics, tradeRisk, maxRisk) {
  const slApplied = pos.stopLoss != null && Number(pos.stopLoss) > 0;
  const tpApplied = pos.takeProfit != null && Number(pos.takeProfit) > 0;
  const rules = [];

  if (metrics) {
    const withinLimit =
      metrics.dailyLossLimitAmount != null && metrics.floatingLoss != null
        ? metrics.floatingLoss < metrics.dailyLossLimitAmount
        : null;
    rules.push({
      name: 'Daily loss under limit',
      status:
        withinLimit == null
          ? { text: 'Unknown', cls: 'tg-trade-rule-status-warn' }
          : withinLimit
            ? { text: 'OK', cls: 'tg-trade-rule-status-ok' }
            : { text: 'At / over limit', cls: 'tg-trade-rule-status-bad' }
    });
  }

  rules.push({
    name: 'Stop loss applied',
    status: slApplied
      ? { text: 'OK', cls: 'tg-trade-rule-status-ok' }
      : { text: 'Not applied', cls: 'tg-trade-rule-status-bad' }
  });

  rules.push({
    name: 'Take profit applied',
    status: tpApplied
      ? { text: 'OK', cls: 'tg-trade-rule-status-ok' }
      : { text: 'Not applied', cls: 'tg-trade-rule-status-warn' }
  });

  if (tradeRisk != null && maxRisk != null) {
    rules.push({
      name: 'Risk per trade',
      status:
        tradeRisk <= maxRisk
          ? { text: 'OK', cls: 'tg-trade-rule-status-ok' }
          : { text: 'Over limit', cls: 'tg-trade-rule-status-bad' }
    });
  }

  return rules;
}

function renderPositionsList(activeTrades, metrics, config) {
  const listEl = document.getElementById('tg-positions-list');
  if (!listEl) return;

  const list = Array.isArray(activeTrades) ? activeTrades : [];
  listEl.innerHTML = '';

  if (list.length === 0) {
    const li = document.createElement('li');
    li.className = 'tg-position-card tg-position-card-empty';
    li.textContent = 'No open positions detected.';
    listEl.appendChild(li);
    return;
  }

  const balance = metrics?.equity ?? metrics?.startingEquity ?? config?.accountSize;
  const riskPercent = Number(config?.riskPerTradePercent) || 1;

  list.forEach((pos, index) => {
    const side = (pos.side || '').toUpperCase();
    const sideClass = side === 'BUY' ? 'tg-side-buy' : 'tg-side-sell';
    const volume = pos.volume ?? pos.size;
    const volumeStr = volume != null ? String(volume) : '–';
    const entry = pos.entryPrice ?? pos.entry;
    const current = pos.currentPrice ?? pos.current;
    const entryStr = entry != null && Number.isFinite(Number(entry)) ? String(entry) : '–';
    const currentStr = current != null && Number.isFinite(Number(current)) ? String(current) : '–';
    const slVal = pos.stopLoss != null && Number(pos.stopLoss) > 0 ? pos.stopLoss : null;
    const tpVal = pos.takeProfit != null && Number(pos.takeProfit) > 0 ? pos.takeProfit : null;
    const slStr = slVal != null ? String(slVal) : '0';
    const tpStr = tpVal != null ? String(tpVal) : '0';
    const profitVal = pos.profit;
    const profitStr =
      profitVal != null && Number.isFinite(Number(profitVal)) ? String(profitVal) : '–';
    const pnlClass =
      profitVal != null && Number.isFinite(Number(profitVal))
        ? Number(profitVal) >= 0
          ? 'tg-trade-profit'
          : 'tg-trade-loss'
        : '';

    const { tradeRisk, maxRisk, statusText, statusOver } = getTradeRiskAndStatus(
      pos,
      balance,
      riskPercent
    );
    const riskStr = tradeRisk != null ? `$${tradeRisk.toFixed(2)}` : '–';
    const maxRiskStr = maxRisk != null ? `$${maxRisk.toFixed(2)}` : '–';

    const rules = getRulesForTrade(pos, metrics, tradeRisk, maxRisk);
    const rulesHtml = rules
      .map(
        (r) =>
          `<li class="tg-trade-rule"><span class="tg-trade-rule-name">${escapeHtml(r.name)}</span><span class="${escapeHtml(r.status.cls)}">${escapeHtml(r.status.text)}</span></li>`
      )
      .join('');

    const li = document.createElement('li');
    li.className = 'tg-position-card tg-position-card-full';
    li.setAttribute('data-trade-index', String(index));
    li.innerHTML = `
      <button type="button" class="tg-position-card-toggle" aria-expanded="true" aria-controls="tg-trade-body-${index}">
        <span class="tg-position-card-toggle-label">Trade ${index + 1}</span>
        <span class="tg-position-card-toggle-summary">${escapeHtml(pos.symbol || '?')} ${escapeHtml(side)}</span>
        <span class="tg-position-card-chevron" aria-hidden="true"></span>
      </button>
      <div id="tg-trade-body-${index}" class="tg-position-card-body" role="region">
        <div class="tg-current-trade">
        <div class="tg-trade-row">
          <span class="tg-trade-label">Symbol</span>
          <span class="tg-trade-value">${escapeHtml(pos.symbol || '–')}</span>
        </div>
        <div class="tg-trade-row">
          <span class="tg-trade-label">Side</span>
          <span class="tg-trade-value tg-position-card-side ${sideClass}">${escapeHtml(side)}</span>
        </div>
        <div class="tg-trade-row">
          <span class="tg-trade-label">Size</span>
          <span class="tg-trade-value">${escapeHtml(volumeStr)}</span>
        </div>
        <div class="tg-trade-row">
          <span class="tg-trade-label">Entry</span>
          <span class="tg-trade-value">${escapeHtml(entryStr)}</span>
        </div>
        <div class="tg-trade-row">
          <span class="tg-trade-label">Current</span>
          <span class="tg-trade-value">${escapeHtml(currentStr)}</span>
        </div>
        <div class="tg-trade-row">
          <span class="tg-trade-label">Stop loss</span>
          <span class="tg-trade-value">${escapeHtml(slStr)}</span>
        </div>
        <div class="tg-trade-row">
          <span class="tg-trade-label">Take profit</span>
          <span class="tg-trade-value">${escapeHtml(tpStr)}</span>
        </div>
        <div class="tg-trade-row tg-trade-row-pnl ${pnlClass}">
          <span class="tg-trade-label">P&L</span>
          <span class="tg-trade-value">${escapeHtml(profitStr)}</span>
        </div>
        <div class="tg-trade-row">
          <span class="tg-trade-label">Risk</span>
          <span class="tg-trade-value">${escapeHtml(riskStr)}</span>
        </div>
        <div class="tg-trade-row">
          <span class="tg-trade-label">Max allowed</span>
          <span class="tg-trade-value">${escapeHtml(maxRiskStr)}</span>
        </div>
        <div class="tg-trade-row">
          <span class="tg-trade-label">Status</span>
          <span class="tg-trade-value${statusOver ? ' tg-trade-risk-over' : ''}">${escapeHtml(statusText)}</span>
        </div>
      </div>
        <div class="tg-trade-rules">
          <div class="tg-trade-rules-title">Rules for this trade</div>
          <ul class="tg-trade-rules-list">${rulesHtml}</ul>
        </div>
      </div>
    `;
    listEl.appendChild(li);
  });

  listEl.querySelectorAll('.tg-position-card-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.tg-position-card-full');
      const expanded = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', String(!expanded));
      card?.classList.toggle('tg-position-card-collapsed', expanded);
    });
  });
}

function escapeHtml(str) {
  if (str == null) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function switchToPanel(panelId) {
  const panels = ['overview', 'rules', 'trades'];
  panels.forEach((id) => {
    const tab = document.getElementById(`tg-tab-${id}`);
    const panel = document.getElementById(`tg-panel-${id}`);
    if (tab && panel) {
      const active = id === panelId;
      tab.classList.toggle('tg-tab-active', active);
      tab.setAttribute('aria-selected', active);
      panel.classList.toggle('tg-panel-active', active);
      panel.hidden = !active;
    }
  });
}

function setupTabs() {
  document.querySelectorAll('.tg-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const panelId = tab.getAttribute('data-panel');
      if (panelId) switchToPanel(panelId);
    });
  });
}

function renderTerminal(lastHooked) {
  const el = document.getElementById('tg-terminal');
  const pill = document.getElementById('tg-status-pill');
  if (!el) return;

  if (!lastHooked) {
    el.textContent = 'No active trading page detected.';
    el.classList.remove('tg-terminal-connected');
    if (pill) {
      pill.textContent = 'Idle';
      pill.classList.remove('tg-status-pill-active');
    }
    return;
  }

  let label = lastHooked.host || 'Unknown page';
  if (lastHooked.url) {
    try {
      const url = new URL(lastHooked.url);
      label = url.hostname;
    } catch (_e) {
      // fall back to host
    }
  }

  el.textContent = label;
  el.classList.add('tg-terminal-connected');
  if (pill) {
    pill.textContent = 'Active';
    pill.classList.add('tg-status-pill-active');
  }
}

async function refreshMappingDebugStatus() {
  const statusEl = document.getElementById('tg-mapping-debug-status');
  if (!statusEl) return;
  const { host } = await getActiveTabInfo();
  if (!host) {
    statusEl.textContent = 'Host: – | Mapping: unknown';
    return;
  }
  const selectors = await sendMessage({ type: 'TG_GET_SELECTORS', payload: { host } });
  const mapped = selectors?.mapping_complete === true;
  const source = selectors?.order_details_identity?.source || selectors?.order_profile?.source || 'n/a';
  statusEl.textContent = `Host: ${host} | Mapping: ${mapped ? 'complete' : 'missing'} | Source: ${source}`;
}

async function showSavedHostsSummary() {
  const outEl = document.getElementById('tg-mapping-debug-hosts');
  if (!outEl) return;
  try {
    const result = await chrome.storage.local.get(['tradeGuardXSelectors']);
    const all = result?.tradeGuardXSelectors || {};
    const hosts = Object.keys(all);
    if (hosts.length === 0) {
      outEl.textContent = 'Saved hosts: none';
      return;
    }
    const summary = hosts
      .slice(0, 8)
      .map((h) => `${h}${all[h]?.mapping_complete === true ? ' (mapped)' : ''}`)
      .join(', ');
    outEl.textContent =
      hosts.length > 8
        ? `Saved hosts (${hosts.length}): ${summary}, ...`
        : `Saved hosts (${hosts.length}): ${summary}`;
  } catch (_err) {
    outEl.textContent = 'Unable to read saved hosts';
  }
}

async function runMappingDiagnostics() {
  const outEl = document.getElementById('tg-mapping-diagnostics-output');
  if (!outEl) return;
  outEl.textContent = 'Running diagnostics...';
  try {
    const res = await sendMessage({ type: 'TG_DEBUG_MAPPING_DIAGNOSTICS' });
    if (!res?.success) {
      outEl.textContent = `Diagnostics failed: ${res?.error || 'unknown error'}`;
      return;
    }
    const frames = Array.isArray(res?.diagnostics?.frames) ? res.diagnostics.frames : [];
    const frameSummary = frames.map((f) => ({
      frameId: f.frameId,
      host: f.host,
      frameType: f.frameType,
      hasMonitorInstance: f.hasMonitorInstance,
      hasDetector: f.hasDetector,
      hasOverlay: f.hasOverlay,
      mappingSessionActive: f.mappingSessionActive,
      requiresMapping: f.requiresMapping,
      mappedMode: f.mappedMode
    }));
    outEl.textContent = JSON.stringify(
      {
        tab: res?.diagnostics?.tab || null,
        directMessage: res?.diagnostics?.directMessage || null,
        frames: frameSummary
      },
      null,
      2
    );
  } catch (err) {
    outEl.textContent = `Diagnostics exception: ${err?.message || 'unknown error'}`;
  }
}

async function refreshPairingUi() {
  const st = await sendMessage({ type: 'TG_GET_PAIRING_STATE' });
  const elAccountId = document.getElementById('tg-pairing-account-id');
  if (elAccountId) elAccountId.textContent = st?.tradingAccountId || '–';

  const brokerHost = st?.brokerHost || null;
  const accountKind = st?.accountKind === 'funded' ? 'funded' : 'live';
  const mappingApproved = Boolean(st?.mappingApproved);
  const role = st?.role === 'admin' ? 'admin' : 'user';

  const hostEl = document.getElementById('tg-pairing-broker-host');
  if (hostEl) hostEl.textContent = brokerHost || '–';

  const kindEl = document.getElementById('tg-pairing-account-kind');
  if (kindEl) kindEl.textContent = accountKind;

  const mapStatusEl = document.getElementById('tg-pairing-mapping-status');
  if (mapStatusEl) {
    mapStatusEl.textContent = brokerHost
      ? mappingApproved
        ? `Mapping status: approved for ${accountKind}`
        : `Mapping status: not yet approved for ${accountKind}`
      : 'Mapping status: no broker host bound';
  }

  const { host: activeHost } = await getActiveTabInfo();
  const onCorrectHost = brokerHost && activeHost && activeHost.toLowerCase() === brokerHost.toLowerCase();

  const wrongHostEl = document.getElementById('tg-pairing-wrong-host');
  if (wrongHostEl) {
    if (brokerHost && !onCorrectHost) wrongHostEl.classList.remove('tg-field-hidden');
    else wrongHostEl.classList.add('tg-field-hidden');
  }

  const mapBtn = document.getElementById('tg-map-platform');
  const mapKindWrap = document.getElementById('tg-map-kind-wrap');
  const mapKindSelect = document.getElementById('tg-map-kind');

  const canMap = role === 'admin' && onCorrectHost && !mappingApproved;
  if (mapBtn) {
    if (role === 'admin') {
      mapBtn.classList.remove('tg-field-hidden');
      mapBtn.disabled = !onCorrectHost;
      mapBtn.title = onCorrectHost
        ? mappingApproved
          ? 'Mapping already approved — re-mapping will create a new pending draft'
          : 'Start field mapping on the current tab’s host'
        : 'Switch to the broker tab to map this host';
    } else {
      // Non-admins cannot map. Hide the button entirely.
      mapBtn.classList.add('tg-field-hidden');
    }
  }
  if (mapKindWrap) {
    if (role === 'admin' && onCorrectHost) {
      mapKindWrap.classList.remove('tg-field-hidden');
      if (mapKindSelect && !mapKindSelect.dataset.tgxKindBound) {
        mapKindSelect.value = accountKind;
      }
    } else {
      mapKindWrap.classList.add('tg-field-hidden');
    }
  }

  // Expose to mapping button handler via dataset for one-shot reads.
  const root = document.getElementById('tg-root');
  if (root) {
    root.dataset.tgxRole = role;
    root.dataset.tgxCanMap = canMap ? '1' : '0';
    root.dataset.tgxBrokerHost = brokerHost || '';
    root.dataset.tgxAccountKind = accountKind;
  }

  // Mapping debug panel is admin-only — it hosts Remap host / Diagnostics
  // which both can trigger the manual mapping overlay on the broker tab.
  const debugPanel = document.getElementById('tg-mapping-debug-panel');
  if (debugPanel) {
    if (role === 'admin') debugPanel.classList.remove('tg-field-hidden');
    else debugPanel.classList.add('tg-field-hidden');
  }
}

function formatFundedMoney(value, currency) {
  if (!Number.isFinite(value)) return '–';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency || 'USD',
      maximumFractionDigits: 2
    }).format(value);
  } catch (_e) {
    return `${currency || '$'}${value.toFixed(2)}`;
  }
}

async function refreshFundedSection() {
  const section = document.getElementById('tg-funded-section');
  if (!section) return;
  const resp = await sendMessage({ type: 'TG_GET_ACCOUNT_CONFIG' });
  const account = resp?.account || null;
  if (!account || account.equityMode !== 'funded') {
    section.classList.add('tg-field-hidden');
    return;
  }
  section.classList.remove('tg-field-hidden');
  const currency = account.currency || 'USD';
  const dailyStart = Number(account.dailyStartingBalance);
  const closedPnl = Number(resp?.closedPnlToday) || 0;
  const computed = Number.isFinite(dailyStart) ? dailyStart + closedPnl : NaN;

  const startEl = document.getElementById('tg-funded-daily-start');
  const computedEl = document.getElementById('tg-funded-computed');
  const closedPnlEl = document.getElementById('tg-funded-closed-pnl');
  const metaEl = document.getElementById('tg-funded-meta');
  const dashLink = document.getElementById('tg-funded-dashboard');

  if (startEl) startEl.textContent = formatFundedMoney(dailyStart, currency);
  if (computedEl) computedEl.textContent = formatFundedMoney(computed, currency);
  if (closedPnlEl) {
    const sign = closedPnl >= 0 ? '+' : '−';
    closedPnlEl.textContent = `${sign}${formatFundedMoney(Math.abs(closedPnl), currency)}`;
  }
  if (metaEl) {
    const firmName = account.propFirmName || account.propFirmSlug || 'Funded account';
    const lastRec = account.lastReconciledAt
      ? new Date(account.lastReconciledAt).toLocaleString()
      : 'never';
    metaEl.textContent = `${firmName} · last reconciled: ${lastRec}`;
  }
  if (dashLink) {
    if (account.dashboardUrl) {
      dashLink.href = account.dashboardUrl;
      dashLink.classList.remove('tg-field-hidden');
    } else {
      dashLink.classList.add('tg-field-hidden');
    }
  }
  // Stash for the adjust handler so it has fresh closedPnlToday context.
  section.dataset.tgxClosedPnl = String(closedPnl);
  section.dataset.tgxCurrency = currency;
}

function setupAdjustBalanceHandler() {
  const btn = document.getElementById('tg-adjust-balance');
  const form = document.getElementById('tg-adjust-balance-form');
  const cancel = document.getElementById('tg-adjust-balance-cancel');
  const input = document.getElementById('tg-adjust-balance-input');
  const errorEl = document.getElementById('tg-adjust-balance-error');
  const section = document.getElementById('tg-funded-section');
  if (!btn || !form || !input || btn.dataset.tgxBound === '1') return;
  btn.dataset.tgxBound = '1';

  const showError = (msg) => {
    if (!errorEl) return;
    errorEl.textContent = msg;
    errorEl.classList.remove('tg-field-hidden');
  };
  const hideError = () => {
    if (!errorEl) return;
    errorEl.classList.add('tg-field-hidden');
    errorEl.textContent = '';
  };
  const closeForm = () => {
    form.classList.add('tg-field-hidden');
    btn.classList.remove('tg-field-hidden');
    hideError();
    input.value = '';
  };

  btn.addEventListener('click', () => {
    btn.classList.add('tg-field-hidden');
    form.classList.remove('tg-field-hidden');
    hideError();
    input.focus();
  });
  if (cancel) cancel.addEventListener('click', closeForm);
  input.addEventListener('input', hideError);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const declaredBalance = Number(input.value.trim());
    if (!Number.isFinite(declaredBalance) || declaredBalance <= 0) {
      showError('Enter the balance shown on your prop firm dashboard.');
      input.focus();
      return;
    }
    const closedPnlToday = Number(section?.dataset.tgxClosedPnl);
    const payload = { declaredBalance };
    if (Number.isFinite(closedPnlToday)) payload.closedPnlToday = closedPnlToday;
    const resp = await sendMessage({ type: 'TG_RECONCILE_ACCOUNT', payload });
    if (!resp?.success) {
      showError(resp?.error || 'Could not save. Try again.');
      return;
    }
    closeForm();
    setStatus('Balance updated', 'neutral');
    refreshFundedSection();
  });
}

async function loadState(refreshOnly = false) {
  if (!refreshOnly) setStatus('Loading…', 'neutral');
  const [state, accountResp] = await Promise.all([
    sendMessage({ type: 'TG_GET_POPUP_STATE' }),
    sendMessage({ type: 'TG_GET_ACCOUNT_CONFIG' })
  ]);
  if (!state) {
    if (!refreshOnly) setStatus('Unable to load state', 'error');
    return;
  }

  const accountMode = accountResp?.account?.equityMode || null;
  renderMetrics(state.metrics, state.config, accountMode);
  if (!refreshOnly) renderConfig(state.config);
  renderRulesFromApi(state.rulesBundle);
  renderSession(state.session || {});
  renderOverviewTradeSummary(state.activeTrades, state.lastTrade);
  renderPositionsList(state.activeTrades, state.metrics, state.config);
  renderTerminal(state.lastHooked);
  await refreshPairingUi();
  await refreshFundedSection();

  if (!refreshOnly) setStatus('Ready', 'neutral');
}

/** Build config payload from current form values (for save and auto-save). */
function getConfigPayload() {
  const dailyEnabledEl = document.getElementById('tg-input-daily-loss-enabled');
  const hedgeEl = document.getElementById('tg-input-hedging-enabled');
  return {
    dailyLossRuleEnabled: dailyEnabledEl ? dailyEnabledEl.checked : true,
    accountSize: Number(document.getElementById('tg-input-account-size')?.value) || undefined,
    dailyLossLimitType:
      document.getElementById('tg-input-daily-loss-type')?.value === 'amount' ? 'amount' : 'percent',
    dailyLossLimitPct: Number(document.getElementById('tg-input-daily-loss')?.value) || undefined,
    dailyLossLimitAmount: Number(
      document.getElementById('tg-input-daily-loss-amount')?.value
    ) || undefined,
    warningThresholdPct: Number(
      document.getElementById('tg-input-warning-threshold')?.value
    ) || undefined,
    hedgingEnabled: hedgeEl ? hedgeEl.checked : true,
    riskPerTradeEnabled:
      document.getElementById('tg-input-risk-per-trade-enabled')?.checked === true,
    riskPerTradePercent:
      Number(document.getElementById('tg-input-risk-per-trade-pct')?.value) || undefined,
    maxTotalLossEnabled: document.getElementById('tg-input-max-total-loss-enabled')?.checked === true,
    maxTotalLossType:
      document.getElementById('tg-input-max-total-loss-type')?.value === 'amount'
        ? 'amount'
        : 'percent',
    maxTotalLossPct: Number(
      document.getElementById('tg-input-max-total-loss-pct')?.value
    ) || undefined,
    maxTotalLossAmount: Number(
      document.getElementById('tg-input-max-total-loss-amount')?.value
    ) || undefined,
    maxStackingTradesEnabled:
      document.getElementById('tg-input-max-stacking-enabled')?.checked === true,
    maxStackingTrades: Number(
      document.getElementById('tg-input-max-stacking-trades')?.value
    ) || undefined,
    maxTradesPerDayEnabled:
      document.getElementById('tg-input-max-trades-per-day-enabled')?.checked === true,
    maxTradesPerDay: Number(
      document.getElementById('tg-input-max-trades-per-day')?.value
    ) || undefined,
    closeDayOnLossCountEnabled:
      document.getElementById('tg-input-close-day-enabled')?.checked === true,
    closeDayOnLossCount: Number(
      document.getElementById('tg-input-close-day-loss-count')?.value
    ) || undefined
  };
}

/** Persist current form values to chrome.storage.local so config survives reload. */
async function saveConfigToStorage() {
  const payload = getConfigPayload();
  const result = await sendMessage({ type: 'TG_SAVE_CONFIG', payload });
  return result?.success === true;
}

/** Local rule form is hidden while linked; kept for future offline mode. */
function setupConfigForm() {
  const dailyTypeEl = document.getElementById('tg-input-daily-loss-type');
  const totalLossTypeEl = document.getElementById('tg-input-max-total-loss-type');
  if (dailyTypeEl) {
    dailyTypeEl.addEventListener('change', () => toggleDailyLossTypeVisibility(dailyTypeEl.value));
  }
  if (totalLossTypeEl) {
    totalLossTypeEl.addEventListener('change', () =>
      toggleTotalLossTypeVisibility(totalLossTypeEl.value)
    );
  }

  const form = document.getElementById('tg-config-form');
  if (!form) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setStatus('Saving…', 'neutral');
    const ok = await saveConfigToStorage();
    if (!ok) setStatus('Failed to save', 'error');
    else setStatus('Saved', 'neutral');
    loadState();
  });

  let autoSaveTimer = null;
  form.addEventListener('input', () => {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(async () => {
      await saveConfigToStorage();
      setStatus('Saved to storage', 'neutral');
    }, 600);
  });
  form.addEventListener('change', () => {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(async () => {
      await saveConfigToStorage();
      setStatus('Saved to storage', 'neutral');
    }, 400);
  });
}

let popupRefreshInterval = null;

function clearPopupRefreshInterval() {
  if (popupRefreshInterval != null) {
    clearInterval(popupRefreshInterval);
    popupRefreshInterval = null;
  }
}

function showPairingGate() {
  const gate = document.getElementById('tg-pairing-gate');
  const app = document.getElementById('tg-app');
  const root = document.getElementById('tg-root');
  clearPopupRefreshInterval();
  gate?.classList.remove('tg-field-hidden');
  app?.classList.add('tg-field-hidden');
  root?.classList.remove('tg-paired');
}

function showMainApp() {
  const gate = document.getElementById('tg-pairing-gate');
  const app = document.getElementById('tg-app');
  const root = document.getElementById('tg-root');
  gate?.classList.add('tg-field-hidden');
  app?.classList.remove('tg-field-hidden');
  root?.classList.add('tg-paired');
}

function setupPairingGateForm() {
  const submit = document.getElementById('tg-pairing-submit');
  const codeInput = document.getElementById('tg-pairing-code');
  const errEl = document.getElementById('tg-pairing-error');
  if (!submit || !codeInput || submit.dataset.tgxPairingBound === '1') return;
  submit.dataset.tgxPairingBound = '1';

  submit.addEventListener('click', async () => {
    const code = codeInput.value.trim();
    if (!code) {
      if (errEl) {
        errEl.textContent = 'Enter the code from the web app.';
        errEl.classList.remove('tg-field-hidden');
      }
      return;
    }
    if (errEl) errEl.classList.add('tg-field-hidden');
    setStatus('Linking…', 'neutral');
    const res = await sendMessage({ type: 'TG_PAIRING_EXCHANGE', payload: { code } });
    if (res?.success) {
      codeInput.value = '';
      if (res.rulesSync && res.rulesSync.success === false) {
        setStatus(`Linked (rules sync: ${res.rulesSync.error || 'skipped'})`, 'neutral');
      } else {
        setStatus('Linked — rules loaded from dashboard', 'neutral');
      }
      showMainApp();
      await initApp();
    } else {
      if (errEl) {
        errEl.textContent = res?.error || 'Pairing failed. Check the code and try again.';
        errEl.classList.remove('tg-field-hidden');
      }
      setStatus('Pairing failed', 'error');
    }
  });
}

function setupDisconnectHandler() {
  const disconnect = document.getElementById('tg-pairing-disconnect');
  if (!disconnect || disconnect.dataset.tgxDisconnectBound === '1') return;
  disconnect.dataset.tgxDisconnectBound = '1';
  disconnect.addEventListener('click', async () => {
    setStatus('Disconnecting…', 'neutral');
    await sendMessage({ type: 'TG_PAIRING_DISCONNECT' });
    setStatus('Disconnected', 'neutral');
    showPairingGate();
    const errEl = document.getElementById('tg-pairing-error');
    if (errEl) {
      errEl.classList.add('tg-field-hidden');
      errEl.textContent = '';
    }
  });
}

async function initApp() {
  const root = document.getElementById('tg-root');
  const wireMainUi = root?.dataset.tgxMainWired !== '1';
  if (wireMainUi) {
    if (root) root.dataset.tgxMainWired = '1';
    setupTabs();
    setupDisconnectHandler();
    setupAdjustBalanceHandler();
  }
  await sendMessage({ type: 'TG_SYNC_RULES_FROM_SERVER' });
  const mapBtn = document.getElementById('tg-map-platform');
  if (wireMainUi && mapBtn) {
    mapBtn.addEventListener('click', async () => {
      const root = document.getElementById('tg-root');
      if (root?.dataset.tgxRole !== 'admin') {
        setStatus('Only admins can map brokers', 'error');
        return;
      }
      if (root?.dataset.tgxCanMap !== '1') {
        setStatus('Switch to the bound broker tab before mapping', 'error');
        return;
      }
      const kindSelect = document.getElementById('tg-map-kind');
      const chosenKind = kindSelect?.value === 'funded' ? 'funded' : 'live';
      await sendMessage({
        type: 'TG_SET_PENDING_MAPPING_KIND',
        payload: { accountKind: chosenKind },
      });
      setStatus(`Starting mapping (${chosenKind})…`, 'neutral');
      let res = await startMappingOnActiveTab();
      // Fallback through background relay if direct tab message fails.
      if (!res?.success) {
        res = await sendMessage({ type: 'TG_START_PLATFORM_MAPPING' });
        if (!res?.success) {
          setStatus(res?.error || 'Failed to start mapping', 'error');
          return;
        }
      }
      setStatus('Look at the trading tab — mapping overlay is there', 'neutral');
      // Close popup so the user sees the tab with the mapping overlay.
      try {
        window.close();
      } catch (_) {}
    });
  }
  const remapBtn = document.getElementById('tg-remap-host');
  if (wireMainUi && remapBtn) {
    remapBtn.addEventListener('click', async () => {
      const root = document.getElementById('tg-root');
      if (root?.dataset.tgxRole !== 'admin') {
        setStatus('Only admins can remap brokers', 'error');
        return;
      }
      const kindSelect = document.getElementById('tg-map-kind');
      const chosenKind = kindSelect?.value === 'funded' ? 'funded' : 'live';
      await sendMessage({
        type: 'TG_SET_PENDING_MAPPING_KIND',
        payload: { accountKind: chosenKind },
      });
      setStatus(`Starting remap (${chosenKind})…`, 'neutral');
      let res = await startMappingOnActiveTab();
      if (!res?.success) {
        res = await sendMessage({ type: 'TG_START_PLATFORM_MAPPING' });
      }
      if (!res?.success) {
        setStatus(res?.error || 'Failed to start remap', 'error');
        return;
      }
      setStatus('Remap started on active tab', 'neutral');
      try {
        window.close();
      } catch (_) {}
    });
  }
  const showHostsBtn = document.getElementById('tg-show-saved-hosts');
  if (wireMainUi && showHostsBtn) {
    showHostsBtn.addEventListener('click', () => {
      showSavedHostsSummary();
    });
  }
  const runDiagBtn = document.getElementById('tg-run-mapping-diagnostics');
  if (wireMainUi && runDiagBtn) {
    runDiagBtn.addEventListener('click', () => {
      runMappingDiagnostics();
    });
  }
  const clearBtn = document.getElementById('tg-clear-state');
  if (wireMainUi && clearBtn) {
    clearBtn.addEventListener('click', async () => {
      const ok = await sendMessage({ type: 'TG_CLEAR_STATE' });
      if (ok?.success) {
        setStatus('State cleared', 'neutral');
        loadState();
      } else {
        setStatus('Failed to clear state', 'error');
      }
    });
  }
  loadState();
  refreshMappingDebugStatus();
  clearPopupRefreshInterval();
  popupRefreshInterval = setInterval(() => {
    const app = document.getElementById('tg-app');
    if (!app || app.classList.contains('tg-field-hidden')) return;
    loadState(true);
    refreshMappingDebugStatus();
  }, 2000);

  // Push-based refresh: background fires these after pairing exchange and
  // after refreshAccountConfig finishes. Without this the popup would only
  // pick up new account data on its 2s poll, and the form values that
  // loadState(true) skips wouldn't render until a hard refresh.
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage && !window.__tgxPopupListenerBound) {
    window.__tgxPopupListenerBound = true;
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === 'TG_PAIRING_CHANGED' || message?.type === 'TG_ACCOUNT_REFRESHED') {
        loadState();
        refreshMappingDebugStatus();
      }
      return undefined;
    });
  }
}

async function bootstrapPopup() {
  const st = await sendMessage({ type: 'TG_GET_PAIRING_STATE' });
  if (st?.connected) {
    showMainApp();
    await initApp();
  } else {
    showPairingGate();
    setupPairingGateForm();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  bootstrapPopup();
});

