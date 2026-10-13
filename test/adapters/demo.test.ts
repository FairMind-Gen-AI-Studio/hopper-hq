import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEMO_LOOP_MS, DEMO_SESSIONS, demoRunIds, demoScript, demoSummaryLine, startDemo } from '../../src/adapters/demo.js';
import { Collector } from '../../src/collector.js';
import type { RawEvent } from '../../src/core/types.js';
import { startDaemon } from '../../src/daemon.js';
import { FEATURE_SLOTS, REPO_SLOTS, slotOf } from '../../src/scene/palette.js';
import { cleanText } from '../../src/scene/text.js';
import { SUMMARY_MAX, summaryInput } from '../../src/summary/input.js';

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
    expect(end.done.map((s) => s.id)).toEqual(['demo-sw-b2', 'demo-oa-h8', 'demo-oa-c3', 'demo-ps-d4']);
    expect(DEMO_SESSIONS).toHaveLength(7);
  });
});

const BASE = 1_000_000_000;
const CHECKOUT = 'feature:checkout-v2';

/** A collector the demo feeds, at the time each step is due. */
function demoCollector() {
  const clock = { now: BASE };
  const c = new Collector({ resolveWorkspace: async () => { throw new Error('demo events carry their workspace'); }, now: () => clock.now, acceptSources: ['demo'] });
  /** Plays a loop's steps from `base`, calling `after` once each step is in. */
  const play = async (loop: number, base: number, after?: (at: number) => void) => {
    for (const step of demoScript(loop)) {
      clock.now = base + step.at;
      for (const e of step.events(clock.now)) await c.ingest(e);
      after?.(step.at);
    }
  };
  const desk = (id: string) => c.floor(CHECKOUT)!.islands.flatMap((i) => i.desks).find((d) => d.sessionId === id)!;
  return { c, clock, play, desk };
}

describe('the demo workflow run', () => {
  it('opens a room for the payments desk, with its host at the head of the table, east of the islands', async () => {
    const { c, clock } = demoCollector();
    for (const e of demoScript()[0]!.events(BASE)) await c.ingest(e);
    clock.now = BASE + 100;
    const floor = c.floor(CHECKOUT)!;
    const look = { body: slotOf('/demo/payments-svc', REPO_SLOTS), tie: slotOf('checkout-v2', FEATURE_SLOTS) };
    expect(floor.rooms).toEqual([
      {
        runId: 'wf_demo-checkout',
        hostSessionId: 'demo-ps-d4',
        name: 'checkout-verify',
        summary: 'Verify split payments end to end',
        phases: [{ title: 'Plan', state: 'current' }, { title: 'Build', state: 'upcoming' }, { title: 'Review', state: 'upcoming' }, { title: 'Ship', state: 'upcoming' }],
        counts: { running: 1, finished: 0 },
        agents: [{ agentId: 'demo-wf-0', label: 'Map the split payment flow', phase: 'Plan', type: 'workflow-subagent', running: true }],
        look,
        host: { pose: 'still', badge: 'meeting', ...look },
        rect: { x: 22, y: 2, w: 8, h: 6 },
      },
    ]);
    expect([floor.roomsMore, floor.size]).toEqual([0, { w: 32, h: 12 }]);
  });

  it('moves the room through its phases, keeps its host in the meeting, and closes it before the loop ends', async () => {
    const { c, play, desk } = demoCollector();
    const seen: unknown[] = [];
    await play(0, BASE, (at) => {
      const room = c.floor(CHECKOUT)!.rooms[0];
      const host = desk('demo-ps-d4');
      seen.push([at, room?.phases.find((p) => p.state === 'current')?.title ?? null, room?.counts ?? null, host.state, host.away]);
    });
    const meeting = (phase: string, running: number, finished: number) => [phase, { running, finished }, 'in_meeting', true];
    expect(seen).toEqual([
      [0, ...meeting('Plan', 1, 0)],
      [6_000, ...meeting('Plan', 1, 0)],
      [8_000, ...meeting('Build', 2, 1)],
      [10_000, ...meeting('Build', 2, 1)],
      [16_000, ...meeting('Build', 1, 2)],
      [22_000, ...meeting('Build', 1, 2)],
      [28_000, ...meeting('Review', 1, 3)],
      [30_000, ...meeting('Review', 1, 3)],
      [34_000, ...meeting('Review', 1, 3)],
      [40_000, ...meeting('Ship', 1, 4)],
      [42_000, ...meeting('Ship', 1, 4)],
      [50_000, ...meeting('Ship', 1, 4)],
      [52_000, null, null, 'done', false],
    ]);
    // The run has completed: the desk lists it.
    expect(desk('demo-ps-d4').runs).toEqual([
      { runId: 'wf_demo-checkout', name: 'checkout-verify', status: 'completed', startedAt: BASE + 25, endedAt: BASE + 52_000, counts: { running: 0, finished: 5 } },
    ]);
  });

  it('runs a new workflow each loop, and lists the earlier ones on the desk', async () => {
    const { c, clock, play, desk } = demoCollector();
    await play(0, BASE);
    clock.now = BASE + DEMO_LOOP_MS;
    for (const e of demoScript(1)[0]!.events(clock.now)) await c.ingest(e);
    expect(c.floor(CHECKOUT)!.rooms.map((r) => [r.runId, r.agents.map((a) => a.agentId), r.host !== null])).toEqual([['wf_demo-checkout-2', ['demo-wf-0-2'], true]]);
    expect(desk('demo-ps-d4').runs.map((r) => [r.runId, r.status])).toEqual([['wf_demo-checkout-2', 'running'], ['wf_demo-checkout', 'completed']]);
    expect([demoRunIds(2).runId, demoRunIds(2).agent(3)]).toEqual(['wf_demo-checkout-3', 'demo-wf-3-3']);
  });

  it('starts every session over each loop without asking anything new, so the summary lines stay current', async () => {
    const { c, play } = demoCollector();
    await play(0, BASE);
    const asked = () => DEMO_SESSIONS.map((s) => [s.id, c.session(s.id)!.lastPrompt, c.session(s.id)!.lastPromptAt]);
    const first = asked();
    expect(first.find(([id]) => id === 'demo-oa-g7')).toEqual(['demo-oa-g7', 'Use Postgres.', BASE + 42_000]);
    await play(1, BASE + DEMO_LOOP_MS);
    expect(asked()).toEqual(first);
    expect(c.snapshot().attention.done.map((s) => s.id)).toEqual(['demo-sw-b2', 'demo-oa-h8', 'demo-oa-c3', 'demo-ps-d4']);
    expect(c.session('demo-sw-b2')!.stateSince).toBe(BASE + DEMO_LOOP_MS + 22);
  });
});

describe('demo interns', () => {
  it('gives the address desk an Explore intern and a general-purpose one, done after 6 and 30 seconds', async () => {
    const { play, desk } = demoCollector();
    const seen: unknown[] = [];
    await play(0, BASE, (at) => {
      if ([0, 6_000, 30_000].includes(at)) seen.push([at, desk('demo-sw-a1').interns.map((i) => [i.agentId, i.type, i.running]), desk('demo-sw-a1').agentsRunning]);
    });
    expect(seen).toEqual([
      [0, [['demo-a1-explore', 'Explore', true], ['demo-a1-review', 'general-purpose', true]], 2],
      [6_000, [['demo-a1-review', 'general-purpose', true], ['demo-a1-explore', 'Explore', false]], 1],
      [30_000, [['demo-a1-review', 'general-purpose', false], ['demo-a1-explore', 'Explore', false]], 0],
    ]);
    expect(desk('demo-sw-a1').interns.map((i) => i.label)).toEqual(['Check the address form against the design', 'Find every caller of useCart()']);
  });
});

describe('demo answers and summary lines', () => {
  it('replies before every turn it ends', async () => {
    for (const loop of [0, 1]) {
      for (const step of demoScript(loop)) {
        const events = step.events(BASE + step.at);
        events.forEach((e, i) => {
          if (e.type === 'turn.finished') expect([e.sessionId, events.slice(0, i).some((x) => x.type === 'answer' && x.sessionId === e.sessionId)]).toEqual([e.sessionId, true]);
        });
      }
    }
    const { c, play } = demoCollector();
    await play(0, BASE);
    expect(DEMO_SESSIONS.filter((s) => c.session(s.id)!.lastAnswer !== null).map((s) => s.id)).toEqual(['demo-sw-b2', 'demo-oa-c3', 'demo-ps-d4', 'demo-oa-h8']);
  });

  it("gives each demo session its own line, found by the title in its notes, and a generic line otherwise", async () => {
    const { c, play } = demoCollector();
    await play(0, BASE);
    for (const s of DEMO_SESSIONS) expect([s.id, demoSummaryLine(summaryInput(c.session(s.id)!)!.text)]).toEqual([s.id, s.summary]);
    expect(demoSummaryLine('Title: Something else\nLast request: -')).toBe('Working through the demo script');
    expect(demoSummaryLine('')).toBe('Working through the demo script');
    const lines = DEMO_SESSIONS.map((s) => s.summary);
    expect(new Set(lines).size).toBe(lines.length);
    for (const line of lines) expect([line, cleanText(line, SUMMARY_MAX) === line && Array.from(line).length <= 100]).toEqual([line, true]);
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
    expect(got).toHaveLength(35);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(got).toHaveLength(54);
    // The second loop starts at 60 s; its next step is due at 66 s.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(got).toHaveLength(89);
    expect(got.flatMap((e) => (e.type === 'workflow.started' ? [e.runId] : []))).toEqual(['wf_demo-checkout', 'wf_demo-checkout-2']);
    demo.stop();
    await vi.advanceTimersByTimeAsync(200_000);
    expect(got).toHaveLength(89);
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

  it('shows the run as a room on the checkout floor, and writes each session that ends a turn or waits its own line', async () => {
    const tmp = (prefix: string) => mkdtemp(join(tmpdir(), prefix));
    const d = await startDaemon({ demo: true, port: 0, dataDir: await tmp('shq-demo-'), claudeDir: await tmp('shq-claude-'), log: () => {}, summarizer: { settleMs: 0 } });
    try {
      const ids = ['demo-sw-b2', 'demo-oa-c3', 'demo-ps-d4', 'demo-oa-g7'];
      const lines = ids.map((id) => DEMO_SESSIONS.find((s) => s.id === id)!.summary);
      await vi.waitFor(() => expect(ids.map((id) => d.collector.session(id)?.summary?.text ?? null)).toEqual(lines), { timeout: 5000 });
      expect(d.collector.floor(CHECKOUT)!.rooms.map((r) => [r.runId, r.hostSessionId])).toEqual([['wf_demo-checkout', 'demo-ps-d4']]);
    } finally {
      await d.stop();
    }
  });
});
