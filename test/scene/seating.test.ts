import { describe, expect, it } from 'vitest';
import { newSession } from '../../src/core/reducer.js';
import type { Session, SessionState, WorkflowRun, Workspace } from '../../src/core/types.js';
import { buildFloors, toView, type SessionView } from '../../src/core/view.js';
import { BLOCK_DESKS, BLOCKS_MAX, LOUNGE_SEATS } from '../../src/scene/layout.js';
import { emptySeating, parseSeating, roomRunsOf, seatFloor, type Seating } from '../../src/scene/seating.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NOW = 30 * DAY;
const _ = null;

/** Three checkouts on the checkout-v2 floor. */
const ORDERS = '/home/dev/orders-api';
const PAYMENTS = '/home/dev/payments-svc';
const WEB = '/home/dev/storefront-web';

const ws = (root: string): Workspace => ({ cwd: root, repoRoot: root, repoName: root.split('/').pop()!, worktree: false, branch: 'feat/checkout-v2', root });

/**
 * A session of checkout `root` viewed at NOW: started `start` minutes after NOW - 1 day, showing `state` for `since`
 * minutes (5 by default). A dormant session has been dormant `since` minutes.
 */
function view(id: string, root: string, state: SessionState = 'working', o: { start?: number; since?: number; runs?: WorkflowRun[] } = {}): SessionView {
  const since = NOW - (o.since ?? 5) * MIN;
  const stored: Pick<Session, 'state' | 'stateSince'> = state === 'dormant' ? { state: 'idle', stateSince: since - 3 * DAY } : { state, stateSince: since };
  return toView({ ...newSession(id, NOW - DAY + (o.start ?? 0) * MIN, ws(root)), ...stored, lastEventAt: stored.stateSince, runs: o.runs ?? [] }, NOW);
}

/** `n` working sessions of one checkout, `<prefix>00` onwards, started one minute apart from `start`. */
const team = (prefix: string, n: number, root: string, start = 0): SessionView[] =>
  Array.from({ length: n }, (_, i) => view(`${prefix}${String(i).padStart(2, '0')}`, root, 'working', { start: start + i }));

/** A run still going, started `start` minutes after NOW - 1 hour. */
const run = (id: string, start: number, extra: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id, name: null, summary: null, phases: [], currentPhase: null, status: 'running', onDisk: true, startedAt: NOW - 60 * MIN + start * MIN, endedAt: null, agents: [], agentsFinished: 0, ...extra,
});

function floorOf(views: SessionView[]) {
  const floors = buildFloors(views);
  expect(floors).toHaveLength(1);
  return floors[0]!;
}

function freeze(s: Seating): Seating {
  for (const list of [s.desks, s.lounge, s.rooms]) Object.freeze(list);
  return Object.freeze(s);
}

/**
 * seatFloor on the floor of `views`, checked every time: it leaves `prev` untouched, gives the same seating whatever the
 * order of the floor's sessions, and is idempotent.
 */
function seat(prev: Seating | null, views: SessionView[]): Seating {
  const floor = floorOf(views);
  const next = seatFloor(prev && freeze(prev), floor);
  expect(seatFloor(prev && structuredClone(prev), { ...floor, sessions: [...floor.sessions].reverse() })).toEqual(next);
  expect(seatFloor(next, floor)).toBe(next);
  return next;
}

/** A seating with one block and one room column, unless the desks say more blocks. */
const seating = (desks: (string | null)[], lounge: (string | null)[] = Array(LOUNGE_SEATS).fill(_), rooms: (string | null)[] = [_, _]): Seating => ({
  blocks: desks.length / BLOCK_DESKS, roomCols: rooms.length / 2, desks, lounge, rooms,
});

describe('emptySeating', () => {
  it('is one block and one room column with nobody seated, a fresh value each time', () => {
    expect(emptySeating()).toEqual({ blocks: 1, roomCols: 1, desks: [_, _, _, _, _, _, _, _], lounge: [_, _, _, _, _, _, _, _], rooms: [_, _] });
    const a = emptySeating();
    a.desks[0] = 'o1';
    expect(emptySeating().desks[0]).toBeNull();
  });
});

describe('roomRunsOf', () => {
  it('keeps one live run per room key, that of the host that started first, then by id, in run start order, then run id', () => {
    const views = [
      view('a2', ORDERS, 'in_meeting', { start: 0, runs: [run('wf_0000aaaa-002', 10)] }),
      view('b1', PAYMENTS, 'in_meeting', { start: 5, runs: [run('wf_0000aaaa-003', 20), run('wf_0000aaaa-001', 10)] }),
      view('a1', ORDERS, 'in_meeting', {
        start: 0,
        runs: [run('wf_0000aaaa-003', 30), run('wf_0000aaaa-009', 1, { status: 'completed', endedAt: NOW - MIN }), run('wf_0000aaaa-002', 10), run('wf_0000aaaa-004', 2, { onDisk: false })],
      }),
    ];
    const shown = (floor: ReturnType<typeof floorOf>) => roomRunsOf(floor).map((r) => [r.key, r.run.id, r.run.startedAt, r.host.id]);
    const floor = floorOf(views);
    expect(shown(floor)).toEqual([
      ['wf_0000aaaa-001', 'wf_0000aaaa-001', NOW - 50 * MIN, 'b1'],
      ['wf_0000aaaa-002', 'wf_0000aaaa-002', NOW - 50 * MIN, 'a1'],
      ['wf_0000aaaa-003', 'wf_0000aaaa-003', NOW - 30 * MIN, 'a1'],
    ]);
    expect(shown({ ...floor, sessions: [...floor.sessions].reverse() })).toEqual(shown(floor));
  });
});

describe('desks', () => {
  it('S1: frees the desk of a session that left the floor, and keeps everybody else where they sit', () => {
    const prev = seat(null, [view('o1', ORDERS, 'working', { start: 1 }), view('o2', ORDERS, 'working', { start: 2 }), view('p1', PAYMENTS, 'working', { start: 3 })]);
    expect(prev.desks).toEqual(['o1', 'o2', _, _, 'p1', _, _, _]);
    expect(seat(prev, [view('o2', ORDERS, 'working', { start: 2 }), view('p1', PAYMENTS, 'working', { start: 3 })])).toEqual(seating([_, 'o2', _, _, 'p1', _, _, _]));
  });

  it('S2a: seats a session at a free desk of a pod where its checkout sits, before an empty pod or an earlier free desk', () => {
    const prev = seating([_, 'o2', _, _, 'w1', 'w2', _, _]);
    const views = [view('o2', ORDERS), view('w1', WEB), view('w2', WEB), view('w3', WEB, 'working', { start: 10 }), view('p1', PAYMENTS, 'working', { start: 11 }), view('o3', ORDERS, 'working', { start: 12 })];
    expect(seat(prev, views).desks).toEqual(['p1', 'o2', 'o3', _, 'w1', 'w2', 'w3', _]);
  });

  it('S2a: takes the next pod where its checkout sits when the first one is full, and counts the desk a dormant session keeps', () => {
    const full = seating(['o1', 'o2', 'o3', 'o4', 'w1', 'o5', _, _, _, _, _, _, _, _, _, _]);
    const views = [...['o1', 'o2', 'o3', 'o4', 'o5'].map((id) => view(id, ORDERS)), view('w1', WEB)];
    expect(seat(full, [...views, view('o6', ORDERS, 'working', { start: 10 })]).desks).toEqual(['o1', 'o2', 'o3', 'o4', 'w1', 'o5', 'o6', _, _, _, _, _, _, _, _, _]);

    const reserved = seating([_, _, _, _, 'w1', _, _, _, 'd1', _, _, _, _, _, _, _]);
    expect(seat(reserved, [view('w1', WEB), view('d1', ORDERS, 'dormant', { since: DAY }), view('o1', ORDERS, 'working', { start: 10 })]).desks).toEqual([_, _, _, _, 'w1', _, _, _, 'd1', 'o1', _, _, _, _, _, _]);
  });

  it('S2b: seats a session of a checkout new to the floor at the first desk of the first empty pod', () => {
    expect(seat(seating(['o1', _, _, _, _, _, _, _]), [view('o1', ORDERS), view('p1', PAYMENTS, 'working', { start: 10 })]).desks).toEqual(['o1', _, _, _, 'p1', _, _, _]);
  });

  it('S2c: seats a session at the first free desk when no pod of its checkout has one and no pod is empty', () => {
    const prev = seating(['o1', 'o2', 'o3', _, 'w1', 'w2', _, _]);
    const views = [...['o1', 'o2', 'o3'].map((id) => view(id, ORDERS)), view('w1', WEB), view('w2', WEB), view('p1', PAYMENTS, 'working', { start: 10 })];
    expect(seat(prev, views).desks).toEqual(['o1', 'o2', 'o3', 'p1', 'w1', 'w2', _, _]);
  });

  it('S2d: with no desk free, takes the desk of the session dormant longest, then by id, which is left without one', () => {
    const prev = seating(['o1', 'o2', 'o3', 'd1', 'w1', 'd3', 'd2', 'w2']);
    const views = [
      ...['o1', 'o2', 'o3'].map((id) => view(id, ORDERS)), view('w1', WEB), view('w2', WEB),
      view('d1', ORDERS, 'dormant', { since: 2 * DAY }), view('d2', WEB, 'dormant', { since: 3 * DAY }), view('d3', WEB, 'dormant', { since: 3 * DAY }),
      view('p1', PAYMENTS, 'working', { start: 10 }), view('p2', PAYMENTS, 'working', { start: 11 }),
    ];
    // d2 and d3 have been dormant longest; d2 goes first by id.
    expect(seat(prev, views)).toEqual(seating(['o1', 'o2', 'o3', 'd1', 'w1', 'p2', 'p1', 'w2']));
  });

  it('S2e: grows the plan a block at a time when no desk is free and nobody is dormant, up to 4 blocks; then sessions wait, and take freed desks in start order', () => {
    const one = seat(null, team('s', 8, ORDERS));
    expect([one.blocks, one.desks]).toEqual([1, team('s', 8, ORDERS).map((v) => v.id)]);
    const two = seat(one, team('s', 9, ORDERS));
    expect([two.blocks, two.desks.length, two.desks[8], two.desks.slice(9)]).toEqual([2, 16, 's08', [_, _, _, _, _, _, _]]);

    const all = team('s', 34, ORDERS);
    const capped = seat(two, all);
    expect([capped.blocks, capped.desks]).toEqual([BLOCKS_MAX, all.slice(0, 32).map((v) => v.id)]);
    // s05 ends: s32, the first to wait, takes its desk.
    const after = seat(capped, all.filter((v) => v.id !== 's05'));
    expect([after.blocks, after.desks[5], after.desks.includes('s33')]).toEqual([4, 's32', false]);
    // The plan never shrinks while the floor has a session.
    expect(seat(after, [all[0]!])).toEqual({ ...after, desks: ['s00', ...Array(31).fill(_)] });
  });

  it('S2: seats arrivals in start order, then by id, whatever the order of the floor', () => {
    const views = [view('c1', ORDERS, 'working', { start: 5 }), view('b2', ORDERS, 'working', { start: 3 }), view('b1', ORDERS, 'working', { start: 3 })];
    expect(seat(null, views).desks).toEqual(['b1', 'b2', 'c1', _, _, _, _, _]);
  });

  it('S3: seats dormant sessions after the others, at a free desk only: never at another session\'s desk, never on a new block', () => {
    const working = team('w', 8, WEB, 10);
    const first = seat(null, [view('d1', ORDERS, 'dormant', { start: 0 }), view('d2', ORDERS, 'dormant', { start: 1 }), ...working]);
    expect([first.blocks, first.desks]).toEqual([1, working.map((v) => v.id)]);

    const seven = working.slice(0, 7);
    const prev = seating([...seven.map((v) => v.id), _]);
    expect(seat(prev, [view('d2', ORDERS, 'dormant', { start: 1 }), view('d1', ORDERS, 'dormant', { start: 0 }), ...seven]).desks).toEqual([...seven.map((v) => v.id), 'd1']);
  });

  it('S2d then S2e in one read: the dormant session left without a desk sits again at a free desk of the block grown later in that read', () => {
    const seven = team('w', 7, ORDERS);
    const prev = seating([...seven.map((v) => v.id), 'd1']);
    const views = [...seven, view('d1', ORDERS, 'dormant', { since: 60 }), view('x1', ORDERS, 'working', { start: 20 }), view('x2', ORDERS, 'working', { start: 21 })];
    // x1 takes d1's desk (S2d); x2 finds no desk free and nobody dormant at one, so the plan grows (S2e); then d1, dormant,
    // takes the first free desk among the pods of its checkout: on the new block, beside x2 (S3).
    const next = seat(prev, views);
    expect([next.blocks, next.desks]).toEqual([2, [...seven.map((v) => v.id), 'x1', 'x2', 'd1', _, _, _, _, _, _]]);
  });

  it('seats a floor on first start in the smallest plan that holds its sessions that are not dormant, the dormant ones at the desks left', () => {
    const dormant = ['d0', 'd1', 'd2'].map((id, i) => view(id, ORDERS, 'dormant', { start: i }));
    const working = team('w', 10, ORDERS, 10);
    expect(seat(null, [...dormant, ...working])).toEqual(seating([...working.map((v) => v.id), 'd0', 'd1', 'd2', _, _, _]));
  });

  it('S8: returns the very seating it was given while nothing changes, and a new one when something does', () => {
    const views = [view('o1', ORDERS), view('w1', WEB, 'idle'), view('p1', PAYMENTS, 'in_meeting', { runs: [run('wf_0000aaaa-001', 1)] })];
    const prev = seat(null, views);
    expect(prev).toEqual(seating(['o1', 'w1', _, _, 'p1', _, _, _], ['w1', _, _, _, _, _, _, _], ['wf_0000aaaa-001', _]));
    expect(seatFloor(prev, floorOf(views))).toBe(prev);
    expect(seatFloor(structuredClone(prev), floorOf(views))).toEqual(prev);
    const next = seat(prev, [...views, view('o2', ORDERS, 'working', { start: 10 })]);
    expect(next).not.toBe(prev);
    expect(next.desks).toEqual(['o1', 'w1', 'o2', _, 'p1', _, _, _]);
  });
});

describe('the lounge', () => {
  it('S5: seats idle sessions with a desk, in the order they became idle, then by id, while seats last', () => {
    // i00 became idle first, i09 last; i10 and i11 at the same time as i04.
    const idle = Array.from({ length: 10 }, (_, i) => view(`i0${i}`, ORDERS, 'idle', { start: i, since: 100 - i }));
    const views = [...idle, view('i11', ORDERS, 'idle', { start: 20, since: 96 }), view('i10', ORDERS, 'idle', { start: 21, since: 96 })];
    expect(seat(null, views).lounge).toEqual(['i00', 'i01', 'i02', 'i03', 'i04', 'i10', 'i11', 'i05']);
  });

  it('S5: gives no seat to an idle session waiting for a desk', () => {
    const capped = seat(null, [...team('s', 32, ORDERS), view('i1', ORDERS, 'idle', { start: 40 })]);
    expect([capped.desks.includes('i1'), capped.lounge]).toEqual([false, [_, _, _, _, _, _, _, _]]);
  });

  it('S4: frees the seat of a session that is no longer idle or has left its desk, and the others keep theirs', () => {
    const before = [view('i1', ORDERS, 'idle', { since: 50 }), view('i2', ORDERS, 'idle', { since: 40 }), view('i3', WEB, 'idle', { since: 30 }), view('i4', WEB, 'idle', { since: 20 })];
    const prev = seat(null, before);
    expect([prev.desks, prev.lounge]).toEqual([['i1', 'i2', _, _, 'i3', 'i4', _, _], ['i1', 'i2', 'i3', 'i4', _, _, _, _]]);
    // i1 is prompted again, i2 ends, i3 has gone dormant and keeps its desk; i5 becomes idle.
    const after = [view('i1', ORDERS, 'working'), view('i3', WEB, 'dormant', { since: 1 }), before[3]!, view('i5', PAYMENTS, 'idle', { start: 10, since: 1 })];
    expect(seat(prev, after)).toEqual(seating(['i1', 'i5', _, _, 'i3', 'i4', _, _], ['i5', _, _, 'i4', _, _, _, _]));
  });
});

describe('rooms', () => {
  it('S6–S7: gives a live run the first empty room and keeps it there while earlier runs end; a third run at once opens a second column; beyond four, none', () => {
    const host = (id: string, runs: WorkflowRun[]) => view(id, ORDERS, 'in_meeting', { runs });
    const r = (n: number, extra: Partial<WorkflowRun> = {}) => run(`wf_0000aaaa-00${n}`, n, extra);
    const ended = { status: 'completed' as const, endedAt: NOW - MIN };

    // Two hosts name run 1: it holds one room.
    const one = seat(null, [host('h1', [r(1), r(2)]), host('h2', [r(1)])]);
    expect([one.roomCols, one.rooms]).toEqual([1, ['wf_0000aaaa-001', 'wf_0000aaaa-002']]);
    // Run 1 ends: run 3 takes its room, and run 2 stays where it is.
    const two = seat(one, [host('h1', [r(1, ended), r(2), r(3)]), host('h2', [r(1, ended)])]);
    expect([two.roomCols, two.rooms]).toEqual([1, ['wf_0000aaaa-003', 'wf_0000aaaa-002']]);
    const four = seat(two, [host('h1', [r(2), r(3), r(4), r(5)]), host('h2', [])]);
    expect([four.roomCols, four.rooms]).toEqual([2, ['wf_0000aaaa-003', 'wf_0000aaaa-002', 'wf_0000aaaa-004', 'wf_0000aaaa-005']]);
    // A sixth run gets no room: nothing changes.
    expect(seat(four, [host('h1', [r(2), r(3), r(4), r(5), r(6)]), host('h2', [])])).toBe(four);
    // Every run ends: the rooms empty, and the wing keeps its second column.
    expect(seat(four, [host('h1', [r(2, ended)]), host('h2', [])])).toEqual({ ...four, rooms: [_, _, _, _] });
  });
});

describe('parseSeating', () => {
  const valid = seating(['o1', _, _, _, 'w1', _, _, _], ['w1', _, _, _, _, _, _, _], ['wf_0000aaaa-001', _]);

  it('reads back what JSON.stringify wrote, a lounge sitter at its desk included, as a fresh value with the seating fields only', () => {
    expect(parseSeating(JSON.stringify(valid))).toEqual(valid);
    const grown = seat(null, [...team('s', 20, ORDERS), view('i1', ORDERS, 'idle', { start: 30 }), view('h1', WEB, 'in_meeting', { runs: [1, 2, 3].map((n) => run(`wf_0000aaaa-00${n}`, n)) })]);
    expect([grown.blocks, grown.roomCols]).toEqual([3, 2]);
    expect(parseSeating(JSON.stringify(grown))).toEqual(grown);
    const shuffled = parseSeating(JSON.stringify({ rooms: valid.rooms, extra: 1, lounge: valid.lounge, desks: valid.desks, roomCols: 1, blocks: 1 }));
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(valid));
  });

  it('rejects anything that is not a valid seating', () => {
    const bad = (patch: Record<string, unknown>) => JSON.stringify({ ...valid, ...patch });
    const { rooms: _rooms, ...noRooms } = valid;
    const texts = [
      '', 'nope', 'null', '[]', '"seating"', '1', JSON.stringify(noRooms),
      bad({ blocks: 0 }), bad({ blocks: 5 }), bad({ blocks: 1.5 }), bad({ blocks: '1' }), bad({ roomCols: 0 }), bad({ roomCols: 3 }),
      bad({ desks: valid.desks.slice(1) }), bad({ blocks: 2 }), bad({ lounge: valid.lounge.slice(1) }), bad({ rooms: [...valid.rooms, _, _] }),
      bad({ desks: ['o1', 1, _, _, 'w1', _, _, _] }), bad({ lounge: [true, _, _, _, _, _, _, _] }), bad({ rooms: [{}, _] }), bad({ desks: 'o1' }),
      // An id twice in one list, and a lounge sitter without a desk.
      bad({ desks: ['o1', _, _, _, 'o1', _, _, _] }), bad({ lounge: ['w1', 'w1', _, _, _, _, _, _] }), bad({ lounge: ['p1', _, _, _, _, _, _, _] }),
      bad({ rooms: ['wf_0000aaaa-001', 'wf_0000aaaa-001'] }),
    ];
    expect(texts.map(parseSeating)).toEqual(texts.map(() => null));
  });
});
