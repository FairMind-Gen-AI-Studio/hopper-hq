/**
 * The floor camera's moves as plain maths: quarter turns around the vertical axis, the zoom and tilt limits, the home
 * view, the pan to a desk, the moves of held arrow keys, and eased tweens between poses.
 */
import { HOME_AZIMUTH, POLAR, floorCenter, type Point } from './world';

export const MIN_ZOOM = 0.55;
export const MAX_ZOOM = 3.2;
/** The camera's angle from the vertical: from nearly straight down to well above the ground (home is world.POLAR). */
export const MIN_POLAR = 0.2;
export const MAX_POLAR = 1.3;
export const QUARTER = Math.PI / 2;
/**
 * How far held arrow keys carry the camera each second: across the ground, this share of the view's height; with
 * Shift, round the vertical axis and up or down, these angles.
 */
export const KEY_PAN = 0.6;
export const KEY_TURN = QUARTER;
export const KEY_TILT = 0.6;
/** A pan to a desk zooms in to at least DESK_ZOOM, and stops DESK_PULL of the way back toward the floor's centre. */
export const DESK_ZOOM = 1.25;
export const DESK_PULL = 0.35;
/** Tween lengths, in milliseconds. */
export const ROTATE_MS = 550;
export const RESET_MS = 600;
export const PAN_MS = 500;

export interface CameraPose {
  /** The point on the ground the camera looks at. */
  target: Point;
  azimuth: number;
  /** The angle from the vertical. */
  polar: number;
  zoom: number;
}

export function clampZoom(zoom: number): number {
  return Number.isFinite(zoom) ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)) : 1;
}

export function clampPolar(polar: number): number {
  return Number.isFinite(polar) ? Math.min(MAX_POLAR, Math.max(MIN_POLAR, polar)) : POLAR;
}

/** The nearest step: the home azimuth plus a whole number of quarter turns. */
export function snapAzimuth(azimuth: number): number {
  return HOME_AZIMUTH + Math.round((azimuth - HOME_AZIMUTH) / QUARTER) * QUARTER;
}

/** One quarter turn on from the nearest step. */
export function stepAzimuth(azimuth: number, step: -1 | 1): number {
  return snapAzimuth(azimuth) + step * QUARTER;
}

/** The home azimuth nearest this one, in whole turns: a reset never spins the floor more than half a turn. */
export function homeAzimuthNear(azimuth: number): number {
  return HOME_AZIMUTH + Math.round((azimuth - HOME_AZIMUTH) / (2 * Math.PI)) * 2 * Math.PI;
}

/** The view a floor opens with: its centre, from the south-east, at the home tilt and zoom 1. */
export function homePose(size: { w: number; h: number }, azimuth = HOME_AZIMUTH): CameraPose {
  return { target: floorCenter(size), azimuth: homeAzimuthNear(azimuth), polar: POLAR, zoom: 1 };
}

/** Moves toward a desk without turning or tilting, keeping some of the floor around it in view. */
export function deskPose(from: CameraPose, spot: Point, size: { w: number; h: number }): CameraPose {
  const c = floorCenter(size);
  return {
    target: { x: spot.x + (c.x - spot.x) * DESK_PULL, z: spot.z + (c.z - spot.z) * DESK_PULL },
    azimuth: from.azimuth,
    polar: from.polar,
    zoom: clampZoom(Math.max(from.zoom, DESK_ZOOM)),
  };
}

/** The arrows held: ahead (up) and back (down), right and left; each -1, 0 or 1. */
export interface KeyMove {
  forward: number;
  right: number;
}

/**
 * Where held arrows carry the camera in `seconds`: across the ground, ahead being the way the camera looks, or, with
 * `turn` (Shift), round the vertical axis (left the way Q turns) and up toward straight down or down toward the
 * ground. `shown` is the view's height in world units: a move covers the same share of it at every zoom.
 */
export function keyPose(from: CameraPose, move: KeyMove, turn: boolean, seconds: number, shown: number): CameraPose {
  if (turn) {
    return {
      ...from,
      azimuth: from.azimuth + move.right * KEY_TURN * seconds,
      polar: move.forward === 0 ? from.polar : clampPolar(from.polar - move.forward * KEY_TILT * seconds),
    };
  }
  const length = Math.hypot(move.forward, move.right);
  if (length === 0) return from;
  const step = (KEY_PAN * shown * seconds) / length;
  const s = Math.sin(from.azimuth);
  const c = Math.cos(from.azimuth);
  // Ahead on the ground is (-sin, -cos), away from the camera; the right of the screen is (cos, -sin).
  return {
    ...from,
    target: {
      x: from.target.x + (-move.forward * s + move.right * c) * step,
      z: from.target.z + (-move.forward * c - move.right * s) * step,
    },
  };
}

/** Cubic ease in and out over 0..1. */
export function easeInOut(t: number): number {
  const s = Math.min(1, Math.max(0, t));
  return s < 0.5 ? 4 * s * s * s : 1 - Math.pow(-2 * s + 2, 3) / 2;
}

/** The signed angle from a to b, the short way round: -PI..PI. */
export function turnBetween(a: number, b: number): number {
  const d = b - a;
  return Math.atan2(Math.sin(d), Math.cos(d));
}

/** A pose between a and b; the azimuth turns the short way round. */
export function lerpPose(a: CameraPose, b: CameraPose, t: number): CameraPose {
  const mix = (x: number, y: number) => x + (y - x) * t;
  return {
    target: { x: mix(a.target.x, b.target.x), z: mix(a.target.z, b.target.z) },
    azimuth: a.azimuth + turnBetween(a.azimuth, b.azimuth) * t,
    polar: mix(a.polar, b.polar),
    zoom: mix(a.zoom, b.zoom),
  };
}

/**
 * An eased move from one pose to another, started at `start` (ms) and lasting `duration` ms; 0 jumps at once. It
 * turns by `turn`, the short way round to `to` unless told otherwise.
 */
export class Tween {
  constructor(
    readonly from: CameraPose,
    readonly to: CameraPose,
    readonly start: number,
    readonly duration: number,
    readonly turn = turnBetween(from.azimuth, to.azimuth),
  ) {}

  at(now: number): CameraPose {
    if (this.done(now)) return this.to;
    const t = easeInOut((now - this.start) / this.duration);
    return { ...lerpPose(this.from, this.to, t), azimuth: this.from.azimuth + this.turn * t };
  }

  done(now: number): boolean {
    return this.duration <= 0 || now - this.start >= this.duration;
  }
}
