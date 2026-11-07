import type { Env } from './types';
import { settings } from './config';
import { loadSnapshot, runMonitors } from './store';
import { present } from './present';
import { authenticate } from './auth';
import { handleAdmin } from './admin';
import { handleLogin } from './session';

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
};

function jsonResponse(data: unknown, init: ResponseInit & { cacheSeconds?: number } = {}) {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', init.cacheSeconds ? `public, max-age=${init.cacheSeconds}` : 'no-store');
  headers.set('Access-Control-Allow-Origin', '*');
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  return new Response(JSON.stringify(data), { status: init.status ?? 200, headers });
}

async function publicStatus(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // Short edge cache so a traffic spike during an outage costs almost nothing.
  const ttl = Number(env.PUBLIC_CACHE_SECONDS ?? 15);
  const cache = caches.default;
  const key = new Request(new URL('/api/status.json', req.url).toString());
  if (ttl > 0) {
    const hit = await cache.match(key);
    if (hit) return hit;
  }
  const snap = await loadSnapshot(env);
  const body = present(snap, Date.now(), settings(env).staleMs);
  const resp = jsonResponse(body, { cacheSeconds: ttl > 0 ? ttl : undefined });
  if (ttl > 0) ctx.waitUntil(cache.put(key, resp.clone()));
  return resp;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === '/api/status.json' && (req.method === 'GET' || req.method === 'HEAD')) {
      try {
        return await publicStatus(req, env, ctx);
      } catch (e) {
        console.error(e);
        // The page treats this as "Status unavailable" and keeps its last known result.
        return jsonResponse({ error: 'Status data temporarily unavailable' }, { status: 503 });
      }
    }
    if (path.startsWith('/api/')) return jsonResponse({ error: 'Not found' }, { status: 404 });

    if (path === '/admin/api/login' || path === '/admin/api/logout') {
      return handleLogin(req, env, path.endsWith('login') ? 'login' : 'logout');
    }
    if (path.startsWith('/admin/api/')) {
      const op = await authenticate(req, env);
      if (!op) return jsonResponse({ error: 'Not signed in' }, { status: 401 });
      return handleAdmin(req, env, op, path);
    }

    return env.ASSETS.fetch(req);
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runMonitors(env).then((r) => console.log('checks', r)));
  },
} satisfies ExportedHandler<Env>;
