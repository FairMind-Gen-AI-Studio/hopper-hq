import { describe, expect, it } from 'vitest';
import { newSession } from '../../src/core/reducer.js';
import type { ChildAgent, McpCall, RunAgent, Session, SessionState, WorkflowRun, Workspace } from '../../src/core/types.js';
import { toView, type SessionView } from '../../src/core/view.js';
import { buildFloorDetail, buildScene, MIN_HOLD_MS } from '../../src/scene/build.js';
import { BLOCK_DESKS, BLOCKS_MAX, layoutPlan, LOUNGE_SEATS, UNSEATED_MAX } from '../../src/scene/layout.js';
import { FEATURE_SLOTS, LINE_SLOTS, REPO_SLOTS, slotOf } from '../../src/scene/palette.js';
import { emptySeating, type Seating } from '../../src/scene/seating.js';
import { capKey } from '../../src/scene/text.js';
import { SCENE_VERSION, type FloorDetail, type MeetingRoom, type Occupant } from '../../src/scene/types.js';
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

const child = (id: string, type: string, running = true, extra: Partial<ChildAgent> = {}): ChildAgent => ({
  id, type, description: null, running, lastAction: null, updatedAt: NOW - MIN, ...extra,
});

const runAgent = (id: string, extra: Partial<RunAgent> = {}): RunAgent => ({
  id, label: null, phase: null, type: 'workflow-subagent', running: true, startedAt: NOW - 10 * MIN, updatedAt: NOW - MIN, ...extra,
});

/** `classifyMcp`'s own shape (tool-label.ts), hand-built: Group A has not wired a real caller onto it yet (hq-mcp-switchboard contract.md Seam 1). */
const mcpCall = (server: string, extra: Partial<McpCall> = {}): McpCall => ({ server, family: null, write: false, fairmind: false, tool: 'call', ...extra });

/** A run the filesystem confirmed, still going, with no agent yet. */
const run = (id: string, extra: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id, name: null, summary: null, phases: [], currentPhase: null, status: 'running', onDisk: true, startedAt: NOW - 20 * MIN, endedAt: null, agents: [], agentsFinished: 0, ...extra,
});

/** A live run with one running agent, started at `startedAt`. */
const live = (id: string, startedAt: number, extra: Partial<WorkflowRun> = {}): WorkflowRun => run(id, { startedAt, agents: [runAgent(`${id}-a`, { startedAt })], ...extra });

function render(views: SessionView[]) {
  const scene = buildScene(views);
  return { scene, floors: scene.floors.map((f) => buildFloorDetail(views, f.key)) };
}

/** A floor's sessions: those at the desks of its pods, in desk order, then those without a desk. */
const occupants = (floor: FloorDetail): Occupant[] => [...floor.pods.flatMap((p) => p.desks.flatMap((d) => (d.occupant ? [d.occupant] : []))), ...floor.unseated];

/** A one-block, one-column seating with these desks (session ids by desk index), and lounge seats and rooms if given. */
function seated(desks: (string | null)[], extra: Partial<Seating> = {}): Seating {
  const base = emptySeating();
  return { ...base, desks: [...desks, ...base.desks.slice(desks.length)], ...extra };
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
    const free = { sessionId: null, state: null };
    expect(scene.floors[0]!.windows).toEqual([
      { sessionId: 'demo-ps-d4', state: 'in_meeting' },
      { sessionId: 'demo-sw-b2', state: 'done' },
      { sessionId: 'demo-sw-a1', state: 'working' },
      free,
      { sessionId: 'demo-oa-c3', state: 'needs_you' },
      free,
      free,
      free,
    ]);
    expect(scene.floors[0]!.counts).toEqual({ working: 1, needs_you: 1, done: 1, in_meeting: 1 });
    expect(scene.floors.map((f) => f.shutters)).toEqual([false, false, false]);
  });

  it('gives each desk of a floor\'s plan one window, in desk index order, dark where the desk is free', () => {
    scene.floors.forEach((f, i) => {
      const desks = floors[i]!.pods.flatMap((p) => p.desks);
      expect(f.windows).toEqual(desks.map((d) => (d.occupant ? { sessionId: d.occupant.sessionId, state: d.occupant.state } : { sessionId: null, state: null })));
    });
  });

  it('builds a floor as its summary without windows, plus its layout', () => {
    scene.floors.forEach((f, i) => {
      const { windows, ...summary } = f;
      expect(floors[i]).toMatchObject({ version: SCENE_VERSION, ...summary });
      expect(floors[i]).not.toHaveProperty('windows');
      expect(windows).toHaveLength(floors[i]!.pods.length * 4);
    });
    expect(buildFloorDetail(views, 'feature:nope')).toBeNull();
  });

  it('is plain JSON', () => {
    expect(JSON.parse(JSON.stringify({ scene, floors }))).toStrictEqual({ scene, floors });
  });

  it('seats each floor on its base plan: a checkout beside its own, else in an empty pod, else at the first free desk', () => {
    expect(floors.map((f) => [f!.size, f!.pods.map((p) => [p.id, p.desks.map((d) => d.occupant?.sessionId ?? null)])])).toEqual([
      [{ w: 28, h: 20 }, [['p0', ['demo-ps-d4', 'demo-sw-b2', 'demo-sw-a1', null]], ['p1', ['demo-oa-c3', null, null, null]]]],
      [{ w: 28, h: 20 }, [['p0', ['demo-ss-e5', null, null, null]], ['p1', [null, null, null, null]]]],
      [{ w: 28, h: 20 }, [['p0', ['demo-oa-h8', 'demo-oa-g7', null, null]], ['p1', [null, null, null, null]]]],
    ]);
    const checkout = { repo: 'orders-api', branch: 'feat/checkout-v2', worktree: true, path: '/demo/orders-api/.worktrees/checkout-v2' };
    expect(floors[0]!.pods.map((p) => [p.color, p.placard])).toEqual([[null, null], [slotOf('/demo/orders-api', REPO_SLOTS), checkout]]);
    expect(floors[0]!.pods[1]!.desks[0]!.occupant!.checkout).toEqual(checkout);
    expect(floors.map((f) => f!.unseated)).toEqual([[], [], []]);
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
    const body = slotOf('/w/api', REPO_SLOTS);
    const tie = slotOf('robots', FEATURE_SLOTS);
    expect(occupants(buildFloorDetail(views, 'feature:robots')!).map((d) => [d.state, d.robot])).toEqual([
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
    const desk = occupants(buildFloorDetail([view('a', ws('/w/api', 'main'), 'working')], 'repo:/w/api')!)[0]!;
    expect(desk.robot).toEqual({ pose: 'typing', badge: 'typing', body: slotOf('/w/api', REPO_SLOTS), tie: null });
  });

  it('tells same-named repositories apart on a floor, and colours each by its root on every floor', () => {
    const views = [
      view('w1', ws('/home/dev/work/api', 'feat/x'), 'working'),
      view('o1', ws('/home/dev/oss/api', 'feat/x'), 'working'),
      view('w2', ws('/home/dev/work/api', 'main'), 'done'),
    ];
    const work = slotOf('/home/dev/work/api', REPO_SLOTS);
    const oss = slotOf('/home/dev/oss/api', REPO_SLOTS);
    expect(work).not.toBe(oss);
    const feature = buildFloorDetail(views, 'feature:x')!;
    const look = (floor: FloorDetail) => floor.pods.flatMap((p) => (p.placard ? [[p.placard.repo, p.color, p.desks.map((d) => d.occupant?.robot?.body ?? null)]] : []));
    expect(feature.repos).toEqual(['api (oss)', 'api (work)']);
    expect(look(feature)).toEqual([
      ['api (oss)', oss, [oss, null, null, null]],
      ['api (work)', work, [work, null, null, null]],
    ]);
    const department = buildFloorDetail(views, 'repo:/home/dev/work/api')!;
    expect([department.name, department.repos, look(department)]).toEqual(['api (work)', ['api (work)'], [['api (work)', work, [work, null, null, null]]]]);
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
    const desks = occupants(buildFloorDetail([
      view('local', ws('/w/api', 'main'), 'working', { tmuxPane: '%12' }),
      view('cloud', ws('/w/api', 'main'), 'working', { location: 'cloud', tmuxPane: '%13' }),
      view('nopane', ws('/w/api', 'main'), 'working', { tmuxPane: null }),
      view('odd', ws('/w/api', 'main'), 'working', { tmuxPane: 'main:1.2' }),
    ], 'repo:/w/api')!);
    expect(desks.map((d) => [d.sessionId, d.location, d.pane, d.focusable])).toEqual([
      ['cloud', 'cloud', '%13', false],
      ['local', 'local', '%12', true],
      ['nopane', 'local', null, false],
      ['odd', 'local', 'main:1.2', false],
    ]);
  });

  it('reports a running tool, else the last action, and counts running agents', () => {
    const desks = occupants(buildFloorDetail([
      view('a', ws('/w/api', 'main'), 'no_signal', { openTool: { id: 't1', label: 'Bash: npm test', startedAt: NOW - 30 * MIN }, lastAction: 'Bash: npm test', lastActionAt: NOW - 30 * MIN }),
      view('b', ws('/w/api', 'main'), 'in_meeting', { lastAction: 'Edit src/a.ts', lastActionAt: NOW - 8 * MIN, children: [child('x', 'Explore'), child('y', 'Plan'), child('z', 'Explore', false)] }),
      view('c', ws('/w/api', 'main'), 'idle'),
    ], 'repo:/w/api')!);
    expect(desks.map((d) => [d.activity, d.agentsRunning])).toEqual([
      [{ label: 'Bash: npm test', since: NOW - 30 * MIN, running: true }, 0],
      [{ label: 'Edit src/a.ts', since: NOW - 8 * MIN, running: false }, 2],
      [null, 0],
    ]);
  });

  it('reports the tool a desk waits on as its last action, not as running', () => {
    const pending = { openTool: { id: 't1', label: 'Bash: rm -rf dist', startedAt: NOW - 2 * MIN }, lastAction: 'Bash: rm -rf dist', lastActionAt: NOW - 2 * MIN };
    const desks = occupants(buildFloorDetail([
      view('a', ws('/w/api', 'main'), 'needs_you', { ...pending, waitReason: { kind: 'permission', text: 'Bash', detail: 'Bash: rm -rf dist' } }),
      view('b', ws('/w/api', 'main'), 'working', pending),
    ], 'repo:/w/api')!);
    expect(desks.map((d) => [d.sessionId, d.activity])).toEqual([
      ['a', { label: 'Bash: rm -rf dist', since: NOW - 2 * MIN, running: false }],
      ['b', { label: 'Bash: rm -rf dist', since: NOW - 2 * MIN, running: true }],
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

describe('pods', () => {
  it('take their placard from their newest session while it shares their checkout, and fill desks in start order', () => {
    const at = (id: string, branch: string, startedAt: number, worktree: boolean) => view(id, ws('/w/api', branch, { worktree }), 'working', { startedAt });
    const pod = (views: SessionView[]) => {
      const p = buildFloorDetail(views, 'feature:x')!.pods[0]!;
      return [p.placard?.branch, p.placard?.worktree, p.desks.map((d) => d.occupant?.sessionId ?? null)];
    };
    expect(pod([at('new', 'fix/x', NOW - DAY + 5, true), at('old', 'feat/x', NOW - DAY, false)])).toEqual(['fix/x', true, ['old', 'new', null, null]]);
    // Sessions that started together: the one with the greater id counts as the newer.
    expect(pod([at('b', 'fix/x', NOW - DAY, true), at('a', 'feat/x', NOW - DAY, false)])).toEqual(['fix/x', true, ['a', 'b', null, null]]);
  });

  it('colour their rug and write their placard while their occupants share a checkout, or a repository only', () => {
    const api = slotOf('/w/api', REPO_SLOTS);
    const tree = ws('/w/api/.worktrees/x', 'feat/x', { repoRoot: '/w/api', repoName: 'api', worktree: true });
    const views = [
      view('a1', ws('/w/api', 'feat/x'), 'working', { startedAt: NOW - DAY }),
      view('a2', ws('/w/api', 'feat/x'), 'dormant', { startedAt: NOW - DAY + 1 }),
      view('t1', tree, 'working', { startedAt: NOW - DAY + 2 }),
      view('w1', ws('/w/web', 'feat/x'), 'working', { startedAt: NOW - DAY + 3 }),
    ];
    const floor = buildFloorDetail(views, 'feature:x', undefined, new Map([['feature:x', seated(['a1', 'a2', null, null, null, 't1', 'w1'])]]))!;
    expect(floor.pods.map((p) => [p.color, p.placard])).toEqual([
      [api, { repo: 'api', branch: 'feat/x', worktree: false, path: '/w/api' }],
      [null, null],
    ]);
    const shared = buildFloorDetail(views, 'feature:x', undefined, new Map([['feature:x', seated(['a1', 't1', 'a2', null, 'w1'])]]))!;
    expect(shared.pods.map((p) => [p.color, p.placard])).toEqual([
      [api, { repo: 'api', branch: null, worktree: false, path: null }],
      [slotOf('/w/web', REPO_SLOTS), { repo: 'web', branch: 'feat/x', worktree: false, path: '/w/web' }],
    ]);
    expect(occupants(shared).map((o) => [o.sessionId, o.checkout])).toEqual([
      ['a1', { repo: 'api', branch: 'feat/x', worktree: false, path: '/w/api' }],
      ['t1', { repo: 'api', branch: 'feat/x', worktree: true, path: '/w/api/.worktrees/x' }],
      ['a2', { repo: 'api', branch: 'feat/x', worktree: false, path: '/w/api' }],
      ['w1', { repo: 'web', branch: 'feat/x', worktree: false, path: '/w/web' }],
    ]);
    const empty = buildFloorDetail(views, 'feature:x', undefined, new Map([['feature:x', seated([null, null, null, null, 'w1'])]]))!.pods[0]!;
    expect([empty.color, empty.placard, empty.desks.map((d) => d.occupant)]).toEqual([null, null, [null, null, null, null]]);
  });
});

describe('the plan', () => {
  const floorOf = (views: SessionView[], seating?: Seating) => buildFloorDetail(views, 'repo:/w/api', undefined, seating && new Map([['repo:/w/api', seating]]))!;

  it('lays out the plan the seating has grown to, with each session at its desk, and seats a floor it has no seating for from scratch', () => {
    const views = [view('a', ws('/w/api', 'main'), 'working'), view('b', ws('/w/api', 'main'), 'working', { startedAt: NOW - DAY + 1 })];
    const grown: Seating = { blocks: 2, roomCols: 2, desks: [null, null, null, null, null, 'b', null, null, null, 'a', ...Array<null>(6).fill(null)], lounge: emptySeating().lounge, rooms: [null, null, null, null] };
    const floor = floorOf(views, grown);
    const plan = layoutPlan({ blocks: 2, roomCols: 2 });
    expect([floor.size, floor.core, floor.lounge, floor.roomSlots, floor.breakArea]).toEqual([plan.size, plan.core, { rect: plan.lounge, seats: LOUNGE_SEATS }, plan.rooms, plan.breakArea]);
    expect(floor.pods.map((p) => [p.id, p.rect, p.desks.map((d) => [d.id, d.rect, d.chair])])).toEqual(plan.pods.map((p) => [p.id, p.rect, p.desks.map((d) => [d.id, d.rect, d.chair])]));
    expect(floor.pods.flatMap((p) => p.desks.map((d) => d.occupant?.sessionId ?? null))).toEqual(grown.desks);
    expect(floorOf(views)).toEqual(floorOf(views, seated(['a', 'b'])));
  });

  it('places each robot: gone without a desk or dormant, at the head of its first room with a slot while in_meeting, on its lounge seat, else at its desk', () => {
    const views = [
      view('desk', ws('/w/api', 'main'), 'working', { startedAt: NOW - DAY }),
      view('rest', ws('/w/api', 'main'), 'idle', { startedAt: NOW - DAY + 1 }),
      view('meet', ws('/w/api', 'main'), 'in_meeting', { startedAt: NOW - DAY + 2, runs: [live('wf_0000aaaa-001', NOW - 9 * MIN), live('wf_0000aaaa-002', NOW - 5 * MIN)] }),
      view('away', ws('/w/api', 'main'), 'dormant', { startedAt: NOW - DAY + 3 }),
      view('wait', ws('/w/api', 'main'), 'working', { startedAt: NOW - DAY + 4 }),
      view('roomless', ws('/w/api', 'main'), 'in_meeting', { startedAt: NOW - DAY + 5, runs: [live('wf_0000aaaa-003', NOW - 4 * MIN)] }),
      view('idle', ws('/w/api', 'main'), 'idle', { startedAt: NOW - DAY + 6 }),
    ];
    const floor = floorOf(views, seated(['desk', 'rest', 'meet', 'away', 'roomless', 'idle'], { lounge: [null, null, 'rest', null, null, null, null, null], rooms: [null, 'wf_0000aaaa-002'] }));
    expect(Object.fromEntries(occupants(floor).map((o) => [o.sessionId, o.at]))).toEqual({
      desk: { kind: 'desk' },
      rest: { kind: 'lounge', seat: 2 },
      meet: { kind: 'room', slot: 1 },
      away: { kind: 'gone' },
      roomless: { kind: 'desk' },
      idle: { kind: 'desk' },
      wait: { kind: 'gone' },
    });
  });

  it('lists the sessions without a desk in start order, with their robots, gone', () => {
    const views = [
      view('b', ws('/w/api', 'main'), 'working', { startedAt: NOW - DAY + 2 }),
      view('c', ws('/w/api', 'main'), 'dormant', { startedAt: NOW - DAY + 1 }),
      view('a', ws('/w/api', 'main'), 'needs_you', { startedAt: NOW - DAY + 2 }),
      view('s', ws('/w/api', 'main'), 'working', { startedAt: NOW - DAY }),
    ];
    const floor = floorOf(views, seated(['s']));
    expect(floor.unseated.map((o) => [o.sessionId, o.state, o.at, o.robot?.pose ?? null])).toEqual([
      ['c', 'dormant', { kind: 'gone' }, null],
      ['a', 'needs_you', { kind: 'gone' }, 'waving'],
      ['b', 'working', { kind: 'gone' }, 'typing'],
    ]);
  });

  it('opens a room for each live run that holds a slot, in slot order, and counts the other live runs', () => {
    const views = [
      view('h1', ws('/w/api', 'main'), 'working', { runs: [live('wf_0000aaaa-001', NOW - 9 * MIN), live('wf_0000aaaa-002', NOW - 8 * MIN)] }),
      view('h2', ws('/w/api', 'main'), 'working', { runs: [live('wf_0000aaaa-003', NOW - 7 * MIN), run('wf_0000aaaa-004', { status: 'completed', endedAt: NOW - MIN })] }),
    ];
    const rooms = [null, 'wf_0000aaaa-003', 'wf_0000aaaa-001', 'wf_0000aaaa-009'];
    const floor = floorOf(views, { ...seated(['h1', 'h2']), roomCols: 2, rooms });
    const slots = layoutPlan({ blocks: 1, roomCols: 2 }).rooms;
    expect([floor.rooms.map((r) => [r.runId, r.hostSessionId, r.slot, r.rect]), floor.roomsMore]).toEqual([
      [['wf_0000aaaa-003', 'h2', 1, slots[1]], ['wf_0000aaaa-001', 'h1', 2, slots[2]]],
      1,
    ]);
  });

  it('counts every session on a floor, those waiting for a desk too, and gives a window only to those at a desk', () => {
    const views = [
      view('s', ws('/w/api', 'main'), 'working'),
      view('w', ws('/w/api', 'main'), 'needs_you', { startedAt: NOW - DAY + 1 }),
      view('d', ws('/w/api', 'main'), 'dormant', { startedAt: NOW - DAY + 2 }),
    ];
    const seating = new Map([['repo:/w/api', seated([null, null, 'd', 's'])]]);
    const summary = buildScene(views, undefined, seating).floors[0]!;
    const free = { sessionId: null, state: null };
    expect([summary.counts, summary.windows]).toEqual([
      { working: 1, needs_you: 1, dormant: 1 },
      [free, free, { sessionId: 'd', state: 'dormant' }, { sessionId: 's', state: 'working' }, free, free, free, free],
    ]);
    const floor = buildFloorDetail(views, 'repo:/w/api', undefined, seating)!;
    expect([floor.counts, floor.unseated.map((o) => o.sessionId)]).toEqual([summary.counts, ['w']]);
    // With no seating given, the floor is seated from scratch.
    expect(buildScene(views).floors[0]!.windows.slice(0, 4).map((w) => w.sessionId)).toEqual(['s', 'w', 'd', null]);
  });

  /** A session id of the redacted kind, numbered. */
  const sid = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;

  it('lists at most UNSEATED_MAX sessions without a desk, the first in start order, and counts the rest', () => {
    const desks = BLOCKS_MAX * BLOCK_DESKS;
    const views = Array.from({ length: desks + UNSEATED_MAX + 6 }, (_, i) => view(sid(i), ws('/home/dev/api', 'main'), 'working', { startedAt: NOW - DAY + i }));
    const floor = buildFloorDetail(views, 'repo:/home/dev/api')!;
    const waiting = views.slice(desks).map((v) => v.id);
    expect([floor.unseated.map((o) => o.sessionId), floor.unseatedMore, floor.counts]).toEqual([waiting.slice(0, UNSEATED_MAX), 6, { working: views.length }]);
    const few = buildFloorDetail(views.slice(0, desks + 2), 'repo:/home/dev/api')!;
    expect([few.unseated.map((o) => o.sessionId), few.unseatedMore]).toEqual([waiting.slice(0, 2), 0]);
  });

  it('tells two checkouts apart by their whole roots, however long, as their pods do', () => {
    const deep = '/home/dev/' + 'a-long-directory-name/'.repeat(9);
    const tree = (tail: string) => ws(`${deep}${tail}`, 'feat/x', { repoRoot: '/home/dev/api', repoName: 'api', worktree: true });
    const views = [view(sid(1), tree('one'), 'working'), view(sid(2), tree('two'), 'working', { startedAt: NOW - DAY + 1 })];
    const floor = buildFloorDetail(views, 'feature:x')!;
    const paths = occupants(floor).map((o) => o.checkout.path);
    expect(paths).toEqual([capKey(`${deep}one`), capKey(`${deep}two`)]);
    expect(paths.map((p) => Array.from(p).length)).toEqual([211, 211]);
    expect(floor.pods.flatMap((p) => (p.placard ? [p.placard.path] : []))).toEqual(paths);
  });

  it('lights one window for a session that a seating lists at two desks: that of its first desk', () => {
    const views = [view(sid(1), ws('/home/dev/api', 'main'), 'working')];
    const seating = new Map([['repo:/home/dev/api', seated([sid(1), null, sid(1)])]]);
    const free = { sessionId: null, state: null };
    expect(buildScene(views, undefined, seating).floors[0]!.windows).toEqual([{ sessionId: sid(1), state: 'working' }, ...Array(7).fill(free)]);
    expect(occupants(buildFloorDetail(views, 'repo:/home/dev/api', undefined, seating)!).map((o) => o.sessionId)).toEqual([sid(1)]);
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

  it('types a wait a workflow agent raised from its run, looking at the children first', () => {
    const runs = [run('wf_0000aaaa-001', { agents: [runAgent('w1', { type: 'code-reviewer' }), runAgent('w2', { type: 'agent' }), runAgent('both', { type: 'Plan' })] })];
    const scene = buildScene([
      waiting('typed', { waitAgentId: 'w1', runs }),
      waiting('untyped', { waitAgentId: 'w2', runs }),
      waiting('both', { waitAgentId: 'both', runs, children: [child('both', 'Explore')] }),
    ]);
    expect(Object.fromEntries(scene.attention.needsYou.map((e) => [e.sessionId, e.reason?.agent]))).toEqual({
      typed: { id: 'w1', type: 'code-reviewer' },
      untyped: { id: 'w2', type: null },
      both: { id: 'both', type: 'Explore' },
    });
  });

  it('shows the same reason on the desk, and none once the session no longer needs the user', () => {
    const desks = occupants(buildFloorDetail([
      waiting('a', { waitAgentId: 'a1', children: [child('a1', 'Explore')] }),
      view('b', ws('/w/api', 'main'), 'working', { waitReason: { kind: 'question', text: 'stale' }, waitAgentId: 'a1' }),
    ], 'repo:/w/api')!);
    expect(desks.map((d) => d.reason)).toEqual([
      { kind: 'permission', text: 'Bash', detail: 'Bash: npm publish', agent: { id: 'a1', type: 'Explore' } },
      null,
    ]);
  });
});

describe('version 4', () => {
  it('gives floors, desks and attention entries no rooms, interns, runs or summary while their sessions have none', () => {
    const views = [view('a', ws('/w/api', 'main'), 'done')];
    const floor = buildFloorDetail(views, 'repo:/w/api')!;
    expect(SCENE_VERSION).toBe(12);
    expect([floor.version, floor.rooms, floor.roomsMore, floor.unseated]).toEqual([12, [], 0, []]);
    const desk = occupants(floor)[0]!;
    expect([desk.summary, desk.interns, desk.internsMore, desk.at, desk.runs]).toEqual([null, [], 0, { kind: 'desk' }, []]);
    expect(buildScene(views).attention.done[0]!.summary).toBeNull();
  });
});

describe('interns', () => {
  it('shows running subagents in the order they started, then the latest to finish, three at most, and counts the rest', () => {
    const children = [
      { ...child('f1', 'Plan', false), updatedAt: NOW - 9 * MIN },
      { ...child('r1', 'Explore'), description: 'Find every caller of useCart()' },
      { ...child('f2', 'Plan', false), updatedAt: NOW - 2 * MIN },
      child('r2', 'agent'),
      { ...child('f3', 'Explore', false), updatedAt: NOW - 2 * MIN },
    ];
    const desk = occupants(buildFloorDetail([view('a', ws('/w/api', 'main'), 'in_meeting', { children })], 'repo:/w/api')!)[0]!;
    expect(desk.interns).toEqual([
      { agentId: 'r1', type: 'Explore', label: 'Find every caller of useCart()', running: true, inRoom: true, smoking: false, leisure: null, call: null },
      { agentId: 'r2', type: null, label: null, running: true, inRoom: true, smoking: false, leisure: null, call: null },
      // f3 waits for its running siblings: outside the (default closed) leisure window it's on a coffee break.
      { agentId: 'f3', type: 'Explore', label: null, running: false, inRoom: false, smoking: false, leisure: 'coffee', call: null },
    ]);
    expect(desk.internsMore).toBe(2);
    const few = occupants(buildFloorDetail([view('a', ws('/w/api', 'main'), 'working', { children: children.slice(0, 2) })], 'repo:/w/api')!)[0]!;
    expect([few.interns.map((i) => i.agentId), few.internsMore]).toEqual([['r1', 'f1'], 0]);
  });

  it('lists an agent of a room and an intern of a desk once, the first, when two of their ids clean to one', () => {
    const v = view('h', ws('/w/api', 'main'), 'in_meeting', {
      children: [child('c1', 'Explore'), child('c1\u0007', 'Plan')],
      runs: [run('wf_0000aaaa-001', { agents: [runAgent('a1', { startedAt: NOW - 10 * MIN }), runAgent('a\u00001', { startedAt: NOW - 9 * MIN })] })],
    });
    const floor = buildFloorDetail([v], 'repo:/w/api')!;
    const desk = occupants(floor)[0]!;
    expect([desk.interns.map((i) => [i.agentId, i.type]), desk.internsMore]).toEqual([[['c1', 'Explore']], 0]);
    expect(floor.rooms[0]!.agents.map((a) => [a.agentId, a.running])).toEqual([['a1', true]]);
  });

  it('counts running subagents and running workflow agents together', () => {
    const runs = [run('wf_0000aaaa-001', { agents: [runAgent('w1'), runAgent('w2'), runAgent('w3', { running: false })], agentsFinished: 1 })];
    const desk = occupants(buildFloorDetail([view('a', ws('/w/api', 'main'), 'in_meeting', { children: [child('c1', 'Explore'), child('c2', 'Plan', false)], runs })], 'repo:/w/api')!)[0]!;
    expect(desk.agentsRunning).toBe(3);
  });
});

describe('smoking (version 5, feature B)', () => {
  it('shows a cigar on the desk only while a working or no_signal session has an actually open smoke-test tool', () => {
    const lit = (extra: Partial<Session> = {}): boolean =>
      occupants(buildFloorDetail([view('a', ws('/w/api', 'main'), 'working', extra)], 'repo:/w/api')!)[0]!.smoking;
    expect(lit({ openTool: { id: 't1', label: 'Bash: npm test -- smoke', startedAt: NOW - MIN, smoking: true } })).toBe(true);
    expect(lit({ openTool: { id: 't1', label: 'Bash: npm run build', startedAt: NOW - MIN } })).toBe(false);
    expect(lit()).toBe(false);
    // A needs_you/done session has not actually run its open tool: a leftover smoking flag on it does not light a cigar.
    for (const state of ['needs_you', 'done'] as const) {
      const stale = occupants(buildFloorDetail(
        [view('a', ws('/w/api', 'main'), state, { openTool: { id: 't1', label: 'Bash: npm test -- smoke', startedAt: NOW - MIN, smoking: true } })],
        'repo:/w/api',
      )!)[0]!;
      expect([state, stale.smoking]).toEqual([state, false]);
    }
  });

  it("carries a running child's or run agent's smoking flag, never a finished one's", () => {
    const children = [child('r1', 'Explore', true, { smoking: true }), child('f1', 'Explore', false, { smoking: false })];
    const desk = occupants(buildFloorDetail([view('a', ws('/w/api', 'main'), 'in_meeting', { children })], 'repo:/w/api')!)[0]!;
    expect(desk.interns.map((i) => [i.agentId, i.smoking])).toEqual([['r1', true], ['f1', false]]);

    const runs = [run('wf_0000aaaa-001', { agents: [runAgent('a1', { smoking: true }), runAgent('a2', { running: false, smoking: false })] })];
    const floor = buildFloorDetail([view('h', ws('/w/api', 'main'), 'in_meeting', { runs })], 'repo:/w/api')!;
    expect(floor.rooms[0]!.agents.map((a) => [a.agentId, a.smoking])).toEqual([['a1', true], ['a2', false]]);
  });
});

describe('on-call headset (hq-mcp-switchboard proposal.md, Group B seam)', () => {
  // Group A has not wired a real `classifyMcp` caller onto the reducer yet (contract.md Seam 1): every `call`/
  // `callAt`/`error` below is hand-built directly on the fixture, exactly as the reducer is expected to leave it.
  const slackSlot = slotOf('Slack', LINE_SLOTS);
  const fairmindSlot = slotOf('fairmind', LINE_SLOTS);

  it("shows a headset on the desk from the session's own call while it is live, and for MIN_HOLD_MS after a sub-second one already closed", () => {
    const callAt = NOW - 200; // a call that started 0.2s ago: well inside the ~1.8s hold even if it already finished
    const headsetAt = (extra: Partial<Session>, now = NOW) =>
      occupants(buildFloorDetail([view('a', ws('/w/api', 'main'), 'working', extra)], 'repo:/w/api', undefined, undefined, false, now)!)[0]!.call;

    expect(headsetAt({ call: mcpCall('Slack'), callAt })).toEqual({ slot: slackSlot, family: null, write: false, fairmind: false, error: false });
    expect(headsetAt({ call: mcpCall('Slack'), callAt }, callAt + MIN_HOLD_MS)).toBeNull(); // exactly at the edge of the hold: expired
    expect(headsetAt({ call: mcpCall('Slack'), callAt }, callAt + MIN_HOLD_MS - 1)).not.toBeNull(); // one ms inside it: still lit
    expect(headsetAt({})).toBeNull(); // no call at all
    // No `now` given (every caller before this feature, and the demo/snapshot fixtures): reads as no call live.
    expect(occupants(buildFloorDetail([view('a', ws('/w/api', 'main'), 'working', { call: mcpCall('Slack'), callAt })], 'repo:/w/api')!)[0]!.call).toBeNull();
  });

  it('does not show a headset from a call left over once the session moves to needs_you or done, exactly like a leftover smoking flag', () => {
    const extra: Partial<Session> = { call: mcpCall('Slack'), callAt: NOW - 200 };
    for (const state of ['needs_you', 'done'] as const) {
      const stale = occupants(buildFloorDetail([view('a', ws('/w/api', 'main'), state, extra)], 'repo:/w/api', undefined, undefined, false, NOW)!)[0]!;
      expect([state, stale.call]).toEqual([state, null]);
    }
  });

  it('carries the Fairmind family and the retained error flag onto the headset', () => {
    const extra: Partial<Session> = { call: mcpCall('fairmind', { family: 'Studio', fairmind: true, write: true }), callAt: NOW - 200, error: true };
    const desk = occupants(buildFloorDetail([view('a', ws('/w/api', 'main'), 'working', extra)], 'repo:/w/api', undefined, undefined, false, NOW)!)[0]!;
    expect(desk.call).toEqual({ slot: fairmindSlot, family: 'Studio', write: true, fairmind: true, error: true });
  });

  it("carries a running child's or run agent's own call, never a finished one's", () => {
    const children = [child('r1', 'Explore', true, { call: mcpCall('Slack'), callAt: NOW - 200 }), child('f1', 'Explore', false, { call: mcpCall('Slack'), callAt: NOW - 200 })];
    const desk = occupants(buildFloorDetail([view('a', ws('/w/api', 'main'), 'in_meeting', { children })], 'repo:/w/api', undefined, undefined, false, NOW)!)[0]!;
    expect(desk.interns.map((i) => [i.agentId, i.call])).toEqual([
      ['r1', { slot: slackSlot, family: null, write: false, fairmind: false, error: false }],
      ['f1', null],
    ]);

    const runs = [run('wf_0000aaaa-001', { agents: [runAgent('a1', { call: mcpCall('Slack'), callAt: NOW - 200 }), runAgent('a2', { running: false, call: mcpCall('Slack'), callAt: NOW - 200 })] })];
    const floor = buildFloorDetail([view('h', ws('/w/api', 'main'), 'in_meeting', { runs })], 'repo:/w/api', undefined, undefined, false, NOW)!;
    expect(floor.rooms[0]!.agents.map((a) => [a.agentId, a.call])).toEqual([
      ['a1', { slot: slackSlot, family: null, write: false, fairmind: false, error: false }],
      ['a2', null],
    ]);
  });

  it('carries a "×N" count on the headset once more than one of the entity\'s own calls are concurrently live ("parallel MCP calls" follow-up), the most-recent call\'s own colour still the one shown', () => {
    const callAt = NOW - 200;
    const calls = { t1: { call: mcpCall('Slack'), callAt: NOW - 300 }, t2: { call: mcpCall('Notion'), callAt } };
    const desk = occupants(buildFloorDetail([view('a', ws('/w/api', 'main'), 'working', { call: mcpCall('Notion'), callAt, calls })], 'repo:/w/api', undefined, undefined, false, NOW)!)[0]!;
    expect(desk.call).toEqual({ slot: slotOf('Notion', LINE_SLOTS), family: null, write: false, fairmind: false, error: false, count: 2 });
  });

  it('omits the count while only a single call is live, whether or not `calls` carries it (no regression for a single call)', () => {
    const callAt = NOW - 200;
    const withMap = occupants(buildFloorDetail([view('a', ws('/w/api', 'main'), 'working', { call: mcpCall('Slack'), callAt, calls: { t1: { call: mcpCall('Slack'), callAt } } })], 'repo:/w/api', undefined, undefined, false, NOW)!)[0]!;
    expect(withMap.call).toEqual({ slot: slackSlot, family: null, write: false, fairmind: false, error: false });
    const withoutMap = occupants(buildFloorDetail([view('a', ws('/w/api', 'main'), 'working', { call: mcpCall('Slack'), callAt })], 'repo:/w/api', undefined, undefined, false, NOW)!)[0]!;
    expect(withoutMap.call).toEqual({ slot: slackSlot, family: null, write: false, fairmind: false, error: false });
  });
});

describe('active lines (hq-mcp-switchboard proposal.md §2 "Many parallel calls"; Group B seam)', () => {
  it('lists every distinct server with a live call anywhere in the building, with a count per line', () => {
    const callAt = NOW - 200;
    const views = [
      view('a', ws('/w/api', 'main'), 'working', { call: mcpCall('Slack'), callAt }),
      view('b', ws('/w/web', 'main'), 'working', { call: mcpCall('Notion'), callAt, children: [child('c1', 'Explore', true, { call: mcpCall('Slack'), callAt })] }),
    ];
    const lines = buildScene(views, undefined, undefined, NOW).activeLines;
    expect(lines).toEqual(
      expect.arrayContaining([
        { slot: slotOf('Slack', LINE_SLOTS), fairmind: false, count: 2, server: 'Slack', family: null, tool: 'call', caller: 'api-a' },
        { slot: slotOf('Notion', LINE_SLOTS), fairmind: false, count: 1, server: 'Notion', family: null, tool: 'call', caller: 'web-b' },
      ]),
    );
    expect(lines).toHaveLength(2);
  });

  it("carries the first-tallied call's own tool verb and caller name (Phase 4, façade antenna tooltip), the same first-tallied-wins limit server/family already accept", () => {
    const callAt = NOW - 200;
    const views = [
      view('a', ws('/w/api', 'main'), 'working', { call: mcpCall('Slack', { tool: 'chat_postMessage' }), callAt }),
      view('b', ws('/w/web', 'main'), 'working', { children: [child('c1', 'Explore', true, { call: mcpCall('Slack', { tool: 'list_channels' }), callAt })] }),
    ];
    const lines = buildScene(views, undefined, undefined, NOW).activeLines;
    expect(lines).toEqual([{ slot: slotOf('Slack', LINE_SLOTS), fairmind: false, count: 2, server: 'Slack', family: null, tool: 'chat_postMessage', caller: 'api-a' }]);
  });

  it('names an intern caller by its agent type, a meeting agent by its label (or type), falling back to a generic name for an unknown one — the same names already shown on the desk panel and the run panel', () => {
    const callAt = NOW - 200;
    const internLines = buildScene(
      [view('a', ws('/w/api', 'main'), 'in_meeting', { children: [child('c1', 'agent', true, { call: mcpCall('Slack'), callAt })] })],
      undefined,
      undefined,
      NOW,
    ).activeLines;
    expect(internLines[0]).toMatchObject({ caller: 'Subagent' });

    const agentLines = buildScene(
      [view('h', ws('/w/api', 'main'), 'in_meeting', { runs: [run('wf_0000aaaa-001', { agents: [runAgent('a1', { label: 'Verify checkout', call: mcpCall('Slack'), callAt })] })] })],
      undefined,
      undefined,
      NOW,
    ).activeLines;
    expect(agentLines[0]).toMatchObject({ caller: 'Verify checkout' });

    const unlabeledAgentLines = buildScene(
      [view('h', ws('/w/api', 'main'), 'in_meeting', { runs: [run('wf_0000aaaa-002', { agents: [runAgent('a2', { label: null, type: 'agent', call: mcpCall('Slack'), callAt })] })] })],
      undefined,
      undefined,
      NOW,
    ).activeLines;
    expect(unlabeledAgentLines[0]).toMatchObject({ caller: 'Agent' });
  });

  it('collapses every Fairmind call into one combined line, never a slot among the others, keeping the first-tallied family', () => {
    const callAt = NOW - 200;
    const views = [
      view('a', ws('/w/api', 'main'), 'working', { call: mcpCall('fairmind', { family: 'Studio', fairmind: true }), callAt }),
      view('b', ws('/w/web', 'main'), 'working', { call: mcpCall('fairmind', { family: 'Brain', fairmind: true }), callAt }),
    ];
    const lines = buildScene(views, undefined, undefined, NOW).activeLines;
    expect(lines).toEqual([{ slot: slotOf('fairmind', LINE_SLOTS), fairmind: true, count: 2, server: 'fairmind', family: 'Studio', tool: 'call', caller: 'api-a' }]);
  });

  it('carries a null family for a Fairmind line whose first-tallied call carried none (hq-mcp-switchboard proposal.md §5 Phase 3 default form)', () => {
    const callAt = NOW - 200;
    const views = [view('a', ws('/w/api', 'main'), 'working', { call: mcpCall('fairmind', { fairmind: true }), callAt })];
    const lines = buildScene(views, undefined, undefined, NOW).activeLines;
    expect(lines).toEqual([{ slot: slotOf('fairmind', LINE_SLOTS), fairmind: true, count: 1, server: 'fairmind', family: null, tool: 'call', caller: 'api-a' }]);
  });

  it('gives two servers whose names hash to the same slot an antenna each, the later name probing to the next free slot', () => {
    // LINE_SLOTS buckets only 8 ways: among 50 distinct synthetic names, two colliding into the same slot is
    // guaranteed by the pigeonhole principle, never left to chance on a handful of real server names.
    const bySlot = new Map<number, string>();
    let a = '';
    let b = '';
    for (let i = 0; i < 50 && !b; i++) {
      const name = `server-${i}`;
      const slot = slotOf(name, LINE_SLOTS);
      const prior = bySlot.get(slot);
      if (prior) {
        a = prior;
        b = name;
      } else {
        bySlot.set(slot, name);
      }
    }
    expect(b).not.toBe('');
    const callAt = NOW - 200;
    const lines = buildScene(
      [view('a', ws('/w/api', 'main'), 'working', { call: mcpCall(a), callAt }), view('b', ws('/w/web', 'main'), 'working', { call: mcpCall(b), callAt })],
      undefined,
      undefined,
      NOW,
    ).activeLines;
    const [first, second] = a < b ? [a, b] : [b, a];
    const home = slotOf(first, LINE_SLOTS);
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.server === first)?.slot).toBe(home);
    expect(lines.find((l) => l.server === second)?.slot).toBe((home + 1) % LINE_SLOTS);
    expect(lines.every((l) => l.count === 1)).toBe(true);
  });

  it('shares a stub only past LINE_SLOTS distinct servers, the extra call counted on the line it lands on', () => {
    const callAt = NOW - 200;
    const servers = Array.from({ length: LINE_SLOTS + 1 }, (_, i) => `srv-${i}`);
    const lines = buildScene(
      servers.map((s, i) => view(`s${i}`, ws(`/w/r${i}`, 'main'), 'working', { call: mcpCall(s), callAt })),
      undefined,
      undefined,
      NOW,
    ).activeLines;
    expect(lines).toHaveLength(LINE_SLOTS);
    expect(new Set(lines.map((l) => l.slot)).size).toBe(LINE_SLOTS);
    expect(lines.reduce((n, l) => n + l.count, 0)).toBe(LINE_SLOTS + 1);
  });

  it('drops a line once every call on it has left the minimum-hold window, and is empty with no clock', () => {
    const views = [view('a', ws('/w/api', 'main'), 'working', { call: mcpCall('Slack'), callAt: NOW - MIN_HOLD_MS })];
    expect(buildScene(views, undefined, undefined, NOW).activeLines).toEqual([]);
    expect(buildScene(views).activeLines).toEqual([]);
  });

  it('lights one antenna per distinct server across every one of a single session\'s own concurrently-open calls ("parallel MCP calls" follow-up — one Claude Code turn calling six MCP servers in parallel used to light at most one antenna)', () => {
    // Six synthetic server names picked to resolve to six distinct slots (LINE_SLOTS = 8): the scenario under test
    // is one entity with many calls open at once, not slotOf's own hashing — an unrelated collision (already
    // covered, and accepted, by the "keeps a slot's first-tallied server name" test above) would otherwise make
    // this test flaky against which real names happen to hash together.
    const servers: string[] = [];
    const seenSlots = new Set<number>();
    for (let i = 0; servers.length < 6; i++) {
      const slot = slotOf(`server-${i}`, LINE_SLOTS);
      if (!seenSlots.has(slot)) {
        seenSlots.add(slot);
        servers.push(`server-${i}`);
      }
    }
    const callAt = NOW - 200;
    const calls = Object.fromEntries(servers.map((server, i) => [`t${i}`, { call: mcpCall(server), callAt: callAt - i }]));
    const views = [view('a', ws('/w/api', 'main'), 'working', { call: mcpCall(servers.at(-1)!), callAt, calls })];
    const lines = buildScene(views, undefined, undefined, NOW).activeLines;
    expect(lines).toHaveLength(6);
    expect(lines.every((l) => l.count === 1)).toBe(true);
    expect(new Set(lines.map((l) => l.server))).toEqual(new Set(servers));
  });

  it("falls back to the entity's own single call/callAt when `calls` has nothing live — a call held past its own tool.finished (reducer.ts's withoutCall already removed it from the map) within its own min-hold tail, or a fixture/restored session the map never existed for", () => {
    const callAt = NOW - 200;
    // `calls` present but empty (as if its one call had just finished): call/callAt alone still carries it.
    const empty = buildScene([view('a', ws('/w/api', 'main'), 'working', { call: mcpCall('Slack'), callAt, calls: {} })], undefined, undefined, NOW).activeLines;
    expect(empty).toEqual([{ slot: slotOf('Slack', LINE_SLOTS), fairmind: false, count: 1, server: 'Slack', family: null, tool: 'call', caller: 'api-a' }]);
    // `calls` entirely absent (every pre-existing fixture, and a session restored from a store saved before it existed).
    const absent = buildScene([view('b', ws('/w/web', 'main'), 'working', { call: mcpCall('Slack'), callAt })], undefined, undefined, NOW).activeLines;
    expect(absent).toEqual([{ slot: slotOf('Slack', LINE_SLOTS), fairmind: false, count: 1, server: 'Slack', family: null, tool: 'call', caller: 'web-b' }]);
  });
});

describe('leisure (version 5, feature A)', () => {
  it('sends a lone waiter to the bar, and pairs two into biliardino, inside the window', () => {
    const lone = [child('r1', 'Explore', true), child('f1', 'Explore', false)];
    const desk1 = occupants(buildFloorDetail([view('a', ws('/w/api', 'main'), 'working', { children: lone })], 'repo:/w/api', undefined, undefined, true)!)[0]!;
    expect(desk1.interns.map((i) => [i.agentId, i.leisure])).toEqual([['r1', null], ['f1', 'gintonic']]);

    const pair = [child('r1', 'Explore', true), child('f1', 'Explore', false), child('f2', 'Explore', false, { updatedAt: NOW - 2 * MIN })];
    const desk2 = occupants(buildFloorDetail([view('a', ws('/w/api', 'main'), 'working', { children: pair })], 'repo:/w/api', undefined, undefined, true)!)[0]!;
    expect(desk2.interns.map((i) => [i.agentId, i.leisure])).toEqual([['r1', null], ['f1', 'biliardino'], ['f2', 'biliardino']]);
  });

  it('sends every waiter for coffee outside the window, and clears leisure once the whole cohort is done', () => {
    const closed = [child('r1', 'Explore', true), child('f1', 'Explore', false)];
    // leisureOpen defaults to false: the window is closed.
    const desk = occupants(buildFloorDetail([view('a', ws('/w/api', 'main'), 'working', { children: closed })], 'repo:/w/api')!)[0]!;
    expect(desk.interns.map((i) => [i.agentId, i.leisure])).toEqual([['r1', null], ['f1', 'coffee']]);

    const allDone = [child('f1', 'Explore', false), child('f2', 'Explore', false, { updatedAt: NOW - 2 * MIN })];
    const done = occupants(buildFloorDetail([view('a', ws('/w/api', 'main'), 'done', { children: allDone })], 'repo:/w/api', undefined, undefined, true)!)[0]!;
    expect(done.interns.every((i) => i.leisure === null)).toBe(true);
  });

  it('sets a run agent leisure the same way, paired within its own run', () => {
    const runs = [run('wf_0000aaaa-001', { agents: [runAgent('a1'), runAgent('a2', { running: false }), runAgent('a3', { running: false, updatedAt: NOW - 2 * MIN })] })];
    const floor = buildFloorDetail([view('h', ws('/w/api', 'main'), 'in_meeting', { runs })], 'repo:/w/api', undefined, undefined, true)!;
    expect(floor.rooms[0]!.agents.map((a) => [a.agentId, a.leisure])).toEqual([['a1', null], ['a2', 'biliardino'], ['a3', 'biliardino']]);
  });

  it('gives the same floor, byte for byte, whatever the order of the sessions, with the window open', () => {
    const views = [
      view('a', ws('/w/api', 'main'), 'working', { children: [child('r1', 'Explore', true), child('f1', 'Explore', false), child('f2', 'Explore', false, { updatedAt: NOW - 2 * MIN })] }),
      view('b', ws('/w/api', 'main'), 'working', { children: [child('r2', 'Explore', true), child('g1', 'Explore', false)] }),
    ];
    const expected = JSON.stringify(buildFloorDetail(views, 'repo:/w/api', undefined, undefined, true));
    expect(JSON.stringify(buildFloorDetail([...views].reverse(), 'repo:/w/api', undefined, undefined, true))).toBe(expected);
  });
});

describe('summaries', () => {
  it('gives the desk and its attention entry the summary line, stale once a prompt came after it', () => {
    const summary = { text: 'Waits for the \u001b[1mcheckout tests', at: NOW - 4 * MIN, inputHash: '0123456789abcdef' };
    const views = [
      view('fresh', ws('/w/api', 'main'), 'done', { summary, lastPromptAt: NOW - 4 * MIN }),
      view('stale', ws('/w/api', 'main'), 'done', { summary, lastPromptAt: NOW - 3 * MIN }),
      view('none', ws('/w/api', 'main'), 'done', { lastPromptAt: NOW - 3 * MIN }),
      view('blank', ws('/w/api', 'main'), 'done', { summary: { ...summary, text: ' \u0007 ' } }),
    ];
    const desks = Object.fromEntries(occupants(buildFloorDetail(views, 'repo:/w/api')!).map((d) => [d.sessionId, d.summary]));
    expect(desks).toEqual({
      fresh: { text: 'Waits for the [1mcheckout tests', at: NOW - 4 * MIN, stale: false },
      stale: { text: 'Waits for the [1mcheckout tests', at: NOW - 4 * MIN, stale: true },
      none: null,
      blank: null,
    });
    expect(Object.fromEntries(buildScene(views).attention.done.map((e) => [e.sessionId, e.summary]))).toEqual(desks);
  });
});

describe('runs on a desk', () => {
  it('lists live runs by start, then the others, the latest to end first, five at most, each with its own status and counts', () => {
    const runs = [
      run('wf_0000aaaa-001', { name: 'old', status: 'completed', startedAt: NOW - 60 * MIN, endedAt: NOW - 50 * MIN, agentsFinished: 3 }),
      run('wf_0000aaaa-002', { name: 'later', status: 'failed', startedAt: NOW - 40 * MIN, endedAt: NOW - 5 * MIN, agentsFinished: 1 }),
      // Seen through the hooks only, with no agent left running: it holds nothing, though it never ended.
      run('wf_0000aaaa-003', { onDisk: false, startedAt: NOW - 30 * MIN, agents: [runAgent('h1', { running: false })], agentsFinished: 1 }),
      run('wf_0000aaaa-004', { name: 'second', startedAt: NOW - 8 * MIN, agents: [runAgent('a1'), runAgent('a2', { running: false })], agentsFinished: 1 }),
      run('wf_0000aaaa-005', { name: 'first', onDisk: false, startedAt: NOW - 9 * MIN, agents: [runAgent('a3')] }),
      run('wf_0000aaaa-006', { status: 'killed', startedAt: NOW - 70 * MIN, endedAt: NOW - 65 * MIN }),
    ];
    const desk = occupants(buildFloorDetail([view('a', ws('/w/api', 'main'), 'in_meeting', { runs })], 'repo:/w/api')!)[0]!;
    expect(desk.runs).toEqual([
      { runId: 'wf_0000aaaa-005', name: 'first', status: 'running', startedAt: NOW - 9 * MIN, endedAt: null, counts: { running: 1, finished: 0 } },
      { runId: 'wf_0000aaaa-004', name: 'second', status: 'running', startedAt: NOW - 8 * MIN, endedAt: null, counts: { running: 1, finished: 1 } },
      { runId: 'wf_0000aaaa-002', name: 'later', status: 'failed', startedAt: NOW - 40 * MIN, endedAt: NOW - 5 * MIN, counts: { running: 0, finished: 1 } },
      { runId: 'wf_0000aaaa-003', name: null, status: 'running', startedAt: NOW - 30 * MIN, endedAt: null, counts: { running: 0, finished: 1 } },
      { runId: 'wf_0000aaaa-001', name: 'old', status: 'completed', startedAt: NOW - 60 * MIN, endedAt: NOW - 50 * MIN, counts: { running: 0, finished: 3 } },
    ]);
  });
});

describe('meeting rooms', () => {
  it('gives each live run on the floor a room, by start then run id, four at most, and counts the rest', () => {
    const views = [
      view('h1', ws('/w/api', 'feat/rooms'), 'in_meeting', {
        runs: [live('wf_0000aaaa-003', NOW - 5 * MIN), live('wf_0000aaaa-001', NOW - 9 * MIN), run('wf_0000aaaa-009', { status: 'completed', startedAt: NOW - 30 * MIN, endedAt: NOW - 20 * MIN })],
      }),
      view('h2', ws('/w/web', 'feat/rooms'), 'working', {
        runs: [
          live('wf_0000aaaa-002', NOW - 5 * MIN),
          live('wf_0000aaaa-004', NOW - MIN),
          live('wf_0000aaaa-005', NOW - 7 * MIN, { onDisk: false, agents: [runAgent('gone', { running: false })] }),
          live('wf_0000aaaa-006', NOW - 2 * MIN),
        ],
      }),
      view('h3', ws('/w/api', 'main'), 'working', { runs: [live('wf_0000aaaa-007', NOW - 10 * MIN)] }),
    ];
    const floor = buildFloorDetail(views, 'feature:rooms')!;
    expect(floor.rooms.map((r) => [r.runId, r.hostSessionId])).toEqual([
      ['wf_0000aaaa-001', 'h1'],
      ['wf_0000aaaa-002', 'h2'],
      ['wf_0000aaaa-003', 'h1'],
      ['wf_0000aaaa-006', 'h2'],
    ]);
    expect(floor.roomsMore).toBe(1);
    // A third run at once opens the second room column.
    const plan = layoutPlan({ blocks: 1, roomCols: 2 });
    expect([floor.rooms.map((r) => [r.slot, r.rect]), floor.roomSlots, floor.size]).toEqual([plan.rooms.map((rect, slot) => [slot, rect]), plan.rooms, plan.size]);
    // A run is on its host's floor only.
    const department = buildFloorDetail(views, 'repo:/w/api')!;
    expect([department.rooms.map((r) => r.runId), department.roomsMore]).toEqual([['wf_0000aaaa-007'], 0]);
  });

  it('names a room after its run, and marks phases done, current and upcoming from the current one', () => {
    const phases = ['Plan', 'Build', 'Review', 'Ship'];
    const room = (extra: Partial<WorkflowRun>) =>
      buildFloorDetail([view('h', ws('/w/api', 'main'), 'working', { runs: [live('wf_0000aaaa-001', NOW - MIN, extra)] })], 'repo:/w/api')!.rooms[0]!;
    const named = room({ name: 'checkout-verify', summary: 'Verify split payments end to end', phases, currentPhase: 'Review' });
    expect([named.name, named.summary, named.phases]).toEqual([
      'checkout-verify',
      'Verify split payments end to end',
      [{ title: 'Plan', state: 'done' }, { title: 'Build', state: 'done' }, { title: 'Review', state: 'current' }, { title: 'Ship', state: 'upcoming' }],
    ]);
    const upcoming = phases.map((title) => ({ title, state: 'upcoming' as const }));
    const cases: Array<[Partial<WorkflowRun>, MeetingRoom['phases']]> = [
      [{ phases, currentPhase: 'Plan' }, [{ title: 'Plan', state: 'current' }, ...upcoming.slice(1)]],
      [{ phases, currentPhase: null }, upcoming],
      [{ phases, currentPhase: 'Deploy' }, upcoming],
      // The script's meta was out of reach: the current phase alone, or nothing.
      [{ phases: [], currentPhase: 'Build' }, [{ title: 'Build', state: 'current' }]],
      [{ phases: [], currentPhase: null }, []],
      // A title the list repeats is current where it comes last.
      [{ phases: ['Build', 'Test', 'Build'], currentPhase: 'Build' }, [{ title: 'Build', state: 'done' }, { title: 'Test', state: 'done' }, { title: 'Build', state: 'current' }]],
    ];
    for (const [extra, expected] of cases) expect([extra, room(extra).phases]).toEqual([extra, expected]);
    expect([room({}).name, room({}).summary]).toEqual([null, null]);
  });

  it("gives a workflow room's board its topic: the run's name, else its current phase, else 'Subagents'", () => {
    const topic = (extra: Partial<WorkflowRun>) =>
      buildFloorDetail([view('h', ws('/w/api', 'main'), 'working', { runs: [live('wf_0000aaaa-001', NOW - MIN, extra)] })], 'repo:/w/api')!.rooms[0]!.topic;
    expect(topic({ name: 'checkout-verify' })).toBe('checkout-verify');
    // No name: the current phase.
    expect(topic({ name: null, phases: ['Plan', 'Build'], currentPhase: 'Build' })).toBe('Build');
    // Neither: the generic fallback, never the run id.
    expect(topic({ name: null, phases: [], currentPhase: null })).toBe('Subagents');
  });

  it("gives a crew room's board its topic: its host's title, else its current phase (it never has one), else 'Subagents', never its fixed name", () => {
    const host = (extra: Partial<Session> = {}) => buildFloorDetail([view('a', ws('/w/api', 'main'), 'working', { children: [child('r1', 'Explore')], ...extra })], 'repo:/w/api')!.rooms[0]!;
    expect(host({ title: 'Investigate the checkout bug' }).topic).toBe('Investigate the checkout bug');
    // No title and no prompt: the generic fallback - the same word as the crew's fixed name, but never taken from it.
    expect(host({ title: null, lastPrompt: null, firstPrompt: null }).topic).toBe('Subagents');
  });

  it('lists running agents in start order, then finished ones, the latest to finish first, 24 at most, with the run counts', () => {
    const agents = [
      ...Array.from({ length: 20 }, (_, i) => runAgent(`f${String(i).padStart(2, '0')}`, { running: false, startedAt: NOW - 30 * MIN + i, updatedAt: NOW - 20 * MIN + i })),
      ...Array.from({ length: 6 }, (_, i) => runAgent(`r${i}`, { startedAt: NOW - 5 * MIN - i })),
    ];
    agents[20] = { ...agents[20]!, label: 'Review the ledger', phase: 'Review', type: 'agent' };
    const r = buildFloorDetail([view('h', ws('/w/api', 'main'), 'working', { runs: [run('wf_0000aaaa-001', { agents, agentsFinished: 25 })] })], 'repo:/w/api')!.rooms[0]!;
    expect(r.counts).toEqual({ running: 6, finished: 25 });
    expect(r.agents.map((a) => a.agentId)).toEqual(['r5', 'r4', 'r3', 'r2', 'r1', 'r0', ...Array.from({ length: 18 }, (_, i) => `f${String(19 - i).padStart(2, '0')}`)]);
    expect(r.agents[5]).toEqual({ agentId: 'r0', label: 'Review the ledger', phase: 'Review', type: null, running: true, smoking: false, leisure: null, call: null });
    // f19 waits for its running siblings: outside the (default closed) leisure window it's on a coffee break.
    expect(r.agents[6]).toEqual({ agentId: 'f19', label: null, phase: null, type: 'workflow-subagent', running: false, smoking: false, leisure: 'coffee', call: null });
  });

  it('seats a working or in_meeting host at the head of its first room, keeping its robot', () => {
    const views = [
      view('meet', ws('/w/api', 'feat/rooms'), 'in_meeting', { runs: [live('wf_0000aaaa-002', NOW - 5 * MIN), live('wf_0000aaaa-001', NOW - 9 * MIN)] }),
      view('busy', ws('/w/web', 'feat/rooms'), 'working', { runs: [live('wf_0000aaaa-003', NOW - 4 * MIN)] }),
      view('helped', ws('/w/web', 'feat/rooms'), 'in_meeting', { children: [child('c1', 'Explore')] }),
    ];
    const floor = buildFloorDetail(views, 'feature:rooms')!;
    const api = slotOf('/w/api', REPO_SLOTS);
    const web = slotOf('/w/web', REPO_SLOTS);
    const tie = slotOf('rooms', FEATURE_SLOTS);
    expect(floor.rooms.map((r) => [r.runId, r.slot, r.look])).toEqual([
      ['wf_0000aaaa-001', 0, { body: api, tie }],
      ['wf_0000aaaa-002', 1, { body: api, tie }],
      ['wf_0000aaaa-003', 2, { body: web, tie }],
      // The running subagent of `helped` meets in a room of its own, after the runs..
      ['crew:helped', 3, { body: web, tie }],
    ]);
    expect(Object.fromEntries(occupants(floor).map((d) => [d.sessionId, [d.at, d.robot]]))).toEqual({
      meet: [{ kind: 'room', slot: 0 }, { pose: 'still', badge: 'meeting', body: api, tie }],
      busy: [{ kind: 'room', slot: 2 }, { pose: 'typing', badge: 'typing', body: web, tie }],
      helped: [{ kind: 'room', slot: 3 }, { pose: 'still', badge: 'meeting', body: web, tie }],
    });
  });

  it('leaves at its desk a host whose run got no room, and seats one whose runs got rooms in the first', () => {
    const views = [
      view('busy', ws('/w/web', 'feat/rooms'), 'working', { runs: [1, 2, 3, 4].map((n) => live(`wf_0000aaaa-00${n}`, NOW - 10 * MIN + n)) }),
      view('late', ws('/w/api', 'feat/rooms'), 'in_meeting', { runs: [live('wf_0000aaaa-005', NOW - MIN)] }),
    ];
    const floor = buildFloorDetail(views, 'feature:rooms')!;
    expect([floor.rooms.map((r) => [r.runId, r.slot]), floor.roomsMore]).toEqual([
      [['wf_0000aaaa-001', 0], ['wf_0000aaaa-002', 1], ['wf_0000aaaa-003', 2], ['wf_0000aaaa-004', 3]],
      1,
    ]);
    expect(occupants(floor).map((d) => [d.sessionId, d.at])).toEqual([['busy', { kind: 'room', slot: 0 }], ['late', { kind: 'desk' }]]);
  });

  it('gives the same rooms, byte for byte, whatever the order of the sessions', () => {
    const views = [
      view('m1', ws('/w/api', 'feat/rooms'), 'in_meeting', { runs: [live('wf_0000aaaa-001', NOW - 5 * MIN), live('wf_0000aaaa-002', NOW - 5 * MIN)] }),
      view('m2', ws('/w/web', 'feat/rooms'), 'in_meeting', { runs: [live('wf_0000aaaa-001', NOW - 5 * MIN)] }),
      view('m3', ws('/w/web', 'feat/rooms'), 'working', { runs: [live('wf_0000aaaa-000', NOW - 5 * MIN), live('wf_0000aaaa-003', NOW - 6 * MIN)] }),
    ];
    const expected = JSON.stringify(buildFloorDetail(views, 'feature:rooms'));
    let seed = 5;
    for (let n = 0; n < 20; n++) {
      const order = [...views];
      for (let i = order.length - 1; i > 0; i--) {
        seed = (seed * 48271) % 2147483647;
        const j = seed % (i + 1);
        [order[i], order[j]] = [order[j]!, order[i]!];
      }
      expect(JSON.stringify(buildFloorDetail(order, 'feature:rooms'))).toBe(expected);
    }
    const floor = buildFloorDetail(views, 'feature:rooms')!;
    expect([floor.rooms.map((r) => [r.runId, r.hostSessionId, r.slot]), floor.roomsMore]).toEqual([
      [['wf_0000aaaa-003', 'm3', 0], ['wf_0000aaaa-000', 'm3', 1], ['wf_0000aaaa-001', 'm1', 2], ['wf_0000aaaa-002', 'm1', 3]],
      1,
    ]);
    expect(Object.fromEntries(occupants(floor).map((o) => [o.sessionId, o.at]))).toEqual({ m1: { kind: 'room', slot: 2 }, m2: { kind: 'desk' }, m3: { kind: 'room', slot: 0 } });
  });

  it('gives a run id that two sessions name one room on the floor: that of the host that started first', () => {
    const views = [
      view('m1', ws('/w/api', 'feat/rooms'), 'in_meeting', { startedAt: NOW - 2 * DAY, runs: [live('wf_0000aaaa-001', NOW - 5 * MIN)] }),
      view('m0', ws('/w/web', 'feat/rooms'), 'in_meeting', { startedAt: NOW - DAY, runs: [live('wf_0000aaaa-001', NOW - 9 * MIN)] }),
      view('m2', ws('/w/web', 'feat/rooms'), 'working', { startedAt: NOW - 2 * DAY, runs: [live('wf_0000aaaa-001', NOW - 9 * MIN)] }),
    ];
    const floor = buildFloorDetail(views, 'feature:rooms')!;
    expect([floor.rooms.map((r) => [r.runId, r.hostSessionId, r.slot]), floor.roomsMore]).toEqual([[['wf_0000aaaa-001', 'm1', 0]], 2]);
    expect(Object.fromEntries(occupants(floor).map((d) => [d.sessionId, d.at.kind]))).toEqual({ m0: 'desk', m1: 'room', m2: 'desk' });
  });

  it('opens a room for the running subagents of a host, and seats the host there while it works', () => {
    const children = [child('f1', 'Plan', false), child('r1', 'Explore')];
    const floor = buildFloorDetail([view('a', ws('/w/api', 'main'), 'working', { children })], 'repo:/w/api')!;
    expect(floor.rooms.map((r) => [r.kind, r.runId, r.hostSessionId, r.name, r.slot, r.counts, r.agents.map((a) => [a.agentId, a.type, a.running])])).toEqual([
      ['crew', 'crew:a', 'a', 'Subagents', 0, { running: 1, finished: 0 }, [['r1', 'Explore', true], ['f1', 'Plan', false]]],
    ]);
    const desk = occupants(floor)[0]!;
    expect([desk.at, desk.interns.map((i) => [i.agentId, i.inRoom])]).toEqual([{ kind: 'room', slot: 0 }, [['r1', true], ['f1', false]]]);
    // With nothing running, the room closes and the host goes back to its desk.
    const idle = buildFloorDetail([view('a', ws('/w/api', 'main'), 'working', { children: [child('f1', 'Plan', false)] })], 'repo:/w/api')!;
    expect([idle.rooms, occupants(idle)[0]!.at]).toEqual([[], { kind: 'desk' }]);
  });

  it('keeps a host that needs you, or is done, at its desk while its subagents meet', () => {
    const children = [child('r1', 'Explore')];
    for (const state of ['needs_you', 'done'] as const) {
      const floor = buildFloorDetail([view('a', ws('/w/api', 'main'), state, { children })], 'repo:/w/api')!;
      expect([state, floor.rooms.map((r) => r.runId), occupants(floor)[0]!.at]).toEqual([state, ['crew:a'], { kind: 'desk' }]);
    }
    const dozing = buildFloorDetail([view('a', ws('/w/api', 'main'), 'no_signal', { children })], 'repo:/w/api')!;
    expect(occupants(dozing)[0]!.at).toEqual({ kind: 'room', slot: 0 });
  });

  it('gives a crew a room after the runs, leaves its subagents at the desk when no room is left, and counts it among the rooms it lacks', () => {
    const views = [
      view('busy', ws('/w/web', 'feat/rooms'), 'working', { runs: [1, 2, 3, 4].map((n) => live(`wf_0000aaaa-00${n}`, NOW - 10 * MIN + n)) }),
      view('late', ws('/w/api', 'feat/rooms'), 'working', { children: [child('r1', 'Explore')] }),
    ];
    const floor = buildFloorDetail(views, 'feature:rooms')!;
    expect([floor.rooms.map((r) => r.runId), floor.roomsMore]).toEqual([['wf_0000aaaa-001', 'wf_0000aaaa-002', 'wf_0000aaaa-003', 'wf_0000aaaa-004'], 1]);
    const late = occupants(floor).find((d) => d.sessionId === 'late')!;
    expect([late.at, late.interns.map((i) => [i.agentId, i.running, i.inRoom])]).toEqual([{ kind: 'desk' }, [['r1', true, false]]]);
  });

  it('keeps two long ids that start alike apart: run agents, interns and runs', () => {
    const long = (n: number) => `${'x'.repeat(300)}${n}`;
    const v = view('h', ws('/w/api', 'main'), 'in_meeting', {
      children: [child(`c${long(1)}`, 'Explore'), child(`c${long(2)}`, 'Explore')],
      runs: [run(`wf_${long(1)}`, { agents: [runAgent(`a${long(1)}`), runAgent(`a${long(2)}`)] }), run(`wf_${long(2)}`, { startedAt: NOW - 19 * MIN })],
    });
    const floor = buildFloorDetail([v], 'repo:/w/api')!;
    const desk = occupants(floor)[0]!;
    const crew = floor.rooms.find((r) => r.kind === 'crew')!;
    const ids = [floor.rooms.filter((r) => r.kind === 'workflow').map((r) => r.runId), floor.rooms[0]!.agents.map((a) => a.agentId), crew.agents.map((a) => a.agentId), desk.interns.map((i) => i.agentId), desk.runs.map((r) => r.runId)];
    for (const pair of ids) expect([pair.length, new Set(pair).size, pair.every((id) => Array.from(id).length === 256)]).toEqual([2, 2, true]);
  });
});

describe('untrusted text', () => {
  const UNSAFE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
  const strings = (x: unknown): string[] =>
    typeof x === 'string' ? [x] : Array.isArray(x) ? x.flatMap(strings) : x && typeof x === 'object' ? Object.entries(x).flatMap(([k, v]) => [k, ...strings(v)]) : [];

  it('emits only well-formed strings, whatever lone surrogates the paths and titles carry', () => {
    const v = view('a', ws('/w/a\ud800pi', 'feat/x\udc00'), 'needs_you', { title: 'Fix \ud83d', waitReason: { kind: 'input', text: 'wh\udfffy' } });
    const out = render([v]);
    for (const s of strings(out)) expect(() => encodeURIComponent(s)).not.toThrow();
    expect(out.scene.floors[0]!.key).toBe('feature:x\uFFFD');
    expect([occupants(out.floors[0]!)[0]!.checkout.path, out.floors[0]!.pods[0]!.placard?.path]).toEqual(['/w/a\uFFFDpi', '/w/a\uFFFDpi']);
  });

  it('says a desk needs you when its reason has no text left once cleaned', () => {
    const v = view('a', ws('/w/api', 'main'), 'needs_you', { waitReason: { kind: 'input', text: '\u0007\u202E' } });
    expect(buildScene([v]).attention.needsYou[0]!.reason).toEqual({ kind: 'input', text: 'Needs you', detail: null, agent: null });
  });

  it('cleans every string it emits', () => {
    const hostile = view('h\u0007', ws('/w/a\u001bpi', 'feat/x\u202E'), 'needs_you', {
      name: 'na\u0000me',
      title: '\u2066title\r\nline',
      tmuxPane: '%1\u0007',
      waitReason: { kind: 'question', text: 'wh\u001b[2Jy', detail: 'de\u0085tail' },
      waitAgentId: 'ag\u0007',
      children: [child('ag\u0007', 'Ex\u0000plore')],
      openTool: { id: 't', label: 'Bash: \u001b[31mls', startedAt: NOW - MIN },
      lastAction: 'Bash: \u001b[31mls',
    });
    const out = render([hostile]);
    for (const s of strings(out)) expect(s).not.toMatch(UNSAFE);
    const desk = occupants(out.floors[0]!)[0]!;
    expect([out.scene.floors[0]!.key, out.scene.floors[0]!.name, desk.sessionId, desk.name, desk.title, desk.pane, desk.reason, desk.activity?.label]).toEqual([
      'feature:x', 'x', 'h', 'name', 'title line', '%1',
      { kind: 'question', text: 'wh[2Jy', detail: 'de tail', agent: { id: 'ag', type: 'Explore' } },
      'Bash: [31mls',
    ]);
  });
});

describe('untrusted text in rooms, interns, runs and summaries', () => {
  const UNSAFE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
  const strings = (x: unknown): string[] =>
    typeof x === 'string' ? [x] : Array.isArray(x) ? x.flatMap(strings) : x && typeof x === 'object' ? Object.entries(x).flatMap(([k, v]) => [k, ...strings(v)]) : [];

  it('cleans every string and caps every id', () => {
    const long = 'x'.repeat(300);
    const hostile = view('h', ws('/w/api', 'main'), 'in_meeting', {
      summary: { text: 'sum\u202Emary', at: NOW - MIN, inputHash: '0123456789abcdef' },
      children: [{ ...child(`c\u0007${long}`, 'Ex\u0000plore'), description: 'look\u001b[2J' }],
      runs: [
        run(`wf_\u0007${long}`, {
          name: 'na\u0085me',
          summary: 'su\u200Emmary',
          phases: ['Pl\u0007an', '\u2066'],
          currentPhase: 'Pl\u0007an',
          agents: [runAgent(`a\u0007${long}`, { label: 'la\u0000bel', phase: 'Re\u0007view', type: 'ty\u202Epe' })],
        }),
      ],
    });
    const out = render([hostile]);
    for (const s of strings(out)) expect(s).not.toMatch(UNSAFE);
    const floor = out.floors[0]!;
    const room = floor.rooms[0]!;
    const desk = occupants(floor)[0]!;
    expect([room.runId, room.agents[0]!.agentId, desk.interns[0]!.agentId, desk.runs[0]!.runId].map((id) => Array.from(id).length)).toEqual([256, 256, 256, 256]);
    expect([room.name, room.topic, room.summary, room.phases, room.agents[0]!.label, room.agents[0]!.phase, room.agents[0]!.type]).toEqual([
      'na me', 'na me', 'summary', [{ title: 'Plan', state: 'current' }], 'label', 'Review', 'type',
    ]);
    expect([desk.summary?.text, desk.interns[0]!.type, desk.interns[0]!.label, desk.runs[0]!.name]).toEqual(['summary', 'Explore', 'look[2J', 'na me']);
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

it('keeps agent metrics on the host after a workflow room closes and cleans the model text', () => {
  const telemetry = { model: 'claude-\u0000sonnet', usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUSD: null, startedAt: NOW - MIN, endedAt: NOW, complete: true };
  const floor = buildFloorDetail([view('h', ws('/w/api', 'main'), 'done', {
    runs: [run('wf_0000aaaa-001', { status: 'completed', endedAt: NOW, agents: [runAgent('a1', { running: false, telemetry })] })],
  })], 'repo:/w/api')!;
  expect(floor.rooms).toEqual([]);
  const summary = occupants(floor)[0]!.runs[0]!;
  expect(summary.counts).toEqual({ running: 0, finished: 1 });
  expect(summary.agents?.[0]?.telemetry).toMatchObject({ model: 'claude-sonnet', usage: { inputTokens: 10, outputTokens: 20 } });
});
