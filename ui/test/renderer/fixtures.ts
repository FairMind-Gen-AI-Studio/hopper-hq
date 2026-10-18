import { OrthographicCamera } from 'three';
import { BLOCK_DESKS, INTERNS_MAX, LOUNGE_SEATS, MEETING_AGENTS_MAX, ROOMS_PER_COL, SEATS_MAX } from '../../../src/scene/layout';
import {
  SCENE_VERSION,
  type Checkout,
  type FloorDetail,
  type GridRect,
  type Intern,
  type MeetingAgent,
  type MeetingRoom,
  type Occupant,
  type Place,
  type PodDesk,
  type Robot,
  type SceneLeisure,
  type ShownState,
} from '../../../src/scene/types';
import { HOME_AZIMUTH, cameraOffset, floorCenter, frustumFor } from '../../renderer/world';
import { podsFor } from '../helpers/plan';

/** The robot the scene builder gives each state (outline §2.6); dormant desks have none. */
export const ROBOT_OF: Record<ShownState, Pick<Robot, 'pose' | 'badge'> | null> = {
  working: { pose: 'typing', badge: 'typing' },
  needs_you: { pose: 'waving', badge: 'needs' },
  done: { pose: 'holding', badge: 'done' },
  in_meeting: { pose: 'still', badge: 'meeting' },
  no_signal: { pose: 'still', badge: 'clock' },
  idle: { pose: 'resting', badge: null },
  dormant: null,
};

export interface DeskSpec {
  id: string;
  state: ShownState;
  name?: string;
  agents?: number;
  cloud?: boolean;
  interns?: Intern[];
  /** Its lounge seat, while it rests there. */
  lounge?: number;
}

export interface CheckoutSpec {
  key: string;
  repo: string;
  color: number;
  /** Feature colour slot of the ties; null on a department floor. */
  tie: number | null;
  branch?: string | null;
  worktree?: boolean;
  desks: DeskSpec[];
}

export function makeOccupant(spec: DeskSpec, body: number, tie: number | null, checkout: Checkout, at: Place): Occupant {
  const look = ROBOT_OF[spec.state];
  return {
    sessionId: spec.id,
    agentKind: 'claude-code',
    name: spec.name ?? spec.id,
    title: null,
    state: spec.state,
    since: 1000,
    reason: null,
    activity: null,
    smoking: false,
    agentsRunning: spec.agents ?? 0,
    summary: null,
    interns: spec.interns ?? [],
    internsMore: 0,
    runs: [],
    location: spec.cloud ? 'cloud' : 'local',
    pane: null,
    focusable: false,
    robot: look ? { ...look, body, tie } : null,
    at,
    checkout,
  };
}

/** The checkout of a spec: its repo, branch and worktree flag, and its key as the path. */
export function checkoutOf(spec: CheckoutSpec): Checkout {
  return { repo: spec.repo, branch: spec.branch === undefined ? 'feat/checkout-v2' : spec.branch, worktree: spec.worktree ?? false, path: spec.key };
}

export interface RoomSpec {
  runId: string;
  /** The host's session id: its checkout gives the room's colours. */
  host: string;
  name?: string | null;
  summary?: string | null;
  phases?: MeetingRoom['phases'];
  /** Running agents (`<runId>-a0` …), then finished ones. */
  running?: number;
  finished?: number;
  /** The host sits at the head of the table. */
  seated?: boolean;
  /** Its room slot; its place in the list of room specs by default. */
  slot?: number;
}

/** A finished intern waiting for a running sibling, at this leisure, over at the break area rather than its desk. */
export function leisureIntern(agentId: string, leisure: SceneLeisure): Intern {
  return { agentId, type: 'Explore', label: null, running: false, inRoom: false, smoking: false, leisure };
}

/** A finished room agent waiting for a running sibling, at this leisure, over at the break area rather than the table. */
export function leisureAgent(agentId: string, leisure: SceneLeisure): MeetingAgent {
  return { agentId, label: null, phase: null, type: 'workflow-subagent', running: false, smoking: false, leisure };
}

/** The phases of the demo's run, in its Build phase. */
export const PHASES: MeetingRoom['phases'] = [
  { title: 'Plan', state: 'done' },
  { title: 'Build', state: 'current' },
  { title: 'Review', state: 'upcoming' },
  { title: 'Ship', state: 'upcoming' },
];

export function makeRoom(spec: RoomSpec, rect: GridRect, body: number, tie: number | null, slot = 0): MeetingRoom {
  const running = spec.running ?? 0;
  const finished = spec.finished ?? 0;
  const agent = (k: number, live: boolean): MeetingAgent => ({
    agentId: `${spec.runId}-a${k}`,
    label: `Agent ${k}`,
    phase: live ? 'Build' : 'Plan',
    type: 'workflow-subagent',
    running: live,
    smoking: false,
    leisure: null,
  });
  const agents = [...Array.from({ length: running }, (_, k) => agent(k, true)), ...Array.from({ length: finished }, (_, k) => agent(running + k, false))];
  return {
    kind: 'workflow',
    runId: spec.runId,
    hostSessionId: spec.host,
    name: spec.name === undefined ? 'checkout-verify' : spec.name,
    summary: spec.summary === undefined ? 'Verify split payments end to end' : spec.summary,
    phases: spec.phases ?? PHASES,
    counts: { running, finished },
    agents: agents.slice(0, MEETING_AGENTS_MAX),
    look: { body, tie },
    rect,
    slot,
  };
}

/**
 * A floor laid out by the real layout algorithms, as the server would send it, with a meeting room per room spec in its
 * slot. On the plan, each checkout takes pods of its own (helpers/plan.ts); a seated host sits at the head of its room,
 * a session with a lounge seat rests there, and a dormant one is gone. The `unseated` wait without a desk, in the first
 * checkout's colours.
 */
export function makeFloor(checkouts: CheckoutSpec[], key = 'feature:checkout-v2', rooms: RoomSpec[] = [], unseated: DeskSpec[] = []): FloorDetail {
  const hostCheckout = (id: string) => checkouts.find((i) => i.desks.some((d) => d.id === id)) ?? checkouts[0]!;
  const slotOf = (r: RoomSpec, n: number) => r.slot ?? n;
  const heads = new Map(rooms.flatMap((r, n): Array<[string, number]> => (r.seated ? [[r.host, slotOf(r, n)]] : [])));
  const atOf = (d: DeskSpec): Place => {
    if (d.state === 'dormant') return { kind: 'gone' };
    const slot = heads.get(d.id);
    if (slot !== undefined) return { kind: 'room', slot };
    return d.lounge === undefined ? { kind: 'desk' } : { kind: 'lounge', seat: d.lounge };
  };
  const { plan, pods } = podsFor(
    checkouts.map((i) => ({ color: i.color, placard: checkoutOf(i), occupants: i.desks.map((d) => makeOccupant(d, i.color, i.tie, checkoutOf(i), atOf(d))) })),
    rooms.some((r, n) => slotOf(r, n) >= ROOMS_PER_COL) ? 2 : 1,
  );
  const first = checkouts[0]!;
  const waiting = unseated.map((d) => makeOccupant(d, first.color, first.tie, checkoutOf(first), { kind: 'gone' }));
  const counts: FloorDetail['counts'] = {};
  for (const o of [...pods.flatMap((p) => p.desks.flatMap((d) => (d.occupant ? [d.occupant] : []))), ...waiting]) counts[o.state] = (counts[o.state] ?? 0) + 1;
  return {
    version: SCENE_VERSION,
    key,
    number: 1,
    kind: key.startsWith('feature:') ? 'feature' : 'department',
    name: key.replace(/^[a-z]+:/, ''),
    repos: [...new Set(checkouts.map((i) => i.repo))].sort(),
    counts,
    shutters: false,
    openedAt: 1000,
    size: plan.size,
    core: plan.core,
    rooms: rooms.map((r, n) => makeRoom(r, plan.rooms[slotOf(r, n)]!, hostCheckout(r.host).color, hostCheckout(r.host).tie, slotOf(r, n))),
    roomsMore: 0,
    pods,
    lounge: { rect: plan.lounge, seats: LOUNGE_SEATS },
    roomSlots: plan.rooms,
    breakArea: plan.breakArea,
    unseated: waiting,
    unseatedMore: 0,
  };
}

/** Three checkouts and one desk in each of the seven states the floor can show. */
export function checkoutSpecs(): CheckoutSpec[] {
  return [
    {
      key: '/demo/storefront-web',
      repo: 'storefront-web',
      color: 2,
      tie: 4,
      desks: [
        { id: 'sw-a1', state: 'working', agents: 1 },
        { id: 'sw-b2', state: 'done' },
        { id: 'sw-c3', state: 'idle' },
      ],
    },
    {
      key: '/demo/orders-api/.worktrees/checkout-v2',
      repo: 'orders-api',
      color: 1,
      tie: 4,
      worktree: true,
      desks: [
        { id: 'oa-c3', state: 'needs_you' },
        { id: 'oa-d5', state: 'no_signal' },
      ],
    },
    {
      key: '/demo/payments-svc',
      repo: 'payments-svc',
      color: 1,
      tie: 4,
      desks: [
        { id: 'ps-d4', state: 'in_meeting', agents: 2 },
        { id: 'ps-f7', state: 'dormant' },
      ],
    },
  ];
}

export function checkoutFloor(): FloorDetail {
  return makeFloor(checkoutSpecs());
}

/**
 * Two runs on the checkout floor: ps-d4's, with ps-d4 in the meeting at the head of the table, and sw-a1's, whose
 * agents outnumber the seats while sw-a1 works at its desk.
 */
export function checkoutRooms(): RoomSpec[] {
  return [
    { runId: 'wf_0000aaaa-001', host: 'ps-d4', running: 3, finished: 2, seated: true },
    { runId: 'wf_0000aaaa-002', host: 'sw-a1', name: 'docs-sweep', summary: null, phases: [], running: 10 },
  ];
}

export function roomFloor(rooms = checkoutRooms()): FloorDetail {
  return makeFloor(checkoutSpecs(), undefined, rooms);
}

/**
 * The fullest floor (design §7.1): four checkouts of BLOCK_DESKS sessions take every desk of four blocks. Each checkout's
 * first session hosts a run at the head of its room's table, with SEATS_MAX agents at it, so that every room slot is open;
 * its next two rest in the lounge, which fills; the others work, need you, are done or lost their signal, but for the
 * very last, dormant, whose desk has its nameplate. INTERNS_MAX interns fly over every other desk, every one of them
 * running, and every running intern and room agent, and every occupant whose own open tool is a smoke test (`working` or
 * `no_signal`: `Occupant.smoking`'s own doc, src/scene/types.ts), holds a cigar — the real worst case for the cigar's
 * added meshes, not an arbitrary sample, so that the budget below is pinned to what a real floor could actually cost.
 * Every intern and room agent is also typed to a Fairmind plugin, so every one of them wears the Fairmind badge
 * (src/scene/fairmind.ts isFairmindAgent, ui/renderer/fairmind-badge.ts): the real worst case for its added meshes too.
 */
export function fullestFloor(): FloorDetail {
  const busy: ShownState[] = ['working', 'needs_you', 'done', 'no_signal'];
  const interns = (id: string): Intern[] =>
    Array.from({ length: INTERNS_MAX }, (_, k) => ({ agentId: `${id}-i${k}`, type: 'fairmind-coding:Software Engineer', label: 'Find the callers', running: true, inRoom: false, smoking: true, leisure: null }));
  const repos = ['storefront-web', 'orders-api', 'payments-svc', 'search-svc'];
  const checkouts = repos.map((repo, r): CheckoutSpec => ({
    key: `/demo/${repo}`,
    repo,
    color: r,
    tie: 4,
    desks: Array.from({ length: BLOCK_DESKS }, (_, n): DeskSpec => {
      const id = `${repo}-${n}`;
      if (n === 0) return { id, state: 'in_meeting', agents: SEATS_MAX, interns: interns(id) };
      if (n <= 2) return { id, state: 'idle', lounge: 2 * r + n - 1, interns: interns(id) };
      if (r === repos.length - 1 && n === BLOCK_DESKS - 1) return { id, state: 'dormant' };
      return { id, state: busy[n % busy.length]!, interns: interns(id) };
    }),
  }));
  const rooms = checkouts.map((c, slot): RoomSpec => ({ runId: `wf_0000aaaa-00${slot + 1}`, host: c.desks[0]!.id, running: SEATS_MAX, finished: 4, seated: true, slot }));
  const floor = makeFloor(checkouts, 'feature:checkout-v2', rooms);
  for (const pod of floor.pods) {
    for (const desk of pod.desks) {
      if (desk.occupant && (desk.occupant.state === 'working' || desk.occupant.state === 'no_signal')) desk.occupant.smoking = true;
    }
  }
  for (const room of floor.rooms) for (const agent of room.agents) {
    agent.smoking = agent.running;
    agent.type = 'fairmind-coding:QA Engineer';
  }
  return floor;
}

/** Every session at a desk, with its desk, in desk order. */
export function seatsOf(floor: FloorDetail): Array<{ desk: PodDesk; occupant: Occupant }> {
  return floor.pods.flatMap((p) => p.desks.flatMap((desk) => (desk.occupant ? [{ desk, occupant: desk.occupant }] : [])));
}

/** The desk and the occupant of a session at a desk. */
export function seatOf(floor: FloorDetail, sessionId: string): { desk: PodDesk; occupant: Occupant } {
  const seat = seatsOf(floor).find((s) => s.occupant.sessionId === sessionId);
  if (!seat) throw new Error(`no desk for ${sessionId}`);
  return seat;
}

/** The floor view's camera at home: orthographic, looking at the floor's centre from the south-east, fitted to it. */
export function isoCamera(size: { w: number; h: number }, aspect = 1.6): OrthographicCamera {
  const f = frustumFor(size, aspect);
  const camera = new OrthographicCamera(f.left, f.right, f.top, f.bottom, 0.1, 300);
  const c = floorCenter(size);
  const o = cameraOffset(HOME_AZIMUTH);
  camera.position.set(c.x + o.x, o.y, c.z + o.z);
  camera.lookAt(c.x, 0, c.z);
  camera.updateMatrixWorld();
  return camera;
}
