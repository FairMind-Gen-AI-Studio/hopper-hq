import { describe, expect, it } from 'vitest';
import {
  AMBIENT_MS,
  BURST_GAP_MS,
  DOOR_HOLD_MS,
  DOOR_MS,
  FLY_SPEED,
  TRIP_MAX_MS,
  WALK_SPEED,
  doorOpen,
  frameRate,
  startTrip,
  tripAt,
  tripEnd,
  type FrameRate,
} from '../../renderer/motion';

const QUARTER = Math.PI / 2;

describe('trips', () => {
  it('walks at 1.6 m/s and flies at 2.2, lasts 5 s at most, spaces a burst 150 ms apart, draws ambient frames every 50 ms and moves the doors in 400 ms, held 1.2 s', () => {
    expect([WALK_SPEED, FLY_SPEED, TRIP_MAX_MS, BURST_GAP_MS, AMBIENT_MS, DOOR_MS, DOOR_HOLD_MS]).toEqual([1.6, 2.2, 5000, 150, 50, 400, 1200]);
  });

  it('measures its path from where it starts, keeps its speed while it lasts no more than TRIP_MAX_MS, and copies its points', () => {
    const points = [{ x: 3, z: 0 }, { x: 3, z: 4 }];
    const trip = startTrip({ x: 0, z: 0 }, points, 1000, 2);
    expect(trip).toEqual({ from: { x: 0, z: 0 }, points: [{ x: 3, z: 0 }, { x: 3, z: 4 }], start: 1000, speed: 2, length: 7 });
    expect(tripEnd(trip)).toBe(4500);
    points[0]!.x = 9;
    expect(trip.points[0]).toEqual({ x: 3, z: 0 });
  });

  it('raises the speed of a longer path so that it lasts TRIP_MAX_MS', () => {
    const trip = startTrip({ x: 0, z: 0 }, [{ x: 0, z: 20 }], 0, WALK_SPEED);
    expect(trip.speed).toBe(4);
    expect(tripEnd(trip)).toBe(TRIP_MAX_MS);
    expect(tripAt(trip, 2500)).toEqual({ x: 0, z: 10, facing: 0, done: false });
  });

  it('is where the clock says along its path, facing the way it goes, and done once at the end', () => {
    // East 3 m, then south 4 m, at 2 m/s from t = 1000: at the corner at 2500, at the end at 4500.
    const trip = startTrip({ x: 0, z: 0 }, [{ x: 3, z: 0 }, { x: 3, z: 4 }], 1000, 2);
    // Before its start it waits where it starts, turned toward its first step.
    expect(tripAt(trip, 0)).toEqual({ x: 0, z: 0, facing: QUARTER, done: false });
    expect(tripAt(trip, 1000)).toEqual({ x: 0, z: 0, facing: QUARTER, done: false });
    expect(tripAt(trip, 1750)).toEqual({ x: 1.5, z: 0, facing: QUARTER, done: false });
    expect(tripAt(trip, 3000)).toEqual({ x: 3, z: 1, facing: 0, done: false });
    expect(tripAt(trip, 4499)).toMatchObject({ x: 3, facing: 0, done: false });
    expect(tripAt(trip, 4500)).toEqual({ x: 3, z: 4, facing: 0, done: true });
    expect(tripAt(trip, 60_000)).toEqual({ x: 3, z: 4, facing: 0, done: true });
  });

  it('faces as Spot.facing does: 0 south, PI/2 east, -PI/2 west, PI north', () => {
    const trip = startTrip({ x: 5, z: 5 }, [{ x: 2, z: 5 }, { x: 2, z: 1 }], 0, 2);
    expect(tripAt(trip, 1000)).toEqual({ x: 3, z: 5, facing: -QUARTER, done: false });
    expect(tripAt(trip, 2500)).toEqual({ x: 2, z: 3, facing: Math.PI, done: false });
    expect(tripAt(startTrip({ x: 0, z: 0 }, [{ x: 1, z: 1 }], 0, 1), 100).facing).toBeCloseTo(Math.PI / 4, 12);
  });

  it('flies one straight leg to a single point', () => {
    // 6.6 m at 2.2 m/s: 3 s.
    const flight = startTrip({ x: 4, z: 0.8 }, [{ x: 4, z: 7.4 }], 0, FLY_SPEED);
    expect(tripEnd(flight)).toBeCloseTo(3000, 9);
    expect(tripAt(flight, 1500)).toMatchObject({ x: 4, facing: 0, done: false });
    expect(tripAt(flight, 1500).z).toBeCloseTo(4.1, 9);
    expect(tripAt(flight, 3000)).toEqual({ x: 4, z: 7.4, facing: 0, done: true });
  });

  it('is done at its start when it goes nowhere, and a point repeated turns it nowhere', () => {
    const still = startTrip({ x: 2, z: 2 }, [{ x: 2, z: 2 }], 100, WALK_SPEED);
    expect([still.length, still.speed, tripEnd(still)]).toEqual([0, WALK_SPEED, 100]);
    expect(tripAt(still, 99)).toEqual({ x: 2, z: 2, facing: 0, done: false });
    expect(tripAt(still, 100)).toEqual({ x: 2, z: 2, facing: 0, done: true });
    const east = startTrip({ x: 0, z: 0 }, [{ x: 0, z: 0 }, { x: 2, z: 0 }, { x: 2, z: 0 }], 0, 1);
    expect(tripAt(east, 0)).toEqual({ x: 0, z: 0, facing: QUARTER, done: false });
    expect(tripAt(east, 1000)).toEqual({ x: 1, z: 0, facing: QUARTER, done: false });
    expect(tripAt(east, 2000)).toEqual({ x: 2, z: 0, facing: QUARTER, done: true });
  });
});

describe('frameRate', () => {
  it('is still while hidden or lost, full while something moves, else ambient while ambient loops run, else still', () => {
    // hidden, lost, moving, ambient: the rate.
    const table: Array<[boolean, boolean, boolean, boolean, FrameRate]> = [
      [false, false, false, false, 'still'],
      [false, false, false, true, 'ambient'],
      [false, false, true, false, 'full'],
      [false, false, true, true, 'full'],
      [false, true, false, false, 'still'],
      [false, true, false, true, 'still'],
      [false, true, true, false, 'still'],
      [false, true, true, true, 'still'],
      [true, false, false, false, 'still'],
      [true, false, false, true, 'still'],
      [true, false, true, false, 'still'],
      [true, false, true, true, 'still'],
      [true, true, false, false, 'still'],
      [true, true, false, true, 'still'],
      [true, true, true, false, 'still'],
      [true, true, true, true, 'still'],
    ];
    for (const [hidden, lost, moving, ambient, rate] of table) {
      expect(frameRate({ hidden, lost, moving, ambient }), JSON.stringify({ hidden, lost, moving, ambient })).toBe(rate);
    }
  });
});

describe('doorOpen', () => {
  it('is closed with no pass; for a pass, opens over DOOR_MS before it, stays open DOOR_HOLD_MS after it, then closes over DOOR_MS', () => {
    expect(doorOpen([], 0)).toBe(0);
    const at = (now: number) => doorOpen([10_000], now);
    expect([9000, 9600, 9800, 9900, 10_000, 10_600, 11_200, 11_400, 11_500, 11_600, 12_000].map(at)).toEqual([0, 0, 0.5, 0.75, 1, 1, 1, 0.5, 0.25, 0, 0]);
  });

  it('stays open through passes closer together than its hold, opens again for a later one, and takes passes in any order', () => {
    const passes = [10_000, 10_800, 14_000];
    const times = [10_000, 11_000, 12_000, 12_200, 12_400, 13_000, 13_600, 13_800, 14_000, 15_200, 15_600];
    const open = [1, 1, 1, 0.5, 0, 0, 0, 0.5, 1, 1, 0];
    expect(times.map((t) => doorOpen(passes, t))).toEqual(open);
    expect(times.map((t) => doorOpen([...passes].reverse(), t))).toEqual(open);
  });
});
