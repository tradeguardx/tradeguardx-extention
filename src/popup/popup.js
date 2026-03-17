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
        chrome.tabs.sendMessage(activeTab.id, { type: 'TG_START_PLATFORM_MAPPING' }, (response) => {
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

function setAiKeyStatus(text, ok = false) {
  const el = document.getElementById('tg-ai-key-status');
  if (!el) return;
  el.textContent = text;
  el.style.color = ok ? '#4ade80' : '#94a3b8';
}

async function refreshAiKeyStatus() {
  const res = await sendMessage({ type: 'TG_GET_ANTHROPIC_API_KEY_STATUS' });
  if (res?.success && res.configured) {
    setAiKeyStatus('Key configured', true);
  } else {
    setAiKeyStatus('Key not configured', false);
  }
}

function renderMetrics(metrics) {
  const accountSizeEl = document.getElementById('tg-account-size');
  const equityEl = document.getElementById('tg-equity');
  const floatingLossEl = document.getElementById('tg-floating-loss');
  const dailyLimitEl = document.getElementById('tg-daily-limit');
  const remainingLossEl = document.getElementById('tg-remaining-loss');
  const progressWrap = document.getElementById('tg-progress-wrap');
  const progressBar = document.getElementById('tg-progress-bar');

  if (!metrics) {
    if (accountSizeEl) accountSizeEl.textContent = '–';
    if (equityEl) equityEl.textContent = '–';
    if (floatingLossEl) floatingLossEl.textContent = '–';
    if (dailyLimitEl) dailyLimitEl.textContent = '–';
    if (remainingLossEl) remainingLossEl.textContent = '–';
    if (progressWrap) progressWrap.style.display = 'none';
    return;
  }

  accountSizeEl.textContent = formatCurrency(metrics.startingEquity);
  equityEl.textContent = formatCurrency(metrics.equity);
  floatingLossEl.textContent = formatCurrency(metrics.floatingLoss);
  dailyLimitEl.textContent = `Limit: ${formatCurrency(metrics.dailyLossLimitAmount)}`;
  remainingLossEl.textContent = formatCurrency(metrics.remainingLoss);

  const limit = Number(metrics.dailyLossLimitAmount) || 0;
  const loss = Number(metrics.floatingLoss) || 0;
  if (progressWrap && progressBar && limit > 0) {
    progressWrap.style.display = '';
    const pct = Math.min(100, (loss / limit) * 100);
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

/**
 * Build the list of all configurable rules with current values.
 */
function renderRulesList(config, metrics) {
  const listEl = document.getElementById('tg-rules-list');
  if (!listEl) return;

  const c = config || {};
  const dailyLossOn = c.dailyLossRuleEnabled !== false;
  const accountSize = Number(c.accountSize) || 50000;
  const dailyType = c.dailyLossLimitType === 'amount' ? 'amount' : 'percent';
  const dailyPct = Number(c.dailyLossLimitPct) || 5;
  const dailyAmount = Number(c.dailyLossLimitAmount) || 2500;
  const warnPct = Number(c.warningThresholdPct) || 80;
  const hedgingOn = c.hedgingEnabled !== false;
  const dailyLimitAmount =
    dailyType === 'amount' ? dailyAmount : (accountSize * dailyPct) / 100;

  const rules = [
    {
      title: 'Daily loss protection',
      desc: 'Block new trades when floating loss reaches the daily limit; warn when loss reaches the warning % of that limit.',
      value: dailyLossOn
        ? `On — ${dailyType === 'amount' ? `Limit $${formatCurrency(dailyLimitAmount)}` : `Account $${formatCurrency(accountSize)}, limit ${dailyPct}%`}, warn at ${warnPct}%`
        : 'Off'
    },
    {
      title: 'Hedging prevention',
      desc: 'Block opening an opposite position on the same symbol (e.g. no Sell if you have an open Buy on that pair).',
      value: hedgingOn ? 'On' : 'Off'
    },
    {
      title: 'Risk per trade',
      desc: 'Block trades whose risk (|Entry − SL| × Volume) exceeds the configured % of balance; also block if lot size exceeds max allowed.',
      value:
        c.riskPerTradeEnabled === true
          ? `On — Max ${c.riskPerTradePercent ?? 1}% of balance per trade`
          : 'Off'
    },
    {
      title: 'Max total loss',
      desc: 'Block new trades when total loss from starting equity exceeds the configured amount or %.',
      value:
        c.maxTotalLossEnabled === true
          ? `On — ${c.maxTotalLossType === 'amount' ? `$${formatCurrency(c.maxTotalLossAmount)}` : `${c.maxTotalLossPct}%`}`
          : 'Off'
    },
    {
      title: 'Stacking (max open positions)',
      desc: 'Prompt/block when number of open positions reaches the limit.',
      value:
        c.maxStackingTradesEnabled === true
          ? `On — Max ${c.maxStackingTrades} positions`
          : 'Off'
    },
    {
      title: 'Max trades per day',
      desc: 'Block new trades after N trades opened today.',
      value:
        c.maxTradesPerDayEnabled === true
          ? `On — Max ${c.maxTradesPerDay} per day`
          : 'Off'
    },
    {
      title: 'Close day after N losses',
      desc: 'Block new trades after N closed losing trades today.',
      value:
        c.closeDayOnLossCountEnabled === true
          ? `On — After ${c.closeDayOnLossCount} loss(es)`
          : 'Off'
    }
  ];

  listEl.innerHTML = '';
  rules.forEach((rule) => {
    const li = document.createElement('li');
    li.className = 'tg-rule-item';
    li.innerHTML = `
      <div class="tg-rule-item-title">${rule.title}</div>
      <div class="tg-rule-item-desc">${rule.desc}</div>
      <div class="tg-rule-item-value">Current: ${rule.value}</div>
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

async function loadState(refreshOnly = false) {
  if (!refreshOnly) setStatus('Loading…', 'neutral');
  const state = await sendMessage({ type: 'TG_GET_POPUP_STATE' });
  if (!state) {
    if (!refreshOnly) setStatus('Unable to load state', 'error');
    return;
  }

  renderMetrics(state.metrics);
  if (!refreshOnly) renderConfig(state.config);
  renderRulesList(state.config, state.metrics);
  renderSession(state.session || {});
  renderOverviewTradeSummary(state.activeTrades, state.lastTrade);
  renderPositionsList(state.activeTrades, state.metrics, state.config);
  renderTerminal(state.lastHooked);

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

async function getAuthToken() {
  try {
    const result = await chrome.storage.local.get(['tgAuthToken']);
    return result.tgAuthToken || null;
  } catch (_e) {
    return null;
  }
}

async function setAuthToken(token) {
  await chrome.storage.local.set({ tgAuthToken: token });
}

function toggleAuthViews(isAuthed) {
  const authEl = document.getElementById('tg-auth');
  const appEl = document.getElementById('tg-app');
  if (authEl) authEl.hidden = !!isAuthed;
  if (appEl) appEl.hidden = !isAuthed;
}

function initApp() {
  setupTabs();
  setupConfigForm();
  const aiKeyInput = document.getElementById('tg-ai-api-key');
  const aiSaveBtn = document.getElementById('tg-ai-save-key');
  if (aiSaveBtn && aiKeyInput) {
    aiSaveBtn.addEventListener('click', async () => {
      const key = aiKeyInput.value?.trim();
      if (!key) {
        setStatus('Enter API key first', 'error');
        setAiKeyStatus('Key not configured', false);
        return;
      }
      setStatus('Saving API key…', 'neutral');
      const res = await sendMessage({ type: 'TG_SET_ANTHROPIC_API_KEY', payload: { apiKey: key } });
      if (!res?.success) {
        setStatus(res?.error || 'Failed to save API key', 'error');
        setAiKeyStatus('Key save failed', false);
        return;
      }
      aiKeyInput.value = '';
      setStatus('API key saved', 'neutral');
      setAiKeyStatus('Key configured', true);
    });
  }
  const mapBtn = document.getElementById('tg-map-platform');
  if (mapBtn) {
    mapBtn.addEventListener('click', async () => {
      setStatus('Starting mapping…', 'neutral');
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
  if (remapBtn) {
    remapBtn.addEventListener('click', async () => {
      setStatus('Starting remap…', 'neutral');
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
  if (showHostsBtn) {
    showHostsBtn.addEventListener('click', () => {
      showSavedHostsSummary();
    });
  }
  const runDiagBtn = document.getElementById('tg-run-mapping-diagnostics');
  if (runDiagBtn) {
    runDiagBtn.addEventListener('click', () => {
      runMappingDiagnostics();
    });
  }
  const clearBtn = document.getElementById('tg-clear-state');
  if (clearBtn) {
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
  refreshAiKeyStatus();
  setInterval(() => {
    loadState(true);
    refreshMappingDebugStatus();
  }, 2000);
}

document.addEventListener('DOMContentLoaded', async () => {
  const token = await getAuthToken();
  const isAuthed = !!token;
  toggleAuthViews(isAuthed);

  const loginGoogleBtn = document.getElementById('tg-login-google');
  if (loginGoogleBtn) {
    loginGoogleBtn.addEventListener('click', () => {
      chrome.tabs.create({
        url: 'https://tradeguardx.com/login?provider=google&source=extension'
      });
    });
  }

  const loginEmailBtn = document.getElementById('tg-login-email');
  if (loginEmailBtn) {
    loginEmailBtn.addEventListener('click', () => {
      chrome.tabs.create({
        url: 'https://tradeguardx.com/login?source=extension'
      });
    });
  }

  const skipBtn = document.getElementById('tg-auth-skip');
  if (skipBtn) {
    skipBtn.addEventListener('click', async () => {
      // For now, store a placeholder token so user can explore the UI.
      await setAuthToken('dev-placeholder-token');
      toggleAuthViews(true);
      initApp();
    });
  }

  const headerAuthBtn = document.getElementById('tg-auth-button');
  if (headerAuthBtn) {
    headerAuthBtn.addEventListener('click', () => {
      chrome.tabs.create({
        url: 'https://tradeguardx.com/login?source=extension'
      });
    });
  }

  if (isAuthed) {
    initApp();
  }
});

