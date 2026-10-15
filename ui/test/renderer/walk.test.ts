import { describe, expect, it } from 'vitest';
import { BLOCK_DESKS, LOUNGE_SEATS, ROOMS_PER_COL, layoutPlan } from '../../../src/scene/layout';
import type { FloorDetail } from '../../../src/scene/types';
import { WALK_CELL, findPath, lineOfSight, walkGrid, type WalkGrid } from '../../renderer/walk';
import {
  BEANBAG_R,
  BEANBAG_X,
  COUCH,
  COUCH_Z,
  barCartSpots,
  deskAnchor,
  elevatorSpot,
  foosballSpots,
  headSpot,
  loungeSpots,
  rectCenter,
  seatSpot,
  seatSpots,
  standSpot,
  type Point,
  type Spot,
} from '../../renderer/world';
import { makeFloor, type DeskSpec, type RoomSpec } from './fixtures';

type Plan = Pick<FloorDetail, 'size' | 'core' | 'pods' | 'lounge' | 'roomSlots' | 'breakArea'>;

/** Every plan size: 1 to 4 blocks, 1 or 2 room columns. */
const SIZES = [1, 2, 3, 4].flatMap((blocks) => [1, 2].map((roomCols) => ({ blocks, roomCols })));

/** A floor of this size with every desk taken, somebody on every lounge seat and a run in every room. */
function fullFloor(blocks: number, roomCols: number): FloorDetail {
  const desks = Array.from({ length: BLOCK_DESKS * blocks }, (_, i): DeskSpec => (i < LOUNGE_SEATS ? { id: `s${i}`, state: 'idle', lounge: i } : { id: `s${i}`, state: 'working' }));
  const rooms = Array.from({ length: ROOMS_PER_COL * roomCols }, (_, slot): RoomSpec => ({ runId: `wf_0000aaaa-00${slot}`, host: `s${slot}`, running: 8, slot }));
  return makeFloor([{ key: '/demo/storefront-web', repo: 'storefront-web', color: 2, tie: 4, desks }], 'feature:checkout-v2', rooms);
}

/** The same plan with nobody on it: every desk free, every room closed. */
function emptyFloor(blocks: number, roomCols: number): Plan {
  const plan = layoutPlan({ blocks, roomCols });
  return {
    size: plan.size,
    core: plan.core,
    pods: plan.pods.map((p) => ({ ...p, color: null, placard: null, desks: p.desks.map((d) => ({ ...d, occupant: null })) })),
    lounge: { rect: plan.lounge, seats: LOUNGE_SEATS },
    roomSlots: plan.rooms,
    breakArea: plan.breakArea,
  };
}

/** Every spot a robot walks to, named: each desk's seat and stand spots, the lounge's seats, each room's seats and head, and the break area's cart and table spots. */
function spotsOf(floor: Plan): Array<[string, Spot]> {
  return [
    ...floor.pods.flatMap((p) => p.desks.flatMap((d): Array<[string, Spot]> => [[`seat ${d.id}`, seatSpot(d)], [`stand ${d.id}`, standSpot(d)]])),
    ...loungeSpots(floor.lounge.rect).map((s, i): [string, Spot] => [`lounge ${i}`, s]),
    ...floor.roomSlots.flatMap((rect, slot): Array<[string, Spot]> => [...seatSpots(rect).map((s, i): [string, Spot] => [`room ${slot} seat ${i}`, s]), [`room ${slot} head`, headSpot(rect)]]),
    ...barCartSpots(floor.breakArea).map((s, i): [string, Spot] => [`cart ${i}`, s]),
    ...foosballSpots(floor.breakArea).map((s, i): [string, Spot] => [`foosball ${i}`, s]),
  ];
}

const isBlocked = (grid: WalkGrid, p: Point) => grid.blocked[Math.floor(p.z / WALK_CELL) * grid.cols + Math.floor(p.x / WALK_CELL)] === 1;

/** The grid from x0 to x1 and z0 to z1 metres as a picture: a line per row of cells, north first, '#' where blocked. */
function picture(grid: WalkGrid, x0: number, z0: number, x1: number, z1: number): string[] {
  const lines: string[] = [];
  for (let r = z0 / WALK_CELL; r < z1 / WALK_CELL; r++) {
    let line = '';
    for (let c = x0 / WALK_CELL; c < x1 / WALK_CELL; c++) line += grid.blocked[r * grid.cols + c] === 1 ? '#' : '.';
    lines.push(line);
  }
  return lines;
}

/** A room, 8 x 6 m: its glass all round but for the door in the west wall, its table, its seats along the table's sides and its head seat at the table's west end. */
const ROOM_PICTURE = [
  '################',
  '#..............#',
  '#..............#',
  '#..............#',
  '#...########...#',
  '...##########..#',
  '..###########..#',
  '#..##########..#',
  '#...########...#',
  '#...########...#',
  '#..............#',
  '################',
];

/** How far walk.ts keeps a walking robot's centre from every blocked cell (its CLEARANCE). */
const CLEARANCE = 0.2;

/** The distance from the point to the nearest blocked cell or the grid's edge, looking one cell round the point's own; Infinity when none of them is blocked. */
function gapAt(grid: WalkGrid, p: Point): number {
  const c0 = Math.floor(p.x / WALK_CELL);
  const r0 = Math.floor(p.z / WALK_CELL);
  let gap = Infinity;
  for (let r = r0 - 1; r <= r0 + 1; r++) {
    for (let c = c0 - 1; c <= c0 + 1; c++) {
      if (c >= 0 && r >= 0 && c < grid.cols && r < grid.rows && grid.blocked[r * grid.cols + c] === 0) continue;
      const dx = Math.max(c * WALK_CELL - p.x, 0, p.x - (c + 1) * WALK_CELL);
      const dz = Math.max(r * WALK_CELL - p.z, 0, p.z - (r + 1) * WALK_CELL);
      gap = Math.min(gap, Math.hypot(dx, dz));
    }
  }
  return gap;
}

/** What robots sit on, as props.ts draws it, each with the spots it serves and its bounding box. */
interface Seat {
  spots: string[];
  box: { x0: number; z0: number; x1: number; z1: number };
  inside: (p: Point) => boolean;
}

/** Every seat on the floor as props.ts draws it: each desk's chair (its seat and back), each couch with its arms, each beanbag, and each room seat and head seat. */
function seatsOf(floor: Plan): Seat[] {
  const rect = (spots: string[], x0: number, z0: number, x1: number, z1: number): Seat => {
    const box = { x0: Math.min(x0, x1), z0: Math.min(z0, z1), x1: Math.max(x0, x1), z1: Math.max(z0, z1) };
    return { spots, box, inside: (p) => p.x >= box.x0 && p.x <= box.x1 && p.z >= box.z0 && p.z <= box.z1 };
  };
  const bag = (x: number, z: number, spots: string[]): Seat => {
    const r = BEANBAG_R * 1.05;
    return { spots, box: { x0: x - r, z0: z - r, x1: x + r, z1: z + r }, inside: (p) => Math.hypot(p.x - x, p.z - z) <= r };
  };
  const c = rectCenter(floor.lounge.rect);
  const couch = (z: number, spots: string[]) => rect(spots, c.x - COUCH.w / 2 - 0.13, z - COUCH.d / 2, c.x + COUCH.w / 2 + 0.13, z + COUCH.d / 2);
  const chairs = floor.pods.flatMap((pod) =>
    pod.desks.map((d) => {
      const a = deskAnchor(d);
      const s = d.chair === 'south' ? 1 : -1;
      return rect([`seat ${d.id}`, `stand ${d.id}`], a.x - 0.25, a.z + s * 0.53, a.x + 0.25, a.z + s * 1.065);
    }),
  );
  return [
    ...chairs,
    couch(c.z - COUCH_Z, ['lounge 0', 'lounge 1', 'lounge 2']),
    couch(c.z + COUCH_Z, ['lounge 3', 'lounge 4', 'lounge 5']),
    bag(c.x - BEANBAG_X, c.z, ['lounge 6']),
    bag(c.x + BEANBAG_X, c.z, ['lounge 7']),
    ...spotsOf(floor)
      .filter(([name]) => name.startsWith('room'))
      .map(([name, s]) => rect([name], s.x - 0.23, s.z - 0.23, s.x + 0.23, s.z + 0.23)),
  ];
}

/** The kind of a named spot: elevator, seat, stand, lounge, room (a room seat) or head. */
const kindOf = (name: string) => (name.startsWith('room') ? (name.endsWith('head') ? 'head' : 'room') : name.split(' ')[0]!);
/** The walks of design §5.2, by the kinds of spot they join. A desk's seat and stand go only to each other's own desk. */
const FLOWS = new Set([
  'elevator>seat',
  'seat>elevator',
  'stand>elevator',
  'seat>stand',
  'stand>seat',
  'seat>lounge',
  'lounge>seat',
  'lounge>elevator',
  'seat>head',
  'head>seat',
  'head>elevator',
  'elevator>room',
  'room>elevator',
]);
/** The longest step off a seat or onto one: between a room's south seat and the free row behind it, 0.89 m. */
const SEAT_STEP = 0.9;

describe('walkGrid', () => {
  it('covers the floor in half-metre cells, row by row, at every plan size', () => {
    expect(WALK_CELL).toBe(0.5);
    for (const { blocks, roomCols } of SIZES) {
      const floor = fullFloor(blocks, roomCols);
      const grid = walkGrid(floor);
      expect([grid.cols, grid.rows, grid.blocked.length]).toEqual([2 * floor.size.w, 2 * floor.size.h, 4 * floor.size.w * floor.size.h]);
    }
  });

  it('blocks the ring of cells along the outer walls, and not the cells inside it', () => {
    const grid = walkGrid(fullFloor(1, 1));
    const { cols, rows, blocked } = grid;
    expect([cols, rows]).toEqual([56, 40]);
    // The north and south rows, and the rows just inside them.
    for (let c = 0; c < cols; c++) {
      const outer = c === 0 || c === cols - 1;
      expect([blocked[c], blocked[(rows - 1) * cols + c], blocked[cols + c], blocked[(rows - 2) * cols + c]], `column ${c}`).toEqual(outer ? [1, 1, 1, 1] : [1, 1, 0, 0]);
    }
    // The west and east columns, and the columns just inside them.
    for (let r = 0; r < rows; r++) {
      const outer = r === 0 || r === rows - 1;
      expect([blocked[r * cols], blocked[r * cols + cols - 1], blocked[r * cols + 1], blocked[r * cols + cols - 2]], `row ${r}`).toEqual(outer ? [1, 1, 1, 1] : [1, 1, 0, 0]);
    }
  });

  it("blocks the core's two plants, and leaves the way out of the elevator free", () => {
    const floor = fullFloor(1, 1);
    const grid = walkGrid(floor);
    expect(picture(grid, 0, 0, 8, 5)).toEqual([
      '################',
      '#...............',
      '#...............',
      '#...............',
      '#...............',
      '#...............',
      '#...##....##....',
      '#...##....##....',
      '#...............',
      '#...............',
    ]);
    expect(isBlocked(grid, elevatorSpot(floor.core))).toBe(false);
  });

  it("blocks each desk's top and monitor, the half of its cells away from its chair, and its chair, the two middle cells of the other half", () => {
    const floor = fullFloor(4, 2);
    const grid = walkGrid(floor);
    // The first pod: its four desks back to back in the middle of its rug, their chairs either side.
    expect(picture(grid, 2, 6, 8, 12)).toEqual([
      '............',
      '............',
      '...##..##...',
      '...##..##...',
      '..########..',
      '..########..',
      '..########..',
      '..########..',
      '...##..##...',
      '...##..##...',
      '............',
      '............',
    ]);
    const desks = floor.pods.flatMap((p) => p.desks);
    expect(desks).toHaveLength(32);
    for (const desk of desks) {
      const { x, y } = desk.rect;
      const monitor = desk.chair === 'south' ? y : y + 1;
      const chair = desk.chair === 'south' ? y + 1 : y;
      expect(picture(grid, x, monitor, x + 2, monitor + 1), desk.id).toEqual(['####', '####']);
      expect(picture(grid, x, chair, x + 2, chair + 1), desk.id).toEqual(['.##.', '.##.']);
    }
  });

  it("blocks each room's glass but for its door, its table and its seats, and nothing else in the room", () => {
    const floor = fullFloor(4, 2);
    const grid = walkGrid(floor);
    expect(floor.roomSlots).toHaveLength(4);
    for (const r of floor.roomSlots) expect(picture(grid, r.x, r.y, r.x + r.w, r.y + r.h), JSON.stringify(r)).toEqual(ROOM_PICTURE);
  });

  it("blocks the lounge's coffee table, each couch's back, seat and arms, and the beanbags, and leaves free the row between each couch and the table", () => {
    for (const blocks of [1, 4]) {
      const floor = fullFloor(blocks, 1);
      const grid = walkGrid(floor);
      const { x, y, w, h } = floor.lounge.rect;
      expect(picture(grid, x, y, x + w, y + h), `${blocks} blocks`).toEqual([
        '...........######...........',
        '...........######...........',
        '............................',
        '........###.####.###........',
        '........###.####.###........',
        '............................',
        '...........######...........',
        '...........######...........',
      ]);
    }
  });

  it("blocks only the bar cart's and the biliardino table's own footprint in the break area, leaving every stand spot free", () => {
    const floor = fullFloor(1, 1);
    const grid = walkGrid(floor);
    const rect = floor.breakArea;
    expect(picture(grid, rect.x, rect.y, rect.x + rect.w, rect.y + rect.h)).toEqual([
      '................',
      '................',
      '...##......####.',
      '...##......####.',
      '................',
      '................',
    ]);
    for (const spot of [...barCartSpots(rect), ...foosballSpots(rect)]) expect(isBlocked(grid, spot), `${spot.x} ${spot.z}`).toBe(false);
  });

  it('keeps the elevator spot and every stand spot on a free cell, and every seat on a blocked one: desk chairs, lounge seats, room seats and heads, at every plan size', () => {
    for (const { blocks, roomCols } of SIZES) {
      const floor = fullFloor(blocks, roomCols);
      const grid = walkGrid(floor);
      const spots: Array<[string, Point]> = [['elevator', elevatorSpot(floor.core)], ...spotsOf(floor)];
      // Two spots a desk, the lounge's eight, nine a room (its eight seats and its head), the cart's four and the table's two.
      expect(spots).toHaveLength(1 + 16 * blocks + 8 + 18 * roomCols + 4 + 2);
      const free = (name: string) => name === 'elevator' || name.startsWith('stand') || name.startsWith('cart') || name.startsWith('foosball');
      expect(spots.filter(([name, s]) => isBlocked(grid, s) === free(name)).map(([name]) => `${blocks}x${roomCols} ${name}`)).toEqual([]);
    }
  });

  it('blocks nothing else, at every plan size: the walls, 12 cells a desk, 105 a room, 44 in the lounge, 8 in the core and 12 in the break area', () => {
    for (const { blocks, roomCols } of SIZES) {
      const grid = walkGrid(fullFloor(blocks, roomCols));
      const walls = 2 * (grid.cols + grid.rows) - 4;
      // A desk: its top and monitor (8) and its chair (4). A room: its glass, the ring of 16 x 12 cells but the 2 of its
      // door (50), its table (30), its north seats (8), its south seats (16) and its head seat (1, the other cell it
      // touches being the table's). The lounge: each couch (12), the coffee table (8) and each beanbag (6). The break
      // area: the cart (4) and the table (8).
      const expected = walls + 12 * BLOCK_DESKS * blocks + 105 * ROOMS_PER_COL * roomCols + 44 + 8 + 12;
      expect(grid.blocked.reduce((n, b) => n + b, 0), `${blocks}x${roomCols}`).toBe(expected);
    }
  });

  it('leaves the free cells one connected area at every plan size', () => {
    for (const { blocks, roomCols } of SIZES) {
      const { cols, rows, blocked } = walkGrid(fullFloor(blocks, roomCols));
      // Flood the free cells from the first, through their sides: a step across a corner needs both cells beside it
      // free, so the sides alone reach every cell the steps do.
      const seen = new Uint8Array(cols * rows);
      const first = blocked.indexOf(0);
      const stack = [first];
      seen[first] = 1;
      let reached = 0;
      while (stack.length > 0) {
        const i = stack.pop()!;
        reached++;
        const c = i % cols;
        for (const j of [i - cols, i + cols, c > 0 ? i - 1 : -1, c < cols - 1 ? i + 1 : -1]) {
          if (j < 0 || j >= cols * rows || blocked[j] === 1 || seen[j] === 1) continue;
          seen[j] = 1;
          stack.push(j);
        }
      }
      expect(reached, `${blocks}x${roomCols}`).toBe(blocked.length - blocked.reduce((n, b) => n + b, 0));
    }
  });

  it('keeps every door open and does not change with who sits where, which rooms are open, or the order of pods and rooms', () => {
    for (const { blocks, roomCols } of SIZES) {
      const grid = walkGrid(fullFloor(blocks, roomCols));
      const empty = emptyFloor(blocks, roomCols);
      expect(walkGrid(empty)).toEqual(grid);
      expect(walkGrid({ ...empty, pods: [...empty.pods].reverse(), roomSlots: [...empty.roomSlots].reverse() })).toEqual(grid);
      expect(walkGrid(empty).blocked).not.toBe(walkGrid(empty).blocked);
    }
  });
});

describe('lineOfSight', () => {
  const floor = fullFloor(1, 1);
  const grid = walkGrid(floor);
  const desks = floor.pods[0]!.desks;
  const room = floor.roomSlots[0]!;

  it('sees along an aisle, out of the elevator and into a room through its door, and not through desks, glass, a table or a seat', () => {
    // The aisle between the block's two pods.
    expect(lineOfSight(grid, { x: 9, z: 5 }, { x: 9, z: 13 })).toBe(true);
    expect(lineOfSight(grid, elevatorSpot(floor.core), { x: 4, z: 5 })).toBe(true);
    // From the chair of a north-row desk to the chair behind it, across both desks.
    expect(lineOfSight(grid, seatSpot(desks[0]!), seatSpot(desks[2]!))).toBe(false);
    // Through the door to the cell beside the head seat, but not onto the seat.
    expect(lineOfSight(grid, { x: 17, z: 5 }, { x: 18.75, z: 5.25 })).toBe(true);
    expect(lineOfSight(grid, { x: 17, z: 5 }, headSpot(room))).toBe(false);
    expect(lineOfSight(grid, { x: 17, z: 3 }, { x: 19, z: 3 })).toBe(false);
    expect(lineOfSight(grid, { x: 17, z: 5 }, { x: 25, z: 5 })).toBe(false);
  });

  it('counts both ends: a segment from or to a blocked cell, or off the floor, is not clear', () => {
    const onDesk = { x: 5, z: 9 };
    const aisle = { x: 9, z: 9 };
    expect(lineOfSight(grid, onDesk, aisle)).toBe(false);
    expect(lineOfSight(grid, aisle, onDesk)).toBe(false);
    expect(lineOfSight(grid, onDesk, onDesk)).toBe(false);
    expect(lineOfSight(grid, aisle, aisle)).toBe(true);
    expect(lineOfSight(grid, { x: -0.5, z: 5 }, { x: 1, z: 5 })).toBe(false);
    expect(lineOfSight(grid, { x: 9, z: 5 }, { x: 9, z: 25 })).toBe(false);
  });

  it('never steps over a blocked cell: it looks at least every quarter metre', () => {
    const line: WalkGrid = { cols: 9, rows: 1, blocked: Uint8Array.from([0, 0, 0, 0, 1, 0, 0, 0, 0]) };
    expect(lineOfSight(line, { x: 0.25, z: 0.25 }, { x: 4.25, z: 0.25 })).toBe(false);
    // Just across the blocked cell, from the cell before it to the cell after it.
    expect(lineOfSight(line, { x: 1.99, z: 0.25 }, { x: 2.51, z: 0.25 })).toBe(false);
    expect(lineOfSight(line, { x: 0.1, z: 0.25 }, { x: 1.99, z: 0.25 })).toBe(true);
    expect(lineOfSight(line, { x: 2.6, z: 0.4 }, { x: 4.4, z: 0.1 })).toBe(true);
  });
});

describe('findPath', () => {
  /** A grid drawn as a picture: a line per row of cells, north first, '#' where blocked. */
  const gridOf = (lines: string[]): WalkGrid => ({ cols: lines[0]!.length, rows: lines.length, blocked: Uint8Array.from(lines.join('').split(''), (ch) => (ch === '#' ? 1 : 0)) });
  /** The centre of cell (c, r). */
  const centre = (c: number, r: number): Point => ({ x: (c + 0.5) * WALK_CELL, z: (r + 0.5) * WALK_CELL });
  /** Whether each step of the walk, from `from` through the path, is in sight. */
  const inSight = (grid: WalkGrid, from: Point, path: Point[]) => path.every((p, i) => lineOfSight(grid, i === 0 ? from : path[i - 1]!, p));

  it('walks from the elevator to every seat, stand, lounge, room seat and head spot at every plan size, each step in sight but the last onto a seat, ending exactly on the spot', () => {
    let walks = 0;
    for (const { blocks, roomCols } of SIZES) {
      const floor = fullFloor(blocks, roomCols);
      const grid = walkGrid(floor);
      const from = elevatorSpot(floor.core);
      const bad: string[] = [];
      for (const [name, to] of spotsOf(floor)) {
        const path = findPath(grid, from, to);
        const last = path[path.length - 1]!;
        if (last.x !== to.x || last.z !== to.z) bad.push(`${name}: ends at ${JSON.stringify(last)}`);
        // A seat's cells are blocked: the last step sits down on it from the free cell nearest it.
        if (!inSight(grid, from, isBlocked(grid, to) ? path.slice(0, -1) : path)) bad.push(`${name}: ${JSON.stringify(path)} has a step out of sight`);
        walks++;
      }
      expect(bad, `${blocks}x${roomCols}`).toEqual([]);
    }
    expect(walks).toBe(648);
  });

  const floor = fullFloor(1, 1);
  const grid = walkGrid(floor);
  const desks = floor.pods[0]!.desks;

  it('goes straight to an end it can see', () => {
    expect(findPath(grid, elevatorSpot(floor.core), { x: 9, z: 5 })).toEqual([{ x: 9, z: 5 }]);
    expect(findPath(grid, { x: 9, z: 5 }, { x: 9.1, z: 5.1 })).toEqual([{ x: 9.1, z: 5.1 }]);
  });

  it('goes round the desks between two chairs back to back, and through the door to the head of a room, onto each seat from the free cell beside it', () => {
    const from = seatSpot(desks[0]!);
    const to = seatSpot(desks[2]!);
    expect(findPath(grid, from, to)).toEqual([{ x: 3.25, z: 7.75 }, { x: 2.75, z: 7.75 }, { x: 2.75, z: 10.25 }, { x: 3.25, z: 10.25 }, { x: to.x, z: to.z }]);
    const head = headSpot(floor.roomSlots[1]!);
    expect(findPath(grid, elevatorSpot(floor.core), head)).toEqual([
      { x: 14.75, z: 6.75 },
      { x: 17.75, z: 11.75 },
      { x: 18.75, z: 12.25 },
      { x: 18.75, z: 12.75 },
      { x: 19.25, z: 12.75 },
      { x: head.x, z: head.z },
    ]);
  });

  it('leaves a blocked cell by the nearest free one, and ends exactly on a blocked end, from the free cell nearest it', () => {
    // Standing on a desk top: out to the nearer of the two free cells either side of its chair (the one west), then on.
    expect(findPath(grid, deskAnchor(desks[0]!), { x: 9, z: 5 })).toEqual([{ x: 3.25, z: 7.75 }, { x: 3.25, z: 6.75 }, { x: 9, z: 5 }]);
    const onDesk = deskAnchor(floor.pods[1]!.desks[2]!);
    expect(onDesk).toEqual({ x: 12, z: 9.6 });
    expect(findPath(grid, { x: 9, z: 5 }, onDesk)).toEqual([{ x: 10.75, z: 10.25 }, { x: 11.25, z: 10.25 }, { x: 12, z: 9.6 }]);
  });

  it('gives [to] when either end is shut in, or every cell is blocked', () => {
    const box = gridOf(['.....', '.###.', '.#.#.', '.###.', '.....']);
    expect(findPath(box, centre(0, 0), centre(2, 2))).toEqual([centre(2, 2)]);
    expect(findPath(box, centre(2, 2), centre(4, 4))).toEqual([centre(4, 4)]);
    expect(findPath(gridOf(['###', '###']), centre(0, 0), centre(2, 1))).toEqual([centre(2, 1)]);
  });

  it('never cuts a corner between two blocked cells', () => {
    // The north-west pocket opens only across the corner of (1, 1): shut in. With (2, 1) open, the way goes round.
    const pocket = gridOf(['..#..', '..#..', '##...', '.....']);
    expect(findPath(pocket, centre(0, 0), centre(4, 0))).toEqual([centre(4, 0)]);
    const open = gridOf(['..#..', '.....', '##...', '.....']);
    const path = findPath(open, centre(0, 0), centre(4, 0));
    expect(path).toEqual([centre(1, 1), centre(3, 1), centre(4, 0)]);
    expect(inSight(open, centre(0, 0), path)).toBe(true);
    // Two blocked cells meeting at a corner: no straight run passes between them either.
    const pinch = gridOf(['....', '.#..', '..#.', '....']);
    expect(findPath(pinch, centre(0, 3), centre(3, 0))).toEqual([centre(0, 0), centre(3, 0)]);
  });

  it('keeps CLEARANCE from every blocked cell and from the edge of the grid, but on its first step and its last', () => {
    const corner = gridOf(['....', '#...']);
    // Straight from cell (0, 0) to cell (3, 1), a robot would pass 0.16 m from the corner of the blocked cell (0, 1).
    expect(findPath(corner, centre(0, 0), centre(3, 1))).toEqual([centre(1, 0), centre(3, 1)]);
    // From 0.1 m off the north edge: first to the centre of its cell, then on.
    expect(findPath(corner, { x: 1.75, z: 0.1 }, centre(0, 0))).toEqual([centre(3, 0), centre(0, 0)]);
  });

  it('gives the same path for the same ends on any grid of the same plan', () => {
    const full = fullFloor(4, 2);
    const from = elevatorSpot(full.core);
    const to = loungeSpots(full.lounge.rect)[4]!;
    const path = findPath(walkGrid(full), from, to);
    // A long walk on the fullest plan: down the east side of the west pods, between the west beanbag and the coffee
    // table, and onto the south couch's middle seat from the row in front of it.
    expect(path).toEqual([{ x: 7.25, z: 3.75 }, { x: 7.25, z: 39.25 }, { x: 7.75, z: 39.25 }, { x: 7.75, z: 40.75 }, { x: 8.75, z: 40.75 }, { x: to.x, z: to.z }]);
    expect(findPath(walkGrid(emptyFloor(4, 2)), from, to)).toEqual(path);
    expect(findPath(walkGrid(full), { ...from }, { ...to })).toEqual(path);
  });

  it("walks design §5.2's flows at every plan size keeping CLEARANCE from every blocked cell, but for a short step off a seat and onto one, and across no other seat", () => {
    let walks = 0;
    for (const { blocks, roomCols } of SIZES) {
      const floor = emptyFloor(blocks, roomCols);
      const grid = walkGrid(floor);
      const seats = seatsOf(floor);
      const spots: Array<[string, Spot]> = [['elevator', elevatorSpot(floor.core)], ...spotsOf(floor)];
      const bad: string[] = [];
      for (const [na, a] of spots) {
        for (const [nb, b] of spots) {
          const flow = `${kindOf(na)}>${kindOf(nb)}`;
          if (!FLOWS.has(flow)) continue;
          if ((flow === 'seat>stand' || flow === 'stand>seat') && na.split(' ')[1] !== nb.split(' ')[1]) continue;
          walks++;
          const path = findPath(grid, a, b);
          const walk = `${na} -> ${nb} ${JSON.stringify(path)}`;
          const last = path[path.length - 1]!;
          if (last.x !== b.x || last.z !== b.z) bad.push(`${walk}: ends elsewhere`);
          if (path.slice(0, -1).some((p) => gapAt(grid, p) < CLEARANCE - 1e-9)) bad.push(`${walk}: a point within CLEARANCE`);
          const others = seats.filter((s) => !s.spots.includes(na) && !s.spots.includes(nb));
          const poly = [a, ...path];
          for (let k = 0; k + 1 < poly.length; k++) {
            const p = poly[k]!;
            const q = poly[k + 1]!;
            const length = Math.hypot(q.x - p.x, q.z - p.z);
            const near = others.filter((s) => s.box.x1 >= Math.min(p.x, q.x) && s.box.x0 <= Math.max(p.x, q.x) && s.box.z1 >= Math.min(p.z, q.z) && s.box.z0 <= Math.max(p.z, q.z));
            // Every centimetre along the step.
            const n = Math.max(1, Math.ceil(length / 0.01));
            let gap = Infinity;
            let across: Seat | undefined;
            for (let i = 0; i <= n; i++) {
              const at = { x: p.x + ((q.x - p.x) * i) / n, z: p.z + ((q.z - p.z) * i) / n };
              gap = Math.min(gap, gapAt(grid, at));
              across ??= near.find((s) => s.inside(at));
            }
            const end = k === 0 || k === poly.length - 2;
            if (gap < CLEARANCE - 1e-9 && !(end && length <= SEAT_STEP)) bad.push(`${walk}: step ${k} comes ${gap.toFixed(3)} m from a blocked cell`);
            if (across) bad.push(`${walk}: step ${k} crosses ${across.spots[0]}`);
          }
        }
      }
      expect(bad, `${blocks}x${roomCols}`).toEqual([]);
    }
    // At a size with d desks and m rooms: 21 d + 2 d m + 8 + 17 m walks.
    expect(walks).toBe(4792);
  }, 60_000);
});
