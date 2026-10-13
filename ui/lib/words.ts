/** The UI's wording: one place for state names, their meaning, wait reasons, floor metadata and plurals. */
import type { RunStatus, WaitKind } from '../../src/core/types';
import { formatAgo, reasonText } from '../../src/scene/text';
import type { FloorSummary, PhaseState, RunSummary, SceneReason, ShownState } from '../../src/scene/types';

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

/** What follows a count of sessions waiting for you: '1 needs you', '2 need you'. */
export function needYou(n: number): string {
  return n === 1 ? 'needs you' : 'need you';
}

export const WAIT_KIND: Record<WaitKind, string> = { permission: 'Permission', question: 'Question', plan: 'Plan approval', input: 'Input' };

/** What a session waits for: 'Permission: Bash (rm -rf dist)'. 'Needs you' when the reason is unknown. */
export function waitText(reason: SceneReason | null): string {
  if (!reason) return reasonText(null);
  return `${WAIT_KIND[reason.kind]}: ${reasonText(reason)}`;
}

/** Which subagent raised the wait, when it was not the main agent: 'raised by Explore'. */
export function raisedBy(reason: SceneReason | null): string | null {
  if (!reason?.agent) return null;
  return `raised by ${reason.agent.type ?? 'a subagent'}`;
}

export interface Meta {
  text: string;
  /** Colours the counts that matter: needs you, done, in a meeting, no signal. */
  tone: 'needs' | 'done' | 'meeting' | 'nosignal' | null;
}

/** What a floor is ('2 repos · 4 sessions', 'Department · 5 sessions') and the counts worth a glance. */
export function floorMeta(f: FloorSummary): Meta[] {
  const sessions = plural(f.windows.length, 'session', 'sessions');
  const metas: Meta[] = [{ text: f.kind === 'department' ? `Department · ${sessions}` : `${plural(f.repos.length, 'repo', 'repos')} · ${sessions}`, tone: null }];
  if (f.shutters) metas.push({ text: 'shutters down', tone: null });
  const { needs_you: needs, done, in_meeting: meeting, no_signal: quiet } = f.counts;
  if (needs) metas.push({ text: `● ${needs} ${needYou(needs)}`, tone: 'needs' });
  if (done) metas.push({ text: `● ${done} done`, tone: 'done' });
  if (meeting) metas.push({ text: `● ${meeting} in a meeting`, tone: 'meeting' });
  if (quiet) metas.push({ text: `● ${quiet} no signal`, tone: 'nosignal' });
  return metas;
}

/** A floor for a screen reader, with every count its label shows: 'Floor 4, checkout-v2: 4 sessions, 1 needs you, 1 done'. */
export function floorLabel(f: FloorSummary): string {
  const parts = [plural(f.windows.length, 'session', 'sessions')];
  const { needs_you: needs, done, in_meeting: meeting, no_signal: quiet } = f.counts;
  if (needs) parts.push(`${needs} ${needYou(needs)}`);
  if (done) parts.push(`${done} done`);
  if (meeting) parts.push(`${meeting} in a meeting`);
  if (quiet) parts.push(`${quiet} no signal`);
  if (f.shutters) parts.push('shutters down');
  return `Floor ${f.number}, ${f.name}: ${parts.join(', ')}`;
}

/** A workflow run's status in words. A killed run was stopped: by the user, or when its session ended. */
export const RUN_STATUS: Record<RunStatus, string> = { running: 'Running', completed: 'Completed', failed: 'Failed', killed: 'Stopped' };

const SPAN: Record<Exclude<RunStatus, 'running'>, string> = { completed: 'Completed in', failed: 'Failed after', killed: 'Stopped after' };

/** How long a run has gone on, or went on: 'Running for 9m', 'Completed in 8m', 'Failed after 3m', 'Stopped after 1h'. */
export function runSpan(run: Pick<RunSummary, 'status' | 'startedAt' | 'endedAt'>, now: number): string {
  if (run.status === 'running') return `Running for ${formatAgo(now - run.startedAt)}`;
  if (run.endedAt === null) return RUN_STATUS[run.status];
  return `${SPAN[run.status]} ${formatAgo(run.endedAt - run.startedAt)}`;
}

/** A run's agents: '2 running · 5 done', as its room's board says. */
export function runCounts(counts: { running: number; finished: number }): string {
  return `${counts.running} running · ${counts.finished} done`;
}

/** A phase's mark, which the eye reads, and its word, which a screen reader says instead. */
export const PHASE: Record<PhaseState, { mark: string; word: string }> = {
  done: { mark: '✓', word: 'done' },
  current: { mark: '●', word: 'current' },
  upcoming: { mark: '○', word: 'upcoming' },
};
