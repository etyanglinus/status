import { describe, expect, it } from 'vitest';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { createSession, readSession, verifyPassword } from '../src/session';
import type { Env } from '../src/types';

// Same hashing as scripts/setup.mjs
const hash = (pw: string) => {
  const salt = randomBytes(16);
  return `pbkdf2$100000$${salt.toString('base64')}$${pbkdf2Sync(pw, salt, 100000, 32, 'sha256').toString('base64')}`;
};
const env = (extra: Partial<Env> = {}) =>
  ({ ADMIN_USERS: JSON.stringify({ 'ops@fasta.co.ke': hash('correct horse battery') }), SESSION_SECRET: 'x'.repeat(64), ...extra }) as Env;
const withCookie = (v: string) => new Request('https://s/admin/api/me', { headers: { Cookie: `other=1; fs_session=${v}` } });

describe('password sign-in', () => {
  it('verifies hashes produced by the setup script', async () => {
    const h = hash('correct horse battery');
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('wrong password!!', h)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
  it('issues and reads a signed session', async () => {
    const e = env();
    const tok = await createSession(e, 'ops@fasta.co.ke');
    expect(await readSession(withCookie(tok), e)).toBe('ops@fasta.co.ke');
  });
  it('rejects tampered sessions, other secrets and removed operators', async () => {
    const e = env();
    const tok = await createSession(e, 'ops@fasta.co.ke');
    const [p, s] = tok.split('.');
    const forged = btoa(JSON.stringify({ e: 'ops@fasta.co.ke', x: Date.now() + 9e9 })).replace(/=+$/, '');
    expect(await readSession(withCookie(`${forged}.${s}`), e)).toBeNull();
    expect(await readSession(withCookie(`${p}.AAAA`), e)).toBeNull();
    expect(await readSession(withCookie(tok), env({ SESSION_SECRET: 'y'.repeat(64) }))).toBeNull();
    expect(await readSession(withCookie(tok), env({ ADMIN_USERS: '{}' }))).toBeNull();
  });
});
