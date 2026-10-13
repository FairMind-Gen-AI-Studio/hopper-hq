/** Finding a workflow run on a floor, for its panel and its breadcrumb. */
import type { Desk, FloorDetail, Island, MeetingRoom, RunSummary } from '../../src/scene/types';

export interface FoundRun {
  /** Its meeting room while it has one. */
  room: MeetingRoom | null;
  /** Its line in the host desk's runs; null when the desk does not list it. */
  run: RunSummary | null;
  /** The host desk, and its island. */
  desk: Desk;
  island: Island;
}

/**
 * A run by its id: in its room, else in the runs of a desk on the floor. Two sessions may name one run id: the first
 * room, in room order, wins, else the first desk. Null when nothing on the floor names the run, or its room's host has
 * no desk here.
 */
export function findRun(floor: Pick<FloorDetail, 'islands' | 'rooms'>, runId: string): FoundRun | null {
  const room = floor.rooms.find((r) => r.runId === runId) ?? null;
  for (const island of floor.islands) {
    for (const desk of island.desks) {
      const run = desk.runs.find((r) => r.runId === runId) ?? null;
      if (room ? desk.sessionId === room.hostSessionId : run) return { room, run, desk, island };
    }
  }
  return null;
}

/** What to call a run: its name from the room or the desk, else its id. */
export function runName(found: FoundRun, runId: string): string {
  return found.room?.name ?? found.run?.name ?? runId;
}
