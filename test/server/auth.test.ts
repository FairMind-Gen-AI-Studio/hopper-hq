import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { authorize, UiAuth, type AuthLevel } from '../../src/server/auth.js';

const TOKEN = 'b'.repeat(48);
const PORT = 17337;
const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_791_700_000_000;

function clock(start = T0) {
  const c = { t: start, now: () => c.t };
  return c;
}

/** The name=value part of a Set-Cookie value. */
const pair = (setCookie: string) => setCookie.split(';')[0]!;

describe('sign-in codes', () => {
  it('are 48 hex characters that last a minute by default', () => {
    const c = clock();
    const auth = new UiAuth({ token: TOKEN, now: c.now });
    const { code, expiresAt } = auth.issueCode();
    expect(code).toMatch(/^[0-9a-f]{48}$/);
    expect(expiresAt).toBe(T0 + 60_000);
    expect(new UiAuth({ token: TOKEN, now: c.now, codeTtlMs: 600_000 }).issueCode().expiresAt).toBe(T0 + 600_000);
    expect(auth.issueCode(5_000).expiresAt).toBe(T0 + 5_000);
  });

  it('work once', () => {
    const auth = new UiAuth({ token: TOKEN, now: clock().now });
    const { code } = auth.issueCode();
    expect(auth.redeemCode(code)).toBe(true);
    expect(auth.redeemCode(code)).toBe(false);
  });

  it('expire', () => {
    const c = clock();
    const auth = new UiAuth({ token: TOKEN, now: c.now });
    const a = auth.issueCode().code;
    const b = auth.issueCode().code;
    c.t = T0 + 59_999;
    expect(auth.redeemCode(a)).toBe(true);
    c.t = T0 + 60_000;
    expect(auth.redeemCode(b)).toBe(false);
  });

  it('keep at most 16 outstanding, dropping the oldest', () => {
    const auth = new UiAuth({ token: TOKEN, now: clock().now });
    const codes = Array.from({ length: 17 }, () => auth.issueCode().code);
    expect(auth.redeemCode(codes[0]!)).toBe(false);
    expect(auth.redeemCode(codes[1]!)).toBe(true);
    expect(auth.redeemCode(codes[16]!)).toBe(true);
  });

  it('purge expired codes before dropping live ones', () => {
    const c = clock();
    const auth = new UiAuth({ token: TOKEN, now: c.now });
    const long = auth.issueCode(600_000).code;
    for (let i = 0; i < 15; i++) auth.issueCode(60_000);
    c.t = T0 + 120_000;
    auth.issueCode();
    expect(auth.redeemCode(long)).toBe(true);
  });

  it('reject anything that is not a code', () => {
    const auth = new UiAuth({ token: TOKEN, now: clock().now });
    for (const bad of ['', 'abc', 'Z'.repeat(48), `${'a'.repeat(48)}x`]) expect(auth.redeemCode(bad)).toBe(false);
  });
});

describe('the sign-in cookie', () => {
  it('is named after the port, HttpOnly, SameSite=Strict, for 30 days', () => {
    const auth = new UiAuth({ token: TOKEN, now: clock().now });
    expect(auth.cookie(PORT)).toMatch(/^shq_17337=1791700000000\.[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000$/);
  });

  it('is accepted on its own port, among other cookies', () => {
    const auth = new UiAuth({ token: TOKEN, now: clock().now });
    const cookie = pair(auth.cookie(PORT));
    expect(auth.hasCookie(cookie, PORT)).toBe(true);
    expect(auth.hasCookie(`theme=dark; ${cookie}; other=1`, PORT)).toBe(true);
    expect(auth.hasCookie(cookie, PORT + 1)).toBe(false);
    expect(auth.hasCookie(undefined, PORT)).toBe(false);
    expect(auth.hasCookie('', PORT)).toBe(false);
  });

  it('survives a restart with the same token, and dies with a new token', () => {
    const c = clock();
    const cookie = pair(new UiAuth({ token: TOKEN, now: c.now }).cookie(PORT));
    expect(new UiAuth({ token: TOKEN, now: c.now }).hasCookie(cookie, PORT)).toBe(true);
    expect(new UiAuth({ token: 'c'.repeat(48), now: c.now }).hasCookie(cookie, PORT)).toBe(false);
  });

  it('is rejected when tampered with', () => {
    const auth = new UiAuth({ token: TOKEN, now: clock().now });
    const cookie = pair(auth.cookie(PORT));
    const [name, value] = cookie.split('=') as [string, string];
    const [issuedAt, sig] = value.split('.') as [string, string];
    const flipped = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
    expect(auth.hasCookie(`${name}=${issuedAt}.${flipped}`, PORT)).toBe(false);
    expect(auth.hasCookie(`${name}=${Number(issuedAt) + 1}.${sig}`, PORT)).toBe(false);
    expect(auth.hasCookie(`${name}=0${issuedAt}.${sig}`, PORT)).toBe(false);
    expect(auth.hasCookie(`${name}=${issuedAt}.${sig}x`, PORT)).toBe(false);
    expect(auth.hasCookie(`${name}=${issuedAt}`, PORT)).toBe(false);
  });

  it('expires after 30 days', () => {
    const c = clock();
    const auth = new UiAuth({ token: TOKEN, now: c.now });
    const cookie = pair(auth.cookie(PORT));
    c.t = T0 + 30 * DAY - 1;
    expect(auth.hasCookie(cookie, PORT)).toBe(true);
    c.t = T0 + 30 * DAY;
    expect(auth.hasCookie(cookie, PORT)).toBe(false);
  });

  it('is rejected when issued more than a minute in the future', () => {
    const verifier = new UiAuth({ token: TOKEN, now: clock().now });
    const near = pair(new UiAuth({ token: TOKEN, now: clock(T0 + 60_000).now }).cookie(PORT));
    const far = pair(new UiAuth({ token: TOKEN, now: clock(T0 + 60_001).now }).cookie(PORT));
    expect(verifier.hasCookie(near, PORT)).toBe(true);
    expect(verifier.hasCookie(far, PORT)).toBe(false);
  });
});

describe('authorize', () => {
  const auth = new UiAuth({ token: TOKEN, now: clock().now });
  const cookie = pair(auth.cookie(PORT));
  const host = `127.0.0.1:${PORT}`;
  const req = (headers: Record<string, string>) => ({ headers: { host, ...headers } }) as unknown as IncomingMessage;
  const check = (level: AuthLevel, headers: Record<string, string>) => authorize(level, req(headers), PORT, TOKEN, auth)?.status ?? 200;
  const levels: AuthLevel[] = ['bearer', 'read', 'write'];

  it('lets anyone through a public route', () => {
    expect(check('public', {})).toBe(200);
  });

  it('accepts the bearer token at every level', () => {
    for (const level of levels) expect(check(level, { authorization: `Bearer ${TOKEN}` })).toBe(200);
  });

  it('answers 401 without a valid credential', () => {
    for (const level of levels) {
      expect(check(level, {})).toBe(401);
      expect(check(level, { authorization: 'Bearer nope' })).toBe(401);
      expect(check(level, { cookie: `shq_${PORT + 1}=${cookie.split('=')[1]}` })).toBe(401);
    }
  });

  it('never accepts the cookie where only the token will do', () => {
    expect(check('bearer', { cookie })).toBe(401);
  });

  it('accepts the cookie for reads unless another site asks', () => {
    expect(check('read', { cookie })).toBe(200);
    expect(check('read', { cookie, 'sec-fetch-site': 'same-origin' })).toBe(200);
    expect(check('read', { cookie, 'sec-fetch-site': 'none' })).toBe(200);
    expect(check('read', { cookie, 'sec-fetch-site': 'same-site' })).toBe(403);
    expect(check('read', { cookie, 'sec-fetch-site': 'cross-site' })).toBe(403);
  });

  it('accepts the cookie for writes only from the same origin', () => {
    const origin = `http://${host}`;
    expect(check('write', { cookie, origin })).toBe(200);
    expect(check('write', { cookie, origin, 'sec-fetch-site': 'same-origin' })).toBe(200);
    expect(check('write', { cookie })).toBe(403);
    expect(check('write', { cookie, origin: `http://localhost:${PORT}` })).toBe(403);
    expect(check('write', { cookie, origin, 'sec-fetch-site': 'same-site' })).toBe(403);
    expect(check('write', { cookie, origin, 'sec-fetch-site': 'none' })).toBe(403);
  });
});
