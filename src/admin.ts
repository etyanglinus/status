import type { Env, Impact, Stage } from './types';
import type { Operator } from './auth';
import { COMPONENTS, COMPONENT_IDS, buildPlan, settings } from './config';
import { loadSnapshot, loadStates, rebuildSnapshot, runMonitors } from './store';

const STAGES: Stage[] = ['investigating', 'identified', 'monitoring', 'resolved'];
const IMPACTS: Impact[] = ['degraded', 'partial_outage', 'major_outage'];
const CATEGORIES = ['new', 'improved', 'fixed'];
const AUDIENCES = ['everyone', 'customers', 'sellers', 'riders'];
const ROADMAP_STAGES = ['planned', 'in_progress', 'beta', 'shipped'];

class BadRequest extends Error {}

const res = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

function str(v: unknown, field: string, max: number, required = true): string | null {
  if (v === undefined || v === null || v === '') {
    if (required) throw new BadRequest(`${field} is required`);
    return null;
  }
  if (typeof v !== 'string') throw new BadRequest(`${field} must be text`);
  const s = v.trim();
  if (required && !s) throw new BadRequest(`${field} is required`);
  if (s.length > max) throw new BadRequest(`${field} must be at most ${max} characters`);
  return s;
}
function oneOf<T extends string>(v: unknown, field: string, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !allowed.includes(v as T)) throw new BadRequest(`${field} must be one of: ${allowed.join(', ')}`);
  return v as T;
}
function ts(v: unknown, field: string, required = true): number | null {
  if (v === undefined || v === null || v === '') {
    if (required) throw new BadRequest(`${field} is required`);
    return null;
  }
  const n = typeof v === 'number' ? v : Date.parse(String(v));
  if (!Number.isFinite(n)) throw new BadRequest(`${field} must be a date/time`);
  return n;
}
function comps(v: unknown, required = true): string[] {
  if (!Array.isArray(v) || (required && v.length === 0)) throw new BadRequest('Select at least one affected component');
  const out = [...new Set(v.map(String))];
  for (const c of out) if (!COMPONENT_IDS.includes(c)) throw new BadRequest(`Unknown component: ${c}`);
  return out;
}
const int = (v: unknown, d = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);
const bool = (v: unknown) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);

/** Redacts query strings (tracking check carries a test order id/contact). */
const redact = (url: string) => { try { const u = new URL(url); return u.search ? `${u.origin}${u.pathname}?…` : url; } catch { return url; } };

export async function handleAdmin(req: Request, env: Env, op: Operator, path: string): Promise<Response> {
  const method = req.method;
  if (method !== 'GET') {
    // CSRF guard: browsers cannot add this header cross-site without CORS approval.
    if (req.headers.get('X-Requested-With') !== 'fasta-status') return res({ error: 'Missing X-Requested-With header' }, 403);
  }
  let body: any = {};
  if (method === 'POST' || method === 'PATCH') {
    try { body = await req.json(); } catch { return res({ error: 'Body must be JSON' }, 400); }
  }
  const now = Date.now();
  const seg = path.replace(/^\/admin\/api\/?/, '').split('/').filter(Boolean);
  const id = seg[1] ? Number(seg[1]) : null;
  if (seg[1] && !Number.isInteger(id)) return res({ error: 'Bad id' }, 400);
  const db = env.DB;

  try {
    let out: unknown;
    let changed = false;
    switch (`${method} ${seg[0] ?? ''}${seg.length > 1 ? '/:id' : ''}${seg[2] ? '/' + seg[2] : ''}`) {
      case 'GET me':
        out = { email: op.email, via: op.via };
        break;

      case 'GET overview': {
        const plan = buildPlan(env);
        const [doc, snap, events, outages] = await Promise.all([
          loadStates(env),
          loadSnapshot(env),
          db.prepare('SELECT * FROM check_events ORDER BY at DESC LIMIT 300').all(),
          db.prepare('SELECT * FROM outages ORDER BY started_at DESC LIMIT 200').all(),
        ]);
        const snapBy = new Map((snap?.components ?? []).flatMap((c) => c.checks.map((k) => [k.id, k] as const)));
        const uptime = (k: any, days: number) => {
          if (!k) return null;
          const keys = Object.keys({ ...k.daily, ...k.unrolled }).sort().slice(-days);
          let good = 0, total = 0;
          for (const d of keys) for (const a of [k.daily[d], k.unrolled?.[d]]) if (a) { good += a.ok + a.degraded; total += a.total; }
          return total ? Math.round((good / total) * 10000) / 100 : null;
        };
        out = {
          now,
          settings: settings(env),
          last_run_at: doc.last_run_at,
          components: COMPONENTS,
          checks: plan.checks.map((c) => {
            const k = snapBy.get(c.id);
            let h24Good = 0, h24Tot = 0;
            for (const h of k?.hourly ?? []) { h24Tot += h.total; h24Good += h.ok + h.degraded; }
            const lats = (k?.hourly ?? []).map((h) => h.lat_avg).filter((x): x is number => x !== null);
            return {
              id: c.id, component: c.component, name: c.name, label: c.publicLabel, depth: c.depth,
              method: c.method ?? 'GET', url: redact(c.urlFrom ? c.urlFrom.url : c.url),
              expect: c.expectStatus ?? [200], slow_ms: c.slowMs ?? settings(env).slowMs,
              state: doc.states[c.id] ?? null,
              uptime_24h: h24Tot ? Math.round((h24Good / h24Tot) * 10000) / 100 : null,
              uptime_7d: uptime(k, 7), uptime_30d: uptime(k, 30),
              avg_24h_ms: lats.length ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : null,
              max_24h_ms: (k?.hourly ?? []).reduce((m, h) => Math.max(m, h.lat_max ?? 0), 0) || null,
              hourly: k?.hourly ?? [],
            };
          }),
          pending: plan.pending,
          events: events.results,
          outages: outages.results,
        };
        break;
      }

      case 'POST run-checks':
        out = await runMonitors(env);
        break;

      // ---------------- Incidents ----------------
      case 'GET incidents': {
        const [inc, upd] = await db.batch([
          db.prepare('SELECT * FROM incidents ORDER BY started_at DESC LIMIT 200'),
          db.prepare('SELECT * FROM incident_updates ORDER BY created_at DESC LIMIT 2000'),
        ]);
        out = (inc.results as any[]).map((i) => ({
          ...i, components: JSON.parse(i.components),
          updates: (upd.results as any[]).filter((u) => u.incident_id === i.id),
        }));
        break;
      }
      case 'POST incidents': {
        const title = str(body.title, 'Title', 160)!;
        const impact = oneOf(body.impact, 'Impact', IMPACTS);
        const components = comps(body.components);
        const stage = oneOf(body.stage ?? 'investigating', 'Stage', STAGES.filter((s) => s !== 'resolved'));
        const message = str(body.message, 'Message', 4000)!;
        const next = ts(body.next_update_at, 'Next update', false);
        const started = ts(body.started_at, 'Start time', false) ?? now;
        const r = await db.prepare(
          `INSERT INTO incidents (title, stage, impact, components, started_at, next_update_at, created_by, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`,
        ).bind(title, stage, impact, JSON.stringify(components), started, next, op.email, now, now).first<{ id: number }>();
        await db.prepare('INSERT INTO incident_updates (incident_id, stage, message, next_update_at, created_by, created_at) VALUES (?,?,?,?,?,?)')
          .bind(r!.id, stage, message, next, op.email, now).run();
        out = { id: r!.id }; changed = true;
        break;
      }
      case 'POST incidents/:id/updates': {
        const stage = oneOf(body.stage, 'Stage', STAGES);
        const message = str(body.message, 'Message', 4000)!;
        const next = stage === 'resolved' ? null : ts(body.next_update_at, 'Next update', false);
        const inc = await db.prepare('SELECT * FROM incidents WHERE id = ?').bind(id).first<any>();
        if (!inc) return res({ error: 'Incident not found' }, 404);
        const impact = body.impact ? oneOf(body.impact, 'Impact', IMPACTS) : inc.impact;
        const components = body.components ? comps(body.components) : JSON.parse(inc.components);
        const resolvedAt = stage === 'resolved' ? (inc.resolved_at ?? now) : null;
        await db.batch([
          db.prepare('INSERT INTO incident_updates (incident_id, stage, message, next_update_at, created_by, created_at) VALUES (?,?,?,?,?,?)')
            .bind(id, stage, message, next, op.email, now),
          db.prepare('UPDATE incidents SET stage = ?, impact = ?, components = ?, next_update_at = ?, resolved_at = ?, updated_at = ? WHERE id = ?')
            .bind(stage, impact, JSON.stringify(components), next, resolvedAt, now, id),
        ]);
        out = { ok: true }; changed = true;
        break;
      }
      case 'PATCH incidents/:id': {
        const inc = await db.prepare('SELECT * FROM incidents WHERE id = ?').bind(id).first<any>();
        if (!inc) return res({ error: 'Incident not found' }, 404);
        await db.prepare('UPDATE incidents SET title = ?, impact = ?, components = ?, started_at = ?, updated_at = ? WHERE id = ?').bind(
          body.title !== undefined ? str(body.title, 'Title', 160) : inc.title,
          body.impact !== undefined ? oneOf(body.impact, 'Impact', IMPACTS) : inc.impact,
          body.components !== undefined ? JSON.stringify(comps(body.components)) : inc.components,
          body.started_at !== undefined ? ts(body.started_at, 'Start time') : inc.started_at,
          now, id,
        ).run();
        out = { ok: true }; changed = true;
        break;
      }
      case 'DELETE incidents/:id':
        await db.batch([
          db.prepare('DELETE FROM incident_updates WHERE incident_id = ?').bind(id),
          db.prepare('DELETE FROM incidents WHERE id = ?').bind(id),
        ]);
        out = { ok: true }; changed = true;
        break;

      // ---------------- Maintenance ----------------
      case 'GET maintenance':
        out = ((await db.prepare('SELECT * FROM maintenance ORDER BY starts_at DESC LIMIT 200').all()).results as any[])
          .map((m) => ({ ...m, components: JSON.parse(m.components) }));
        break;
      case 'POST maintenance':
      case 'PATCH maintenance/:id': {
        const existing = id ? await db.prepare('SELECT * FROM maintenance WHERE id = ?').bind(id).first<any>() : null;
        if (id && !existing) return res({ error: 'Not found' }, 404);
        const pick = <T>(k: string, f: () => T, old: T) => (body[k] !== undefined || !existing ? f() : old);
        const title = pick('title', () => str(body.title, 'Title', 160)!, existing?.title);
        const message = pick('message', () => str(body.message, 'Customer impact', 4000)!, existing?.message);
        const components = pick('components', () => JSON.stringify(comps(body.components)), existing?.components);
        const starts = pick('starts_at', () => ts(body.starts_at, 'Start')!, existing?.starts_at);
        const ends = pick('ends_at', () => ts(body.ends_at, 'End')!, existing?.ends_at);
        if (ends <= starts) throw new BadRequest('End must be after start');
        const cancelled = pick('cancelled', () => bool(body.cancelled), existing?.cancelled ?? 0);
        if (existing) {
          await db.prepare('UPDATE maintenance SET title=?, message=?, components=?, starts_at=?, ends_at=?, cancelled=?, updated_at=? WHERE id=?')
            .bind(title, message, components, starts, ends, cancelled, now, id).run();
          out = { ok: true };
        } else {
          out = await db.prepare(`INSERT INTO maintenance (title, message, components, starts_at, ends_at, cancelled, created_by, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`).bind(title, message, components, starts, ends, cancelled, op.email, now, now).first();
        }
        changed = true;
        break;
      }
      case 'DELETE maintenance/:id':
        await db.prepare('DELETE FROM maintenance WHERE id = ?').bind(id).run();
        out = { ok: true }; changed = true;
        break;

      // ---------------- Changelog ----------------
      case 'GET changelog':
        out = (await db.prepare('SELECT * FROM changelog ORDER BY published_at DESC LIMIT 500').all()).results;
        break;
      case 'POST changelog':
      case 'PATCH changelog/:id': {
        const existing = id ? await db.prepare('SELECT * FROM changelog WHERE id = ?').bind(id).first<any>() : null;
        if (id && !existing) return res({ error: 'Not found' }, 404);
        const pick = <T>(k: string, f: () => T, old: T) => (body[k] !== undefined || !existing ? f() : old);
        const vals = [
          pick('title', () => str(body.title, 'Title', 160)!, existing?.title),
          pick('body', () => str(body.body, 'Description', 8000)!, existing?.body),
          pick('category', () => oneOf(body.category, 'Category', CATEGORIES), existing?.category),
          pick('audience', () => oneOf(body.audience ?? 'everyone', 'Audience', AUDIENCES), existing?.audience),
          pick('published_at', () => ts(body.published_at, 'Publish date', false) ?? now, existing?.published_at),
          pick('draft', () => bool(body.draft), existing?.draft ?? 0),
        ];
        if (existing) {
          await db.prepare('UPDATE changelog SET title=?, body=?, category=?, audience=?, published_at=?, draft=?, updated_at=? WHERE id=?')
            .bind(...vals, now, id).run();
          out = { ok: true };
        } else {
          out = await db.prepare(`INSERT INTO changelog (title, body, category, audience, published_at, draft, created_by, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`).bind(...vals, op.email, now, now).first();
        }
        changed = true;
        break;
      }
      case 'DELETE changelog/:id':
        await db.prepare('DELETE FROM changelog WHERE id = ?').bind(id).run();
        out = { ok: true }; changed = true;
        break;

      // ---------------- Upcoming features (roadmap) ----------------
      case 'GET roadmap':
        out = (await db.prepare('SELECT * FROM roadmap ORDER BY sort_order ASC, id ASC').all()).results;
        break;
      case 'POST roadmap':
      case 'PATCH roadmap/:id': {
        const existing = id ? await db.prepare('SELECT * FROM roadmap WHERE id = ?').bind(id).first<any>() : null;
        if (id && !existing) return res({ error: 'Not found' }, 404);
        const pick = <T>(k: string, f: () => T, old: T) => (body[k] !== undefined || !existing ? f() : old);
        const vals = [
          pick('title', () => str(body.title, 'Title', 160)!, existing?.title),
          pick('description', () => str(body.description, 'Description', 4000)!, existing?.description),
          pick('stage', () => oneOf(body.stage, 'Stage', ROADMAP_STAGES), existing?.stage),
          pick('audience', () => oneOf(body.audience ?? 'everyone', 'Audience', AUDIENCES), existing?.audience),
          pick('eta_label', () => str(body.eta_label, 'Timing', 60, false), existing?.eta_label),
          pick('sort_order', () => int(body.sort_order), existing?.sort_order ?? 0),
          pick('hidden', () => bool(body.hidden), existing?.hidden ?? 0),
        ];
        if (existing) {
          await db.prepare('UPDATE roadmap SET title=?, description=?, stage=?, audience=?, eta_label=?, sort_order=?, hidden=?, updated_at=? WHERE id=?')
            .bind(...vals, now, id).run();
          out = { ok: true };
        } else {
          out = await db.prepare(`INSERT INTO roadmap (title, description, stage, audience, eta_label, sort_order, hidden, created_by, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`).bind(...vals, op.email, now, now).first();
        }
        changed = true;
        break;
      }
      case 'DELETE roadmap/:id':
        await db.prepare('DELETE FROM roadmap WHERE id = ?').bind(id).run();
        out = { ok: true }; changed = true;
        break;

      default:
        return res({ error: 'Not found' }, 404);
    }
    if (changed) await rebuildSnapshot(env, now);
    return res(out);
  } catch (e) {
    if (e instanceof BadRequest) return res({ error: e.message }, 400);
    console.error(e);
    return res({ error: 'Something went wrong' }, 500);
  }
}
