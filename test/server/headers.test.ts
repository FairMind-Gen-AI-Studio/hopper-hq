import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { IncomingHttpHeaders, Server } from 'node:http';
import { basename } from 'node:path';
import { Collector } from '../../src/collector.js';
import { createApiServer } from '../../src/server/http.js';
import { bearer, call, close, listen } from '../helpers/http.js';

const TOKEN = 'a'.repeat(48);
let server: Server;
let port: number;
let collector: Collector;

beforeAll(async () => {
  collector = new Collector({ resolveWorkspace: async (cwd) => ({ cwd, repoRoot: cwd, repoName: basename(cwd), worktree: false, branch: 'main' }), saveDelayMs: 0 });
  server = createApiServer({ collector, token: TOKEN });
  port = await listen(server);
});
afterAll(() => close(server));

function expectSecurityHeaders(h: IncomingHttpHeaders): void {
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['referrer-policy']).toBe('no-referrer');
  expect(h['cross-origin-resource-policy']).toBe('same-origin');
  expect(h['x-frame-options']).toBe('DENY');
}

describe('security headers', () => {
  it('come with every API answer, whatever its status', async () => {
    const json = { ...bearer(TOKEN), 'content-type': 'application/json' };
    const replies = [
      await call(port, { path: '/api/health', headers: bearer(TOKEN) }),
      await call(port, { method: 'POST', path: '/api/hooks', headers: json, body: '[]' }),
      await call(port, { path: '/api/health' }),
      await call(port, { path: '/api/health', headers: { ...bearer(TOKEN), host: 'evil.example' } }),
      await call(port, { path: '/api/health', headers: { ...bearer(TOKEN), origin: 'https://evil.example' } }),
      await call(port, { method: 'POST', path: '/api/sessions/nobody/seen', headers: bearer(TOKEN) }),
      await call(port, { path: '/api/nope', headers: bearer(TOKEN) }),
    ];
    expect(replies.map((r) => r.status)).toEqual([200, 204, 401, 403, 403, 404, 404]);
    for (const r of replies) {
      expectSecurityHeaders(r.headers);
      expect(r.headers['cache-control']).toBe('no-store');
    }
  });

  it('come with the answer of a failing handler', async () => {
    const spy = vi.spyOn(collector, 'snapshot').mockImplementation(() => {
      throw new Error('boom');
    });
    const r = await call(port, { path: '/api/building', headers: bearer(TOKEN) });
    spy.mockRestore();
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ error: 'Internal error' });
    expectSecurityHeaders(r.headers);
  });
});

describe('routing', () => {
  it('answers 404 for an unknown path, with or without a token', async () => {
    expect((await call(port, { path: '/nope' })).status).toBe(404);
    expect((await call(port, { path: '/api/nope', headers: bearer(TOKEN) })).status).toBe(404);
  });

  it('answers 404 when the path exists under another method', async () => {
    expect((await call(port, { method: 'DELETE', path: '/api/health', headers: bearer(TOKEN) })).status).toBe(404);
    expect((await call(port, { method: 'GET', path: '/api/hooks', headers: bearer(TOKEN) })).status).toBe(404);
  });
});
