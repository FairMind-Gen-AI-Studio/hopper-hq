/** The UI's wording: one place for state names, their meaning, and plurals. */
import type { ShownState } from '../../src/scene/types';

export const STATES: Record<ShownState, { label: string; description: string }> = {
  needs_you: { label: 'Needs you', description: 'Blocked on a permission, a question or a plan approval.' },
  done: { label: 'Done, to review', description: 'Finished its turn and waits for you to look.' },
  working: { label: 'Working', description: 'Making progress right now.' },
  in_meeting: { label: 'In a meeting', description: 'Idle itself, but its subagents or workflow agents are still running.' },
  no_signal: { label: 'No signal', description: 'Working, but nothing new for a while. Often a long command.' },
  idle: { label: 'Idle', description: 'Reviewed, nothing to do.' },
  dormant: { label: 'Dormant', description: 'Idle for days: gone home. A floor where everyone is dormant lowers its shutters.' },
};

/** The legend's order: what needs you first. */
export const STATE_ORDER: readonly ShownState[] = ['needs_you', 'done', 'working', 'in_meeting', 'no_signal', 'idle', 'dormant'];

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
