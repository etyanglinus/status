/** Built-in operator login (email + password) with an HMAC-signed session cookie.
 *  Operators are stored in the ADMIN_USERS secret as JSON: {"email": "pbkdf2$<iter>$<saltB64>$<hashB64>"}.
 *  `npm run setup` (scripts/setup.mjs) creates the hashes; plain passwords are never stored. */
import type { Env } from './types';

export const COOKIE = 'fs_session';
const SESSION_HOURS = 12;
const MAX_FAILS = 8;               // failed attempts per IP address ...
const WINDOW_MS = 15 * 60 * 1000;  // ... in 15 minutes

const enc = new TextEncoder();
const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (b: ArrayBuffer | Uint8Array) => b64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) => unb64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export function users(env: Env): Record<string, string> {
  try {
    const v = JSON.parse(env.ADMIN_USERS || '{}');
    const out: Record<string, string> = {};
    for (const [k, h] of Object.entries(v)) if (typeof h === 'string') out[k.trim().toLowerCase()] = h;
    return out;
  } catch {
    return {};
  }
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterS, saltS, hashS] = stored.split('$');
  if (scheme !== 'pbkdf2' || !iterS || !saltS || !hashS) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: unb64(saltS), iterations: Number(iterS) }, key, 256);
  return equal(new Uint8Array(bits), unb64(hashS));
}

async function hmacKey(env: Env) {
  return crypto.subtle.importKey('raw', enc.encode(env.SESSION_SECRET!), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export function sessionsEnabled(env: Env): boolean {
  return !!env.SESSION_SECRET && env.SESSION_SECRET.length >= 32 && Object.keys(users(env)).length > 0;
}

export async function createSession(env: Env, email: string): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify({ e: email, x: Date.now() + SESSION_HOURS * 3600_000 })));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(payload));
  return `${payload}.${b64url(sig)}`;
}

export async function readSession(req: Request, env: Env): Promise<string | null> {
  if (!sessionsEnabled(env)) return null;
  const raw = (req.headers.get('Cookie') ?? '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!raw) return null;
  const [payload, sig] = raw.split('.');
  if (!payload || !sig) return null;
  let ok = false;
  try { ok = await crypto.subtle.verify('HMAC', await hmacKey(env), unb64url(sig), enc.encode(payload)); } catch { return null; }
  if (!ok) return null;
  try {
    const { e, x } = JSON.parse(new TextDecoder().decode(unb64url(payload)));
    if (typeof e !== 'string' || typeof x !== 'number' || x < Date.now()) return null;
    return users(env)[e] ? e : null;   // removed operators lose access immediately
  } catch {
    return null;
  }
}

export function cookieHeader(value: string, maxAgeSec: number, secure: boolean): string {
  return `${COOKIE}=${value}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

/** POST /admin/api/login and /admin/api/logout (no session required). */
export async function handleLogin(req: Request, env: Env, action: 'login' | 'logout'): Promise<Response> {
  const secure = new URL(req.url).protocol === 'https:';
  if (req.method !== 'POST' || req.headers.get('X-Requested-With') !== 'fasta-status') return json({ error: 'Bad request' }, 400);
  if (action === 'logout') return json({ ok: true }, 200, { 'Set-Cookie': cookieHeader('', 0, secure) });
  if (!sessionsEnabled(env)) return json({ error: 'Password sign-in is not set up. Run `npm run setup` or use Cloudflare Access.' }, 503);

  let body: { email?: unknown; password?: unknown };
  try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
  const email = String(body.email ?? '').trim().toLowerCase().slice(0, 200);
  const password = String(body.password ?? '').slice(0, 500);
  const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown';
  const now = Date.now();
  // Lock out by IP only. Locking by email would let anyone lock a real operator out during an outage.
  const keys = [`ip:${ip}`];

  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM login_attempts WHERE key = ? AND at > ?`,
  ).bind(keys[0], now - WINDOW_MS).first<{ n: number }>();
  if (row && row.n >= MAX_FAILS) return json({ error: 'Too many attempts. Wait 15 minutes and try again.' }, 429);

  const stored = users(env)[email];
  // Always run the hash so response time doesn't reveal which emails exist.
  const ok = await verifyPassword(password, stored ?? 'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
  if (!stored || !ok) {
    await env.DB.batch([
      ...keys.map((k) => env.DB.prepare('INSERT INTO login_attempts (key, at) VALUES (?, ?)').bind(k, now)),
      env.DB.prepare('DELETE FROM login_attempts WHERE at < ?').bind(now - 24 * 3600_000),
    ]);
    return json({ error: 'Wrong email or password' }, 401);
  }
  const token = await createSession(env, email);
  return json({ ok: true, email }, 200, { 'Set-Cookie': cookieHeader(token, SESSION_HOURS * 3600, secure) });
}
