/* global window */

/**
 * MappingStore helper for content-side selector shaping/merging.
 * Keep this focused on deterministic data transforms.
 */

const IDENTITY_FIELD_ALIASES = {
  pnl: 'pnl',
  profit: 'pnl',
  pl: 'pnl',
  closeButton: 'closeButton',
  close: 'closeButton',
  stopLoss: 'stopLoss',
  sl: 'stopLoss',
  takeProfit: 'takeProfit',
  tp: 'takeProfit',
  currentPrice: 'currentPrice',
  markPrice: 'currentPrice',
  entryPrice: 'entryPrice',
  openPrice: 'entryPrice',
  volume: 'volume',
  size: 'volume',
  qty: 'volume',
  side: 'side',
  symbol: 'symbol'
};

function getContainerSelector(selectors) {
  const s = selectors || {};
  const identity = s.order_details_identity || null;
  return (
    identity?.selector ||
    s.positions_table ||
    (identity?.fieldSelectors?.container ? identity.fieldSelectors.container : null)
  );
}

function getTradeTabSelectors(selectors) {
  const s = selectors || {};
  return {
    open: s.open_positions_tab || null,
    pending: s.pending_positions_tab || null,
    closed: s.closed_positions_tab || null
  };
}

function mergeOrderProfileFromIdentity({
  selectors,
  rowFieldKeys,
  host
} = {}) {
  const s = selectors || {};
  const identity = s.order_details_identity || null;
  if (!identity?.fieldSelectors || !Array.isArray(rowFieldKeys)) {
    return s.order_profile || null;
  }
  const rowFields = new Set(rowFieldKeys);
  const currentProfile = s.order_profile || {
    version: 1,
    host,
    strictMappedMode: true,
    rowSelector: null,
    rowSelectorHint: null,
    headerAliases: {},
    headerMap: {},
    fieldBindings: {},
    negativeRowPatterns: [],
    source: 'guided_mapping',
    lastVerifiedAt: Date.now()
  };
  const mergedBindings = { ...(currentProfile.fieldBindings || {}) };
  for (const [k, v] of Object.entries(identity.fieldSelectors)) {
    const key = IDENTITY_FIELD_ALIASES[k] || k;
    if (!rowFields.has(key) || !v || typeof v !== 'string') continue;
    if (!mergedBindings[key]?.selector) {
      mergedBindings[key] = { selector: v, confidence: 0.95, source: 'guided_mapping' };
    }
  }
  return {
    ...currentProfile,
    strictMappedMode: true,
    fieldBindings: mergedBindings,
    lastVerifiedAt: Date.now()
  };
}

window.TradeGuardXMappingStore = {
  getContainerSelector,
  getTradeTabSelectors,
  mergeOrderProfileFromIdentity
};

