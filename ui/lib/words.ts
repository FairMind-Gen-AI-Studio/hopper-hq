/** The UI's wording: one place for state names, their meaning, wait reasons, floor metadata and plurals. */
import type { RunStatus, WaitKind } from '../../src/core/types';
import { formatAgo, friendlyServer, reasonText } from '../../src/scene/text';
import type { ActiveLine, DeskSummary, FloorSummary, PhaseState, RunSummary, SceneReason, ShownState } from '../../src/scene/types';

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

/** How many sessions a floor has: at a desk or waiting for one. */
export function sessionsOf(f: Pick<FloorSummary, 'counts'>): number {
  return Object.values(f.counts).reduce((n, c) => n + (c ?? 0), 0);
}

/**
 * What a floor is: 'Department', or a feature floor's repositories by name, at most `names` of them, the rest counted:
 * 'code-ingestion', 'api, web', 'orders-api +2'.
 */
export function floorWhat(f: Pick<FloorSummary, 'kind' | 'repos'>, names = 2): string {
  if (f.kind === 'department') return 'Department';
  if (f.repos.length === 0) return 'Feature';
  if (f.repos.length <= names) return f.repos.join(', ');
  return `${f.repos.slice(0, names).join(', ')} +${f.repos.length - names}`;
}

/** What a floor is ('orders-api, payments-svc +1 · 4 sessions', 'Department · 5 sessions') and the counts worth a glance. */
export function floorMeta(f: FloorSummary): Meta[] {
  const sessions = plural(sessionsOf(f), 'session', 'sessions');
  const metas: Meta[] = [{ text: `${floorWhat(f)} · ${sessions}`, tone: null }];
  if (f.shutters) metas.push({ text: 'shutters down', tone: null });
  const { needs_you: needs, done, in_meeting: meeting, no_signal: quiet } = f.counts;
  if (needs) metas.push({ text: `● ${needs} ${needYou(needs)}`, tone: 'needs' });
  if (done) metas.push({ text: `● ${done} done`, tone: 'done' });
  if (meeting) metas.push({ text: `● ${meeting} in a meeting`, tone: 'meeting' });
  if (quiet) metas.push({ text: `● ${quiet} no signal`, tone: 'nosignal' });
  return metas;
}

/** A floor for a screen reader, with its repositories and every count its label shows: 'Floor 4, checkout-v2 (orders-api, web): 4 sessions, 1 needs you, 1 done'. */
export function floorLabel(f: FloorSummary): string {
  const parts = [plural(sessionsOf(f), 'session', 'sessions')];
  const { needs_you: needs, done, in_meeting: meeting, no_signal: quiet } = f.counts;
  if (needs) parts.push(`${needs} ${needYou(needs)}`);
  if (done) parts.push(`${done} done`);
  if (meeting) parts.push(`${meeting} in a meeting`);
  if (quiet) parts.push(`${quiet} no signal`);
  if (f.shutters) parts.push('shutters down');
  const repos = f.kind === 'feature' && f.repos.length > 0 ? ` (${f.repos.join(', ')})` : '';
  return `Floor ${f.number}, ${f.name}${repos}: ${parts.join(', ')}`;
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

/** A summary line's age, and in words whether a prompt came after it: '2m ago', '2m ago (older than the last prompt)'. */
export function summaryAge(summary: DeskSummary, now: number): string {
  return `${formatAgo(now - summary.at)} ago${summary.stale ? ' (older than the last prompt)' : ''}`;
}

/**
 * The façade's own brand spelling for the rooftop's Fairmind line (hq-mcp-switchboard Phase 4 — requirement 1):
 * distinct from `classifyMcp`'s internal canonical token (`'fairmind'`, lowercase, `ActiveLine.server`'s own value
 * for that line) and from the DOM chip's own 'Fairmind: …' casing (`labels.ts`'s `tagTitle`, which keeps whatever
 * case the real tool name happened to use) — this is the one place the rooftop itself names the brand to a
 * viewer, so it uses the brand's own spelling, exactly as the user feedback that asked for this feature wrote it.
 */
const FAIRMIND_BRAND = 'FairMind';

/**
 * An active line's own rooftop tag (Phase 4, requirement 1): the server's own readable name (or the brand, for
 * the Fairmind line, with its family after a middle dot — 'FairMind · Brain'), and a small live-caller count past
 * one ('Slack ×3'). `friendlyServer` (tool-label.ts, "friendly server names" follow-up) turns `ActiveLine.server`'s
 * own raw, canonical token ('Google_Calendar') into what a person reads ('Google Calendar') — `ActiveLine.server`
 * itself, and every lookup keyed by it (the glyph, the colour slot), stay untouched; only this display string
 * changes.
 */
export function antennaTag(line: Pick<ActiveLine, 'fairmind' | 'server' | 'family' | 'count'>): string {
  const name = line.fairmind ? FAIRMIND_BRAND : friendlyServer(line.server);
  const named = line.fairmind && line.family ? `${name} · ${line.family}` : name;
  return line.count > 1 ? `${named} ×${line.count}` : named;
}

/**
 * An active line's hover/focus tooltip (Phase 4, requirement 3): its server (with the Fairmind line's own family,
 * same as `antennaTag`), the tool it is calling, and which session or sub-agent is calling it — tool and names
 * only, never the call's own inputs (the façade's own form of tool-label.ts's privacy rule: `ActiveLine.tool` and
 * `.caller` are themselves never anything but a name, by construction of build.ts's `activeLinesOf`). A count past
 * one names only the busiest call on the line, the same first-tallied-wins limit `antennaTag` already accepts for
 * `server`/`family`.
 */
export function antennaTooltip(line: Pick<ActiveLine, 'fairmind' | 'server' | 'family' | 'tool' | 'caller' | 'count'>): string {
  const name = line.fairmind && line.family ? `${FAIRMIND_BRAND} · ${line.family}` : line.fairmind ? FAIRMIND_BRAND : friendlyServer(line.server);
  const bits = [name, line.tool, `called by ${line.caller}`];
  if (line.count > 1) bits.push(`+${line.count - 1} more call${line.count - 1 === 1 ? '' : 's'}`);
  return bits.join(' · ');
}
