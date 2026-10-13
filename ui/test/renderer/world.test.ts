import { describe, expect, it } from 'vitest';
import { INTERNS_MAX, SEATS_MAX } from '../../../src/scene/layout';
import {
  BOARD,
  CAMERA_DISTANCE,
  DOOR_W,
  FRAME_MARGIN,
  HOME_AZIMUTH,
  LABEL_Y,
  PARTITION_H,
  PARTITION_T,
  POLAR,
  TABLE,
  azimuthOf,
  boardAnchor,
  cameraOffset,
  cellToWorld,
  deskAnchor,
  doorGap,
  floorCenter,
  frustumFor,
  headSpot,
  internSpots,
  labelAnchor,
  placardAnchor,
  robotSpot,
  roomKey,
  roomTagAnchor,
  seatSpot,
  seatSpots,
  shadowExtent,
  standSpot,
  tableCenter,
  visibleWalls,
  type Point,
} from '../../renderer/world';
import { makeDesk } from './fixtures';

const RECT = { x: 3, y: 7, w: 2, h: 2 };
const QUARTER = Math.PI / 2;

describe('world maths', () => {
  it('maps a grid cell to the ground plane, one cell per metre', () => {
    expect(cellToWorld(5, 9)).toEqual({ x: 5, z: 9 });
    expect(floorCenter({ w: 22, h: 12 })).toEqual({ x: 11, z: 6 });
  });

  it('puts the desk top toward the north edge of its cells and the chair toward the south edge', () => {
    expect(deskAnchor(RECT)).toEqual({ x: 4, z: 7.6 });
    const seat = seatSpot(RECT);
    expect(seat.x).toBe(4);
    expect(seat.z).toBeCloseTo(8.38, 10);
    expect(seat.facing).toBe(Math.PI);
    const stand = standSpot(RECT);
    expect(stand.x).toBeCloseTo(4.6, 10);
    expect(stand.z).toBeCloseTo(8.48, 10);
    expect(stand.facing).toBe(0);
    // Both spots stay inside the desk's own cells.
    for (const s of [seat, stand]) {
      expect(s.x).toBeGreaterThan(RECT.x);
      expect(s.x).toBeLessThan(RECT.x + RECT.w);
      expect(s.z).toBeLessThan(RECT.y + RECT.h);
    }
  });

  it('seats a robot by pose, stands it when it waves or holds a result, and has none for a dormant desk', () => {
    const at = (state: Parameters<typeof makeDesk>[0]['state']) => robotSpot(makeDesk({ id: 'x', state }, RECT, 0, null));
    for (const state of ['working', 'in_meeting', 'no_signal', 'idle'] as const) expect(at(state)).toEqual(seatSpot(RECT));
    for (const state of ['needs_you', 'done'] as const) expect(at(state)).toEqual(standSpot(RECT));
    expect(at('dormant')).toBeNull();
  });

  it('floats the interns in an arc behind the monitor, inside the desk cells, turned toward the middle', () => {
    const a = deskAnchor(RECT);
    const spots = internSpots(RECT);
    expect(spots).toHaveLength(INTERNS_MAX);
    for (const s of spots) {
      // The monitor stands 0.24 m north of the desk top's centre: the interns hover north of it.
      expect(s.z).toBeLessThan(a.z - 0.24 - 0.05);
      expect(s.z).toBeGreaterThan(RECT.y);
      expect(s.x).toBeGreaterThan(RECT.x);
      expect(s.x).toBeLessThan(RECT.x + RECT.w);
    }
    const [middle, west, east] = spots;
    expect([middle!.x, middle!.facing]).toEqual([a.x, 0]);
    expect(west!.x).toBeLessThan(a.x);
    expect(east!.x).toBeGreaterThan(a.x);
    // The arc bows away from the desk in the middle, and its ends turn in.
    expect(middle!.z).toBeLessThan(west!.z);
    expect(west!.z).toBe(east!.z);
    expect(west!.facing).toBeGreaterThan(0);
    expect(east!.facing).toBe(-west!.facing);
  });

  it('hangs a desk label above the robot, or above the monitor of an empty desk', () => {
    const label = (state: Parameters<typeof makeDesk>[0]['state']) => labelAnchor(makeDesk({ id: 'x', state }, RECT, 0, null));
    expect(label('working')).toEqual({ ...pick(seatSpot(RECT)), y: LABEL_Y.seated });
    expect(label('needs_you')).toEqual({ ...pick(standSpot(RECT)), y: LABEL_Y.standing });
    expect(label('dormant')).toEqual({ x: 4, y: LABEL_Y.empty, z: 7.6 });
    expect(placardAnchor({ x: 2, y: 6, w: 4, h: 4 })).toEqual({ x: 2.2, y: 0.02, z: 9.85 });
  });

  it('places the camera on a sphere around its target, and reads the azimuth back', () => {
    const o = cameraOffset(HOME_AZIMUTH);
    expect(Math.hypot(o.x, o.y, o.z)).toBeCloseTo(CAMERA_DISTANCE, 10);
    expect(o.y).toBeCloseTo(CAMERA_DISTANCE * Math.cos(POLAR), 10);
    expect(o.x).toBeCloseTo(o.z, 10);
    expect(o.x).toBeGreaterThan(0);
    for (const a of [HOME_AZIMUTH, HOME_AZIMUTH + QUARTER, -HOME_AZIMUTH, -3 * HOME_AZIMUTH]) {
      expect(azimuthOf(cameraOffset(a))).toBeCloseTo(a, 10);
    }
  });

  it('frames the whole floor, wall tops included, for a wide and a square view', () => {
    const size = { w: 24, h: 16 };
    // From home, the floor spans (w + h) / sqrt 2 across the screen; the back wall tops set the height.
    const halfW = 20 / Math.SQRT2;
    const halfH = (20 / Math.SQRT2) * Math.cos(POLAR) + 2.6 * Math.sin(POLAR);
    const wide = frustumFor(size, 2);
    expect(wide.top).toBeCloseTo(halfH * FRAME_MARGIN, 10);
    expect(wide.bottom).toBeCloseTo(-wide.top, 10);
    expect(wide.right).toBeCloseTo(2 * wide.top, 10);
    expect(wide.left).toBeCloseTo(-wide.right, 10);
    const square = frustumFor(size, 1);
    expect(square.right).toBeCloseTo(halfW * FRAME_MARGIN, 10);
    expect(square.top).toBeCloseTo(square.right, 10);
  });

  it('gives the same frustum from every quarter turn, and spans the floor width looking north', () => {
    const size = { w: 22, h: 12 };
    const home = frustumFor(size, 1.6);
    for (let k = 1; k < 4; k++) {
      const turned = frustumFor(size, 1.6, HOME_AZIMUTH + k * QUARTER);
      expect(turned.right).toBeCloseTo(home.right, 10);
      expect(turned.top).toBeCloseTo(home.top, 10);
    }
    expect(frustumFor(size, 0.5, 0).right).toBeCloseTo((22 / 2) * FRAME_MARGIN, 10);
    expect(frustumFor(size, 0).right).toBeCloseTo(frustumFor(size, 1).right, 10);
  });

  it('cuts away the two walls that face the camera, in all four quadrants', () => {
    expect(visibleWalls(HOME_AZIMUTH)).toEqual({ north: true, east: false, south: false, west: true });
    expect(visibleWalls(HOME_AZIMUTH + QUARTER)).toEqual({ north: false, east: false, south: true, west: true });
    expect(visibleWalls(HOME_AZIMUTH + 2 * QUARTER)).toEqual({ north: false, east: true, south: true, west: false });
    expect(visibleWalls(HOME_AZIMUTH - QUARTER)).toEqual({ north: true, east: true, south: false, west: false });
    expect(visibleWalls(HOME_AZIMUTH + 4 * QUARTER)).toEqual(visibleWalls(HOME_AZIMUTH));
  });

  it('keeps side walls when the camera looks straight along them', () => {
    expect(visibleWalls(0)).toEqual({ north: true, east: true, south: false, west: true });
  });

  it('sizes the sun shadow to the floor', () => {
    expect(shadowExtent({ w: 22, h: 12 })).toBe(14);
    expect(shadowExtent({ w: 16, h: 30 })).toBe(18);
  });
});

describe('meeting rooms', () => {
  /** The demo's room: east of the islands, at the top of the wing. */
  const ROOM = { x: 22, y: 2, w: 8, h: 6 };
  const inside = (p: Point) => p.x > ROOM.x && p.x < ROOM.x + ROOM.w && p.z > ROOM.y && p.z < ROOM.y + ROOM.h;

  it('stands the table in the middle of the room, a little south of its centre, away from the whiteboard', () => {
    const t = tableCenter(ROOM);
    expect(t.x).toBe(26);
    expect(t.z).toBeGreaterThan(5);
    expect(t.z - TABLE.d / 2).toBeGreaterThan(ROOM.y + 1.5);
    expect(t.z + TABLE.d / 2).toBeLessThan(ROOM.y + ROOM.h - 1.5);
    expect(t.x - TABLE.w / 2).toBeGreaterThan(ROOM.x + 1.5);
    expect(t.x + TABLE.w / 2).toBeLessThan(ROOM.x + ROOM.w - 1);
  });

  it('seats four agents on the north side and four on the south, in facing pairs from the head end, each facing the table', () => {
    const t = tableCenter(ROOM);
    const seats = seatSpots(ROOM);
    expect(seats).toHaveLength(SEATS_MAX);
    const north = seats.filter((s) => s.z < t.z);
    const south = seats.filter((s) => s.z > t.z);
    expect([north.length, south.length]).toEqual([4, 4]);
    // North seats look south across the table, south seats look north.
    for (const s of north) expect([s.facing, s.z]).toEqual([0, t.z - TABLE.d / 2 - 0.45]);
    for (const s of south) expect([s.facing, s.z]).toEqual([Math.PI, t.z + TABLE.d / 2 + 0.45]);
    // Agents take a north seat, then the one facing it, from the west end east.
    expect(seats.map((s) => (s.z < t.z ? 'N' : 'S')).join('')).toBe('NSNSNSNS');
    for (let k = 0; k < 4; k++) expect(seats[2 * k]!.x).toBe(seats[2 * k + 1]!.x);
    expect(north.map((s) => s.x)).toEqual([24.5, 25.5, 26.5, 27.5]);
    for (const s of seats) {
      expect(inside(s)).toBe(true);
      expect(Math.abs(s.x - t.x)).toBeLessThan(TABLE.w / 2);
    }
  });

  it('puts the head seat at the west end of the table, facing east along it', () => {
    const t = tableCenter(ROOM);
    const head = headSpot(ROOM);
    expect(head).toEqual({ x: t.x - TABLE.w / 2 - 0.45, z: t.z, facing: Math.PI / 2 });
    expect(inside(head)).toBe(true);
    for (const s of seatSpots(ROOM)) expect(head.x).toBeLessThan(s.x - 1);
  });

  it('opens the door in the middle of the west partition, clear of the head seat', () => {
    const door = doorGap(ROOM);
    expect((door.from + door.to) / 2).toBe(ROOM.y + ROOM.h / 2);
    expect(door.to - door.from).toBeCloseTo(DOOR_W, 10);
    expect(door.from).toBeGreaterThan(ROOM.y);
    expect(door.to).toBeLessThan(ROOM.y + ROOM.h);
    expect(headSpot(ROOM).x - ROOM.x).toBeGreaterThan(1);
  });

  it('hangs the whiteboard on the inside of the north partition, and its overlay from the top of the board', () => {
    const a = boardAnchor(ROOM);
    expect(a.x).toBe(ROOM.x + ROOM.w / 2);
    expect(a.y).toBe(BOARD.y + BOARD.h / 2);
    expect(a.y).toBeLessThan(PARTITION_H);
    expect(a.z).toBeGreaterThan(ROOM.y + PARTITION_T);
    expect(a.z).toBeLessThan(ROOM.y + 0.2);
    expect(BOARD.w).toBeLessThan(ROOM.w);
  });

  it('hangs the room tag over the door', () => {
    const door = doorGap(ROOM);
    const a = roomTagAnchor(ROOM);
    expect(a.z).toBe((door.from + door.to) / 2);
    expect(a.x).toBeCloseTo(ROOM.x + PARTITION_T / 2, 10);
    expect(a.y).toBeGreaterThan(PARTITION_H);
  });

  it('keys a room by its host and its run, so the rooms of one run under two hosts stay apart', () => {
    const a = { hostSessionId: 'host-a', runId: 'wf_0000aaaa-001' };
    expect(roomKey(a)).toBe(roomKey({ ...a }));
    expect(roomKey(a)).not.toBe(roomKey({ ...a, hostSessionId: 'host-b' }));
    expect(roomKey({ hostSessionId: 'a b', runId: 'c' })).not.toBe(roomKey({ hostSessionId: 'a', runId: 'b c' }));
  });
});

function pick(s: { x: number; z: number }): { x: number; z: number } {
  return { x: s.x, z: s.z };
}
