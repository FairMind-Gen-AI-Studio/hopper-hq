import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS as T } from '../../src/config.js';
import { newSession } from '../../src/core/reducer.js';
import type { Session, SessionState } from '../../src/core/types.js';
import { buildAttention, buildFloors, effectiveState, floorKeyOf, islandKeyOf, toView } from '../../src/core/view.js';
import { WS } from '../helpers/events.js';

const H = 60 * 60 * 1000;
function sess(id: string, state: SessionState, stateSince: number, extra: Partial<Session> = {}): Session {
  return { ...newSession(id, 0, WS), state, stateSince, lastEventAt: stateSince, ...extra };
}

describe('effectiveState', () => {
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
