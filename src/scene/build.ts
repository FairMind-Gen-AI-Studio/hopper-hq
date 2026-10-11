/**
 * Session views -> the scene model the browser draws (types.ts). Server-only: it builds on core/view.ts.
 * Pure and deterministic: the same views in any order give the same scene, down to its JSON text. Every string is cleaned.
 */
import { buildFloors, byCodeUnit, floorKeyOf, islandKeyOf, type Floor, type SessionView } from '../core/view.js';
import { layoutFloor } from './layout.js';
import { FEATURE_SLOTS, REPO_SLOTS, slotOf } from './palette.js';
import { cleanOrNull, cleanText, KEY_MAX, taskTitle } from './text.js';
import {
  SCENE_VERSION,
  type AttentionEntry,
  type Badge,
  type BuildingScene,
  type Desk,
  type DeskActivity,
  type FacadeWindow,
  type FloorDetail,
  type FloorSummary,
  type Island,
  type Pose,
  type Robot,
  type SceneReason,
  type ShownState,
} from './types.js';

/** M2 robots are static: the state shows as a pose and a badge at the desk. Dormant sessions have gone home. */
const ROBOT: Record<ShownState, { pose: Pose; badge: Badge | null } | null> = {
  working: { pose: 'typing', badge: 'typing' },
  needs_you: { pose: 'waving', badge: 'needs' },
  done: { pose: 'holding', badge: 'done' },
  in_meeting: { pose: 'still', badge: 'meeting' },
  no_signal: { pose: 'still', badge: 'clock' },
  idle: { pose: 'resting', badge: null },
  dormant: null,
};

/** Count keys follow this order, whatever the order of the desks. */
const SHOWN_STATES = Object.keys(ROBOT) as ShownState[];

/** A tmux pane id, the only focus target tmux is given. */
const PANE = /^%\d+$/;

/** The reducer's name for a subagent it has seen act but not start: its type is unknown. */
const UNNAMED_AGENT = 'agent';

/** A session with its island, ready to become a desk. */
interface IslandGroup {
  key: string;
  repo: string;
  branch: string | null;
  worktree: boolean;
  path: string;
  /** Desks in order: by start time, then id. */
  views: SessionView[];
}

const idOf = (v: SessionView): string => cleanText(v.id, KEY_MAX);

/** Session name, or '<repo>-<first 4 characters of id>'. */
function nameOf(v: SessionView): string {
  return cleanOrNull(v.name) ?? cleanText(`${v.workspace.repoName}-${Array.from(cleanText(v.id)).slice(0, 4).join('')}`);
}

/** Focus reaches a local session through its tmux pane. */
function focusableOf(v: SessionView): boolean {
  return v.effectiveState !== 'ended' && v.location === 'local' && v.tmuxPane !== null && PANE.test(v.tmuxPane);
}

/** The wait of a session that needs the user. `agent` is the subagent that raised it, typed from the session's children. */
export function reasonOf(v: SessionView): SceneReason | null {
  if (v.effectiveState !== 'needs_you' || !v.waitReason) return null;
  const agentId = v.waitAgentId;
  const child = agentId ? v.children.find((c) => c.id === agentId) : undefined;
  return {
    kind: v.waitReason.kind,
    text: cleanText(v.waitReason.text),
    detail: cleanOrNull(v.waitReason.detail),
    agent: agentId ? { id: cleanText(agentId, KEY_MAX), type: child && child.type !== UNNAMED_AGENT ? cleanOrNull(child.type) : null } : null,
  };
}

/** The tool still running, else the last action. */
function activityOf(v: SessionView): DeskActivity | null {
  const running = v.openTool && cleanOrNull(v.openTool.label);
  if (v.openTool && running) return { label: running, since: v.openTool.startedAt, running: true };
  const last = cleanOrNull(v.lastAction);
  return last ? { label: last, since: v.lastActionAt ?? v.stateSince, running: false } : null;
}

function robotOf(state: ShownState, repo: string, feature: string | null): Robot | null {
  const look = ROBOT[state];
  if (!look) return null;
  return { pose: look.pose, badge: look.badge, body: slotOf(repo, REPO_SLOTS), tie: feature === null ? null : slotOf(feature, FEATURE_SLOTS) };
}

/** One island per checkout, ordered by repo, branch and key: stable while sessions come and go. */
function islandsOf(floor: Floor): IslandGroup[] {
  const byKey = new Map<string, SessionView[]>();
  for (const v of floor.sessions) {
    const key = islandKeyOf(v);
    const list = byKey.get(key);
    if (list) list.push(v);
    else byKey.set(key, [v]);
  }
  const groups = [...byKey].map(([key, views]): IslandGroup => {
    views.sort((a, b) => a.startedAt - b.startedAt || byCodeUnit(a.id, b.id));
    const ws = views[0]!.workspace;
    return { key, repo: cleanText(ws.repoName), branch: cleanOrNull(ws.branch), worktree: ws.worktree, path: cleanText(ws.root ?? ws.cwd), views };
  });
  return groups.sort((a, b) => byCodeUnit(a.repo, b.repo) || byCodeUnit(a.branch ?? '', b.branch ?? '') || byCodeUnit(a.key, b.key));
}

function summaryOf(floor: Floor, number: number, islands: IslandGroup[]): FloorSummary {
  const windows: FacadeWindow[] = islands.flatMap((i) => i.views.map((v) => ({ sessionId: idOf(v), state: v.effectiveState as ShownState })));
  const counts: Partial<Record<ShownState, number>> = {};
  for (const state of SHOWN_STATES) {
    const n = windows.filter((w) => w.state === state).length;
    if (n > 0) counts[state] = n;
  }
  return {
    key: floor.key,
    number,
    kind: floor.kind,
    name: cleanText(floor.name),
    repos: [...new Set(floor.repos.map((r) => cleanText(r)))].sort(byCodeUnit),
    windows,
    counts,
    shutters: floor.dormant,
    openedAt: floor.openedAt,
  };
}

function deskOf(v: SessionView, rect: Desk['rect'], repo: string): Desk {
  const state = v.effectiveState as ShownState;
  return {
    sessionId: idOf(v),
    rect,
    name: nameOf(v),
    title: taskTitle(v),
    state,
    since: v.effectiveSince,
    reason: reasonOf(v),
    activity: activityOf(v),
    agentsRunning: v.children.filter((c) => c.running).length,
    location: v.location,
    pane: cleanOrNull(v.tmuxPane),
    focusable: focusableOf(v),
    robot: robotOf(state, repo, v.feature),
  };
}

function detailOf(floor: Floor, number: number, groups: IslandGroup[]): FloorDetail {
  const layout = layoutFloor(groups.map((g) => ({ key: g.key, deskIds: g.views.map((v) => v.id) })));
  const { windows: _windows, ...summary } = summaryOf(floor, number, groups);
  const islands = groups.map((g, i): Island => {
    const placed = layout.islands[i]!;
    return {
      key: g.key,
      repo: g.repo,
      branch: g.branch,
      worktree: g.worktree,
      path: g.path,
      color: slotOf(g.repo, REPO_SLOTS),
      rect: placed.rect,
      desks: g.views.map((v, k) => deskOf(v, placed.desks[k]!.rect, g.repo)),
    };
  });
  return { version: SCENE_VERSION, ...summary, size: layout.size, core: layout.core, islands };
}

function entryOf(v: SessionView, state: AttentionEntry['state']): AttentionEntry {
  return {
    sessionId: idOf(v),
    floorKey: floorKeyOf(v),
    name: nameOf(v),
    repo: cleanText(v.workspace.repoName),
    state,
    since: v.effectiveSince,
    reason: reasonOf(v),
    title: taskTitle(v),
    focusable: focusableOf(v),
  };
}

/** Longest wait first (needs you) and oldest first (done): both by `since`, then by id. */
function attentionOf(views: readonly SessionView[], state: AttentionEntry['state']): AttentionEntry[] {
  return views
    .filter((v) => v.effectiveState === state)
    .sort((a, b) => a.effectiveSince - b.effectiveSince || byCodeUnit(a.id, b.id))
    .map((v) => entryOf(v, state));
}

/** The building every client sees: floors top to bottom, and the attention queue. */
export function buildScene(views: readonly SessionView[], firstSeen?: ReadonlyMap<string, number>): BuildingScene {
  const floors = buildFloors(views, firstSeen);
  return {
    version: SCENE_VERSION,
    floors: floors.map((f, i) => summaryOf(f, floors.length - i, islandsOf(f))),
    attention: { needsYou: attentionOf(views, 'needs_you'), done: attentionOf(views, 'done') },
  };
}

/** One floor in detail: its islands and desks laid out on the grid. Null when no live session is on it. */
export function buildFloorDetail(views: readonly SessionView[], key: string, firstSeen?: ReadonlyMap<string, number>): FloorDetail | null {
  const floors = buildFloors(views, firstSeen);
  const i = floors.findIndex((f) => f.key === key);
  const floor = floors[i];
  return floor ? detailOf(floor, floors.length - i, islandsOf(floor)) : null;
}
