import { describe, expect, it } from 'vitest';
import { memoFetch, runCheck, PUBLIC_KIND_TEXT } from '../src/checks';
import { buildPlan } from '../src/config';
import type { Env } from '../src/types';

const opts = { timeoutMs: 1000, slowMs: 500 };
const json = (o: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...headers } });
const base = { id: 'x', component: 'api', name: 'x', publicLabel: 'x', depth: 'deep' as const, url: 'https://f/api' };

describe('v2 checks', () => {
  it('expected validation error proves sign-in service is up', async () => {
    const def = { ...base, method: 'POST' as const, body: '{}', expectStatus: [422], json: [{ path: 'errors.0.code', equals: 'login_type' }] };
    expect((await runCheck(def, opts, (async () => json({ errors: [{ code: 'login_type' }] }, 422)) as any)).outcome).toBe('up');
    const r = await runCheck(def, opts, (async () => json({ message: 'Server Error' }, 500)) as any);
    expect(r.outcome).toBe('down');
    expect(r.kind).toBe('server_error');
  });
  it('payment rule passes with cash on delivery OR an online gateway', async () => {
    const def = { ...base, json: [{ path: 'content', explain: 'No payment method', anyOf: [
      { path: 'content.cash_on_delivery', equals: true },
      { path: 'content.active_payment_method_list', type: 'array' as const, nonEmpty: true }] }] };
    const run = (c: unknown) => runCheck(def, opts, (async () => json({ content: c })) as any);
    expect((await run({ cash_on_delivery: true, active_payment_method_list: [] })).outcome).toBe('up');
    expect((await run({ cash_on_delivery: false, active_payment_method_list: ['mpesa'] })).outcome).toBe('up');
    const bad = await run({ cash_on_delivery: false, active_payment_method_list: [] });
    expect(bad.outcome).toBe('down');
    expect(bad.reason).toBe('No payment method');
  });
  it('maintenance mode on is reported as a maintenance problem', async () => {
    const def = { ...base, json: [{ path: 'content.maintenance_mode', equals: false, failKind: 'maintenance' as const }] };
    const r = await runCheck(def, opts, (async () => json({ content: { maintenance_mode: true } })) as any);
    expect(r.outcome).toBe('down');
    expect(r.kind).toBe('maintenance');
    expect(PUBLIC_KIND_TEXT[r.kind]).toBe('Showing a maintenance page');
  });
  it('image check follows the URL from JSON and requires an image', async () => {
    const def = { ...base, urlFrom: { url: 'https://f/api/v1/config', path: 'content.logo_full_url' }, contentType: 'image/' };
    const ok = (async (u: string) => u.endsWith('config') ? json({ content: { logo_full_url: 'https://f/logo.png' } })
      : new Response('PNG', { headers: { 'content-type': 'image/png' } })) as any;
    expect((await runCheck(def, opts, ok)).outcome).toBe('up');
    const html = (async (u: string) => u.endsWith('config') ? json({ content: { logo_full_url: 'https://f/logo.png' } })
      : new Response('<html>', { headers: { 'content-type': 'text/html' } })) as any;
    const r = await runCheck(def, opts, html);
    expect(r.outcome).toBe('down');
    expect(r.kind).toBe('content');
  });
  it('every failure kind has public text without URLs', () => {
    for (const t of Object.values(PUBLIC_KIND_TEXT)) expect(t).not.toMatch(/https?:|\/api|\.php/);
  });
  it('memoFetch sends one request for repeated GETs but never shares POSTs', async () => {
    let n = 0;
    const f = memoFetch((async () => { n++; return json({ a: 1 }); }) as any);
    await Promise.all([f('https://f/api/v1/config'), f('https://f/api/v1/config'), f('https://f/api/v1/config')]);
    expect(n).toBe(1);
    await f('https://f/login', { method: 'POST', body: '{}' });
    await f('https://f/login', { method: 'POST', body: '{}' });
    expect(n).toBe(3);
  });
  it('plan has 11 components covered and no check sends real data', () => {
    const env = { STOREFRONT_URL: 'https://web', API_URL: 'https://api', SELLER_LOGIN_PATH: '/login/vendor' } as Env;
    const plan = buildPlan(env);
    expect(plan.checks.length).toBeGreaterThanOrEqual(17);
    expect(new Set(plan.checks.map((c) => c.component)).size).toBe(11);
    for (const c of plan.checks.filter((c) => c.method === 'POST')) expect(c.body).toBe('{}');
    expect(new Set(plan.checks.map((c) => c.id)).size).toBe(plan.checks.length);
  });
});

import { pool } from '../src/store';
describe('pool', () => {
  it('never runs more than the limit at once and keeps order', async () => {
    let live = 0, peak = 0;
    const out = await pool([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 6, async (n) => {
      live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--; return n * 2;
    });
    expect(peak).toBeLessThanOrEqual(6);
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
  });
});

describe('shared responses', () => {
  it('report the real request time, not ~0 ms', async () => {
    const slowFetch = (async () => { await new Promise((r) => setTimeout(r, 60)); return new Response(JSON.stringify({ content: { business_name: 'F' } }), { headers: { 'content-type': 'application/json' } }); }) as any;
    const f = memoFetch(slowFetch);
    const def = { id: 'a', component: 'api', name: 'a', publicLabel: 'a', depth: 'deep' as const, url: 'https://f/api/v1/config', json: [{ path: 'content.business_name', type: 'string' as const }] };
    const first = await runCheck(def, { timeoutMs: 1000, slowMs: 5000 }, f);
    const second = await runCheck({ ...def, id: 'b' }, { timeoutMs: 1000, slowMs: 5000 }, f);
    expect(first.latencyMs).toBeGreaterThanOrEqual(50);
    expect(second.latencyMs).toBeGreaterThanOrEqual(50);
    expect(second.outcome).toBe('up');
  });
});

describe('maintenance wording', () => {
  it('a missing maintenance field is "incomplete data", not "maintenance"', async () => {
    const def = { ...base, json: [{ path: 'content.maintenance_mode', equals: false, failKind: 'maintenance' as const }] };
    const r = await runCheck(def, opts, (async () => json({ content: {} })) as any);
    expect(r.kind).toBe('structure');
  });
});
