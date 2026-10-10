import { DEFAULT_THRESHOLDS, type Thresholds } from '../config.js';
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

export function buildFloors(views: SessionView[]): Floor[] {
  const map = new Map<string, Floor>();
  for (const v of views) {
    if (v.effectiveState === 'ended') continue;
    const key = v.feature ? `feature:${v.feature}` : `repo:${v.workspace.repoName}`;
    let f = map.get(key);
    if (!f) {
      f = { key, kind: v.feature ? 'feature' : 'department', name: v.feature ?? v.workspace.repoName, repos: [], sessions: [], counts: {}, openedAt: v.startedAt, dormant: true };
      map.set(key, f);
    }
    f.sessions.push(v);
    if (!f.repos.includes(v.workspace.repoName)) f.repos.push(v.workspace.repoName);
    f.counts[v.effectiveState] = (f.counts[v.effectiveState] ?? 0) + 1;
    f.openedAt = Math.min(f.openedAt, v.startedAt);
    if (v.effectiveState !== 'dormant') f.dormant = false;
  }
  const floors = [...map.values()];
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
