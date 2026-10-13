import { DEFAULT_THRESHOLDS, type Thresholds } from '../config.js';
import { capKey } from '../scene/text.js';
import { DEFAULT_FEATURE_RULES, deriveFeature, type FeatureRules } from './feature.js';
import type { Session, SessionState } from './types.js';

export interface SessionView extends Session {
  effectiveState: SessionState;
  effectiveSince: number;
  feature: string | null;
}

export function effectiveState(s: Session, now: number, t: Thresholds = DEFAULT_THRESHOLDS): { state: SessionState; since: number } {
  let state = s.state;
  let since = s.stateSince;

  if (state === 'done') {
    const seen = s.seenAt !== null && s.seenAt >= s.stateSince;
    if (seen) {
      state = 'idle';
      since = s.seenAt as number;
    } else if (now - s.stateSince >= t.doneToIdleMs) {
      state = 'idle';
      since = s.stateSince + t.doneToIdleMs;
    }
  }
  if (state === 'idle' && now - since >= t.idleToDormantMs) {
    state = 'dormant';
    since = since + t.idleToDormantMs;
  }
  if (state === 'working') {
    // A subagent's step, or a running workflow agent's, is a sign of life too.
    const runAgents = s.runs.flatMap((r) => r.agents.filter((a) => a.running).map((a) => a.updatedAt));
    const lastActivity = Math.max(s.lastEventAt, s.stateSince, ...s.children.map((c) => c.updatedAt), ...runAgents);
    if (now - lastActivity >= t.noSignalMs) {
      state = 'no_signal';
      since = lastActivity + t.noSignalMs;
    }
  }
  return { state, since };
}

export function toView(s: Session, now: number, t: Thresholds = DEFAULT_THRESHOLDS, rules: FeatureRules = DEFAULT_FEATURE_RULES): SessionView {
  const eff = effectiveState(s, now, t);
  return { ...s, effectiveState: eff.state, effectiveSince: eff.since, feature: deriveFeature(s.workspace.branch, s.workspace.repoName, rules) };
}

/** The floor a session works on: its feature, else its repository's department, keyed by repo root (cwd outside git). */
export function floorKeyOf(v: Pick<SessionView, 'feature' | 'workspace'>): string {
  return capKey(v.feature ? `feature:${v.feature}` : `repo:${repoRootOf(v)}`);
}

/** The island a session sits at: one per checkout, keyed by worktree root (cwd outside git, or when saved without a root). */
export function islandKeyOf(v: Pick<SessionView, 'workspace'>): string {
  return capKey(v.workspace.root ?? v.workspace.cwd);
}

/** The repository a session works in: its repo root, or its cwd outside git. Repo colours are keyed by it. */
export function repoRootOf(v: Pick<SessionView, 'workspace'>): string {
  return v.workspace.repoRoot ?? v.workspace.cwd;
}

/** A path's parent directories, outermost first: '/home/dev/work/api' gives ['home', 'dev', 'work']. */
function parentsOf(root: string): string[] {
  return root.split('/').filter(Boolean).slice(0, -1);
}

/**
 * How the building names each repository, from the live sessions (ended ones do not count). A repo name that no other
 * repository root shares stays bare. Repositories that share a name are told apart by the shortest run of trailing
 * parent directories that no other one ends with: 'api (work)' and 'api (oss)', or 'api (a/work)' and 'api (b/work)'.
 * One whose parent directories all end another's keeps its whole root: 'api (/a/api)' beside 'api (b/a)'.
 * The labels depend only on the set of repositories, so a repository has the same label on every floor.
 */
export function repoLabels(views: readonly SessionView[]): (v: Pick<SessionView, 'workspace'>) => string {
  const roots = new Map<string, Set<string>>();
  for (const v of views) {
    if (v.effectiveState === 'ended') continue;
    const name = v.workspace.repoName;
    const set = roots.get(name);
    if (set) set.add(repoRootOf(v));
    else roots.set(name, new Set([repoRootOf(v)]));
  }
  return (v) => {
    const name = v.workspace.repoName;
    const root = repoRootOf(v);
    const others = [...(roots.get(name) ?? [])].filter((r) => r !== root).map(parentsOf);
    if (others.length === 0) return name;
    const parents = parentsOf(root);
    for (let k = 1; k <= parents.length; k++) {
      const tail = parents.slice(-k).join('/');
      if (!others.some((o) => o.length >= k && o.slice(-k).join('/') === tail)) return `${name} (${tail})`;
    }
    return `${name} (${root})`;
  };
}

export interface Floor {
  key: string;
  kind: 'feature' | 'department';
  name: string;
  repos: string[];
  sessions: SessionView[];
  counts: Partial<Record<SessionState, number>>;
  /** When the floor key was first seen, else its earliest session start; floors are ordered newest first by this. */
  openedAt: number;
  dormant: boolean;
}

/** Plain UTF-16 code-unit order: the same on every machine, whatever its locale. */
export function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Floors, newest first. `firstSeen` holds each floor key's first-seen time, which keeps floors in place as sessions come and go. */
export function buildFloors(views: readonly SessionView[], firstSeen?: ReadonlyMap<string, number>): Floor[] {
  const label = repoLabels(views);
  const map = new Map<string, Floor>();
  for (const v of views) {
    if (v.effectiveState === 'ended') continue;
    const key = floorKeyOf(v);
    const repo = label(v);
    let f = map.get(key);
    if (!f) {
      f = { key, kind: v.feature ? 'feature' : 'department', name: v.feature ?? repo, repos: [], sessions: [], counts: {}, openedAt: v.startedAt, dormant: true };
      map.set(key, f);
    }
    f.sessions.push(v);
    if (!f.repos.includes(repo)) f.repos.push(repo);
    f.counts[v.effectiveState] = (f.counts[v.effectiveState] ?? 0) + 1;
    f.openedAt = Math.min(f.openedAt, v.startedAt);
    if (v.effectiveState !== 'dormant') f.dormant = false;
  }
  const floors = [...map.values()];
  for (const f of floors) {
    f.openedAt = firstSeen?.get(f.key) ?? f.openedAt;
    f.repos.sort();
    f.sessions.sort((a, b) => byCodeUnit(a.workspace.repoName, b.workspace.repoName) || a.startedAt - b.startedAt || byCodeUnit(a.id, b.id));
  }
  return floors.sort((a, b) => b.openedAt - a.openedAt || byCodeUnit(a.key, b.key));
}

export interface Attention {
  needsYou: SessionView[];
  done: SessionView[];
}

export function buildAttention(views: SessionView[]): Attention {
  const pick = (st: SessionState) => views.filter((v) => v.effectiveState === st).sort((a, b) => a.effectiveSince - b.effectiveSince);
  return { needsYou: pick('needs_you'), done: pick('done') };
}
