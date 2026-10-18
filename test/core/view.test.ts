import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS as T } from '../../src/config.js';
import { newSession } from '../../src/core/reducer.js';
import type { Session, SessionState, WorkflowRun } from '../../src/core/types.js';
import { buildAttention, buildFloors, byCodeUnit, effectiveState, floorKeyOf, islandKeyOf, toView } from '../../src/core/view.js';
import { KEY_MAX } from '../../src/scene/text.js';
import { WS } from '../helpers/events.js';

const H = 60 * 60 * 1000;
function sess(id: string, state: SessionState, stateSince: number, extra: Partial<Session> = {}): Session {
  return { ...newSession(id, 0, WS), state, stateSince, lastEventAt: stateSince, ...extra };
}

describe('effectiveState', () => {
  it('expires finished Codex desks after four hours of inactivity without changing their stored state', () => {
    for (const state of ['done', 'idle', 'dormant'] as const) {
      const s = sess('codex-a', state, 100, { agentKind: 'codex', seenAt: 200 });
      expect(effectiveState(s, 4 * H + 99).state).not.toBe('ended');
      expect(effectiveState(s, 4 * H + 100)).toEqual({ state: 'ended', since: 4 * H + 100 });
      expect(s.state).toBe(state);
    }
  });

  it('keeps Codex work and waits visible and bases expiry on the latest activity', () => {
    for (const state of ['working', 'no_signal', 'needs_you', 'in_meeting'] as const) {
      expect(effectiveState(sess('codex-a', state, 0, { agentKind: 'codex' }), 8 * H).state).not.toBe('ended');
    }
    const s = sess('codex-a', 'done', 0, { agentKind: 'codex', lastEventAt: 3 * H });
    expect(effectiveState(s, 4 * H).state).not.toBe('ended');
    expect(effectiveState(s, 7 * H)).toEqual({ state: 'ended', since: 7 * H });
  });

  it('turns done into idle after the threshold or once seen', () => {
    expect(effectiveState(sess('a', 'done', 0), 4 * H - 1, T)).toEqual({ state: 'done', since: 0 });
    expect(effectiveState(sess('a', 'done', 0), 4 * H, T)).toEqual({ state: 'idle', since: 4 * H });
    expect(effectiveState(sess('a', 'done', 0, { seenAt: 10 }), 20, T)).toEqual({ state: 'idle', since: 10 });
    // seen before the current done started does not count
    expect(effectiveState(sess('a', 'done', 100, { seenAt: 10 }), 200, T).state).toBe('done');
  });

  it('turns idle into dormant after three days', () => {
    expect(effectiveState(sess('a', 'idle', 0), 3 * 24 * H, T)).toEqual({ state: 'dormant', since: 3 * 24 * H });
    expect(effectiveState(sess('a', 'done', 0), 4 * H + 3 * 24 * H, T).state).toBe('dormant');
  });

  it('turns quiet work into no_signal, counting subagent activity', () => {
    expect(effectiveState(sess('a', 'working', 0), 10 * 60 * 1000, T)).toEqual({ state: 'no_signal', since: 10 * 60 * 1000 });
    const busyChild = sess('a', 'working', 0, { children: [{ id: 'c', type: 'Explore', description: null, running: true, lastAction: null, updatedAt: 9 * 60 * 1000 }] });
    expect(effectiveState(busyChild, 10 * 60 * 1000, T).state).toBe('working');
  });

  it('counts the steps of a running workflow agent too, and not those of one that finished', () => {
    const MIN = 60 * 1000;
    const run = (running: boolean): WorkflowRun => ({
      id: 'wf_0000aaaa-001', name: null, summary: null, phases: [], currentPhase: null, status: 'running', onDisk: true, startedAt: 0, endedAt: null,
      agents: [{ id: 'w1', label: null, phase: null, type: 'workflow-subagent', running, startedAt: 0, updatedAt: 9 * MIN }], agentsFinished: running ? 0 : 1,
    });
    expect(effectiveState(sess('a', 'working', 0, { runs: [run(true)] }), 10 * MIN, T).state).toBe('working');
    expect(effectiveState(sess('a', 'working', 0, { runs: [run(true)] }), 19 * MIN, T)).toEqual({ state: 'no_signal', since: 19 * MIN });
    expect(effectiveState(sess('a', 'working', 0, { runs: [run(false)] }), 10 * MIN, T)).toEqual({ state: 'no_signal', since: 10 * MIN });
  });

  it('leaves other states alone', () => {
    for (const st of ['needs_you', 'in_meeting', 'ended'] as const) {
      expect(effectiveState(sess('a', st, 0), 999 * H, T).state).toBe(st);
    }
  });
});

describe('buildFloors', () => {
  const now = 10 * H;
  const v = (id: string, repoName: string, branch: string | null, state: SessionState, startedAt: number) =>
    toView({ ...sess(id, state, now - 1), startedAt, workspace: { ...WS, repoName, branch } }, now);

  it("orders a floor's sessions by repo in code-unit order, then by start, then by id, whatever the input order", () => {
    const views = [v('B', 'web', 'feat/x', 'working', 5), v('A', 'web', 'feat/x', 'working', 5), v('C', 'Web', 'feat/x', 'working', 9), v('D', 'api', 'feat/x', 'working', 1)];
    for (const input of [views, [...views].reverse()]) {
      expect(buildFloors(input)[0]!.sessions.map((s) => s.id)).toEqual(['C', 'D', 'A', 'B']);
    }
  });

  it('groups by feature across repos and by repo for trunk work, newest floor first', () => {
    const floors = buildFloors([
      v('a', 'storefront-web', 'feat/checkout-v2', 'working', 100),
      v('b', 'orders-api', 'feat/checkout-v2', 'needs_you', 50),
      v('c', 'orders-api', 'main', 'done', 300),
      v('d', 'orders-api', 'main', 'ended', 400),
    ]);
    expect(floors.map((f) => [f.key, f.kind, f.name, f.repos])).toEqual([
      ['repo:/home/dev/shop/orders-api', 'department', 'orders-api', ['orders-api']],
      ['feature:checkout-v2', 'feature', 'checkout-v2', ['orders-api', 'storefront-web']],
    ]);
    expect(floors[1]!.counts).toEqual({ working: 1, needs_you: 1 });
    expect(floors[1]!.sessions.map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('marks a floor dormant only when every session on it is dormant', () => {
    const old = toView({ ...sess('x', 'idle', 0), workspace: { ...WS, branch: 'feat/docs' } }, 4 * 24 * H);
    const fresh = toView({ ...sess('y', 'working', 4 * 24 * H), workspace: { ...WS, branch: 'feat/docs' } }, 4 * 24 * H);
    expect(buildFloors([old])[0]!.dormant).toBe(true);
    expect(buildFloors([old, fresh])[0]!.dormant).toBe(false);
  });
});

describe('floor and island keys', () => {
  const now = 10 * H;
  const at = (id: string, cwd: string, branch: string | null, extra: Partial<Session['workspace']> = {}) =>
    toView({ ...sess(id, 'working', now - 1), workspace: { cwd, repoRoot: cwd, repoName: cwd.split('/').pop()!, worktree: false, branch, root: cwd, ...extra } }, now);

  it('keys department floors by repository root, so two repos with one name get two floors', () => {
    const floors = buildFloors([at('a', '/home/dev/work/api', 'main'), at('b', '/home/dev/oss/api', 'main'), at('c', '/home/dev/web', 'main')]);
    expect(floors.map((f) => [f.key, f.name]).sort()).toEqual([
      ['repo:/home/dev/oss/api', 'api (oss)'],
      ['repo:/home/dev/web', 'web'],
      ['repo:/home/dev/work/api', 'api (work)'],
    ]);
  });

  it('keys feature floors by feature, and a directory outside git by its path', () => {
    expect(floorKeyOf(at('a', '/home/dev/web', 'feat/checkout-v2'))).toBe('feature:checkout-v2');
    expect(floorKeyOf(at('b', '/tmp/scratch', null, { repoRoot: null, root: null }))).toBe('repo:/tmp/scratch');
  });

  it('keys islands by worktree root, falling back to cwd for rows saved without one', () => {
    expect(islandKeyOf(at('a', '/home/dev/api/src', 'main', { repoRoot: '/home/dev/api', root: '/home/dev/api' }))).toBe('/home/dev/api');
    expect(islandKeyOf(at('b', '/home/dev/api-wt', 'feat/x', { repoRoot: '/home/dev/api', worktree: true }))).toBe('/home/dev/api-wt');
    const old = at('c', '/home/dev/api/src', 'main', { repoRoot: '/home/dev/api' });
    delete old.workspace.root;
    expect(islandKeyOf(old)).toBe('/home/dev/api/src');
  });

  it('cleans keys and caps them at KEY_MAX', () => {
    expect(islandKeyOf(at('a', '/home/dev/a\u0007pi', 'main'))).toBe('/home/dev/api');
    expect(floorKeyOf(at('b', '/' + 'x'.repeat(600), 'main'))).toHaveLength(256);
  });
});

describe('repository labels', () => {
  const now = 10 * H;
  const at = (id: string, root: string, branch: string, state: SessionState = 'working', repoName = root.split('/').pop()!) =>
    toView({ ...sess(id, state, now - 1), workspace: { cwd: root, repoRoot: root, repoName, worktree: false, branch, root } }, now);
  const labels = (views: ReturnType<typeof at>[]) =>
    buildFloors(views).sort((a, b) => byCodeUnit(a.key, b.key)).map((f) => [f.key, f.name, f.repos]);

  it('tells same-named repositories apart by the shortest run of parent directories no other one ends with', () => {
    expect(labels([at('a', '/home/dev/a/work/api', 'main'), at('b', '/home/dev/b/work/api', 'main'), at('c', '/home/dev/oss/api', 'main'), at('d', '/home/dev/web', 'main')])).toEqual([
      ['repo:/home/dev/a/work/api', 'api (a/work)', ['api (a/work)']],
      ['repo:/home/dev/b/work/api', 'api (b/work)', ['api (b/work)']],
      ['repo:/home/dev/oss/api', 'api (oss)', ['api (oss)']],
      ['repo:/home/dev/web', 'web', ['web']],
    ]);
  });

  it('gives a repository the same label on every floor, and lists same-named ones apart on a feature floor', () => {
    expect(labels([at('a', '/home/dev/work/api', 'main'), at('b', '/home/dev/work/api', 'feat/x'), at('c', '/home/dev/oss/api', 'feat/x')])).toEqual([
      ['feature:x', 'x', ['api (oss)', 'api (work)']],
      ['repo:/home/dev/work/api', 'api (work)', ['api (work)']],
    ]);
  });

  it('keeps the whole root when its parent directories all end another\'s', () => {
    expect(labels([at('a', '/a/api', 'main'), at('b', '/b/a/api', 'main')])).toEqual([
      ['repo:/a/api', 'api (/a/api)', ['api (/a/api)']],
      ['repo:/b/a/api', 'api (b/a)', ['api (b/a)']],
    ]);
    expect(labels([at('a', '/x/svc.git', 'main', 'working', 'svc'), at('b', '/x/svc', 'main')])).toEqual([
      ['repo:/x/svc', 'svc (/x/svc)', ['svc (/x/svc)']],
      ['repo:/x/svc.git', 'svc (/x/svc.git)', ['svc (/x/svc.git)']],
    ]);
  });

  it('names a department floor after the first of its labels, whatever the order of its sessions', () => {
    // A session in a bare clone's directory, outside git, and one in a worktree of that clone, share its floor.
    const bare = toView({ ...sess('a', 'working', now - 1), workspace: { cwd: '/x/svc.git', repoRoot: null, repoName: 'svc.git', worktree: false, branch: null, root: null } }, now);
    const trunk = at('b', '/x/svc.git', 'main', 'working', 'svc');
    for (const views of [[bare, trunk], [trunk, bare]]) expect(labels(views)).toEqual([['repo:/x/svc.git', 'svc', ['svc', 'svc.git']]]);
  });

  it('counts only live sessions', () => {
    expect(labels([at('a', '/home/dev/work/api', 'main'), at('b', '/home/dev/oss/api', 'main', 'ended')])).toEqual([
      ['repo:/home/dev/work/api', 'api', ['api']],
    ]);
  });
});

describe('long keys', () => {
  const now = 10 * H;
  const at = (id: string, cwd: string) =>
    toView({ ...sess(id, 'working', now - 1), workspace: { cwd, repoRoot: cwd, repoName: cwd.split('/').pop()!, worktree: false, branch: 'main', root: cwd } }, now);

  it('keeps two floors and two islands apart when their keys share the first KEY_MAX code points', () => {
    const a = at('a', '/' + 'x'.repeat(KEY_MAX) + 'a'.repeat(43));
    const b = at('b', '/' + 'x'.repeat(KEY_MAX) + 'b'.repeat(43));
    expect(floorKeyOf(a)).not.toBe(floorKeyOf(b));
    expect(islandKeyOf(a)).not.toBe(islandKeyOf(b));
    for (const key of [floorKeyOf(a), floorKeyOf(b), islandKeyOf(a), islandKeyOf(b)]) expect(Array.from(key)).toHaveLength(KEY_MAX);
    expect(buildFloors([a, b])).toHaveLength(2);
  });
});

describe('floor order', () => {
  const now = 10 * H;
  const at = (id: string, cwd: string, startedAt: number, state: SessionState = 'working') =>
    toView({ ...sess(id, state, now - 1), startedAt, workspace: { cwd, repoRoot: cwd, repoName: cwd.split('/').pop()!, worktree: false, branch: 'main', root: cwd } }, now);

  it('keeps floors where they were first seen when their oldest session ends', () => {
    const before = [at('a1', '/w/alpha', 100), at('b1', '/w/beta', 200), at('a2', '/w/alpha', 400)];
    const after = [at('a1', '/w/alpha', 100, 'ended'), before[1]!, before[2]!];
    expect(buildFloors(before).map((f) => f.key)).toEqual(['repo:/w/beta', 'repo:/w/alpha']);
    // By earliest live start alone, alpha now opened at 400 and jumps to the top.
    expect(buildFloors(after).map((f) => f.key)).toEqual(['repo:/w/alpha', 'repo:/w/beta']);
    const firstSeen = new Map([['repo:/w/alpha', 100], ['repo:/w/beta', 200]]);
    expect(buildFloors(after, firstSeen).map((f) => [f.key, f.openedAt])).toEqual([['repo:/w/beta', 200], ['repo:/w/alpha', 100]]);
  });

  it('falls back to the earliest start for a floor with no first-seen time', () => {
    const floors = buildFloors([at('a', '/w/alpha', 100), at('c', '/w/gamma', 300)], new Map([['repo:/w/alpha', 500]]));
    expect(floors.map((f) => [f.key, f.openedAt])).toEqual([['repo:/w/alpha', 500], ['repo:/w/gamma', 300]]);
  });

  it('orders floors opened at the same time by key, comparing code units', () => {
    expect(buildFloors([at('a', '/w/alpha', 100), at('z', '/w/Zeta', 100)]).map((f) => f.key)).toEqual(['repo:/w/Zeta', 'repo:/w/alpha']);
  });
});

describe('buildAttention', () => {
  it('lists needs_you and done, longest wait first', () => {
    const now = 10 * H;
    const views = [
      toView(sess('late', 'needs_you', 9 * H), now),
      toView(sess('early', 'needs_you', 8 * H), now),
      toView(sess('d', 'done', 9.5 * H), now),
      toView(sess('w', 'working', 9.9 * H), now),
    ];
    const a = buildAttention(views);
    expect(a.needsYou.map((s) => s.id)).toEqual(['early', 'late']);
    expect(a.done.map((s) => s.id)).toEqual(['d']);
  });
});
