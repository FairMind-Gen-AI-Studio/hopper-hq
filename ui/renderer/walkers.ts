/**
 * Where each robot on a floor is going, and how it gets there (design §5.2, §5.3). Pure: no three.js objects, no DOM
 * and no clock; times are passed in, on the view's clock. A walker is one robot's way to its place: a session's robot,
 * a workflow agent or an intern. Robots on foot follow the walk grid (walk.ts); interns fly straight over everything.
 * New robots come out of the elevator and robots no longer on the floor leave by it, a burst of them BURST_GAP_MS apart;
 * the elevator doors move for them (motion.doorOpen). Standing up from a desk's chair to its stand, and sitting back
 * down, is one straight step off the grid: findPath's way between them goes round the chair.
 */
import { BURST_GAP_MS, DOOR_HOLD_MS, DOOR_MS, FLY_SPEED, WALK_SPEED, doorOpen, startTrip, tripAt, tripEnd, type Trip } from './motion';
import { findPath, type WalkGrid } from './walk';
import type { Point, Spot } from './world';

/** On foot over the walk grid, or flying straight (interns). */
export type Gait = 'walk' | 'fly';

/** A robot's place on the floor, as a floor update gives it. */
export interface Wanted {
  /** The robot's key: one per robot on the floor. */
  id: string;
  gait: Gait;
  /** Names the place: a desk's chair or stand, a lounge seat, a room's seat. Its spot moves with the furniture when the plan grows. */
  place: string;
  /** The place's spot. */
  to: Spot;
  /** Places that share it are one straight step apart: a desk's chair and its stand. */
  near?: string;
}

export interface Walker {
  gait: Gait;
  /** The place it is going to, or is at; empty while it leaves. */
  place: string;
  /** Its place's `near`; null when it has none. */
  near: string | null;
  /** Where it is going: its place's spot, or the elevator's while it leaves. */
  to: Spot;
  /** Its trip there; null once it is there. */
  trip: Trip | null;
  /** Its trip is one straight step from a place near its own: up from its chair, or back down. */
  step: boolean;
  /** Inside the elevator until its trip starts. */
  arriving: boolean;
  /** Off the floor once it reaches the elevator. */
  leaving: boolean;
}

/**
 * Where the robots of a burst come out of the elevator, in turn: across its spot, in metres, so that no two robots of a
 * burst come out at one place (a robot is about 0.5 m wide).
 */
export const ELEVATOR_LANES = [0, -0.6, 0.6] as const;

/** What walkers find their way by: the floor's walk grid, and the elevator spot, where robots come and go. */
export interface Ways {
  grid: WalkGrid;
  elevator: Spot;
}

export interface Moves {
  walkers: Map<string, Walker>;
  /**
   * When the walkers pass the elevator doors from now on: each one still inside as it comes out, each leaver as it gets
   * there. A robot dropped inside the elevator, or turned back on its way out, has none.
   */
  passes: number[];
}

/**
 * The walkers after a floor update at `now`: those wanted in the order of `wanted`, then those leaving in the order of
 * `prev`. A robot
 * - new to the floor comes out of the elevator: the k-th of the update (k from 0) sets off DOOR_MS + k * BURST_GAP_MS
 *   from now, once the doors are open, from the k-th of ELEVATOR_LANES in turn;
 * - whose place changed, or that was leaving, goes there from where it is now: one straight step from a place near it,
 *   at rest or on such a step, else over the grid;
 * - whose place stayed keeps its trip, or, at rest, its place's spot, which the furniture may have moved;
 * - no longer wanted walks to the elevator to leave: the k-th of the update sets off k * BURST_GAP_MS from now. One still
 *   inside the elevator is gone at once.
 *
 * regrid (a new walk grid): every trip under way is found again from where its robot is. snap: every robot is at its
 * place at once, and those not wanted are gone. Pure: `prev` stays as it is, and a walker that does not change is the
 * same object.
 */
export function moveAll(prev: ReadonlyMap<string, Walker>, wanted: readonly Wanted[], ways: Ways, now: number, opts: { snap?: boolean; regrid?: boolean } = {}): Moves {
  const walkers = new Map<string, Walker>();
  let arrivals = 0;
  for (const w of wanted) {
    if (walkers.has(w.id)) continue;
    const p = prev.get(w.id);
    if (opts.snap) walkers.set(w.id, { gait: w.gait, place: w.place, near: w.near ?? null, to: w.to, trip: null, step: false, arriving: false, leaving: false });
    else if (!p) {
      const from = { x: ways.elevator.x + ELEVATOR_LANES[arrivals % ELEVATOR_LANES.length]!, z: ways.elevator.z };
      const trip = startTrip(from, route(ways, w.gait, from, w.to), now + DOOR_MS + arrivals++ * BURST_GAP_MS, speedOf(w.gait));
      walkers.set(w.id, { gait: w.gait, place: w.place, near: w.near ?? null, to: w.to, trip, step: false, arriving: true, leaving: false });
    } else if (p.leaving || p.place !== w.place || (p.trip && (opts.regrid || !sameSpot(p.to, w.to)))) walkers.set(w.id, head(ways, p, w, now));
    else walkers.set(w.id, sameSpot(p.to, w.to) && p.to.facing === w.to.facing ? p : { ...p, to: w.to });
  }
  if (opts.snap) return { walkers, passes: [] };
  let departures = 0;
  for (const [id, p] of prev) {
    if (walkers.has(id) || (p.arriving && p.trip && now < p.trip.start)) continue;
    if (p.leaving && !opts.regrid) {
      walkers.set(id, p);
      continue;
    }
    // A leaver on a new grid keeps the time it sets off at; anyone else joins the burst.
    const start = p.leaving ? Math.max(now, p.trip?.start ?? now) : now + departures++ * BURST_GAP_MS;
    const from = positionOf(p, now);
    const trip = startTrip(from, route(ways, p.gait, from, ways.elevator), start, speedOf(p.gait));
    walkers.set(id, { gait: p.gait, place: '', near: null, to: ways.elevator, trip, step: false, arriving: false, leaving: true });
  }
  return { walkers, passes: passesOf(walkers, now) };
}

/** When the walkers pass the elevator doors from `now` on: each one still inside as it comes out, each leaver as it gets there. */
function passesOf(walkers: ReadonlyMap<string, Walker>, now: number): number[] {
  const passes: number[] = [];
  for (const w of walkers.values()) {
    const pass = !w.trip ? null : w.arriving ? w.trip.start : w.leaving ? tripEnd(w.trip) : null;
    if (pass !== null && pass >= now) passes.push(pass);
  }
  return passes;
}

/** Where the walker is at `now`, the way it faces, whether it is on its way (past its start, short of its end), and whether it is out of the elevator. */
export function walkerAt(w: Walker, now: number): { x: number; z: number; facing: number; walking: boolean; shown: boolean } {
  if (!w.trip || now >= tripEnd(w.trip)) return { x: w.to.x, z: w.to.z, facing: w.to.facing, walking: false, shown: true };
  const at = tripAt(w.trip, now);
  return { x: at.x, z: at.z, facing: at.facing, walking: now >= w.trip.start, shown: !(w.arriving && now < w.trip.start) };
}

/** The walker after `now`: the same one while it is under way or at rest; at rest at its place once its trip is over; null once it has left. */
export function advance(w: Walker, now: number): Walker | null {
  if (!w.trip || now < tripEnd(w.trip)) return w;
  return w.leaving ? null : { ...w, trip: null, step: false, arriving: false };
}

/** The walker at once where it is going: at its place, or null when it was leaving. */
export function settled(w: Walker): Walker | null {
  if (w.leaving) return null;
  return w.trip ? { ...w, trip: null, step: false, arriving: false } : w;
}

/** Whether the elevator doors move at `now`: opening or closing, neither shut nor held open. */
export function doorsMoving(passes: readonly number[], now: number): boolean {
  // A moment later, they are not as open as now.
  return doorOpen(passes, now + 1) !== doorOpen(passes, now);
}

/** The first time after `now` at which the elevator doors start to open, or start to close after their hold; null when there is none. */
export function doorsNext(passes: readonly number[], now: number): number | null {
  let next: number | null = null;
  for (const pass of passes) {
    // Another pass may hold them open then: only a time at which they do move counts.
    for (const t of [pass - DOOR_MS, pass + DOOR_HOLD_MS]) if (t > now && (next === null || t < next) && doorsMoving(passes, t)) next = t;
  }
  return next;
}

/**
 * On its way to its new place from where it is now. From a place near it, at rest or on its step there, it is one straight
 * step. A robot still inside the elevator comes out when it was to.
 */
function head(ways: Ways, p: Walker, w: Wanted, now: number): Walker {
  const inside = p.arriving && p.trip !== null && now < p.trip.start;
  const from = positionOf(p, now);
  const near = w.near ?? null;
  const step = near !== null && near === p.near && !p.leaving && (p.trip === null || p.step);
  const points = step ? [{ x: w.to.x, z: w.to.z }] : route(ways, w.gait, from, w.to);
  const trip = startTrip(from, points, inside ? p.trip!.start : now, speedOf(w.gait));
  return { gait: w.gait, place: w.place, near, to: w.to, trip, step, arriving: inside, leaving: false };
}

function positionOf(w: Walker, now: number): Point {
  const at = walkerAt(w, now);
  return { x: at.x, z: at.z };
}

/** The way from one point to another: on foot over the grid, or flying straight. */
function route(ways: Ways, gait: Gait, from: Point, to: Point): Point[] {
  return gait === 'fly' ? [{ x: to.x, z: to.z }] : findPath(ways.grid, from, to);
}

function speedOf(gait: Gait): number {
  return gait === 'fly' ? FLY_SPEED : WALK_SPEED;
}

function sameSpot(a: Point, b: Point): boolean {
  return a.x === b.x && a.z === b.z;
}
