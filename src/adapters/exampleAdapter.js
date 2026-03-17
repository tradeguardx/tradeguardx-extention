import { BaseAdapter } from './baseAdapter.js';

/**
 * ExampleAdapter
 *
 * This is a reference implementation for one generic web trading platform.
 * To support a real platform (DXTrade, MatchTrader, TradeLocker, etc.), copy
 * this file, adjust selectors, and register the adapter in the content script.
 */
export class ExampleAdapter extends BaseAdapter {
  constructor() {
    super();
    this.tradeButtonSelectors = {
      buy: '.tg-buy-button',
      sell: '.tg-sell-button'
    };

    this.accountSelectors = {
      balance: '.tg-account-balance',
      equity: '.tg-account-equity',
      positionsRow: '.tg-open-position-row',
      positionSymbol: '.tg-position-symbol',
      positionSide: '.tg-position-side',
      positionSize: '.tg-position-size',
      positionEntry: '.tg-position-entry',
      positionPnl: '.tg-position-pnl'
    };

    this.orderSelectors = {
      symbol: '.tg-order-symbol',
      size: '.tg-order-size',
      entryPrice: '.tg-order-entry-price',
      stopLoss: '.tg-order-sl',
      takeProfit: '.tg-order-tp'
    };

    this.closedTradeSelectors = {
      row: '.tg-closed-trade-row',
      pnl: '.tg-closed-trade-pnl'
    };
  }

  // eslint-disable-next-line class-methods-use-this
  getPlatformId() {
    return 'example-platform';
  }

  // Detect supported pages either by hostname or presence of key elements.
  // eslint-disable-next-line class-methods-use-this
  isMatch(url, doc) {
    try {
      const hostname = new URL(url).hostname;
      if (hostname.includes('example-trading.com')) return true;
    } catch (_e) {
      // Ignore URL parsing failures.
    }
    return Boolean(doc.querySelector(this.tradeButtonSelectors.buy) || doc.querySelector(this.tradeButtonSelectors.sell));
  }

  start({ onTradeAttempt, onAccountUpdate, onTradeClosed }) {
    this.observeTradeButtons(onTradeAttempt);
    this.observeAccountInfo(onAccountUpdate);
    this.observeClosedTrades(onTradeClosed);
  }

  observeTradeButtons(onTradeAttempt) {
    const attachListeners = (root) => {
      const buyButtons = root.querySelectorAll(this.tradeButtonSelectors.buy);
      const sellButtons = root.querySelectorAll(this.tradeButtonSelectors.sell);

      buyButtons.forEach((btn) => {
        if (btn.__tgBound) return;
        btn.__tgBound = true;
        btn.addEventListener(
          'click',
          (event) => {
            const trade = this.getPendingOrderDetails('BUY');
            onTradeAttempt({ ...trade, side: 'BUY' }, event);
          },
          true
        );
      });

      sellButtons.forEach((btn) => {
        if (btn.__tgBound) return;
        btn.__tgBound = true;
        btn.addEventListener(
          'click',
          (event) => {
            const trade = this.getPendingOrderDetails('SELL');
            onTradeAttempt({ ...trade, side: 'SELL' }, event);
          },
          true
        );
      });
    };

    // Initial scan.
    attachListeners(document);

    // Observe for dynamically added buttons.
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (!(node instanceof HTMLElement)) return;
          attachListeners(node);
        });
      }
    });

    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  observeAccountInfo(onAccountUpdate) {
    const parseAccount = () => {
      const balanceEl = document.querySelector(this.accountSelectors.balance);
      const equityEl = document.querySelector(this.accountSelectors.equity);

      const balance = balanceEl ? this.parseNumber(balanceEl.textContent) : null;
      const equity = equityEl ? this.parseNumber(equityEl.textContent) : null;

      const rows = document.querySelectorAll(this.accountSelectors.positionsRow);
      const openPositions = [];

      rows.forEach((row) => {
        const get = (sel) => row.querySelector(sel);
        const symbol = get(this.accountSelectors.positionSymbol)?.textContent?.trim() || '';
        const sideText = get(this.accountSelectors.positionSide)?.textContent?.trim() || '';
        const side = sideText.toUpperCase().includes('SELL') ? 'SELL' : 'BUY';
        const size = this.parseNumber(get(this.accountSelectors.positionSize)?.textContent);
        const entryPrice = this.parseNumber(get(this.accountSelectors.positionEntry)?.textContent);
        const pnl = this.parseNumber(get(this.accountSelectors.positionPnl)?.textContent);

        if (!symbol) return;
        openPositions.push({
          symbol,
          side,
          size,
          entryPrice,
          pnl
        });
      });

      onAccountUpdate({
        balance,
        equity,
        openPositions
      });
    };

    // Initial snapshot.
    parseAccount();

    // Watch for any changes under a reasonably large container (fallback to body).
    const root =
      document.querySelector(this.accountSelectors.balance)?.closest('.tg-account-root') ||
      document.body;

    if (!root) return;

    const observer = new MutationObserver(() => {
      parseAccount();
    });

    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  observeClosedTrades(onTradeClosed) {
    const root = document.querySelector(this.closedTradeSelectors.row)?.parentElement || document.body;
    if (!root) return;

    const handleRow = (row) => {
      if (!(row instanceof HTMLElement)) return;
      if (!row.matches(this.closedTradeSelectors.row)) return;
      if (row.__tgClosedHandled) return;
      row.__tgClosedHandled = true;

      const pnlEl = row.querySelector(this.closedTradeSelectors.pnl);
      const pnl = this.parseNumber(pnlEl?.textContent);
      if (pnl === null || Number.isNaN(pnl)) return;

      onTradeClosed({ pnl });
    };

    // Existing rows.
    root.querySelectorAll(this.closedTradeSelectors.row).forEach((row) => handleRow(row));

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (node instanceof HTMLElement) {
            handleRow(node);
            node.querySelectorAll?.(this.closedTradeSelectors.row).forEach((row) => handleRow(row));
          }
        });
      }
    });

    observer.observe(root, { childList: true, subtree: true });
  }

  getPendingOrderDetails() {
    const symbolEl = document.querySelector(this.orderSelectors.symbol);
    const sizeEl = document.querySelector(this.orderSelectors.size);
    const entryEl = document.querySelector(this.orderSelectors.entryPrice);
    const slEl = document.querySelector(this.orderSelectors.stopLoss);
    const tpEl = document.querySelector(this.orderSelectors.takeProfit);

    return {
      symbol: symbolEl?.textContent?.trim() || symbolEl?.value?.trim() || '',
      size: this.parseNumber(sizeEl?.value || sizeEl?.textContent),
      entryPrice: this.parseNumber(entryEl?.textContent || entryEl?.value),
      stopLossPrice: this.parseNumber(slEl?.textContent || slEl?.value),
      takeProfitPrice: this.parseNumber(tpEl?.textContent || tpEl?.value)
    };
  }

  // eslint-disable-next-line class-methods-use-this
  parseNumber(raw) {
    if (!raw) return null;
    const cleaned = raw.toString().replace(/[^\d.-]/g, '');
    const value = Number(cleaned);
    return Number.isFinite(value) ? value : null;
  }

  closeAllPositions() {
    // Example: click a hypothetical "Close All" button if present.
    const closeAllButton = document.querySelector('.tg-close-all');
    if (closeAllButton) {
      closeAllButton.click();
    }
  }

  setTradingDisabled(isDisabled, reason) {
    const root = document.body;
    if (!root) return;

    let overlay = document.getElementById('tg-trade-guardx-overlay');

    if (isDisabled) {
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'tg-trade-guardx-overlay';
        overlay.style.position = 'fixed';
        overlay.style.inset = '0';
        overlay.style.background = 'rgba(0,0,0,0.65)';
        overlay.style.zIndex = '999999';
        overlay.style.display = 'flex';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';
        overlay.style.fontFamily = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        overlay.style.color = '#fff';
        overlay.style.textAlign = 'center';

        const box = document.createElement('div');
        box.style.background = '#121826';
        box.style.borderRadius = '12px';
        box.style.padding = '24px 32px';
        box.style.maxWidth = '420px';
        box.style.boxShadow = '0 18px 45px rgba(0,0,0,0.4)';

        const title = document.createElement('div');
        title.textContent = 'Trade GuardX – Trading Disabled';
        title.style.fontSize = '18px';
        title.style.fontWeight = '600';
        title.style.marginBottom = '8px';

        const msg = document.createElement('div');
        msg.id = 'tg-trade-guardx-message';
        msg.style.fontSize = '14px';
        msg.style.opacity = '0.9';
        msg.textContent = reason || 'Trading has been disabled by your risk rules.';

        box.appendChild(title);
        box.appendChild(msg);
        overlay.appendChild(box);
        root.appendChild(overlay);
      } else {
        const msg = overlay.querySelector('#tg-trade-guardx-message');
        if (msg) msg.textContent = reason || msg.textContent;
      }

      // Disable trade buttons visually.
      const { buy, sell } = this.tradeButtonSelectors;
      root.querySelectorAll(`${buy}, ${sell}`).forEach((btn) => {
        btn.setAttribute('disabled', 'true');
        btn.style.opacity = '0.5';
        btn.style.pointerEvents = 'none';
      });
    } else if (overlay) {
      overlay.remove();
      const { buy, sell } = this.tradeButtonSelectors;
      root.querySelectorAll(`${buy}, ${sell}`).forEach((btn) => {
        btn.removeAttribute('disabled');
        btn.style.opacity = '';
        btn.style.pointerEvents = '';
      });
    }
  }
}

