import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { basename } from 'node:path';
import { Collector } from '../../src/collector.js';
import { CSP } from '../../src/server/headers.js';
import { createApiServer } from '../../src/server/http.js';
import { bearer, call, close, listen } from '../helpers/http.js';

const TOKEN = 'd'.repeat(48);
let server: Server;
let port: number;

beforeAll(async () => {
  const collector = new Collector({ resolveWorkspace: async (cwd) => ({ cwd, repoRoot: cwd, repoName: basename(cwd), worktree: false, branch: 'main' }), saveDelayMs: 0 });
  server = createApiServer({ collector, token: TOKEN });
  port = await listen(server);
});
afterAll(() => close(server));

async function signIn(): Promise<string> {
  const minted = await call(port, { method: 'POST', path: '/api/ui/login-code', headers: bearer(TOKEN) });
  const url = new URL(minted.json.url as string);
  const login = await call(port, { path: url.pathname + url.search });
  return login.headers['set-cookie']![0]!.split(';')[0]!;
}

describe('browser sign-in', () => {
  it('mints a one-time link with the token, and the link sets the cookie', async () => {
    const minted = await call(port, { method: 'POST', path: '/api/ui/login-code', headers: bearer(TOKEN) });
    expect(minted.status).toBe(200);
    expect(minted.json.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/ui/login\\?code=[0-9a-f]{48}$`));
    expect(minted.json.expiresAt).toBeGreaterThan(Date.now());

    const url = new URL(minted.json.url as string);
    const login = await call(port, { path: url.pathname + url.search });
    expect(login.status).toBe(303);
    expect(login.headers.location).toBe('/ui/');
    expect(login.headers['x-frame-options']).toBe('DENY');
    const setCookie = login.headers['set-cookie']!;
    expect(setCookie).toHaveLength(1);
    expect(setCookie[0]).toMatch(new RegExp(`^shq_${port}=\\d+\\.[A-Za-z0-9_-]{43}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000$`));

    const again = await call(port, { path: url.pathname + url.search });
    expect(again.status).toBe(401);
    expect(again.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(again.headers['content-security-policy']).toBe(CSP);
    expect(again.text).toContain('This sign-in link has expired or was already used.');
    expect(again.headers['set-cookie']).toBeUndefined();
  });

  it('answers the expired page for a missing or malformed code, without echoing it', async () => {
    for (const path of ['/ui/login', '/ui/login?code=', '/ui/login?code=%3Cscript%3E']) {
      const r = await call(port, { path });
      expect(r.status).toBe(401);
      expect(r.text).not.toContain('script');
    }
  });

  it('does not let the cookie mint codes or post hooks', async () => {
    const cookie = await signIn();
    const origin = `http://127.0.0.1:${port}`;
    expect((await call(port, { method: 'POST', path: '/api/ui/login-code', headers: { cookie, origin } })).status).toBe(401);
    expect((await call(port, { method: 'POST', path: '/api/hooks', headers: { cookie, origin, 'content-type': 'application/json' }, body: '[]' })).status).toBe(401);
    expect((await call(port, { path: '/api/health', headers: { cookie } })).status).toBe(401);
  });

  it('lets the cookie write only from the same origin', async () => {
    const cookie = await signIn();
    const origin = `http://127.0.0.1:${port}`;
    expect((await call(port, { method: 'POST', path: '/api/seen', headers: { cookie, origin } })).status).toBe(200);
    expect((await call(port, { method: 'POST', path: '/api/seen', headers: { cookie } })).status).toBe(403);
    expect((await call(port, { method: 'POST', path: '/api/seen', headers: { cookie, origin: `http://127.0.0.1:${port + 1}` } })).status).toBe(403);
    expect((await call(port, { method: 'POST', path: '/api/seen', headers: { cookie, origin, 'sec-fetch-site': 'same-site' } })).status).toBe(403);
  });

  it('ignores a cookie named for another port', async () => {
    const cookie = (await signIn()).replace(`shq_${port}=`, `shq_${port + 1}=`);
    const origin = `http://127.0.0.1:${port}`;
    expect((await call(port, { method: 'POST', path: '/api/seen', headers: { cookie, origin } })).status).toBe(401);
  });

  it('keeps the bearer token working on every protected route', async () => {
    expect((await call(port, { path: '/api/health', headers: bearer(TOKEN) })).status).toBe(200);
    expect((await call(port, { method: 'POST', path: '/api/seen', headers: bearer(TOKEN) })).status).toBe(200);
    expect((await call(port, { method: 'POST', path: '/api/ui/login-code', headers: bearer(TOKEN) })).status).toBe(200);
  });

  it('sends the root to the UI', async () => {
    const r = await call(port, { path: '/' });
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/ui/');
  });
});
