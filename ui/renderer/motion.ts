/**
 * How robots and the elevator doors move over time, and how often the view draws (design §5.2, §6.1). Pure maths: no
 * three.js objects, no DOM and no clock. Times are passed in, in milliseconds on the view's clock (ViewEnv.now and the
 * frame timestamps).
 */
import type { Point } from './world';

export const WALK_SPEED = 1.6, FLY_SPEED = 2.2;
/** The longest a trip lasts: longer paths are walked faster, up to SPEED_FACTOR_MAX times their speed. */
export const TRIP_MAX_MS = 5000;
/** The most a trip's speed is raised: past it, a long trip on a large floor takes longer than TRIP_MAX_MS. */
export const SPEED_FACTOR_MAX = 3;
/** Between two robots leaving or arriving in one burst. */
export const BURST_GAP_MS = 150;
/** Between two ambient frames. */
export const AMBIENT_MS = 50;
/** Elevator doors: how long they take to open or close, and how long they stay open after the last pass. */
export const DOOR_MS = 400, DOOR_HOLD_MS = 1200;

export interface Trip {
  from: Point;
  points: Point[];
  start: number;
  /** Metres per second: the given speed, raised so that the trip lasts at most TRIP_MAX_MS, up to SPEED_FACTOR_MAX times it. */
  speed: number;
  /** Path length in metres. */
  length: number;
}

/**
 * A trip from `from` through `points` (a path from walk.findPath, or the one point a flight goes straight to), starting
 * at `start`, which may be later than now: until then the robot waits at `from`. Its points are copied.
 */
export function startTrip(from: Point, points: readonly Point[], start: number, speed: number): Trip {
  let length = 0;
  let a = from;
  for (const b of points) {
    length += Math.hypot(b.x - a.x, b.z - a.z);
    a = b;
  }
  return {
    from: { x: from.x, z: from.z },
    points: points.map((p) => ({ x: p.x, z: p.z })),
    start,
    speed: Math.max(speed, Math.min(speed * SPEED_FACTOR_MAX, (length * 1000) / TRIP_MAX_MS)),
    length,
  };
}

/** When the trip reaches its end: its start, plus its length at its speed. A trip of no length ends as it starts. */
export function tripEnd(trip: Trip): number {
  return trip.length > 0 ? trip.start + (trip.length / trip.speed) * 1000 : trip.start;
}

/** Where the trip is at `now`: on the path, facing along it (Spot.facing convention); done once it has reached the end. */
export function tripAt(trip: Trip, now: number): { x: number; z: number; facing: number; done: boolean } {
  const done = now >= tripEnd(trip);
  // Metres still to go before the robot's position, from the start of the current segment.
  let left = done ? Infinity : (Math.max(0, now - trip.start) * trip.speed) / 1000;
  let a = trip.from;
  // Facing the way of the segment it is on; a segment of no length turns it nowhere. 0 (south) before any.
  let facing = 0;
  for (const b of trip.points) {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len > 0) {
      facing = Math.atan2(dx, dz);
      if (left < len) return { x: a.x + (dx * left) / len, z: a.z + (dz * left) / len, facing, done };
      left -= len;
    }
    a = b;
  }
  return { x: a.x, z: a.z, facing, done };
}

export type FrameRate = 'still' | 'ambient' | 'full';
/** Hidden or lost: still. Something moving (a trip, doors opening or closing but not held open, a camera tween or glide, a held key): full. Else ambient when ambient loops run, else still. */
export function frameRate(s: { hidden: boolean; lost: boolean; moving: boolean; ambient: boolean }): FrameRate {
  if (s.hidden || s.lost) return 'still';
  if (s.moving) return 'full';
  return s.ambient ? 'ambient' : 'still';
}

/** How open the elevator doors are at `now` (0 closed, 1 open), given the times robots pass them. */
export function doorOpen(passes: readonly number[], now: number): number {
  // For each pass, the doors open over the DOOR_MS before it, stay open DOOR_HOLD_MS after it and close over the next
  // DOOR_MS. Passes close together keep them open; their order does not matter. A pass that is not a finite time moves
  // nothing.
  let open = 0;
  for (const pass of passes) {
    if (!Number.isFinite(pass)) continue;
    const opening = 1 - (pass - now) / DOOR_MS;
    const closing = 1 - (now - pass - DOOR_HOLD_MS) / DOOR_MS;
    open = Math.max(open, Math.min(1, opening, closing));
  }
  return open;
}
