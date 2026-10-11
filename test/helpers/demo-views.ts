import { demoScript } from '../../src/adapters/demo.js';
import { applyEvent } from '../../src/core/reducer.js';
import type { CollectorEvent, Session } from '../../src/core/types.js';
import { toView, type SessionView } from '../../src/core/view.js';

/** A fixed moment: the demo script starts at DEMO_BASE and is looked at 100 ms later. */
export const DEMO_BASE = Date.UTC(2026, 9, 11, 9, 0, 0);
export const DEMO_NOW = DEMO_BASE + 100;

/** The demo's opening step folded through the reducer, as the collector applies it, then viewed at DEMO_NOW. */
export function demoViews(): SessionView[] {
  const sessions = new Map<string, Session>();
  let seq = 0;
  for (const raw of demoScript()[0]!.events(DEMO_BASE)) {
    const e = { ...raw, seq: seq++ } as CollectorEvent;
    const next = applyEvent(sessions.get(e.sessionId), e);
    if (next) sessions.set(next.id, next);
  }
  return [...sessions.values()].map((s) => toView(s, DEMO_NOW));
}
