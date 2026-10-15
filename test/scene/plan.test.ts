import { describe, expect, it } from 'vitest';
import {
  BLOCK,
  BLOCK_DESKS,
  BLOCKS_MAX,
  BREAK,
  layoutPlan,
  LOUNGE,
  LOUNGE_SEATS,
  MARGIN,
  PAD,
  POD,
  POD_DESKS,
  ROOM_COLS_MAX,
  ROOMS_MAX,
  ROOMS_PER_COL,
  type PlanLayout,
} from '../../src/scene/layout.js';
import type { GridRect } from '../../src/scene/types.js';

const rect = (x: number, y: number, w: number, h: number): GridRect => ({ x, y, w, h });
const overlaps = (a: GridRect, b: GridRect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (r: GridRect, outer: GridRect) => r.x >= outer.x && r.y >= outer.y && r.x + r.w <= outer.x + outer.w && r.y + r.h <= outer.y + outer.h;

/** A pod at (x, y) with its four desks: the north row west to east, then the south row. */
function pod(p: number, x: number, y: number): PlanLayout['pods'][number] {
  return {
    id: `p${p}`,
    rect: rect(x, y, 6, 6),
    desks: [
      { id: `p${p}-0`, rect: rect(x + 1, y + 1, 2, 2), chair: 'north' },
      { id: `p${p}-1`, rect: rect(x + 3, y + 1, 2, 2), chair: 'north' },
      { id: `p${p}-2`, rect: rect(x + 1, y + 3, 2, 2), chair: 'south' },
      { id: `p${p}-3`, rect: rect(x + 3, y + 3, 2, 2), chair: 'south' },
    ],
  };
}

const SIZES = [1, 2, 3, 4].flatMap((blocks) => [1, 2].map((roomCols) => ({ blocks, roomCols })));

describe('the fixed plan', () => {
  it('has pods of 4 desks, blocks of 2 pods, a lounge of 8 seats, at most 4 blocks and 2 columns of 2 rooms, and a break area as wide as a room slot', () => {
    expect([POD_DESKS, BLOCK_DESKS, BLOCKS_MAX, POD, BLOCK, LOUNGE, LOUNGE_SEATS, ROOMS_PER_COL, ROOM_COLS_MAX, BREAK]).toEqual([
      4, 8, 4, { w: 6, h: 6 }, { w: 14, h: 6 }, { w: 14, h: 4 }, 8, 2, 2, { w: 8, h: 3 },
    ]);
    expect(ROOMS_MAX).toBe(ROOMS_PER_COL * ROOM_COLS_MAX);
  });

  it('lays out the base plan: one block below the core, the lounge below it, and one column of two rooms', () => {
    expect(layoutPlan({ blocks: 1, roomCols: 1 })).toEqual({
      size: { w: 28, h: 20 },
      core: rect(2, 2, 4, 2),
      pods: [pod(0, 2, 6), pod(1, 10, 6)],
      lounge: rect(2, 14, 14, 4),
      rooms: [rect(18, 2, 8, 6), rect(18, 9, 8, 6)],
      breakArea: rect(18, 15, 8, 3),
    });
  });

  it('adds a block 8 cells further south and moves the lounge down with it, keeping everything else in place', () => {
    const base = layoutPlan({ blocks: 1, roomCols: 1 });
    expect(layoutPlan({ blocks: 2, roomCols: 1 })).toEqual({
      ...base,
      size: { w: 28, h: 28 },
      pods: [...base.pods, pod(2, 2, 14), pod(3, 10, 14)],
      lounge: rect(2, 22, 14, 4),
    });
  });

  it('lays out the fullest plan: four blocks, and a second room column that widens the floor to 38', () => {
    expect(layoutPlan({ blocks: 4, roomCols: 2 })).toEqual({
      size: { w: 38, h: 44 },
      core: rect(2, 2, 4, 2),
      pods: [pod(0, 2, 6), pod(1, 10, 6), pod(2, 2, 14), pod(3, 10, 14), pod(4, 2, 22), pod(5, 10, 22), pod(6, 2, 30), pod(7, 10, 30)],
      lounge: rect(2, 38, 14, 4),
      rooms: [rect(18, 2, 8, 6), rect(18, 9, 8, 6), rect(28, 2, 8, 6), rect(28, 9, 8, 6)],
      breakArea: rect(18, 15, 8, 3),
    });
    expect(SIZES.map((s) => [s.blocks, s.roomCols, layoutPlan(s).size])).toEqual(
      SIZES.map((s) => [s.blocks, s.roomCols, { w: s.roomCols === 1 ? 28 : 38, h: 12 + 8 * s.blocks }]),
    );
  });

  it('numbers desks block by block, west pod then east, north row then south row, with each chair out of its pod', () => {
    const l = layoutPlan({ blocks: 4, roomCols: 2 });
    const desks = l.pods.flatMap((p) => p.desks);
    expect(desks).toHaveLength(BLOCKS_MAX * BLOCK_DESKS);
    // Desk index 4p + n is desk n of pod p.
    expect(desks.map((d) => d.id)).toEqual(Array.from({ length: 32 }, (_, i) => `p${Math.floor(i / 4)}-${i % 4}`));
    expect(desks.map((d) => d.chair)).toEqual(Array.from({ length: 32 }, (_, i) => (i % 4 < 2 ? 'north' : 'south')));
    for (const p of l.pods) {
      // The monitors meet on the pod's middle line: the north row's south edge, the south row's north edge.
      expect(p.desks.map((d) => (d.chair === 'north' ? d.rect.y + d.rect.h : d.rect.y))).toEqual([p.rect.y + 3, p.rect.y + 3, p.rect.y + 3, p.rect.y + 3]);
    }
  });

  it('clamps a size out of range into it: fractions round down, NaN counts as 1', () => {
    const base = layoutPlan({ blocks: 1, roomCols: 1 });
    const full = layoutPlan({ blocks: 4, roomCols: 2 });
    expect(layoutPlan({ blocks: 0, roomCols: 0 })).toEqual(base);
    expect(layoutPlan({ blocks: -3, roomCols: -1 })).toEqual(base);
    expect(layoutPlan({ blocks: Number.NaN, roomCols: Number.NaN })).toEqual(base);
    expect(layoutPlan({ blocks: 9, roomCols: 3 })).toEqual(full);
    expect(layoutPlan({ blocks: Infinity, roomCols: Infinity })).toEqual(full);
    expect(layoutPlan({ blocks: 2.7, roomCols: 1.5 })).toEqual(layoutPlan({ blocks: 2, roomCols: 1 }));
  });

  it('never overlaps the core, a pod, the lounge, a room or the break area, keeps desks on their rug and everything inside the margins, at every size', () => {
    for (const s of SIZES) {
      const l = layoutPlan(s);
      const field = rect(MARGIN, MARGIN, l.size.w - 2 * MARGIN, l.size.h - 2 * MARGIN);
      const rects = [l.core, ...l.pods.map((p) => p.rect), l.lounge, ...l.rooms, l.breakArea];
      expect(rects).toHaveLength(1 + 2 * s.blocks + 1 + ROOMS_PER_COL * s.roomCols + 1);
      rects.forEach((r, i) => {
        expect(inside(r, field), JSON.stringify([s, r])).toBe(true);
        for (const other of rects.slice(i + 1)) expect(overlaps(r, other), JSON.stringify([s, r, other])).toBe(false);
      });
      for (const p of l.pods) {
        const rug = rect(p.rect.x + PAD, p.rect.y + PAD, p.rect.w - 2 * PAD, p.rect.h - 2 * PAD);
        p.desks.forEach((d, i) => {
          expect(inside(d.rect, rug)).toBe(true);
          for (const other of p.desks.slice(i + 1)) expect(overlaps(d.rect, other.rect)).toBe(false);
        });
      }
    }
  });

  it('is pure: the same size gives an equal layout, a fresh one each time, and leaves its input untouched', () => {
    const size = Object.freeze({ blocks: 3, roomCols: 2 });
    const a = layoutPlan(size);
    const b = layoutPlan(size);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.pods[0]).not.toBe(b.pods[0]);
    expect(size).toEqual({ blocks: 3, roomCols: 2 });
  });
});
