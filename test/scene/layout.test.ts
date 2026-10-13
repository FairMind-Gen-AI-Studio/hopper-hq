import { describe, expect, it } from 'vitest';
import { AISLE, CORE, DESK, INTERNS_MAX, MARGIN, MEETING_AGENTS_MAX, MIN_SIZE, PAD, ROOM, ROOMS_MAX, RUNS_SHOWN, SEATS_MAX } from '../../src/scene/layout.js';

describe('the layout constants', () => {
  it('sizes desks, margins, the core and rooms, and caps what a floor shows', () => {
    expect([DESK, PAD, AISLE, MARGIN, CORE, MIN_SIZE]).toEqual([2, 1, 2, 2, { w: 4, h: 2 }, { w: 16, h: 10 }]);
    expect([ROOM, ROOMS_MAX, SEATS_MAX, INTERNS_MAX, RUNS_SHOWN, MEETING_AGENTS_MAX]).toEqual([{ w: 8, h: 6 }, 4, 8, 3, 5, 24]);
  });
});
