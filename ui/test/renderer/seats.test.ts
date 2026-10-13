import { describe, expect, it } from 'vitest';
import { keepSeats } from '../../renderer/seats';

const seats = (entries: Array<[string, number]>) => new Map(entries);

describe('keepSeats', () => {
  it('gives the first ids the lowest seats, in list order, and none to those beyond the seats', () => {
    expect(keepSeats(new Map(), ['a', 'b', 'c'], 8)).toEqual(seats([['a', 0], ['b', 1], ['c', 2]]));
    expect(keepSeats(new Map(), ['a', 'b', 'c', 'd'], 3)).toEqual(seats([['a', 0], ['b', 1], ['c', 2]]));
    expect(keepSeats(new Map(), [], 3)).toEqual(new Map());
    expect(keepSeats(new Map(), ['a'], 0)).toEqual(new Map());
  });

  it('keeps everybody on their seat when one leaves, and gives the seats left free to the next ones, lowest first', () => {
    const first = keepSeats(new Map(), ['a', 'b', 'c'], 8);
    const after = keepSeats(first, ['a', 'c'], 8);
    expect(after).toEqual(seats([['a', 0], ['c', 2]]));
    expect(keepSeats(after, ['a', 'c', 'd', 'e'], 8)).toEqual(seats([['a', 0], ['c', 2], ['d', 1], ['e', 3]]));
  });

  it('gives a freed seat to an id that waited beyond the seats, and moves nobody else', () => {
    const full = keepSeats(new Map(), ['a', 'b', 'c', 'd'], 3);
    expect(full.has('d')).toBe(false);
    // 'b' leaves: 'd', still listed, takes its seat; nobody else moves.
    expect(keepSeats(full, ['a', 'c', 'd'], 3)).toEqual(seats([['a', 0], ['c', 2], ['d', 1]]));
  });

  it('keeps a seat whatever the order of the list, and drops seats beyond `count` and ids listed twice', () => {
    const prev = seats([['a', 2], ['b', 0], ['c', 5]]);
    expect(keepSeats(prev, ['c', 'b', 'a', 'd'], 4)).toEqual(seats([['b', 0], ['a', 2], ['c', 1], ['d', 3]]));
    expect(keepSeats(prev, ['a', 'b', 'a', 'd'], 4)).toEqual(seats([['a', 2], ['b', 0], ['d', 1]]));
    // Two ids on one seat (no keepSeats result has that): the first listed keeps it.
    expect(keepSeats(seats([['a', 1], ['b', 1]]), ['b', 'a'], 4)).toEqual(seats([['b', 1], ['a', 0]]));
  });

  it('is pure: a fresh map, the same for the same seats in any order, and its input untouched', () => {
    const prev = seats([['a', 1], ['b', 0]]);
    const out = keepSeats(prev, ['a', 'b', 'c'], 4);
    expect(out).not.toBe(prev);
    expect(prev).toEqual(seats([['a', 1], ['b', 0]]));
    expect(keepSeats(seats([['b', 0], ['a', 1]]), ['a', 'b', 'c'], 4)).toEqual(out);
    expect([...out]).toEqual([['a', 1], ['b', 0], ['c', 2]]);
  });
});
