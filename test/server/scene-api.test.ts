import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { basename } from 'node:path';
import { Collector } from '../../src/collector.js';
import { UiAuth } from '../../src/server/auth.js';
import { createApiServer } from '../../src/server/http.js';
import { bearer, call, close, listen } from '../helpers/http.js';

const TOKEN = 'f'.repeat(48);
const NOW = 1_791_700_000_000;
let server: Server;
let port: number;
let collector: Collector;
let cookie: string;

beforeAll(async () => {
  collector = new Collector({ resolveWorkspace: async (cwd) => ({ cwd, repoRoot: cwd, repoName: basename(cwd), worktree: false, branch: 'main' }), saveDelayMs: 0, now: () => NOW });
  void collector.ingest({ type: 'waiting', sessionId: 'S1', ts: NOW - 60_000, source: 'hook', cwd: '/w/orders-api', reason: { kind: 'permission', text: 'Bash', detail: 'Bash: npm test' }, agentId: null });
  void collector.ingest({ type: 'tool.started', sessionId: 'S2', ts: NOW - 30_000, source: 'hook', cwd: '/w/shop-web', toolId: 't1', tool: 'Edit', label: 'Edit src/app.ts', agentId: null });
  await collector.idle();
  const auth = new UiAuth({ token: TOKEN, now: () => NOW });
  server = createApiServer({ collector, token: TOKEN, auth });
  port = await listen(server);
  cookie = auth.cookie(port).split(';')[0]!;
});
afterAll(() => close(server));

const floorOf = (repo: string) => collector.scene().floors.find((f) => f.repos.includes(repo))!.key;

describe('GET /api/scene', () => {
  it('serves the building to the token and to a signed-in browser', async () => {
    const expected = collector.scene();
    expect(expected.floors).toHaveLength(2);
    for (const headers of [bearer(TOKEN), { cookie }, { cookie, 'sec-fetch-site': 'same-origin' }]) {
      const r = await call(port, { path: '/api/scene', headers });
      expect(r.status).toBe(200);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.json).toEqual(expected);
    }
    expect((await call(port, { path: '/api/scene', headers: { cookie, 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    expect((await call(port, { path: '/api/scene' })).status).toBe(401);
  });
});

describe('GET /api/floor', () => {
  it('serves one floor in detail', async () => {
    const key = floorOf('orders-api');
    const r = await call(port, { path: `/api/floor?key=${encodeURIComponent(key)}`, headers: { cookie } });
    expect(r.status).toBe(200);
    expect(r.json).toEqual(collector.floor(key));
    expect(r.json.key).toBe(key);
    expect(r.json.islands[0].desks[0].sessionId).toBe('S1');
  });

  it('answers 400 without a key, or with one longer than 512 characters', async () => {
    for (const path of ['/api/floor', '/api/floor?key=', `/api/floor?key=${'x'.repeat(513)}`]) {
      const r = await call(port, { path, headers: bearer(TOKEN) });
      expect(r.status).toBe(400);
      expect(r.json.error).toEqual(expect.any(String));
    }
  });

  it('answers 404 for a floor nobody is on', async () => {
    for (const key of ['repo:/nowhere', 'x'.repeat(512)]) {
      const r = await call(port, { path: `/api/floor?key=${encodeURIComponent(key)}`, headers: bearer(TOKEN) });
      expect(r).toMatchObject({ status: 404, json: { error: 'No such floor' } });
    }
  });

  it('needs a credential', async () => {
    expect((await call(port, { path: `/api/floor?key=${encodeURIComponent(floorOf('shop-web'))}` })).status).toBe(401);
  });
});
