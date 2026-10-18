import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEMO_DROP_INS, DEMO_LEISURE_HOUR, DEMO_LOOP_MS, DEMO_SESSIONS, demoRunIds, demoScript, demoSummaryLine, startDemo } from '../../src/adapters/demo.js';
import { Collector } from '../../src/collector.js';
import type { RawEvent } from '../../src/core/types.js';
import type { FloorDetail } from '../../src/scene/types.js';
import { startDaemon } from '../../src/daemon.js';
import { FEATURE_SLOTS, REPO_SLOTS, slotOf } from '../../src/scene/palette.js';
import { personaOf } from '../../src/scene/persona.js';
import { cleanText } from '../../src/scene/text.js';
import { SUMMARY_MAX, summaryInput } from '../../src/summary/input.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('demoScript', () => {
  it('shows Codex and Claude Code together, including Codex drop-ins', async () => {
    const { c, play } = demoCollector();
    await play(0, BASE);
    for (const session of [...DEMO_SESSIONS, ...DEMO_DROP_INS]) {
      expect(c.session(session.id)!.agentKind).toBe(session.agentKind ?? 'claude-code');
    }
    expect(c.session('demo-sw-a1')!.agentKind).toBe('codex');
    expect(c.session('demo-ps-d4')!.agentKind).toBe('claude-code');
    expect(c.session('demo-ps-k11')!.agentKind).toBe('codex');
  });

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
    expect(end.done.map((s) => s.id)).toEqual(['demo-sw-b2', 'demo-oa-h8', 'demo-ps-d4']);
    expect(DEMO_SESSIONS).toHaveLength(7);
  });

  it('keeps every step of a loop within the loop, in time order', () => {
    for (const loop of [0, 1, 2]) {
      const times = demoScript(loop).map((step) => step.at);
      expect(times).toEqual([...times].sort((a, b) => a - b));
      expect(new Set(times).size).toBe(times.length);
      expect(times.every((t) => t >= 0 && t < DEMO_LOOP_MS)).toBe(true);
    }
  });

  it("spawns agents across at least 5 distinct personas (hq-agent-personas TP3), alongside the plain explorer/generalist interns", () => {
    const BASE = 1_000_000_000;
    const types = demoScript().flatMap((step) => step.events(BASE + step.at)).flatMap((e) => (e.type === 'agent.started' ? [e.agentType] : []));
    const personas = new Set(types.map((t) => personaOf(t)));
    expect(personas.size).toBeGreaterThanOrEqual(5);
    expect([...personas].sort()).toEqual(['developer', 'explorer', 'generalist', 'none', 'qa', 'reviewer', 'security', 'techlead'].sort());
  });
});

const BASE = 1_000_000_000;
const CHECKOUT = 'feature:checkout-v2';
const SEARCH = 'feature:search-ranking';

/** A collector the demo feeds, at the time each step is due. `hourOf` defaults to the real local hour, as production does. */
function demoCollector(hourOf?: (now: number) => number) {
  const clock = { now: BASE };
  const c = new Collector({ resolveWorkspace: async () => { throw new Error('demo events carry their workspace'); }, now: () => clock.now, acceptSources: ['demo'], hourOf });
  /** Plays a loop's steps from `base`, calling `after` once each step is in. */
  const play = async (loop: number, base: number, after?: (at: number) => void) => {
    for (const step of demoScript(loop)) {
      clock.now = base + step.at;
      for (const e of step.events(clock.now)) await c.ingest(e);
      after?.(step.at);
    }
  };
  /** A session at its desk, on the checkout floor by default. */
  const desk = (id: string, floorKey = CHECKOUT) => c.floor(floorKey)!.pods.flatMap((p) => p.desks).find((d) => d.occupant?.sessionId === id)!.occupant!;
  return { c, clock, play, desk };
}

/** The sessions on a floor, at a desk or waiting for one. */
const sessionsOn = (floor: FloorDetail) => [...floor.pods.flatMap((p) => p.desks.flatMap((d) => (d.occupant ? [d.occupant] : []))), ...floor.unseated];

describe('the demo workflow run', () => {
  it('opens a room for the payments desk in the first room slot, with its host at the head of the table', async () => {
    const { c, clock } = demoCollector();
    for (const e of demoScript()[0]!.events(BASE)) await c.ingest(e);
    clock.now = BASE + 100;
    const floor = c.floor(CHECKOUT)!;
    const look = { body: slotOf('/demo/payments-svc', REPO_SLOTS), tie: slotOf('checkout-v2', FEATURE_SLOTS) };
    expect(floor.rooms.filter((r) => r.kind === 'workflow')).toEqual([
      {
        kind: 'workflow',
        runId: 'wf_demo-checkout',
        hostSessionId: 'demo-ps-d4',
        name: 'checkout-verify',
        summary: 'Verify split payments end to end',
        phases: [{ title: 'Plan', state: 'current' }, { title: 'Build', state: 'upcoming' }, { title: 'Review', state: 'upcoming' }, { title: 'Ship', state: 'upcoming' }],
        counts: { running: 1, finished: 0 },
        agents: [{ agentId: 'demo-wf-0', label: 'Map the split payment flow', phase: 'Plan', type: 'fairmind-coding:Technical Lead / Architect', running: true, smoking: false, leisure: null }],
        look,
        rect: { x: 18, y: 2, w: 8, h: 6 },
        slot: 0,
      },
    ]);
    // The checkout desk's subagents meet in a room of their own, after the run's.
    expect(floor.rooms.filter((r) => r.kind === 'crew').map((r) => [r.runId, r.hostSessionId, r.name, r.slot])).toEqual([['crew:demo-sw-a1', 'demo-sw-a1', 'Subagents', 1]]);
    expect([floor.roomsMore, floor.size]).toEqual([0, { w: 28, h: 20 }]);
  });

  it('moves the room through its phases, keeps its host in the meeting, and closes it before the loop ends', async () => {
    const { c, play, desk } = demoCollector();
    // Each change, with the step that made it.
    const seen: unknown[][] = [];
    await play(0, BASE, (at) => {
      const room = c.floor(CHECKOUT)!.rooms.find((r) => r.runId === 'wf_demo-checkout');
      const host = desk('demo-ps-d4');
      const now = [room?.phases.find((p) => p.state === 'current')?.title ?? null, room?.counts ?? null, room?.slot ?? null, host.state, host.at.kind === 'room'];
      if (JSON.stringify(seen.at(-1)?.slice(1)) !== JSON.stringify(now)) seen.push([at, ...now]);
    });
    const meeting = (phase: string, running: number, finished: number) => [phase, { running, finished }, 0, 'in_meeting', true];
    expect(seen).toEqual([
      [0, ...meeting('Plan', 1, 0)],
      [8_000, ...meeting('Build', 2, 1)],
      [16_000, ...meeting('Build', 1, 2)],
      [28_000, ...meeting('Review', 1, 3)],
      [40_000, ...meeting('Ship', 1, 4)],
      [52_000, null, null, null, 'done', false],
    ]);
    // The run has completed: the desk lists it.
    expect(desk('demo-ps-d4').runs).toEqual([
      { runId: 'wf_demo-checkout', name: 'checkout-verify', status: 'completed', startedAt: BASE + 25, endedAt: BASE + 52_000, counts: { running: 0, finished: 5 } },
    ]);
  });

  it('runs a new workflow each loop, and lists the earlier ones on the desk', async () => {
    const { c, clock, play, desk } = demoCollector();
    // Read after every step, as the daemon's scene hub does: room slots are taken in the order runs are seen.
    await play(0, BASE, () => c.floor(CHECKOUT));
    clock.now = BASE + DEMO_LOOP_MS;
    for (const e of demoScript(1)[0]!.events(clock.now)) await c.ingest(e);
    expect(c.floor(CHECKOUT)!.rooms.filter((r) => r.kind === 'workflow').map((r) => [r.runId, r.agents.map((a) => a.agentId), r.slot])).toEqual([
      ['wf_demo-checkout-2', ['demo-wf-0-2'], 0],
      ['wf_demo-replay', ['demo-rp-1', 'demo-rp-2', 'demo-rp-0'], 1],
    ]);
    expect(desk('demo-ps-d4').at).toEqual({ kind: 'room', slot: 0 });
    expect(desk('demo-ps-d4').runs.map((r) => [r.runId, r.status])).toEqual([['wf_demo-checkout-2', 'running'], ['wf_demo-checkout', 'completed']]);
    expect([demoRunIds(2).runId, demoRunIds(2).agent(3)]).toEqual(['wf_demo-checkout-3', 'demo-wf-3-3']);
    expect([demoRunIds(2, 'replay').runId, demoRunIds(2, 'replay').agent(3)]).toEqual(['wf_demo-replay-3', 'demo-rp-3-3']);
  });

  it('starts a second run on the orders desk before the first ends, and ends it in the next loop: a room is open every second', async () => {
    const { c, clock, desk } = demoCollector();
    const steps = [0, 1, 2].flatMap((loop) => demoScript(loop).map((step) => ({ step, base: BASE + loop * DEMO_LOOP_MS })));
    // Each change of the open rooms, by second, with the orders desk's place: [second, rooms (run and slot), host's place].
    const seen: unknown[][] = [];
    const empty: number[] = [];
    let next = 0;
    for (let second = 0; second < 3 * DEMO_LOOP_MS / 1000; second++) {
      for (; next < steps.length && steps[next]!.base + steps[next]!.step.at <= BASE + second * 1000; next++) {
        const { step, base } = steps[next]!;
        clock.now = base + step.at;
        for (const e of step.events(clock.now)) await c.ingest(e);
        c.floor(CHECKOUT);
      }
      clock.now = BASE + second * 1000 + 500;
      const rooms = c.floor(CHECKOUT)!.rooms.filter((r) => r.kind === 'workflow');
      if (rooms.length === 0) empty.push(second);
      const now = [rooms.map((r) => `${r.runId} ${r.slot}`), desk('demo-oa-c3').at.kind];
      if (JSON.stringify(seen.at(-1)?.slice(1)) !== JSON.stringify(now)) seen.push([second, ...now]);
    }
    expect(empty).toEqual([]);
    expect(seen).toEqual([
      [0, ['wf_demo-checkout 0'], 'desk'],
      [44, ['wf_demo-checkout 0', 'wf_demo-replay 1'], 'room'],
      [52, ['wf_demo-replay 1'], 'room'],
      [60, ['wf_demo-checkout-2 0', 'wf_demo-replay 1'], 'desk'],
      [67, ['wf_demo-checkout-2 0'], 'desk'],
      [104, ['wf_demo-checkout-2 0', 'wf_demo-replay-2 1'], 'room'],
      [112, ['wf_demo-replay-2 1'], 'room'],
      [120, ['wf_demo-checkout-3 0', 'wf_demo-replay-2 1'], 'desk'],
      [127, ['wf_demo-checkout-3 0'], 'desk'],
      [164, ['wf_demo-checkout-3 0', 'wf_demo-replay-3 1'], 'room'],
      [172, ['wf_demo-replay-3 1'], 'room'],
    ]);
    expect(desk('demo-oa-c3').runs.map((r) => [r.runId, r.status, r.counts])).toEqual([
      ['wf_demo-replay-3', 'running', { running: 2, finished: 1 }],
      ['wf_demo-replay-2', 'completed', { running: 0, finished: 4 }],
      ['wf_demo-replay', 'completed', { running: 0, finished: 4 }],
    ]);
  });

  it('starts every session over each loop without asking anything new, so the summary lines stay current', async () => {
    const { c, play } = demoCollector();
    await play(0, BASE);
    const asked = () => [...DEMO_SESSIONS, ...DEMO_DROP_INS].map((s) => [s.id, c.session(s.id)!.lastPrompt, c.session(s.id)!.lastPromptAt]);
    const first = asked();
    expect(first.find(([id]) => id === 'demo-oa-g7')).toEqual(['demo-oa-g7', 'Use Postgres.', BASE + 42_000]);
    expect(first.find(([id]) => id === 'demo-oa-j10')).toEqual(['demo-oa-j10', 'Which states can a refund be in?', BASE + 36_000]);
    await play(1, BASE + DEMO_LOOP_MS);
    expect(asked()).toEqual(first);
    expect(c.snapshot().attention.done.map((s) => s.id)).toEqual(['demo-sw-b2', 'demo-oa-h8', 'demo-ps-d4']);
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

describe('the demo smoke test (mega sigaro)', () => {
  it('holds a cigar on the search desk from its tool.started (within the opening batch) to its tool.finished at 45s, with smoke:true set explicitly', async () => {
    const { play, desk } = demoCollector();
    const seen: unknown[] = [];
    await play(0, BASE, (at) => {
      if ([0, 20_000, 28_000, 44_000, 45_000, 46_000].includes(at)) seen.push([at, desk('demo-ss-e5', SEARCH).smoking]);
    });
    expect(seen).toEqual([
      [0, true],
      [20_000, true],
      [28_000, true],
      [44_000, true],
      [45_000, false],
      [46_000, false],
    ]);
  });
});

describe('the demo leisure window (aperitivo/biliardino/coffee)', () => {
  /** Who is waiting, and what for, among `demo-sw-a1`'s interns and the checkout-verify run's agents (sorted by id: `meetingAgentsOf`/`internsOf` order by recency, not id, but `assignLeisure` pairs by id). */
  const byId = (a: [string, unknown], b: [string, unknown]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const waiters = (desk: ReturnType<ReturnType<typeof demoCollector>['desk']>, room: { agents: { agentId: string; leisure: string | null }[] } | undefined) => ({
    interns: desk.interns.filter((i) => i.leisure !== null).map((i): [string, string | null] => [i.agentId, i.leisure]).sort(byId),
    agents: (room?.agents ?? []).filter((a) => a.leisure !== null).map((a): [string, string | null] => [a.agentId, a.leisure]).sort(byId),
  });

  it('pairs waiters for biliardino, with a lone gin tonic, once the window is forced open (DEMO_LEISURE_HOUR)', async () => {
    const { c, play, desk } = demoCollector(() => DEMO_LEISURE_HOUR);
    const seen: unknown[] = [];
    await play(0, BASE, (at) => {
      if ([16_000, 20_000].includes(at)) {
        const room = c.floor(CHECKOUT)!.rooms.find((r) => r.runId === 'wf_demo-checkout');
        seen.push([at, waiters(desk('demo-sw-a1'), room)]);
      }
    });
    expect(seen).toEqual([
      [16_000, { interns: [['demo-a1-explore', 'gintonic']], agents: [['demo-wf-0', 'biliardino'], ['demo-wf-1', 'biliardino']] }],
      [20_000, { interns: [['demo-a1-explore', 'gintonic']], agents: [['demo-wf-0', 'biliardino'], ['demo-wf-1', 'biliardino']] }],
    ]);
  });

  it('sends the same waiters for coffee instead, outside the window', async () => {
    const { c, play, desk } = demoCollector(() => 10);
    const seen: unknown[] = [];
    await play(0, BASE, (at) => {
      if ([16_000, 20_000].includes(at)) {
        const room = c.floor(CHECKOUT)!.rooms.find((r) => r.runId === 'wf_demo-checkout');
        seen.push([at, waiters(desk('demo-sw-a1'), room)]);
      }
    });
    expect(seen).toEqual([
      [16_000, { interns: [['demo-a1-explore', 'coffee']], agents: [['demo-wf-0', 'coffee'], ['demo-wf-1', 'coffee']] }],
      [20_000, { interns: [['demo-a1-explore', 'coffee']], agents: [['demo-wf-0', 'coffee'], ['demo-wf-1', 'coffee']] }],
    ]);
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
    for (const s of [...DEMO_SESSIONS, ...DEMO_DROP_INS]) expect([s.id, demoSummaryLine(summaryInput(c.session(s.id)!)!.text)]).toEqual([s.id, s.summary]);
    expect(demoSummaryLine('Title: Something else\nLast request: -')).toBe('Working through the demo script');
    expect(demoSummaryLine('')).toBe('Working through the demo script');
    const lines = [...DEMO_SESSIONS, ...DEMO_DROP_INS].map((s) => s.summary);
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

describe('demo drop-ins', () => {
  /** Who sits at each desk of the checkout floor, pod by pod; null: a free desk. */
  const desks = (floor: FloorDetail) => floor.pods.map((p) => p.desks.map((d) => d.occupant?.sessionId ?? null));

  it('brings the checkout floor to nine sessions for part of every loop, which grows it by a block in the first loop only', async () => {
    const { c, play } = demoCollector();
    const dropIns = DEMO_DROP_INS.map((s) => s.id);
    // Each loop's changes in the floor's sessions and blocks, with the step that made them.
    const seen: unknown[][][] = [[], [], []];
    const nine: unknown[] = [];
    for (const loop of [0, 1, 2]) {
      await play(loop, BASE + loop * DEMO_LOOP_MS, (at) => {
        const floor = c.floor(CHECKOUT)!;
        const now = [sessionsOn(floor).length, c.seatingOf(CHECKOUT)!.blocks];
        if (JSON.stringify(seen[loop]!.at(-1)?.slice(1)) !== JSON.stringify(now)) seen[loop]!.push([at, ...now]);
        if (now[0] === 9 && nine.length === loop) nine.push([floor.unseated, desks(floor)]);
        // A drop-in never waits for you and never finishes a turn: the attention bar keeps to the other sessions.
        const { needsYou, done } = c.snapshot().attention;
        expect([...needsYou, ...done].filter((s) => dropIns.includes(s.id))).toEqual([]);
      });
    }
    const counts = [4, 5, 6, 7, 8, 9, 8, 7, 6, 5, 4];
    const times = [0, 5_000, 13_000, 21_000, 29_000, 37_000, 43_000, 46_000, 54_000, 56_000, 58_000];
    expect(seen[0]).toEqual(times.map((at, i) => [at, counts[i], at < 37_000 ? 1 : 2]));
    for (const loop of [1, 2]) expect(seen[loop]).toEqual(times.map((at, i) => [at, counts[i], 2]));
    // With nine there, every session has a desk: in the first loop the ninth takes the first desk of the new block; later
    // loops find the second block free and take whole pods there first.
    expect(nine).toEqual([
      [[], [['demo-ps-d4', 'demo-sw-b2', 'demo-sw-a1', 'demo-sw-i9'], ['demo-oa-c3', 'demo-oa-j10', 'demo-ps-k11', 'demo-sw-l12'], ['demo-ps-m13', null, null, null], [null, null, null, null]]],
      [[], [['demo-ps-d4', 'demo-sw-b2', 'demo-sw-a1', 'demo-sw-i9'], ['demo-oa-c3', 'demo-oa-j10', null, null], ['demo-ps-k11', 'demo-ps-m13', null, null], ['demo-sw-l12', null, null, null]]],
      [[], [['demo-ps-d4', 'demo-sw-b2', 'demo-sw-a1', 'demo-sw-i9'], ['demo-oa-c3', 'demo-oa-j10', null, null], ['demo-ps-k11', 'demo-ps-m13', null, null], ['demo-sw-l12', null, null, null]]],
    ]);
  });

  it('sends the drop-in that is cleared to the lounge while it is idle, and back to its desk at its next prompt', async () => {
    const { c, play } = demoCollector();
    const seen: unknown[][] = [];
    for (const loop of [0, 1]) {
      await play(loop, BASE + loop * DEMO_LOOP_MS, (at) => {
        const me = sessionsOn(c.floor(CHECKOUT)!).find((o) => o.sessionId === 'demo-oa-j10');
        const now = [me?.state ?? null, me?.at ?? null];
        if (JSON.stringify(seen.at(-1)?.slice(1)) !== JSON.stringify(now)) seen.push([loop * DEMO_LOOP_MS + at, ...now]);
      });
    }
    expect(seen).toEqual([
      [0, null, null],
      [13_000, 'working', { kind: 'desk' }],
      [20_000, 'idle', { kind: 'lounge', seat: 0 }],
      [36_000, 'working', { kind: 'desk' }],
      [46_000, null, null],
      [73_000, 'working', { kind: 'desk' }],
      [80_000, 'idle', { kind: 'lounge', seat: 0 }],
      [96_000, 'working', { kind: 'desk' }],
      [106_000, null, null],
    ]);
  });

  it('ends each drop-in before the loop ends: it leaves the floor and frees its desk', async () => {
    const { c, play } = demoCollector();
    const left: unknown[] = [];
    await play(0, BASE, (at) => {
      const floor = c.floor(CHECKOUT)!;
      for (const { id } of DEMO_DROP_INS) {
        if (c.session(id)?.state === 'ended' && !left.some((l) => (l as unknown[])[0] === id)) {
          left.push([id, at, sessionsOn(floor).some((o) => o.sessionId === id), c.seatingOf(CHECKOUT)!.desks.includes(id)]);
        }
      }
    });
    expect(left).toEqual([
      ['demo-sw-i9', 43_000, false, false],
      ['demo-oa-j10', 46_000, false, false],
      ['demo-ps-k11', 54_000, false, false],
      ['demo-sw-l12', 56_000, false, false],
      ['demo-ps-m13', 58_000, false, false],
    ]);
    expect(c.seatingOf(CHECKOUT)!.desks).toEqual(['demo-ps-d4', 'demo-sw-b2', 'demo-sw-a1', null, 'demo-oa-c3', ...Array(11).fill(null)]);
    expect(c.seatingOf(CHECKOUT)!.lounge).toEqual(Array(8).fill(null));
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
    expect(got).toHaveLength(87);
    // The second loop starts at 60 s; its next step is due at 63 s.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(got).toHaveLength(122);
    expect(got.flatMap((e) => (e.type === 'workflow.started' ? [e.runId] : []))).toEqual(['wf_demo-checkout', 'wf_demo-replay', 'wf_demo-checkout-2']);
    demo.stop();
    await vi.advanceTimersByTimeAsync(200_000);
    expect(got).toHaveLength(122);
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
      expect(d.collector.floor(CHECKOUT)!.rooms.map((r) => [r.runId, r.hostSessionId])).toEqual([['wf_demo-checkout', 'demo-ps-d4'], ['crew:demo-sw-a1', 'demo-sw-a1']]);
    } finally {
      await d.stop();
    }
  });
});
