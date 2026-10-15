import { describe, expect, it } from 'vitest';
import { LOUNGE_SEATS, layoutPlan } from '../../../src/scene/layout';
import { BURST_GAP_MS, DOOR_HOLD_MS, DOOR_MS, FLY_SPEED, WALK_SPEED, startTrip, tripAt, tripEnd, type Trip } from '../../renderer/motion';
import { WALK_CELL, findPath, walkGrid } from '../../renderer/walk';
import { ELEVATOR_LANES, advance, doorsMoving, doorsNext, moveAll, settled, walkerAt, type Walker, type Wanted, type Ways } from '../../renderer/walkers';
import { elevatorSpot, internSpots, loungeSpots, seatSpot, standSpot, type Point, type Spot } from '../../renderer/world';
import { checkoutFloor, checkoutSpecs, makeFloor, seatOf } from './fixtures';

const floor = checkoutFloor();
const ways: Ways = { grid: walkGrid(floor), elevator: elevatorSpot(floor.core) };
const elevator = ways.elevator;
const desk = seatOf(floor, 'sw-a1').desk;
const seat = seatSpot(desk);
const stand = standSpot(desk);
const lounge = loungeSpots(floor.lounge.rect)[2]!;
const other = seatSpot(seatOf(floor, 'oa-c3').desk);

/** The checkout floor grown from two blocks to three: the lounge moves 8 m south. */
function grownFloor() {
  const checkouts = checkoutSpecs();
  checkouts[0]!.desks = Array.from({ length: 9 }, (_, k) => ({ id: `sw-${k}`, state: 'working' as const }));
  return makeFloor(checkouts);
}

const want = (id: string, place: string, to: Spot, gait: Wanted['gait'] = 'walk'): Wanted => ({ id, gait, place, to });
const resting = (place: string, to: Spot): Walker => ({ gait: 'walk', place, near: null, to, trip: null, step: false, arriving: false, leaving: false });
/** A walk over the checkout floor, from `from` to `to`, setting off at `start`. */
const walk = (from: Point, to: Point, start: number, grid = ways.grid): Trip => startTrip(from, findPath(grid, from, to), start, WALK_SPEED);
const point = (p: Point): Point => ({ x: p.x, z: p.z });
const where = (t: Trip, now: number): Point => point(tripAt(t, now));

describe('moveAll', () => {
  it('puts every wanted robot at its place at once on a snap, and lets the others go', () => {
    const prev = new Map<string, Walker>([
      ['a', { ...resting('desk seat', seat), trip: walk(seat, lounge, 0) }],
      ['b', { gait: 'walk', place: '', near: null, to: elevator, trip: walk(other, elevator, 0), step: false, arriving: false, leaving: true }],
      ['c', resting('desk stand', stand)],
    ]);
    const moves = moveAll(prev, [want('a', 'lounge 2', lounge), want('d', 'desk seat', seat)], ways, 500, { snap: true });
    expect([...moves.walkers]).toEqual([
      ['a', resting('lounge 2', lounge)],
      ['d', resting('desk seat', seat)],
    ]);
    expect(moves.passes).toEqual([]);
  });

  it('brings robots new to the floor out of the elevator once its doors are open, BURST_GAP_MS apart and in three lanes in turn, an intern flying straight', () => {
    const intern = internSpots(desk)[0]!;
    const wanted = [want('a', 'desk seat', seat), want('b', 'lounge 2', lounge), want('i', 'intern 0', intern, 'fly'), want('c', 'desk seat', other)];
    const moves = moveAll(new Map(), wanted, ways, 1000);
    const start = 1000 + DOOR_MS;
    const lane = (k: number): Point => ({ x: elevator.x + ELEVATOR_LANES[k]!, z: elevator.z });
    expect(ELEVATOR_LANES).toEqual([0, -0.6, 0.6]);
    expect([...moves.walkers]).toEqual([
      ['a', { gait: 'walk', place: 'desk seat', near: null, to: seat, trip: walk(elevator, seat, start), step: false, arriving: true, leaving: false }],
      ['b', { gait: 'walk', place: 'lounge 2', near: null, to: lounge, trip: walk(lane(1), lounge, start + BURST_GAP_MS), step: false, arriving: true, leaving: false }],
      ['i', { gait: 'fly', place: 'intern 0', near: null, to: intern, trip: startTrip(lane(2), [point(intern)], start + 2 * BURST_GAP_MS, FLY_SPEED), step: false, arriving: true, leaving: false }],
      ['c', { gait: 'walk', place: 'desk seat', near: null, to: other, trip: walk(elevator, other, start + 3 * BURST_GAP_MS), step: false, arriving: true, leaving: false }],
    ]);
    expect(moves.passes).toEqual([0, 1, 2, 3].map((k) => start + k * BURST_GAP_MS));
  });

  it('puts every lane out of the elevator on a free cell of the walk grid, at every plan size', () => {
    for (const blocks of [1, 2, 3, 4]) {
      for (const roomCols of [1, 2]) {
        const plan = layoutPlan({ blocks, roomCols });
        const grid = walkGrid({
          size: plan.size,
          core: plan.core,
          pods: plan.pods.map((p) => ({ ...p, color: null, placard: null, desks: p.desks.map((d) => ({ ...d, occupant: null })) })),
          lounge: { rect: plan.lounge, seats: LOUNGE_SEATS },
          roomSlots: plan.rooms,
          breakArea: plan.breakArea,
        });
        const spot = elevatorSpot(plan.core);
        for (const lane of ELEVATOR_LANES) {
          const x = spot.x + lane;
          expect(grid.blocked[Math.floor(spot.z / WALK_CELL) * grid.cols + Math.floor(x / WALK_CELL)], `${blocks}x${roomCols} lane ${lane}`).toBe(0);
        }
      }
    }
  });

  it('keeps a robot whose place stays as it is, at rest or under way, and turns it to a new facing', () => {
    const still = resting('desk seat', seat);
    const going = { ...resting('lounge 2', lounge), trip: walk(seat, lounge, 0) };
    const prev = new Map([['a', still], ['b', going]]);
    const moves = moveAll(prev, [want('a', 'desk seat', { ...seat }), want('b', 'lounge 2', lounge)], ways, 800);
    expect(moves.walkers.get('a')).toBe(still);
    expect(moves.walkers.get('b')).toBe(going);
    expect(moves.passes).toEqual([]);
    const turned = moveAll(prev, [want('a', 'desk seat', { ...seat, facing: 1 })], ways, 800).walkers.get('a')!;
    expect(turned).toEqual({ ...still, to: { ...seat, facing: 1 } });
  });

  it('walks a robot whose place changed from where it is now: its spot at rest, its point along its trip under way', () => {
    const prev = new Map([['a', resting('desk seat', seat)]]);
    const toLounge = moveAll(prev, [want('a', 'lounge 2', lounge)], ways, 5000).walkers.get('a')!;
    expect(toLounge).toEqual({ gait: 'walk', place: 'lounge 2', near: null, to: lounge, trip: walk(seat, lounge, 5000), step: false, arriving: false, leaving: false });
    // A second later it is wanted at its stand instead: it turns from where it got to.
    const back = moveAll(new Map([['a', toLounge]]), [want('a', 'desk stand', stand)], ways, 6000).walkers.get('a')!;
    const from = where(toLounge.trip!, 6000);
    expect(from).not.toEqual(point(seat));
    expect(back.trip).toEqual(walk(from, stand, 6000));
    expect([back.place, back.to]).toEqual(['desk stand', stand]);
  });

  it("steps straight between a desk's chair and its stand, at rest or half way through such a step, and walks round to it from anywhere else", () => {
    const near = 'desk p0-0';
    const atDesk = (place: string, to: Spot): Wanted => ({ ...want('a', place, to), near });
    const sitting: Walker = { ...resting('desk seat', seat), near };
    const up = moveAll(new Map([['a', sitting]]), [atDesk('desk stand', stand)], ways, 1000).walkers.get('a')!;
    expect(up).toEqual({ gait: 'walk', place: 'desk stand', near, to: stand, trip: startTrip(seat, [point(stand)], 1000, WALK_SPEED), step: true, arriving: false, leaving: false });
    // Half way up, it sits back down: straight back from where it got to.
    const down = moveAll(new Map([['a', up]]), [atDesk('desk seat', seat)], ways, 1150).walkers.get('a')!;
    expect([down.step, down.trip]).toEqual([true, startTrip(where(up.trip!, 1150), [point(seat)], 1150, WALK_SPEED)]);
    expect(advance(up, tripEnd(up.trip!))).toEqual({ ...up, trip: null, step: false });
    // On its way back from the lounge, it finds its way to its stand over the grid.
    const back: Walker = { ...sitting, trip: walk(lounge, seat, 0) };
    const round = moveAll(new Map([['a', back]]), [atDesk('desk stand', stand)], ways, 1000).walkers.get('a')!;
    expect([round.step, round.trip]).toEqual([false, walk(where(back.trip!, 1000), stand, 1000)]);
    // So does a robot from another desk's chair.
    const elsewhere = moveAll(new Map([['a', { ...resting('desk seat', other), near: 'desk p1-0' }]]), [atDesk('desk stand', stand)], ways, 1000).walkers.get('a')!;
    expect([elsewhere.step, elsewhere.trip]).toEqual([false, walk(other, stand, 1000)]);
  });

  it('moves a robot at rest with its spot when the plan grows under it, and finds the way again for one under way on the new grid', () => {
    const grown = grownFloor();
    const bigger: Ways = { grid: walkGrid(grown), elevator };
    const moved = loungeSpots(grown.lounge.rect)[2]!;
    expect(moved.z).toBe(lounge.z + 8);
    const sitter = resting('lounge 2', lounge);
    const going = { ...resting('desk seat', seat), trip: walk(lounge, seat, 0) };
    const moves = moveAll(new Map([['s', sitter], ['g', going]]), [want('s', 'lounge 2', moved), want('g', 'desk seat', seat)], bigger, 1000, { regrid: true });
    // The sitter moves with the couch it sits on.
    expect(moves.walkers.get('s')).toEqual({ ...sitter, to: moved });
    const from = where(going.trip, 1000);
    expect(moves.walkers.get('g')!.trip).toEqual(walk(from, seat, 1000, bigger.grid));
    expect(moves.passes).toEqual([]);
  });

  it('sends robots no longer wanted to the elevator, BURST_GAP_MS apart, and drops one still inside it', () => {
    const going = { ...resting('lounge 2', lounge), trip: walk(seat, lounge, 0) };
    const inside: Walker = { gait: 'walk', place: 'desk seat', near: null, to: other, trip: walk(elevator, other, 2400), step: false, arriving: true, leaving: false };
    const prev = new Map([['a', resting('desk seat', seat)], ['in', inside], ['b', going]]);
    const moves = moveAll(prev, [], ways, 2000);
    const a = walk(seat, elevator, 2000);
    const b = walk(where(going.trip, 2000), elevator, 2000 + BURST_GAP_MS);
    expect([...moves.walkers]).toEqual([
      ['a', { gait: 'walk', place: '', near: null, to: elevator, trip: a, step: false, arriving: false, leaving: true }],
      ['b', { gait: 'walk', place: '', near: null, to: elevator, trip: b, step: false, arriving: false, leaving: true }],
    ]);
    expect(moves.passes).toEqual([tripEnd(a), tripEnd(b)]);
  });

  it('turns a leaving robot back from where it is when it is wanted again, and keeps a leaver on its way otherwise', () => {
    const leaving: Walker = { gait: 'walk', place: '', near: null, to: elevator, trip: walk(seat, elevator, 1000), step: false, arriving: false, leaving: true };
    const back = moveAll(new Map([['a', leaving]]), [want('a', 'desk seat', seat)], ways, 2000).walkers.get('a')!;
    expect(back).toEqual({ gait: 'walk', place: 'desk seat', near: null, to: seat, trip: walk(where(leaving.trip!, 2000), seat, 2000), step: false, arriving: false, leaving: false });
    const kept = moveAll(new Map([['a', leaving]]), [], ways, 2000);
    expect(kept.walkers.get('a')).toBe(leaving);
    expect(kept.passes).toEqual([tripEnd(leaving.trip!)]);
  });

  it('finds the way out again on a new grid for a leaver, setting off when it was to', () => {
    const grid = walkGrid(grownFloor());
    const waiting: Walker = { gait: 'walk', place: '', near: null, to: elevator, trip: walk(seat, elevator, 3000), step: false, arriving: false, leaving: true };
    const moves = moveAll(new Map([['a', waiting]]), [], { grid, elevator }, 2000, { regrid: true });
    const trip = walk(seat, elevator, 3000, grid);
    expect(moves.walkers.get('a')).toEqual({ ...waiting, trip });
    expect(moves.passes).toEqual([tripEnd(trip)]);
  });

  it('lets a robot still inside the elevator come out when it was to, wherever it is wanted next', () => {
    const inside: Walker = { gait: 'walk', place: 'desk seat', near: null, to: seat, trip: walk(elevator, seat, 2400), step: false, arriving: true, leaving: false };
    const moves = moveAll(new Map([['a', inside]]), [want('a', 'lounge 2', lounge)], ways, 2000);
    expect(moves.walkers.get('a')).toEqual({ gait: 'walk', place: 'lounge 2', near: null, to: lounge, trip: walk(elevator, lounge, 2400), step: false, arriving: true, leaving: false });
    expect(moves.passes).toEqual([2400]);
  });

  it('gives the passes of every robot still to come out of the elevator or to reach it, and none of one dropped inside it or turned back', () => {
    const inside: Walker = { gait: 'walk', place: 'desk seat', near: null, to: seat, trip: walk(elevator, seat, 2400), step: false, arriving: true, leaving: false };
    const out: Walker = { ...inside, trip: walk(elevator, other, 1500), to: other };
    const leaving: Walker = { gait: 'walk', place: '', near: null, to: elevator, trip: walk(seat, elevator, 1000), step: false, arriving: false, leaving: true };
    const prev = new Map([['in', inside], ['out', out], ['leaving', leaving]]);
    // The one inside and the leaver still have to pass the doors; the one already out passed them at 1500.
    expect(moveAll(prev, [want('in', 'desk seat', seat), want('out', 'desk seat', other)], ways, 2000).passes).toEqual([2400, tripEnd(leaving.trip!)]);
    // Dropped inside the elevator, and turned back before it gets there: no pass is left for either.
    const moves = moveAll(prev, [want('out', 'desk seat', other), want('leaving', 'desk seat', seat)], ways, 2000);
    expect([[...moves.walkers.keys()], moves.walkers.get('leaving')!.leaving, moves.passes]).toEqual([['out', 'leaving'], false, []]);
  });

  it('is pure: the same walkers for the same update, prev left as it was, a robot listed twice placed once', () => {
    const prev = new Map([['a', resting('desk seat', seat)], ['b', { ...resting('lounge 2', lounge), trip: walk(seat, lounge, 0) }]]);
    const copy = structuredClone([...prev]);
    const wanted = [want('a', 'lounge 2', lounge), want('c', 'desk seat', other), want('c', 'desk stand', stand)];
    const first = moveAll(prev, wanted, ways, 900);
    expect(moveAll(prev, wanted, ways, 900)).toEqual(first);
    expect([...prev]).toEqual(copy);
    expect(first.walkers.get('c')!.place).toBe('desk seat');
    expect([...first.walkers.keys()]).toEqual(['a', 'c', 'b']);
  });
});

describe('a walker over time', () => {
  const coming: Walker = { gait: 'walk', place: 'desk seat', near: null, to: seat, trip: walk(elevator, seat, 1400), step: false, arriving: true, leaving: false };
  const end = tripEnd(coming.trip!);

  it('waits unseen inside the elevator until it sets off, walks its trip facing its way, and stands at its place facing its own way', () => {
    expect(walkerAt(coming, 1000)).toEqual({ x: elevator.x, z: elevator.z, facing: tripAt(coming.trip!, 1000).facing, walking: false, shown: false });
    const on = tripAt(coming.trip!, 2000);
    expect(walkerAt(coming, 2000)).toEqual({ x: on.x, z: on.z, facing: on.facing, walking: true, shown: true });
    expect(walkerAt(coming, end)).toEqual({ x: seat.x, z: seat.z, facing: seat.facing, walking: false, shown: true });
    // One leaving waits where it is, in sight, until it sets off.
    const leaving: Walker = { gait: 'walk', place: '', near: null, to: elevator, trip: walk(seat, elevator, 3000), step: false, arriving: false, leaving: true };
    expect(walkerAt(leaving, 2900)).toMatchObject({ x: seat.x, z: seat.z, walking: false, shown: true });
    expect(walkerAt(resting('desk seat', seat), 0)).toEqual({ x: seat.x, z: seat.z, facing: seat.facing, walking: false, shown: true });
  });

  it('is the same walker until its trip is over, then rests at its place, or is gone when it was leaving', () => {
    expect(advance(coming, end - 1)).toBe(coming);
    expect(advance(coming, end)).toEqual({ ...coming, trip: null, arriving: false });
    const still = resting('desk seat', seat);
    expect(advance(still, 99_999)).toBe(still);
    const leaving: Walker = { gait: 'walk', place: '', near: null, to: elevator, trip: walk(seat, elevator, 3000), step: false, arriving: false, leaving: true };
    expect(advance(leaving, tripEnd(leaving.trip!) - 1)).toBe(leaving);
    expect(advance(leaving, tripEnd(leaving.trip!))).toBeNull();
  });

  it('settles at once: at its place, or gone when it was leaving', () => {
    expect(settled(coming)).toEqual({ ...coming, trip: null, arriving: false });
    const still = resting('desk seat', seat);
    expect(settled(still)).toBe(still);
    expect(settled({ gait: 'walk', place: '', near: null, to: elevator, trip: walk(seat, elevator, 3000), step: false, arriving: false, leaving: true })).toBeNull();
  });
});

describe('the elevator doors', () => {
  it('move while they open and close, and neither while shut nor while held open', () => {
    const passes = [10_000];
    const at = (t: number) => doorsMoving(passes, t);
    expect([9000, 9599, 9600, 9800, 9999, 10_000, 10_600, 11_199, 11_200, 11_400, 11_599, 11_600, 12_000].map(at)).toEqual([
      false, false, true, true, true, false, false, false, true, true, true, false, false,
    ]);
    // Two passes closer than the hold: the doors stay open between them.
    expect([10_800, 11_200, 11_600, 12_000, 12_400].map((t) => doorsMoving([10_000, 10_800], t))).toEqual([false, false, false, true, false]);
    expect(doorsMoving([], 0)).toBe(false);
  });

  it('tell when they next start to open, or to close after their hold', () => {
    expect(doorsNext([10_000], 0)).toBe(10_000 - DOOR_MS);
    expect(doorsNext([10_000], 9600)).toBe(10_000 + DOOR_HOLD_MS);
    // A second pass while they are open: they close after its hold, not after the first one's.
    expect(doorsNext([10_000, 10_800], 10_000)).toBe(10_800 + DOOR_HOLD_MS);
    expect(doorsNext([10_000, 14_000], 11_300)).toBe(14_000 - DOOR_MS);
    expect(doorsNext([10_000], 11_200)).toBeNull();
    expect(doorsNext([], 0)).toBeNull();
  });
});
