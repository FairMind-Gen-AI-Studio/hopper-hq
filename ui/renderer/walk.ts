/**
 * Where robots can walk on a floor (design §5.1). Pure maths: no three.js objects, no DOM and no clock.
 *
 * The walk grid covers the floor in square cells of WALK_CELL, row by row from the north-west corner: cell (c, r) is
 * the square from (c, r) * WALK_CELL to (c + 1, r + 1) * WALK_CELL on the ground plane (x east, z south). A piece of
 * furniture blocks every cell whose centre lies on it, or less than CLEARANCE from it, so that a walking robot keeps
 * clear of it. Walls and glass are thin: each blocks the ring of cells along its inner side. Seats stay free, since
 * robots sit on them: desk and room chairs, the couches' seats and the beanbags.
 */
import type { FloorDetail, GridRect } from '../../src/scene/types';
import { COFFEE_TABLE, COUCH, COUCH_Z, TABLE, deskAnchor, doorGap, rectCenter, tableCenter, type Point } from './world';

/** Side of a walk-grid cell, in metres. */
export const WALK_CELL = 0.5;
export interface WalkGrid {
  cols: number;
  rows: number;
  /** 1: blocked. Row-major, cols * rows. */
  blocked: Uint8Array;
}

/** How far a walking robot keeps its centre from furniture: about half its width. */
const CLEARANCE = 0.2;
/** A desk's top, centred on its anchor (props.ts buildDesk); its monitor stands on it. */
const DESK_TOP = { w: 1.6, d: 0.8 } as const;
/** The depth of a couch's back, along the couch's outer edge (props.ts buildLounge). */
const COUCH_BACK = 0.26;
/** A plant's pot and leaves around its centre, and how far in from the core's south corners it stands (props.ts buildShell). */
const PLANT_R = 0.3;
const PLANT_IN = 0.5;

/** The floor's walkable cells: blocked are the outer walls, desks (top and monitor), room glass except the door gaps, room tables, lounge furniture and the core's plants. Doors always count as open. */
export function walkGrid(floor: Pick<FloorDetail, 'size' | 'core' | 'pods' | 'lounge' | 'roomSlots'>): WalkGrid {
  const cols = Math.ceil(floor.size.w / WALK_CELL);
  const rows = Math.ceil(floor.size.h / WALK_CELL);
  const blocked = new Uint8Array(cols * rows);
  /** Blocks each cell whose centre lies inside (x0, x1) x (z0, z1) and passes `test`. */
  const block = (x0: number, z0: number, x1: number, z1: number, test: (x: number, z: number) => boolean = () => true) => {
    for (let r = Math.max(0, Math.floor(z0 / WALK_CELL)); r < Math.min(rows, Math.ceil(z1 / WALK_CELL)); r++) {
      for (let c = Math.max(0, Math.floor(x0 / WALK_CELL)); c < Math.min(cols, Math.ceil(x1 / WALK_CELL)); c++) {
        const x = (c + 0.5) * WALK_CELL;
        const z = (r + 0.5) * WALK_CELL;
        if (x > x0 && x < x1 && z > z0 && z < z1 && test(x, z)) blocked[r * cols + c] = 1;
      }
    }
  };
  /** A solid piece, [x0, x1] by [z0, z1], with CLEARANCE around it. */
  const solid = (x0: number, z0: number, x1: number, z1: number) => block(x0 - CLEARANCE, z0 - CLEARANCE, x1 + CLEARANCE, z1 + CLEARANCE);
  /** A round piece of radius `r`, with CLEARANCE around it. */
  const round = (px: number, pz: number, r: number) => {
    const out = r + CLEARANCE;
    block(px - out, pz - out, px + out, pz + out, (x, z) => (x - px) ** 2 + (z - pz) ** 2 < out * out);
  };
  /** The ring of cells along the inside of a rectangle's edges, but those `open` lets through. */
  const ring = (rect: GridRect, open: (x: number, z: number) => boolean = () => false) =>
    block(rect.x, rect.y, rect.x + rect.w, rect.y + rect.h, (x, z) => {
      const edge = x - rect.x < WALK_CELL || rect.x + rect.w - x < WALK_CELL || z - rect.y < WALK_CELL || rect.y + rect.h - z < WALK_CELL;
      return edge && !open(x, z);
    });

  ring({ x: 0, y: 0, w: floor.size.w, h: floor.size.h });

  const core = floor.core;
  for (const x of [core.x + PLANT_IN, core.x + core.w - PLANT_IN]) round(x, core.y + core.h - PLANT_IN, PLANT_R);

  for (const pod of floor.pods) {
    for (const desk of pod.desks) {
      const a = deskAnchor(desk);
      solid(a.x - DESK_TOP.w / 2, a.z - DESK_TOP.d / 2, a.x + DESK_TOP.w / 2, a.z + DESK_TOP.d / 2);
    }
  }

  // The lounge: its coffee table, and each couch's back.
  const lounge = rectCenter(floor.lounge.rect);
  solid(lounge.x - COFFEE_TABLE.w / 2, lounge.z - COFFEE_TABLE.d / 2, lounge.x + COFFEE_TABLE.w / 2, lounge.z + COFFEE_TABLE.d / 2);
  for (const sign of [-1, 1]) {
    const outer = lounge.z + sign * (COUCH_Z + COUCH.d / 2);
    const inner = outer - sign * COUCH_BACK;
    solid(lounge.x - COUCH.w / 2, Math.min(outer, inner), lounge.x + COUCH.w / 2, Math.max(outer, inner));
  }

  for (const rect of floor.roomSlots) {
    // The door: the cells of the west glass inside its gap, CLEARANCE in from either post.
    const door = doorGap(rect);
    ring(rect, (x, z) => x - rect.x < WALK_CELL && z > door.from + CLEARANCE && z < door.to - CLEARANCE);
    const t = tableCenter(rect);
    solid(t.x - TABLE.w / 2, t.z - TABLE.d / 2, t.x + TABLE.w / 2, t.z + TABLE.d / 2);
  }

  return { cols, rows, blocked };
}

/** True when the point lies on a blocked cell, or off the grid. */
function blockedAt(grid: WalkGrid, x: number, z: number): boolean {
  const c = Math.floor(x / WALK_CELL);
  const r = Math.floor(z / WALK_CELL);
  return c < 0 || r < 0 || c >= grid.cols || r >= grid.rows || grid.blocked[r * grid.cols + c] === 1;
}

/** True when the straight segment a→b crosses no blocked cell (sampled every WALK_CELL / 2). */
export function lineOfSight(grid: WalkGrid, a: Point, b: Point): boolean {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  // Both ends, and points between them at most WALK_CELL / 2 apart.
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / (WALK_CELL / 2)));
  for (let k = 0; k <= steps; k++) {
    if (blockedAt(grid, a.x + (dx * k) / steps, a.z + (dz * k) / steps)) return false;
  }
  return true;
}
