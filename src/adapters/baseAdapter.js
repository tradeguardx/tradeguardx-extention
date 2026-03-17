/**
 * Base adapter interface for platform-specific or universal detection.
 * If a platform is recognized (e.g. my.exness.com), use its adapter.
 * Otherwise use the universal adapter that runs heuristic DOM detection.
 */

(function () {
  function getAdapter(hostname) {
    if (!hostname || typeof hostname !== 'string') hostname = '';
    const host = hostname.toLowerCase();

    // Platform-specific adapters can be registered here later.
    // if (host.includes('exness.com')) return window.TradeGuardX?.adapters?.exness;
    // if (host.includes('tradingview')) return window.TradeGuardX?.adapters?.tradingView;
    // if (host.includes('dxtrade')) return window.TradeGuardX?.adapters?.dxtrade;

    return window.TradeGuardX?.adapters?.universal || null;
  }

  window.TradeGuardX = window.TradeGuardX || {};
  window.TradeGuardX.adapters = window.TradeGuardX.adapters || {};
  window.TradeGuardX.adapters.getAdapter = getAdapter;
})();
