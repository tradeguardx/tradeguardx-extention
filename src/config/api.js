/**
 * Which API stack the extension calls.
 * - `local` — user :3000, trades :3009; broker mapping / AI mapper → dev.api (hosted broker service).
 * - `dev` / `prod` — hosted API Gateway URLs.
 */
export const API_ENV = 'prod';

const URLS = {
  local: {
    AI_API_BASE_URL: 'https://dev.api.tradeguardx.com',
    USER_API_BASE_URL: 'http://localhost:3000',
    TRADE_API_BASE_URL: 'http://localhost:3009',
  },
  dev: {
    AI_API_BASE_URL: 'https://dev.api.tradeguardx.com',
    USER_API_BASE_URL: 'https://dev.api.tradeguardx.com/user',
    TRADE_API_BASE_URL: 'https://dev.api.tradeguardx.com/trades',
  },
  prod: {
    AI_API_BASE_URL: 'https://api.tradeguardx.com',
    USER_API_BASE_URL: 'https://api.tradeguardx.com/user',
    TRADE_API_BASE_URL: 'https://api.tradeguardx.com/trades',
  },
};

const pick = URLS[API_ENV] || URLS.dev;

export const AI_API_BASE_URL = pick.AI_API_BASE_URL;
export const USER_API_BASE_URL = pick.USER_API_BASE_URL;
export const TRADE_API_BASE_URL = pick.TRADE_API_BASE_URL;

export function getBrokerMappingUrl(brokerId) {
  const safeId = encodeURIComponent(brokerId || '');
  return `${AI_API_BASE_URL}/broker/broker-mappings/${safeId}`;
}

export function getBrokerMappingsPostUrl() {
  return `${AI_API_BASE_URL}/broker/broker-mappings`;
}

export function getAiMapperUrl() {
  return `${AI_API_BASE_URL}/broker/aiMapper`;
}

export function getPairingExchangeUrl() {
  return `${USER_API_BASE_URL.replace(/\/+$/, '')}/pairing/exchange`;
}

export function getPairingRefreshUrl() {
  return `${USER_API_BASE_URL.replace(/\/+$/, '')}/pairing/refresh`;
}

/** GET /rules — extension JWT may omit ?tradingAccountId (bound to pairing token). */
export function getRulesUrl() {
  return `${USER_API_BASE_URL.replace(/\/+$/, '')}/rules`;
}

/** GET /trading-accounts — extension token returns its bound account (funded-mode state included). */
export function getTradingAccountsListUrl() {
  return `${USER_API_BASE_URL.replace(/\/+$/, '')}/trading-accounts`;
}

/** PATCH /trading-accounts/{id} — sync balance/reset snapshots from the extension. */
export function getTradingAccountPatchUrl(accountId) {
  const safeId = encodeURIComponent(accountId || '');
  return `${USER_API_BASE_URL.replace(/\/+$/, '')}/trading-accounts/${safeId}`;
}

/** POST /trading-accounts/{id}/reconcile — user-declared balance reconciliation. */
export function getTradingAccountReconcileUrl(accountId) {
  const safeId = encodeURIComponent(accountId || '');
  return `${USER_API_BASE_URL.replace(/\/+$/, '')}/trading-accounts/${safeId}/reconcile`;
}

export function getTradesPostUrl() {
  return `${TRADE_API_BASE_URL.replace(/\/+$/, '')}/trades`;
}

/**
 * GET /trades/daily-summary — timezone-aware server-side count + P&L of closed trades
 * since the account's last daily reset instant. Used to seed max-trades-per-day and
 * daily-loss rules after pair/refresh so a disconnect/reconnect can't reset the count.
 */
export function getTradesDailySummaryUrl() {
  return `${TRADE_API_BASE_URL.replace(/\/+$/, '')}/trades/daily-summary`;
}

export function getJournalEventsPostUrl() {
  return `${TRADE_API_BASE_URL.replace(/\/+$/, '')}/journal/events`;
}

export function getJournalMediaPostUrl() {
  return `${TRADE_API_BASE_URL.replace(/\/+$/, '')}/journal/media`;
}
