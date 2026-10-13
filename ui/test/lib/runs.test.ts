import { describe, expect, it } from 'vitest';
import { occupantsOf } from '../../lib/occupants';
import { findRun, runName } from '../../lib/runs';
import { DONE_RUN, RUN, checkoutWithRoom } from '../helpers/rooms';

describe('findRun', () => {
  it("finds a run in its room, with its host, also when a session ahead of it lists the same run", () => {
    const floor = checkoutWithRoom();
    const sessions = occupantsOf(floor);
    const host = sessions.find((d) => d.sessionId === floor.rooms[0]!.hostSessionId)!;
    // Two sessions that name one run: the first session on the floor lists it too.
    const other = sessions[0]!;
    expect(other).not.toBe(host);
    other.runs = [...host.runs.filter((r) => r.runId === RUN), ...other.runs];
    const found = findRun(floor, RUN)!;
    expect([found.room?.runId, found.host.sessionId, found.run?.runId]).toEqual([RUN, host.sessionId, RUN]);
    expect(runName(found, RUN)).toBe('checkout-verify');
  });

  it("finds a run without a room in the runs of a session, and nothing for a run nobody names", () => {
    const floor = checkoutWithRoom();
    const found = findRun(floor, DONE_RUN)!;
    expect([found.room, found.run?.name, runName(found, DONE_RUN)]).toEqual([null, 'nightly-smoke', 'nightly-smoke']);
    expect(findRun(floor, 'wf_gone')).toBeNull();
  });

  it('finds the run of a session waiting for a desk, after those of the sessions at a desk', () => {
    const floor = checkoutWithRoom();
    const host = occupantsOf(floor).find((d) => d.sessionId === 'ps-d4')!;
    floor.pods = floor.pods.map((p) => ({ ...p, desks: p.desks.map((d) => (d.occupant === host ? { ...d, occupant: null } : d)) }));
    floor.unseated = [{ ...host, at: { kind: 'gone' } }];
    expect(findRun(floor, RUN)!.host.sessionId).toBe('ps-d4');
    expect(findRun(floor, DONE_RUN)!.host.sessionId).toBe('ps-d4');
  });
});
