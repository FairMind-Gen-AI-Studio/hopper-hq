/**
 * Where things stand on a floor, in world units. Pure maths: no three.js objects and no DOM.
 * One grid cell is one metre. Grid x is world x (east), grid y is world z (south), and world y points up.
 */
import { INTERNS_MAX, LOUNGE_SEATS, SEATS_MAX } from '../../src/scene/layout';
import type { FloorDetail, GridRect, MeetingRoom, Occupant, PodDesk, Pose } from '../../src/scene/types';
import type { Target } from './index';

/** Wall height and thickness. */
export const WALL_H = 2.6;
export const WALL_T = 0.16;
/** Seat height of a desk chair. */
export const SEAT_Y = 0.48;
/** The camera's angle from the vertical at home, its home azimuth (looking from the south-east) and its distance. */
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
 * A desk fills its 2x2 cells: the top, with the monitor on the edge opposite the chair, sits toward that edge of the
 * cells, and the chair toward its own edge. A seated robot faces the monitor; a standing one stands east of the chair,
 * facing away from the desk. Below, distances run from the desk top's centre toward the chair.
 */
export const DESK_TOP_Z = 0.6;
export const CHAIR_Z = 0.78;
export const STAND_X = 0.6;
export const STAND_Z = 0.88;
/** A desk's top, centred on its anchor: wide along the desk, deep toward the chair. The monitor stands on it. */
export const DESK_TOP = { w: 1.6, d: 0.8 } as const;
/**
 * A desk chair, as wide as its seat: the seat, `seat` deep, centred CHAIR_Z toward the chair, and behind it the back,
 * `back` thick, centred `backZ` toward the chair.
 */
export const DESK_CHAIR = { w: 0.5, seat: 0.5, back: 0.07, backZ: 1.03 } as const;

/** 1 when the chair is on the desk's south edge, -1 when it is on its north edge: the sign of the way to the chair. */
function toChair(desk: Pick<PodDesk, 'chair'>): 1 | -1 {
  return desk.chair === 'south' ? 1 : -1;
}

/** The centre of the desk top on the ground plane: toward the edge opposite the chair. */
export function deskAnchor(desk: Pick<PodDesk, 'rect' | 'chair'>): Point {
  const r = desk.rect;
  return { x: r.x + r.w / 2, z: desk.chair === 'south' ? r.y + DESK_TOP_Z : r.y + r.h - DESK_TOP_Z };
}

/** On the chair, facing the monitor. */
export function seatSpot(desk: Pick<PodDesk, 'rect' | 'chair'>): Spot {
  const a = deskAnchor(desk);
  const s = toChair(desk);
  return { x: a.x, z: a.z + s * CHAIR_Z, facing: s === 1 ? Math.PI : 0 };
}

/** Beside the chair, facing away from the desk. */
export function standSpot(desk: Pick<PodDesk, 'rect' | 'chair'>): Spot {
  const a = deskAnchor(desk);
  const s = toChair(desk);
  return { x: a.x + STAND_X, z: a.z + s * STAND_Z, facing: s === 1 ? 0 : Math.PI };
}

/** Poses that stand up from the desk; the others sit. Every leisure pose (robot.ts POSES) stands too: the break area has no chair. */
export function isStanding(pose: Pose): boolean {
  return pose === 'waving' || pose === 'holding' || pose === 'gintonic' || pose === 'biliardino' || pose === 'coffee';
}

/**
 * Where a desk's interns hover: over the desk's own half, between its monitor and its chair, the first in the middle and
 * the others either side, a little nearer the monitor and turned toward the middle. They face the chair. Back to back,
 * two desks' interns stay over their own desks.
 */
const INTERN_ARC = [
  { dx: 0, dz: 0.12, facing: 0 },
  { dx: -0.55, dz: 0.02, facing: 0.3 },
  { dx: 0.55, dz: 0.02, facing: -0.3 },
] as const;

/** INTERNS_MAX spots at HOVER_Y over the desk's own half, between its monitor and its chair, clear of the monitors. The arcs of two back-to-back desks never meet: every two spots in a pod are at least 0.5 m apart. */
export function internSpots(desk: Pick<PodDesk, 'rect' | 'chair'>): Spot[] {
  const a = deskAnchor(desk);
  const s = toChair(desk);
  return INTERN_ARC.slice(0, INTERNS_MAX).map((p) => ({ x: a.x + p.dx, z: a.z + s * p.dz, facing: s === 1 ? p.facing : Math.PI - p.facing }));
}

/**
 * The lounge, around its centre (prototypes/floor-3d-mockup.html): a coffee table, two three-seat couches facing each
 * other across it, north and south, and a beanbag at each end of the table, west and east.
 */
export const COUCH = { w: 2.6, d: 0.9 } as const;
/** How far north and south of the lounge's centre the couches stand, and the gap between two seats of a couch. */
export const COUCH_Z = 1.3;
export const COUCH_SEAT_GAP = 0.8;
/** A seat sits this much nearer the table than its couch's centre. */
export const COUCH_SEAT_IN = 0.1;
export const COFFEE_TABLE = { w: 1.6, d: 0.8 } as const;
/** How far west and east of the lounge's centre the beanbags sit, and their radius. */
export const BEANBAG_X = 2.2;
export const BEANBAG_R = 0.5;
/** A couch's back is this deep along its outer edge, and its arms this wide, centred on its ends: COUCH.w + COUCH_ARM in all. */
export const COUCH_BACK = 0.26;
export const COUCH_ARM = 0.26;
/** A beanbag is a ball of BEANBAG_R, this much wider across and this much as high. */
export const BEANBAG_SCALE = { across: 1.05, up: 0.55 } as const;

/** LOUNGE_SEATS spots in seat order: the north couch west to east (3), the south couch west to east (3), the west beanbag, the east beanbag. */
export function loungeSpots(lounge: GridRect): Spot[] {
  const c = rectCenter(lounge);
  // Each couch faces the table: the north one south, the south one north.
  const couch = (sign: 1 | -1) => [-1, 0, 1].map((k): Spot => ({ x: c.x + k * COUCH_SEAT_GAP, z: c.z + sign * (COUCH_Z - COUCH_SEAT_IN), facing: sign === 1 ? Math.PI : 0 }));
  const spots = [...couch(-1), ...couch(1), { x: c.x - BEANBAG_X, z: c.z, facing: Math.PI / 2 }, { x: c.x + BEANBAG_X, z: c.z, facing: -Math.PI / 2 }];
  return spots.slice(0, LOUNGE_SEATS);
}

/** How far into the floor, from the north wall, a robot stands once out of the elevator. */
export const ELEVATOR_STEP = 0.8;

/** Just inside the elevator doors, facing south. */
export function elevatorSpot(core: GridRect): Spot {
  return { x: core.x + core.w / 2, z: ELEVATOR_STEP, facing: 0 };
}

/**
 * The break area (props.ts draws it): a bar cart near its west edge, a coffee machine midway between them, and a
 * biliardino table near its east edge, each with its own stand spot(s), far enough apart that walking between any two
 * never crosses a third's spots.
 */
export const BAR_CART = { w: 1.0, d: 0.5 } as const;
/** How far the cart's centre stands from the break area's west edge. */
export const BAR_CART_X = 2;
/** The radius of the ring of stand spots round the cart. */
export const BAR_CART_R = 0.9;

/** Where the bar cart stands, centred in the break area's depth. */
export function barCartCenter(rect: GridRect): Point {
  return { x: rect.x + BAR_CART_X, z: rect.y + rect.h / 2 };
}

/** The 4 "standing with a glass" spots in a ring round the cart, each facing it: north, east, south, west. */
export function barCartSpots(rect: GridRect): Spot[] {
  const c = barCartCenter(rect);
  const r = BAR_CART_R;
  return [
    { x: c.x, z: c.z - r, facing: 0 },
    { x: c.x + r, z: c.z, facing: -Math.PI / 2 },
    { x: c.x, z: c.z + r, facing: Math.PI },
    { x: c.x - r, z: c.z, facing: Math.PI / 2 },
  ];
}

/** The biliardino table: wider east-west than deep, a row of little players along its long north and south sides. */
export const FOOSBALL = { w: 1.6, d: 0.8 } as const;
/** How far the table's centre stands from the break area's east edge. */
export const FOOSBALL_X = 1.5;
/** How far a handle spot stands from the table's long edge. */
export const FOOSBALL_OUT = 0.5;
/**
 * How high the table's 8 rods (and so its players and its handles: one straight rod, the same height throughout)
 * stand above the floor: props.ts's cabinet carries them through its raised rim, just above its own green field,
 * and robot.ts's biliardino pose (session and workflow kinds, standing) reaches a hand to just this height. An
 * intern, with no legs to stand on, floats low enough at this pose instead of its desk's HOVER_Y (robot.ts).
 */
export const FOOSBALL_ROD_Y = 0.62;

/** Where the biliardino table stands, centred in the break area's depth. */
export function foosballCenter(rect: GridRect): Point {
  return { x: rect.x + rect.w - FOOSBALL_X, z: rect.y + rect.h / 2 };
}

/**
 * v1's two handle spots, one per side, facing each other across the table: 1-v-1. Room stays beside each for a second
 * handle spot, were the table ever to seat 4.
 */
export function foosballSpots(rect: GridRect): Spot[] {
  const c = foosballCenter(rect);
  return [
    { x: c.x, z: c.z - FOOSBALL.d / 2 - FOOSBALL_OUT, facing: 0 },
    { x: c.x, z: c.z + FOOSBALL.d / 2 + FOOSBALL_OUT, facing: Math.PI },
  ];
}

/**
 * The coffee machine (OQ-3: a finished sub-agent waiting outside the leisure window takes a coffee break here),
 * centred between the cart and the table, in the free gap their own footprints and rings leave between them.
 */
export const COFFEE_MACHINE = { w: 0.6, d: 0.5 } as const;
/** How far the one stand spot stands south of the machine's centre, facing it. */
export const COFFEE_MACHINE_OUT = 0.5;

/** Where the coffee machine stands: the break area's own centre, midway between the cart and the table. */
export function coffeeMachineCenter(rect: GridRect): Point {
  return rectCenter(rect);
}

/** The one "holding a coffee cup" stand spot, south of the machine, facing it (north). */
export function coffeeMachineSpots(rect: GridRect): Spot[] {
  const c = coffeeMachineCenter(rect);
  return [{ x: c.x, z: c.z + COFFEE_MACHINE.d / 2 + COFFEE_MACHINE_OUT, facing: Math.PI }];
}

/** How far in from the core's south corners its plants stand. */
export const PLANT_IN = 0.5;

/** Where the core's two plants stand: in its south-west and south-east corners. */
export function plantSpots(core: GridRect): Point[] {
  const z = core.y + core.h - PLANT_IN;
  return [{ x: core.x + PLANT_IN, z }, { x: core.x + core.w - PLANT_IN, z }];
}

/** Height of a desk label's anchor: above a standing or a seated robot's head, or above the monitor of a desk whose robot has gone. */
export const LABEL_Y = { standing: 1.45, seated: 1.6, empty: 1.6 } as const;

/** The point a desk's label hangs from: above its robot, wherever it is, or above the monitor when it has gone. */
export function labelAnchor(floor: Pick<FloorDetail, 'lounge' | 'roomSlots'>, desk: Pick<PodDesk, 'rect' | 'chair'>, occupant: Occupant): Point3 {
  const spot = placeSpot(floor, desk, occupant);
  if (!spot) {
    const a = deskAnchor(desk);
    return { x: a.x, y: LABEL_Y.empty, z: a.z };
  }
  const standing = occupant.at.kind === 'desk' && occupant.robot !== null && isStanding(occupant.robot.pose);
  return { x: spot.x, y: standing ? LABEL_Y.standing : LABEL_Y.seated, z: spot.z };
}

/** The point a pod's placard stands on: the rug's south-west corner. */
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
/** The side of a room seat, the head seat's too, centred on its spot. */
export const ROOM_SEAT = 0.46;
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

/** Where an occupant's robot belongs: its seat or stand spot (by pose), its lounge seat, its room's head seat; null when gone. */
export function placeSpot(floor: Pick<FloorDetail, 'lounge' | 'roomSlots'>, desk: Pick<PodDesk, 'rect' | 'chair'> | null, occupant: Occupant): Spot | null {
  const at = occupant.at;
  if (at.kind === 'desk') return desk && (occupant.robot && isStanding(occupant.robot.pose) ? standSpot(desk) : seatSpot(desk));
  if (at.kind === 'lounge') return loungeSpots(floor.lounge.rect)[at.seat] ?? null;
  if (at.kind === 'room') {
    const rect = floor.roomSlots[at.slot];
    return rect ? headSpot(rect) : null;
  }
  return null;
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

/** Whether two targets name the same desk, or the same run's rooms. */
export function sameTarget(a: Target | null, b: Target | null): boolean {
  return a === b || (a !== null && b !== null && a.kind === b.kind && a.id === b.id);
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

/** The angle from the vertical of a camera offset: the inverse of cameraOffset. */
export function polarOf(offset: Point3): number {
  return Math.atan2(Math.hypot(offset.x, offset.z), offset.y);
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
