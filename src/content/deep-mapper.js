/* global chrome */

/**
 * DeepMapper
 *
 * User can click broadly (cell/row/wrapper), then we extract rich table context,
 * ask Claude for exact selectors, and validate selectors against real DOM nodes.
 */
class DeepMapper {
  constructor({ onComplete, onError } = {}) {
    this.onComplete = onComplete || (() => {});
    this.onError = onError || (() => {});
  }

  async map(clickedEl, options = {}) {
    const manualSelections = options?.manualSelections || {};
    const context = this._extractDeepContext(clickedEl, manualSelections, options || {});
    if (!context) throw new Error('Could not find a trade table near the clicked element');

    const selectorMap = await this._askClaude(context);
    let validated = this._validateAndScore(selectorMap, context.rowEl);
    const failed = this._collectFailedSelectors(validated);

    if (failed.length > 0) {
      const fixedMap = await this._askClaudeFix(context, selectorMap, failed);
      const fixedValidated = this._validateAndScore(fixedMap, context.rowEl);
      validated = this._mergeValidated(validated, fixedValidated);
    }

    this.onComplete(validated);
    return validated;
  }

  _extractDeepContext(clickedEl, manualSelections = {}, options = {}) {
    const forcedRowEl =
      options?.forcedRowEl instanceof HTMLElement && options.forcedRowEl.isConnected
        ? options.forcedRowEl
        : null;
    const rowEl = forcedRowEl || this._findRowAncestor(clickedEl);
    if (!rowEl) return null;
    const broadContext = options?.broadContext === true;

    const tableEl =
      rowEl.closest('table') ||
      rowEl.closest('[role="table"]') ||
      rowEl.parentElement;

    const headerEl =
      tableEl?.querySelector('thead tr, thead, tr:first-child') ||
      this._findHeaderRow(tableEl);

    const maxRows = broadContext ? 8 : 3;
    const allRows = Array.from(tableEl?.querySelectorAll(this._guessRowSelector(rowEl)) || [])
      .filter((r) => r !== headerEl)
      .slice(0, maxRows);

    return {
      clickedEl,
      rowEl,
      tableEl,
      headerEl,
      allRows,
      broadContext,
      focusFields: Array.isArray(options?.focusFields) ? options.focusFields : [],
      manualSelections,
      manualSelectionHints: this._buildManualSelectionHints(manualSelections, rowEl),
      rowValueMap: this._buildRowValueMap(rowEl),
      headerHTML: headerEl ? this._serializeEl(headerEl, 3) : null,
      rowHTMLs: allRows.map((r) => this._serializeEl(r, 6)),
      tableWindowHTML: broadContext ? this._serializeTableWindow(tableEl, headerEl, allRows) : null,
      headerCells: this._extractCells(headerEl),
      rowCells: this._extractCells(rowEl)
    };
  }

  _serializeTableWindow(tableEl, headerEl, rows) {
    if (!tableEl) return null;
    const header = headerEl ? `HEADER:\n${this._serializeEl(headerEl, 5)}` : 'HEADER:\n(not found)';
    const body = (rows || [])
      .slice(0, 8)
      .map((r, i) => `ROW ${i + 1}:\n${this._serializeEl(r, 5)}`)
      .join('\n');
    return `${header}\n${body || 'ROWS:\n(not found)'}`;
  }

  _buildManualSelectionHints(manualSelections, rowEl) {
    const hints = {};
    Object.entries(manualSelections || {}).forEach(([field, hint]) => {
      const selector = typeof hint === 'string' ? hint : hint?.selector;
      const liveValue = typeof hint === 'object' ? (hint.liveValue || null) : null;
      if (!selector || typeof selector !== 'string') return;
      let scopedValue = null;
      let documentValue = null;
      try {
        const scopedEl = rowEl?.querySelector?.(selector);
        if (scopedEl) scopedValue = (scopedEl.innerText || scopedEl.textContent || '').trim().slice(0, 120);
      } catch (_err) {
        // ignore
      }
      try {
        const docEl = document.querySelector(selector);
        if (docEl) documentValue = (docEl.innerText || docEl.textContent || '').trim().slice(0, 120);
      } catch (_err) {
        // ignore
      }
      hints[field] = {
        selector,
        liveValue,
        scopedValue,
        documentValue
      };
    });
    return hints;
  }

  _buildRowValueMap(rowEl) {
    const map = [];
    if (!rowEl) return map;
    const allEls = Array.from(rowEl.querySelectorAll('*'));
    allEls.forEach((el) => {
      if (!(el instanceof HTMLElement)) return;
      if (el.childElementCount > 0) return;
      const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 80) return;
      const attrs = {};
      ['data-testid', 'data-test', 'data-id', 'data-col', 'aria-label', 'title', 'id', 'role'].forEach((a) => {
        const v = el.getAttribute(a);
        if (v) attrs[a] = v.trim().slice(0, 120);
      });
      map.push({
        text,
        attrs,
        tag: el.tagName.toLowerCase()
      });
    });
    return map;
  }

  _findRowAncestor(el) {
    let cur = el;
    while (cur && cur !== document.body) {
      if (cur.tagName === 'TR' || cur.getAttribute('role') === 'row') return cur;
      if (['DIV', 'LI', 'ARTICLE'].includes(cur.tagName)) {
        const text = cur.innerText || '';
        const numCount = (text.match(/\d+\.?\d*/g) || []).length;
        if (numCount >= 3 && text.length < 500) return cur;
      }
      cur = cur.parentElement;
    }

    cur = el;
    while (cur && cur !== document.body) {
      const siblings = Array.from(cur.parentElement?.children || []);
      const rowLike = siblings.find((s) => {
        const t = s.innerText || '';
        return /\d/.test(t) && t.length < 500 && t.length > 10;
      });
      if (rowLike) return rowLike;
      cur = cur.parentElement;
    }

    return null;
  }

  _findHeaderRow(tableEl) {
    if (!tableEl) return null;
    const rows = Array.from(tableEl.querySelectorAll('tr, [role="row"]'));
    return (
      rows.find((r) => {
        const text = (r.innerText || '').trim();
        const hasNumbers = /\d{2,}/.test(text);
        const hasTh = r.querySelector('th') !== null;
        return hasTh || (!hasNumbers && text.length > 5);
      }) ||
      rows[0] ||
      null
    );
  }

  _guessRowSelector(rowEl) {
    const tag = rowEl.tagName.toLowerCase();
    const attrs = [
      'data-testid',
      'data-test',
      'data-position-id',
      'data-order-id',
      'data-id',
      'data-key',
      'data-row'
    ];
    for (const attr of attrs) {
      if (rowEl.hasAttribute(attr)) return `${tag}[${attr}]`;
    }
    if (rowEl.closest('tbody')) return 'tbody > tr';
    return tag;
  }

  _serializeEl(el, depth = 4) {
    if (!el || depth === 0) return '';
    const tag = el.tagName.toLowerCase();
    const attrs = this._serializeAttrs(el);
    const text =
      el.childElementCount === 0
        ? (el.innerText || el.textContent || '').trim().slice(0, 80)
        : '';
    const children =
      depth > 1
        ? Array.from(el.children)
            .slice(0, 20)
            .map((c) => this._serializeEl(c, depth - 1))
            .filter(Boolean)
            .join('\n')
        : '';
    const inner = text ? `"${text}"` : children ? `\n${children}` : '';
    return `<${tag}${attrs}>${inner}</${tag}>`;
  }

  _serializeAttrs(el) {
    const important = [
      'data-test',
      'data-testid',
      'data-id',
      'data-col',
      'data-index',
      'data-position-id',
      'data-order-id',
      'data-side',
      'data-symbol',
      'aria-label',
      'title',
      'id',
      'role',
      'type',
      'class'
    ];
    return important
      .map((a) => {
        const v = el.getAttribute(a);
        return v ? ` ${a}="${v.trim().slice(0, 120)}"` : '';
      })
      .join('');
  }

  _extractCells(rowEl) {
    if (!rowEl) return [];
    const cells = rowEl.querySelectorAll('td, th, [role="cell"], [role="columnheader"]');
    return Array.from(cells).map((cell, i) => {
      const leaf = this._findBestLeaf(cell);
      return {
        index: i,
        cellText: (cell.innerText || '').trim().slice(0, 80),
        leafText: leaf ? (leaf.innerText || '').trim().slice(0, 80) : null,
        cellAttrs: this._getAttrMap(cell),
        leafAttrs: leaf ? this._getAttrMap(leaf) : null,
        leafTag: leaf?.tagName.toLowerCase() || null,
        childCount: cell.childElementCount
      };
    });
  }

  _findBestLeaf(cell) {
    const leaves = Array.from(cell.querySelectorAll('*')).filter((el) => {
      if (el.childElementCount > 0) return false;
      const text = (el.innerText || '').trim();
      return text.length > 0 && text.length < 80;
    });
    if (leaves.length === 0) return cell.childElementCount === 0 ? cell : null;
    if (leaves.length === 1) return leaves[0];
    const withAttr = leaves.find(
      (l) =>
        l.getAttribute('data-testid') ||
        l.getAttribute('data-test') ||
        l.getAttribute('data-id')
    );
    return withAttr || leaves[0];
  }

  _getAttrMap(el) {
    const result = {};
    const attrs = [
      'data-test',
      'data-testid',
      'data-id',
      'data-col',
      'data-index',
      'aria-label',
      'title',
      'id',
      'class',
      'role'
    ];
    for (const a of attrs) {
      const v = el?.getAttribute(a);
      if (v) result[a] = v.trim().slice(0, 120);
    }
    return result;
  }

  static buildPrompt(context) {
    return `You are an expert DOM analyst for trading platforms.

A user clicked somewhere on their broker's positions table. Your job is to analyze
the full DOM structure and return EXACT CSS selectors for each trade field.

These selectors will be used as: row.querySelector(selector)
They must point to the LEAF element that contains the actual value text.

=== USER MANUAL FIELD HINTS (from clicks) ===
${Object.entries(context.manualSelectionHints || {})
    .map(
      ([k, v]) =>
        `${k}: selector="${v?.selector || ''}" liveValue="${v?.liveValue || ''}" scopedValue="${v?.scopedValue || ''}" documentValue="${v?.documentValue || ''}"`
    )
    .join('\n') || '(none)'}

=== ALL LEAF ELEMENTS IN THE ROW (text => attributes) ===
${(context.rowValueMap || [])
    .map((el, i) => `[${i}] text="${el.text}" tag=${el.tag} attrs=${JSON.stringify(el.attrs)}`)
    .join('\n') || '(none)'}

=== HEADER ROW ===
${context.headerHTML || '(not found)'}

=== HEADER CELLS (extracted) ===
${context.headerCells
    .map(
      (c) =>
        `col[${c.index}]: text="${c.cellText}" attrs=${JSON.stringify(c.cellAttrs)}`
    )
    .join('\n') || '(none)'}

=== TRADE ROW HTML (full serialized DOM) ===
${context.rowHTMLs[0] || '(not found)'}

${context.rowHTMLs[1] ? `=== SECOND ROW (for pattern confirmation) ===\n${context.rowHTMLs[1]}` : ''}

=== TRADE ROW CELLS (extracted with leaf elements) ===
${context.rowCells
    .map(
      (c) => `
col[${c.index}]:
  cell text   : "${c.cellText}"
  cell attrs  : ${JSON.stringify(c.cellAttrs)}
  leaf text   : "${c.leafText}"
  leaf tag    : ${c.leafTag}
  leaf attrs  : ${JSON.stringify(c.leafAttrs)}
  child count : ${c.childCount}`
    )
    .join('\n')}

=== YOUR TASK ===
Use value matching first, structure second.
For each field:
1) Match user hint live value against row leaf value map.
2) If no hint/match, infer from expected value patterns.
3) Return selector for the matched LEAF element.

SELECTOR PRIORITY (use the highest available):
1. [data-testid="value"]
2. [data-test="value"]
3. [data-id="value"]
4. [aria-label="value"]
5. [id="value"]
6. td:nth-of-type(N) > span
7. td:nth-of-type(N)

IMPORTANT RULES:
- Selector must work scoped inside a single row: row.querySelector(YOUR_SELECTOR)
- Target the LEAF element with the actual text value, not a wrapper
- DO NOT mix up similar fields
- For closeButton, target the actual clickable button element
- NEVER use class selectors (.foo) or hashed CSS module classes
- Prefer data-* attributes over structural selectors
- If unsure for a field, return null
- Return ONLY JSON

Expected value patterns:
- symbol: trading pair like BTCUSDT, EURUSD, XAUUSD
- side: Buy/Sell/Long/Short
- volume: small quantity/lot value like 0.01, 1, 2.5
- entryPrice/currentPrice: larger instrument prices
- takeProfit/stopLoss: number or Add/--/—
- pnl: signed numeric (+/-)

${(context.focusFields || []).length > 0
    ? `PRIORITY MISSING FIELDS TO FILL NOW:\n${context.focusFields.map((f) => `- ${f}`).join('\n')}\n`
    : ''}

${context.broadContext && context.tableWindowHTML
    ? `=== BROADER TABLE WINDOW CONTEXT ===
${context.tableWindowHTML}
`
    : ''}

FIELDS TO MAP:
{
  "symbol": null,
  "side": null,
  "volume": null,
  "entryPrice": null,
  "currentPrice": null,
  "takeProfit": null,
  "stopLoss": null,
  "pnl": null,
  "closeButton": null,
  "rowSelector": null,
  "balanceSelector": null
}`;
  }

  async _askClaude(context) {
    if (!chrome?.runtime?.id || !chrome.runtime.sendMessage) {
      throw new Error('Extension runtime unavailable');
    }
    const prompt = DeepMapper.buildPrompt(context);
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'MAP_FIELDS', payload: { prompt } }, (response) => {
        if (chrome.runtime?.lastError) {
          reject(new Error(chrome.runtime.lastError.message || 'MAP_FIELDS failed'));
          return;
        }
        if (!response?.success) {
          reject(new Error(response?.error || 'MAP_FIELDS failed'));
          return;
        }
        resolve(response.mapping || {});
      });
    });
  }

  static buildFixPrompt(context, firstResult, failedFields) {
    return `You previously returned selectors for this trading row mapping.

Some selectors failed validation and did not resolve on the live row.
Fix ONLY the failed fields below and return full JSON again.

FAILED FIELDS:
${failedFields.map((f) => `- ${f.field}: "${f.selector}" (${f.reason})`).join('\n')}

PREVIOUS JSON:
${JSON.stringify(firstResult, null, 2)}

ROW HTML:
${context.rowHTMLs?.[0] || '(not found)'}

ROW CELLS:
${(context.rowCells || [])
    .map((c) => `col[${c.index}] text="${c.cellText}" leaf="${c.leafText}" attrs=${JSON.stringify(c.leafAttrs || c.cellAttrs || {})}`)
    .join('\n')}

ROW VALUE MAP:
${(context.rowValueMap || [])
    .map((x, i) => `[${i}] text="${x.text}" attrs=${JSON.stringify(x.attrs)}`)
    .join('\n')}

RULES:
- row scoped selectors for row fields
- no class selectors
- prefer data-test/data-testid
- return ONLY JSON`;
  }

  async _askClaudeFix(context, firstResult, failedFields) {
    if (!chrome?.runtime?.id || !chrome.runtime.sendMessage) {
      throw new Error('Extension runtime unavailable');
    }
    const prompt = DeepMapper.buildFixPrompt(context, firstResult, failedFields);
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'MAP_FIELDS', payload: { prompt } }, (response) => {
        if (chrome.runtime?.lastError) {
          reject(new Error(chrome.runtime.lastError.message || 'MAP_FIELDS retry failed'));
          return;
        }
        if (!response?.success) {
          reject(new Error(response?.error || 'MAP_FIELDS retry failed'));
          return;
        }
        resolve(response.mapping || {});
      });
    });
  }

  _collectFailedSelectors(validated) {
    return Object.entries(validated || {})
      .filter(([, v]) => !!v?.selector && (v.valid === false || !!v.warning))
      .map(([field, v]) => ({
        field,
        selector: v.selector,
        reason: v.warning || 'did not resolve'
      }));
  }

  _mergeValidated(baseValidated, retryValidated) {
    const merged = { ...(baseValidated || {}) };
    Object.entries(retryValidated || {}).forEach(([field, data]) => {
      const prev = merged[field];
      if (!prev) {
        merged[field] = data;
        return;
      }
      if (data?.valid && !prev?.valid) {
        merged[field] = data;
        return;
      }
      if (data?.valid && prev?.warning && !data?.warning) {
        merged[field] = data;
      }
    });
    return merged;
  }

  _validateAndScore(selectorMap, rowEl) {
    const result = {};
    const skipRow = ['rowSelector', 'balanceSelector'];
    for (const [field, selector] of Object.entries(selectorMap || {})) {
      if (!selector || typeof selector !== 'string') {
        result[field] = { selector: null, valid: false, value: null };
        continue;
      }

      if (skipRow.includes(field)) {
        try {
          const el = document.querySelector(selector);
          result[field] = {
            selector,
            valid: !!el,
            value: el ? (el.innerText || '').trim() : null
          };
        } catch (_err) {
          result[field] = { selector, valid: false, value: null };
        }
        continue;
      }

      try {
        const el = rowEl?.querySelector(selector) || null;
        const value = el ? (el.innerText || el.textContent || '').trim() : null;
        result[field] = {
          selector,
          valid: !!el,
          value,
          warning: this._checkValueSanity(field, value)
        };
      } catch (_err) {
        result[field] = { selector, valid: false, value: null, warning: 'invalid selector syntax' };
      }
    }
    return result;
  }

  _checkValueSanity(field, value) {
    if (!value) return null;
    const v = value.trim();
    switch (field) {
      case 'symbol':
        return /[A-Z]{3,}/.test(v) ? null : 'expected trading pair like BTCUSDT';
      case 'side':
        return /\b(buy|sell|long|short)\b/i.test(v) ? null : 'expected Buy/Sell/Long/Short';
      case 'entryPrice':
      case 'currentPrice':
      case 'volume':
        return /\d/.test(v) ? null : 'expected a number';
      case 'pnl':
        return /[+-]?\d/.test(v) ? null : 'expected a number with +/- prefix';
      case 'takeProfit':
      case 'stopLoss':
        return /\d/.test(v) || /add|not set|--|—/i.test(v)
          ? null
          : 'expected a number or "Add"';
      default:
        return null;
    }
  }

  static toStorableProfile(validatedResult, host) {
    const fields = {};
    for (const [field, data] of Object.entries(validatedResult || {})) {
      if (data?.valid && data?.selector) fields[field] = data.selector;
    }
    return {
      host,
      version: 1,
      createdAt: Date.now(),
      fields,
      rowSelector: validatedResult?.rowSelector?.selector || 'tbody > tr',
      balanceSelector: validatedResult?.balanceSelector?.selector || null
    };
  }
}

window.DeepMapper = DeepMapper;

