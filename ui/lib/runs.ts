/** Finding a workflow run on a floor, for its panel and its breadcrumb. */
import type { FloorDetail, MeetingRoom, Occupant, RunSummary } from '../../src/scene/types';
import { occupantsOf } from './occupants';

export interface FoundRun {
  /** Its meeting room while it has one. */
  room: MeetingRoom | null;
  /** Its line in the host's runs; null when the host does not list it. */
  run: RunSummary | null;
  /** The host session: at a desk, or waiting for one. */
  host: Occupant;
}

/**
 * A run by its id: in its room, else in the runs of a session on the floor, at a desk or waiting for one. Two sessions may
 * name one run id: the first room, in room order, wins, else the first session, in floor order. Null when nothing on the
 * floor names the run, or its room's host is not on the floor.
 */
export function findRun(floor: Pick<FloorDetail, 'pods' | 'unseated' | 'rooms'>, runId: string): FoundRun | null {
  const room = floor.rooms.find((r) => r.runId === runId) ?? null;
  for (const host of occupantsOf(floor)) {
    const run = host.runs.find((r) => r.runId === runId) ?? null;
    if (room ? host.sessionId === room.hostSessionId : run) return { room, run, host };
  }
  return null;
}

/** What to call a run: its name from the room or the host's runs, else its id. */
export function runName(found: FoundRun, runId: string): string {
  return found.room?.name ?? found.run?.name ?? runId;
}
