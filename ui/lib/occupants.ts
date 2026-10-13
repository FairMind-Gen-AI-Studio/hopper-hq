/** A floor's sessions, for its panels and its routes. */
import type { FloorDetail, Occupant } from '../../src/scene/types';

/** The floor's sessions: those at the desks of its pods, in pod and desk order, then those waiting for a desk. */
export function occupantsOf(floor: Pick<FloorDetail, 'pods' | 'unseated'>): Occupant[] {
  return [...floor.pods.flatMap((p) => p.desks.flatMap((d) => (d.occupant ? [d.occupant] : []))), ...floor.unseated];
}
