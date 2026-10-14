/**
 * Who sits where on one floor of the fixed plan (layout.ts layoutPlan). Server-only: it builds on core/view.ts.
 * Seating is advanced, never rebuilt: sessions keep their desks, lounge seats and rooms while they stay, so a floor changes
 * only where somebody came or went. Pure and deterministic: the same seating and floor, in any order of its sessions, give
 * the same next seating.
 */
import type { WorkflowRun } from '../core/types.js';
import type { Floor, SessionView } from '../core/view.js';
import { liveRun } from '../core/reducer.js';
import { byCodeUnit, islandKeyOf } from '../core/view.js';
import { BLOCK_DESKS, BLOCKS_MAX, LOUNGE_SEATS, POD_DESKS, ROOM_COLS_MAX, ROOMS_PER_COL } from './layout.js';
import { capKey } from './text.js';

/** Who sits where on one floor. Stored as JSON in the floors table. */
export interface Seating {
  /** 1..BLOCKS_MAX. */
  blocks: number;
  /** 1..ROOM_COLS_MAX. */
  roomCols: number;
  /** Session id by desk index (blocks * BLOCK_DESKS entries); null: a free desk. */
  desks: (string | null)[];
  /** Session id by lounge seat (LOUNGE_SEATS entries); null: a free seat. */
  lounge: (string | null)[];
  /** Room key (the run id through capKey) by room slot (roomCols * ROOMS_PER_COL entries); null: an empty room. */
  rooms: (string | null)[];
}

/** The key of a session's crew: the room of its running subagents. A workflow run id never has this form. */
export const CREW_PREFIX = 'crew:';

/** The crew of a session: its running subagents as one run, named for what it is. Null while none runs. */
function crewRun(host: SessionView): WorkflowRun | null {
  if (!host.children.some((c) => c.running)) return null;
  return {
    id: CREW_PREFIX + host.id,
    name: 'Subagents',
    summary: null,
    phases: [],
    currentPhase: null,
    status: 'running',
    onDisk: false,
    startedAt: host.startedAt,
    endedAt: null,
    agents: host.children.map((c) => ({ id: c.id, label: c.description, phase: null, type: c.type, running: c.running, startedAt: c.updatedAt, updatedAt: c.updatedAt })),
    agentsFinished: 0,
  };
}

/** A live run of a session on the floor that can hold a room: a workflow run, or the crew of its running subagents. */
export interface RoomRun {
  run: WorkflowRun;
  host: SessionView;
  /** capKey(run.id): one room per key on a floor. */
  key: string;
  /** True for the crew of the host's running subagents, false for a workflow run. */
  crew: boolean;
}

/** One block, one room column, nobody seated. */
export function emptySeating(): Seating {
  return {
    blocks: 1,
    roomCols: 1,
    desks: Array<string | null>(BLOCK_DESKS).fill(null),
    lounge: Array<string | null>(LOUNGE_SEATS).fill(null),
    rooms: Array<string | null>(ROOMS_PER_COL).fill(null),
  };
}

/** Start order: by start time, then id. */
const byStartOrder = (a: SessionView, b: SessionView): number => a.startedAt - b.startedAt || byCodeUnit(a.id, b.id);

/** By the time the session's state began, then id: the order sessions became idle, or dormant. */
const bySince = (a: SessionView, b: SessionView): number => a.effectiveSince - b.effectiveSince || byCodeUnit(a.id, b.id);

/**
 * The floor's live runs and crews, one per key (the host that started first, then by id), in room order: runs before
 * crews, then run start, then run id, then host id.
 */
export function roomRunsOf(floor: Floor): RoomRun[] {
  const first = new Map<string, RoomRun>();
  for (const host of floor.sessions) {
    const crew = crewRun(host);
    for (const run of crew ? [...host.runs.filter(liveRun), crew] : host.runs.filter(liveRun)) {
      const key = capKey(run.id);
      const held = first.get(key);
      if (!held || (host.startedAt - held.host.startedAt || byCodeUnit(host.id, held.host.id)) < 0) first.set(key, { run, host, key, crew: run === crew });
    }
  }
  return [...first.values()].sort((a, b) => Number(a.crew) - Number(b.crew) || a.run.startedAt - b.run.startedAt || byCodeUnit(a.run.id, b.run.id) || byCodeUnit(a.host.id, b.host.id));
}

/**
 * The desk a session arriving with checkout `checkout` takes without moving anybody, or -1: a free desk in a pod where a
 * session of its checkout sits (the first in desk order), else the first desk of the first empty pod, else the first free desk.
 */
function freeDesk(desks: readonly (string | null)[], checkout: string, checkoutOf: ReadonlyMap<string, string>): number {
  const pods = new Set<number>();
  desks.forEach((id, i) => {
    if (id !== null && checkoutOf.get(id) === checkout) pods.add(Math.floor(i / POD_DESKS));
  });
  const near = desks.findIndex((id, i) => id === null && pods.has(Math.floor(i / POD_DESKS)));
  if (near !== -1) return near;
  for (let p = 0; p * POD_DESKS < desks.length; p++) {
    if (desks.slice(p * POD_DESKS, (p + 1) * POD_DESKS).every((id) => id === null)) return p * POD_DESKS;
  }
  return desks.indexOf(null);
}

/** The desk of the seated dormant session that has been dormant longest (then by id), or -1. */
function longestDormant(desks: readonly (string | null)[], on: ReadonlyMap<string, SessionView>): number {
  let found = -1;
  desks.forEach((id, i) => {
    const v = id === null ? undefined : on.get(id);
    if (v?.effectiveState !== 'dormant') return;
    if (found === -1 || bySince(v, on.get(desks[found]!)!) < 0) found = i;
  });
  return found;
}

const sameList = (a: readonly (string | null)[], b: readonly (string | null)[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** Advances one floor's seating to its sessions now (rules S1–S8). Returns `prev` itself when nothing changes. Pure and idempotent. */
export function seatFloor(prev: Seating | null, floor: Floor): Seating {
  const from = prev ?? emptySeating();
  const on = new Map(floor.sessions.map((v) => [v.id, v]));
  const checkoutOf = new Map(floor.sessions.map((v) => [v.id, islandKeyOf(v)]));
  const arrivals = [...floor.sessions].sort(byStartOrder);
  let blocks = from.blocks;

  // S1: a desk whose session left the floor is free.
  const desks = from.desks.map((id) => (id !== null && on.has(id) ? id : null));
  const seated = (): Set<string> => new Set(desks.filter((id): id is string => id !== null));

  // S2: sessions that are not dormant take a desk, or a dormant session's, or a new block's; at the cap they wait.
  for (const v of arrivals) {
    if (v.effectiveState === 'dormant' || seated().has(v.id)) continue;
    const checkout = checkoutOf.get(v.id)!;
    let desk = freeDesk(desks, checkout, checkoutOf);
    if (desk === -1) desk = longestDormant(desks, on);
    if (desk === -1 && blocks < BLOCKS_MAX) {
      blocks += 1;
      desks.push(...Array<string | null>(BLOCK_DESKS).fill(null));
      desk = freeDesk(desks, checkout, checkoutOf);
    }
    if (desk !== -1) desks[desk] = v.id;
  }

  // S3: dormant sessions take a free desk only: they never move anybody and never grow the plan.
  for (const v of arrivals) {
    if (v.effectiveState !== 'dormant' || seated().has(v.id)) continue;
    const desk = freeDesk(desks, checkoutOf.get(v.id)!, checkoutOf);
    if (desk !== -1) desks[desk] = v.id;
  }

  // S4: a lounge seat is kept while its session has a desk and stays idle.
  const atDesk = seated();
  const idle = (id: string): boolean => atDesk.has(id) && on.get(id)!.effectiveState === 'idle';
  const lounge = from.lounge.map((id) => (id !== null && idle(id) ? id : null));

  // S5: seated idle sessions take the free seats in the order they became idle.
  const resting = new Set(lounge);
  for (const v of floor.sessions.filter((s) => idle(s.id) && !resting.has(s.id)).sort(bySince)) {
    const seat = lounge.indexOf(null);
    if (seat === -1) break;
    lounge[seat] = v.id;
  }

  // S6: a room whose run is no longer live empties.
  const runs = roomRunsOf(floor);
  const live = new Set(runs.map((r) => r.key));
  const rooms = from.rooms.map((key) => (key !== null && live.has(key) ? key : null));
  let roomCols = from.roomCols;

  // S7: live runs take the first empty room, opening a second room column if need be.
  for (const r of runs) {
    if (rooms.includes(r.key)) continue;
    if (!rooms.includes(null) && roomCols < ROOM_COLS_MAX) {
      roomCols += 1;
      rooms.push(...Array<string | null>(ROOMS_PER_COL).fill(null));
    }
    const slot = rooms.indexOf(null);
    if (slot !== -1) rooms[slot] = r.key;
  }

  // S8: the same value is the same object.
  if (prev && blocks === prev.blocks && roomCols === prev.roomCols && sameList(desks, prev.desks) && sameList(lounge, prev.lounge) && sameList(rooms, prev.rooms)) {
    return prev;
  }
  return { blocks, roomCols, desks, lounge, rooms };
}

/** A whole number in 1..max. */
const isCount = (n: unknown, max: number): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= max;

/** `length` entries, each a string or null, no string twice. */
function isIds(list: unknown, length: number): list is (string | null)[] {
  if (!Array.isArray(list) || list.length !== length) return false;
  const ids = list.filter((x): x is string => typeof x === 'string');
  return list.every((x) => x === null || typeof x === 'string') && new Set(ids).size === ids.length;
}

/**
 * A stored value read back; null unless it is a valid Seating: types, ranges and array lengths; no session id twice within
 * `desks`; no session id twice within `lounge`; every lounge id also in `desks`; no key twice within `rooms`.
 */
export function parseSeating(text: string): Seating | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { blocks, roomCols, desks, lounge, rooms } = raw as Record<string, unknown>;
  if (!isCount(blocks, BLOCKS_MAX) || !isCount(roomCols, ROOM_COLS_MAX)) return null;
  if (!isIds(desks, blocks * BLOCK_DESKS) || !isIds(lounge, LOUNGE_SEATS) || !isIds(rooms, roomCols * ROOMS_PER_COL)) return null;
  if (lounge.some((id) => id !== null && !desks.includes(id))) return null;
  return { blocks, roomCols, desks: [...desks], lounge: [...lounge], rooms: [...rooms] };
}
