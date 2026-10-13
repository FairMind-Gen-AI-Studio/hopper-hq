import { describe, expect, it, vi } from 'vitest';
import { basename } from 'node:path';
import { demoScript } from '../src/adapters/demo.js';
import type { WorkspaceResolver } from '../src/adapters/git.js';
import { Collector } from '../src/collector.js';
import { newSession } from '../src/core/reducer.js';
import type { RawEvent, Session } from '../src/core/types.js';
import { emptySeating, parseSeating } from '../src/scene/seating.js';
import type { FloorDetail } from '../src/scene/types.js';
import { Store } from '../src/store/store.js';

const resolver: WorkspaceResolver = async (cwd) => ({ cwd, repoRoot: cwd, repoName: basename(cwd), worktree: false, branch: 'main' });
const NOW = 1_000_000;
const hook = (e: Record<string, unknown>): RawEvent => ({ sessionId: 'S1', ts: NOW, source: 'hook', cwd: '/w/orders-api', ...e }) as RawEvent;

function collector(extra: Partial<ConstructorParameters<typeof Collector>[0]> = {}) {
  return new Collector({ resolveWorkspace: resolver, now: () => NOW + 1000, saveDelayMs: 0, ...extra });
}

describe('Collector', () => {
  it('creates an unknown session from an event that carries a cwd', async () => {
    const c = collector();
    await c.ingest(hook({ type: 'prompt', text: 'go' }));
    const snap = c.snapshot();
    expect(snap.floors.map((f) => [f.key, f.kind])).toEqual([['repo:/w/orders-api', 'department']]);
    expect(snap.floors[0]!.sessions[0]).toMatchObject({ id: 'S1', effectiveState: 'working', lastPrompt: 'go' });
  });

  it('drops events for unknown sessions without a cwd', async () => {
    const c = collector();
    await c.ingest({ type: 'prompt', sessionId: 'X', ts: NOW, source: 'hook', text: 'x' });
    expect(c.dropped).toBe(1);
    expect(c.snapshot().floors).toEqual([]);
  });

  it('applies events in arrival order even when git is slow', async () => {
    const slow: WorkspaceResolver = (cwd) => new Promise((r) => setTimeout(() => r({ cwd, repoRoot: cwd, repoName: 'orders-api', worktree: false, branch: 'main' }), 20));
    const c = collector({ resolveWorkspace: slow });
    void c.ingest(hook({ type: 'tool.started', toolId: 't1', tool: 'Bash', label: 'Bash: ls', agentId: null }));
    void c.ingest(hook({ type: 'turn.finished', backgroundTasks: 0, ts: NOW }));
    await c.idle();
    expect(c.snapshot().attention.done.map((s) => s.id)).toEqual(['S1']);
  });

  it('drops events whose session id could not name a session, and skips such saved sessions, saying how many', async () => {
    const c = collector();
    for (const sessionId of ['..', 'a/b']) await c.ingest(hook({ type: 'prompt', text: 'go', sessionId }));
    expect(c.dropped).toBe(2);
    expect(c.liveViews()).toEqual([]);
    const store = await Store.open(':memory:');
    const ws = { cwd: '/w/x', repoRoot: '/w/x', repoName: 'x', worktree: false, branch: 'main' };
    const log = vi.fn();
    store.saveSessions([newSession('S1', 1000, ws)], 1);
    collector({ store, log });
    expect(log).not.toHaveBeenCalled();
    store.saveSessions([newSession('..', 1000, ws)], 1);
    expect(collector({ store, log }).liveViews().map((v) => v.id)).toEqual(['S1']);
    store.saveSessions([newSession('a b', 1000, ws)], 1);
    collector({ store, log });
    expect(log.mock.calls).toEqual([['scranton-hq skipped 1 saved session whose id is not valid'], ['scranton-hq skipped 2 saved sessions whose ids are not valid']]);
    store.close();
  });

  it('ignores sources it was not asked to accept', async () => {
    const c = collector({ acceptSources: ['demo'] });
    await c.ingest(hook({ type: 'prompt', text: 'go' }));
    expect(c.snapshot().floors).toEqual([]);
  });

  it('marks finished sessions as seen', async () => {
    const c = collector();
    await c.ingest(hook({ type: 'prompt', text: 'go' }));
    expect(c.markSeen('S1')).toBe(false);
    await c.ingest(hook({ type: 'turn.finished', backgroundTasks: 0, ts: NOW + 1 }));
    expect(c.attentionSummary().done).toBe(1);
    expect(c.markSeen('S1')).toBe(true);
    expect(c.attentionSummary().done).toBe(0);
    expect(c.markSeen('S1')).toBe(false);
    expect(c.markSeen('nope')).toBe(false);
  });

  it('marks every finished session at once', async () => {
    const c = collector();
    await c.ingest(hook({ type: 'turn.finished', backgroundTasks: 0 }));
    await c.ingest(hook({ type: 'turn.finished', backgroundTasks: 0, sessionId: 'S2' }));
    expect(c.markAllSeen()).toBe(2);
  });

  it('summarises who needs attention', async () => {
    const c = collector();
    await c.ingest(hook({ type: 'waiting', reason: { kind: 'permission', text: 'Bash', detail: 'Bash: rm -rf dist' } }));
    expect(c.attentionSummary()).toEqual({
      generatedAt: NOW + 1000,
      needsYou: 1,
      done: 0,
      items: [{ id: 'S1', name: null, repo: 'orders-api', feature: null, state: 'needs_you', since: NOW, reason: { kind: 'permission', text: 'Bash', detail: 'Bash: rm -rf dist' }, title: null, tmuxPane: null, tmuxSession: null }],
    });
  });

  it('cleans names, titles and reasons in the attention summary', async () => {
    const c = collector();
    await c.ingest(hook({ type: 'session.seen', workspace: { cwd: '/w/orders-api', repoRoot: '/w/orders-api', repoName: 'orders-api', worktree: false, branch: 'main' }, name: 'orders\u001b[31m-api\u0007' }));
    await c.ingest(hook({ type: 'title', title: '\u202EFix\r\nthe build' }));
    await c.ingest(hook({ type: 'waiting', reason: { kind: 'permission', text: 'Bash\u0000', detail: 'Bash: rm\u001b[2K -rf dist' }, agentId: null }));
    expect(c.attentionSummary().items[0]).toEqual({
      id: 'S1', name: 'orders[31m-api', repo: 'orders-api', feature: null, state: 'needs_you', since: NOW,
      reason: { kind: 'permission', text: 'Bash', detail: 'Bash: rm[2K -rf dist' }, title: 'Fix the build', tmuxPane: null, tmuxSession: null,
    });
  });

  it('gives the pane with its tmux session as Claude Code wrote it, for the mod to compare with what tmux says', async () => {
    const c = collector();
    await c.ingest(hook({ type: 'session.seen', workspace: { cwd: '/w/orders-api', repoRoot: '/w/orders-api', repoName: 'orders-api', worktree: false, branch: 'main' }, tmuxPane: '%7', tmuxSession: 'api  work' }));
    await c.ingest(hook({ type: 'waiting', reason: { kind: 'question', text: 'Which one?' }, agentId: null }));
    expect(c.attentionSummary().items[0]).toMatchObject({ tmuxPane: '%7', tmuxSession: 'api  work' });
  });

  it('cleans the repo and the feature in the attention summary', async () => {
    const c = collector();
    await c.ingest(hook({ type: 'session.seen', workspace: { cwd: '/w/orders-api', repoRoot: '/w/orders-api', repoName: 'orders\u001b[1m-api', worktree: false, branch: 'feat/check\u202Eout' } }));
    await c.ingest(hook({ type: 'waiting', reason: { kind: 'question', text: 'Which one?' }, agentId: null }));
    expect(c.attentionSummary().items[0]).toMatchObject({ repo: 'orders[1m-api', feature: 'checkout' });
  });

  it('says a session needs you when its reason has no text left once cleaned', async () => {
    const c = collector();
    await c.ingest(hook({ type: 'waiting', reason: { kind: 'input', text: '\u0007\u202E' }, agentId: null }));
    expect(c.attentionSummary().items[0]!.reason).toEqual({ kind: 'input', text: 'Needs you' });
  });

  it('notifies listeners until they unsubscribe', async () => {
    const c = collector();
    const fn = vi.fn();
    const off = c.onChange(fn);
    await c.ingest(hook({ type: 'prompt', text: 'go' }));
    expect(fn).toHaveBeenCalled();
    off();
    fn.mockClear();
    await c.ingest(hook({ type: 'prompt', text: 'again', ts: NOW + 5 }));
    expect(fn).not.toHaveBeenCalled();
  });

  it('keeps sessions it could not save and saves them with the next change', async () => {
    vi.useFakeTimers();
    try {
      const saved: string[][] = [];
      let fail = true;
      const store = {
        loadSessions: () => [],
        loadFloors: () => new Map(),
        appendEvent: () => {},
        save: (list: Session[]) => {
          if (fail) {
            fail = false;
            throw new Error('database is locked');
          }
          saved.push(list.map((s) => s.id));
        },
      } as unknown as Store;
      const log = vi.fn();
      const c = collector({ store, log, saveDelayMs: 10 });
      await c.ingest(hook({ type: 'prompt', text: 'go' }));
      vi.advanceTimersByTime(10);
      expect(log).toHaveBeenCalledWith('scranton-hq could not save sessions and floors: database is locked');
      expect(saved).toEqual([]);
      await c.ingest(hook({ type: 'prompt', text: 'go', sessionId: 'S2' }));
      vi.advanceTimersByTime(10);
      expect(saved).toEqual([['S1', 'S2']]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores sessions from the store and keeps ordering after a restart', async () => {
    const store = await Store.open(':memory:');
    const a = collector({ store });
    await a.ingest(hook({ type: 'prompt', text: 'go' }));
    await a.close();
    const b = collector({ store });
    expect(b.snapshot().floors[0]!.sessions[0]).toMatchObject({ id: 'S1', effectiveState: 'working' });
    await b.ingest(hook({ type: 'turn.finished', backgroundTasks: 0, ts: NOW }));
    expect(b.attentionSummary().done).toBe(1);
    await b.close();
    store.close();
  });

  it('keeps a reply in the session row and never in the event log', async () => {
    const store = await Store.open(':memory:');
    const c = collector({ store });
    await c.ingest(hook({ type: 'prompt', text: 'go' }));
    await c.ingest(hook({ type: 'answer', text: 'All green: 42 tests pass.' }));
    await c.ingest(hook({ type: 'turn.finished', backgroundTasks: 0 }));
    await c.close();
    expect(store.recentEvents('S1').map((e) => e.type)).toEqual(['prompt', 'turn.finished']);
    expect(store.loadSessions()[0]).toMatchObject({ lastAnswer: 'All green: 42 tests pass.', lastAnswerAt: NOW, lastPromptAt: NOW });
    store.close();
  });

  it('restores subagents as not running, and a meeting only they held as done since it began', async () => {
    const store = await Store.open(':memory:');
    const child = { id: 'a1', type: 'Explore', description: 'Find callers', running: true, lastAction: 'Grep useCart', updatedAt: NOW - 5000 };
    store.saveSessions([{ ...newSession('S1', NOW - 9000, { cwd: '/w/x', repoRoot: '/w/x', repoName: 'x', worktree: false, branch: 'main' }), state: 'in_meeting', children: [child] }], NOW);
    expect(collector({ store }).view('S1')).toMatchObject({ state: 'done', stateSince: NOW - 9000, seenAt: null, children: [{ ...child, running: false }] });
    store.close();
  });

  it('ends the sessions it restored from a session file that nothing has reported since and whose process is gone, as of their last event', async () => {
    const store = await Store.open(':memory:');
    const a = collector({ store });
    const ws = (cwd: string) => ({ cwd, repoRoot: cwd, repoName: basename(cwd), worktree: false, branch: 'main' });
    const seen = (sessionId: string, cwd: string, ts: number, pid: number) => ({ type: 'session.seen', sessionId, ts, source: 'fs', cwd, workspace: ws(cwd), pid, name: null, tmuxPane: null, tmuxSession: null, transcriptPath: null, startedAt: ts }) as RawEvent;
    await a.ingest(seen('A1', '/w/alpha', NOW, 101));
    await a.ingest(seen('B1', '/w/beta', NOW + 10, 102));
    await a.ingest(seen('C1', '/w/gamma', NOW + 20, 103));
    await a.ingest(hook({ type: 'prompt', text: 'h', sessionId: 'H1', cwd: '/w/hooks', ts: NOW + 25 }));
    await a.close();
    store.saveSessions([{ ...newSession('R1', NOW, { cwd: '/w/delta', repoRoot: '/w/delta', repoName: 'delta', worktree: false, branch: 'main' }), location: 'cloud', state: 'working' }], NOW);

    const b = collector({ store });
    await b.ingest(hook({ type: 'prompt', text: 'c again', sessionId: 'C1', cwd: '/w/gamma', ts: NOW + 30 }));
    b.endGone(new Set(['B1']));
    await b.idle();
    expect(b.view('A1')).toMatchObject({ state: 'ended', stateSince: NOW });
    expect(b.view('H1')).toMatchObject({ state: 'working' });
    expect(b.liveViews().map((v) => v.id)).toEqual(['B1', 'C1', 'H1', 'R1']);
    b.endGone(new Set());
    await b.idle();
    expect(b.liveViews().map((v) => v.id)).toEqual(['B1', 'C1', 'H1', 'R1']);
    await b.close();
    store.close();
  });

  it('keeps the subagents that ran in the sessions it restored from a session file running until the first scan has looked, then stops those nothing reported on', async () => {
    const store = await Store.open(':memory:');
    const ws = (cwd: string) => ({ cwd, repoRoot: cwd, repoName: basename(cwd), worktree: false, branch: 'main' });
    const child = (id: string, updatedAt: number) => ({ id, type: 'Explore', description: null, running: true, lastAction: null, updatedAt });
    const meeting = (id: string, cwd: string, pid: number | null, children: Session['children']): Session => ({
      ...newSession(id, NOW - 9000, ws(cwd)), pid, state: 'in_meeting', stateSince: NOW - 5000, lastEventAt: NOW - 5000, children,
    });
    store.saveSessions([
      meeting('A1', '/w/alpha', 101, [child('a1', NOW - 4000), child('a2', NOW - 3000)]),
      meeting('B1', '/w/beta', 102, [child('b1', NOW - 4000)]),
      meeting('H1', '/w/hooks', null, [child('h1', NOW - 4000)]),
    ], NOW);
    const c = collector({ store, holdRestored: true });
    const shown = () => ['A1', 'B1', 'H1'].map((id) => {
      const s = c.session(id)!;
      return [id, s.state, s.stateSince, s.children.map((x) => [x.id, x.running, x.restored ?? false])];
    });
    // A session only hooks reported on settles now, as before: no scan will look at it.
    expect(shown()).toEqual([
      ['A1', 'in_meeting', NOW - 5000, [['a1', true, true], ['a2', true, true]]],
      ['B1', 'in_meeting', NOW - 5000, [['b1', true, true]]],
      ['H1', 'done', NOW - 5000, [['h1', false, true]]],
    ]);
    // The first scan finds a1's transcript, last written when the store last heard of it, and nothing of a2 or b1. The
    // settling comes after every event ingested before it, even one still waiting for its session's workspace.
    void c.ingest(hook({ type: 'prompt', text: 'go', sessionId: 'N1', cwd: '/w/new' }));
    void c.ingest({ type: 'agent.started', sessionId: 'A1', ts: NOW - 4000, source: 'fs', cwd: '/w/alpha', agentId: 'a1', agentType: 'Explore', description: null });
    await c.settleRestored();
    expect(shown()).toEqual([
      ['A1', 'in_meeting', NOW - 5000, [['a1', true, false], ['a2', false, true]]],
      ['B1', 'done', NOW - 5000, [['b1', false, true]]],
      ['H1', 'done', NOW - 5000, [['h1', false, true]]],
    ]);
    expect(c.session('B1')!.seenAt).toBeNull();
    await c.close();
    store.close();
  });
});

describe('floor order', () => {
  it('keeps floors in place across a restart, even when a floor\'s oldest session ends', async () => {
    const store = await Store.open(':memory:');
    const a = collector({ store });
    await a.ingest(hook({ type: 'prompt', text: 'a', sessionId: 'A1', cwd: '/w/alpha', ts: NOW }));
    await a.ingest(hook({ type: 'prompt', text: 'b', sessionId: 'B1', cwd: '/w/beta', ts: NOW + 10 }));
    await a.ingest(hook({ type: 'prompt', text: 'a', sessionId: 'A2', cwd: '/w/alpha', ts: NOW + 20 }));
    await a.ingest(hook({ type: 'session.ended', reason: 'exit', sessionId: 'A1', cwd: '/w/alpha', ts: NOW + 30 }));
    expect(a.snapshot().floors.map((f) => [f.key, f.openedAt])).toEqual([['repo:/w/beta', NOW + 10], ['repo:/w/alpha', NOW]]);
    await a.close();

    const b = collector({ store });
    expect(b.snapshot().floors.map((f) => f.key)).toEqual(['repo:/w/beta', 'repo:/w/alpha']);
    await b.ingest(hook({ type: 'prompt', text: 'c', sessionId: 'C1', cwd: '/w/gamma', ts: NOW + 40 }));
    expect(b.snapshot().floors.map((f) => f.key)).toEqual(['repo:/w/gamma', 'repo:/w/beta', 'repo:/w/alpha']);
    await b.close();
    store.close();
  });

  it('opens the floor of a session that moves to a new feature branch when it moved, on top', async () => {
    const c = collector();
    await c.ingest(hook({ type: 'prompt', text: 'a', sessionId: 'A1', cwd: '/w/alpha', ts: NOW }));
    await c.ingest(hook({ type: 'prompt', text: 'b', sessionId: 'B1', cwd: '/w/beta', ts: NOW + 10 }));
    await c.ingest(hook({ type: 'branch', branch: 'feat/late-idea', sessionId: 'A1', cwd: '/w/alpha', ts: NOW + 50 }));
    expect(c.snapshot().floors.map((f) => [f.key, f.openedAt])).toEqual([['feature:late-idea', NOW + 50], ['repo:/w/beta', NOW + 10]]);
  });

  it('forgets a floor once its last session ends, so that it opens on top when it comes back, across a restart', async () => {
    const store = await Store.open(':memory:');
    const a = collector({ store });
    await a.ingest(hook({ type: 'prompt', text: 'a', sessionId: 'A1', cwd: '/w/alpha', ts: NOW }));
    await a.ingest(hook({ type: 'prompt', text: 'b', sessionId: 'B1', cwd: '/w/beta', ts: NOW + 10 }));
    await a.ingest(hook({ type: 'session.ended', reason: 'exit', sessionId: 'A1', cwd: '/w/alpha', ts: NOW + 20 }));
    a.flush();
    expect(store.loadFloors()).toEqual(new Map([['repo:/w/beta', { firstSeen: NOW + 10, plan: null }]]));
    await a.ingest(hook({ type: 'prompt', text: 'a', sessionId: 'A2', cwd: '/w/alpha', ts: NOW + 30 }));
    expect(a.snapshot().floors.map((f) => [f.key, f.openedAt])).toEqual([['repo:/w/alpha', NOW + 30], ['repo:/w/beta', NOW + 10]]);
    await a.close();

    const b = collector({ store });
    expect(b.snapshot().floors.map((f) => [f.key, f.openedAt])).toEqual([['repo:/w/alpha', NOW + 30], ['repo:/w/beta', NOW + 10]]);
    await b.close();
    store.close();
  });

  it('saves a floor that closed and reopened since the last save at its new time', async () => {
    const store = await Store.open(':memory:');
    const c = collector({ store, saveDelayMs: 60_000 });
    await c.ingest(hook({ type: 'prompt', text: 'a', sessionId: 'A1', cwd: '/w/alpha', ts: NOW }));
    await c.ingest(hook({ type: 'prompt', text: 'b', sessionId: 'B1', cwd: '/w/beta', ts: NOW + 10 }));
    c.flush();
    await c.ingest(hook({ type: 'session.ended', reason: 'exit', sessionId: 'A1', cwd: '/w/alpha', ts: NOW + 20 }));
    await c.ingest(hook({ type: 'prompt', text: 'a', sessionId: 'A2', cwd: '/w/alpha', ts: NOW + 30 }));
    await c.close();
    expect(store.loadFloors()).toEqual(new Map([['repo:/w/alpha', { firstSeen: NOW + 30, plan: null }], ['repo:/w/beta', { firstSeen: NOW + 10, plan: null }]]));
    store.close();
  });

  it('forgets the floor a session leaves for another branch', async () => {
    const store = await Store.open(':memory:');
    const c = collector({ store });
    await c.ingest(hook({ type: 'prompt', text: 'a', sessionId: 'A1', cwd: '/w/alpha', ts: NOW }));
    await c.ingest(hook({ type: 'branch', branch: 'feat/late-idea', sessionId: 'A1', cwd: '/w/alpha', ts: NOW + 50 }));
    await c.close();
    expect(store.loadFloors()).toEqual(new Map([['feature:late-idea', { firstSeen: NOW + 50, plan: null }]]));
    store.close();
  });

  it('keeps a floor in place while a dormant session still sits on it', async () => {
    let now = NOW + 1000;
    const c = collector({ now: () => now });
    await c.ingest(hook({ type: 'turn.finished', backgroundTasks: 0, sessionId: 'A1', cwd: '/w/alpha', ts: NOW }));
    await c.ingest(hook({ type: 'prompt', text: 'b', sessionId: 'B1', cwd: '/w/beta', ts: NOW + 10 }));
    await c.ingest(hook({ type: 'prompt', text: 'a', sessionId: 'A2', cwd: '/w/alpha', ts: NOW + 20 }));
    now = NOW + 30 * 24 * 60 * 60 * 1000;
    await c.ingest(hook({ type: 'session.ended', reason: 'exit', sessionId: 'A2', cwd: '/w/alpha', ts: now }));
    expect(c.view('A1')!.effectiveState).toBe('dormant');
    expect(c.snapshot().floors.map((f) => [f.key, f.openedAt])).toEqual([['repo:/w/beta', NOW + 10], ['repo:/w/alpha', NOW]]);
  });

  it('forgets at start the floors no session sits on any more', async () => {
    const store = await Store.open(':memory:');
    const ws = (cwd: string) => ({ cwd, repoRoot: cwd, repoName: basename(cwd), worktree: false, branch: 'main' });
    const at = (firstSeen: number) => ({ firstSeen, plan: null });
    store.save([newSession('A1', 50, ws('/w/alpha')), { ...newSession('G1', 5, ws('/w/gamma')), state: 'ended' }], new Map([['repo:/w/alpha', at(40)], ['repo:/w/gamma', at(5)], ['repo:/w/gone', at(30)]]), 1);
    const c = collector({ store });
    expect(c.snapshot().floors.map((f) => [f.key, f.openedAt])).toEqual([['repo:/w/alpha', 40]]);
    await c.close();
    expect(store.loadFloors()).toEqual(new Map([['repo:/w/alpha', at(40)]]));
    store.close();
  });

  it('opens each floor at its earliest live start over sessions saved before floors were recorded', async () => {
    const store = await Store.open(':memory:');
    const ws = (cwd: string) => ({ cwd, repoRoot: cwd, repoName: basename(cwd), worktree: false, branch: 'main' });
    store.saveSessions([
      newSession('A1', 100, ws('/w/alpha')),
      newSession('A2', 50, ws('/w/alpha')),
      newSession('B1', 70, ws('/w/beta')),
      { ...newSession('A0', 10, ws('/w/alpha')), state: 'ended' },
      { ...newSession('G1', 5, ws('/w/gamma')), state: 'ended' },
    ], 1);
    const c = collector({ store });
    expect(c.snapshot().floors.map((f) => [f.key, f.openedAt])).toEqual([['repo:/w/beta', 70], ['repo:/w/alpha', 50]]);
    await c.close();
    expect(store.loadFloors()).toEqual(new Map([['repo:/w/alpha', { firstSeen: 50, plan: null }], ['repo:/w/beta', { firstSeen: 70, plan: null }]]));
    store.close();
  });
});

describe('scene', () => {
  it('draws the demo building from ingested events, and keeps its floors in place as the demo plays', async () => {
    const base = 1_000_000_000;
    let now = base;
    const c = new Collector({ resolveWorkspace: async () => { throw new Error('demo events carry their workspace'); }, now: () => now, acceptSources: ['demo'], saveDelayMs: 0 });
    const steps = demoScript();
    for (const e of steps[0]!.events(base)) await c.ingest(e);
    now = base + 100;

    const scene = c.scene();
    expect(scene.floors.map((f) => [f.number, f.key, f.windows.length])).toEqual([
      [3, 'feature:checkout-v2', 4],
      [2, 'feature:search-ranking', 1],
      [1, 'repo:/demo/orders-api', 2],
    ]);
    expect(scene.attention.needsYou.map((e) => [e.sessionId, e.floorKey, e.focusable])).toEqual([
      ['demo-oa-c3', 'feature:checkout-v2', true],
      ['demo-oa-g7', 'repo:/demo/orders-api', true],
    ]);
    expect(c.floor('feature:checkout-v2')!.pods.map((p) => p.desks.map((d) => d.occupant?.sessionId ?? null))).toEqual([
      ['demo-ps-d4', 'demo-sw-b2', 'demo-sw-a1', null],
      ['demo-oa-c3', null, null, null],
    ]);
    expect(c.floor('feature:nope')).toBeNull();

    const opened = scene.floors.map((f) => f.openedAt);
    for (const step of steps.slice(1)) {
      now = base + step.at;
      for (const e of step.events(now)) await c.ingest(e);
    }
    now = base + 59_000;
    expect(c.scene().floors.map((f) => f.openedAt)).toEqual(opened);
    expect(c.scene().attention.needsYou.map((e) => e.sessionId)).toEqual(['demo-sw-a1']);
  });

  it('renders the building and its floors from one reading of the clock', async () => {
    let reads = 0;
    const before = NOW + 4 * 60 * 60 * 1000 - 1;
    const c = collector({ now: () => (reads++ === 0 ? before : before + 2) });
    await c.ingest(hook({ type: 'turn.finished', backgroundTasks: 0 }));
    reads = 0;
    const { scene, floors } = c.render(['repo:/w/orders-api', 'repo:/w/nowhere']);
    expect(reads).toBe(1);
    expect(scene.attention.done.map((e) => e.sessionId)).toEqual(['S1']);
    expect(floors.get('repo:/w/orders-api')!.islands[0]!.desks[0]!.state).toBe('done');
    expect(floors.get('repo:/w/nowhere')).toBeNull();
    expect([...floors.keys()]).toEqual(['repo:/w/orders-api', 'repo:/w/nowhere']);
  });

  it('reports an ended session by id, and leaves it out of the building', async () => {
    const c = collector();
    await c.ingest(hook({ type: 'prompt', text: 'go' }));
    await c.ingest(hook({ type: 'prompt', text: 'go', sessionId: 'S2', cwd: '/w/search-svc' }));
    await c.ingest(hook({ type: 'session.ended', reason: 'exit', ts: NOW + 1 }));
    expect(c.view('S1')).toMatchObject({ id: 'S1', effectiveState: 'ended' });
    expect(c.view('nope')).toBeNull();
    expect(c.liveViews().map((v) => v.id)).toEqual(['S2']);
    expect(c.scene().floors.map((f) => f.key)).toEqual(['repo:/w/search-svc']);
    expect(c.floor('repo:/w/orders-api')).toBeNull();
    expect(c.floor('repo:/w/search-svc')!.islands[0]!.desks.map((d) => d.sessionId)).toEqual(['S2']);
  });
});

describe('the collector and the summarizer', () => {
  const SUMMARY = { text: 'Done: the form works.', at: NOW + 2, inputHash: '0123456789abcdef' };

  it('gives a session as it holds it, ended or not, and null for an unknown one', async () => {
    const c = collector();
    await c.ingest(hook({ type: 'prompt', text: 'go' }));
    await c.ingest(hook({ type: 'session.ended', reason: 'exit', ts: NOW + 1 }));
    expect(c.session('S1')).toMatchObject({ id: 'S1', state: 'ended', lastPrompt: 'go' });
    expect(c.session('S9')).toBeNull();
  });

  it('tells session listeners the stored and the new value of each change, until they unsubscribe', async () => {
    const c = collector();
    const calls: [Session | undefined, Session][] = [];
    const off = c.onSessionChange((prev, next) => calls.push([prev, next]));
    await c.ingest(hook({ type: 'prompt', text: 'go' }));
    await c.ingest(hook({ type: 'turn.finished', backgroundTasks: 0, ts: NOW + 1 }));
    await c.ingest(hook({ type: 'tool.finished', toolId: 't0', ok: true, agentId: null, ts: NOW - 5 }));
    expect(c.setSummary('S1', SUMMARY)).toBe(true);
    off();
    await c.ingest(hook({ type: 'prompt', text: 'again', ts: NOW + 3 }));
    expect(calls.map(([prev, next]) => [prev?.state ?? null, next.state, next.summary])).toEqual([
      [null, 'working', null],
      ['working', 'done', null],
      ['done', 'done', SUMMARY],
    ]);
    expect(calls[1]![0]).toBe(calls[0]![1]);
    expect(calls[2]![0]).toBe(calls[1]![1]);
  });

  it('stores a summary with no event and saves it with the session, for known sessions only', async () => {
    const store = await Store.open(':memory:');
    const c = collector({ store });
    await c.ingest(hook({ type: 'turn.finished', backgroundTasks: 0 }));
    const changes = vi.fn();
    c.onChange(changes);
    expect(c.setSummary('S9', SUMMARY)).toBe(false);
    expect(changes).not.toHaveBeenCalled();
    expect(c.setSummary('S1', SUMMARY)).toBe(true);
    expect(changes).toHaveBeenCalledTimes(1);
    await c.close();
    expect(store.recentEvents('S1').map((e) => e.type)).toEqual(['turn.finished']);
    expect(collector({ store }).session('S1')!.summary).toEqual(SUMMARY);
    store.close();
  });

  it('keeps going when a session listener throws', async () => {
    const log = vi.fn();
    const c = collector({ log });
    const later = vi.fn();
    c.onSessionChange(() => {
      throw new Error('boom');
    });
    c.onSessionChange(later);
    await c.ingest(hook({ type: 'prompt', text: 'go' }));
    expect([later.mock.calls.length, c.dropped, c.session('S1')?.lastPrompt]).toEqual([1, 0, 'go']);
    expect(log).toHaveBeenCalledWith('scranton-hq session listener failed: boom');
  });

  it('drops and counts the events of an ignored working directory before they are ordered', async () => {
    const dir = '/home/dev/.scranton-hq/summarizer';
    const c = collector({ ignoreCwd: (cwd) => cwd === dir || cwd.startsWith(dir + '/') });
    await c.ingest(hook({ type: 'prompt', text: 'Summarize', sessionId: 'X1', cwd: dir }));
    await c.ingest(hook({ type: 'turn.finished', backgroundTasks: 0, sessionId: 'X1', cwd: `${dir}/sub` }));
    await c.ingest(hook({ type: 'prompt', text: 'go', cwd: `${dir}-other` }));
    expect([c.ignored, c.dropped]).toEqual([2, 0]);
    expect(c.session('X1')).toBeNull();
    expect(c.session('S1')).toMatchObject({ lastPrompt: 'go', lastSeq: 0 });
  });
});

describe('seating', () => {
  const KEY = 'repo:/w/alpha';
  const ws = { cwd: '/w/alpha', repoRoot: '/w/alpha', repoName: 'alpha', worktree: false, branch: 'main' };
  const prompt = (sessionId: string, ts = NOW) => hook({ type: 'prompt', text: 'go', sessionId, cwd: '/w/alpha', ts });
  /** The desks of a one-block plan, the given ids first. */
  const desks = (...ids: string[]) => [...ids, ...Array<null>(8 - ids.length).fill(null)];

  it('seats a floor at its first scene read and saves it with the floor, telling no change listener, and reading again changes nothing', async () => {
    vi.useFakeTimers();
    try {
      const store = await Store.open(':memory:');
      const c = collector({ store, saveDelayMs: 10 });
      await c.ingest(prompt('A1'));
      await c.ingest(prompt('A2', NOW + 1));
      vi.advanceTimersByTime(10);
      // Neither the snapshot nor the attention summary seats anybody.
      c.snapshot();
      c.attentionSummary();
      expect([c.seatingOf(KEY), store.loadFloors().get(KEY)]).toEqual([null, { firstSeen: NOW, plan: null }]);

      const changes = vi.fn();
      c.onChange(changes);
      c.scene();
      const seated = c.seatingOf(KEY)!;
      expect(seated).toEqual({ ...emptySeating(), desks: desks('A1', 'A2') });
      expect(changes).not.toHaveBeenCalled();
      vi.advanceTimersByTime(10);
      expect(store.loadFloors().get(KEY)).toEqual({ firstSeen: NOW, plan: JSON.stringify(seated) });

      const save = vi.spyOn(store, 'save');
      c.floor(KEY);
      c.render([KEY, 'repo:/w/nowhere']);
      c.scene();
      vi.advanceTimersByTime(10);
      expect([c.seatingOf(KEY) === seated, save.mock.calls.length]).toEqual([true, 0]);
      store.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('draws each floor it reads from the seating it keeps: a desk stays with its session while others come and go', async () => {
    const c = collector();
    for (let i = 1; i <= 3; i++) await c.ingest(prompt(`A${i}`, NOW + i));
    c.scene();
    await c.ingest(hook({ type: 'session.ended', reason: 'exit', sessionId: 'A1', cwd: '/w/alpha', ts: NOW + 10 }));
    await c.ingest(prompt('A4', NOW + 11));
    const sitting = (floor: FloorDetail | null | undefined) => floor!.pods[0]!.desks.map((d) => d.occupant?.sessionId ?? null);
    expect(sitting(c.floor(KEY))).toEqual(['A4', 'A2', 'A3', null]);
    expect(sitting(c.render([KEY]).floors.get(KEY))).toEqual(['A4', 'A2', 'A3', null]);
    expect(c.seatingOf(KEY)!.desks).toEqual(desks('A4', 'A2', 'A3'));
  });

  it('moves seating on at every scene read: render, floor and scene', async () => {
    const c = collector();
    await c.ingest(prompt('A1'));
    c.render([]);
    expect(c.seatingOf(KEY)!.desks).toEqual(desks('A1'));
    await c.ingest(prompt('A2', NOW + 1));
    c.floor('repo:/w/nowhere');
    expect(c.seatingOf(KEY)!.desks).toEqual(desks('A1', 'A2'));
    await c.ingest(prompt('A3', NOW + 2));
    c.scene();
    expect(c.seatingOf(KEY)!.desks).toEqual(desks('A1', 'A2', 'A3'));
  });

  it('keeps every seat across a restart: desks, a lounge sitter, rooms and the plan size', async () => {
    const store = await Store.open(':memory:');
    const a = collector({ store });
    for (let i = 1; i <= 9; i++) await a.ingest(prompt(`A${i}`, NOW + i));
    // A9 is done and seen: idle, it rests in the lounge. A1 runs a workflow: it holds a room.
    await a.ingest(hook({ type: 'turn.finished', backgroundTasks: 0, sessionId: 'A9', cwd: '/w/alpha', ts: NOW + 20 }));
    expect(a.markSeen('A9')).toBe(true);
    await a.ingest({ type: 'workflow.started', runId: 'wf_0000aaaa-001', sessionId: 'A1', ts: NOW + 30, source: 'fs', cwd: '/w/alpha' });
    a.scene();
    const seated = a.seatingOf(KEY)!;
    expect(seated).toEqual({
      blocks: 2,
      roomCols: 1,
      desks: [...['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9'], ...Array(7).fill(null)],
      lounge: ['A9', ...Array(7).fill(null)],
      rooms: ['wf_0000aaaa-001', null],
    });
    await a.close();

    const b = collector({ store });
    const restored = b.seatingOf(KEY);
    expect(restored).toEqual(seated);
    b.scene();
    expect(b.seatingOf(KEY)).toBe(restored);
    store.close();
  });

  it('seats a floor again at its first read when its stored seating does not read back', async () => {
    const store = await Store.open(':memory:');
    store.save([{ ...newSession('A1', 50, ws), state: 'working' }], new Map([[KEY, { firstSeen: 40, plan: JSON.stringify({ ...emptySeating(), blocks: 9 }) }]]), 1);
    const c = collector({ store });
    expect(c.seatingOf(KEY)).toBeNull();
    c.scene();
    expect(c.seatingOf(KEY)).toEqual({ ...emptySeating(), desks: desks('A1') });
    await c.close();
    expect(parseSeating(store.loadFloors().get(KEY)!.plan!)).toEqual(c.seatingOf(KEY));
    store.close();
  });

  it('opens at the base plan a floor whose sessions all ended while it was down', async () => {
    const store = await Store.open(':memory:');
    const grown = { ...emptySeating(), blocks: 2, roomCols: 2, desks: ['A1', ...Array(15).fill(null)], rooms: [null, null, null, null] };
    store.save([{ ...newSession('A1', 50, ws), state: 'ended' }], new Map([[KEY, { firstSeen: 40, plan: JSON.stringify(grown) }]]), 1);
    const c = collector({ store });
    expect(c.seatingOf(KEY)).toBeNull();
    c.flush();
    expect(store.loadFloors()).toEqual(new Map());
    await c.ingest(prompt('A2'));
    c.scene();
    expect(c.seatingOf(KEY)).toEqual({ ...emptySeating(), desks: desks('A2') });
    await c.close();
    store.close();
  });

  it('forgets a floor\'s seating with the floor, so that it reopens at the base plan', async () => {
    const store = await Store.open(':memory:');
    const c = collector({ store });
    for (let i = 1; i <= 9; i++) await c.ingest(prompt(`A${i}`, NOW + i));
    c.scene();
    expect(c.seatingOf(KEY)!.blocks).toBe(2);
    for (let i = 1; i <= 9; i++) await c.ingest(hook({ type: 'session.ended', reason: 'exit', sessionId: `A${i}`, cwd: '/w/alpha', ts: NOW + 20 }));
    expect(c.seatingOf(KEY)).toBeNull();
    c.flush();
    expect(store.loadFloors().has(KEY)).toBe(false);
    await c.ingest(prompt('B1', NOW + 30));
    c.scene();
    expect(c.seatingOf(KEY)).toEqual({ ...emptySeating(), desks: desks('B1') });
    await c.close();
    store.close();
  });

  it('moves a session that went dormant with time out of the lounge at the next scene read, and not before', async () => {
    let now = NOW + 1000;
    const c = collector({ now: () => now });
    await c.ingest(prompt('A1'));
    await c.ingest(hook({ type: 'turn.finished', backgroundTasks: 0, sessionId: 'A1', cwd: '/w/alpha', ts: NOW + 1 }));
    expect(c.markSeen('A1')).toBe(true);
    await c.ingest(prompt('A2', NOW + 2));
    c.scene();
    const resting = c.seatingOf(KEY)!;
    expect([resting.desks, resting.lounge]).toEqual([desks('A1', 'A2'), desks('A1')]);

    now += 3 * 24 * 60 * 60 * 1000;
    expect(c.view('A1')!.effectiveState).toBe('dormant');
    c.snapshot();
    c.attentionSummary();
    expect(c.seatingOf(KEY)).toBe(resting);
    c.floor(KEY);
    // Dormant, it keeps its desk.
    expect([c.seatingOf(KEY)!.desks, c.seatingOf(KEY)!.lounge]).toEqual([desks('A1', 'A2'), desks()]);
  });
});
