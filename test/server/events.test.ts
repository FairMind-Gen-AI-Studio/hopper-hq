import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import type { Server, ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import { basename } from 'node:path';
import { Collector } from '../../src/collector.js';
import type { RawEvent } from '../../src/core/types.js';
import type { BuildingScene } from '../../src/scene/types.js';
import { UiAuth } from '../../src/server/auth.js';
import { SceneHub, type SceneHubOptions, type SceneSource } from '../../src/server/events.js';
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

/** A scene of about `bytes` characters: a different one at every read when `changing`, else always the same. */
function heavySource(bytes: number, changing: boolean): SceneSource {
  let reads = 0;
  return {
    scene: () => ({ version: 1, floors: [], attention: { needsYou: [], done: [] }, pad: String(changing ? reads++ : 0).padEnd(bytes, '.') }) as unknown as BuildingScene,
    floor: () => null,
    onChange: () => () => {},
  };
}

async function serve(hub: SceneHub): Promise<number> {
  const collector = new Collector({ resolveWorkspace: async (cwd) => ({ cwd, repoRoot: cwd, repoName: basename(cwd), worktree: false, branch: 'main' }), saveDelayMs: 0 });
  const server = createApiServer({ collector, token: TOKEN, hub });
  open.push(server);
  return listen(server);
}

/** Asks for a live view on a raw connection, then stops reading from it. */
function stalledView(port: number): Promise<Socket> {
  return new Promise((resolve) => {
    const sock = connect(port, '127.0.0.1', () => {
      sock.write(`GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${TOKEN}\r\n\r\n`);
      sock.pause();
      resolve(sock);
    });
    sock.on('error', () => {});
  });
}

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 300 && !ok(); i++) await sleep(10);
};

/** A response whose reader has stopped: everything written to it stays buffered. */
function stalledResponse() {
  const r = {
    writableLength: 0,
    destroyed: false,
    writeHead: () => r,
    on: () => r,
    write: (chunk: string) => {
      r.writableLength += Buffer.byteLength(chunk);
      return false;
    },
    destroy: () => {
      r.destroyed = true;
    },
    end: () => {},
  };
  return r;
}

describe('a live view that stops reading', () => {
  it('is dropped once its unread output passes the limit, and the others keep their stream', async () => {
    const hub = new SceneHub({ source: heavySource(128 * 1024, true), maxBufferedBytes: 64 * 1024, coalesceMs: 30, tickMs: LONG, heartbeatMs: LONG });
    const port = await serve(hub);
    const reader = await sse(port, '/api/events');
    await reader.take(isEvent('scene'));
    const stalled = await stalledView(port);
    await until(() => hub.size === 2);
    for (let i = 0; i < 400 && hub.size === 2; i++) {
      hub.flush();
      await reader.take(isEvent('scene'));
    }
    expect(hub.size).toBe(1);
    const gone = once(stalled, 'close');
    stalled.resume();
    await gone;
    hub.flush();
    expect((await reader.take(isEvent('scene'))).data).toMatch(/^\{"version":1,/);
  });

  it('is dropped at the heartbeat when nothing changes, past 1 MiB by default', async () => {
    const hub = new SceneHub({ source: heavySource(1024, false), coalesceMs: 30, tickMs: LONG, heartbeatMs: 20 });
    const res = stalledResponse();
    try {
      expect(hub.attach(res as unknown as ServerResponse, null)).toBe(true);
      res.writableLength += 1024 * 1024;
      await until(() => hub.size === 0);
      expect(hub.size).toBe(0);
      expect(res.destroyed).toBe(true);
    } finally {
      hub.close();
    }
  });
});

/** A source that throws while `failing` is set; its scene changes at every read. */
function flakySource() {
  const state = { failing: false, reads: 0 };
  const source: SceneSource = {
    scene: () => {
      if (state.failing) throw new Error('scene broke');
      return { version: 1, floors: [], attention: { needsYou: [], done: [] }, reads: state.reads++ } as unknown as BuildingScene;
    },
    floor: () => null,
    onChange: () => () => {},
  };
  return { state, source };
}

describe('scene code that throws', () => {
  it('is logged on a flush and on the tick, and the streams stay open', async () => {
    const { state, source } = flakySource();
    const log = vi.fn();
    const hub = new SceneHub({ source, log, coalesceMs: 30, tickMs: 20, heartbeatMs: LONG });
    const port = await serve(hub);
    const reader = await sse(port, '/api/events');
    await reader.take(isEvent('scene'));
    state.failing = true;
    expect(() => hub.flush()).not.toThrow();
    await until(() => log.mock.calls.length >= 2);
    expect(log).toHaveBeenCalledWith('scranton-hq could not build the live view: scene broke');
    expect(hub.size).toBe(1);
    state.failing = false;
    expect(json((await reader.take(isEvent('scene'))).data).reads).toBeGreaterThan(0);
  });

  it('fails a new view whole with 500, and registers nothing', async () => {
    const { state, source } = flakySource();
    state.failing = true;
    const hub = new SceneHub({ source, log: vi.fn(), coalesceMs: 30, tickMs: LONG, heartbeatMs: LONG });
    const port = await serve(hub);
    expect((await sse(port, '/api/events')).status).toBe(500);
    expect(hub.size).toBe(0);
  });
});
