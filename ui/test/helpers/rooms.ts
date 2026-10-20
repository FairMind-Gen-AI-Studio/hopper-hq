/**
 * A workflow run for UI tests: the fixtures' checkout floor with the payments session (ps-d4) in a meeting, its run in
 * the first room slot, put together the way src/scene/build.ts does. Each call returns fresh objects.
 */
import type { FloorDetail, MeetingRoom } from '../../../src/scene/types';
import { CHECKOUT, NOW, makeFloor } from './fixtures';

/** The run in the room. */
export const RUN = 'wf_0000aaaa-001';
/** An earlier run of the same desk, finished: it has no room. */
export const DONE_RUN = 'wf_0000aaaa-000';

const MIN = 60_000;

export function checkoutWithRoom(): FloorDetail {
  const floor = makeFloor(CHECKOUT)!;
  const host = floor.pods.flatMap((p) => p.desks).find((d) => d.occupant?.checkout.repo === 'payments-svc')!.occupant!;
  host.at = { kind: 'room', slot: 0 };
  host.runs = [
    { runId: RUN, name: 'checkout-verify', status: 'running', startedAt: NOW - 9 * MIN, endedAt: null, counts: { running: 2, finished: 1 } },
    { runId: DONE_RUN, name: 'nightly-smoke', status: 'completed', startedAt: NOW - 70 * MIN, endedAt: NOW - 62 * MIN, counts: { running: 0, finished: 4 } },
  ];
  const room: MeetingRoom = {
    kind: 'workflow',
    runId: RUN,
    hostSessionId: host.sessionId,
    name: 'checkout-verify',
    topic: 'checkout-verify',
    summary: 'Verify split payments end to end',
    phases: [
      { title: 'Plan', state: 'done' },
      { title: 'Build', state: 'current' },
      { title: 'Review', state: 'upcoming' },
      { title: 'Ship', state: 'upcoming' },
    ],
    counts: { running: 2, finished: 1 },
    agents: [
      { agentId: 'wf-agent-1', label: 'Implement the split ledger entries', phase: 'Build', type: 'workflow-subagent', running: true, smoking: false, leisure: null, call: null },
      { agentId: 'wf-agent-2', label: 'Implement the refund path', phase: 'Build', type: 'workflow-subagent', running: true, smoking: false, leisure: null, call: null },
      { agentId: 'wf-agent-0', label: 'Map the split payment flow', phase: 'Plan', type: 'workflow-subagent', running: false, smoking: false, leisure: null, call: null },
    ],
    look: { body: host.robot!.body, tie: host.robot!.tie },
    rect: floor.roomSlots[0]!,
    slot: 0,
  };
  return { ...floor, rooms: [room] };
}
