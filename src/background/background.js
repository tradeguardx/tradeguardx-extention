/* global chrome */

import { Storage } from '../storage/storage.js';
import { RulesEngine } from '../rules/rulesEngine.js';

const storage = new Storage();
const rulesEngine = new RulesEngine(storage);
const ANTHROPIC_API_KEY_STORAGE_KEY = 'tradeGuardXAnthropicApiKey';
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
// TEMP ONLY: fallback key for local testing. Remove after verifying popup save flow.
const ANTHROPIC_HARDCODED_FALLBACK_KEY = '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';
const CONTENT_SCRIPT_FILES = [
  'src/overlay/warningOverlay.js',
  'src/content/universalDetector.js',
  'src/content/deep-mapper.js',
  'src/adapters/baseAdapter.js',
  'src/adapters/universalAdapter.js',
  'src/content/domScanner.js',
  'src/content/orderTableTracker.js',
  'src/content/tradeMonitor.js',
  'src/content/content.js'
];

chrome.runtime.onInstalled.addListener((details) => {
  storage.ensureDefaults();
  if (details.reason === 'install') {
    storage.clearState();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return undefined;

  switch (message.type) {
    case 'TG_EVALUATE_ACCOUNT':
      handleEvaluateAccount(message.payload, sendResponse);
      return true; // async
    case 'TG_TRADE_ALLOWED':
      handleTradeAllowed(sendResponse);
      return true; // async
    case 'TG_POSITIONS_OPENED':
      handlePositionsOpened(message.payload, sendResponse);
      return true; // async
    case 'TG_POSITION_CLOSED_LOSS':
      handlePositionClosedLoss(sendResponse);
      return true; // async
    case 'TG_GET_POPUP_STATE':
      handleGetPopupState(sendResponse);
      return true; // async
    case 'TG_GET_CONFIG':
      handleGetConfig(sendResponse);
      return true; // async
    case 'TG_SAVE_CONFIG':
      handleSaveConfig(message.payload, sendResponse);
      return true; // async
    case 'TG_GET_SELECTORS':
      handleGetSelectors(message.payload, sendResponse);
      return true; // async
    case 'TG_SAVE_SELECTORS':
      handleSaveSelectors(message.payload, sendResponse);
      return true; // async
    case 'TG_UI_HOOKED':
      handleUiHooked(message.payload, sender, sendResponse);
      return true; // async
    case 'TG_CLEAR_STATE':
      handleClearState(sendResponse);
      return true; // async
    case 'TG_START_PLATFORM_MAPPING':
      handleStartPlatformMapping(sendResponse);
      return true; // async
    case 'MAP_FIELDS':
      handleMapFields(message.payload, sendResponse);
      return true; // async
    case 'TG_SET_ANTHROPIC_API_KEY':
      handleSetAnthropicApiKey(message.payload, sendResponse);
      return true; // async
    case 'TG_GET_ANTHROPIC_API_KEY_STATUS':
      handleGetAnthropicApiKeyStatus(sendResponse);
      return true; // async
    case 'TG_DEBUG_MAPPING_DIAGNOSTICS':
      handleDebugMappingDiagnostics(sendResponse);
      return true; // async
    default:
      break;
  }

  return undefined;
});

async function handleEvaluateAccount(payload, sendResponse) {
  try {
    const { accountState, activeTrades } = payload || {};
    if (!accountState) {
      sendResponse(null);
      return;
    }
    const config = await storage.getConfig();
    const result = await rulesEngine.evaluateAccount(accountState);

    const sourceTrades = Array.isArray(activeTrades)
      ? activeTrades
      : (Array.isArray(accountState.positions) ? accountState.positions : []);
    await storage.updateState((current) => ({
      ...current,
      activeTrades: sourceTrades.map((t) => ({
        symbol: t.symbol,
        side: t.side,
        volume: t.volume ?? null,
        stopLoss: t.stopLoss ?? null,
        takeProfit: t.takeProfit ?? null,
        profit: t.profit ?? null,
        entryPrice: t.entryPrice ?? null,
        currentPrice: t.currentPrice ?? null
      }))
    }));

    sendResponse({ ...result, config });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Trade GuardX: account evaluation failed', err);
    sendResponse(null);
  }
}

async function handleTradeAllowed(sendResponse) {
  try {
    sendResponse({ success: true });
  } catch (err) {
    sendResponse({ success: false });
  }
}

async function handlePositionsOpened(payload, sendResponse) {
  try {
    const delta = Number(payload?.delta) || 1;
    await storage.incrementTradesOpenedTodayBy(delta);
    sendResponse({ success: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Trade GuardX: failed to increment trades opened', err);
    sendResponse({ success: false });
  }
}

async function handlePositionClosedLoss(sendResponse) {
  try {
    await storage.incrementSessionLossCount();
    sendResponse({ success: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Trade GuardX: failed to increment session loss count', err);
    sendResponse({ success: false });
  }
}

async function handleGetPopupState(sendResponse) {
  try {
    const popupState = await rulesEngine.getPopupState();
    sendResponse(popupState);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Trade GuardX: failed to get popup state', err);
    sendResponse(null);
  }
}

async function handleGetConfig(sendResponse) {
  try {
    const config = await storage.getConfig();
    sendResponse(config);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Trade GuardX: failed to get config', err);
    sendResponse(null);
  }
}

async function handleSaveConfig(payload, sendResponse) {
  try {
    if (!payload || typeof payload !== 'object') {
      sendResponse({ success: false });
      return;
    }
    await storage.setConfig(payload);
    sendResponse({ success: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Trade GuardX: failed to update config', err);
    sendResponse({ success: false });
  }
}

async function handleGetSelectors(payload, sendResponse) {
  try {
    const host = payload?.host;
    if (!host) {
      sendResponse(null);
      return;
    }
    const all = await storage.getSelectors();
    sendResponse(all[host] || null);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Trade GuardX: failed to get selectors', err);
    sendResponse(null);
  }
}

async function handleSaveSelectors(payload, sendResponse) {
  try {
    const { host, selectors } = payload || {};
    if (!host || !selectors) {
      sendResponse({ success: false });
      return;
    }
    await storage.updateSelectorsForHost(host, selectors);
    sendResponse({ success: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Trade GuardX: failed to save selectors', err);
    sendResponse({ success: false });
  }
}

async function handleClearState(sendResponse) {
  try {
    await storage.clearState();
    sendResponse({ success: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Trade GuardX: failed to clear state', err);
    sendResponse({ success: false });
  }
}

async function handleUiHooked(payload, sender, sendResponse) {
  try {
    const { host, url, at } = payload || {};
    if (!host) {
      sendResponse?.({ success: false });
      return;
    }

    await storage.updateState((current) => ({
      ...current,
      lastHooked: {
        host,
        url: url || sender?.tab?.url || null,
        at: at || Date.now()
      }
    }));

    sendResponse?.({ success: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Trade GuardX: failed to record UI hook info', err);
    sendResponse?.({ success: false });
  }
}

async function handleStartPlatformMapping(sendResponse) {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs && tabs[0];
    if (!activeTab?.id) {
      sendResponse?.({ success: false, error: 'No active tab found' });
      return;
    }
    await chrome.tabs.update(activeTab.id, { active: true });
    const sendStart = () =>
      new Promise((resolve) => {
        chrome.tabs.sendMessage(activeTab.id, { type: 'TG_START_PLATFORM_MAPPING' }, (response) => {
          if (chrome.runtime?.lastError) {
            resolve({ success: false, error: chrome.runtime.lastError.message || 'Unable to start mapping' });
            return;
          }
          resolve(response && typeof response === 'object' ? response : { success: true });
        });
      });

    const startInAllFrames = async () => {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: activeTab.id, allFrames: true },
          func: async () => {
            try {
              let monitor = window.__tradeGuardXMonitor || null;
              if (!monitor && typeof window.TradeMonitor === 'function') {
                monitor = new window.TradeMonitor();
                window.__tradeGuardXMonitor = monitor;
                if (typeof monitor.init === 'function') {
                  await monitor.init();
                }
              }
              if (!monitor || typeof monitor.startGuidedPlatformMapping !== 'function') {
                return { started: false, href: window.location.href, reason: 'monitor_missing' };
              }
              await monitor.startGuidedPlatformMapping();
              const started = typeof monitor._isMappingActive === 'function'
                ? monitor._isMappingActive()
                : true;
              return {
                started: !!started,
                href: window.location.href,
                reason: started ? 'ok' : 'overlay_not_active'
              };
            } catch (err) {
              return {
                started: false,
                href: window.location.href,
                reason: err?.message || 'start_failed'
              };
            }
          }
        });

        const okResult = (results || []).find((r) => r?.result?.started === true);
        if (okResult) return { success: true };

        const firstReason = (results || [])
          .map((r) => r?.result?.reason)
          .find(Boolean);
        return { success: false, error: firstReason || 'Unable to start mapping in frames' };
      } catch (err) {
        return { success: false, error: err?.message || 'Frame mapping start failed' };
      }
    };

    let result = await sendStart();
    if (!result?.success) {
      // Some SPA/terminal pages miss auto-injection; inject scripts then retry once.
      try {
        await chrome.scripting.executeScript({
          target: { tabId: activeTab.id, allFrames: true },
          files: CONTENT_SCRIPT_FILES
        });
        result = await sendStart();
        if (!result?.success) {
          // Exness-like web terminals may host the app in nested frames; start there directly.
          result = await startInAllFrames();
        }
      } catch (injectErr) {
        sendResponse?.({
          success: false,
          error: injectErr?.message || result?.error || 'Unable to start mapping'
        });
        return;
      }
    } else if (!result?.success) {
      result = await startInAllFrames();
    }
    sendResponse?.(result?.success ? result : { success: false, error: result?.error || 'Unable to start mapping' });
  } catch (err) {
    sendResponse?.({ success: false, error: err?.message || 'Failed to start mapping' });
  }
}

async function getAnthropicApiKey() {
  return new Promise((resolve) => {
    chrome.storage.local.get([ANTHROPIC_API_KEY_STORAGE_KEY], (result) => {
      if (chrome.runtime?.lastError) {
        resolve(ANTHROPIC_HARDCODED_FALLBACK_KEY || null);
        return;
      }
      const key = result?.[ANTHROPIC_API_KEY_STORAGE_KEY];
      if (typeof key === 'string' && key.trim()) {
        resolve(key.trim());
        return;
      }
      resolve(ANTHROPIC_HARDCODED_FALLBACK_KEY || null);
    });
  });
}

async function handleSetAnthropicApiKey(payload, sendResponse) {
  try {
    const key = typeof payload?.apiKey === 'string' ? payload.apiKey.trim() : '';
    if (!key) {
      sendResponse?.({ success: false, error: 'API key is required' });
      return;
    }
    await new Promise((resolve) => {
      chrome.storage.local.set({ [ANTHROPIC_API_KEY_STORAGE_KEY]: key }, resolve);
    });
    sendResponse?.({ success: true });
  } catch (err) {
    sendResponse?.({ success: false, error: err?.message || 'Failed to save API key' });
  }
}

async function handleGetAnthropicApiKeyStatus(sendResponse) {
  try {
    const key = await getAnthropicApiKey();
    sendResponse?.({ success: true, configured: !!key });
  } catch (err) {
    sendResponse?.({ success: false, configured: false });
  }
}

function parseClaudeJsonText(text) {
  const clean = String(text || '').replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(clean);
  } catch (_err) {
    const match = clean.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Claude returned invalid JSON');
    return JSON.parse(match[0]);
  }
}

async function handleMapFields(payload, sendResponse) {
  try {
    const prompt = typeof payload?.prompt === 'string' ? payload.prompt : '';
    if (!prompt.trim()) {
      sendResponse?.({ success: false, error: 'Missing prompt' });
      return;
    }

    const apiKey = await getAnthropicApiKey();
    if (!apiKey) {
      sendResponse?.({
        success: false,
        error: 'Anthropic API key not configured. Save it first.'
      });
      return;
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      sendResponse?.({
        success: false,
        error: `Claude API error: ${response.status} ${errText?.slice(0, 240) || ''}`.trim()
      });
      return;
    }

    const data = await response.json();
    const text = data?.content?.[0]?.text || '';
    const mapping = parseClaudeJsonText(text);
    sendResponse?.({ success: true, mapping });
  } catch (err) {
    sendResponse?.({ success: false, error: err?.message || 'MAP_FIELDS failed' });
  }
}

async function handleDebugMappingDiagnostics(sendResponse) {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs && tabs[0];
    if (!activeTab?.id) {
      sendResponse?.({ success: false, error: 'No active tab found' });
      return;
    }

    const directMessage = await new Promise((resolve) => {
      chrome.tabs.sendMessage(activeTab.id, { type: 'TG_START_PLATFORM_MAPPING' }, (response) => {
        if (chrome.runtime?.lastError) {
          resolve({
            ok: false,
            error: chrome.runtime.lastError.message || 'sendMessage failed'
          });
          return;
        }
        resolve({ ok: true, response });
      });
    });

    const frameProbe = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id, allFrames: true },
      func: () => {
        const monitor = window.__tradeGuardXMonitor || null;
        const overlay =
          document.getElementById('tg-guided-mapper') ||
          document.getElementById('tg-mapper-bar');
        return {
          href: window.location.href,
          host: window.location.hostname,
          readyState: document.readyState,
          frameType: window.top === window.self ? 'top' : 'child',
          hasTradeMonitorClass: typeof window.TradeMonitor === 'function',
          hasMonitorInstance: !!monitor,
          hasDetector: !!(monitor && monitor.detector),
          hasOverlay: !!overlay,
          mappingSessionActive:
            !!(monitor && typeof monitor._isMappingActive === 'function' && monitor._isMappingActive()),
          requiresMapping: !!(monitor && monitor._requiresMapping === true),
          mappedMode: !!(monitor && typeof monitor._isMappedCrawlMode === 'function' && monitor._isMappedCrawlMode())
        };
      }
    });

    sendResponse?.({
      success: true,
      diagnostics: {
        tab: {
          id: activeTab.id,
          url: activeTab.url || null,
          title: activeTab.title || null
        },
        directMessage,
        frames: frameProbe.map((x) => ({
          frameId: x.frameId,
          ...x.result
        }))
      }
    });
  } catch (err) {
    sendResponse?.({ success: false, error: err?.message || 'Diagnostics failed' });
  }
}

