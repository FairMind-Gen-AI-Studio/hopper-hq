/**
 * Where robots can walk on a floor, and the way they take from one place to another (design §5.1). Pure maths: no
 * three.js objects, no DOM and no clock.
 *
 * The walk grid covers the floor in square cells of WALK_CELL, row by row from the north-west corner: cell (c, r) is
 * the square from (c, r) * WALK_CELL to (c + 1, r + 1) * WALK_CELL on the ground plane (x east, z south). A piece of
 * furniture blocks every cell whose centre lies on it, or less than CLEARANCE from it, so that a walking robot keeps
 * clear of it. Walls and glass are thin: each blocks the ring of cells along its inner side. Seats block too, the
 * couches' only on the row of cells they stand on, so that the row between a couch and the coffee table stays free: a
 * robot walks round every seat, and steps onto one only to sit down.
 *
 * A path is A* over the cells, string-pulled into straight runs: each point goes on to the farthest later one it can
 * reach along a segment that keeps CLEARANCE from every blocked cell. The same grid and ends always give the same path.
 */
import type { FloorDetail, GridRect } from '../../src/scene/types';
import {
  BEANBAG_R,
  BEANBAG_X,
  COFFEE_TABLE,
  COUCH,
  COUCH_Z,
  TABLE,
  deskAnchor,
  doorGap,
  headSpot,
  rectCenter,
  seatSpots,
  tableCenter,
  type Point,
} from './world';

/** Side of a walk-grid cell, in metres. */
export const WALK_CELL = 0.5;
export interface WalkGrid {
  cols: number;
  rows: number;
  /** 1: blocked. Row-major, cols * rows. */
  blocked: Uint8Array;
}

/** How far a walking robot keeps its centre from furniture, and its way from every blocked cell: about half its width. */
const CLEARANCE = 0.2;
/** A desk's top, centred on its anchor (props.ts buildDesk); its monitor stands on it. */
const DESK_TOP = { w: 1.6, d: 0.8 } as const;
/** A desk chair's seat and back: its width, and how far from the desk top's centre it starts and ends toward the chair (props.ts buildDesk). */
const DESK_CHAIR = { w: 0.5, near: 0.53, far: 1.065 } as const;
/** The side of a room seat, the head seat's too, centred on its spot (props.ts buildRoom). */
const ROOM_SEAT = 0.46;
/** The depth of a couch's back, along the couch's outer edge, and the width of its arms, centred on its ends (props.ts buildLounge). */
const COUCH_BACK = 0.26;
const COUCH_ARM = 0.26;
/** A beanbag's radius on the ground: its ball is drawn 1.05 times as wide (props.ts buildLounge). */
const BEANBAG_FOOT = BEANBAG_R * 1.05;
/** A plant's pot and leaves around its centre, and how far in from the core's south corners it stands (props.ts buildShell). */
const PLANT_R = 0.3;
const PLANT_IN = 0.5;

/**
 * The floor's walkable cells: blocked are the outer walls, desks (top and monitor), every seat (desk chairs, room seats,
 * couch seats, beanbags), room glass except the door gaps, room tables, the couches with their arms, the coffee table and
 * the core's plants. Doors always count as open. The free cells form one connected area at every plan size.
 */
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
      // Its chair, toward the chair's edge of its cells.
      const s = desk.chair === 'south' ? 1 : -1;
      const near = a.z + s * DESK_CHAIR.near;
      const far = a.z + s * DESK_CHAIR.far;
      solid(a.x - DESK_CHAIR.w / 2, Math.min(near, far), a.x + DESK_CHAIR.w / 2, Math.max(near, far));
    }
  }

  // The lounge: its coffee table, each couch, and the beanbags.
  const lounge = rectCenter(floor.lounge.rect);
  solid(lounge.x - COFFEE_TABLE.w / 2, lounge.z - COFFEE_TABLE.d / 2, lounge.x + COFFEE_TABLE.w / 2, lounge.z + COFFEE_TABLE.d / 2);
  for (const sign of [-1, 1]) {
    const outer = lounge.z + sign * (COUCH_Z + COUCH.d / 2);
    const inner = outer - sign * COUCH_BACK;
    solid(lounge.x - COUCH.w / 2, Math.min(outer, inner), lounge.x + COUCH.w / 2, Math.max(outer, inner));
    // Its seat and arms, from its back to its front edge, with CLEARANCE only east and west: the row of cells in front
    // of the couch stays free, the way to its seats.
    const front = lounge.z + sign * (COUCH_Z - COUCH.d / 2);
    const half = COUCH.w / 2 + COUCH_ARM / 2 + CLEARANCE;
    block(lounge.x - half, Math.min(inner, front), lounge.x + half, Math.max(inner, front));
  }
  for (const side of [-1, 1]) round(lounge.x + side * BEANBAG_X, lounge.z, BEANBAG_FOOT);

  for (const rect of floor.roomSlots) {
    // The door: the cells of the west glass inside its gap, CLEARANCE in from either post.
    const door = doorGap(rect);
    ring(rect, (x, z) => x - rect.x < WALK_CELL && z > door.from + CLEARANCE && z < door.to - CLEARANCE);
    const t = tableCenter(rect);
    solid(t.x - TABLE.w / 2, t.z - TABLE.d / 2, t.x + TABLE.w / 2, t.z + TABLE.d / 2);
    // Its seats along the table's sides, and the head seat at its west end.
    for (const s of [...seatSpots(rect), headSpot(rect)]) solid(s.x - ROOM_SEAT / 2, s.z - ROOM_SEAT / 2, s.x + ROOM_SEAT / 2, s.z + ROOM_SEAT / 2);
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

/** The distance from the point to the segment a→b. */
function toSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2));
  return Math.hypot(a.x + t * dx - p.x, a.z + t * dz - p.z);
}

/** The distance from the segment a→b to the rectangle [x0, x1] by [z0, z1]: 0 when they meet. */
function gap(a: Point, b: Point, x0: number, z0: number, x1: number, z1: number): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  if (Math.max(a.x, b.x) >= x0 && Math.min(a.x, b.x) <= x1 && Math.max(a.z, b.z) >= z0 && Math.min(a.z, b.z) <= z1) {
    // Their boxes overlap: they meet unless the rectangle's corners all lie on one side of the segment's line.
    const s00 = dx * (z0 - a.z) - dz * (x0 - a.x);
    const s10 = dx * (z0 - a.z) - dz * (x1 - a.x);
    const s01 = dx * (z1 - a.z) - dz * (x0 - a.x);
    const s11 = dx * (z1 - a.z) - dz * (x1 - a.x);
    if (Math.min(s00, s10, s01, s11) <= 0 && Math.max(s00, s10, s01, s11) >= 0) return 0;
  }
  // Apart, the nearest two points are an end of the segment and the rectangle, or a corner of the rectangle and the segment.
  const toRect = (p: Point) => Math.hypot(Math.max(x0 - p.x, 0, p.x - x1), Math.max(z0 - p.z, 0, p.z - z1));
  return Math.min(
    toRect(a),
    toRect(b),
    toSegment({ x: x0, z: z0 }, a, b),
    toSegment({ x: x1, z: z0 }, a, b),
    toSegment({ x: x0, z: z1 }, a, b),
    toSegment({ x: x1, z: z1 }, a, b),
  );
}

/**
 * True when the segment a→b keeps at least CLEARANCE from every blocked cell and from the edges of the grid; never
 * when an end is off the grid. A step between the centres of two neighbouring free cells always does: a cell's centre
 * lies WALK_CELL / 2 from its edges, and a step across a corner needs both cells beside it free.
 */
function keepsClear(grid: WalkGrid, a: Point, b: Point): boolean {
  const { cols, rows, blocked } = grid;
  const w = cols * WALK_CELL;
  const h = rows * WALK_CELL;
  if (!(a.x >= 0 && a.x < w && a.z >= 0 && a.z < h && b.x >= 0 && b.x < w && b.z >= 0 && b.z < h)) return false;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const r0 = Math.floor((Math.min(a.z, b.z) - CLEARANCE) / WALK_CELL);
  const r1 = Math.floor((Math.max(a.z, b.z) + CLEARANCE) / WALK_CELL);
  for (let r = r0; r <= r1; r++) {
    // The part of the segment less than CLEARANCE from row r, and the columns less than CLEARANCE from that part.
    let lo = 0;
    let hi = 1;
    if (dz !== 0) {
      const ta = (r * WALK_CELL - CLEARANCE - a.z) / dz;
      const tb = ((r + 1) * WALK_CELL + CLEARANCE - a.z) / dz;
      lo = Math.max(0, Math.min(ta, tb));
      hi = Math.min(1, Math.max(ta, tb));
    }
    const xa = a.x + dx * lo;
    const xb = a.x + dx * hi;
    const c0 = Math.floor((Math.min(xa, xb) - CLEARANCE) / WALK_CELL);
    const c1 = Math.floor((Math.max(xa, xb) + CLEARANCE) / WALK_CELL);
    for (let c = c0; c <= c1; c++) {
      // A cell off the grid counts as blocked.
      if (c >= 0 && r >= 0 && c < cols && r < rows && blocked[r * cols + c] === 0) continue;
      if (gap(a, b, c * WALK_CELL, r * WALK_CELL, (c + 1) * WALK_CELL, (r + 1) * WALK_CELL) < CLEARANCE) return false;
    }
  }
  return true;
}

/** The centre of cell `i`. */
function centreOf(grid: WalkGrid, i: number): Point {
  return { x: ((i % grid.cols) + 0.5) * WALK_CELL, z: (Math.floor(i / grid.cols) + 0.5) * WALK_CELL };
}

/** The free cell whose centre is nearest the point (of two as near, the lower index); -1 when every cell is blocked. */
function nearestFree(grid: WalkGrid, p: Point): number {
  const { cols, rows, blocked } = grid;
  // The point's cell, or the nearest cell of the grid when the point is off it.
  const c = Math.min(cols - 1, Math.max(0, Math.floor(p.x / WALK_CELL)));
  const r = Math.min(rows - 1, Math.max(0, Math.floor(p.z / WALK_CELL)));
  if (blocked[r * cols + c] === 0) return r * cols + c;
  let best = -1;
  let bestD = Infinity;
  for (let k = 1; k < Math.max(cols, rows); k++) {
    // The cells k rings out are at least k - 1/2 cells from the point: once one nearer is found, none of them can beat it.
    const bound = (k - 0.5) * WALK_CELL;
    if (bestD <= bound * bound) break;
    for (let rr = Math.max(0, r - k); rr <= Math.min(rows - 1, r + k); rr++) {
      const edge = rr === r - k || rr === r + k;
      for (let cc = c - k; cc <= c + k; cc += edge ? 1 : 2 * k) {
        if (cc < 0 || cc >= cols) continue;
        const i = rr * cols + cc;
        if (blocked[i] === 1) continue;
        const q = centreOf(grid, i);
        const d = (q.x - p.x) ** 2 + (q.z - p.z) ** 2;
        if (d < bestD || (d === bestD && i < best)) {
          best = i;
          bestD = d;
        }
      }
    }
  }
  return best;
}

/** The 8 neighbours of a cell, as column and row steps: the 4 sides, then the 4 corners. */
const STEPS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [0, 1],
  [-1, 0],
  [1, 0],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];

/**
 * A* from cell `start` to cell `goal`: over 8 neighbours, never past the corner of a blocked cell, with the octile
 * distance as its heuristic. The open set is a binary heap ordered by f, then h, then cell index, so that the same grid
 * and ends always give the same cells. The cells from start to goal, both included; null when the goal is out of reach.
 */
function search(grid: WalkGrid, start: number, goal: number): number[] | null {
  const { cols, rows, blocked } = grid;
  const n = cols * rows;
  const g = new Float64Array(n).fill(Infinity);
  const h = new Float64Array(n);
  const f = new Float64Array(n);
  const came = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const heap = new Int32Array(n);
  /** Where each cell is in the heap; -1 when it is not. */
  const slot = new Int32Array(n).fill(-1);
  let size = 0;

  const gc = goal % cols;
  const gr = Math.floor(goal / cols);
  const octile = (i: number) => {
    const dc = Math.abs((i % cols) - gc);
    const dr = Math.abs(Math.floor(i / cols) - gr);
    return dc + dr + (Math.SQRT2 - 2) * Math.min(dc, dr);
  };
  const before = (a: number, b: number) => f[a]! < f[b]! || (f[a] === f[b] && (h[a]! < h[b]! || (h[a] === h[b] && a < b)));
  const put = (i: number, k: number) => {
    heap[k] = i;
    slot[i] = k;
  };
  const up = (k: number) => {
    const i = heap[k]!;
    while (k > 0) {
      const parent = (k - 1) >> 1;
      if (!before(i, heap[parent]!)) break;
      put(heap[parent]!, k);
      k = parent;
    }
    put(i, k);
  };
  const down = (k: number) => {
    const i = heap[k]!;
    for (;;) {
      const left = 2 * k + 1;
      if (left >= size) break;
      const child = left + 1 < size && before(heap[left + 1]!, heap[left]!) ? left + 1 : left;
      if (!before(heap[child]!, i)) break;
      put(heap[child]!, k);
      k = child;
    }
    put(i, k);
  };
  const free = (c: number, r: number) => c >= 0 && r >= 0 && c < cols && r < rows && blocked[r * cols + c] === 0;

  g[start] = 0;
  h[start] = octile(start);
  f[start] = h[start]!;
  put(start, 0);
  size = 1;
  while (size > 0) {
    const cur = heap[0]!;
    slot[cur] = -1;
    size--;
    if (size > 0) {
      put(heap[size]!, 0);
      down(0);
    }
    if (cur === goal) {
      const cells: number[] = [];
      for (let i = goal; i !== -1; i = came[i]!) cells.push(i);
      return cells.reverse();
    }
    closed[cur] = 1;
    const cc = cur % cols;
    const cr = Math.floor(cur / cols);
    for (const [dc, dr] of STEPS) {
      if (!free(cc + dc, cr + dr)) continue;
      // A step across a corner needs both cells beside it free.
      if (dc !== 0 && dr !== 0 && !(free(cc + dc, cr) && free(cc, cr + dr))) continue;
      const next = (cr + dr) * cols + cc + dc;
      if (closed[next]) continue;
      const cost = g[cur]! + (dc !== 0 && dr !== 0 ? Math.SQRT2 : 1);
      if (cost >= g[next]!) continue;
      g[next] = cost;
      came[next] = cur;
      if (slot[next] === -1) {
        h[next] = octile(next);
        f[next] = cost + h[next]!;
        put(next, size);
        size++;
        up(size - 1);
      } else {
        f[next] = cost + h[next]!;
        up(slot[next]!);
      }
    }
  }
  return null;
}

/**
 * A walkable path from `from` to `to`: A* over 8 neighbours without corner cutting and with an octile heuristic,
 * from the nearest free cell of each end, string-pulled only along segments that keep CLEARANCE from every blocked cell.
 * Only the first segment (leaving a seat) and the last (sitting down on one) may cross a blocked cell. The points after
 * `from`, the last exactly `to`; [to] when there is no path.
 */
export function findPath(grid: WalkGrid, from: Point, to: Point): Point[] {
  const end = { x: to.x, z: to.z };
  const start = nearestFree(grid, from);
  const goal = nearestFree(grid, to);
  const cells = start === -1 || goal === -1 ? null : search(grid, start, goal);
  if (!cells) return [end];
  // From where it stands, through the centre of each cell, to the end. Each point then goes on to the farthest it reaches
  // keeping CLEARANCE, else to the next point. From a cell's centre the next always keeps it, so only the step from
  // `from` to the first cell and the step from the last cell to `to` may cross a blocked cell: off a seat, onto one.
  const points = [{ x: from.x, z: from.z }, ...cells.map((i) => centreOf(grid, i)), end];
  const out: Point[] = [];
  for (let i = 0; i < points.length - 1; ) {
    let j = points.length - 1;
    while (j > i + 1 && !keepsClear(grid, points[i]!, points[j]!)) j--;
    out.push(points[j]!);
    i = j;
  }
  return out;
}
