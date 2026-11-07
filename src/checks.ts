import type { CheckDef, CheckResult, FailureKind, JsonExpectation } from './types';

const MAX_BODY = 2 * 1024 * 1024;
const UA = 'FastaStatus/1.0 (+https://status.fastadeliveries.co.ke)';
const MAINTENANCE = /mainten|maintain/i;

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((cur, key) => {
    if (cur === null || cur === undefined) return undefined;
    return (cur as Record<string, unknown>)[key];
  }, obj);
}

function typeOf(v: unknown): string {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  return typeof v;
}

/** Returns null when the rule passes, otherwise { kind, reason }. */
function checkRule(body: unknown, r: JsonExpectation): { kind: FailureKind; reason: string } | null {
  const f = checkRuleInner(body, r);
  // failKind describes a wrong VALUE (e.g. maintenance_mode = true). A missing field is still "incomplete data".
  return f && r.failKind && getPath(body, r.path) !== undefined && getPath(body, r.path) !== null ? { ...f, kind: r.failKind } : f;
}
function checkRuleInner(body: unknown, r: JsonExpectation): { kind: FailureKind; reason: string } | null {
  if (r.anyOf?.length) {
    const fails = r.anyOf.map((x) => checkRule(body, x));
    if (fails.some((f) => f === null)) return null;
    return { kind: fails.every((f) => f!.kind === 'empty') ? 'empty' : 'structure', reason: r.explain ?? fails.map((f) => f!.reason).join(' and ') };
  }
  const v = getPath(body, r.path);
  if (v === undefined || v === null) return { kind: 'structure', reason: r.explain ?? `JSON field "${r.path}" is missing` };
  if (r.type && typeOf(v) !== r.type) return { kind: 'structure', reason: r.explain ?? `JSON field "${r.path}" is ${typeOf(v)}, expected ${r.type}` };
  if (r.nonEmpty) {
    const empty =
      (typeof v === 'string' && v.trim() === '') ||
      (Array.isArray(v) && v.length === 0) ||
      (typeOf(v) === 'object' && Object.keys(v as object).length === 0);
    if (empty) return { kind: 'empty', reason: r.explain ?? `JSON field "${r.path}" is empty` };
  }
  if (r.equals !== undefined && v !== r.equals) {
    return { kind: 'structure', reason: r.explain ?? `JSON field "${r.path}" is ${JSON.stringify(v)}, expected ${JSON.stringify(r.equals)}` };
  }
  return null;
}

/** Returns a failure reason, or null when the JSON body meets every expectation. */
export function checkJson(body: unknown, rules: JsonExpectation[]): string | null {
  for (const r of rules) {
    const f = checkRule(body, r);
    if (f) return f.reason;
  }
  return null;
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BODY) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  reader.cancel().catch(() => {});
  const all = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(all);
}

/** Real network time of a shared response (see memoFetch). */
const SHARED_MS = new WeakMap<Response, number>();

/**
 * Shares identical GET requests within one monitoring run (several checks read /api/v1/config),
 * so Fasta's server gets one request instead of three. Each caller gets its own clone.
 */
export function memoFetch(base: typeof fetch = fetch): typeof fetch {
  const seen = new Map<string, Promise<Response>>();
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method !== 'GET' || init?.body) return base(input, init);
    const key = `${String(input)}|${JSON.stringify(init?.headers ?? {})}|${init?.redirect ?? ''}`;
    let p = seen.get(key);
    if (!p) {
      const t0 = Date.now();
      p = base(input, init).then((r) => { SHARED_MS.set(r, Date.now() - t0); return r; });
      seen.set(key, p);
    }
    // Each caller gets its own copy, tagged with how long the real request took.
    return p.then((r) => { const c = r.clone(); SHARED_MS.set(c, SHARED_MS.get(r) ?? 0); return c; });
  }) as typeof fetch;
}

/** Runs one check. Validates status, redirects, content type, content and JSON structure. An HTTP 200
 *  maintenance page or an empty JSON list counts as a failure. Every result carries a public-safe `kind`. */
export async function runCheck(
  def: CheckDef,
  opts: { timeoutMs: number; slowMs: number },
  fetcher: typeof fetch = fetch,
): Promise<CheckResult> {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('timeout'), opts.timeoutMs);
  const done = (kind: FailureKind, reason: string, status: number | null): CheckResult =>
    ({ outcome: 'down', kind, reason, status, latencyMs: Date.now() - started });
  const headers = { 'User-Agent': UA, Accept: def.json ? 'application/json' : 'text/html,*/*', 'Cache-Control': 'no-cache', ...def.headers };
  try {
    let url = def.url;
    if (def.urlFrom) {
      const src = await fetcher(def.urlFrom.url, { headers: { 'User-Agent': UA, Accept: 'application/json', 'Cache-Control': 'no-cache' }, signal: ctrl.signal, redirect: 'manual' });
      let parsed: unknown;
      try { parsed = JSON.parse(await readCapped(src)); } catch { return done('structure', `Could not read ${def.urlFrom.url} to find the file URL`, src.status); }
      const found = getPath(parsed, def.urlFrom.path);
      if (typeof found !== 'string' || !/^https?:\/\//.test(found)) return done('structure', `No file URL at "${def.urlFrom.path}"`, src.status);
      url = found;
    }

    const res = await fetcher(url, {
      method: def.method ?? 'GET',
      headers,
      body: def.body,
      redirect: def.followRedirects === false ? 'manual' : 'follow',
      signal: ctrl.signal,
    });
    const status = res.status;

    if (status >= 300 && status < 400) {
      const loc = res.headers.get('location') ?? '';
      if (def.forbidFinalUrl?.test(loc) || MAINTENANCE.test(loc)) return done('maintenance', `Redirected to maintenance page (${status} → ${loc})`, status);
      if (!def.allowRedirect?.test(loc)) return done('redirect', `Unexpected redirect (${status} → ${loc || 'no location'})`, status);
    }
    if (def.forbidFinalUrl && res.url && def.forbidFinalUrl.test(new URL(res.url).pathname)) {
      return done('maintenance', `Landed on maintenance page (${new URL(res.url).pathname})`, status);
    }
    const expected = def.expectStatus ?? [200];
    if (!(status >= 300 && status < 400) && !expected.includes(status)) {
      return done(status >= 500 ? 'server_error' : 'client_error', `HTTP ${status} (expected ${expected.join('/')})`, status);
    }
    if (def.contentType) {
      const ct = res.headers.get('content-type') ?? '';
      if (!ct.toLowerCase().startsWith(def.contentType)) {
        res.body?.cancel().catch(() => {});
        return done('content', `Content-Type is "${ct || 'missing'}", expected ${def.contentType}*`, status);
      }
    }

    const text = await readCapped(res);
    if (def.contentType?.startsWith('image/') && text.length === 0) return done('empty', 'Image file is empty', status);
    for (const needle of def.mustContain ?? []) {
      if (!text.includes(needle)) return done('content', `Expected content missing: ${JSON.stringify(needle)}`, status);
    }
    for (const needle of def.mustNotContain ?? []) {
      if (text.includes(needle)) return done(MAINTENANCE.test(needle) ? 'maintenance' : 'content', `Unexpected content found: ${JSON.stringify(needle)}`, status);
    }
    if (def.json) {
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { return done('structure', 'Response is not valid JSON', status); }
      for (const rule of def.json) {
        const f = checkRule(parsed, rule);
        if (f) return done(f.kind, f.reason, status);
      }
    }
    // A shared response (memoFetch) reports the original request's network time, not ~0 ms.
    const latency = SHARED_MS.has(res) ? SHARED_MS.get(res)! : Date.now() - started;
    const slow = def.slowMs ?? opts.slowMs;
    if (latency > slow) return { outcome: 'degraded', kind: 'slow', reason: `Slow response (${latency} ms, limit ${slow} ms)`, status, latencyMs: latency };
    return { outcome: 'up', kind: 'ok', reason: 'OK', status, latencyMs: latency };
  } catch (err) {
    const aborted = ctrl.signal.aborted;
    return done(aborted ? 'timeout' : 'connection', aborted ? `Timed out after ${opts.timeoutMs / 1000}s` : `Connection failed: ${(err as Error)?.message ?? err}`, null);
  } finally {
    clearTimeout(timer);
  }
}

/** Customer-facing explanation for each failure kind. Never includes URLs or internal details. */
export const PUBLIC_KIND_TEXT: Record<FailureKind, string> = {
  ok: 'Working normally',
  slow: 'Responding slowly',
  timeout: 'Not responding (timed out)',
  connection: 'Could not be reached',
  server_error: 'Returning server errors',
  client_error: 'Returning unexpected errors',
  maintenance: 'Showing a maintenance page',
  redirect: 'Sending visitors to the wrong page',
  content: 'Loading, but with the wrong content',
  structure: 'Returning incomplete data',
  empty: 'Returning no data',
};
