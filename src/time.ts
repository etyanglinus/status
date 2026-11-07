/** East Africa Time is UTC+3 all year (no daylight saving). */
export const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** EAT calendar date (YYYY-MM-DD) for a UTC timestamp. */
export function eatDay(ts: number): string {
  return new Date(ts + EAT_OFFSET_MS).toISOString().slice(0, 10);
}

/** Human-readable EAT time for alerts, e.g. "6 Nov 2026, 3:30 p.m. EAT". */
export function formatEat(ts: number): string {
  const d = new Date(ts + EAT_OFFSET_MS);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  let h = d.getUTCHours();
  const ampm = h >= 12 ? 'p.m.' : 'a.m.';
  h = h % 12 || 12;
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${h}:${m} ${ampm} EAT`;
}

/** The last `n` EAT dates ending today, oldest first. */
export function lastDays(now: number, n: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(eatDay(now - i * DAY_MS));
  return out;
}
