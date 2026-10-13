import { OrthographicCamera } from 'three';
import { MEETING_AGENTS_MAX, layoutFloor } from '../../../src/scene/layout';
import {
  SCENE_VERSION,
  type Desk,
  type FloorDetail,
  type GridRect,
  type Island,
  type MeetingAgent,
  type MeetingRoom,
  type Robot,
  type ShownState,
} from '../../../src/scene/types';
import { HOME_AZIMUTH, cameraOffset, floorCenter, frustumFor } from '../../renderer/world';

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
}

export interface IslandSpec {
  key: string;
  repo: string;
  color: number;
  /** Feature colour slot of the ties; null on a department floor. */
  tie: number | null;
  branch?: string | null;
  worktree?: boolean;
  desks: DeskSpec[];
}

export function makeDesk(spec: DeskSpec, rect: Desk['rect'], body: number, tie: number | null): Desk {
  const look = ROBOT_OF[spec.state];
  return {
    sessionId: spec.id,
    rect,
    name: spec.name ?? spec.id,
    title: null,
    state: spec.state,
    since: 1000,
    reason: null,
    activity: null,
    agentsRunning: spec.agents ?? 0,
    summary: null,
    interns: [],
    internsMore: 0,
    away: false,
    runs: [],
    location: spec.cloud ? 'cloud' : 'local',
    pane: null,
    focusable: false,
    robot: look ? { ...look, body, tie } : null,
  };
}

export interface RoomSpec {
  runId: string;
  /** The host desk's session id: its island gives the room's colours. */
  host: string;
  name?: string | null;
  summary?: string | null;
  phases?: MeetingRoom['phases'];
  /** Running agents (`<runId>-a0` …), then finished ones. */
  running?: number;
  finished?: number;
  /** The host sits at the head of the table, and its desk is away. */
  seated?: boolean;
}

/** The phases of the demo's run, in its Build phase. */
export const PHASES: MeetingRoom['phases'] = [
  { title: 'Plan', state: 'done' },
  { title: 'Build', state: 'current' },
  { title: 'Review', state: 'upcoming' },
  { title: 'Ship', state: 'upcoming' },
];

export function makeRoom(spec: RoomSpec, rect: GridRect, body: number, tie: number | null): MeetingRoom {
  const running = spec.running ?? 0;
  const finished = spec.finished ?? 0;
  const agent = (k: number, live: boolean): MeetingAgent => ({
    agentId: `${spec.runId}-a${k}`,
    label: `Agent ${k}`,
    phase: live ? 'Build' : 'Plan',
    type: 'workflow-subagent',
    running: live,
  });
  const agents = [...Array.from({ length: running }, (_, k) => agent(k, true)), ...Array.from({ length: finished }, (_, k) => agent(running + k, false))];
  return {
    runId: spec.runId,
    hostSessionId: spec.host,
    name: spec.name === undefined ? 'checkout-verify' : spec.name,
    summary: spec.summary === undefined ? 'Verify split payments end to end' : spec.summary,
    phases: spec.phases ?? PHASES,
    counts: { running, finished },
    agents: agents.slice(0, MEETING_AGENTS_MAX),
    look: { body, tie },
    host: spec.seated ? { pose: 'still', badge: 'meeting', body, tie } : null,
    rect,
  };
}

/** A floor laid out by the real layout algorithm, as the server would send it, with a meeting room per room spec. */
export function makeFloor(islands: IslandSpec[], key = 'feature:checkout-v2', rooms: RoomSpec[] = []): FloorDetail {
  const layout = layoutFloor(
    islands.map((i) => ({ key: i.key, deskIds: i.desks.map((d) => d.id) })),
    rooms.map((r) => r.runId),
  );
  const away = new Set(rooms.filter((r) => r.seated).map((r) => r.host));
  const placed: Island[] = islands.map((spec, n) => {
    const slot = layout.islands[n]!;
    return {
      key: spec.key,
      repo: spec.repo,
      branch: spec.branch === undefined ? 'feat/checkout-v2' : spec.branch,
      worktree: spec.worktree ?? false,
      path: spec.key,
      color: spec.color,
      rect: slot.rect,
      desks: spec.desks.map((d, k) => ({ ...makeDesk(d, slot.desks[k]!.rect, spec.color, spec.tie), away: away.has(d.id) })),
    };
  });
  const hostIsland = (id: string) => islands.find((i) => i.desks.some((d) => d.id === id)) ?? islands[0]!;
  const counts: FloorDetail['counts'] = {};
  for (const island of placed) for (const desk of island.desks) counts[desk.state] = (counts[desk.state] ?? 0) + 1;
  return {
    version: SCENE_VERSION,
    key,
    number: 1,
    kind: key.startsWith('feature:') ? 'feature' : 'department',
    name: key.replace(/^[a-z]+:/, ''),
    repos: [...new Set(islands.map((i) => i.repo))].sort(),
    counts,
    shutters: false,
    openedAt: 1000,
    size: layout.size,
    core: layout.core,
    islands: placed,
    rooms: rooms.map((r, n) => makeRoom(r, layout.rooms[n]!.rect, hostIsland(r.host).color, hostIsland(r.host).tie)),
    roomsMore: 0,
  };
}

/** Three islands and one desk in each of the seven states the floor can show. */
export function checkoutIslands(): IslandSpec[] {
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
  return makeFloor(checkoutIslands());
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
  return makeFloor(checkoutIslands(), undefined, rooms);
}

/** Every desk of a floor, islands in order. */
export function desksOf(floor: FloorDetail): Desk[] {
  return floor.islands.flatMap((i) => i.desks);
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
