/* global window */

/**
 * Mapping quality checks (read-only diagnostics).
 * Used to warn about brittle selectors without blocking runtime.
 */

function hasFragilePattern(selector) {
  const s = String(selector || '');
  return /:nth-of-type\(|:nth-child\(|> div:nth|> span:nth/i.test(s);
}

function assessSelectors(selectors) {
  const s = selectors && typeof selectors === 'object' ? selectors : {};
  const warnings = [];

  const positions = s.positions_table || s.order_details_identity?.selector || null;
  if (!positions) {
    warnings.push({
      code: 'missing_positions_table',
      severity: 'high',
      message: 'Positions container selector is missing.'
    });
  } else if (hasFragilePattern(positions)) {
    warnings.push({
      code: 'fragile_positions_table',
      severity: 'medium',
      message: 'Positions selector uses nth-*; may drift after layout updates.'
    });
  }

  const rowSel = s.order_profile?.rowSelector || null;
  if (rowSel && /portfolio_list_row_\d+/i.test(rowSel)) {
    warnings.push({
      code: 'dynamic_row_id',
      severity: 'medium',
      message: 'Row selector appears to contain a position id; prefer wildcard/prefix.'
    });
  }
  if (rowSel && hasFragilePattern(rowSel)) {
    warnings.push({
      code: 'fragile_row_selector',
      severity: 'low',
      message: 'Row selector uses nth-* and may be unstable.'
    });
  }

  const keys = [
    'buy_button',
    'sell_button',
    'close_button',
    'order_instrument',
    'open_positions_tab',
    'pending_positions_tab',
    'closed_positions_tab'
  ];
  keys.forEach((k) => {
    const v = s[k];
    if (!v) return;
    if (hasFragilePattern(v)) {
      warnings.push({
        code: `fragile_${k}`,
        severity: 'low',
        message: `${k} selector uses nth-* and may be brittle.`
      });
    }
  });

  if (s.closed_trades_section && positions && String(s.closed_trades_section).trim() === String(positions).trim()) {
    warnings.push({
      code: 'closed_equals_open',
      severity: 'high',
      message: 'closed_trades_section equals positions_table and can suppress all open rows.'
    });
  }

  return {
    ok: warnings.length === 0,
    warnings
  };
}

window.TradeGuardXMappingQuality = {
  assessSelectors
};

