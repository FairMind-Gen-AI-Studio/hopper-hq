import { describe, expect, it, vi } from 'vitest';
import { basename } from 'node:path';
import type { WorkspaceResolver } from '../src/adapters/git.js';
import { Collector } from '../src/collector.js';
import { newSession } from '../src/core/reducer.js';
import type { RawEvent, Session } from '../src/core/types.js';
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
      items: [{ id: 'S1', name: null, repo: 'orders-api', feature: null, state: 'needs_you', since: NOW, reason: { kind: 'permission', text: 'Bash', detail: 'Bash: rm -rf dist' }, title: null, tmuxPane: null }],
    });
  });

  it('cleans names, titles and reasons in the attention summary', async () => {
    const c = collector();
    await c.ingest(hook({ type: 'session.seen', workspace: { cwd: '/w/orders-api', repoRoot: '/w/orders-api', repoName: 'orders-api', worktree: false, branch: 'main' }, name: 'orders\u001b[31m-api\u0007' }));
    await c.ingest(hook({ type: 'title', title: '\u202EFix\r\nthe build' }));
    await c.ingest(hook({ type: 'waiting', reason: { kind: 'permission', text: 'Bash\u0000', detail: 'Bash: rm\u001b[2K -rf dist' }, agentId: null }));
    expect(c.attentionSummary().items[0]).toEqual({
      id: 'S1', name: 'orders[31m-api', repo: 'orders-api', feature: null, state: 'needs_you', since: NOW,
      reason: { kind: 'permission', text: 'Bash', detail: 'Bash: rm[2K -rf dist' }, title: 'Fix the build', tmuxPane: null,
    });
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
        recordFloors: () => {},
        appendEvent: () => {},
        saveSessions: (list: Session[]) => {
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
      expect(log).toHaveBeenCalledWith('scranton-hq could not save sessions: database is locked');
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
    expect(store.loadFloors()).toEqual(new Map([['repo:/w/alpha', 50], ['repo:/w/beta', 70]]));
    store.close();
  });
});
