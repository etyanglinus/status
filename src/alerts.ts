import type { Env } from './types';
import { formatEat } from './time';

let colo: string | null = null;

/** Cloudflare data centre the checks ran from (e.g. "NBO" Nairobi, "MBA" Mombasa). */
async function checkLocation(): Promise<string> {
  if (colo) return colo;
  try {
    const t = await (await fetch('https://www.cloudflare.com/cdn-cgi/trace', { signal: AbortSignal.timeout(5000) })).text();
    colo = /colo=([A-Z]+)/.exec(t)?.[1] ?? 'unknown';
  } catch {
    colo = 'unknown';
  }
  return colo;
}

export interface AlertInput {
  kind: 'down' | 'degraded' | 'recovered';
  component: string;
  checks: { name: string; reason: string }[];
  firstFailureAt: number | null;
  downSince: number | null;
  now: number;
}

export async function formatAlert(env: Env, a: AlertInput): Promise<string> {
  const where = `Cloudflare ${await checkLocation()}`;
  const dash = env.DASHBOARD_URL ?? '';
  if (a.kind === 'recovered') {
    const mins = a.downSince ? Math.max(1, Math.round((a.now - a.downSince) / 60000)) : null;
    return [
      `✅ RECOVERED — ${a.component}`,
      ...a.checks.map((c) => `Check: ${c.name}`),
      mins ? `Was failing for about ${mins} min (since ${formatEat(a.downSince!)})` : '',
      `Automated checks passed twice in a row. Verify the customer flow before resolving any public incident.`,
      `Dashboard: ${dash}`,
    ].filter(Boolean).join('\n');
  }
  return [
    a.kind === 'down' ? `🔴 OUTAGE — ${a.component}` : `🟡 DEGRADED — ${a.component}`,
    ...a.checks.map((c) => `Check: ${c.name}\nReason: ${c.reason}`),
    `First failure: ${a.firstFailureAt ? formatEat(a.firstFailureAt) : formatEat(a.now)}`,
    `Checked from: ${where}`,
    `Dashboard: ${dash}`,
  ].filter(Boolean).join('\n');
}

/** Sends to every configured private channel. Returns true if at least one succeeded. */
export async function sendAlert(env: Env, text: string): Promise<boolean> {
  const jobs: Promise<boolean>[] = [];
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    jobs.push(
      fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
      }).then((r) => r.ok).catch(() => false),
    );
  }
  if (env.ALERT_WEBHOOK_URL) {
    // `text` works for Slack and Google Chat; `content` for Discord.
    jobs.push(
      fetch(env.ALERT_WEBHOOK_URL, {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, content: text }),
      }).then((r) => r.ok).catch(() => false),
    );
  }
  if (jobs.length === 0) {
    console.warn('No alert channel configured', text);
    return false;
  }
  const results = await Promise.all(jobs);
  return results.some(Boolean);
}
