import { basename, dirname } from 'node:path';
import { DEFAULT_THRESHOLDS, type Thresholds } from '../config.js';
import { cleanText, KEY_MAX } from '../scene/text.js';
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
    const lastActivity = Math.max(s.lastEventAt, s.stateSince, ...s.children.map((c) => c.updatedAt));
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
  return cleanText(v.feature ? `feature:${v.feature}` : `repo:${v.workspace.repoRoot ?? v.workspace.cwd}`, KEY_MAX);
}

/** The island a session sits at: one per checkout, keyed by worktree root (cwd outside git, or when saved without a root). */
export function islandKeyOf(v: Pick<SessionView, 'workspace'>): string {
  return cleanText(v.workspace.root ?? v.workspace.cwd, KEY_MAX);
}

export interface Floor {
  key: string;
  kind: 'feature' | 'department';
  name: string;
  repos: string[];
  sessions: SessionView[];
  counts: Partial<Record<SessionState, number>>;
  /** Earliest session start on the floor; floors are ordered newest first by this. */
  openedAt: number;
  dormant: boolean;
}

export function buildFloors(views: readonly SessionView[]): Floor[] {
  const map = new Map<string, Floor>();
  const dirs = new Map<string, string>();
  for (const v of views) {
    if (v.effectiveState === 'ended') continue;
    const key = floorKeyOf(v);
    let f = map.get(key);
    if (!f) {
      f = { key, kind: v.feature ? 'feature' : 'department', name: v.feature ?? v.workspace.repoName, repos: [], sessions: [], counts: {}, openedAt: v.startedAt, dormant: true };
      map.set(key, f);
      dirs.set(key, v.workspace.repoRoot ?? v.workspace.cwd);
    }
    f.sessions.push(v);
    if (!f.repos.includes(v.workspace.repoName)) f.repos.push(v.workspace.repoName);
    f.counts[v.effectiveState] = (f.counts[v.effectiveState] ?? 0) + 1;
    f.openedAt = Math.min(f.openedAt, v.startedAt);
    if (v.effectiveState !== 'dormant') f.dormant = false;
  }
  const floors = [...map.values()];
  // Departments sharing a repo name are told apart by the directory their repos sit in: 'api (work)', 'api (oss)'.
  const named = new Map<string, number>();
  for (const f of floors) if (f.kind === 'department') named.set(f.name, (named.get(f.name) ?? 0) + 1);
  for (const f of floors) {
    if (f.kind !== 'department' || (named.get(f.name) ?? 0) < 2) continue;
    const parent = dirname(dirs.get(f.key) ?? '');
    f.name = `${f.name} (${basename(parent) || parent})`;
  }
  for (const f of floors) {
    f.repos.sort();
    f.sessions.sort((a, b) => a.workspace.repoName.localeCompare(b.workspace.repoName) || a.startedAt - b.startedAt);
  }
  return floors.sort((a, b) => b.openedAt - a.openedAt || a.key.localeCompare(b.key));
}

export interface Attention {
  needsYou: SessionView[];
  done: SessionView[];
}

export function buildAttention(views: SessionView[]): Attention {
  const pick = (st: SessionState) => views.filter((v) => v.effectiveState === st).sort((a, b) => a.effectiveSince - b.effectiveSince);
  return { needsYou: pick('needs_you'), done: pick('done') };
}
