import { describe, expect, it } from 'vitest';
import { findRun, runName } from '../../lib/runs';
import { DONE_RUN, RUN, checkoutWithRoom } from '../helpers/rooms';

describe('findRun', () => {
  it("finds a run in its room, at its host's desk, also when a desk ahead of it lists the same run", () => {
    const floor = checkoutWithRoom();
    const desks = floor.islands.flatMap((i) => i.desks);
    const host = desks.find((d) => d.sessionId === floor.rooms[0]!.hostSessionId)!;
    // Two sessions that name one run: the first desk on the floor lists it too.
    const other = desks[0]!;
    expect(other).not.toBe(host);
    other.runs = [...host.runs.filter((r) => r.runId === RUN), ...other.runs];
    const found = findRun(floor, RUN)!;
    expect([found.room?.runId, found.desk.sessionId, found.run?.runId]).toEqual([RUN, host.sessionId, RUN]);
    expect(runName(found, RUN)).toBe('checkout-verify');
  });

  it("finds a run without a room in the runs of a desk, and nothing for a run nobody names", () => {
    const floor = checkoutWithRoom();
    const found = findRun(floor, DONE_RUN)!;
    expect([found.room, found.run?.name, runName(found, DONE_RUN)]).toEqual([null, 'nightly-smoke', 'nightly-smoke']);
    expect(findRun(floor, 'wf_gone')).toBeNull();
  });
});
