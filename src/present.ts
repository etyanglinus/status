import type { DayAgg, Snapshot } from './store';
import { HISTORY_DAYS } from './store';
import { overallStatus, resolveStatus } from './engine';
import { PUBLIC_KIND_TEXT } from './checks';
import { lastDays } from './time';
import { COMPONENTS } from './config';
import type { ComponentStatus, FailureKind } from './types';

const OVERALL_TEXT: Record<string, string> = {
  operational: 'All monitored systems operational',
  degraded: 'Some services are degraded',
  disruption: 'Service disruption',
  maintenance: 'Scheduled maintenance in progress',
  unavailable: 'Status unavailable',
  partly_unavailable: 'Some status information is unavailable',
};

const pct = (good: number, total: number) => (total ? Math.round((good / total) * 10000) / 100 : null);
const merge = (a?: DayAgg, b?: DayAgg): DayAgg | undefined => {
  if (!a) return b; if (!b) return a;
  return { total: a.total + b.total, ok: a.ok + b.ok, degraded: a.degraded + b.degraded, down: a.down + b.down, lat_sum: a.lat_sum + b.lat_sum, lat_max: Math.max(a.lat_max, b.lat_max) };
};

/** Public JSON for the status page. Computed per request so "stale" and maintenance windows are
 *  always judged against the current time. Contains no URLs, raw error messages or secrets. */
export function present(snap: Snapshot | null, now: number, staleMs: number) {
  const lastRun = snap?.last_run_at ?? null;
  const stale = !snap || lastRun === null || now - lastRun > staleMs;
  const days = lastDays(now, HISTORY_DAYS);
  const active = (snap?.incidents ?? []).filter((i) => i.resolved_at === null);
  const inWindow = (snap?.maintenance ?? []).filter((m) => m.starts_at <= now && m.ends_at > now);
  const incidentDays = new Map<string, Set<string>>();   // component -> EAT days with an incident
  for (const i of snap?.incidents ?? []) {
    const end = i.resolved_at ?? now;
    for (let t = i.started_at; t <= end + 1; t += 86_400_000) {
      for (const c of i.components) {
        const set = incidentDays.get(c) ?? new Set();
        set.add(new Date(t + 3 * 3600_000).toISOString().slice(0, 10));
        incidentDays.set(c, set);
      }
    }
  }

  const components = (snap?.components ?? []).map((c) => {
    const inputs = {
      auto: c.auto,
      incidentImpacts: active.filter((i) => i.components.includes(c.id)).map((i) => i.impact),
      inMaintenance: inWindow.some((m) => m.components.includes(c.id)),
    };
    const status: ComponentStatus = resolveStatus({ ...inputs, stale });
    const lastConfirmed = stale && lastRun !== null && status === 'unavailable'
      ? { status: resolveStatus({ ...inputs, stale: false }), at: lastRun } : null;

    // Per-day totals across this component's checks.
    const perDay = (day: string) => {
      let agg: DayAgg | undefined;
      for (const k of c.checks) agg = merge(agg, merge(k.daily[day], k.unrolled?.[day]));
      return agg;
    };
    const dayAggs = days.map((d) => [d, perDay(d)] as const);
    const windowUptime = (n: number) => {
      let good = 0, total = 0;
      for (const [, a] of dayAggs.slice(-n)) if (a) { good += a.ok + a.degraded; total += a.total; }
      return pct(good, total);
    };

    // Hourly response time across checks: average of the checks' hourly averages.
    const hourly = (c.checks[0]?.hourly ?? []).map((_, i) => {
      let tot = 0, good = 0, latSum = 0, latN = 0, latMax = 0;
      for (const k of c.checks) {
        const h = k.hourly[i];
        if (!h) continue;
        tot += h.total; good += h.ok + h.degraded;
        if (h.lat_avg !== null) { latSum += h.lat_avg; latN++; latMax = Math.max(latMax, h.lat_max ?? 0); }
      }
      return { hour: c.checks[0].hourly[i].hour, uptime: pct(good, tot), avg_ms: latN ? Math.round(latSum / latN) : null, max_ms: latN ? latMax : null };
    });
    let h24Good = 0, h24Total = 0;
    for (const k of c.checks) for (const h of k.hourly) { h24Total += h.total; h24Good += h.ok + h.degraded; }
    const latNow = c.checks.map((k) => k.latency_ms).filter((x): x is number => x !== null);
    const lat24 = hourly.map((h) => h.avg_ms).filter((x): x is number => x !== null);

    return {
      id: c.id,
      name: c.name,
      description: c.description,
      group: c.group,
      status,
      last_confirmed: lastConfirmed,
      monitoring: c.monitoring,
      checks: c.checks.map((k) => {
        const kStatus = stale ? 'unavailable' : k.state === 'down' ? 'down' : k.state === 'degraded' ? 'degraded' : k.state === 'up' ? 'operational' : 'unknown';
        let kGood = 0, kTot = 0;
        for (const h of k.hourly) { kTot += h.total; kGood += h.ok + h.degraded; }
        return {
          label: k.label,
          detail: k.detail,
          depth: k.depth,
          status: kStatus,
          problem: kStatus === 'down' || kStatus === 'degraded' ? PUBLIC_KIND_TEXT[(k.kind ?? 'connection') as FailureKind] : null,
          since: k.since,
          response_ms: k.latency_ms,
          last_checked_at: k.last_result_at,
          uptime_24h: pct(kGood, kTot),
        };
      }),
      pending_checks: c.pending,
      uptime: { h24: pct(h24Good, h24Total), d7: windowUptime(7), d30: windowUptime(30), d90: windowUptime(90) },
      response: {
        current_ms: latNow.length ? Math.round(latNow.reduce((a, b) => a + b, 0) / latNow.length) : null,
        avg_24h_ms: lat24.length ? Math.round(lat24.reduce((a, b) => a + b, 0) / lat24.length) : null,
        hourly,
      },
      uptime_90d: windowUptime(90),
      history: dayAggs.map(([day, a]) => (a && a.total
        ? {
            day,
            uptime: pct(a.ok + a.degraded, a.total),
            samples: a.total,
            down_minutes: a.down,
            degraded_minutes: a.degraded,
            avg_ms: a.lat_sum > 0 && a.ok + a.degraded ? Math.round(a.lat_sum / (a.ok + a.degraded)) : null,
            incident: incidentDays.get(c.id)?.has(day) ?? false,
          }
        : { day, uptime: null, samples: 0, incident: incidentDays.get(c.id)?.has(day) ?? false })),
    };
  });

  const overall = overallStatus(components.map((c) => c.status));
  const byStart = (a: { started_at: number }, b: { started_at: number }) => b.started_at - a.started_at;
  const nameOf = (id: string) => COMPONENTS.find((c) => c.id === id)?.name ?? id;

  return {
    generated_at: now,
    last_checked_at: lastRun,
    stale,
    overall: { status: overall, text: OVERALL_TEXT[overall] },
    summary: {
      operational: components.filter((c) => c.status === 'operational').length,
      affected: components.filter((c) => ['degraded', 'partial_outage', 'major_outage'].includes(c.status)).length,
      monitored_checks: components.reduce((n, c) => n + c.checks.length, 0),
      planned_checks: components.reduce((n, c) => n + c.pending_checks.length, 0),
    },
    components,
    detections: (snap?.outages ?? []).map((o) => ({
      component: o.component,
      component_name: nameOf(o.component),
      check: o.check,
      severity: o.severity,
      problem: PUBLIC_KIND_TEXT[o.kind] ?? 'Problem detected',
      started_at: o.started_at,
      ended_at: o.ended_at,
    })),
    active_incidents: active.sort(byStart),
    maintenance: {
      in_progress: inWindow,
      upcoming: (snap?.maintenance ?? []).filter((m) => m.starts_at > now).sort((a, b) => a.starts_at - b.starts_at),
      recent: (snap?.maintenance ?? []).filter((m) => m.ends_at <= now).sort((a, b) => b.ends_at - a.ends_at).slice(0, 10),
    },
    past_incidents: (snap?.incidents ?? []).filter((i) => i.resolved_at !== null).sort(byStart),
    changelog: (snap?.changelog ?? []).filter((e) => e.published_at <= now),
    roadmap: snap?.roadmap ?? [],
  };
}
