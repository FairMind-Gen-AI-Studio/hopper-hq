import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * Who may call a route.
 * - public: anyone who passes the Host and Origin checks.
 * - bearer: the token only (CLI, mod).
 * - read: the token, or the browser cookie unless another site sends the request.
 * - write: the token, or the browser cookie from a page of this very origin.
 */
export type AuthLevel = 'public' | 'bearer' | 'read' | 'write';

export const CODE_TTL_MS = 60_000;
export const MAX_CODES = 16;
export const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;
const COOKIE_MAX_AGE_MS = COOKIE_MAX_AGE_S * 1000;
/** A cookie issued this far in the future still counts (clock adjustments). */
const CLOCK_SKEW_MS = 60_000;

export interface UiAuthOptions {
  token: string;
  now?: () => number;
  /** Lifetime of a sign-in code (default one minute). */
  codeTtlMs?: number;
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export const cookieName = (port: number): string => `shq_${port}`;

export const loginUrl = (port: number, code: string): string => `http://127.0.0.1:${port}/ui/login?code=${code}`;

/**
 * One-time sign-in codes and the cookie they buy. The cookie is signed with the token and holds no state:
 * it survives daemon restarts, and a new token revokes every cookie.
 */
export class UiAuth {
  /** sha256(code) -> expiresAt, oldest first. */
  private readonly codes = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly o: UiAuthOptions) {
    this.now = o.now ?? Date.now;
  }

  issueCode(ttlMs = this.o.codeTtlMs ?? CODE_TTL_MS): { code: string; expiresAt: number } {
    const now = this.now();
    for (const [hash, expiresAt] of this.codes) if (expiresAt <= now) this.codes.delete(hash);
    while (this.codes.size >= MAX_CODES) this.codes.delete(this.codes.keys().next().value!);
    const code = randomBytes(24).toString('hex');
    const expiresAt = now + ttlMs;
    this.codes.set(sha256(code), expiresAt);
    return { code, expiresAt };
  }

  /** Spends a code: true once, and only before it expires. */
  redeemCode(code: string): boolean {
    if (!/^[0-9a-f]{48}$/.test(code)) return false;
    const hash = sha256(code);
    const expiresAt = this.codes.get(hash);
    if (expiresAt === undefined) return false;
    this.codes.delete(hash);
    return this.now() < expiresAt;
  }

  /** The Set-Cookie value that signs a browser in on this port. */
  cookie(port: number): string {
    const issuedAt = String(this.now());
    return `${cookieName(port)}=${issuedAt}.${this.sign(issuedAt)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_S}`;
  }

  /** True when the Cookie header holds this port's cookie, signed with the current token and not expired. */
  hasCookie(header: string | undefined, port: number): boolean {
    if (!header) return false;
    const name = cookieName(port);
    const now = this.now();
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
      const m = /^(\d{1,16})\.([A-Za-z0-9_-]{43})$/.exec(part.slice(eq + 1).trim());
      if (!m) continue;
      const issuedAt = Number(m[1]);
      if (now - issuedAt >= COOKIE_MAX_AGE_MS || issuedAt > now + CLOCK_SKEW_MS) continue;
      const given = Buffer.from(m[2]!);
      const expected = Buffer.from(this.sign(m[1]!));
      if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
    }
    return false;
  }

  private sign(issuedAt: string): string {
    return createHmac('sha256', this.o.token).update(`scranton-hq ui ${issuedAt}`).digest('base64url');
  }
}

export function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header || !header.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export interface Denial {
  status: 401 | 403;
  error: string;
}

const NO_CREDENTIAL: Denial = { status: 401, error: 'Missing or wrong token' };
const CROSS_SITE: Denial = { status: 403, error: 'Cross-site request refused' };

/**
 * Checks a request's credentials against a route's level, after the Host and Origin checks.
 * Cookies reach every server on 127.0.0.1 whatever its port, and SameSite treats all those ports as one site,
 * so Origin and Sec-Fetch-Site are what stop other local pages. Null means allowed.
 */
export function authorize(level: AuthLevel, req: IncomingMessage, port: number, token: string, auth: UiAuth): Denial | null {
  if (level === 'public') return null;
  if (bearerMatches(req.headers.authorization, token)) return null;
  if (level === 'bearer' || !auth.hasCookie(req.headers.cookie, port)) return NO_CREDENTIAL;
  const site = req.headers['sec-fetch-site'];
  if (level === 'read') return site === undefined || site === 'same-origin' || site === 'none' ? null : CROSS_SITE;
  const origin = req.headers.origin;
  const sameOrigin = origin !== undefined && origin === `http://${req.headers.host}`;
  return sameOrigin && (site === undefined || site === 'same-origin') ? null : CROSS_SITE;
}
