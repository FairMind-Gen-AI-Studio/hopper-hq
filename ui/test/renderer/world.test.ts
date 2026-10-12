import { describe, expect, it } from 'vitest';
import {
  CAMERA_DISTANCE,
  FRAME_MARGIN,
  HOME_AZIMUTH,
  LABEL_Y,
  POLAR,
  azimuthOf,
  cameraOffset,
  cellToWorld,
  deskAnchor,
  floorCenter,
  frustumFor,
  labelAnchor,
  placardAnchor,
  robotSpot,
  seatSpot,
  shadowExtent,
  standSpot,
  visibleWalls,
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

function pick(s: { x: number; z: number }): { x: number; z: number } {
  return { x: s.x, z: s.z };
}
