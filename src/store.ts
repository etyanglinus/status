import type { CheckStateRow, Env, FailureKind, Impact, Outcome, Stage } from './types';
import { COMPONENTS, buildPlan, settings } from './config';
import { memoFetch, runCheck } from './checks';
import { advance, automatedStatus, emptyState } from './engine';
import { formatAlert, sendAlert } from './alerts';
import { DAY_MS, eatDay } from './time';

export const HISTORY_DAYS = 90;
const HOURLY_KEEP_DAYS = 8;
const DAILY_KEEP_DAYS = 120;
const DAILY_REFRESH_MS = 10 * 60_000;   // re-read 90-day history at most every 10 minutes
const HOUR_MS = 3600_000;

/** EAT hour bucket, e.g. "2026-11-07T14". */
export function eatHour(ts: number): string {
  return new Date(ts + 3 * HOUR_MS).toISOString().slice(0, 13);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DayAgg { total: number; ok: number; degraded: number; down: number; lat_sum: number; lat_max: number }
export interface HourPoint { hour: string; total: number; ok: number; degraded: number; down: number; lat_avg: number | null; lat_max: number | null }

export interface CheckSnap {
  id: string;
  label: string;
  detail: string;
  depth: 'basic' | 'deep';
  state: Outcome | 'unknown';
  kind: FailureKind | null;
  latency_ms: number | null;
  last_result_at: number | null;
  since: number | null;               // when the current problem started
  hourly: HourPoint[];                 // last 24 hours, oldest first
  daily: Record<string, DayAgg>;       // EAT date -> totals from completed hours (last 90 days)
  unrolled: Record<string, DayAgg>;    // results from the current, not-yet-rolled hour(s)
}

export interface Snapshot {
  version: 2;
  built_at: number;
  last_run_at: number | null;
  daily_built_at: number;
  components: {
    id: string; name: string; description: string; group: string;
    auto: ReturnType<typeof automatedStatus>;
    monitoring: 'deep' | 'basic' | 'none';
    checks: CheckSnap[];
    pending: string[];
  }[];
  outages: PublicOutage[];
  incidents: PublicIncident[];
  maintenance: PublicMaintenance[];
  changelog: PublicChangelog[];
  roadmap: PublicRoadmap[];
}
export interface PublicOutage {
  component: string; check: string; severity: 'down' | 'degraded'; kind: FailureKind; started_at: number; ended_at: number | null;
}
export interface PublicIncident {
  id: number; title: string; stage: Stage; impact: Impact; components: string[];
  started_at: number; resolved_at: number | null; next_update_at: number | null;
  updates: { stage: Stage; message: string; created_at: number; next_update_at: number | null }[];
}
export interface PublicMaintenance {
  id: number; title: string; message: string; components: string[]; starts_at: number; ends_at: number;
}
export interface PublicChangelog {
  id: number; title: string; body: string; category: string; audience: string; published_at: number;
}
export interface PublicRoadmap {
  id: number; title: string; description: string; stage: string; audience: string; eta_label: string | null; sort_order: number;
}

interface StatesDoc { last_run_at: number | null; states: Record<string, CheckStateRow> }

const json = <T>(s: string | null | undefined, fallback: T): T => {
  try { return s ? (JSON.parse(s) as T) : fallback; } catch { return fallback; }
};
const putMeta = (env: Env, key: string, value: string) =>
  env.DB.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(key, value);

/** All check states live in one meta row, so a monitoring run costs one write for them. */
export async function loadStates(env: Env): Promise<StatesDoc> {
  const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'states'`).first<{ value: string }>();
  if (row) return json<StatesDoc>(row.value, { last_run_at: null, states: {} });
  // First run after upgrading from v1: import the old per-row table once.
  const states: Record<string, CheckStateRow> = {};
  try {
    const { results } = await env.DB.prepare('SELECT * FROM check_state').all<CheckStateRow>();
    for (const r of results) states[r.check_id] = r;
  } catch { /* table may not exist on fresh installs */ }
  const last = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'last_run_at'`).first<{ value: string }>();
  return { last_run_at: last ? Number(last.value) : null, states };
}

/** Runs `fn` over `items` with at most `limit` in flight, preserving order. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---------------------------------------------------------------------------
// Monitoring run (cron, every minute)
// ---------------------------------------------------------------------------

export async function runMonitors(env: Env, now = Date.now()): Promise<{ checked: number; events: number }> {
  const owner = crypto.randomUUID();
  const lease = await env.DB.prepare(
    "INSERT INTO monitor_lease (id, owner, expires_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at WHERE monitor_lease.expires_at < ? RETURNING owner"
  ).bind(owner, Date.now() + 300_000, Date.now()).first<{ owner: string }>();
  if (!lease || lease.owner !== owner) return { checked: 0, events: 0 };
  try {
    return await runLeasedMonitors(env, now);
  } finally {
    await env.DB.prepare('DELETE FROM monitor_lease WHERE id = 1 AND owner = ?').bind(owner).run();
  }
}

async function runLeasedMonitors(env: Env, now: number): Promise<{ checked: number; events: number }> {
  const cfg = settings(env);
  const plan = buildPlan(env);
  const doc = await loadStates(env);
  const fetcher = memoFetch();

  // Workers allow 6 simultaneous outgoing connections. Run at most 6 checks at a time so each
  // check's timer only starts when its request actually goes out (queued time is not "slowness").
  const results = await pool(plan.checks, 6, (c) => runCheck(c, cfg, fetcher));
  const hour = eatHour(now);
  const stmts: D1PreparedStatement[] = [];
  const groups = new Map<string, { component: string; kind: 'down' | 'degraded' | 'recovered'; items: { id: string; name: string; reason: string; failKind: FailureKind; first: number | null; downSince: number | null }[] }>();
  let events = 0;

  plan.checks.forEach((def, i) => {
    const r = results[i];
    const prev = doc.states[def.id] ?? emptyState(def.id);
    const { next, event } = advance(prev, r, now, cfg);
    doc.states[def.id] = next;

    const lat = r.outcome === 'down' ? 0 : r.latencyMs;
    stmts.push(env.DB.prepare(
      `INSERT INTO hourly (check_id, hour, total, ok, degraded, down, lat_sum, lat_max) VALUES (?, ?, 1, ?, ?, ?, ?, ?)
       ON CONFLICT(check_id, hour) DO UPDATE SET total = total + 1, ok = ok + excluded.ok, degraded = degraded + excluded.degraded,
         down = down + excluded.down, lat_sum = lat_sum + excluded.lat_sum, lat_max = max(lat_max, excluded.lat_max)`,
    ).bind(def.id, hour, r.outcome === 'up' ? 1 : 0, r.outcome === 'degraded' ? 1 : 0, r.outcome === 'down' ? 1 : 0, lat, lat));

    if (event) {
      stmts.push(env.DB.prepare('INSERT INTO check_events (check_id, kind, reason, at, alerted) VALUES (?,?,?,?,0)').bind(def.id, event, r.reason, now));
      events++;
      // Problem periods for the public "detected problems" log.
      if (event === 'recovered') {
        stmts.push(env.DB.prepare('UPDATE outages SET ended_at = ? WHERE check_id = ? AND ended_at IS NULL').bind(now, def.id));
      } else {
        stmts.push(env.DB.prepare('UPDATE outages SET ended_at = ? WHERE check_id = ? AND ended_at IS NULL').bind(now, def.id));
        stmts.push(env.DB.prepare('INSERT INTO outages (check_id, component, severity, kind, started_at) VALUES (?, ?, ?, ?, ?)')
          .bind(def.id, def.component, event, r.kind, event === 'down' ? (next.first_failure_at ?? now) : now));
      }
      const key = `${def.component}:${event}`;
      const g = groups.get(key) ?? { component: def.component, kind: event, items: [] };
      g.items.push({ id: def.id, name: def.name, reason: r.reason, failKind: r.kind, first: next.first_failure_at ?? prev.first_failure_at, downSince: prev.down_since });
      groups.set(key, g);
    }
  });

  // Roll finished hours into the daily table when the hour changes.
  let rolled = false;
  if (doc.last_run_at !== null && eatHour(doc.last_run_at) !== hour) {
    stmts.push(env.DB.prepare(
      `INSERT INTO daily (check_id, day, total, ok, degraded, down, lat_sum, lat_max)
       SELECT check_id, substr(hour, 1, 10), SUM(total), SUM(ok), SUM(degraded), SUM(down), SUM(lat_sum), MAX(lat_max)
       FROM hourly WHERE rolled = 0 AND hour < ? GROUP BY check_id, substr(hour, 1, 10)
       ON CONFLICT(check_id, day) DO UPDATE SET total = total + excluded.total, ok = ok + excluded.ok,
         degraded = degraded + excluded.degraded, down = down + excluded.down, lat_sum = lat_sum + excluded.lat_sum,
         lat_max = max(lat_max, excluded.lat_max)`,
    ).bind(hour));
    stmts.push(env.DB.prepare('UPDATE hourly SET rolled = 1 WHERE rolled = 0 AND hour < ?').bind(hour));
    rolled = true;
  }

  // Keep only states for checks that still exist.
  const live = new Set(plan.checks.map((c) => c.id));
  for (const id of Object.keys(doc.states)) if (!live.has(id)) delete doc.states[id];
  doc.last_run_at = now;
  stmts.push(putMeta(env, 'states', JSON.stringify(doc)));
  for (const [key, group] of groups) {
    stmts.push(env.DB.prepare(
      'INSERT OR IGNORE INTO alert_outbox (event_key, payload, created_at) VALUES (?, ?, ?)'
    ).bind(String(now) + ':' + key, JSON.stringify(group), now));
  }
  await env.DB.batch(stmts);

  // State and notification intent were committed together. Retry unsent messages.
  const pending = await env.DB.prepare(
    'SELECT event_key, payload, created_at FROM alert_outbox WHERE sent_at IS NULL ORDER BY created_at LIMIT 10'
  ).all<{ event_key: string; payload: string; created_at: number }>();
  for (const row of pending.results) {
    const group = JSON.parse(row.payload) as { component: string; kind: 'down' | 'degraded' | 'recovered'; items: { name: string; reason: string; first: number | null; downSince: number | null }[] };
    const firsts = group.items.map((item) => item.first).filter((value): value is number => value !== null);
    const downs = group.items.map((item) => item.downSince).filter((value): value is number => value !== null);
    const message = await formatAlert(env, {
      kind: group.kind,
      component: COMPONENTS.find((component) => component.id === group.component)?.name ?? group.component,
      checks: group.items,
      firstFailureAt: firsts.length ? Math.min(...firsts) : null,
      downSince: downs.length ? Math.min(...downs) : null,
      now,
    });
    const delivered = await sendAlert(env, message.slice(0, 3900));
    if (delivered) {
      for (const item of group.items) {
        await env.DB.prepare('UPDATE check_events SET alerted = 1 WHERE at = ? AND kind = ? AND reason = ?')
          .bind(row.created_at, group.kind, item.reason).run();
      }
    }
    await env.DB.prepare(
      'UPDATE alert_outbox SET attempts = attempts + 1, sent_at = ? WHERE event_key = ?'
    ).bind(delivered ? Date.now() : null, row.event_key).run();
  }

  // Housekeeping once a day (first run after midnight EAT).
  if (eatDay(now - 60_000) !== eatDay(now)) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM hourly WHERE rolled = 1 AND hour < ?').bind(eatHour(now - HOURLY_KEEP_DAYS * DAY_MS)),
      env.DB.prepare('DELETE FROM daily WHERE day < ?').bind(eatDay(now - DAILY_KEEP_DAYS * DAY_MS)),
      env.DB.prepare('DELETE FROM check_events WHERE at < ?').bind(now - 180 * DAY_MS),
      env.DB.prepare('DELETE FROM outages WHERE started_at < ? AND ended_at IS NOT NULL').bind(now - 180 * DAY_MS),
      env.DB.prepare('DELETE FROM login_attempts WHERE at < ?').bind(now - DAY_MS),
    ]);
  }

  await rebuildSnapshot(env, now, { doc, forceDaily: rolled });
  return { checked: plan.checks.length, events };
}

// ---------------------------------------------------------------------------
// Snapshot: everything the public page needs, prebuilt so a page view reads one row.
// ---------------------------------------------------------------------------

export async function rebuildSnapshot(
  env: Env, now = Date.now(), opts: { doc?: StatesDoc; forceDaily?: boolean } = {},
): Promise<Snapshot> {
  const plan = buildPlan(env);
  const doc = opts.doc ?? await loadStates(env);
  const prev = await loadSnapshot(env);
  const ids = plan.checks.map((c) => c.id);
  const qs = ids.map(() => '?').join(',') || "''";
  const horizon = now - HISTORY_DAYS * DAY_MS;
  const hourFrom = eatHour(now - 23 * HOUR_MS);

  const needDaily = opts.forceDaily || !prev || prev.version !== 2 || now - prev.daily_built_at > DAILY_REFRESH_MS
    || ids.some((id) => !prev.components.some((c) => c.checks.some((k) => k.id === id)));

  const queries: D1PreparedStatement[] = [
    env.DB.prepare(`SELECT check_id, hour, total, ok, degraded, down, lat_sum, lat_max, rolled FROM hourly WHERE check_id IN (${qs}) AND hour >= ?`).bind(...ids, hourFrom),
    env.DB.prepare('SELECT * FROM incidents WHERE resolved_at IS NULL OR started_at >= ? ORDER BY started_at DESC LIMIT 200').bind(horizon),
    env.DB.prepare(`SELECT u.incident_id, u.stage, u.message, u.created_at, u.next_update_at FROM incident_updates u
                    JOIN incidents i ON i.id = u.incident_id WHERE i.resolved_at IS NULL OR i.started_at >= ? ORDER BY u.created_at DESC`).bind(horizon),
    env.DB.prepare('SELECT id, title, message, components, starts_at, ends_at FROM maintenance WHERE cancelled = 0 AND ends_at >= ? ORDER BY starts_at ASC LIMIT 100').bind(horizon),
    env.DB.prepare('SELECT id, title, body, category, audience, published_at FROM changelog WHERE draft = 0 ORDER BY published_at DESC LIMIT 100'),
    env.DB.prepare('SELECT id, title, description, stage, audience, eta_label, sort_order FROM roadmap WHERE hidden = 0 ORDER BY sort_order ASC, id ASC'),
    env.DB.prepare('SELECT check_id, component, severity, kind, started_at, ended_at FROM outages WHERE ended_at IS NULL OR started_at >= ? ORDER BY started_at DESC LIMIT 200').bind(now - 30 * DAY_MS),
  ];
  if (needDaily) {
    queries.push(env.DB.prepare(`SELECT check_id, day, total, ok, degraded, down, lat_sum, lat_max FROM daily WHERE check_id IN (${qs}) AND day >= ?`)
      .bind(...ids, eatDay(now - (HISTORY_DAYS - 1) * DAY_MS)));
  }
  const [hourlyQ, incidents, updates, maint, changelog, roadmap, outagesQ, dailyQ] = await env.DB.batch(queries);

  // Daily history: fresh from the table, or reused from the previous snapshot.
  const dailyBy = new Map<string, Record<string, DayAgg>>();
  if (needDaily && dailyQ) {
    for (const d of dailyQ.results as any[]) {
      const m = dailyBy.get(d.check_id) ?? {};
      m[d.day] = { total: d.total, ok: d.ok, degraded: d.degraded, down: d.down, lat_sum: d.lat_sum, lat_max: d.lat_max };
      dailyBy.set(d.check_id, m);
    }
  } else if (prev) {
    for (const c of prev.components) for (const k of c.checks) dailyBy.set(k.id, k.daily);
  }

  // Hourly: last 24 hours for charts; unrolled hours are added on top of the daily totals.
  const hours: string[] = [];
  for (let i = 23; i >= 0; i--) hours.push(eatHour(now - i * HOUR_MS));
  const hourlyBy = new Map<string, Map<string, any>>();
  const unrolled = new Map<string, Record<string, DayAgg>>();
  for (const h of hourlyQ.results as any[]) {
    const m = hourlyBy.get(h.check_id) ?? new Map();
    m.set(h.hour, h);
    hourlyBy.set(h.check_id, m);
    if (!h.rolled) {
      const u = unrolled.get(h.check_id) ?? {};
      const day = h.hour.slice(0, 10);
      const a = (u[day] ??= { total: 0, ok: 0, degraded: 0, down: 0, lat_sum: 0, lat_max: 0 });
      a.total += h.total; a.ok += h.ok; a.degraded += h.degraded; a.down += h.down; a.lat_sum += h.lat_sum; a.lat_max = Math.max(a.lat_max, h.lat_max);
      unrolled.set(h.check_id, u);
    }
  }

  const checkSnap = (def: (typeof plan.checks)[number]): CheckSnap => {
    const st = doc.states[def.id];
    const hm = hourlyBy.get(def.id);
    const hourly: HourPoint[] = hours.map((hour) => {
      const h = hm?.get(hour);
      if (!h) return { hour, total: 0, ok: 0, degraded: 0, down: 0, lat_avg: null, lat_max: null };
      const n = h.ok + h.degraded;
      return { hour, total: h.total, ok: h.ok, degraded: h.degraded, down: h.down, lat_avg: n ? Math.round(h.lat_sum / n) : null, lat_max: n ? h.lat_max : null };
    });
    return {
      id: def.id, label: def.publicLabel, detail: def.publicDetail ?? def.publicLabel, depth: def.depth,
      state: st?.last_result_at ? st.state : 'unknown',
      kind: st?.state === 'up' ? 'ok' : (st?.last_kind ?? null),
      latency_ms: st?.last_outcome === 'down' ? null : (st?.last_latency_ms ?? null),
      last_result_at: st?.last_result_at ?? null,
      since: st?.state === 'down' ? st.down_since : null,
      hourly,
      daily: dailyBy.get(def.id) ?? {},
      unrolled: unrolled.get(def.id) ?? {},
    };
  };

  const components = COMPONENTS.map((c) => {
    const defs = plan.checks.filter((k) => k.component === c.id);
    return {
      id: c.id, name: c.name, description: c.description, group: c.group,
      auto: automatedStatus(defs.map((k) => doc.states[k.id]?.state ?? 'up')),
      monitoring: (defs.some((k) => k.depth === 'deep') ? 'deep' : defs.length ? 'basic' : 'none') as 'deep' | 'basic' | 'none',
      checks: defs.map(checkSnap),
      pending: plan.pending.filter((p) => p.component === c.id).map((p) => p.publicLabel),
    };
  });

  const updatesBy = new Map<number, PublicIncident['updates']>();
  for (const u of updates.results as any[]) {
    const list = updatesBy.get(u.incident_id) ?? [];
    list.push({ stage: u.stage, message: u.message, created_at: u.created_at, next_update_at: u.next_update_at });
    updatesBy.set(u.incident_id, list);
  }

  const snap: Snapshot = {
    version: 2,
    built_at: now,
    last_run_at: doc.last_run_at,
    daily_built_at: needDaily ? now : prev!.daily_built_at,
    components,
    outages: (outagesQ.results as any[]).map((o) => ({
      component: o.component,
      check: plan.checks.find((k) => k.id === o.check_id)?.publicLabel ?? 'Automated check',
      severity: o.severity, kind: o.kind, started_at: o.started_at, ended_at: o.ended_at,
    })),
    incidents: (incidents.results as any[]).map((i) => ({
      id: i.id, title: i.title, stage: i.stage, impact: i.impact, components: json<string[]>(i.components, []),
      started_at: i.started_at, resolved_at: i.resolved_at, next_update_at: i.next_update_at,
      updates: updatesBy.get(i.id) ?? [],
    })),
    maintenance: (maint.results as any[]).map((m) => ({ ...m, components: json<string[]>(m.components, []) })),
    changelog: changelog.results as unknown as PublicChangelog[],
    roadmap: roadmap.results as unknown as PublicRoadmap[],
  };

  await putMeta(env, 'snapshot', JSON.stringify(snap)).run();
  return snap;
}

export async function loadSnapshot(env: Env): Promise<Snapshot | null> {
  const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'snapshot'`).first<{ value: string }>();
  const s = row ? json<Snapshot | null>(row.value, null) : null;
  return s && (s as Snapshot).version === 2 ? s : null;
}
