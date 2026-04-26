/**
 * Timezone-aware daily reset logic for funded accounts.
 *
 * The prop firm daily cutoff happens at a fixed local time in a specific IANA timezone
 * (e.g. 17:00 America/New_York for FTMO US sessions). This module computes the next
 * reset instant and decides whether a reset is pending, independent of UTC midnight.
 */

function parseHHMM(v) {
  if (typeof v !== 'string') return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v.trim());
  if (!m) return null;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/**
 * Return the offset (minutes) of the given IANA timezone at `instantMs`.
 * E.g. America/New_York in winter → -300.
 */
function tzOffsetMinutes(timezone, instantMs) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    const parts = dtf.formatToParts(new Date(instantMs));
    const lookup = {};
    for (const p of parts) lookup[p.type] = p.value;
    const asUtc = Date.UTC(
      Number(lookup.year),
      Number(lookup.month) - 1,
      Number(lookup.day),
      Number(lookup.hour === '24' ? '00' : lookup.hour),
      Number(lookup.minute),
      Number(lookup.second)
    );
    return Math.round((asUtc - instantMs) / 60_000);
  } catch (_e) {
    return 0;
  }
}

/**
 * Given an IANA timezone and local HH:MM, compute the UTC ms of that local wall-clock
 * time on the given calendar day (as observed in that timezone).
 */
function localWallTimeToUtc(timezone, year, month, day, hour, minute) {
  // Approximate UTC candidate then correct using the observed offset.
  const approx = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offsetMin = tzOffsetMinutes(timezone, approx);
  return approx - offsetMin * 60_000;
}

function ymdInTz(instantMs, timezone) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = dtf.formatToParts(new Date(instantMs));
  const lookup = {};
  for (const p of parts) lookup[p.type] = p.value;
  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day)
  };
}

/**
 * Return the next reset instant at or after `fromMs`. If `fromMs` is before today's
 * reset, returns today's reset; otherwise tomorrow's.
 */
export function nextResetInstant(timezone, resetTimeLocal, fromMs = Date.now()) {
  const hm = parseHHMM(resetTimeLocal);
  if (!hm || !timezone) return null;
  const { year, month, day } = ymdInTz(fromMs, timezone);
  const todayReset = localWallTimeToUtc(timezone, year, month, day, hm.hour, hm.minute);
  if (fromMs < todayReset) return todayReset;
  const tomorrowReset = localWallTimeToUtc(timezone, year, month, day + 1, hm.hour, hm.minute);
  return tomorrowReset;
}

/**
 * Most recent reset instant at or before `fromMs`.
 */
export function lastResetInstant(timezone, resetTimeLocal, fromMs = Date.now()) {
  const hm = parseHHMM(resetTimeLocal);
  if (!hm || !timezone) return null;
  const { year, month, day } = ymdInTz(fromMs, timezone);
  const todayReset = localWallTimeToUtc(timezone, year, month, day, hm.hour, hm.minute);
  if (fromMs >= todayReset) return todayReset;
  const yesterdayReset = localWallTimeToUtc(timezone, year, month, day - 1, hm.hour, hm.minute);
  return yesterdayReset;
}

/**
 * Has a reset been crossed since `lastDailyResetAt`?
 *  - returns false if account is not in funded mode / missing required config
 *  - returns true if lastDailyResetAt is null (first-time init) OR strictly earlier than
 *    the most recent scheduled reset.
 */
export function hasResetPassed(account, nowMs = Date.now()) {
  if (!account || account.equityMode !== 'funded') return false;
  if (!account.timezone || !account.dailyResetTimeLocal) return false;
  const last = lastResetInstant(account.timezone, account.dailyResetTimeLocal, nowMs);
  if (last == null) return false;
  if (!account.lastDailyResetAt) return true;
  const lastDone = Date.parse(account.lastDailyResetAt);
  if (!Number.isFinite(lastDone)) return true;
  return lastDone < last;
}

/**
 * Has the user reconciled since the last daily reset?
 */
export function needsReconcile(account, nowMs = Date.now()) {
  if (!account || account.equityMode !== 'funded') return false;
  if (!account.timezone || !account.dailyResetTimeLocal) return false;
  const last = lastResetInstant(account.timezone, account.dailyResetTimeLocal, nowMs);
  if (last == null) return false;
  const reconciledAt = account.lastReconciledAt ? Date.parse(account.lastReconciledAt) : NaN;
  return !Number.isFinite(reconciledAt) || reconciledAt < last;
}
