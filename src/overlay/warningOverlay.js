/**
 * Trade GuardX — Overlay & Toast System
 * Premium trading terminal aesthetic. Dark, precise, data-first.
 * Advisory only — cannot guarantee trade protection.
 */

const OVERLAY_ID            = 'tg-warning-overlay';
const BLOCKED_OVERLAY_ID    = 'tg-blocked-trade-overlay';
const TRADE_CLOSED_OVERLAY_ID = 'tg-trade-closed-overlay';
const NO_SL_OVERLAY_ID      = 'tg-no-sl-overlay';
const TOAST_ID              = 'tg-warning-toast';

/* ── Inject shared styles once ─────────────────────────────────────────────── */
function _injectStyles() {
  if (document.getElementById('tg-overlay-styles')) return;
  const s = document.createElement('style');
  s.id = 'tg-overlay-styles';
  s.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Outfit:wght@400;500;600;700;800&display=swap');

    @keyframes tg-slide-up   { from { transform:translateY(18px) scale(0.96); opacity:0 } to { transform:translateY(0) scale(1); opacity:1 } }
    @keyframes tg-fade-in    { from { opacity:0 } to { opacity:1 } }
    @keyframes tg-scan       { 0%{top:-40%} 100%{top:140%} }
    @keyframes tg-glow-amber { 0%,100%{box-shadow:0 0 0 0 rgba(251,191,36,0),0 28px 70px rgba(0,0,0,0.65)} 50%{box-shadow:0 0 32px 6px rgba(251,191,36,0.1),0 28px 70px rgba(0,0,0,0.65)} }
    @keyframes tg-glow-red   { 0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,0),0 28px 70px rgba(0,0,0,0.65)} 50%{box-shadow:0 0 32px 6px rgba(239,68,68,0.12),0 28px 70px rgba(0,0,0,0.65)} }
    @keyframes tg-glow-green { 0%,100%{box-shadow:0 0 0 0 rgba(34,197,94,0),0 28px 70px rgba(0,0,0,0.65)} 50%{box-shadow:0 0 28px 5px rgba(34,197,94,0.1),0 28px 70px rgba(0,0,0,0.65)} }
    @keyframes tg-blink      { 0%,100%{opacity:1} 50%{opacity:0.25} }
    @keyframes tg-bar-grow   { from{width:0} }
    @keyframes tg-count-up   { from{opacity:0;transform:translateY(5px)} to{opacity:1;transform:translateY(0)} }
    @keyframes tg-toast-in   { from{transform:translateX(120%);opacity:0} to{transform:translateX(0);opacity:1} }

    .tg-font-mono { font-family: 'IBM Plex Mono', monospace !important; }
    .tg-font-ui   { font-family: 'Outfit', system-ui, sans-serif !important; }

    .tg-overlay-root {
      position:fixed;inset:0;z-index:2147483647;
      display:flex;align-items:center;justify-content:center;
      padding:20px;box-sizing:border-box;
      background:rgba(2,6,18,0.82);
      backdrop-filter:blur(10px);
      animation:tg-fade-in 0.2s ease both;
    }

    .tg-card {
      width:100%;max-width:420px;
      border-radius:18px;overflow:hidden;
      position:relative;
      font-family:'Outfit',system-ui,sans-serif;
      animation:tg-slide-up 0.38s cubic-bezier(0.34,1.18,0.64,1) both;
    }
    .tg-card-wide { max-width:500px; }

    .tg-scan-line {
      position:absolute;left:0;right:0;height:35%;pointer-events:none;z-index:0;
      background:linear-gradient(180deg,transparent,rgba(255,255,255,0.018),transparent);
      animation:tg-scan 5s linear infinite;
    }

    .tg-card-amber {
      background:linear-gradient(160deg,rgba(12,18,32,0.99),rgba(6,10,20,0.99));
      border:1px solid rgba(251,191,36,0.25);
      animation:tg-slide-up 0.38s cubic-bezier(0.34,1.18,0.64,1) both, tg-glow-amber 3s ease-in-out infinite;
    }
    .tg-card-red {
      background:linear-gradient(160deg,rgba(12,18,32,0.99),rgba(6,10,20,0.99));
      border:1px solid rgba(239,68,68,0.28);
      animation:tg-slide-up 0.38s cubic-bezier(0.34,1.18,0.64,1) both, tg-glow-red 3s ease-in-out infinite;
    }
    .tg-card-green {
      background:linear-gradient(160deg,rgba(12,18,32,0.99),rgba(6,10,20,0.99));
      border:1px solid rgba(34,197,94,0.22);
      animation:tg-slide-up 0.38s cubic-bezier(0.34,1.18,0.64,1) both, tg-glow-green 3s ease-in-out infinite;
    }
    .tg-card-neutral {
      background:linear-gradient(160deg,rgba(12,18,32,0.99),rgba(6,10,20,0.99));
      border:1px solid rgba(148,163,184,0.18);
      animation:tg-slide-up 0.38s cubic-bezier(0.34,1.18,0.64,1) both;
      box-shadow:0 28px 70px rgba(0,0,0,0.65);
    }

    /* Header stripe */
    .tg-head { position:relative;z-index:1;padding:13px 16px;display:flex;align-items:center;gap:10px;border-bottom:1px solid; }
    .tg-head-amber { background:linear-gradient(135deg,rgba(100,60,0,0.28),rgba(50,28,0,0.18)); border-color:rgba(251,191,36,0.12); }
    .tg-head-red   { background:linear-gradient(135deg,rgba(80,8,8,0.35),rgba(50,4,4,0.22));   border-color:rgba(239,68,68,0.12); }
    .tg-head-green { background:linear-gradient(135deg,rgba(5,46,22,0.32),rgba(3,28,14,0.2));  border-color:rgba(34,197,94,0.12); }
    .tg-head-neutral { background:rgba(255,255,255,0.02); border-color:rgba(148,163,184,0.1); }

    /* Icon circle */
    .tg-icon { width:34px;height:34px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:17px;flex-shrink:0; }
    .tg-icon-amber { background:linear-gradient(135deg,#f59e0b,#d97706); box-shadow:0 0 16px rgba(245,158,11,0.4); }
    .tg-icon-red   { background:linear-gradient(135deg,#ef4444,#b91c1c); box-shadow:0 0 16px rgba(239,68,68,0.45); }
    .tg-icon-green { background:linear-gradient(135deg,#22c55e,#15803d); box-shadow:0 0 14px rgba(34,197,94,0.4); }
    .tg-icon-neutral { background:rgba(100,116,139,0.25); border:1px solid rgba(100,116,139,0.3); }

    /* Body */
    .tg-body { position:relative;z-index:1;padding:14px 16px 16px; }

    /* Metrics grid */
    .tg-metrics { display:grid;gap:7px;margin-bottom:12px; }
    .tg-metrics-3 { grid-template-columns:repeat(3,1fr); }
    .tg-metrics-4 { grid-template-columns:repeat(4,1fr); }
    .tg-metrics-2 { grid-template-columns:repeat(2,1fr); }
    .tg-met { background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.055);border-radius:10px;padding:9px 8px 8px;text-align:center; }
    .tg-met-v { font-size:15px;font-weight:800;font-family:'IBM Plex Mono',monospace;letter-spacing:-0.02em;line-height:1;animation:tg-count-up 0.45s ease both; }
    .tg-met-l { font-size:8px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#1e3040;margin-top:4px; }
    .tg-met-v.amber { color:#fbbf24; }
    .tg-met-v.red   { color:#f87171; }
    .tg-met-v.green { color:#4ade80; }
    .tg-met-v.muted { color:#4a6070; }
    .tg-met-v.white { color:#e2f8f0; }

    /* Risk bar */
    .tg-bar-wrap { margin-bottom:12px; }
    .tg-bar-hd { display:flex;justify-content:space-between;align-items:center;margin-bottom:5px; }
    .tg-bar-hd span { font-size:9px;font-family:'IBM Plex Mono',monospace;color:#1e3040;letter-spacing:0.06em; }
    .tg-bar-hd strong { font-size:9px;font-family:'IBM Plex Mono',monospace; }
    .tg-bar-hd strong.amber { color:#fbbf24; }
    .tg-bar-hd strong.red   { color:#f87171; }
    .tg-bar-track { height:4px;background:rgba(255,255,255,0.05);border-radius:99px;overflow:hidden; }
    .tg-bar-fill  { height:100%;border-radius:99px;animation:tg-bar-grow 0.6s ease both; }
    .tg-bar-fill.amber { background:linear-gradient(90deg,#d97706,#fbbf24); }
    .tg-bar-fill.red   { background:linear-gradient(90deg,#dc2626,#f87171); }
    .tg-bar-fill.green { background:linear-gradient(90deg,#15803d,#4ade80); }

    /* Message box */
    .tg-msg { font-size:12px;color:#5a7888;line-height:1.65;margin-bottom:12px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.045);border-radius:9px;padding:10px 12px; }
    .tg-msg b { color:#9ab8c8;font-weight:600; }
    .tg-sym { display:inline-block;padding:1px 7px;border-radius:4px;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.1);font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:700;color:#e2f8f0; }

    /* Disclaimer */
    .tg-disc { font-size:9px;color:#142030;font-family:'IBM Plex Mono',monospace;line-height:1.5;margin-bottom:12px;letter-spacing:0.02em; }

    /* Rules list */
    .tg-rules { display:flex;flex-direction:column;gap:5px;margin-bottom:12px; }
    .tg-rule  { font-size:11px;padding:7px 11px;background:rgba(255,255,255,0.025);border:1px solid rgba(255,255,255,0.05);border-radius:7px;color:#4a6070;font-family:'IBM Plex Mono',monospace;line-height:1.4; }

    /* Buttons */
    .tg-btns { display:flex;gap:8px; }
    .tg-btn  { height:36px;padding:0 16px;border-radius:9px;font-size:12px;font-weight:700;font-family:'Outfit',sans-serif;cursor:pointer;border:none;display:flex;align-items:center;justify-content:center;gap:5px;transition:all 0.15s;white-space:nowrap; }
    .tg-btn:hover { filter:brightness(1.12);transform:translateY(-1px); }
    .tg-btn:active { transform:scale(0.97);filter:none; }
    .tg-btn-ghost  { background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.09);color:#3a5060; }
    .tg-btn-amber  { background:linear-gradient(135deg,#d97706,#b45309);color:#fff8e1;box-shadow:0 3px 14px rgba(217,119,6,0.28); }
    .tg-btn-red    { background:linear-gradient(135deg,#ef4444,#b91c1c);color:#fff;box-shadow:0 3px 14px rgba(239,68,68,0.3); }
    .tg-btn-green  { background:linear-gradient(135deg,#22c55e,#15803d);color:#fff;box-shadow:0 3px 14px rgba(34,197,94,0.28); }
    .tg-btn-outline-red { background:transparent;border:1px solid rgba(239,68,68,0.35);color:#f87171; }
    .tg-btn-full   { flex:1; }
    .tg-btn-lg     { height:40px;font-size:13px; }

    /* PnL hero */
    .tg-pnl-hero { border-radius:12px;padding:14px 15px;margin-bottom:12px; }
    .tg-pnl-lbl  { font-size:9px;text-transform:uppercase;letter-spacing:0.1em;font-family:'IBM Plex Mono',monospace;color:#2a4050;margin-bottom:4px;font-weight:700; }
    .tg-pnl-val  { font-size:30px;font-weight:800;font-family:'IBM Plex Mono',monospace;letter-spacing:-0.03em;line-height:1.1; }
    .tg-pnl-sub  { font-size:11px;color:#2a4050;margin-top:4px;font-family:'IBM Plex Mono',monospace; }

    /* Close btn */
    .tg-close-x { position:absolute;top:12px;right:12px;z-index:2;width:26px;height:26px;border-radius:7px;border:1px solid rgba(148,163,184,0.2);background:rgba(255,255,255,0.04);color:#3a5060;cursor:pointer;font-size:11px;display:flex;align-items:center;justify-content:center;transition:all 0.15s; }
    .tg-close-x:hover { color:#8aa0b0;border-color:rgba(148,163,184,0.35); }
  `;
  document.head.appendChild(s);
}

/* ── Logo helper ────────────────────────────────────────────────────────────── */
function _logo(size = 22) {
  const w = document.createElement('div');
  Object.assign(w.style, { width:`${size}px`, height:`${size}px`, borderRadius:'7px', overflow:'hidden', flexShrink:'0', display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(0,255,160,0.08)', border:'1px solid rgba(0,255,160,0.2)' });
  try {
    const url = typeof chrome !== 'undefined' && chrome?.runtime?.getURL ? chrome.runtime.getURL('icons/logo.png') : null;
    if (url) {
      const img = document.createElement('img');
      img.src = url; img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
      img.addEventListener('error', () => { w.textContent = '⚡'; w.style.fontSize = `${size * 0.55}px`; w.style.color = '#00ffa0'; });
      w.appendChild(img); return w;
    }
  } catch (_) {}
  w.textContent = '⚡'; w.style.fontSize = `${size * 0.55}px`; w.style.color = '#00ffa0';
  return w;
}

/* ── Currency formatter ─────────────────────────────────────────────────────── */
function formatCurrency(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '–';
  return Number(v).toLocaleString(undefined, { minimumFractionDigits:2, maximumFractionDigits:2 });
}

/* ── Small DOM helpers ──────────────────────────────────────────────────────── */
function _el(tag, cls, extra = {}) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  Object.assign(e.style, extra);
  return e;
}
function _met(value, label, colorCls) {
  const m = _el('div', 'tg-met');
  const v = _el('div', `tg-met-v ${colorCls}`); v.textContent = value;
  const l = _el('div', 'tg-met-l'); l.textContent = label;
  m.appendChild(v); m.appendChild(l); return m;
}
function _bar(pct, colorCls, label, rightLabel) {
  const w = _el('div', 'tg-bar-wrap');
  const hd = _el('div', 'tg-bar-hd');
  const lbl = _el('span'); lbl.textContent = label;
  const rgt = _el('strong', colorCls); rgt.textContent = rightLabel;
  hd.appendChild(lbl); hd.appendChild(rgt);
  const track = _el('div', 'tg-bar-track');
  const fill  = _el('div', `tg-bar-fill ${colorCls}`);
  fill.style.width = Math.min(100, pct) + '%';
  track.appendChild(fill); w.appendChild(hd); w.appendChild(track); return w;
}
function _closeX(root) {
  const x = _el('button', 'tg-close-x');
  x.textContent = '✕'; x.addEventListener('click', () => root.remove()); return x;
}
function _disc(text) {
  const d = _el('div', 'tg-disc'); d.textContent = text; return d;
}

/* ═══════════════════════════════════════════════════════════════════════════════
   showNoStopLossOverlay  — SL Reminder
═══════════════════════════════════════════════════════════════════════════════ */
function showNoStopLossOverlay({ symbol = null, stopLoss = null, takeProfit = null, message = null, onSetStopLoss = null } = {}) {
  _injectStyles();
  document.getElementById(NO_SL_OVERLAY_ID)?.remove();

  const sym  = symbol || '?';
  const slN  = Number(stopLoss);
  const tpN  = Number(takeProfit);
  const slTx = Number.isFinite(slN) && slN > 0 ? formatCurrency(slN) : '0.00';
  const tpTx = Number.isFinite(tpN) && tpN > 0 ? formatCurrency(tpN) : '0.00';
  const slMissing = slTx === '0.00';

  const root = _el('div', 'tg-overlay-root'); root.id = NO_SL_OVERLAY_ID;

  const card = _el('div', 'tg-card tg-card-amber');
  card.appendChild(_el('div', 'tg-scan-line'));
  card.appendChild(_closeX(root));

  /* header */
  const head = _el('div', 'tg-head tg-head-amber');
  const icon = _el('div', 'tg-icon tg-icon-amber'); icon.textContent = '⚠';
  const hInfo = _el('div');
  const hTitle = _el('div', 'tg-font-ui', { fontSize:'13px', fontWeight:'800', color:'#fbbf24', letterSpacing:'0.01em' });
  hTitle.textContent = 'No Stop Loss Set';
  const hSub = _el('div', 'tg-font-mono', { fontSize:'9px', color:'#5a3800', letterSpacing:'0.12em', marginTop:'2px' });
  hSub.textContent = 'RISK ALERT · ADVISORY ONLY';
  hInfo.appendChild(hTitle); hInfo.appendChild(hSub);
  head.appendChild(icon); head.appendChild(hInfo);
  card.appendChild(head);

  /* body */
  const body = _el('div', 'tg-body');

  /* metrics */
  const metrics = _el('div', 'tg-metrics tg-metrics-3');
  metrics.appendChild(_met(sym, 'Symbol', 'white'));
  metrics.appendChild(_met(slTx, 'Stop Loss', slMissing ? 'red' : 'amber'));
  metrics.appendChild(_met(tpTx, 'Take Profit', 'muted'));
  body.appendChild(metrics);

  /* message */
  const msg = _el('div', 'tg-msg tg-font-ui');
  msg.innerHTML = `Your open position on <span class="tg-sym">${sym}</span> has <b>no stop loss set</b>. Without a stop loss, a sudden move can result in uncontrolled losses. Set a stop loss to cap your downside before the market moves against you.`;
  if (message) { const extra = _el('div', 'tg-font-mono', { fontSize:'10px', color:'#2a4050', marginTop:'8px' }); extra.textContent = message; msg.appendChild(extra); }
  body.appendChild(msg);

  body.appendChild(_disc('Advisory only · Repeats every 30s while SL is unset · TradeGuarX cannot guarantee trade protection'));

  /* buttons */
  const btns = _el('div', 'tg-btns');
  const dismiss = _el('button', 'tg-btn tg-btn-ghost'); dismiss.textContent = 'Dismiss'; dismiss.addEventListener('click', () => root.remove());
  const setsl   = _el('button', 'tg-btn tg-btn-amber tg-btn-full'); setsl.textContent = 'Set Stop Loss Now →';
  setsl.addEventListener('click', () => { if (typeof onSetStopLoss === 'function') onSetStopLoss(); root.remove(); });
  btns.appendChild(dismiss); btns.appendChild(setsl);
  body.appendChild(btns);

  card.appendChild(body);
  root.appendChild(card);
  document.documentElement.appendChild(root);
}

/* ═══════════════════════════════════════════════════════════════════════════════
   showWarningOverlay  — general warning (daily loss warn, over-risk, etc.)
═══════════════════════════════════════════════════════════════════════════════ */
function showWarningOverlay({ title, message, highlight }) {
  _injectStyles();

  // Update if already open
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) {
    const t = existing.querySelector('#tg-w-title');
    const m = existing.querySelector('#tg-w-msg');
    if (t) t.textContent = title || t.textContent;
    if (m) m.textContent = message || m.textContent;
    if (highlight && typeof flashScreen === 'function') flashScreen();
    return;
  }

  const root = _el('div', 'tg-overlay-root'); root.id = OVERLAY_ID;

  const card = _el('div', 'tg-card tg-card-amber');
  card.appendChild(_el('div', 'tg-scan-line'));
  card.appendChild(_closeX(root));

  /* header */
  const head = _el('div', 'tg-head tg-head-amber');
  const icon = _el('div', 'tg-icon tg-icon-amber'); icon.textContent = '⚠';
  const hInfo = _el('div');
  const hTitle = _el('div', 'tg-font-ui', { fontSize:'13px', fontWeight:'800', color:'#fbbf24' });
  hTitle.id = 'tg-w-title';
  hTitle.textContent = title || 'Trade GuardX Warning';
  const hSub = _el('div', 'tg-font-mono', { fontSize:'9px', color:'#5a3800', letterSpacing:'0.1em', marginTop:'2px' });
  hSub.textContent = 'RISK MANAGEMENT · ADVISORY ONLY';
  hInfo.appendChild(hTitle); hInfo.appendChild(hSub);
  head.appendChild(icon); head.appendChild(hInfo);
  card.appendChild(head);

  /* body */
  const body = _el('div', 'tg-body');

  const msg = _el('div', 'tg-msg tg-font-ui'); msg.id = 'tg-w-msg';
  msg.textContent = message || '';
  body.appendChild(msg);

  body.appendChild(_disc('This extension cannot guarantee trade protection. Risk estimates are approximate.'));

  const btns = _el('div', 'tg-btns');
  const dismiss = _el('button', 'tg-btn tg-btn-ghost'); dismiss.textContent = 'Dismiss'; dismiss.addEventListener('click', () => root.remove());
  const ack     = _el('button', 'tg-btn tg-btn-amber tg-btn-full'); ack.textContent = 'I understand'; ack.addEventListener('click', () => root.remove());
  btns.appendChild(dismiss); btns.appendChild(ack);
  body.appendChild(btns);

  card.appendChild(body);
  root.appendChild(card);
  document.documentElement.appendChild(root);

  if (highlight && typeof flashScreen === 'function') flashScreen();
}

/* ═══════════════════════════════════════════════════════════════════════════════
   showBlockedTradeOverlay  — trade blocked by rule
═══════════════════════════════════════════════════════════════════════════════ */
function showBlockedTradeOverlay(reason, config, options) {
  _injectStyles();
  document.getElementById(BLOCKED_OVERLAY_ID)?.remove();

  const isConfirm = options?.confirmMode === true && typeof options?.onContinue === 'function';
  const overlayTitle = options?.title || 'Trade Blocked';

  /* parse config for metrics */
  const c = config || {};
  const balance        = c.accountSize != null ? Number(c.accountSize) : null;
  const dailyLossOn    = c.dailyLossRuleEnabled !== false;
  const riskPerTradeOn = c.riskPerTradeEnabled === true;
  const limitType      = c.dailyLossLimitType === 'amount' ? 'amount' : 'percent';
  const dailyPct       = c.dailyLossLimitPct   != null ? Number(c.dailyLossLimitPct)   : 5;
  const dailyAmt       = c.dailyLossLimitAmount != null ? Number(c.dailyLossLimitAmount): 0;
  const warnPct        = c.warningThresholdPct  != null ? Number(c.warningThresholdPct) : 80;
  const riskPct        = c.riskPerTradePercent  != null ? Number(c.riskPerTradePercent) : 1;
  const hedgingOn      = c.hedgingEnabled !== false;
  const dailyLimit     = limitType === 'amount' ? dailyAmt : (balance ? balance * dailyPct / 100 : 0);

  const root = _el('div', 'tg-overlay-root'); root.id = BLOCKED_OVERLAY_ID;

  const card = _el('div', 'tg-card tg-card-red');
  card.appendChild(_el('div', 'tg-scan-line'));

  /* header */
  const head = _el('div', 'tg-head tg-head-red');
  const icon = _el('div', 'tg-icon tg-icon-red'); icon.textContent = '🛑';
  const hInfo = _el('div');
  const hTitle = _el('div', 'tg-font-ui', { fontSize:'13px', fontWeight:'800', color:'#fca5a5' });
  hTitle.textContent = overlayTitle;
  const hSub = _el('div', 'tg-font-mono', { fontSize:'9px', letterSpacing:'0.1em', marginTop:'2px' });
  hSub.style.color = '#6a1a1a';
  hSub.textContent = isConfirm ? 'CONFIRM TO PROCEED AT YOUR OWN RISK' : 'RULE ENFORCED · TRADE NOT EXECUTED';
  hInfo.appendChild(hTitle); hInfo.appendChild(hSub);
  head.appendChild(icon); head.appendChild(hInfo);
  card.appendChild(head);

  /* body */
  const body = _el('div', 'tg-body');

  /* reason card */
  const reasonBox = _el('div', 'tg-font-ui', { fontSize:'12px', color:'#7a9aaa', lineHeight:'1.6', marginBottom:'12px', background:'rgba(239,68,68,0.06)', border:'1px solid rgba(239,68,68,0.15)', borderLeft:'3px solid rgba(239,68,68,0.6)', borderRadius:'0 9px 9px 0', padding:'10px 12px' });
  reasonBox.innerHTML = `<div style="font-size:9px;font-family:'IBM Plex Mono',monospace;color:#3a1a1a;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:5px;">Reason</div>${reason || 'A rule prevented this trade.'}`;
  body.appendChild(reasonBox);

  /* active rules */
  const rulesLabel = _el('div', 'tg-font-mono', { fontSize:'9px', color:'#1e3040', letterSpacing:'0.12em', textTransform:'uppercase', marginBottom:'7px', fontWeight:'600' });
  rulesLabel.textContent = 'Active Rules';
  body.appendChild(rulesLabel);

  const rules = _el('div', 'tg-rules');
  const ruleItems = [
    `Daily loss: ${dailyLossOn ? `On · ${limitType === 'amount' ? `$${formatCurrency(dailyLimit)}` : `${dailyPct}%`} limit, warn at ${warnPct}%` : 'Off'}`,
    `Per-trade risk: ${riskPerTradeOn ? `On · ${riskPct}% of balance` : 'Off'}`,
    `Hedging: ${hedgingOn ? 'On' : 'Off'}`,
    `Max positions: ${c.maxStackingTradesEnabled ? c.maxStackingTrades : 'Off'}`,
    `Max trades/day: ${c.maxTradesPerDayEnabled ? c.maxTradesPerDay : 'Off'}`,
  ];
  ruleItems.forEach(txt => { const r = _el('div', 'tg-rule'); r.textContent = txt; rules.appendChild(r); });
  body.appendChild(rules);

  body.appendChild(_disc('Change rules via the TradeGuarX extension icon · Risk estimates are approximate'));

  /* buttons */
  const btns = _el('div', 'tg-btns');
  const closeBtn = _el('button', `tg-btn tg-btn-ghost${isConfirm ? '' : ' tg-btn-full'}`);
  closeBtn.textContent = isConfirm ? 'Cancel' : 'Got it';
  closeBtn.addEventListener('click', () => root.remove());
  btns.appendChild(closeBtn);

  if (isConfirm) {
    const cont = _el('button', 'tg-btn tg-btn-amber tg-btn-full'); cont.textContent = 'Continue anyway →';
    cont.addEventListener('click', () => { options.onContinue(); root.remove(); });
    btns.appendChild(cont);
  }

  body.appendChild(btns);
  card.appendChild(body);
  root.appendChild(card);
  document.documentElement.appendChild(root);

  if (typeof flashScreen === 'function') flashScreen();
}

/* ═══════════════════════════════════════════════════════════════════════════════
   showTradeClosedOverlay  — trade closed (profit / loss / neutral)
═══════════════════════════════════════════════════════════════════════════════ */
function showTradeClosedOverlay({ outcome = 'CLOSED', symbol = null, side = null, volume = null, entryPrice = null, currentPrice = null, stopLoss = null, takeProfit = null, pnl = null, closedAt = null } = {}) {
  _injectStyles();
  document.getElementById(TRADE_CLOSED_OVERLAY_ID)?.remove();

  const state    = String(outcome || '').toUpperCase();
  const isLoss   = state === 'LOSS';
  const isProfit = state === 'PROFIT';
  const pnlNum   = Number.isFinite(Number(pnl)) ? Number(pnl) : null;
  const dt       = closedAt ? new Date(closedAt) : new Date();
  const fmt      = v => (v == null || Number.isNaN(Number(v)) ? '–' : formatCurrency(Number(v)));

  const cardCls   = isLoss ? 'tg-card-red'   : isProfit ? 'tg-card-green'   : 'tg-card-neutral';
  const headCls   = isLoss ? 'tg-head-red'   : isProfit ? 'tg-head-green'   : 'tg-head-neutral';
  const iconCls   = isLoss ? 'tg-icon-red'   : isProfit ? 'tg-icon-green'   : 'tg-icon-neutral';
  const iconChar  = isLoss ? '↓' : isProfit ? '↑' : '=';
  const pnlColor  = isLoss ? '#f87171'        : isProfit ? '#4ade80'         : '#4a6070';
  const badgeTxt  = isLoss ? 'LOSS REALIZED'  : isProfit ? 'PROFIT BOOKED'   : 'POSITION CLOSED';
  const btnCls    = isLoss ? 'tg-btn-red'     : isProfit ? 'tg-btn-green'    : 'tg-btn-ghost';
  const pnlBg     = isLoss ? 'rgba(239,68,68,0.07)'  : isProfit ? 'rgba(34,197,94,0.07)'  : 'rgba(100,116,139,0.06)';
  const pnlBorder = isLoss ? 'rgba(239,68,68,0.18)'  : isProfit ? 'rgba(34,197,94,0.15)'  : 'rgba(100,116,139,0.15)';

  const root = _el('div', 'tg-overlay-root'); root.id = TRADE_CLOSED_OVERLAY_ID;

  const card = _el('div', `tg-card tg-card-wide ${cardCls}`);
  card.appendChild(_el('div', 'tg-scan-line'));
  card.appendChild(_closeX(root));

  /* header */
  const head = _el('div', `tg-head ${headCls}`);
  const icon = _el('div', `tg-icon ${iconCls}`, { fontSize:'20px', fontWeight:'800' }); icon.textContent = iconChar;
  const hInfo = _el('div');
  const hTitle = _el('div', 'tg-font-ui', { fontSize:'13px', fontWeight:'800', color: isLoss ? '#fca5a5' : isProfit ? '#86efac' : '#94a3b8' });
  hTitle.textContent = symbol ? `${symbol} closed` : 'Position closed';
  const hSub = _el('div', 'tg-font-mono', { fontSize:'9px', letterSpacing:'0.12em', marginTop:'2px', color: isLoss ? '#5a1818' : isProfit ? '#1a4a2a' : '#2a3a45' });
  hSub.textContent = badgeTxt;
  hInfo.appendChild(hTitle); hInfo.appendChild(hSub);

  /* logo right */
  const logoWrap = _el('div', '', { marginLeft:'auto', display:'flex', alignItems:'center', gap:'7px' });
  logoWrap.appendChild(_logo(20));
  const logoTxt = _el('div', 'tg-font-mono', { fontSize:'9px', color:'#1e3040', letterSpacing:'0.1em' });
  logoTxt.textContent = 'TRADEGUARX';
  logoWrap.appendChild(logoTxt);

  head.appendChild(icon); head.appendChild(hInfo); head.appendChild(logoWrap);
  card.appendChild(head);

  /* body */
  const body = _el('div', 'tg-body');

  /* PnL hero */
  const pnlCard = _el('div', 'tg-pnl-hero', { background:pnlBg, border:`1px solid ${pnlBorder}` });
  const pnlLbl = _el('div', 'tg-pnl-lbl'); pnlLbl.textContent = 'Realized P/L estimate';
  const pnlVal = _el('div', 'tg-pnl-val', { color:pnlColor, animation:'tg-count-up 0.5s ease both' });
  pnlVal.textContent = pnlNum == null ? 'Not available' : `${pnlNum >= 0 ? '+' : ''}${formatCurrency(pnlNum)}`;
  const pnlSub = _el('div', 'tg-pnl-sub');
  pnlSub.textContent = isLoss ? 'Loss was realized on close' : isProfit ? 'Profit was realized on close' : 'Outcome from available trade data';
  pnlCard.appendChild(pnlLbl); pnlCard.appendChild(pnlVal); pnlCard.appendChild(pnlSub);
  body.appendChild(pnlCard);

  /* metrics grid */
  const metrics = _el('div', 'tg-metrics tg-metrics-4', { marginBottom:'10px' });
  metrics.appendChild(_met(side || '–', 'Side', 'white'));
  metrics.appendChild(_met(volume != null ? String(volume) : '–', 'Size', 'muted'));
  metrics.appendChild(_met(fmt(entryPrice), 'Entry', 'muted'));
  metrics.appendChild(_met(fmt(currentPrice), 'Close', isLoss ? 'red' : isProfit ? 'green' : 'muted'));
  body.appendChild(metrics);

  /* SL / TP row */
  const sltp = _el('div', 'tg-metrics tg-metrics-2', { marginBottom:'12px' });
  sltp.appendChild(_met(fmt(stopLoss),   'Stop Loss',   'muted'));
  sltp.appendChild(_met(fmt(takeProfit), 'Take Profit', 'muted'));
  body.appendChild(sltp);

  /* time */
  const when = _el('div', 'tg-font-mono', { fontSize:'9px', color:'#142030', textAlign:'center', marginBottom:'12px', letterSpacing:'0.06em' });
  when.textContent = `Closed at ${dt.toLocaleTimeString()} · Auto-dismiss in 45s`;
  body.appendChild(when);

  /* button */
  const btns = _el('div', 'tg-btns');
  const done = _el('button', `tg-btn ${btnCls} tg-btn-full tg-btn-lg`);
  done.textContent = isLoss ? 'Noted — review my rules' : isProfit ? 'Great — keep trading' : 'Got it';
  done.addEventListener('click', () => root.remove());
  btns.appendChild(done);
  body.appendChild(btns);

  card.appendChild(body);
  root.appendChild(card);
  document.documentElement.appendChild(root);

  clearTimeout(root._ac);
  root._ac = setTimeout(() => root.remove(), 45000);
}

/* ═══════════════════════════════════════════════════════════════════════════════
   showToast
═══════════════════════════════════════════════════════════════════════════════ */
function showToast(message, tone = 'info') {
  _injectStyles();
  let toast = document.getElementById(TOAST_ID);

  if (!toast) {
    toast = document.createElement('div');
    toast.id = TOAST_ID;
    Object.assign(toast.style, {
      position:'fixed', right:'16px', bottom:'20px', zIndex:'2147483646',
      minWidth:'220px', maxWidth:'320px',
      fontFamily:"'Outfit',system-ui,sans-serif", fontSize:'12px',
      padding:'10px 14px', borderRadius:'10px',
      display:'flex', alignItems:'center', gap:'9px', lineHeight:'1.4',
      boxShadow:'0 10px 40px rgba(0,0,0,0.4)',
      transition:'opacity 0.2s ease, transform 0.2s ease',
      animation:'tg-toast-in 0.3s cubic-bezier(0.34,1.2,0.64,1) both',
    });
    const icon = document.createElement('span'); icon.setAttribute('data-tg-ti',''); icon.style.fontSize='13px';
    const text = document.createElement('span'); text.setAttribute('data-tg-tt',''); text.style.flex='1';
    toast.appendChild(icon); toast.appendChild(text);
    document.documentElement.appendChild(toast);
  }

  const isErr  = tone === 'error';
  const isWarn = tone === 'warn';
  toast.querySelector('[data-tg-ti]').textContent = isErr ? '✕' : isWarn ? '⚠' : '✓';
  toast.querySelector('[data-tg-tt]').textContent = message;

  Object.assign(toast.style, {
    background: isErr  ? 'linear-gradient(135deg,rgba(20,6,6,0.97),rgba(14,4,4,0.99))'
               :isWarn ? 'linear-gradient(135deg,rgba(20,16,2,0.97),rgba(14,11,2,0.99))'
               :         'linear-gradient(135deg,rgba(4,16,10,0.97),rgba(3,11,7,0.99))',
    border: isErr  ? '1px solid rgba(248,113,113,0.35)'
           :isWarn ? '1px solid rgba(250,204,21,0.35)'
           :         '1px solid rgba(34,197,94,0.3)',
    color:'#e2e8f0',
  });
  toast.querySelector('[data-tg-ti]').style.color = isErr ? '#fca5a5' : isWarn ? '#fcd34d' : '#4ade80';

  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    toast.style.opacity = '0'; toast.style.transform = 'translateX(12px)';
    setTimeout(() => toast.remove(), 220);
  }, 4000);
}

/* ═══════════════════════════════════════════════════════════════════════════════
   flashScreen
═══════════════════════════════════════════════════════════════════════════════ */
function flashScreen() {
  const f = document.createElement('div');
  Object.assign(f.style, { position:'fixed', inset:'0', zIndex:'2147483645', pointerEvents:'none', opacity:'0', transition:'opacity 0.15s ease-out', background:'radial-gradient(ellipse at center,rgba(239,68,68,0.22) 0%,transparent 70%)' });
  document.documentElement.appendChild(f);
  requestAnimationFrame(() => {
    f.style.opacity = '1';
    setTimeout(() => { f.style.opacity = '0'; setTimeout(() => f.remove(), 200); }, 180);
  });
}

/* ── Exports ──────────────────────────────────────────────────────────────── */
window.showWarningOverlay      = showWarningOverlay;
window.showNoStopLossOverlay   = showNoStopLossOverlay;
window.showBlockedTradeOverlay = showBlockedTradeOverlay;
window.showTradeClosedOverlay  = showTradeClosedOverlay;
window.showToast               = showToast;
window.flashScreen             = flashScreen;