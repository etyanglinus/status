/** Pure status logic: per-check state machine, component status and overall banner.
 *  Kept free of I/O so it can be unit-tested. */
import type { CheckStateRow, ComponentStatus, FailureKind, Impact, Outcome } from './types';

export interface Thresholds { failThreshold: number; recoverThreshold: number }
export type CheckEvent = 'down' | 'degraded' | 'recovered' | null;

export function emptyState(id: string): CheckStateRow {
  return {
    check_id: id, state: 'up', fail_streak: 0, slow_streak: 0, ok_streak: 0, up_streak: 0,
    first_failure_at: null, down_since: null, last_outcome: null, last_reason: null, last_kind: null,
    last_status: null, last_latency_ms: null, last_result_at: null,
  };
}

/**
 * Applies one result to a check's state.
 *  - `down` only after `failThreshold` consecutive failures (one failed request never creates an outage)
 *  - recovery from `down` only after `recoverThreshold` consecutive non-failing results
 *  - `degraded` after `failThreshold` consecutive slow/failed results, cleared by `recoverThreshold` good ones
 */
export function advance(
  prev: CheckStateRow,
  r: { outcome: Outcome; reason: string; status: number | null; latencyMs: number; kind?: FailureKind },
  now: number,
  t: Thresholds,
): { next: CheckStateRow; event: CheckEvent } {
  const failStreak = r.outcome === 'down' ? prev.fail_streak + 1 : 0;
  const slowStreak = r.outcome !== 'up' ? prev.slow_streak + 1 : 0;
  const okStreak = r.outcome !== 'down' ? prev.ok_streak + 1 : 0;
  const upStreak = r.outcome === 'up' ? prev.up_streak + 1 : 0;

  let state: Outcome = prev.state;
  let event: CheckEvent = null;
  if (prev.state === 'down') {
    if (okStreak >= t.recoverThreshold) {
      state = r.outcome === 'degraded' ? 'degraded' : 'up';
      event = 'recovered';
    }
  } else if (failStreak >= t.failThreshold) {
    state = 'down';
    event = 'down';
  } else if (prev.state === 'degraded') {
    if (upStreak >= t.recoverThreshold) { state = 'up'; event = 'recovered'; }
  } else if (slowStreak >= t.failThreshold) {
    state = 'degraded';
    event = 'degraded';
  }

  // When the current run of failures began (shown in alerts). Cleared once fully healthy.
  let firstFailureAt = prev.first_failure_at;
  if (r.outcome === 'down' && firstFailureAt === null) firstFailureAt = now;
  else if (state === 'up' && r.outcome === 'up') firstFailureAt = null;

  return {
    event,
    next: {
      check_id: prev.check_id,
      state,
      fail_streak: failStreak,
      slow_streak: slowStreak,
      ok_streak: okStreak,
      up_streak: upStreak,
      first_failure_at: firstFailureAt,
      down_since: state === 'down' ? (prev.state === 'down' ? prev.down_since : now) : null,
      last_outcome: r.outcome,
      last_reason: r.reason,
      last_kind: r.kind ?? (r.outcome === 'up' ? 'ok' : null),
      last_status: r.status,
      last_latency_ms: r.latencyMs,
      last_result_at: now,
    },
  };
}

/** Automated status of a component from the thresholded states of its live checks. */
export function automatedStatus(states: Outcome[]): ComponentStatus {
  if (states.length === 0) return 'unmonitored';
  const down = states.filter((s) => s === 'down').length;
  if (down === states.length) return 'major_outage';
  if (down > 0) return 'partial_outage';
  if (states.includes('degraded')) return 'degraded';
  return 'operational';
}

const RANK: Record<string, number> = {
  operational: 0, unmonitored: 0, maintenance: 1, degraded: 2, partial_outage: 3, major_outage: 4,
};

/**
 * Final public status for one component.
 *  - an open incident can only make things look worse, never better, than measurements
 *  - an operator can keep an incident open after automated checks recover
 *  - during scheduled maintenance the component shows "maintenance" unless an incident says worse
 *  - when monitoring data is stale the automated part becomes "unavailable"
 */
export function resolveStatus(opts: {
  auto: ComponentStatus;
  stale: boolean;
  incidentImpacts: Impact[];
  inMaintenance: boolean;
}): ComponentStatus {
  const worstIncident = opts.incidentImpacts.reduce<Impact | null>(
    (w, i) => (w === null || RANK[i] > RANK[w] ? i : w), null);
  const auto: ComponentStatus = opts.stale && opts.auto !== 'unmonitored' ? 'unavailable' : opts.auto;

  if (opts.inMaintenance) {
    return worstIncident && RANK[worstIncident] > RANK.maintenance ? worstIncident : 'maintenance';
  }
  if (auto === 'unavailable') return worstIncident ?? 'unavailable';
  if (!worstIncident) return auto;
  return RANK[worstIncident] >= RANK[auto] ? worstIncident : auto;
}

export type Overall =
  | 'operational' | 'degraded' | 'disruption' | 'maintenance' | 'unavailable' | 'partly_unavailable';

export function overallStatus(statuses: ComponentStatus[]): Overall {
  const s = statuses.filter((x) => x !== 'unmonitored');
  if (s.length === 0 || s.every((x) => x === 'unavailable')) return 'unavailable';
  if (s.includes('major_outage')) return 'disruption';
  if (s.includes('partial_outage') || s.includes('degraded')) return 'degraded';
  if (s.includes('unavailable')) return 'partly_unavailable';
  if (s.includes('maintenance')) return 'maintenance';
  return 'operational';
}
