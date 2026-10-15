import { DEFAULT_LEISURE_WINDOW, type LeisureWindow } from '../config.js';
import { byCodeUnit } from './view.js';

/**
 * Whether `now` falls inside `window`, as told by `hourOf` (viewer-local by default, since
 * hopper-hq is local-first). `hourOf` is the only clock this module reads — tests MUST inject
 * it explicitly so they stay timezone-independent. A window where `toHour <= fromHour` wraps
 * past midnight (e.g. the office's own 17:00 -> 02:00).
 */
export function inLeisureWindow(
  now: number,
  window: LeisureWindow = DEFAULT_LEISURE_WINDOW,
  hourOf: (now: number) => number = (n) => new Date(n).getHours(),
): boolean {
  const hour = hourOf(now);
  const { fromHour, toHour } = window;
  if (toHour <= fromHour) return hour >= fromHour || hour < toHour;
  return hour >= fromHour && hour < toHour;
}

/** The ids of the finished agents in `agents`, when at least one sibling is still running. Pure. */
export function waitingSubagents<T extends { id: string; running: boolean }>(agents: readonly T[]): string[] {
  if (!agents.some((a) => a.running)) return [];
  return agents.filter((a) => !a.running).map((a) => a.id);
}

export type Leisure = 'gintonic' | 'biliardino' | 'coffee';

/**
 * What each waiting sub-agent does. Outside the window every waiter gets a `coffee` break
 * (OQ-3). Inside the window, ids are sorted by code unit and paired off for `biliardino`
 * (table football needs two players); a lone leftover nurses a `gintonic`.
 */
export function assignLeisure(waitingIds: readonly string[], inWindow: boolean): Map<string, Leisure> {
  const out = new Map<string, Leisure>();
  if (!inWindow) {
    for (const id of waitingIds) out.set(id, 'coffee');
    return out;
  }
  const sorted = [...waitingIds].sort(byCodeUnit);
  let i = 0;
  for (; i + 1 < sorted.length; i += 2) {
    out.set(sorted[i]!, 'biliardino');
    out.set(sorted[i + 1]!, 'biliardino');
  }
  if (i < sorted.length) out.set(sorted[i]!, 'gintonic');
  return out;
}

/** Convenience: what every waiting sub-agent in `agents` is doing right now. */
export function leisureOf<T extends { id: string; running: boolean }>(
  now: number,
  agents: readonly T[],
  window: LeisureWindow = DEFAULT_LEISURE_WINDOW,
  hourOf?: (now: number) => number,
): Map<string, Leisure> {
  return assignLeisure(waitingSubagents(agents), inLeisureWindow(now, window, hourOf));
}
