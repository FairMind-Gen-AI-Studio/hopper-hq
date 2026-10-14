/**
 * Seats that stay put (design §5.2): the seats at a room's table and the spots of a desk's interns go to whoever comes
 * first and stay theirs until they leave, so nobody moves when somebody else goes. Pure: no three.js objects, no DOM.
 */

/** Keeps each id that is still listed on its seat; new ids take the lowest free seats in list order; ids beyond `count` seats get none. Pure. */
export function keepSeats(prev: ReadonlyMap<string, number>, ids: readonly string[], count: number): Map<string, number> {
  // A count that is not a whole number has only its whole seats; one that is not a number has none.
  const n = Number.isNaN(count) ? 0 : Math.floor(count);
  const seats = new Map<string, number>();
  const taken = new Set<number>();
  // Those still listed keep their seat, while it is one of the `n` and nobody listed before them has it.
  for (const id of ids) {
    const seat = prev.get(id);
    if (seat === undefined || seats.has(id) || taken.has(seat) || seat < 0 || seat >= n) continue;
    seats.set(id, seat);
    taken.add(seat);
  }
  // The others take the lowest free seats, in list order, while any is left.
  let free = 0;
  for (const id of ids) {
    if (seats.has(id)) continue;
    while (taken.has(free)) free++;
    if (free >= n) break;
    seats.set(id, free);
    taken.add(free);
  }
  return seats;
}
