/**
 * Pods for UI and renderer tests, filled the way a fresh floor fills them when each checkout keeps to itself: every group
 * takes the next pods of its own, its occupants at consecutive desks, POD_DESKS to a pod. The plan grows by a block for
 * every two pods it needs, up to BLOCKS_MAX.
 */
import { BLOCKS_MAX, POD_DESKS, layoutPlan, type PlanLayout } from '../../../src/scene/layout';
import type { Occupant, Pod, PodPlacard } from '../../../src/scene/types';

export interface PodGroup {
  /** The rug colour and the placard of the pods it holds. */
  color: number | null;
  placard: PodPlacard | null;
  occupants: Occupant[];
}

export function podsFor(groups: readonly PodGroup[], roomCols = 1): { plan: PlanLayout; pods: Pod[] } {
  const chunks = groups.flatMap((g) =>
    Array.from({ length: Math.ceil(g.occupants.length / POD_DESKS) }, (_, k) => ({ g, occupants: g.occupants.slice(k * POD_DESKS, (k + 1) * POD_DESKS) })),
  );
  const plan = layoutPlan({ blocks: Math.min(BLOCKS_MAX, Math.max(1, Math.ceil(chunks.length / 2))), roomCols });
  const pods = plan.pods.map((p, i): Pod => {
    const chunk = chunks[i];
    return {
      id: p.id,
      rect: p.rect,
      color: chunk ? chunk.g.color : null,
      placard: chunk ? chunk.g.placard : null,
      desks: p.desks.map((d, n) => ({ ...d, occupant: chunk?.occupants[n] ?? null })),
    };
  });
  return { plan, pods };
}
