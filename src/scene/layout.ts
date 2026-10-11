/**
 * Pure grid layout of one floor. Browser-safe. Integer cells; x grows east, y grows south.
 * The core (elevator and plants) sits on the north wall. Islands fill bands below it, left to right, and a band wraps
 * before it grows wider than BAND_MAX_W. Desks fill an island in rows of PER_ROW, each desk DESK x DESK cells.
 */
import type { GridRect } from './types.js';

export const DESK = 2, PER_ROW = 4, PAD = 1, AISLE = 2, MARGIN = 2, BAND_MAX_W = 26;
export const CORE = { w: 4, h: 2 }, MIN_SIZE = { w: 16, h: 10 };
export interface IslandSlot { key: string; deskIds: string[] }     // already ordered by build.ts
export interface FloorLayout { size: { w: number; h: number }; core: GridRect; islands: { key: string; rect: GridRect; desks: { id: string; rect: GridRect }[] }[] }

export function layoutFloor(islands: IslandSlot[]): FloorLayout {
  const core: GridRect = { x: MARGIN, y: MARGIN, w: CORE.w, h: CORE.h };
  let x = MARGIN;
  let y = MARGIN + CORE.h + AISLE;
  let bandH = 0;
  let right = core.x + core.w;
  const placed: FloorLayout['islands'] = [];
  for (const island of islands) {
    const n = island.deskIds.length;
    const w = Math.min(PER_ROW, n) * DESK + 2 * PAD;
    const h = Math.ceil(n / PER_ROW) * DESK + 2 * PAD;
    if (x > MARGIN && x - MARGIN + w > BAND_MAX_W) {
      x = MARGIN;
      y += bandH + AISLE;
      bandH = 0;
    }
    const left = x;
    const top = y;
    placed.push({
      key: island.key,
      rect: { x: left, y: top, w, h },
      desks: island.deskIds.map((id, k) => ({
        id,
        rect: { x: left + PAD + (k % PER_ROW) * DESK, y: top + PAD + Math.floor(k / PER_ROW) * DESK, w: DESK, h: DESK },
      })),
    });
    right = Math.max(right, left + w);
    x += w + AISLE;
    bandH = Math.max(bandH, h);
  }
  return { size: { w: Math.max(MIN_SIZE.w, right + MARGIN), h: Math.max(MIN_SIZE.h, y + bandH + MARGIN) }, core, islands: placed };
}
