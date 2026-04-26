/**
 * TradeGuardX — Overlay & Toast System v3
 * Minimal. One question. One number. One decision.
 *
 * Exports preserved (called from other content scripts):
 *   showWarningOverlay({ title, message, highlight })
 *   showNoStopLossOverlay({ symbol, stopLoss, takeProfit, message, onSetStopLoss, repeatIntervalSeconds })
 *   showBlockedTradeOverlay(reason, config, options)   // options.confirmMode, options.onContinue, options.title
 *   showTradeClosedOverlay({ outcome, symbol, side, volume, entryPrice, currentPrice, stopLoss, takeProfit, pnl, closedAt })
 *   showPreTradeConfirmation({ side, symbol, balance, dailyLossLimit, totalLossLimit, maxTradesPerDay, tradesToday, closedPnlToday, allowBalanceEdit, onConfirm, onCancel, onUpdateBalance })
 *   showToast(message, tone)
 *   flashScreen()
 */

const OVERLAY_ID              = 'tg-warning-overlay';
const BLOCKED_OVERLAY_ID      = 'tg-blocked-trade-overlay';
const TRADE_CLOSED_OVERLAY_ID = 'tg-trade-closed-overlay';
const NO_SL_OVERLAY_ID        = 'tg-no-sl-overlay';
const PRE_TRADE_OVERLAY_ID    = 'tg-pre-trade-overlay';
const TOAST_ID                = 'tg-warning-toast';

const TOAST_DURATION   = 5500;
const OVERRIDE_COOLDOWN_MS = 3000;

/* ─── Styles (injected once) ─────────────────────────────────────────────── */
function _injectStyles() {
  if (document.getElementById('tg-overlay-styles')) return;
  const s = document.createElement('style');
  s.id = 'tg-overlay-styles';
  s.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&display=swap');

    :root {
      --tg-bg: #0b0d10;
      --tg-surface: #13161b;
      --tg-surface-2: #1a1e25;
      --tg-border: rgba(255,255,255,0.08);
      --tg-border-hi: rgba(255,255,255,0.14);
      --tg-text: #e8eaee;
      --tg-text-2: #9098a4;
      --tg-text-3: #5a6370;
      --tg-green: #4ade80;
      --tg-amber: #f59e0b;
      --tg-red: #ef4444;
      --tg-font-ui: 'Inter', system-ui, -apple-system, sans-serif;
      --tg-font-num: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace;
      --tg-font-hero: 'Fraunces', Georgia, serif;
    }

    @keyframes tg-fade-in      { from { opacity:0 }                                          to { opacity:1 } }
    @keyframes tg-rise         { from { opacity:0; transform:translateY(12px) }              to { opacity:1; transform:translateY(0) } }
    @keyframes tg-toast-in     { from { opacity:0; transform:translateY(8px) }               to { opacity:1; transform:translateY(0) } }
    @keyframes tg-bar-shrink   { from { width:100% }                                         to { width:0% } }
    @keyframes tg-breathe      { 0%,100% { opacity:0.55; transform:scaleX(0.98) } 50% { opacity:1; transform:scaleX(1) } }
    @keyframes tg-shimmer      { 0% { transform:translateX(-120%); opacity:0 } 30% { opacity:0.8 } 70% { opacity:0.8 } 100% { transform:translateX(220%); opacity:0 } }
    @keyframes tg-count-up     { from { opacity:0; transform:translateY(6px) }               to { opacity:1; transform:translateY(0) } }
    @keyframes tg-hue-green    { 0%,100% { filter:hue-rotate(0deg) } 50% { filter:hue-rotate(-8deg) } }
    @keyframes tg-hue-red      { 0%,100% { filter:hue-rotate(0deg) } 50% { filter:hue-rotate(6deg) } }
    @keyframes tg-sig-in       { from { opacity:0 } to { opacity:1 } }
    @keyframes tg-word-in      { from { opacity:0; transform:translateY(8px); filter:blur(2px) } to { opacity:1; transform:translateY(0); filter:blur(0) } }

    /* ── Full-screen backdrop ───────────────────────────────────── */
    .tg-ov-root {
      position: fixed; inset: 0; z-index: 2147483647;
      display: flex; align-items: center; justify-content: center;
      padding: 24px; box-sizing: border-box;
      background: rgba(11,13,16,0.72);
      backdrop-filter: blur(8px) saturate(0.9);
      -webkit-backdrop-filter: blur(8px) saturate(0.9);
      font-family: var(--tg-font-ui);
      animation: tg-fade-in 0.18s ease both;
      color: var(--tg-text);
    }

    /* ── Card shell ─────────────────────────────────────────────── */
    .tg-ov-card {
      width: 100%; max-width: 440px;
      background: var(--tg-surface);
      border: 1px solid var(--tg-border);
      border-radius: 16px;
      padding: 32px 28px 24px;
      position: relative;
      overflow: hidden;
      animation: tg-rise 0.28s cubic-bezier(0.2, 0.8, 0.2, 1) both;
      box-shadow: 0 24px 56px rgba(0,0,0,0.5);
      box-sizing: border-box;
    }
    .tg-ov-card-wide { max-width: 480px; }
    .tg-ov-card > * { position: relative; z-index: 1; }

    /* breathing semantic top-edge accent bar */
    .tg-ov-card::before {
      content: ''; position: absolute; left: 0; right: 0; top: 0;
      height: 2px; border-radius: 16px 16px 0 0;
      transform-origin: center;
      animation: tg-breathe 3.2s ease-in-out infinite;
    }
    .tg-ov-card.tg-amber::before  { background: linear-gradient(90deg, transparent, var(--tg-amber), transparent); }
    .tg-ov-card.tg-red::before    { background: linear-gradient(90deg, transparent, var(--tg-red),   transparent); }
    .tg-ov-card.tg-green::before  { background: linear-gradient(90deg, transparent, var(--tg-green), transparent); }
    .tg-ov-card.tg-neutral::before { background: linear-gradient(90deg, transparent, var(--tg-text-3), transparent); opacity: 0.5; }

    /* one-time shimmer sweep across the card on mount */
    .tg-ov-card::after {
      content: ''; position: absolute; inset: 0 auto 0 0;
      width: 40%; pointer-events: none;
      background: linear-gradient(105deg, transparent 30%, rgba(255,255,255,0.045) 50%, transparent 70%);
      animation: tg-shimmer 1.4s cubic-bezier(0.2,0.8,0.2,1) 0.35s both;
    }

    /* ── Close X ─────────────────────────────────────────────────── */
    .tg-ov-close {
      position: absolute; top: 14px; right: 14px;
      width: 28px; height: 28px; border-radius: 8px;
      border: 1px solid transparent; background: transparent;
      color: var(--tg-text-3); cursor: pointer;
      font-size: 14px; line-height: 1;
      display: flex; align-items: center; justify-content: center;
      transition: color 0.12s, background 0.12s, border-color 0.12s;
    }
    .tg-ov-close:hover { color: var(--tg-text); background: rgba(255,255,255,0.04); border-color: var(--tg-border); }

    /* ── Signature line (rotating one-liner) + brand ─────────────── */
    .tg-ov-signature {
      font-family: var(--tg-font-hero); font-style: italic;
      font-size: 12px; color: var(--tg-text-2);
      margin-top: 22px; padding-top: 14px;
      border-top: 1px solid var(--tg-border);
      letter-spacing: -0.005em;
      animation: tg-sig-in 0.6s ease 0.4s both;
      position: relative; z-index: 1;
    }
    .tg-ov-brand {
      display: flex; align-items: center; gap: 6px;
      font-size: 10px; font-family: var(--tg-font-num);
      color: var(--tg-text-3); letter-spacing: 0.08em;
      text-transform: uppercase; margin-top: 10px;
      position: relative; z-index: 1;
    }
    .tg-ov-brand-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--tg-green); }

    /* ── Eyebrow label (tiny, above heading) ────────────────────── */
    .tg-ov-eyebrow {
      font-size: 10px; font-family: var(--tg-font-num); font-weight: 500;
      letter-spacing: 0.14em; text-transform: uppercase;
      margin-bottom: 14px;
    }
    .tg-ov-eyebrow.tg-amber { color: var(--tg-amber); }
    .tg-ov-eyebrow.tg-red   { color: var(--tg-red); }
    .tg-ov-eyebrow.tg-green { color: var(--tg-green); }
    .tg-ov-eyebrow.tg-neutral { color: var(--tg-text-2); }

    /* ── Heading (hero) ─────────────────────────────────────────── */
    .tg-ov-heading {
      font-family: var(--tg-font-hero);
      font-weight: 500;
      font-size: 42px; line-height: 1.05;
      letter-spacing: -0.02em;
      margin: 0 0 10px;
      color: var(--tg-text);
    }
    /* staggered word reveal */
    .tg-ov-heading .tg-word,
    .tg-ov-heading-sm .tg-word {
      display: inline-block;
      opacity: 0;
      animation: tg-word-in 0.55s cubic-bezier(0.2, 0.8, 0.2, 1) both;
      animation-delay: calc(var(--tg-word-i, 0) * 55ms + 120ms);
    }
    .tg-ov-heading-sm {
      font-family: var(--tg-font-hero);
      font-weight: 500;
      font-size: 28px; line-height: 1.15;
      letter-spacing: -0.015em;
      margin: 0 0 8px;
      color: var(--tg-text);
    }

    /* ── Body text ──────────────────────────────────────────────── */
    .tg-ov-lede {
      font-size: 14px; line-height: 1.55; color: var(--tg-text-2);
      margin: 0 0 20px;
    }
    .tg-ov-lede b, .tg-ov-lede strong { color: var(--tg-text); font-weight: 600; }

    /* ── Reason block (the "why") ───────────────────────────────── */
    .tg-ov-reason {
      background: var(--tg-surface-2);
      border: 1px solid var(--tg-border);
      border-left: 2px solid var(--tg-red);
      border-radius: 8px;
      padding: 12px 14px;
      font-size: 13px; color: var(--tg-text);
      line-height: 1.5;
      margin: 0 0 20px;
    }
    .tg-ov-reason.tg-amber { border-left-color: var(--tg-amber); }

    /* ── Facts grid (compact key/value rows) ────────────────────── */
    .tg-ov-facts {
      display: grid; grid-template-columns: repeat(2, 1fr);
      gap: 1px;
      background: var(--tg-border);
      border: 1px solid var(--tg-border);
      border-radius: 8px;
      overflow: hidden;
      margin: 0 0 20px;
    }
    .tg-ov-fact { background: var(--tg-surface); padding: 10px 12px; }
    .tg-ov-fact-lbl {
      font-size: 10px; font-family: var(--tg-font-num);
      color: var(--tg-text-3); letter-spacing: 0.08em;
      text-transform: uppercase; margin-bottom: 4px;
    }
    .tg-ov-fact-val {
      font-size: 14px; font-family: var(--tg-font-num);
      color: var(--tg-text); font-weight: 500;
      line-height: 1.2;
    }
    .tg-ov-fact-val.tg-green { color: var(--tg-green); }
    .tg-ov-fact-val.tg-red   { color: var(--tg-red); }
    .tg-ov-fact-val.tg-amber { color: var(--tg-amber); }
    .tg-ov-fact-val.tg-muted { color: var(--tg-text-2); }

    /* ── P&L hero (for trade closed) ────────────────────────────── */
    .tg-ov-pnl {
      margin: 0 0 20px;
    }
    .tg-ov-pnl-lbl {
      font-size: 10px; font-family: var(--tg-font-num);
      letter-spacing: 0.14em; text-transform: uppercase;
      color: var(--tg-text-3); margin-bottom: 6px;
    }
    .tg-ov-pnl-val {
      font-family: var(--tg-font-num);
      font-size: 38px; font-weight: 600;
      letter-spacing: -0.02em; line-height: 1;
      animation: tg-count-up 0.5s cubic-bezier(0.2,0.8,0.2,1) 0.15s both;
    }
    .tg-ov-pnl-val.tg-green { color: var(--tg-green); animation: tg-count-up 0.5s cubic-bezier(0.2,0.8,0.2,1) 0.15s both, tg-hue-green 4s ease-in-out 0.7s infinite; }
    .tg-ov-pnl-val.tg-red   { color: var(--tg-red);   animation: tg-count-up 0.5s cubic-bezier(0.2,0.8,0.2,1) 0.15s both, tg-hue-red 4s ease-in-out 0.7s infinite; }
    .tg-ov-pnl-val.tg-muted { color: var(--tg-text-2); }

    /* ── Buttons ─────────────────────────────────────────────────── */
    .tg-ov-actions { display: flex; gap: 8px; margin: 0; }
    .tg-ov-btn {
      flex: 1;
      height: 42px;
      padding: 0 16px;
      border-radius: 10px;
      font-size: 13px; font-weight: 600;
      font-family: var(--tg-font-ui);
      cursor: pointer;
      border: 1px solid transparent;
      display: inline-flex; align-items: center; justify-content: center;
      gap: 6px;
      transition: background 0.12s, border-color 0.12s, color 0.12s, opacity 0.12s;
      white-space: nowrap;
    }
    .tg-ov-btn:focus-visible { outline: 2px solid rgba(96,165,250,0.5); outline-offset: 2px; }
    .tg-ov-btn-primary {
      background: var(--tg-text); color: var(--tg-bg); border-color: var(--tg-text);
    }
    .tg-ov-btn-primary:hover { background: #ffffff; border-color: #ffffff; }
    .tg-ov-btn-primary.tg-amber { background: var(--tg-amber); border-color: var(--tg-amber); color: #14100a; }
    .tg-ov-btn-primary.tg-amber:hover { background: #fbbf24; border-color: #fbbf24; }
    .tg-ov-btn-primary.tg-red { background: var(--tg-red); border-color: var(--tg-red); color: #140a0a; }
    .tg-ov-btn-primary.tg-red:hover { background: #f87171; border-color: #f87171; }
    .tg-ov-btn-primary.tg-green { background: var(--tg-green); border-color: var(--tg-green); color: #0a1410; }
    .tg-ov-btn-primary.tg-green:hover { background: #86efac; border-color: #86efac; }
    .tg-ov-btn-ghost {
      background: transparent; color: var(--tg-text-2); border-color: var(--tg-border);
    }
    .tg-ov-btn-ghost:hover { color: var(--tg-text); border-color: var(--tg-border-hi); background: rgba(255,255,255,0.02); }
    .tg-ov-btn[disabled] { opacity: 0.4; cursor: not-allowed; }

    /* ── Override link (subtle, dangerous) ──────────────────────── */
    .tg-ov-override-link {
      display: block;
      margin-top: 14px;
      text-align: center;
      font-size: 11px;
      font-family: var(--tg-font-num);
      letter-spacing: 0.06em;
      color: var(--tg-text-3);
      background: none; border: none; cursor: pointer;
      padding: 6px 8px;
      text-decoration: underline;
      text-decoration-color: rgba(255,255,255,0.1);
      text-underline-offset: 3px;
      transition: color 0.12s, text-decoration-color 0.12s;
    }
    .tg-ov-override-link:hover { color: var(--tg-text-2); text-decoration-color: rgba(255,255,255,0.25); }

    /* ── Override confirm row (friction) ─────────────────────────── */
    .tg-ov-override-box {
      margin-top: 12px;
      padding: 14px;
      background: var(--tg-surface-2);
      border: 1px solid var(--tg-border);
      border-radius: 10px;
      animation: tg-rise 0.2s ease both;
    }
    .tg-ov-override-hint {
      font-size: 11px; color: var(--tg-text-3);
      font-family: var(--tg-font-num); letter-spacing: 0.04em;
      margin-bottom: 8px;
    }
    .tg-ov-override-hint code {
      color: var(--tg-red); font-weight: 600; letter-spacing: 0.1em;
    }
    .tg-ov-override-input {
      width: 100%;
      height: 38px;
      padding: 0 12px;
      background: var(--tg-bg);
      border: 1px solid var(--tg-border);
      border-radius: 8px;
      color: var(--tg-text);
      font-family: var(--tg-font-num);
      font-size: 13px; letter-spacing: 0.1em;
      outline: none;
      transition: border-color 0.12s;
      box-sizing: border-box;
    }
    .tg-ov-override-input:focus { border-color: var(--tg-red); }
    .tg-ov-override-actions { display: flex; gap: 8px; margin-top: 10px; }

    /* ── Pre-trade balance hero + update form ───────────────────── */
    .tg-ov-balance {
      display: flex; align-items: baseline; gap: 10px;
      margin: 0 0 6px;
    }
    .tg-ov-balance-lbl {
      font-size: 10px; font-family: var(--tg-font-num); font-weight: 500;
      letter-spacing: 0.14em; text-transform: uppercase;
      color: var(--tg-text-3);
    }
    .tg-ov-balance-val {
      font-family: var(--tg-font-num);
      font-size: 36px; font-weight: 600;
      letter-spacing: -0.02em; line-height: 1;
      color: var(--tg-text);
      animation: tg-count-up 0.5s cubic-bezier(0.2,0.8,0.2,1) 0.15s both;
    }
    .tg-ov-balance-edit {
      background: transparent; border: 1px solid var(--tg-border);
      color: var(--tg-text-2); font-size: 11px;
      font-family: var(--tg-font-num); letter-spacing: 0.04em;
      padding: 4px 8px; border-radius: 6px;
      cursor: pointer;
      transition: color 0.12s, border-color 0.12s, background 0.12s;
      margin-left: auto;
    }
    .tg-ov-balance-edit:hover { color: var(--tg-text); border-color: var(--tg-border-hi); background: rgba(255,255,255,0.02); }

    .tg-ov-balance-edit-box {
      margin: 8px 0 16px;
      padding: 12px;
      background: var(--tg-surface-2);
      border: 1px solid var(--tg-border);
      border-radius: 10px;
      animation: tg-rise 0.2s ease both;
    }
    .tg-ov-balance-edit-hint {
      font-size: 11px; color: var(--tg-text-3);
      font-family: var(--tg-font-num); letter-spacing: 0.04em;
      margin-bottom: 8px;
    }
    .tg-ov-balance-edit-row {
      display: flex; gap: 8px; align-items: center;
    }
    .tg-ov-balance-edit-input {
      flex: 1;
      height: 36px;
      padding: 0 12px;
      background: var(--tg-bg);
      border: 1px solid var(--tg-border);
      border-radius: 8px;
      color: var(--tg-text);
      font-family: var(--tg-font-num);
      font-size: 14px; letter-spacing: 0.02em;
      outline: none;
      transition: border-color 0.12s;
      box-sizing: border-box;
    }
    .tg-ov-balance-edit-input:focus { border-color: var(--tg-text-2); }
    .tg-ov-balance-edit-input:disabled { opacity: 0.5; }
    .tg-ov-balance-edit-save {
      height: 36px; padding: 0 14px;
      background: var(--tg-text); color: var(--tg-bg);
      border: 1px solid var(--tg-text); border-radius: 8px;
      font-size: 12px; font-weight: 600;
      font-family: var(--tg-font-ui); cursor: pointer;
      transition: background 0.12s, opacity 0.12s;
    }
    .tg-ov-balance-edit-save:hover { background: #ffffff; }
    .tg-ov-balance-edit-save[disabled] { opacity: 0.4; cursor: not-allowed; }
    .tg-ov-balance-edit-error {
      margin-top: 6px; font-size: 11px; color: var(--tg-red);
      font-family: var(--tg-font-ui);
    }

    /* Side pill (BUY / SELL) */
    .tg-ov-side-pill {
      display: inline-block;
      padding: 2px 8px; border-radius: 999px;
      font-family: var(--tg-font-num);
      font-size: 10px; font-weight: 600;
      letter-spacing: 0.12em; text-transform: uppercase;
      margin-left: 6px;
      border: 1px solid currentColor;
    }
    .tg-ov-side-pill.tg-green { color: var(--tg-green); }
    .tg-ov-side-pill.tg-red   { color: var(--tg-red); }

    /* ── Countdown bar (trade closed auto-dismiss) ──────────────── */
    .tg-ov-countdown {
      margin: 0 0 16px;
    }
    .tg-ov-countdown-track {
      height: 2px; background: var(--tg-border);
      border-radius: 999px; overflow: hidden;
    }
    .tg-ov-countdown-fill { height: 100%; background: var(--tg-text-3); animation: tg-bar-shrink linear both; }
    .tg-ov-countdown-fill.tg-red   { background: var(--tg-red); opacity: 0.6; }
    .tg-ov-countdown-fill.tg-green { background: var(--tg-green); opacity: 0.6; }

    /* ═════════════════════════════════════════════════════════════
       Toast (bottom-right, minimal)
    ═════════════════════════════════════════════════════════════ */
    .tg-toast {
      position: fixed; right: 16px; bottom: 16px;
      z-index: 2147483646;
      width: min(360px, calc(100vw - 24px));
      background: var(--tg-surface);
      border: 1px solid var(--tg-border);
      border-radius: 12px;
      padding: 12px 14px;
      display: flex; gap: 10px; align-items: flex-start;
      font-family: var(--tg-font-ui);
      color: var(--tg-text);
      box-shadow: 0 16px 40px rgba(0,0,0,0.4);
      animation: tg-toast-in 0.22s cubic-bezier(0.2,0.8,0.2,1) both;
      transition: opacity 0.2s ease, transform 0.2s ease;
    }
    .tg-toast-dot {
      width: 8px; height: 8px; border-radius: 50%;
      margin-top: 6px; flex-shrink: 0;
    }
    .tg-toast-dot.info  { background: var(--tg-green); }
    .tg-toast-dot.warn  { background: var(--tg-amber); }
    .tg-toast-dot.error { background: var(--tg-red); }
    .tg-toast-body { flex: 1; min-width: 0; }
    .tg-toast-title {
      font-size: 12px; font-weight: 600;
      color: var(--tg-text); margin-bottom: 2px;
      line-height: 1.3;
    }
    .tg-toast-msg {
      font-size: 12px; color: var(--tg-text-2);
      line-height: 1.45; word-wrap: break-word;
    }
    .tg-toast-close {
      background: transparent; border: none; cursor: pointer;
      color: var(--tg-text-3); font-size: 13px; line-height: 1;
      padding: 2px 4px; border-radius: 6px; flex-shrink: 0;
      transition: color 0.12s, background 0.12s;
    }
    .tg-toast-close:hover { color: var(--tg-text); background: rgba(255,255,255,0.04); }
    .tg-toast-bar {
      position: absolute; left: 0; right: 0; bottom: 0;
      height: 2px;
      border-radius: 0 0 12px 12px;
      overflow: hidden;
      background: rgba(255,255,255,0.04);
    }
    .tg-toast-bar-fill {
      height: 100%;
      animation: tg-bar-shrink linear both;
    }
    .tg-toast-bar-fill.info  { background: var(--tg-green); opacity: 0.5; }
    .tg-toast-bar-fill.warn  { background: var(--tg-amber); opacity: 0.5; }
    .tg-toast-bar-fill.error { background: var(--tg-red);   opacity: 0.5; }

    /* ── Small-screen ────────────────────────────────────────────── */
    @media (max-width: 520px) {
      .tg-ov-root { align-items: flex-end; padding: 12px; }
      .tg-ov-card, .tg-ov-card-wide { max-width: 100%; border-radius: 14px; padding: 24px 20px 20px; }
      .tg-ov-heading { font-size: 36px; }
      .tg-ov-facts { grid-template-columns: 1fr; }
      .tg-ov-actions { flex-direction: column; }
      .tg-toast { left: 12px; right: 12px; bottom: 12px; width: auto; }
    }
  `;
  document.head.appendChild(s);
}

/* ─── DOM helpers ────────────────────────────────────────────────────────── */
function _el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function _closeX(root) {
  const x = _el('button', 'tg-ov-close');
  x.type = 'button';
  x.setAttribute('aria-label', 'Close');
  x.textContent = '✕';
  x.addEventListener('click', () => root.remove());
  return x;
}

function _brand() {
  const b = _el('div', 'tg-ov-brand');
  const dot = _el('div', 'tg-ov-brand-dot');
  const t = document.createElement('span');
  t.textContent = 'TradeGuardX · Advisory only';
  b.appendChild(dot); b.appendChild(t);
  return b;
}

/* Rotating signature one-liners — shareable moments. */
const SIGNATURES = {
  block: [
    'Your past self is looking out for present you.',
    'The rule you set on a calmer day just spoke up.',
    'Impulse: 0. Discipline: 1.',
    'You wrote this rule for a reason. The reason just showed up.',
  ],
  warn: [
    'The small nudge beats the big regret.',
    'A pause is still progress.',
    'One check now saves a journal entry later.',
  ],
  profit: [
    'A win is easier to repeat when you remember why.',
    'Take the W. Write down what worked.',
    'Edge is boring on purpose.',
    'Plan respected. Next.',
  ],
  loss: [
    'The loss is real. The lesson is free.',
    'Write one line. The next trade starts clean.',
    'Call it tuition. Log the receipt.',
    'One trade doesn’t define a month.',
  ],
  neutral: [
    'Clean exit. Small discipline compounds.',
    'Noted. Next.',
  ],
  sl: [
    'No stop, no plan, no net.',
    'Markets don’t schedule meetings.',
    'Define your exit before the market defines it for you.',
  ],
};
function _signature(kind) {
  const pool = SIGNATURES[kind] || SIGNATURES.neutral;
  const line = pool[Math.floor(Math.random() * pool.length)];
  const d = _el('div', 'tg-ov-signature');
  d.textContent = `“${line}”`;
  return d;
}

function _fact(label, value, tone) {
  const f = _el('div', 'tg-ov-fact');
  const l = _el('div', 'tg-ov-fact-lbl'); l.textContent = label;
  const v = _el('div', `tg-ov-fact-val${tone ? ' ' + tone : ''}`); v.textContent = value;
  f.appendChild(l); f.appendChild(v);
  return f;
}

function _formatCurrency(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '–';
  return Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function _fmtOr(v, fallback = '–') {
  if (v === null || v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return _formatCurrency(n);
}

/** Render heading text with each word wrapped in a span for staggered reveal. */
function _setHeadingText(el, text) {
  if (!el) return;
  el.textContent = '';
  const words = String(text || '').split(/(\s+)/); // keep whitespace between words
  let idx = 0;
  words.forEach((chunk) => {
    if (!chunk) return;
    if (/^\s+$/.test(chunk)) {
      el.appendChild(document.createTextNode(chunk));
      return;
    }
    const span = document.createElement('span');
    span.className = 'tg-word';
    span.style.setProperty('--tg-word-i', String(idx++));
    span.textContent = chunk;
    el.appendChild(span);
  });
}

/**
 * Animate a currency number from 0 → target over ~600ms.
 * Formats as `±$123.45`. Keeps sign style consistent with caller.
 */
function _animateCurrency(el, target, { duration = 650, signStyle = 'plusminus' } = {}) {
  if (!el || !Number.isFinite(Number(target))) return;
  const finalVal = Number(target);
  const prefersReduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  const render = (v) => {
    const abs = Math.abs(v);
    const formatted = `$${_formatCurrency(abs)}`;
    let sign = '';
    if (signStyle === 'plusminus') sign = v >= 0 ? '+' : '−';
    else if (signStyle === 'minusOnly') sign = v < 0 ? '−' : '';
    el.textContent = `${sign}${formatted}`;
  };
  if (prefersReduced || duration <= 0) {
    render(finalVal);
    return;
  }
  const start = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 3); // easeOutCubic
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const v = finalVal * ease(t);
    render(v);
    if (t < 1) requestAnimationFrame(step);
    else render(finalVal);
  };
  requestAnimationFrame(step);
}

/* ═══════════════════════════════════════════════════════════════════════════
   showWarningOverlay — generic rule warning (advisory, not blocking)
═══════════════════════════════════════════════════════════════════════════ */
function showWarningOverlay({ title, message, highlight } = {}) {
  _injectStyles();

  const existing = document.getElementById(OVERLAY_ID);
  if (existing) {
    const t = existing.querySelector('[data-tg-w-title]');
    const m = existing.querySelector('[data-tg-w-msg]');
    if (t && title)   _setHeadingText(t, title);
    if (m && message) m.textContent = message;
    if (highlight) flashScreen();
    return;
  }

  const root = _el('div', 'tg-ov-root'); root.id = OVERLAY_ID;
  const card = _el('div', 'tg-ov-card tg-amber');
  card.appendChild(_closeX(root));

  const eyebrow = _el('div', 'tg-ov-eyebrow tg-amber');
  eyebrow.textContent = 'Heads up';
  card.appendChild(eyebrow);

  const h = _el('h2', 'tg-ov-heading-sm');
  h.setAttribute('data-tg-w-title', '');
  _setHeadingText(h, title || 'Worth a second look.');
  card.appendChild(h);

  const lede = _el('p', 'tg-ov-lede');
  lede.setAttribute('data-tg-w-msg', '');
  lede.textContent = message || 'A rule flagged this. A ten-second check now beats a ten-line journal entry later.';
  card.appendChild(lede);

  const actions = _el('div', 'tg-ov-actions');
  const ack = _el('button', 'tg-ov-btn tg-ov-btn-primary tg-amber');
  ack.type = 'button';
  ack.textContent = 'Noted — carry on';
  ack.addEventListener('click', () => root.remove());
  actions.appendChild(ack);
  card.appendChild(actions);

  card.appendChild(_signature('warn'));
  card.appendChild(_brand());
  root.appendChild(card);
  document.documentElement.appendChild(root);

  if (highlight) flashScreen();
}

/* ═══════════════════════════════════════════════════════════════════════════
   showNoStopLossOverlay — persistent reminder when a position lacks SL
═══════════════════════════════════════════════════════════════════════════ */
function showNoStopLossOverlay({
  symbol = null,
  stopLoss = null,
  takeProfit = null,
  message = null,
  onSetStopLoss = null,
  repeatIntervalSeconds = 30,
} = {}) {
  _injectStyles();
  document.getElementById(NO_SL_OVERLAY_ID)?.remove();

  const slN = Number(stopLoss);
  const tpN = Number(takeProfit);
  const slTx = Number.isFinite(slN) && slN > 0 ? _formatCurrency(slN) : 'Not set';
  const tpTx = Number.isFinite(tpN) && tpN > 0 ? _formatCurrency(tpN) : 'Not set';
  const slMissing = slTx === 'Not set';

  const repeatSec = Number.isFinite(Number(repeatIntervalSeconds)) && Number(repeatIntervalSeconds) > 0
    ? Math.round(Number(repeatIntervalSeconds))
    : 30;

  const root = _el('div', 'tg-ov-root'); root.id = NO_SL_OVERLAY_ID;
  const card = _el('div', 'tg-ov-card tg-amber');
  card.appendChild(_closeX(root));

  const eyebrow = _el('div', 'tg-ov-eyebrow tg-amber');
  eyebrow.textContent = 'No stop loss';
  card.appendChild(eyebrow);

  const h = _el('h2', 'tg-ov-heading-sm');
  _setHeadingText(h, symbol ? `${symbol} is swimming without floaties.` : 'Swimming without floaties.');
  card.appendChild(h);

  const lede = _el('p', 'tg-ov-lede');
  lede.innerHTML = 'No stop means <b>no exit plan</b>. The market doesn’t wait for you to pick one.';
  card.appendChild(lede);

  const facts = _el('div', 'tg-ov-facts');
  facts.appendChild(_fact('Symbol',      symbol || '–', ''));
  facts.appendChild(_fact('Stop loss',   slTx, slMissing ? 'tg-red' : 'tg-amber'));
  facts.appendChild(_fact('Take profit', tpTx, 'tg-muted'));
  facts.appendChild(_fact('Repeats in',  `${repeatSec}s`, 'tg-muted'));
  card.appendChild(facts);

  if (message) {
    const note = _el('div', 'tg-ov-reason tg-amber');
    note.textContent = message;
    card.appendChild(note);
  }

  const actions = _el('div', 'tg-ov-actions');
  const dismiss = _el('button', 'tg-ov-btn tg-ov-btn-ghost');
  dismiss.type = 'button';
  dismiss.textContent = 'In a bit';
  dismiss.addEventListener('click', () => root.remove());
  const setSl = _el('button', 'tg-ov-btn tg-ov-btn-primary tg-amber');
  setSl.type = 'button';
  setSl.textContent = 'Set it now →';
  setSl.addEventListener('click', () => {
    if (typeof onSetStopLoss === 'function') {
      try { onSetStopLoss(); } catch (_) {}
    }
    root.remove();
  });
  actions.appendChild(dismiss); actions.appendChild(setSl);
  card.appendChild(actions);

  card.appendChild(_signature('sl'));
  card.appendChild(_brand());
  root.appendChild(card);
  document.documentElement.appendChild(root);
}

/* ═══════════════════════════════════════════════════════════════════════════
   showBlockedTradeOverlay — full-screen stop, with optional override friction
═══════════════════════════════════════════════════════════════════════════ */
function showBlockedTradeOverlay(reason, config, options) {
  _injectStyles();
  document.getElementById(BLOCKED_OVERLAY_ID)?.remove();

  const isConfirm   = options?.confirmMode === true && typeof options?.onContinue === 'function';
  const titleText   = options?.title || (isConfirm ? 'Wait a sec.' : 'Nice try.');
  const reasonText  = String(reason || '').trim() || 'A protection rule prevented this trade.';

  const root = _el('div', 'tg-ov-root'); root.id = BLOCKED_OVERLAY_ID;
  const card = _el('div', 'tg-ov-card tg-red');

  if (!isConfirm) card.appendChild(_closeX(root));

  const eyebrow = _el('div', 'tg-ov-eyebrow tg-red');
  eyebrow.textContent = isConfirm ? 'Worth a second thought' : 'Your rule caught this';
  card.appendChild(eyebrow);

  const h = _el('h2', 'tg-ov-heading');
  _setHeadingText(h, titleText);
  card.appendChild(h);

  const lede = _el('p', 'tg-ov-lede');
  lede.textContent = isConfirm
    ? 'You set this rule yourself. Override if you truly mean it — type OVERRIDE so it’s a decision, not a reflex.'
    : 'You set this rule yourself. Present-you will be thankful in about three candles.';
  card.appendChild(lede);

  const reasonBox = _el('div', 'tg-ov-reason');
  reasonBox.textContent = reasonText;
  card.appendChild(reasonBox);

  /* actions */
  const actions = _el('div', 'tg-ov-actions');
  const cancel = _el('button', 'tg-ov-btn tg-ov-btn-primary tg-green');
  cancel.type = 'button';
  cancel.textContent = isConfirm ? 'Good call — cancel' : 'Thanks, past me';
  cancel.addEventListener('click', () => root.remove());
  actions.appendChild(cancel);
  card.appendChild(actions);

  /* override path (confirm-mode only) */
  if (isConfirm) {
    const overrideLink = _el('button', 'tg-ov-override-link');
    overrideLink.type = 'button';
    overrideLink.textContent = 'I know what I’m doing →';

    const box = _el('div', 'tg-ov-override-box');
    box.style.display = 'none';

    const hint = _el('div', 'tg-ov-override-hint');
    hint.innerHTML = 'Type <code>OVERRIDE</code> — make this a decision, not a reflex.';
    box.appendChild(hint);

    const input = _el('input', 'tg-ov-override-input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'OVERRIDE';
    box.appendChild(input);

    const subActions = _el('div', 'tg-ov-override-actions');
    const back = _el('button', 'tg-ov-btn tg-ov-btn-ghost');
    back.type = 'button';
    back.textContent = 'Never mind';
    const go = _el('button', 'tg-ov-btn tg-ov-btn-primary tg-red');
    go.type = 'button';
    go.textContent = `Continue in ${Math.round(OVERRIDE_COOLDOWN_MS / 1000)}s`;
    go.disabled = true;
    subActions.appendChild(back); subActions.appendChild(go);
    box.appendChild(subActions);

    card.appendChild(overrideLink);
    card.appendChild(box);

    let cooldownTimer = null;
    let cooldownEnd = 0;
    let typedOk = false;

    const refreshGoState = () => {
      const now = Date.now();
      const remaining = Math.max(0, cooldownEnd - now);
      if (remaining > 0) {
        go.disabled = true;
        go.textContent = `Continue in ${Math.ceil(remaining / 1000)}s`;
      } else if (!typedOk) {
        go.disabled = true;
        go.textContent = 'Continue';
      } else {
        go.disabled = false;
        go.textContent = 'Continue anyway';
      }
    };

    overrideLink.addEventListener('click', () => {
      overrideLink.style.display = 'none';
      cancel.textContent = 'Cancel';
      box.style.display = 'block';
      cooldownEnd = Date.now() + OVERRIDE_COOLDOWN_MS;
      refreshGoState();
      if (cooldownTimer) clearInterval(cooldownTimer);
      cooldownTimer = setInterval(() => {
        refreshGoState();
        if (Date.now() >= cooldownEnd) {
          clearInterval(cooldownTimer);
          cooldownTimer = null;
        }
      }, 250);
      setTimeout(() => input.focus(), 40);
    });

    input.addEventListener('input', () => {
      typedOk = input.value.trim().toUpperCase() === 'OVERRIDE';
      refreshGoState();
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !go.disabled) go.click();
      if (e.key === 'Escape') back.click();
    });

    back.addEventListener('click', () => {
      if (cooldownTimer) { clearInterval(cooldownTimer); cooldownTimer = null; }
      box.style.display = 'none';
      overrideLink.style.display = 'block';
      cancel.textContent = 'Cancel trade';
      input.value = '';
      typedOk = false;
    });

    go.addEventListener('click', () => {
      if (go.disabled) return;
      if (cooldownTimer) { clearInterval(cooldownTimer); cooldownTimer = null; }
      try { options.onContinue(); } catch (_) {}
      root.remove();
    });
  }

  card.appendChild(_signature('block'));
  card.appendChild(_brand());
  root.appendChild(card);
  document.documentElement.appendChild(root);

  flashScreen();
}

/* ═══════════════════════════════════════════════════════════════════════════
   showTradeClosedOverlay — reflective close summary (profit / loss / neutral)
═══════════════════════════════════════════════════════════════════════════ */
function showTradeClosedOverlay({
  outcome = 'CLOSED',
  symbol = null,
  side = null,
  volume = null,
  entryPrice = null,
  currentPrice = null,
  stopLoss = null,
  takeProfit = null,
  pnl = null,
  closedAt = null,
} = {}) {
  _injectStyles();
  document.getElementById(TRADE_CLOSED_OVERLAY_ID)?.remove();

  const DISMISS_MS = 45000;
  const state    = String(outcome || '').toUpperCase();
  const isLoss   = state === 'LOSS';
  const isProfit = state === 'PROFIT';
  const pnlNum   = Number.isFinite(Number(pnl)) ? Number(pnl) : null;

  const tone     = isLoss ? 'tg-red' : isProfit ? 'tg-green' : 'tg-neutral';
  const sigKind  = isLoss ? 'loss' : isProfit ? 'profit' : 'neutral';
  const eyebrowTxt = isLoss ? 'Loss booked' : isProfit ? 'W booked' : 'Position closed';
  const eyebrowCls = isLoss ? 'tg-red' : isProfit ? 'tg-green' : 'tg-neutral';
  const heading    = isLoss
    ? 'Call it tuition.'
    : isProfit
      ? 'Nice one.'
      : (symbol ? `${symbol} is done.` : 'Position closed.');
  const lede = isLoss
    ? 'The loss is real. The lesson is free. Write one line while it’s fresh.'
    : isProfit
      ? 'Was this the plan working — or the market being kind? Be honest.'
      : 'Wrap it up. Review the details in your journal when you have a minute.';

  const root = _el('div', 'tg-ov-root'); root.id = TRADE_CLOSED_OVERLAY_ID;
  const card = _el('div', `tg-ov-card tg-ov-card-wide ${tone}`);
  card.appendChild(_closeX(root));

  const eyebrow = _el('div', `tg-ov-eyebrow ${eyebrowCls}`);
  eyebrow.textContent = eyebrowTxt;
  card.appendChild(eyebrow);

  const h = _el('h2', 'tg-ov-heading-sm');
  _setHeadingText(h, heading);
  card.appendChild(h);

  const ledeEl = _el('p', 'tg-ov-lede');
  ledeEl.textContent = lede;
  card.appendChild(ledeEl);

  /* P&L hero */
  const pnlWrap = _el('div', 'tg-ov-pnl');
  const pnlLbl  = _el('div', 'tg-ov-pnl-lbl'); pnlLbl.textContent = 'Realized P&L';
  const pnlVal  = _el('div', `tg-ov-pnl-val ${isLoss ? 'tg-red' : isProfit ? 'tg-green' : 'tg-muted'}`);
  if (pnlNum == null) {
    pnlVal.textContent = '–';
  } else {
    // seed with zero so the digit-roll feels like it climbs from nothing
    pnlVal.textContent = pnlNum >= 0 ? '+$0.00' : '−$0.00';
    // delay start until card rise animation is mostly done
    setTimeout(() => _animateCurrency(pnlVal, pnlNum, { duration: 750, signStyle: 'plusminus' }), 300);
  }
  pnlWrap.appendChild(pnlLbl); pnlWrap.appendChild(pnlVal);
  card.appendChild(pnlWrap);

  /* facts */
  const facts = _el('div', 'tg-ov-facts');
  facts.appendChild(_fact('Symbol', symbol || '–', ''));
  facts.appendChild(_fact('Side',   side || '–', side === 'BUY' ? 'tg-green' : side === 'SELL' ? 'tg-red' : ''));
  facts.appendChild(_fact('Size',   volume != null ? String(volume) : '–', 'tg-muted'));
  facts.appendChild(_fact('Entry',  _fmtOr(entryPrice),   'tg-muted'));
  facts.appendChild(_fact('Close',  _fmtOr(currentPrice), isLoss ? 'tg-red' : isProfit ? 'tg-green' : 'tg-muted'));
  facts.appendChild(_fact('Stop',   _fmtOr(stopLoss),     'tg-muted'));
  card.appendChild(facts);

  /* countdown */
  const cd = _el('div', 'tg-ov-countdown');
  const track = _el('div', 'tg-ov-countdown-track');
  const fill  = _el('div', `tg-ov-countdown-fill ${isLoss ? 'tg-red' : isProfit ? 'tg-green' : ''}`);
  fill.style.animationDuration = `${DISMISS_MS}ms`;
  track.appendChild(fill);
  cd.appendChild(track);
  card.appendChild(cd);

  /* actions */
  const actions = _el('div', 'tg-ov-actions');
  const btnCls = isProfit ? 'tg-ov-btn tg-ov-btn-primary tg-green' : isLoss ? 'tg-ov-btn tg-ov-btn-primary' : 'tg-ov-btn tg-ov-btn-ghost';
  const done = _el('button', btnCls);
  done.type = 'button';
  done.textContent = isLoss ? 'Log one line →' : isProfit ? 'Take the W' : 'Got it';
  done.addEventListener('click', () => root.remove());
  actions.appendChild(done);
  card.appendChild(actions);

  card.appendChild(_signature(sigKind));
  card.appendChild(_brand());
  root.appendChild(card);
  document.documentElement.appendChild(root);

  clearTimeout(root._ac);
  root._ac = setTimeout(() => root.remove(), DISMISS_MS);
  // Suppress unused-var warning for closedAt (accepted for signature compat)
  void closedAt; void takeProfit;
}

/* ═══════════════════════════════════════════════════════════════════════════
   showPreTradeConfirmation — pause before every buy/sell click.
   Shows the balance the rules are evaluated against and the day's headroom,
   lets the user tweak the balance inline (funded mode), then confirm or cancel.
═══════════════════════════════════════════════════════════════════════════ */
function showPreTradeConfirmation({
  side = null,
  symbol = null,
  balance = null,
  dailyLossLimit = null,    // positive dollar number (absolute)
  totalLossLimit = null,    // positive dollar number (absolute), optional
  maxTradesPerDay = null,   // optional
  tradesToday = 0,
  closedPnlToday = null,
  allowBalanceEdit = false, // true for funded-mode accounts
  onConfirm = null,
  onCancel = null,
  onUpdateBalance = null,
} = {}) {
  _injectStyles();
  document.getElementById(PRE_TRADE_OVERLAY_ID)?.remove();

  const root = _el('div', 'tg-ov-root'); root.id = PRE_TRADE_OVERLAY_ID;
  const card = _el('div', 'tg-ov-card tg-ov-card-wide tg-neutral');

  /* Build + assemble once; re-render values on balance update by reaching into refs. */
  const refs = {};

  /* Eyebrow + heading */
  const eyebrow = _el('div', 'tg-ov-eyebrow tg-neutral');
  eyebrow.textContent = 'Pre-trade check';
  card.appendChild(eyebrow);

  const h = _el('h2', 'tg-ov-heading-sm');
  const sideUp = String(side || '').toUpperCase();
  const headingTxt = sideUp === 'BUY' || sideUp === 'SELL'
    ? `Ready to ${sideUp.toLowerCase()}${symbol ? ` ${symbol}` : ''}?`
    : 'Ready to click?';
  _setHeadingText(h, headingTxt);
  if (sideUp === 'BUY' || sideUp === 'SELL') {
    const pill = _el('span', `tg-ov-side-pill ${sideUp === 'BUY' ? 'tg-green' : 'tg-red'}`);
    pill.textContent = sideUp;
    h.appendChild(pill);
  }
  card.appendChild(h);

  const lede = _el('p', 'tg-ov-lede');
  lede.textContent = allowBalanceEdit
    ? 'Your rules work off the balance below. Confirm it’s current, tweak if it drifted, then commit.'
    : 'Quick glance at the day’s headroom before you click.';
  card.appendChild(lede);

  /* Balance hero */
  const balanceWrap = _el('div', 'tg-ov-balance');
  const balanceLbl = _el('div', 'tg-ov-balance-lbl'); balanceLbl.textContent = 'Balance';
  const balanceVal = _el('div', 'tg-ov-balance-val');
  refs.balanceVal = balanceVal;
  balanceWrap.appendChild(balanceLbl);
  balanceWrap.appendChild(balanceVal);

  let editBtn = null;
  if (allowBalanceEdit && typeof onUpdateBalance === 'function') {
    editBtn = _el('button', 'tg-ov-balance-edit');
    editBtn.type = 'button';
    editBtn.textContent = 'Update →';
    balanceWrap.appendChild(editBtn);
  }
  card.appendChild(balanceWrap);

  /* Inline edit form (hidden by default) */
  let editBox = null;
  if (allowBalanceEdit && typeof onUpdateBalance === 'function') {
    editBox = _el('div', 'tg-ov-balance-edit-box');
    editBox.style.display = 'none';
    const hint = _el('div', 'tg-ov-balance-edit-hint');
    hint.textContent = 'What’s the true balance right now?';
    editBox.appendChild(hint);
    const row = _el('div', 'tg-ov-balance-edit-row');
    const input = _el('input', 'tg-ov-balance-edit-input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.autocomplete = 'off';
    input.placeholder = '5000.00';
    const save = _el('button', 'tg-ov-balance-edit-save');
    save.type = 'button';
    save.textContent = 'Save';
    save.disabled = true;
    row.appendChild(input);
    row.appendChild(save);
    editBox.appendChild(row);
    const error = _el('div', 'tg-ov-balance-edit-error');
    error.style.display = 'none';
    editBox.appendChild(error);

    const isValid = () => {
      const n = Number(input.value);
      return Number.isFinite(n) && n > 0;
    };
    input.addEventListener('input', () => {
      save.disabled = !isValid();
      error.style.display = 'none';
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !save.disabled) save.click();
      if (e.key === 'Escape') {
        editBox.style.display = 'none';
        if (editBtn) editBtn.style.display = '';
      }
    });

    editBtn.addEventListener('click', () => {
      editBox.style.display = 'block';
      editBtn.style.display = 'none';
      input.value = balance != null ? String(balance) : '';
      // Setting .value programmatically doesn't fire the 'input' event, so sync
      // the Save button state manually — otherwise it stays disabled until the
      // user types something, which blocks quick re-confirmation of the same number.
      save.disabled = !isValid();
      setTimeout(() => { input.focus(); input.select(); }, 40);
    });

    save.addEventListener('click', async () => {
      if (!isValid()) return;
      const newBalance = Number(input.value);
      save.disabled = true;
      input.disabled = true;
      save.textContent = 'Saving…';
      error.style.display = 'none';
      try {
        const updated = await onUpdateBalance(newBalance);
        if (!updated) throw new Error('Update failed');
        _refreshPreTradeDisplay(refs, updated);
        editBox.style.display = 'none';
        if (editBtn) editBtn.style.display = '';
      } catch (err) {
        error.textContent = (err && err.message) || 'Could not save. Try again.';
        error.style.display = 'block';
      } finally {
        save.disabled = false;
        input.disabled = false;
        save.textContent = 'Save';
      }
    });

    card.appendChild(editBox);
  }

  /* Facts grid */
  const facts = _el('div', 'tg-ov-facts');

  const dailyLossFact = _el('div', 'tg-ov-fact');
  dailyLossFact.appendChild(Object.assign(_el('div', 'tg-ov-fact-lbl'), { textContent: 'Max daily loss' }));
  const dailyLossVal = _el('div', 'tg-ov-fact-val tg-red');
  dailyLossFact.appendChild(dailyLossVal);
  refs.dailyLossVal = dailyLossVal;
  facts.appendChild(dailyLossFact);

  const totalLossFact = _el('div', 'tg-ov-fact');
  totalLossFact.appendChild(Object.assign(_el('div', 'tg-ov-fact-lbl'), { textContent: 'Max total loss' }));
  const totalLossVal = _el('div', 'tg-ov-fact-val tg-red');
  totalLossFact.appendChild(totalLossVal);
  refs.totalLossVal = totalLossVal;
  facts.appendChild(totalLossFact);

  const tradesFact = _el('div', 'tg-ov-fact');
  tradesFact.appendChild(Object.assign(_el('div', 'tg-ov-fact-lbl'), { textContent: 'Trades today' }));
  const tradesVal = _el('div', 'tg-ov-fact-val');
  tradesFact.appendChild(tradesVal);
  refs.tradesVal = tradesVal;
  facts.appendChild(tradesFact);

  const pnlFact = _el('div', 'tg-ov-fact');
  pnlFact.appendChild(Object.assign(_el('div', 'tg-ov-fact-lbl'), { textContent: 'Closed P&L today' }));
  const pnlVal = _el('div', 'tg-ov-fact-val');
  pnlFact.appendChild(pnlVal);
  refs.pnlVal = pnlVal;
  facts.appendChild(pnlFact);

  card.appendChild(facts);

  /* Actions */
  const actions = _el('div', 'tg-ov-actions');

  const cancel = _el('button', 'tg-ov-btn tg-ov-btn-ghost');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => {
    root.remove();
    if (typeof onCancel === 'function') { try { onCancel(); } catch (_) {} }
  });

  const confirm = _el('button', 'tg-ov-btn tg-ov-btn-primary tg-green');
  confirm.type = 'button';
  confirm.textContent = 'Looks right — trade';
  confirm.addEventListener('click', () => {
    root.remove();
    if (typeof onConfirm === 'function') { try { onConfirm(); } catch (_) {} }
  });

  actions.appendChild(cancel);
  actions.appendChild(confirm);
  card.appendChild(actions);

  card.appendChild(_signature('warn'));
  card.appendChild(_brand());
  root.appendChild(card);
  document.documentElement.appendChild(root);

  /* Seed display values */
  _refreshPreTradeDisplay(refs, {
    balance,
    dailyLossLimit,
    totalLossLimit,
    maxTradesPerDay,
    tradesToday,
    closedPnlToday,
  });

  /* Auto-focus the confirm button for keyboard users */
  setTimeout(() => confirm.focus(), 120);
  return root;
}

function _refreshPreTradeDisplay(refs, data) {
  if (!refs || !data) return;
  const {
    balance,
    dailyLossLimit,
    totalLossLimit,
    maxTradesPerDay,
    tradesToday,
    closedPnlToday,
  } = data;

  if (refs.balanceVal) {
    refs.balanceVal.textContent = balance != null && Number.isFinite(Number(balance))
      ? `$${_formatCurrency(Number(balance))}`
      : '–';
  }
  if (refs.dailyLossVal) {
    refs.dailyLossVal.textContent = dailyLossLimit != null && Number.isFinite(Number(dailyLossLimit)) && Number(dailyLossLimit) > 0
      ? `−$${_formatCurrency(Number(dailyLossLimit))}`
      : '—';
    if (!(Number.isFinite(Number(dailyLossLimit)) && Number(dailyLossLimit) > 0)) {
      refs.dailyLossVal.classList.remove('tg-red');
      refs.dailyLossVal.classList.add('tg-muted');
    }
  }
  if (refs.totalLossVal) {
    refs.totalLossVal.textContent = totalLossLimit != null && Number.isFinite(Number(totalLossLimit)) && Number(totalLossLimit) > 0
      ? `−$${_formatCurrency(Number(totalLossLimit))}`
      : '—';
    if (!(Number.isFinite(Number(totalLossLimit)) && Number(totalLossLimit) > 0)) {
      refs.totalLossVal.classList.remove('tg-red');
      refs.totalLossVal.classList.add('tg-muted');
    }
  }
  if (refs.tradesVal) {
    const taken = Number(tradesToday) || 0;
    const cap = Number.isFinite(Number(maxTradesPerDay)) && Number(maxTradesPerDay) > 0 ? Number(maxTradesPerDay) : null;
    refs.tradesVal.textContent = cap != null ? `${taken} / ${cap}` : `${taken}`;
    refs.tradesVal.classList.remove('tg-amber', 'tg-red', 'tg-muted');
    if (cap != null) {
      if (taken >= cap) refs.tradesVal.classList.add('tg-red');
      else if (taken >= cap - 1) refs.tradesVal.classList.add('tg-amber');
    }
  }
  if (refs.pnlVal) {
    const p = Number(closedPnlToday);
    if (!Number.isFinite(p) || p === 0) {
      refs.pnlVal.textContent = '$0.00';
      refs.pnlVal.classList.remove('tg-green', 'tg-red');
      refs.pnlVal.classList.add('tg-muted');
    } else {
      refs.pnlVal.textContent = p > 0 ? `+$${_formatCurrency(p)}` : `−$${_formatCurrency(Math.abs(p))}`;
      refs.pnlVal.classList.remove('tg-muted');
      refs.pnlVal.classList.toggle('tg-green', p > 0);
      refs.pnlVal.classList.toggle('tg-red', p < 0);
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   showToast — bottom-right minimal notification
═══════════════════════════════════════════════════════════════════════════ */
function showToast(message, tone = 'info') {
  _injectStyles();

  const TITLES = { info: 'Notice', warn: 'Heads up', error: 'Alert' };
  const safeTone = (tone === 'warn' || tone === 'error') ? tone : 'info';

  let toast = document.getElementById(TOAST_ID);
  if (!toast) {
    toast = document.createElement('div');
    toast.id = TOAST_ID;
    toast.className = 'tg-toast';

    const dot  = document.createElement('div'); dot.setAttribute('data-tg-dot', '');
    const body = document.createElement('div'); body.className = 'tg-toast-body';
    const title = document.createElement('div'); title.className = 'tg-toast-title'; title.setAttribute('data-tg-title', '');
    const msg   = document.createElement('div'); msg.className = 'tg-toast-msg'; msg.setAttribute('data-tg-msg', '');
    body.appendChild(title); body.appendChild(msg);

    const close = document.createElement('button');
    close.className = 'tg-toast-close';
    close.type = 'button';
    close.textContent = '✕';
    close.addEventListener('click', () => {
      clearTimeout(toast._t);
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(8px)';
      setTimeout(() => toast.remove(), 200);
    });

    const bar = document.createElement('div'); bar.className = 'tg-toast-bar';
    const barFill = document.createElement('div'); barFill.setAttribute('data-tg-bar', '');
    bar.appendChild(barFill);

    toast.appendChild(dot);
    toast.appendChild(body);
    toast.appendChild(close);
    toast.appendChild(bar);
    document.documentElement.appendChild(toast);
  }

  const dot     = toast.querySelector('[data-tg-dot]');
  const title   = toast.querySelector('[data-tg-title]');
  const msgEl   = toast.querySelector('[data-tg-msg]');
  const barFill = toast.querySelector('[data-tg-bar]');

  if (dot)   dot.className = `tg-toast-dot ${safeTone}`;
  if (title) title.textContent = TITLES[safeTone];
  if (msgEl) msgEl.textContent = message;
  if (barFill) {
    barFill.className = `tg-toast-bar-fill ${safeTone}`;
    barFill.style.animation = 'none';
    void barFill.offsetWidth;
    barFill.style.animation = `tg-bar-shrink ${TOAST_DURATION}ms linear both`;
  }

  toast.style.opacity = '1';
  toast.style.transform = '';

  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
    setTimeout(() => toast.remove(), 200);
  }, TOAST_DURATION);
}

/* ═══════════════════════════════════════════════════════════════════════════
   flashScreen — brief red vignette
═══════════════════════════════════════════════════════════════════════════ */
function flashScreen() {
  const f = document.createElement('div');
  Object.assign(f.style, {
    position: 'fixed', inset: '0', zIndex: '2147483645',
    pointerEvents: 'none', opacity: '0',
    transition: 'opacity 0.15s ease-out',
    background: 'radial-gradient(ellipse at center, rgba(239,68,68,0.18) 0%, transparent 65%)',
  });
  document.documentElement.appendChild(f);
  requestAnimationFrame(() => {
    f.style.opacity = '1';
    setTimeout(() => {
      f.style.opacity = '0';
      setTimeout(() => f.remove(), 180);
    }, 160);
  });
}

/* ─── Exports ────────────────────────────────────────────────────────────── */
window.showWarningOverlay         = showWarningOverlay;
window.showNoStopLossOverlay      = showNoStopLossOverlay;
window.showBlockedTradeOverlay    = showBlockedTradeOverlay;
window.showTradeClosedOverlay     = showTradeClosedOverlay;
window.showPreTradeConfirmation   = showPreTradeConfirmation;
window.showToast                  = showToast;
window.flashScreen                = flashScreen;
