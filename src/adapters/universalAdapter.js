/**
 * Universal adapter: delegates to the universal detector (heuristic DOM scan).
 * Used for any platform that does not have a dedicated adapter.
 */

(function () {
  const detector = window.TradeGuardX?.universalDetector;

  const universalAdapter = {
    getEquity(root) {
      return detector ? detector.detectEquity(root || document.body) : null;
    },
    getBalance(root) {
      return detector ? detector.detectBalance(root || document.body) : null;
    },
    getTrades(root) {
      return detector ? detector.detectTrades(root || document.body) : [];
    },
    getTradeButtons(root) {
      return detector ? detector.detectTradeButtons(root || document.body) : { buyButtons: [], sellButtons: [] };
    },
    getCloseButtons(root) {
      return detector ? detector.detectCloseButtons(root || document.body) : [];
    }
  };

  window.TradeGuardX = window.TradeGuardX || {};
  window.TradeGuardX.adapters = window.TradeGuardX.adapters || {};
  window.TradeGuardX.adapters.universal = universalAdapter;
})();
