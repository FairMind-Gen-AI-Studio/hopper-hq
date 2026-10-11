import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEMO_SESSIONS, demoScript, startDemo } from '../../src/adapters/demo.js';
import { Collector } from '../../src/collector.js';
import type { RawEvent } from '../../src/core/types.js';
import { startDaemon } from '../../src/daemon.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('demoScript', () => {
  it('opens with three floors and two sessions waiting', async () => {
    const base = 1_000_000_000;
    let now = base;
    const c = new Collector({ resolveWorkspace: async () => { throw new Error('demo events carry their workspace'); }, now: () => now, acceptSources: ['demo'] });
    const steps = demoScript();
    for (const e of steps[0]!.events(base)) await c.ingest(e);
    now = base + 100;
    const snap = c.snapshot();
    expect(snap.floors.map((f) => [f.name, f.kind, f.repos])).toEqual([
      ['checkout-v2', 'feature', ['orders-api', 'payments-svc', 'storefront-web']],
      ['search-ranking', 'feature', ['search-svc']],
      ['orders-api', 'department', ['orders-api']],
    ]);
    expect(snap.attention.needsYou.map((s) => s.id)).toEqual(['demo-oa-c3', 'demo-oa-g7']);
    expect(snap.attention.done.map((s) => s.id)).toEqual(['demo-sw-b2']);

    for (const step of steps.slice(1)) {
      now = base + step.at;
      for (const e of step.events(now)) await c.ingest(e);
    }
    now = base + 59_000;
    const end = c.snapshot().attention;
    expect(end.needsYou.map((s) => s.id)).toEqual(['demo-sw-a1']);
    expect(end.done.map((s) => s.id)).toEqual(['demo-sw-b2', 'demo-oa-h8', 'demo-ps-d4', 'demo-oa-c3']);
    expect(DEMO_SESSIONS).toHaveLength(7);
  });
});

describe('demo floors', () => {
  it('announces each session when it started, oldest first', () => {
    const b = 1_000_000_000;
    const seen = demoScript()[0]!.events(b).flatMap((e) => (e.type === 'session.seen' ? [[e.sessionId, e.ts, e.startedAt]] : []));
    expect(seen).toEqual(DEMO_SESSIONS.map((s, i) => [s.id, b - (i + 1) * 600_000, b - (i + 1) * 600_000]).reverse());
  });
});

describe('startDemo', () => {
  it('replays the script on a loop until stopped', async () => {
    vi.useFakeTimers();
    const got: RawEvent[] = [];
    const demo = startDemo((e) => got.push(e), { now: () => 5_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toHaveLength(32);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(got).toHaveLength(40);
    demo.stop();
    await vi.advanceTimersByTimeAsync(200_000);
    expect(got).toHaveLength(40);
  });
});

describe('demo daemon', () => {
  it('serves demo sessions and ignores real ones', async () => {
    const d = await startDaemon({ demo: true, port: 0, dataDir: await mkdtemp(join(tmpdir(), 'shq-demo-')), claudeDir: await mkdtemp(join(tmpdir(), 'shq-claude-')), log: () => {} });
    await new Promise((r) => setTimeout(r, 50));
    await d.collector.ingest({ type: 'prompt', sessionId: 'REAL', ts: Date.now(), source: 'hook', cwd: '/w/real', text: 'x' });
    await d.collector.idle();
    const summary = d.collector.attentionSummary();
    expect(summary.needsYou).toBe(2);
    expect(d.collector.snapshot().floors.flatMap((f) => f.sessions.map((s) => s.id))).not.toContain('REAL');
    await d.stop();
  });
});
