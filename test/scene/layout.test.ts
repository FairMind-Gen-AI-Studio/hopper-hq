import { describe, expect, it } from 'vitest';
import { layoutFloor, MARGIN, PAD, type IslandSlot } from '../../src/scene/layout.js';
import type { GridRect } from '../../src/scene/types.js';

const island = (key: string, n: number): IslandSlot => ({ key, deskIds: Array.from({ length: n }, (_, k) => `${key}-${k}`) });
const rect = (x: number, y: number, w: number, h: number): GridRect => ({ x, y, w, h });
const CORE = rect(2, 2, 4, 2);

describe('layoutFloor', () => {
  it('gives an empty floor the minimum size and the core on the north wall', () => {
    expect(layoutFloor([])).toEqual({ size: { w: 16, h: 10 }, core: CORE, islands: [] });
  });

  it('places one desk below the core, padded inside its island', () => {
    expect(layoutFloor([island('a', 1)])).toEqual({
      size: { w: 16, h: 12 },
      core: CORE,
      islands: [{ key: 'a', rect: rect(2, 6, 4, 4), desks: [{ id: 'a-0', rect: rect(3, 7, 2, 2) }] }],
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
    const copy = structuredClone(input);
    expect(layoutFloor(input)).toEqual(layoutFloor(copy));
    expect(input).toEqual(copy);
  });
});
