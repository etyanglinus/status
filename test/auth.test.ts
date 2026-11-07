import { afterEach, describe, expect, it, vi } from 'vitest';
import { authenticate } from '../src/auth';
import type { Env } from '../src/types';

const TEAM = 'fasta.cloudflareaccess.com';
const AUD = 'aud-tag-123';
const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

async function keypair() {
  const kp = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', kp.publicKey)) as JsonWebKey;
  return { kp, jwk: { ...jwk, kid: 'k1', alg: 'RS256' } };
}
async function sign(kp: CryptoKeyPair, payload: Record<string, unknown>) {
  const head = enc({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
  const body = enc(payload);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}
const env = (extra: Partial<Env> = {}) => ({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ...extra }) as Env;
const req = (headers: Record<string, string>, url = 'https://status.fastadeliveries.co.ke/admin/api/me') => new Request(url, { headers });

afterEach(() => vi.unstubAllGlobals());

describe('admin authentication', () => {
  it('accepts a valid Cloudflare Access JWT', async () => {
    const { kp, jwk } = await keypair();
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ keys: [jwk] })));
    const exp = Math.floor(Date.now() / 1000) + 600;
    const t = await sign(kp, { aud: [AUD], email: 'ops@fastadeliveries.co.ke', exp, iss: `https://${TEAM}` });
    expect(await authenticate(req({ 'Cf-Access-Jwt-Assertion': t }), env())).toEqual({ email: 'ops@fastadeliveries.co.ke', via: 'access' });
  });
  it('rejects wrong audience, expired or tampered tokens', async () => {
    const { kp, jwk } = await keypair();
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ keys: [jwk] })));
    const exp = Math.floor(Date.now() / 1000) + 600;
    const wrongAud = await sign(kp, { aud: ['other'], email: 'a@b', exp, iss: `https://${TEAM}` });
    const expired = await sign(kp, { aud: [AUD], email: 'a@b', exp: 1, iss: `https://${TEAM}` });
    const good = await sign(kp, { aud: [AUD], email: 'a@b', exp, iss: `https://${TEAM}` });
    const [h, , s] = good.split('.');
    const tampered = `${h}.${enc({ aud: [AUD], email: 'attacker@x', exp, iss: `https://${TEAM}` })}.${s}`;
    for (const t of [wrongAud, expired, tampered, 'garbage']) {
      expect(await authenticate(req({ 'Cf-Access-Jwt-Assertion': t }), env())).toBeNull();
    }
  });
  it('rejects requests with no credentials, even with a spoofed Host', async () => {
    expect(await authenticate(req({ Host: 'localhost' }), env({ DEV_ADMIN_EMAIL: 'dev@x' }))).toBeNull();
    expect(await authenticate(req({ 'CF-Connecting-IP': '41.90.1.2' }, 'http://status.fastadeliveries.co.ke/admin/api/me'), env({ DEV_ADMIN_EMAIL: 'dev@x' }))).toBeNull();
  });
  it('break-glass token requires 32+ chars and an exact match', async () => {
    const tok = 'x'.repeat(40);
    expect(await authenticate(req({ Authorization: `Bearer ${tok}` }), env({ ADMIN_TOKEN: tok }))).toEqual({ email: 'break-glass-token', via: 'token' });
    expect(await authenticate(req({ Authorization: `Bearer ${tok}y` }), env({ ADMIN_TOKEN: tok }))).toBeNull();
    expect(await authenticate(req({ Authorization: 'Bearer short' }), env({ ADMIN_TOKEN: 'short' }))).toBeNull();
  });
  it('is closed when Access is not configured yet', async () => {
    expect(await authenticate(req({ 'Cf-Access-Jwt-Assertion': 'a.b.c' }), env({ ACCESS_AUD: 'REPLACE_ME' }))).toBeNull();
  });
});
