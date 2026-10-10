import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename } from 'node:path';
import { Collector } from '../src/collector.js';
import { createApiServer } from '../src/server/http.js';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
const permission = readFileSync(new URL('./fixtures/hooks/PermissionRequest.json', import.meta.url), 'utf8');
const SID = JSON.parse(permission).session_id as string;

let server: Server;
let port: number;
let collector: Collector;

beforeAll(async () => {
  collector = new Collector({ resolveWorkspace: async (cwd) => ({ cwd, repoRoot: cwd, repoName: basename(cwd), worktree: false, branch: 'main' }), saveDelayMs: 0, now: () => 1791660010000 });
  server = createApiServer({ collector, token: TOKEN, maxBodyBytes: 4096 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function call(opts: { method?: string; path: string; token?: string | null; host?: string; origin?: string; body?: string }): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: opts.host ?? `127.0.0.1:${port}` };
    if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? TOKEN}`;
    if (opts.origin) headers.origin = opts.origin;
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(opts.body));
    }
    const req = request({ host: '127.0.0.1', port, path: opts.path, method: opts.method ?? 'GET', headers }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: b ? JSON.parse(b) : null }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

describe('API security', () => {
  it('requires the token', async () => {
    expect((await call({ path: '/api/health', token: null })).status).toBe(401);
    expect((await call({ path: '/api/health', token: 'wrong' })).status).toBe(401);
  });
  it('rejects foreign Host and Origin headers', async () => {
    expect((await call({ path: '/api/health', host: `evil.example:${port}` })).status).toBe(403);
    expect((await call({ path: '/api/health', origin: 'https://evil.example' })).status).toBe(403);
    expect((await call({ path: '/api/health', host: `localhost:${port}`, origin: `http://localhost:${port}` })).status).toBe(200);
  });
});

describe('API routes', () => {
  it('reports health', async () => {
    const r = await call({ path: '/api/health' });
    expect(r).toEqual({ status: 200, json: { ok: true, version: '0.1.0' } });
  });

  it('accepts hook payloads and reflects them in attention', async () => {
    expect((await call({ method: 'POST', path: '/api/hooks', body: permission })).status).toBe(204);
    await collector.idle();
    const r = await call({ path: '/api/attention' });
    expect(r.json).toMatchObject({ needsYou: 1, done: 0, items: [{ id: SID, state: 'needs_you', reason: { kind: 'permission', text: 'Bash' } }] });
    const b = await call({ path: '/api/building' });
    expect(b.json.floors).toHaveLength(1);
  });

  it('rejects invalid and oversized bodies', async () => {
    expect((await call({ method: 'POST', path: '/api/hooks', body: '{oops' })).status).toBe(400);
    expect((await call({ method: 'POST', path: '/api/hooks', body: JSON.stringify({ x: 'y'.repeat(5000) }) })).status).toBe(413);
  });

  it('marks a finished session as seen', async () => {
    expect((await call({ method: 'POST', path: `/api/sessions/${SID}/seen` })).status).toBe(404);
    const stop = JSON.stringify({ hook_event_name: 'Stop', session_id: SID, cwd: '/home/dev/shop/orders-api', _scranton_ts: 1791660009000 });
    expect((await call({ method: 'POST', path: '/api/hooks', body: stop })).status).toBe(204);
    await collector.idle();
    expect((await call({ path: '/api/attention' })).json.done).toBe(1);
    expect((await call({ method: 'POST', path: `/api/sessions/${encodeURIComponent(SID)}/seen` })).status).toBe(204);
    expect((await call({ path: '/api/attention' })).json.done).toBe(0);
    expect((await call({ method: 'POST', path: '/api/seen' })).json).toEqual({ marked: 0 });
  });

  it('accepts a batch of payloads, as the mod sends them', async () => {
    const batch = (JSON.parse(readFileSync(new URL('./fixtures/hooks/batch.json', import.meta.url), 'utf8')) as Record<string, unknown>[])
      .map((p) => ({ ...p, session_id: 'BATCH' }));
    expect((await call({ method: 'POST', path: '/api/hooks', body: JSON.stringify(batch) })).status).toBe(204);
    await collector.idle();
    const r = await call({ path: '/api/attention' });
    expect(r.json.items.map((i: { id: string }) => i.id)).toContain('BATCH');
  });

  it('answers 404 for unknown routes', async () => {
    expect((await call({ path: '/api/nope' })).status).toBe(404);
    expect((await call({ method: 'DELETE', path: '/api/health' })).status).toBe(404);
  });
});
