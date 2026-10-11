import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { basename } from 'node:path';
import { Collector } from '../../src/collector.js';
import type { RawEvent } from '../../src/core/types.js';
import { UiAuth } from '../../src/server/auth.js';
import { SceneHub, type SceneHubOptions } from '../../src/server/events.js';
import { createApiServer } from '../../src/server/http.js';
import { bearer, close, listen } from '../helpers/http.js';
import { isEvent, openSse, type SseStream } from '../helpers/sse.js';

const TOKEN = 'g'.repeat(48);
const T0 = 1_791_700_000_000;
const HOUR = 60 * 60 * 1000;
const LONG = 60_000;

const waiting = (sessionId: string, ts: number, cwd = '/w/orders-api'): RawEvent => ({
  type: 'waiting', sessionId, ts, source: 'hook', cwd, reason: { kind: 'permission', text: 'Bash' }, agentId: null,
});
const working = (sessionId: string, ts: number, label: string, cwd = '/w/orders-api'): RawEvent => ({
  type: 'tool.started', sessionId, ts, source: 'hook', cwd, toolId: `${sessionId}-${ts}`, tool: 'Edit', label, agentId: null,
});
const finished = (sessionId: string, ts: number, cwd = '/w/orders-api'): RawEvent => ({ type: 'turn.finished', sessionId, ts, source: 'hook', cwd, backgroundTasks: 0 });

interface Setup {
  clock: { t: number };
  collector: Collector;
  hub: SceneHub;
  auth: UiAuth;
  port: number;
  server: Server;
}

const open: Array<SseStream | Server> = [];
afterEach(async () => {
  for (const x of open.splice(0)) {
    if ('take' in x) x.close();
    else await close(x);
  }
});

async function setup(hub: Omit<SceneHubOptions, 'source'> = {}, events: RawEvent[] = []): Promise<Setup> {
  const clock = { t: T0 };
  const collector = new Collector({ resolveWorkspace: async (cwd) => ({ cwd, repoRoot: cwd, repoName: basename(cwd), worktree: false, branch: 'main' }), saveDelayMs: 0, now: () => clock.t });
  for (const e of events) void collector.ingest(e);
  await collector.idle();
  const s = new SceneHub({ source: collector, coalesceMs: 30, tickMs: LONG, heartbeatMs: LONG, ...hub });
  const auth = new UiAuth({ token: TOKEN, now: () => clock.t });
  const server = createApiServer({ collector, token: TOKEN, auth, hub: s });
  const port = await listen(server);
  open.push(server);
  return { clock, collector, hub: s, auth, port, server };
}

async function sse(port: number, path: string, headers: Record<string, string> = bearer(TOKEN)): Promise<SseStream> {
  const s = await openSse(port, path, headers);
  open.push(s);
  return s;
}

const json = (data: string | null) => JSON.parse(data!);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const keyOf = (c: Collector, repo: string) => c.scene().floors.find((f) => f.repos.includes(repo))!.key;

describe('GET /api/events', () => {
  it('opens with the retry delay and the scene', async () => {
    const t = await setup({}, [waiting('S1', T0 - 1000)]);
    const s = await sse(t.port, '/api/events');
    expect(s.status).toBe(200);
    expect(s.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(s.headers['cache-control']).toBe('no-store');
    expect(s.headers['x-accel-buffering']).toBe('no');
    expect(s.headers['x-content-type-options']).toBe('nosniff');
    expect((await s.take()).retry).toBe(3000);
    const scene = await s.take();
    expect(scene.event).toBe('scene');
    expect(json(scene.data)).toEqual(t.collector.scene());
    expect(json(scene.data).attention.needsYou[0].sessionId).toBe('S1');
  });

  it('adds the subscribed floor, or null when there is no such floor', async () => {
    const t = await setup({}, [waiting('S1', T0 - 1000)]);
    const key = keyOf(t.collector, 'orders-api');
    const known = await sse(t.port, `/api/events?floor=${encodeURIComponent(key)}`);
    await known.take(isEvent('scene'));
    expect(json((await known.take()).data)).toEqual(t.collector.floor(key));
    const unknown = await sse(t.port, '/api/events?floor=repo%3A%2Fnowhere');
    await unknown.take(isEvent('scene'));
    const floor = await unknown.take();
    expect(floor.event).toBe('floor');
    expect(floor.data).toBe('null');
  });

  it('accepts the browser cookie, and refuses other sites and the unsigned', async () => {
    const t = await setup();
    const cookie = t.auth.cookie(t.port).split(';')[0]!;
    expect((await sse(t.port, '/api/events', { cookie, 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    expect((await sse(t.port, '/api/events', { cookie, 'sec-fetch-site': 'same-site' })).status).toBe(403);
    expect((await sse(t.port, '/api/events', {})).status).toBe(401);
  });

  it('sends one scene for a burst of changes', async () => {
    const t = await setup({}, [waiting('S1', T0 - 1000)]);
    const s = await sse(t.port, '/api/events');
    await s.take(isEvent('scene'));
    void t.collector.ingest(waiting('S2', T0 - 900, '/w/shop-web'));
    void t.collector.ingest(waiting('S3', T0 - 800, '/w/shop-web'));
    void t.collector.ingest(finished('S4', T0 - 700));
    const next = json((await s.take(isEvent('scene'))).data);
    expect(next.attention.needsYou.map((e: { sessionId: string }) => e.sessionId)).toEqual(['S1', 'S2', 'S3']);
    expect(next.attention.done.map((e: { sessionId: string }) => e.sessionId)).toEqual(['S4']);
    await sleep(150);
    expect(s.messages.filter(isEvent('scene'))).toHaveLength(2);
  });

  it('sends nothing when what a client sees has not changed', async () => {
    const t = await setup({}, [working('S1', T0 - 1000, 'Edit a.ts')]);
    const key = keyOf(t.collector, 'orders-api');
    const building = await sse(t.port, '/api/events');
    const floor = await sse(t.port, `/api/events?floor=${encodeURIComponent(key)}`);
    await building.take(isEvent('scene'));
    await floor.take(isEvent('floor'));
    void t.collector.ingest(working('S1', T0 - 500, 'Edit b.ts'));
    const detail = json((await floor.take(isEvent('floor'))).data);
    expect(detail.islands[0].desks[0].activity.label).toBe('Edit b.ts');
    await sleep(100);
    expect(building.messages.filter(isEvent('scene'))).toHaveLength(1);
    expect(floor.messages.filter(isEvent('scene'))).toHaveLength(1);
  });

  it('picks up states that change with time on the tick', async () => {
    const t = await setup({ tickMs: 40 }, [finished('S1', T0 - 1000)]);
    const s = await sse(t.port, '/api/events');
    expect(json((await s.take(isEvent('scene'))).data).attention.done).toHaveLength(1);
    await sleep(150);
    expect(s.messages.filter(isEvent('scene'))).toHaveLength(1);
    t.clock.t = T0 + 5 * HOUR;
    const later = json((await s.take(isEvent('scene'))).data);
    expect(later.attention.done).toHaveLength(0);
    expect(later.floors[0].windows[0].state).toBe('idle');
  });

  it('sends a heartbeat comment', async () => {
    const t = await setup({ heartbeatMs: 30 });
    const s = await sse(t.port, '/api/events');
    expect((await s.take((m) => m.comment !== null)).comment).toBe('ping');
  });

  it('turns away the 17th live view, and makes room when one leaves', async () => {
    const t = await setup();
    const streams = await Promise.all(Array.from({ length: 16 }, () => sse(t.port, '/api/events')));
    expect(streams.every((s) => s.status === 200)).toBe(true);
    expect(t.hub.size).toBe(16);
    const extra = await sse(t.port, '/api/events');
    expect(extra.status).toBe(503);
    await extra.ended;
    expect(JSON.parse(extra.body)).toEqual({ error: 'Too many live views' });
    streams[0]!.close();
    for (let i = 0; i < 50 && t.hub.size > 15; i++) await sleep(10);
    expect(t.hub.size).toBe(15);
    expect((await sse(t.port, '/api/events')).status).toBe(200);
  });

  it('ends every stream on close and accepts no more', async () => {
    const t = await setup();
    const a = await sse(t.port, '/api/events');
    const b = await sse(t.port, '/api/events?floor=repo%3A%2Fw');
    await a.take(isEvent('scene'));
    t.hub.close();
    await Promise.all([a.ended, b.ended]);
    expect(t.hub.size).toBe(0);
    expect((await sse(t.port, '/api/events')).status).toBe(503);
  });
});
