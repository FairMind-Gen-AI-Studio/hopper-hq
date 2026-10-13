import { describe, expect, it } from 'vitest';
import { BLOCK_DESKS, LOUNGE_SEATS, ROOMS_PER_COL, layoutPlan } from '../../../src/scene/layout';
import type { FloorDetail } from '../../../src/scene/types';
import { WALK_CELL, findPath, lineOfSight, walkGrid, type WalkGrid } from '../../renderer/walk';
import { deskAnchor, elevatorSpot, headSpot, loungeSpots, seatSpot, seatSpots, standSpot, type Point, type Spot } from '../../renderer/world';
import { makeFloor, type DeskSpec, type RoomSpec } from './fixtures';

type Plan = Pick<FloorDetail, 'size' | 'core' | 'pods' | 'lounge' | 'roomSlots'>;

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
  };
}

/** Every spot a robot walks to, named: each desk's seat and stand spots, the lounge's seats, each room's seats and head. */
function spotsOf(floor: Plan): Array<[string, Spot]> {
  return [
    ...floor.pods.flatMap((p) => p.desks.flatMap((d): Array<[string, Spot]> => [[`seat ${d.id}`, seatSpot(d)], [`stand ${d.id}`, standSpot(d)]])),
    ...loungeSpots(floor.lounge.rect).map((s, i): [string, Spot] => [`lounge ${i}`, s]),
    ...floor.roomSlots.flatMap((rect, slot): Array<[string, Spot]> => [...seatSpots(rect).map((s, i): [string, Spot] => [`room ${slot} seat ${i}`, s]), [`room ${slot} head`, headSpot(rect)]]),
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

/** A room, 8 x 6 m: its glass all round but for the door in the west wall, and its table. */
const ROOM_PICTURE = [
  '################',
  '#..............#',
  '#..............#',
  '#..............#',
  '#..............#',
  '...##########..#',
  '...##########..#',
  '#..##########..#',
  '#..............#',
  '#..............#',
  '#..............#',
  '################',
];

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

  it("blocks each desk's top and monitor, the half of its cells away from its chair, and leaves the chair's half free", () => {
    const floor = fullFloor(4, 2);
    const grid = walkGrid(floor);
    // The first pod: its four desks back to back in the middle of its rug.
    expect(picture(grid, 2, 6, 8, 12)).toEqual([
      '............',
      '............',
      '............',
      '............',
      '..########..',
      '..########..',
      '..########..',
      '..########..',
      '............',
      '............',
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
      expect(picture(grid, x, chair, x + 2, chair + 1), desk.id).toEqual(['....', '....']);
    }
  });

  it("blocks each room's glass but for its door, and its table, and nothing else in the room", () => {
    const floor = fullFloor(4, 2);
    const grid = walkGrid(floor);
    expect(floor.roomSlots).toHaveLength(4);
    for (const r of floor.roomSlots) expect(picture(grid, r.x, r.y, r.x + r.w, r.y + r.h), JSON.stringify(r)).toEqual(ROOM_PICTURE);
  });

  it("blocks the lounge's coffee table and each couch's back, and leaves its seats free", () => {
    for (const blocks of [1, 4]) {
      const floor = fullFloor(blocks, 1);
      const grid = walkGrid(floor);
      const { x, y, w, h } = floor.lounge.rect;
      expect(picture(grid, x, y, x + w, y + h), `${blocks} blocks`).toEqual([
        '...........######...........',
        '............................',
        '............................',
        '............####............',
        '............####............',
        '............................',
        '............................',
        '...........######...........',
      ]);
    }
  });

  it('keeps the elevator spot and every seat, stand, lounge, room seat and head spot on a free cell, at every plan size', () => {
    for (const { blocks, roomCols } of SIZES) {
      const floor = fullFloor(blocks, roomCols);
      const grid = walkGrid(floor);
      const spots: Array<[string, Point]> = [['elevator', elevatorSpot(floor.core)], ...spotsOf(floor)];
      // Two spots a desk, the lounge's eight, and nine a room: its eight seats and its head.
      expect(spots).toHaveLength(1 + 16 * blocks + 8 + 18 * roomCols);
      expect(spots.filter(([, s]) => isBlocked(grid, s)).map(([name]) => `${blocks}x${roomCols} ${name}`)).toEqual([]);
    }
  });

  it('blocks nothing else, at every plan size: the walls, 8 cells a desk, 80 a room, 20 in the lounge and 8 in the core', () => {
    for (const { blocks, roomCols } of SIZES) {
      const grid = walkGrid(fullFloor(blocks, roomCols));
      const walls = 2 * (grid.cols + grid.rows) - 4;
      // A room: its glass, the ring of 16 x 12 cells but the 2 of its door (50), and its table (30).
      const expected = walls + 8 * BLOCK_DESKS * blocks + 80 * ROOMS_PER_COL * roomCols + 20 + 8;
      expect(grid.blocked.reduce((n, b) => n + b, 0), `${blocks}x${roomCols}`).toBe(expected);
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

  it('sees along an aisle, out of the elevator and into a room through its door, and not through desks, glass or a table', () => {
    // The aisle between the block's two pods.
    expect(lineOfSight(grid, { x: 9, z: 5 }, { x: 9, z: 13 })).toBe(true);
    expect(lineOfSight(grid, elevatorSpot(floor.core), { x: 4, z: 5 })).toBe(true);
    // From the chair of a north-row desk to the chair behind it, across both desks.
    expect(lineOfSight(grid, seatSpot(desks[0]!), seatSpot(desks[2]!))).toBe(false);
    expect(lineOfSight(grid, { x: 17, z: 5 }, headSpot(room))).toBe(true);
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

  it('walks from the elevator to every seat, stand, lounge, room seat and head spot at every plan size, each step in sight, ending exactly on the spot', () => {
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
        if (!inSight(grid, from, path)) bad.push(`${name}: ${JSON.stringify(path)} has a step out of sight`);
        walks++;
      }
      expect(bad, `${blocks}x${roomCols}`).toEqual([]);
    }
    expect(walks).toBe(600);
  });

  const floor = fullFloor(1, 1);
  const grid = walkGrid(floor);
  const desks = floor.pods[0]!.desks;

  it('goes straight to an end it can see', () => {
    expect(findPath(grid, elevatorSpot(floor.core), { x: 9, z: 5 })).toEqual([{ x: 9, z: 5 }]);
    expect(findPath(grid, { x: 9, z: 5 }, { x: 9.1, z: 5.1 })).toEqual([{ x: 9.1, z: 5.1 }]);
  });

  it('goes round the desks between two chairs back to back, and through the door to the head of a room', () => {
    const from = seatSpot(desks[0]!);
    const to = seatSpot(desks[2]!);
    expect(findPath(grid, from, to)).toEqual([{ x: 2.75, z: 7.75 }, { x: 2.75, z: 10.25 }, { x: to.x, z: to.z }]);
    const head = headSpot(floor.roomSlots[1]!);
    expect(findPath(grid, elevatorSpot(floor.core), head)).toEqual([{ x: 16.25, z: 8.75 }, { x: 18.25, z: 12.25 }, { x: head.x, z: head.z }]);
  });

  it('leaves a blocked cell by the nearest free one, and ends exactly on a blocked end, from the free cell nearest it', () => {
    // Standing on a desk top: out to the nearer of the two free cells by its chair (the one west), then on.
    expect(findPath(grid, deskAnchor(desks[0]!), { x: 9, z: 5 })).toEqual([{ x: 3.75, z: 7.75 }, { x: 9, z: 5 }]);
    const onDesk = deskAnchor(floor.pods[1]!.desks[2]!);
    expect(onDesk).toEqual({ x: 12, z: 9.6 });
    expect(findPath(grid, { x: 9, z: 5 }, onDesk)).toEqual([{ x: 10.75, z: 10.25 }, { x: 11.75, z: 10.25 }, { x: 12, z: 9.6 }]);
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
    expect(path).toEqual([centre(3, 1), centre(4, 0)]);
    expect(inSight(open, centre(0, 0), path)).toBe(true);
  });

  it('gives the same path for the same ends on any grid of the same plan', () => {
    const full = fullFloor(4, 2);
    const from = elevatorSpot(full.core);
    const to = loungeSpots(full.lounge.rect)[4]!;
    const path = findPath(walkGrid(full), from, to);
    // The longest walk from the elevator on the fullest plan: down the east side of the west pods, round the coffee table.
    expect(path).toEqual([{ x: 7.25, z: 4.25 }, { x: 7.25, z: 38.75 }, { x: 8.25, z: 41.25 }, { x: to.x, z: to.z }]);
    expect(findPath(walkGrid(emptyFloor(4, 2)), from, to)).toEqual(path);
    expect(findPath(walkGrid(full), { ...from }, { ...to })).toEqual(path);
  });
});
