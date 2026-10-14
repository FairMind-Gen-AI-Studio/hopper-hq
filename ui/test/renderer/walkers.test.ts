import { describe, expect, it } from 'vitest';
import { BURST_GAP_MS, DOOR_MS, FLY_SPEED, WALK_SPEED, startTrip, tripAt, tripEnd, type Trip } from '../../renderer/motion';
import { findPath, walkGrid } from '../../renderer/walk';
import { advance, moveAll, settled, walkerAt, type Walker, type Wanted, type Ways } from '../../renderer/walkers';
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

  it('brings robots new to the floor out of the elevator once its doors are open, BURST_GAP_MS apart, an intern flying straight', () => {
    const intern = internSpots(desk)[0]!;
    const moves = moveAll(new Map(), [want('a', 'desk seat', seat), want('b', 'lounge 2', lounge), want('i', 'intern 0', intern, 'fly')], ways, 1000);
    const start = 1000 + DOOR_MS;
    expect([...moves.walkers]).toEqual([
      ['a', { gait: 'walk', place: 'desk seat', near: null, to: seat, trip: walk(elevator, seat, start), step: false, arriving: true, leaving: false }],
      ['b', { gait: 'walk', place: 'lounge 2', near: null, to: lounge, trip: walk(elevator, lounge, start + BURST_GAP_MS), step: false, arriving: true, leaving: false }],
      ['i', { gait: 'fly', place: 'intern 0', near: null, to: intern, trip: startTrip(elevator, [point(intern)], start + 2 * BURST_GAP_MS, FLY_SPEED), step: false, arriving: true, leaving: false }],
    ]);
    expect(moves.passes).toEqual([start, start + BURST_GAP_MS, start + 2 * BURST_GAP_MS]);
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
    expect(kept.passes).toEqual([]);
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
    expect(moves.passes).toEqual([]);
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
