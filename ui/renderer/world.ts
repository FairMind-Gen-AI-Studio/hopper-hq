/**
 * Where things stand on a floor, in world units. Pure maths: no three.js objects and no DOM.
 * One grid cell is one metre. Grid x is world x (east), grid y is world z (south), and world y points up.
 */
import { SEATS_MAX } from '../../src/scene/layout';
import type { Desk, GridRect, MeetingRoom, Pose } from '../../src/scene/types';

/** Wall height and thickness. */
export const WALL_H = 2.6;
export const WALL_T = 0.16;
/** Seat height of a desk chair. */
export const SEAT_Y = 0.48;
/** The camera's fixed angle from the vertical, its home azimuth (looking from the south-east) and its distance. */
export const POLAR = 0.98;
export const HOME_AZIMUTH = Math.PI / 4;
export const CAMERA_DISTANCE = 60;
/** Room left around the floor when the camera frames it. */
export const FRAME_MARGIN = 1.08;

export interface Point {
  x: number;
  z: number;
}
export interface Point3 {
  x: number;
  y: number;
  z: number;
}
/** A place to sit or stand, and the way it faces: 0 looks south (toward the home camera), PI looks north. */
export interface Spot extends Point {
  facing: number;
}

/** Grid cell (x, y) to the world's ground plane. */
export function cellToWorld(x: number, y: number): Point {
  return { x, z: y };
}

export function rectCenter(r: GridRect): Point {
  return { x: r.x + r.w / 2, z: r.y + r.h / 2 };
}

/**
 * A desk fills its 2x2 cells: the top, with the monitor on its north edge, sits toward the north edge of the cells,
 * and the chair toward the south edge. A seated robot faces the monitor; a standing one stands east of the chair,
 * facing the room.
 */
export const DESK_TOP_Z = 0.6;
export const CHAIR_Z = 0.78;
export const STAND_X = 0.6;
export const STAND_Z = 0.88;

/** The centre of the desk top on the ground plane: the origin of the desk's furniture. */
export function deskAnchor(rect: GridRect): Point {
  return { x: rect.x + rect.w / 2, z: rect.y + DESK_TOP_Z };
}

export function seatSpot(rect: GridRect): Spot {
  const a = deskAnchor(rect);
  return { x: a.x, z: a.z + CHAIR_Z, facing: Math.PI };
}

export function standSpot(rect: GridRect): Spot {
  const a = deskAnchor(rect);
  return { x: a.x + STAND_X, z: a.z + STAND_Z, facing: 0 };
}

/** Poses that stand up from the desk; the others sit. */
export function isStanding(pose: Pose): boolean {
  return pose === 'waving' || pose === 'holding';
}

/** Where the desk's robot is: on the chair, or beside it; null when the desk is empty (dormant). */
export function robotSpot(desk: Desk): Spot | null {
  if (!desk.robot) return null;
  return isStanding(desk.robot.pose) ? standSpot(desk.rect) : seatSpot(desk.rect);
}

/** Height of a desk label's anchor: above a standing or a seated robot's head, or above the monitor of an empty desk. */
export const LABEL_Y = { standing: 1.45, seated: 1.6, empty: 1.6 } as const;

/** The point a desk's label hangs from. */
export function labelAnchor(desk: Desk): Point3 {
  const spot = robotSpot(desk);
  if (!spot) {
    const a = deskAnchor(desk.rect);
    return { x: a.x, y: LABEL_Y.empty, z: a.z };
  }
  return { x: spot.x, y: desk.robot && isStanding(desk.robot.pose) ? LABEL_Y.standing : LABEL_Y.seated, z: spot.z };
}

/** The point an island's placard stands on: the rug's south-west corner. */
export function placardAnchor(rect: GridRect): Point3 {
  return { x: rect.x + 0.2, y: 0.02, z: rect.y + rect.h - 0.15 };
}

/**
 * A meeting room fills its cells (prototypes/floor-3d-mockup.html): glass partitions along its edges, a door in the
 * middle of the west one, a whiteboard on the north one, and a table a little south of the middle, with SEATS_MAX
 * seats along its long sides and a head seat at its west end.
 */
export const PARTITION_H = 2.2;
export const PARTITION_T = 0.06;
export const DOOR_W = 1.6;
/** The table's length (west to east) and depth, and how far south of the room's centre it stands. */
export const TABLE = { w: 4.4, d: 1.3, south: 0.3 } as const;
/** A seat's distance from the table's edge, and the gap between two seats along a side. */
export const SEAT_OUT = 0.45;
export const SEAT_GAP = 1;
/** The whiteboard's size, and the height of its centre. */
export const BOARD = { w: 3.4, h: 1.2, y: 1.5 } as const;

export function tableCenter(rect: GridRect): Point {
  return { x: rect.x + rect.w / 2, z: rect.y + rect.h / 2 + TABLE.south };
}

/**
 * The seats around the table, in the order agents take them: a north seat, then the south seat facing it, from the
 * head end east. North seats face south and south seats face north, across the table.
 */
export function seatSpots(rect: GridRect): Spot[] {
  const t = tableCenter(rect);
  const pairs = SEATS_MAX / 2;
  const out: Spot[] = [];
  for (let k = 0; k < pairs; k++) {
    const x = t.x + (k - (pairs - 1) / 2) * SEAT_GAP;
    out.push({ x, z: t.z - TABLE.d / 2 - SEAT_OUT, facing: 0 }, { x, z: t.z + TABLE.d / 2 + SEAT_OUT, facing: Math.PI });
  }
  return out;
}

/** The head seat: the host's, at the west end of the table, facing east along it. */
export function headSpot(rect: GridRect): Spot {
  const t = tableCenter(rect);
  return { x: t.x - TABLE.w / 2 - SEAT_OUT, z: t.z, facing: Math.PI / 2 };
}

/** Where the door in the west partition starts and ends, north to south. */
export function doorGap(rect: GridRect): { from: number; to: number } {
  const mid = rect.y + rect.h / 2;
  return { from: mid - DOOR_W / 2, to: mid + DOOR_W / 2 };
}

/** The top of the whiteboard, in the middle of the north partition: its overlay hangs from here. */
export function boardAnchor(rect: GridRect): Point3 {
  return { x: rect.x + rect.w / 2, y: BOARD.y + BOARD.h / 2, z: rect.y + PARTITION_T + 0.05 };
}

/** The room's tag hangs over its door. */
export function roomTagAnchor(rect: GridRect): Point3 {
  const door = doorGap(rect);
  return { x: rect.x + PARTITION_T / 2, y: PARTITION_H + 0.25, z: (door.from + door.to) / 2 };
}

/** What tells rooms apart: two sessions may name the same run, and each gets a room. */
export function roomKey(room: Pick<MeetingRoom, 'hostSessionId' | 'runId'>): string {
  return JSON.stringify([room.hostSessionId, room.runId]);
}

export function floorCenter(size: { w: number; h: number }): Point {
  return { x: size.w / 2, z: size.h / 2 };
}

/** The camera's offset from its target: spherical coordinates as three.js reads them (polar from +y, azimuth from +z). */
export function cameraOffset(azimuth: number, polar = POLAR, distance = CAMERA_DISTANCE): Point3 {
  const s = Math.sin(polar) * distance;
  return { x: s * Math.sin(azimuth), y: Math.cos(polar) * distance, z: s * Math.cos(azimuth) };
}

/** The azimuth of a camera offset: the inverse of cameraOffset. */
export function azimuthOf(offset: Point): number {
  return Math.atan2(offset.x, offset.z);
}

export interface Frustum {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * The smallest centred orthographic frustum that shows the whole floor, slab and wall tops, from this azimuth, with
 * FRAME_MARGIN to spare. The camera looks at the floor's centre. Every quarter turn from home gives the same frustum.
 */
export function frustumFor(size: { w: number; h: number }, aspect: number, azimuth = HOME_AZIMUTH): Frustum {
  const c = floorCenter(size);
  const right = { x: Math.cos(azimuth), z: -Math.sin(azimuth) };
  const up = { x: -Math.cos(POLAR) * Math.sin(azimuth), y: Math.sin(POLAR), z: -Math.cos(POLAR) * Math.cos(azimuth) };
  let halfW = 0;
  let halfH = 0;
  for (const x of [0, size.w]) {
    for (const z of [0, size.h]) {
      for (const y of [0, WALL_H]) {
        const dx = x - c.x;
        const dz = z - c.z;
        halfW = Math.max(halfW, Math.abs(dx * right.x + dz * right.z));
        halfH = Math.max(halfH, Math.abs(dx * up.x + y * up.y + dz * up.z));
      }
    }
  }
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  const viewH = Math.max(2 * halfH, (2 * halfW) / a) * FRAME_MARGIN;
  return { left: (-viewH * a) / 2, right: (viewH * a) / 2, top: viewH / 2, bottom: -viewH / 2 };
}

export type WallSide = 'north' | 'east' | 'south' | 'west';
export const WALL_SIDES: readonly WallSide[] = ['north', 'east', 'south', 'west'];
/** Each wall's outward normal on the ground plane. */
export const WALL_NORMAL: Record<WallSide, Point> = {
  north: { x: 0, z: -1 },
  east: { x: 1, z: 0 },
  south: { x: 0, z: 1 },
  west: { x: -1, z: 0 },
};

/** A wall is cut away when it faces the camera: its outward normal points toward the camera (n · camDir >= 0.3). */
export function visibleWalls(azimuth: number): Record<WallSide, boolean> {
  const dx = Math.sin(azimuth);
  const dz = Math.cos(azimuth);
  const shown = (side: WallSide) => WALL_NORMAL[side].x * dx + WALL_NORMAL[side].z * dz < 0.3;
  return { north: shown('north'), east: shown('east'), south: shown('south'), west: shown('west') };
}

/** Half the side of the sun's square shadow camera: the floor's larger half-extent and a margin. */
export function shadowExtent(size: { w: number; h: number }): number {
  return Math.max(size.w, size.h) / 2 + 3;
}
