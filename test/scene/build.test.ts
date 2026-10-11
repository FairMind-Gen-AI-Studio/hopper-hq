import { describe, expect, it } from 'vitest';
import { newSession } from '../../src/core/reducer.js';
import type { ChildAgent, Session, SessionState, Workspace } from '../../src/core/types.js';
import { toView, type SessionView } from '../../src/core/view.js';
import { buildFloorDetail, buildScene } from '../../src/scene/build.js';
import { FEATURE_SLOTS, REPO_SLOTS, slotOf } from '../../src/scene/palette.js';
import { SCENE_VERSION } from '../../src/scene/types.js';
import { demoViews } from '../helpers/demo-views.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NOW = 30 * DAY;

const ws = (cwd: string, branch: string | null, extra: Partial<Workspace> = {}): Workspace => ({
  cwd, repoRoot: cwd, repoName: cwd.split('/').pop()!, worktree: false, branch, root: cwd, ...extra,
});

/** A session viewed at NOW, showing `state`. Time-derived states are stored the way they arise. */
function view(id: string, workspace: Workspace, state: SessionState, extra: Partial<Session> = {}): SessionView {
  const stored: Partial<Session> =
    state === 'dormant' ? { state: 'idle', stateSince: NOW - 4 * DAY, lastEventAt: NOW - 4 * DAY }
    : state === 'no_signal' ? { state: 'working', stateSince: NOW - 30 * MIN, lastEventAt: NOW - 30 * MIN }
    : { state, stateSince: NOW - 5 * MIN, lastEventAt: NOW - 5 * MIN };
  return toView({ ...newSession(id, NOW - DAY, workspace), tmuxPane: '%1', ...stored, ...extra }, NOW);
}

const child = (id: string, type: string, running = true): ChildAgent => ({ id, type, description: null, running, lastAction: null, updatedAt: NOW - MIN });

function render(views: SessionView[]) {
  const scene = buildScene(views);
  return { scene, floors: scene.floors.map((f) => buildFloorDetail(views, f.key)) };
}

describe('the demo building', () => {
  const views = demoViews();
  const { scene, floors } = render(views);

  it('matches the snapshot', () => {
    expect({ scene, floors }).toMatchSnapshot();
  });

  it('lists floors newest first, numbered from the bottom, one window per desk', () => {
    expect(scene.version).toBe(SCENE_VERSION);
    expect(scene.floors.map((f) => [f.number, f.key, f.name, f.kind, f.repos])).toEqual([
      [3, 'feature:checkout-v2', 'checkout-v2', 'feature', ['orders-api', 'payments-svc', 'storefront-web']],
      [2, 'feature:search-ranking', 'search-ranking', 'feature', ['search-svc']],
      [1, 'repo:/demo/orders-api', 'orders-api', 'department', ['orders-api']],
    ]);
    expect(scene.floors[0]!.windows).toEqual([
      { sessionId: 'demo-oa-c3', state: 'needs_you' },
      { sessionId: 'demo-ps-d4', state: 'in_meeting' },
      { sessionId: 'demo-sw-b2', state: 'done' },
      { sessionId: 'demo-sw-a1', state: 'working' },
    ]);
    expect(scene.floors[0]!.counts).toEqual({ working: 1, needs_you: 1, done: 1, in_meeting: 1 });
    expect(scene.floors.map((f) => f.shutters)).toEqual([false, false, false]);
  });

  it('keeps windows in the order of the floor\'s desks', () => {
    scene.floors.forEach((f, i) => {
      expect(f.windows.map((w) => w.sessionId)).toEqual(floors[i]!.islands.flatMap((island) => island.desks.map((d) => d.sessionId)));
    });
  });

  it('builds a floor as its summary without windows, plus its layout', () => {
    scene.floors.forEach((f, i) => {
      const { windows, ...summary } = f;
      expect(floors[i]).toMatchObject({ version: SCENE_VERSION, ...summary });
      expect(floors[i]).not.toHaveProperty('windows');
      expect(windows).toHaveLength(floors[i]!.islands.reduce((n, island) => n + island.desks.length, 0));
    });
    expect(buildFloorDetail(views, 'feature:nope')).toBeNull();
  });

  it('is plain JSON', () => {
    expect(JSON.parse(JSON.stringify({ scene, floors }))).toStrictEqual({ scene, floors });
  });

  it('gives each checkout its own island, ordered by repo, branch and path', () => {
    expect(floors[0]!.islands.map((i) => [i.key, i.repo, i.branch, i.worktree, i.path, i.color])).toEqual([
      ['/demo/orders-api/.worktrees/checkout-v2', 'orders-api', 'feat/checkout-v2', true, '/demo/orders-api/.worktrees/checkout-v2', slotOf('orders-api', REPO_SLOTS)],
      ['/demo/payments-svc', 'payments-svc', 'feat/checkout-v2', false, '/demo/payments-svc', slotOf('payments-svc', REPO_SLOTS)],
      ['/demo/storefront-web', 'storefront-web', 'feat/checkout-v2', false, '/demo/storefront-web', slotOf('storefront-web', REPO_SLOTS)],
    ]);
  });

  it('lists who needs the user, longest wait first, and what is done, oldest first', () => {
    expect(scene.attention.needsYou.map((e) => [e.sessionId, e.floorKey, e.name, e.reason, e.focusable])).toEqual([
      ['demo-oa-c3', 'feature:checkout-v2', 'orders-api-c3', { kind: 'permission', text: 'Bash', detail: 'Bash: rm -rf dist && npm run build', agent: null }, true],
      ['demo-oa-g7', 'repo:/demo/orders-api', 'orders-api-g7', { kind: 'question', text: 'Should the retry queue use Redis or Postgres?', detail: null, agent: null }, true],
    ]);
    expect(scene.attention.done.map((e) => [e.sessionId, e.title, e.reason])).toEqual([['demo-sw-b2', 'Rewrite checkout copy and empty states', null]]);
  });
});

describe('desks', () => {
  it('poses each robot by state, with the body in the repo colour and the tie in the feature colour', () => {
    const states: SessionState[] = ['working', 'needs_you', 'done', 'in_meeting', 'no_signal', 'idle', 'dormant'];
    const views = states.map((s, i) => view(`s${i}`, ws('/w/api', 'feat/robots'), s, { startedAt: NOW - DAY + i }));
    const body = slotOf('api', REPO_SLOTS);
    const tie = slotOf('robots', FEATURE_SLOTS);
    expect(buildFloorDetail(views, 'feature:robots')!.islands[0]!.desks.map((d) => [d.state, d.robot])).toEqual([
      ['working', { pose: 'typing', badge: 'typing', body, tie }],
      ['needs_you', { pose: 'waving', badge: 'needs', body, tie }],
      ['done', { pose: 'holding', badge: 'done', body, tie }],
      ['in_meeting', { pose: 'still', badge: 'meeting', body, tie }],
      ['no_signal', { pose: 'still', badge: 'clock', body, tie }],
      ['idle', { pose: 'resting', badge: null, body, tie }],
      ['dormant', null],
    ]);
  });

  it('gives robots on a department floor no tie', () => {
    const desk = buildFloorDetail([view('a', ws('/w/api', 'main'), 'working')], 'repo:/w/api')!.islands[0]!.desks[0]!;
    expect(desk.robot).toEqual({ pose: 'typing', badge: 'typing', body: slotOf('api', REPO_SLOTS), tie: null });
  });

  it('lowers the shutters only when every desk on a floor is dormant', () => {
    const scene = buildScene([
      view('a', ws('/w/old', 'main'), 'dormant'),
      view('b', ws('/w/old', 'main'), 'dormant'),
      view('c', ws('/w/mixed', 'main'), 'dormant'),
      view('d', ws('/w/mixed', 'main'), 'idle'),
    ]);
    expect(scene.floors.map((f) => [f.key, f.shutters, f.counts])).toEqual([
      ['repo:/w/mixed', false, { idle: 1, dormant: 1 }],
      ['repo:/w/old', true, { dormant: 2 }],
    ]);
  });

  it('can focus a local session with a tmux pane, and nothing else', () => {
    const desks = buildFloorDetail([
      view('local', ws('/w/api', 'main'), 'working', { tmuxPane: '%12' }),
      view('cloud', ws('/w/api', 'main'), 'working', { location: 'cloud', tmuxPane: '%13' }),
      view('nopane', ws('/w/api', 'main'), 'working', { tmuxPane: null }),
      view('odd', ws('/w/api', 'main'), 'working', { tmuxPane: 'main:1.2' }),
    ], 'repo:/w/api')!.islands[0]!.desks;
    expect(desks.map((d) => [d.sessionId, d.location, d.pane, d.focusable])).toEqual([
      ['cloud', 'cloud', '%13', false],
      ['local', 'local', '%12', true],
      ['nopane', 'local', null, false],
      ['odd', 'local', 'main:1.2', false],
    ]);
  });

  it('reports a running tool, else the last action, and counts running agents', () => {
    const desks = buildFloorDetail([
      view('a', ws('/w/api', 'main'), 'no_signal', { openTool: { id: 't1', label: 'Bash: npm test', startedAt: NOW - 30 * MIN }, lastAction: 'Bash: npm test', lastActionAt: NOW - 30 * MIN }),
      view('b', ws('/w/api', 'main'), 'in_meeting', { lastAction: 'Edit src/a.ts', lastActionAt: NOW - 8 * MIN, children: [child('x', 'Explore'), child('y', 'Plan'), child('z', 'Explore', false)] }),
      view('c', ws('/w/api', 'main'), 'idle'),
    ], 'repo:/w/api')!.islands[0]!.desks;
    expect(desks.map((d) => [d.activity, d.agentsRunning])).toEqual([
      [{ label: 'Bash: npm test', since: NOW - 30 * MIN, running: true }, 0],
      [{ label: 'Edit src/a.ts', since: NOW - 8 * MIN, running: false }, 2],
      [null, 0],
    ]);
  });

  it('names a desk after its session, else after its repo and the start of its id', () => {
    const entry = buildScene([view('7f3a9c2e-0001', ws('/w/api', 'main'), 'done', { name: null, lastPrompt: 'Fix the login', firstPrompt: 'Start' })]).attention.done[0]!;
    expect(entry).toMatchObject({ name: 'api-7f3a', repo: 'api', title: 'Fix the login' });
  });

  it('leaves ended sessions out of the building and the attention bar', () => {
    const views = [view('gone', ws('/w/api', 'main'), 'ended'), view('here', ws('/w/web', 'main'), 'done')];
    const scene = buildScene(views);
    expect(scene.floors.map((f) => f.key)).toEqual(['repo:/w/web']);
    expect(scene.attention.done.map((e) => e.sessionId)).toEqual(['here']);
    expect(buildFloorDetail(views, 'repo:/w/api')).toBeNull();
  });

  it('orders attention by how long it has waited, then by id', () => {
    const since = (id: string, state: SessionState, t: number) => view(id, ws('/w/api', 'main'), state, { stateSince: t, lastEventAt: t });
    const scene = buildScene([
      since('b', 'needs_you', NOW - 2 * MIN),
      since('c', 'needs_you', NOW - 9 * MIN),
      since('a', 'needs_you', NOW - 2 * MIN),
      since('d', 'done', NOW - MIN),
      since('e', 'done', NOW - 3 * MIN),
    ]);
    expect(scene.attention.needsYou.map((e) => e.sessionId)).toEqual(['c', 'a', 'b']);
    expect(scene.attention.done.map((e) => e.sessionId)).toEqual(['e', 'd']);
  });
});

describe('wait reasons', () => {
  const waiting = (id: string, extra: Partial<Session>) =>
    view(id, ws('/w/api', 'main'), 'needs_you', { waitReason: { kind: 'permission', text: 'Bash', detail: 'Bash: npm publish' }, ...extra });

  it('says which subagent raised a wait, with its type from the session\'s children', () => {
    const scene = buildScene([
      waiting('own', { waitAgentId: null }),
      waiting('explore', { waitAgentId: 'a1', children: [child('a1', 'Explore')] }),
      waiting('unknown', { waitAgentId: 'a2', children: [child('a9', 'Plan')] }),
      waiting('unnamed', { waitAgentId: 'a3', children: [child('a3', 'agent')] }),
    ]);
    expect(Object.fromEntries(scene.attention.needsYou.map((e) => [e.sessionId, e.reason]))).toEqual({
      own: { kind: 'permission', text: 'Bash', detail: 'Bash: npm publish', agent: null },
      explore: { kind: 'permission', text: 'Bash', detail: 'Bash: npm publish', agent: { id: 'a1', type: 'Explore' } },
      unknown: { kind: 'permission', text: 'Bash', detail: 'Bash: npm publish', agent: { id: 'a2', type: null } },
      unnamed: { kind: 'permission', text: 'Bash', detail: 'Bash: npm publish', agent: { id: 'a3', type: null } },
    });
  });

  it('shows the same reason on the desk, and none once the session no longer needs the user', () => {
    const desks = buildFloorDetail([
      waiting('a', { waitAgentId: 'a1', children: [child('a1', 'Explore')] }),
      view('b', ws('/w/api', 'main'), 'working', { waitReason: { kind: 'question', text: 'stale' }, waitAgentId: 'a1' }),
    ], 'repo:/w/api')!.islands[0]!.desks;
    expect(desks.map((d) => d.reason)).toEqual([
      { kind: 'permission', text: 'Bash', detail: 'Bash: npm publish', agent: { id: 'a1', type: 'Explore' } },
      null,
    ]);
  });
});

describe('untrusted text', () => {
  const UNSAFE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
  const strings = (x: unknown): string[] =>
    typeof x === 'string' ? [x] : Array.isArray(x) ? x.flatMap(strings) : x && typeof x === 'object' ? Object.entries(x).flatMap(([k, v]) => [k, ...strings(v)]) : [];

  it('cleans every string it emits', () => {
    const hostile = view('h\u0007', ws('/w/a\u001bpi', 'feat/x\u202E'), 'needs_you', {
      name: 'na\u0000me',
      title: '\u2066title\r\nline',
      tmuxPane: '%1\u0007',
      waitReason: { kind: 'question', text: 'wh\u001b[2Jy', detail: 'de\u0085tail' },
      waitAgentId: 'ag\u0007',
      children: [child('ag\u0007', 'Ex\u0000plore')],
      openTool: { id: 't', label: 'Bash: \u001b[31mls', startedAt: NOW - MIN },
    });
    const out = render([hostile]);
    for (const s of strings(out)) expect(s).not.toMatch(UNSAFE);
    const desk = out.floors[0]!.islands[0]!.desks[0]!;
    expect([out.scene.floors[0]!.key, out.scene.floors[0]!.name, desk.sessionId, desk.name, desk.title, desk.pane, desk.reason, desk.activity?.label]).toEqual([
      'feature:x', 'x', 'h', 'name', 'title line', '%1',
      { kind: 'question', text: 'wh[2Jy', detail: 'detail', agent: { id: 'ag', type: 'Explore' } },
      'Bash: [31mls',
    ]);
  });
});

describe('determinism', () => {
  it('gives the same scene, byte for byte, whatever the order of the sessions', () => {
    const views = [
      ...demoViews(),
      // Ties on every ordering key: start time, wait time, floor opening, island repo and branch.
      view('t1', ws('/w/api', 'main'), 'done'),
      view('t2', ws('/w/api', 'main'), 'done'),
      view('t3', ws('/w/api/sub', 'main', { repoRoot: '/w/api', repoName: 'api', root: undefined }), 'needs_you'),
      view('t4', ws('/w/zeta', 'main'), 'working'),
    ];
    const orders = [
      [...views].reverse(),
      [...views.slice(5), ...views.slice(0, 5)],
      [...views.filter((_, i) => i % 2 === 1), ...views.filter((_, i) => i % 2 === 0)],
    ];
    const expected = JSON.stringify(render(views));
    for (const order of orders) expect(JSON.stringify(render(order))).toBe(expected);
  });

  it('leaves its input untouched', () => {
    const views = demoViews();
    const copy = structuredClone(views);
    render(views);
    expect(views).toEqual(copy);
  });
});
