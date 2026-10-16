/**
 * Pure grid layout of one floor. Browser-safe. Integer cells; x grows east, y grows south.
 * The core (elevator and plants) sits on the north wall. layoutPlan lays out a floor's fixed plan: blocks of two pods of
 * four desks below the core, each desk DESK x DESK cells, the lounge along the south wall under them, and the meeting
 * wing's room slots in columns east of the blocks. A plan grows by a block (south) or a room column (east), never
 * otherwise, so no desk, seat or room of it ever moves.
 */
import type { GridRect } from './types.js';

export const DESK = 2, PAD = 1, AISLE = 2, MARGIN = 2;
export const CORE = { w: 4, h: 2 }, MIN_SIZE = { w: 16, h: 10 };
/** A meeting room: a table with SEATS_MAX seats and a head seat, and a whiteboard on its north wall. */
export const ROOM = { w: 8, h: 6 };
/** Rooms on one floor; the floor counts the running runs beyond them. */
export const ROOMS_MAX = 4;
/** Seats at a room's table, besides the head seat. */
export const SEATS_MAX = 8;
/** Interns a desk shows; it counts the rest. */
export const INTERNS_MAX = 3;
/** Runs a desk lists. */
export const RUNS_SHOWN = 5;
/** Agents a room lists. */
export const MEETING_AGENTS_MAX = 24;
/** Unseated sessions a floor lists; it counts the rest. */
export const UNSEATED_MAX = 24;
/** Desks in a pod (2x2, back to back) and in a block (two pods side by side). */
export const POD_DESKS = 4, BLOCK_DESKS = 8;
/** Blocks a floor grows to. Sessions beyond its desks wait unseated. */
export const BLOCKS_MAX = 4;
/** A pod's rug (its 2x2 desks inside a PAD margin) and a block (two pods an AISLE apart). */
export const POD = { w: 6, h: 6 }, BLOCK = { w: 14, h: 6 };
/** The lounge strip along the south wall, and its seats. */
export const LOUNGE = { w: 14, h: 4 }, LOUNGE_SEATS = 8;
/** Room slots per column of the meeting wing, and columns at most: ROOMS_MAX = ROOMS_PER_COL * ROOM_COLS_MAX. */
export const ROOMS_PER_COL = 2, ROOM_COLS_MAX = 2;
/**
 * The break area (a bar cart and a biliardino table, world.ts/props.ts): as wide as a room slot, flush with the room
 * column's west edge, below its two slots. Fixed regardless of how many blocks or room columns the plan has: the room
 * column's first slot never moves, and a block's pods never reach east of it, so it never overlaps either.
 */
export const BREAK = { w: ROOM.w, h: 3 };

/** How far a floor's plan has grown. */
export interface PlanSize {
  /** 1..BLOCKS_MAX. */
  blocks: number;
  /** 1..ROOM_COLS_MAX. */
  roomCols: number;
}

export interface PlanLayout {
  size: { w: number; h: number };
  core: GridRect;
  /** Block by block, west pod then east pod. */
  pods: { id: string; rect: GridRect; desks: { id: string; rect: GridRect; chair: 'north' | 'south' }[] }[];
  lounge: GridRect;
  /** By slot: column by column (west first), north to south. */
  rooms: GridRect[];
  /** The break area: a bar cart and a biliardino table (world.ts spots, props.ts furniture). */
  breakArea: GridRect;
}

/** A whole number in 1..max: fractions round down, NaN counts as 1. */
function clampSize(n: number, max: number): number {
  return Number.isNaN(n) ? 1 : Math.min(max, Math.max(1, Math.floor(n)));
}

/** The plan's cells. Out-of-range sizes are clamped into range. Pure. */
export function layoutPlan(plan: PlanSize): PlanLayout {
  const blocks = clampSize(plan.blocks, BLOCKS_MAX);
  const roomCols = clampSize(plan.roomCols, ROOM_COLS_MAX);
  const top = MARGIN + CORE.h + AISLE;
  const pods: PlanLayout['pods'] = [];
  for (let b = 0; b < blocks; b++) {
    const y = top + b * (BLOCK.h + AISLE);
    for (let k = 0; k < 2; k++) {
      const p = 2 * b + k;
      const x = MARGIN + k * (POD.w + AISLE);
      pods.push({
        id: `p${p}`,
        rect: { x, y, w: POD.w, h: POD.h },
        // Desk n: the north row west to east, then the south row. Chairs face out of the pod, so the monitors meet in its middle.
        desks: Array.from({ length: POD_DESKS }, (_, n) => ({
          id: `p${p}-${n}`,
          rect: { x: x + PAD + (n % 2) * DESK, y: y + PAD + (n < 2 ? 0 : DESK), w: DESK, h: DESK },
          chair: n < 2 ? 'north' : 'south',
        })),
      });
    }
  }
  const lounge: GridRect = { x: MARGIN, y: top + blocks * (BLOCK.h + AISLE), w: LOUNGE.w, h: LOUNGE.h };
  const rooms: GridRect[] = [];
  for (let c = 0; c < roomCols; c++) {
    for (let r = 0; r < ROOMS_PER_COL; r++) {
      rooms.push({ x: MARGIN + BLOCK.w + AISLE + c * (ROOM.w + AISLE), y: MARGIN + r * (ROOM.h + PAD), w: ROOM.w, h: ROOM.h });
    }
  }
  const breakArea: GridRect = { x: MARGIN + BLOCK.w + AISLE, y: MARGIN + ROOMS_PER_COL * ROOM.h + (ROOMS_PER_COL - 1) * PAD, w: BREAK.w, h: BREAK.h };
  return {
    size: { w: MARGIN + BLOCK.w + AISLE + roomCols * ROOM.w + (roomCols - 1) * AISLE + MARGIN, h: lounge.y + LOUNGE.h + MARGIN },
    core: { x: MARGIN, y: MARGIN, w: CORE.w, h: CORE.h },
    pods,
    lounge,
    rooms,
    breakArea,
  };
}
