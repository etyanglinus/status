import type { Env } from './types';
import { readSession } from './session';

/** Who is calling the admin API. Cloudflare Access sits in front of /admin* and signs
 *  every request with a JWT; we verify it here too, so the admin API is never open even
 *  if the Access policy is misconfigured. */
export interface Operator { email: string; via: 'access' | 'password' | 'token' | 'dev' }

type Jwk = JsonWebKey & { kid: string };
let certCache: { at: number; keys: Jwk[] } | null = null;

const b64urlToBytes = (s: string) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

async function accessKeys(team: string, force = false): Promise<Jwk[]> {
  if (!force && certCache && Date.now() - certCache.at < 3600_000) return certCache.keys;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error('Could not load Access certs');
  const body = (await res.json()) as { keys: Jwk[] };
  certCache = { at: Date.now(), keys: body.keys };
  return body.keys;
}

export async function verifyAccessJwt(token: string, env: Env): Promise<string | null> {
  const team = env.ACCESS_TEAM_DOMAIN, aud = env.ACCESS_AUD;
  if (!team || !aud || team.startsWith('REPLACE') || aud.startsWith('REPLACE')) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header: { kid?: string; alg?: string }, payload: Record<string, any>;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
  } catch { return null; }
  if (header.alg !== 'RS256') return null;

  let keys = await accessKeys(team);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) { keys = await accessKeys(team, true); jwk = keys.find((k) => k.kid === header.kid); }
  if (!jwk) return null;

  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  const auds: string[] = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) return null;
  if (typeof payload.exp !== 'number' || payload.exp < nowSec) return null;
  if (typeof payload.nbf === 'number' && payload.nbf > nowSec + 60) return null;
  if (payload.iss !== `https://${team}`) return null;
  return typeof payload.email === 'string' ? payload.email : null;
}

function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export async function authenticate(req: Request, env: Env): Promise<Operator | null> {
  const jwt = req.headers.get('Cf-Access-Jwt-Assertion');
  if (jwt) {
    const email = await verifyAccessJwt(jwt, env).catch(() => null);
    if (email) return { email, via: 'access' };
  }
  const sessionEmail = await readSession(req, env);
  if (sessionEmail) return { email: sessionEmail, via: 'password' };
  const auth = req.headers.get('Authorization');
  if (env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= 32 && auth?.startsWith('Bearer ') && safeEqual(auth.slice(7), env.ADMIN_TOKEN)) {
    return { email: 'break-glass-token', via: 'token' };
  }
  // Local development only (`wrangler dev` with DEV_ADMIN_EMAIL in .dev.vars). On Cloudflare's edge
  // CF-Connecting-IP is set by Cloudflare to the real client address, so it can never be loopback.
  const ip = req.headers.get('CF-Connecting-IP') ?? '';
  if (env.DEV_ADMIN_EMAIL && new URL(req.url).protocol === 'http:' && (ip === '127.0.0.1' || ip === '::1')) {
    return { email: env.DEV_ADMIN_EMAIL, via: 'dev' };
  }
  return null;
}
