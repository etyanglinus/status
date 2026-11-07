import { describe, expect, it } from 'vitest';
import { advance, automatedStatus, emptyState, overallStatus, resolveStatus } from '../src/engine';
import { checkJson, runCheck } from '../src/checks';
import type { Outcome } from '../src/types';

const T = { failThreshold: 3, recoverThreshold: 2 };
const run = (outcomes: Outcome[]) => {
  let s = emptyState('x');
  const events: (string | null)[] = [];
  outcomes.forEach((o, i) => {
    const r = advance(s, { outcome: o, reason: o, status: 200, latencyMs: 10 }, 1000 * (i + 1), T);
    s = r.next; events.push(r.event);
  });
  return { s, events };
};

describe('check state machine', () => {
  it('one failed request does not create an outage', () => {
    const { s, events } = run(['up', 'down', 'up']);
    expect(s.state).toBe('up');
    expect(events.filter(Boolean)).toEqual([]);
  });
  it('alerts after three consecutive failures and records the first failure time', () => {
    const { s, events } = run(['up', 'down', 'down', 'down']);
    expect(s.state).toBe('down');
    expect(events[3]).toBe('down');
    expect(s.first_failure_at).toBe(2000);
    expect(s.down_since).toBe(4000);
  });
  it('fires the outage event only once', () => {
    const { events } = run(['down', 'down', 'down', 'down', 'down']);
    expect(events.filter((e) => e === 'down')).toHaveLength(1);
  });
  it('needs two consecutive successes to recover', () => {
    const a = run(['down', 'down', 'down', 'up']);
    expect(a.s.state).toBe('down');
    const b = run(['down', 'down', 'down', 'up', 'down', 'up']);
    expect(b.s.state).toBe('down');
    const c = run(['down', 'down', 'down', 'up', 'up']);
    expect(c.s.state).toBe('up');
    expect(c.events[4]).toBe('recovered');
  });
  it('marks sustained slowness as degraded', () => {
    expect(run(['degraded', 'degraded']).s.state).toBe('up');
    expect(run(['degraded', 'degraded', 'degraded']).s.state).toBe('degraded');
    expect(run(['degraded', 'degraded', 'degraded', 'up', 'up']).s.state).toBe('up');
  });
});

describe('component status', () => {
  it('derives outage level from its checks', () => {
    expect(automatedStatus([])).toBe('unmonitored');
    expect(automatedStatus(['up', 'up'])).toBe('operational');
    expect(automatedStatus(['up', 'degraded'])).toBe('degraded');
    expect(automatedStatus(['up', 'down'])).toBe('partial_outage');
    expect(automatedStatus(['down', 'down'])).toBe('major_outage');
  });
  it('stale data shows Status unavailable', () => {
    expect(resolveStatus({ auto: 'operational', stale: true, incidentImpacts: [], inMaintenance: false })).toBe('unavailable');
  });
  it('an operator incident stays visible after automated recovery', () => {
    expect(resolveStatus({ auto: 'operational', stale: false, incidentImpacts: ['partial_outage'], inMaintenance: false })).toBe('partial_outage');
  });
  it('an incident never hides a worse measured outage', () => {
    expect(resolveStatus({ auto: 'major_outage', stale: false, incidentImpacts: ['degraded'], inMaintenance: false })).toBe('major_outage');
  });
  it('maintenance overrides measured downtime, but not a worse incident', () => {
    expect(resolveStatus({ auto: 'major_outage', stale: false, incidentImpacts: [], inMaintenance: true })).toBe('maintenance');
    expect(resolveStatus({ auto: 'operational', stale: false, incidentImpacts: ['major_outage'], inMaintenance: true })).toBe('major_outage');
  });
  it('overall banner', () => {
    expect(overallStatus(['operational', 'unmonitored'])).toBe('operational');
    expect(overallStatus(['operational', 'degraded'])).toBe('degraded');
    expect(overallStatus(['operational', 'major_outage'])).toBe('disruption');
    expect(overallStatus(['unavailable', 'unavailable', 'unmonitored'])).toBe('unavailable');
    expect(overallStatus(['operational', 'maintenance'])).toBe('maintenance');
  });
});

describe('content checks', () => {
  const opts = { timeoutMs: 1000, slowMs: 500 };
  const fake = (body: string, init: ResponseInit & { url?: string } = {}) =>
    (async () => {
      const r = new Response(body, init);
      if (init.url) Object.defineProperty(r, 'url', { value: init.url });
      return r;
    }) as unknown as typeof fetch;

  it('flags HTTP 200 with unexpected content', async () => {
    const r = await runCheck({ id: 'a', component: 'api', name: 'up', publicLabel: '', depth: 'basic', url: 'https://x/up', mustContain: ['Application up'] },
      opts, fake('<h1>Something else</h1>', { status: 200 }));
    expect(r.outcome).toBe('down');
    expect(r.reason).toMatch(/Expected content missing/);
  });
  it('flags an empty JSON list', async () => {
    const r = await runCheck({ id: 'a', component: 'api', name: 'cat', publicLabel: '', depth: 'deep', url: 'https://x/api',
      json: [{ path: 'content.data', type: 'array', nonEmpty: true }] }, opts, fake('{"content":{"data":[]}}', { status: 200 }));
    expect(r.outcome).toBe('down');
    expect(r.reason).toMatch(/empty/);
  });
  it('flags a redirect to the maintenance page', async () => {
    const r = await runCheck({ id: 'a', component: 'storefront', name: 'home', publicLabel: '', depth: 'basic', url: 'https://x/', followRedirects: false },
      opts, fake('', { status: 307, headers: { location: '/maintainance' } }));
    expect(r.outcome).toBe('down');
    expect(r.reason).toMatch(/maintenance/);
  });
  it('flags landing on the maintenance page after following redirects', async () => {
    const r = await runCheck({ id: 'a', component: 'storefront', name: 'home', publicLabel: '', depth: 'basic', url: 'https://x/', forbidFinalUrl: /maintain/i, mustContain: ['__NEXT_DATA__'] },
      opts, fake('<script id="__NEXT_DATA__"></script>', { status: 200, url: 'https://x/maintainance' }));
    expect(r.outcome).toBe('down');
  });
  it('passes valid JSON structure', () => {
    expect(checkJson({ content: { business_name: 'Fasta' } }, [{ path: 'content.business_name', type: 'string', nonEmpty: true }])).toBeNull();
  });
  it('times out', async () => {
    const hang = ((_u: string, init: RequestInit) => new Promise((_, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted'))))) as unknown as typeof fetch;
    const r = await runCheck({ id: 'a', component: 'api', name: 'up', publicLabel: '', depth: 'basic', url: 'https://x/up' }, { timeoutMs: 50, slowMs: 500 }, hang);
    expect(r.outcome).toBe('down');
    expect(r.reason).toMatch(/Timed out/);
  });
});
