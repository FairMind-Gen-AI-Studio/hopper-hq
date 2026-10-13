import { describe, expect, it } from 'vitest';
import { INTERNS_MAX, layoutFloor, MARGIN, MEETING_AGENTS_MAX, PAD, ROOM, ROOMS_MAX, RUNS_SHOWN, SEATS_MAX, type IslandSlot } from '../../src/scene/layout.js';
import type { GridRect } from '../../src/scene/types.js';

const island = (key: string, n: number): IslandSlot => ({ key, deskIds: Array.from({ length: n }, (_, k) => `${key}-${k}`) });
const rect = (x: number, y: number, w: number, h: number): GridRect => ({ x, y, w, h });
const CORE = rect(2, 2, 4, 2);

describe('layoutFloor', () => {
  it('gives an empty floor the minimum size and the core on the north wall', () => {
    expect(layoutFloor([])).toEqual({ size: { w: 16, h: 10 }, core: CORE, islands: [], rooms: [] });
  });

  it('places one desk below the core, padded inside its island', () => {
    expect(layoutFloor([island('a', 1)])).toEqual({
      size: { w: 16, h: 12 },
      core: CORE,
      islands: [{ key: 'a', rect: rect(2, 6, 4, 4), desks: [{ id: 'a-0', rect: rect(3, 7, 2, 2) }] }],
      rooms: [],
    });
  });

  it('puts four desks in one row and starts a second row at the fifth', () => {
    const four = layoutFloor([island('a', 4)]);
    expect(four.islands[0]!.rect).toEqual(rect(2, 6, 10, 4));
    expect(four.islands[0]!.desks.map((d) => [d.rect.x, d.rect.y])).toEqual([[3, 7], [5, 7], [7, 7], [9, 7]]);
    expect(four.size).toEqual({ w: 16, h: 12 });

    const five = layoutFloor([island('a', 5)]);
    expect(five.islands[0]!.rect).toEqual(rect(2, 6, 10, 6));
    expect(five.islands[0]!.desks[4]!.rect).toEqual(rect(3, 9, 2, 2));
    expect(five.size).toEqual({ w: 16, h: 14 });
  });

  it('grows an island by rows: nine desks make three', () => {
    const nine = layoutFloor([island('a', 9)]);
    expect(nine.islands[0]!.rect).toEqual(rect(2, 6, 10, 8));
    expect(nine.islands[0]!.desks.map((d) => [d.rect.x, d.rect.y])).toEqual([[3, 7], [5, 7], [7, 7], [9, 7], [3, 9], [5, 9], [7, 9], [9, 9], [3, 11]]);
    expect(nine.size).toEqual({ w: 16, h: 16 });
  });

  it('lays islands left to right and wraps to a new band past the band width', () => {
    const l = layoutFloor([island('a', 4), island('b', 4), island('c', 4)]);
    expect(l.islands.map((i) => i.rect)).toEqual([rect(2, 6, 10, 4), rect(14, 6, 10, 4), rect(2, 12, 10, 4)]);
    expect(l.size).toEqual({ w: 26, h: 18 });
  });

  it('starts a new band below the tallest island of the band before', () => {
    const l = layoutFloor([island('a', 1), island('b', 9), island('c', 4), island('d', 2)]);
    expect(l.islands.map((i) => i.rect)).toEqual([rect(2, 6, 4, 4), rect(8, 6, 10, 8), rect(2, 16, 10, 4), rect(14, 16, 6, 4)]);
    expect(l.size).toEqual({ w: 22, h: 22 });
  });

  it('lays out the demo checkout floor: three islands in one band', () => {
    const l = layoutFloor([island('/demo/orders-api/.worktrees/checkout-v2', 1), island('/demo/payments-svc', 1), island('/demo/storefront-web', 2)]);
    expect(l.islands.map((i) => [i.rect, i.desks.map((d) => d.rect)])).toEqual([
      [rect(2, 6, 4, 4), [rect(3, 7, 2, 2)]],
      [rect(8, 6, 4, 4), [rect(9, 7, 2, 2)]],
      [rect(14, 6, 6, 4), [rect(15, 7, 2, 2), rect(17, 7, 2, 2)]],
    ]);
    expect(l.size).toEqual({ w: 22, h: 12 });
  });

  it('never overlaps the core, another island or the margin, and keeps desks inside their island', () => {
    const overlaps = (a: GridRect, b: GridRect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    let seed = 7;
    const next = (n: number) => {
      seed = (seed * 48271) % 2147483647;
      return seed % n;
    };
    for (let run = 0; run < 200; run++) {
      const l = layoutFloor(Array.from({ length: 1 + next(8) }, (_, i) => island(`i${i}`, 1 + next(12))));
      const rects = l.islands.map((i) => i.rect);
      rects.forEach((r, i) => {
        expect(overlaps(r, l.core)).toBe(false);
        for (const other of rects.slice(i + 1)) expect(overlaps(r, other)).toBe(false);
        expect(r.x >= MARGIN && r.y >= MARGIN && r.x + r.w <= l.size.w - MARGIN && r.y + r.h <= l.size.h - MARGIN).toBe(true);
      });
      for (const { rect: r, desks } of l.islands) {
        for (const d of desks) {
          expect(d.rect.x >= r.x + PAD && d.rect.y >= r.y + PAD && d.rect.x + d.rect.w <= r.x + r.w - PAD && d.rect.y + d.rect.h <= r.y + r.h - PAD).toBe(true);
        }
      }
    }
  });

  it('is pure: the same input gives the same layout and is left untouched', () => {
    const input = [island('a', 3), island('b', 6)];
    const rooms = ['wf_0000aaaa-001'];
    const copy = structuredClone(input);
    expect(layoutFloor(input, rooms)).toEqual(layoutFloor(copy, ['wf_0000aaaa-001']));
    expect(input).toEqual(copy);
    expect(rooms).toEqual(['wf_0000aaaa-001']);
  });
});

describe('the meeting wing', () => {
  const demo = () => [island('/demo/orders-api/.worktrees/checkout-v2', 1), island('/demo/payments-svc', 1), island('/demo/storefront-web', 2)];

  it('sizes rooms and caps what a floor shows', () => {
    expect([ROOM, ROOMS_MAX, SEATS_MAX, INTERNS_MAX, RUNS_SHOWN, MEETING_AGENTS_MAX]).toEqual([{ w: 8, h: 6 }, 4, 8, 3, 5, 24]);
  });

  it('puts a room an aisle east of the islands, on the north margin, and widens the floor to hold it', () => {
    const l = layoutFloor(demo(), ['wf_0000aaaa-001']);
    expect(l.rooms).toEqual([{ runId: 'wf_0000aaaa-001', rect: rect(22, 2, 8, 6) }]);
    expect(l.size).toEqual({ w: 32, h: 12 });
    expect(l.islands).toEqual(layoutFloor(demo()).islands);
    expect(l.core).toEqual(CORE);
  });

  it('stacks rooms north to south in the order given, a cell apart, and grows the floor south', () => {
    const ids = ['wf_0000aaaa-004', 'wf_0000aaaa-001', 'wf_0000aaaa-003', 'wf_0000aaaa-002'];
    const l = layoutFloor(demo(), ids);
    expect(l.rooms.map((r) => [r.runId, r.rect])).toEqual([
      ['wf_0000aaaa-004', rect(22, 2, 8, 6)],
      ['wf_0000aaaa-001', rect(22, 9, 8, 6)],
      ['wf_0000aaaa-003', rect(22, 16, 8, 6)],
      ['wf_0000aaaa-002', rect(22, 23, 8, 6)],
    ]);
    expect(l.size).toEqual({ w: 32, h: 31 });
  });

  it('keeps the wing east of the core on a floor without islands, and of the widest band', () => {
    expect(layoutFloor([], ['wf_0000aaaa-001'])).toEqual({ size: { w: 18, h: 10 }, core: CORE, islands: [], rooms: [{ runId: 'wf_0000aaaa-001', rect: rect(8, 2, 8, 6) }] });
    // The second band is narrower than the first: the wing keeps clear of both.
    const l = layoutFloor([island('a', 4), island('b', 4), island('c', 1)], ['wf_0000aaaa-001']);
    expect(l.islands.map((i) => i.rect)).toEqual([rect(2, 6, 10, 4), rect(14, 6, 10, 4), rect(2, 12, 4, 4)]);
    expect(l.rooms[0]!.rect).toEqual(rect(26, 2, 8, 6));
    expect(l.size).toEqual({ w: 36, h: 18 });
  });

  it('never moves an island, and keeps rooms clear of the core, the islands, each other and the margin', () => {
    const overlaps = (a: GridRect, b: GridRect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    let seed = 11;
    const next = (n: number) => {
      seed = (seed * 48271) % 2147483647;
      return seed % n;
    };
    for (let run = 0; run < 200; run++) {
      const islands = Array.from({ length: next(8) }, (_, i) => island(`i${i}`, 1 + next(12)));
      const rooms = Array.from({ length: next(ROOMS_MAX + 1) }, (_, i) => `wf_0000aaaa-00${i}`);
      const plain = layoutFloor(islands);
      const l = layoutFloor(islands, rooms);
      expect(l.islands).toEqual(plain.islands);
      expect(l.core).toEqual(plain.core);
      if (rooms.length === 0) expect(l.size).toEqual(plain.size);
      expect(l.rooms.map((r) => r.runId)).toEqual(rooms);
      const rects = l.rooms.map((r) => r.rect);
      rects.forEach((r, i) => {
        expect(overlaps(r, l.core)).toBe(false);
        for (const other of [...rects.slice(i + 1), ...l.islands.map((isl) => isl.rect)]) expect(overlaps(r, other)).toBe(false);
        expect(r.x >= MARGIN && r.y >= MARGIN && r.x + r.w <= l.size.w - MARGIN && r.y + r.h <= l.size.h - MARGIN).toBe(true);
      });
      expect(l.size.w >= plain.size.w && l.size.h >= plain.size.h).toBe(true);
    }
  });
});
