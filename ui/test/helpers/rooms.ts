/**
 * A workflow run for UI tests: the fixtures' checkout floor with the payments desk (ps-d4) in a meeting, its run in a
 * room of the meeting wing, put together the way src/scene/build.ts does. Each call returns fresh objects.
 */
import { layoutFloor } from '../../../src/scene/layout';
import type { FloorDetail, MeetingRoom } from '../../../src/scene/types';
import { CHECKOUT, NOW, makeFloor } from './fixtures';

/** The run in the room. */
export const RUN = 'wf_0000aaaa-001';
/** An earlier run of the same desk, finished: it has no room. */
export const DONE_RUN = 'wf_0000aaaa-000';

const MIN = 60_000;

export function checkoutWithRoom(): FloorDetail {
  const floor = makeFloor(CHECKOUT)!;
  const layout = layoutFloor(
    floor.islands.map((i) => ({ key: i.key, deskIds: i.desks.map((d) => d.sessionId) })),
    [RUN],
  );
  const island = floor.islands.find((i) => i.repo === 'payments-svc')!;
  const desk = island.desks[0]!;
  desk.away = true;
  desk.runs = [
    { runId: RUN, name: 'checkout-verify', status: 'running', startedAt: NOW - 9 * MIN, endedAt: null, counts: { running: 2, finished: 1 } },
    { runId: DONE_RUN, name: 'nightly-smoke', status: 'completed', startedAt: NOW - 70 * MIN, endedAt: NOW - 62 * MIN, counts: { running: 0, finished: 4 } },
  ];
  const room: MeetingRoom = {
    runId: RUN,
    hostSessionId: desk.sessionId,
    name: 'checkout-verify',
    summary: 'Verify split payments end to end',
    phases: [
      { title: 'Plan', state: 'done' },
      { title: 'Build', state: 'current' },
      { title: 'Review', state: 'upcoming' },
      { title: 'Ship', state: 'upcoming' },
    ],
    counts: { running: 2, finished: 1 },
    agents: [
      { agentId: 'wf-agent-1', label: 'Implement the split ledger entries', phase: 'Build', type: 'workflow-subagent', running: true },
      { agentId: 'wf-agent-2', label: 'Implement the refund path', phase: 'Build', type: 'workflow-subagent', running: true },
      { agentId: 'wf-agent-0', label: 'Map the split payment flow', phase: 'Plan', type: 'workflow-subagent', running: false },
    ],
    look: { body: desk.robot!.body, tie: desk.robot!.tie },
    host: { ...desk.robot!, pose: 'still', badge: 'meeting' },
    rect: layout.rooms[0]!.rect,
  };
  return { ...floor, size: layout.size, rooms: [room] };
}
