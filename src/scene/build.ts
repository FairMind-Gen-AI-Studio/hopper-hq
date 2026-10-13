/**
 * Session views -> the scene model the browser draws (types.ts). Server-only: it builds on core/view.ts.
 * Pure and deterministic: the same views in any order give the same scene, down to its JSON text. Every string is cleaned.
 */
import type { WorkflowRun } from '../core/types.js';
import { buildFloors, byCodeUnit, floorKeyOf, islandKeyOf, liveRun, repoLabels, repoRootOf, type Floor, type SessionView } from '../core/view.js';
import { INTERNS_MAX, layoutFloor, MEETING_AGENTS_MAX, ROOMS_MAX, RUNS_SHOWN } from './layout.js';
import { FEATURE_SLOTS, REPO_SLOTS, slotOf } from './palette.js';
import { cleanOrNull, cleanText, KEY_MAX, taskTitle } from './text.js';
import {
  SCENE_VERSION,
  type AttentionEntry,
  type Badge,
  type BuildingScene,
  type Desk,
  type DeskActivity,
  type DeskSummary,
  type FacadeWindow,
  type FloorDetail,
  type FloorSummary,
  type GridRect,
  type Intern,
  type Island,
  type MeetingAgent,
  type MeetingRoom,
  type PhaseState,
  type Pose,
  type Robot,
  type RunSummary,
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

/** The longest run name and phase title a script's meta gives (adapters/claude-code/script-meta.ts). */
const RUN_NAME_MAX = 120;
const PHASE_MAX = 80;

/** A session with its island, ready to become a desk. */
interface IslandGroup {
  key: string;
  /** The repository's label (see repoLabels). */
  repo: string;
  /** The repository's root: the key of its colour, the same on every floor. */
  root: string;
  branch: string | null;
  worktree: boolean;
  path: string;
  /** Desks in order: by start time, then id. The last, the newest, gives the island its repo, branch, worktree flag and path. */
  views: SessionView[];
}

const idOf = (v: SessionView): string => cleanText(v.id, KEY_MAX);

/** An agent's type as the scene shows it: null when the reducer did not learn it. */
const typeOf = (type: string): string | null => (type === UNNAMED_AGENT ? null : cleanOrNull(type));

/** Start order, then id: how running runs and rooms line up. */
const byStart = (a: WorkflowRun, b: WorkflowRun): number => a.startedAt - b.startedAt || byCodeUnit(a.id, b.id);

/** Session name, or '<repo>-<first 4 characters of id>'. */
function nameOf(v: SessionView): string {
  return cleanOrNull(v.name) ?? cleanText(`${v.workspace.repoName}-${Array.from(cleanText(v.id)).slice(0, 4).join('')}`);
}

/** Focus reaches a local session through its tmux pane. */
function focusableOf(v: SessionView): boolean {
  return v.effectiveState !== 'ended' && v.location === 'local' && v.tmuxPane !== null && PANE.test(v.tmuxPane);
}

/**
 * The wait of a session that needs the user. `agent` is the subagent that raised it, typed from the session's children,
 * else from the agents of its workflow runs.
 */
export function reasonOf(v: SessionView): SceneReason | null {
  if (v.effectiveState !== 'needs_you' || !v.waitReason) return null;
  const agentId = v.waitAgentId;
  const agent = agentId ? (v.children.find((c) => c.id === agentId) ?? v.runs.flatMap((r) => r.agents).find((a) => a.id === agentId)) : undefined;
  return {
    kind: v.waitReason.kind,
    text: cleanText(v.waitReason.text) || 'Needs you',
    detail: cleanOrNull(v.waitReason.detail),
    agent: agentId ? { id: cleanText(agentId, KEY_MAX), type: agent ? typeOf(agent.type) : null } : null,
  };
}

/** The session's status line; stale once a prompt came after it. Null when there is none, or nothing is left of it once cleaned. */
function deskSummaryOf(v: SessionView): DeskSummary | null {
  if (!v.summary) return null;
  const text = cleanOrNull(v.summary.text);
  return text ? { text, at: v.summary.at, stale: v.lastPromptAt !== null && v.lastPromptAt > v.summary.at } : null;
}

/**
 * The session's plain subagents: running ones in the order they started (the order the reducer first saw them), then
 * finished ones, the latest to finish first; at most INTERNS_MAX, and how many more there are.
 */
function internsOf(v: SessionView): { interns: Intern[]; internsMore: number } {
  const finished = v.children
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => !c.running)
    .sort((a, b) => b.c.updatedAt - a.c.updatedAt || b.i - a.i)
    .map(({ c }) => c);
  const shown = [...v.children.filter((c) => c.running), ...finished].slice(0, INTERNS_MAX);
  return {
    interns: shown.map((c) => ({ agentId: cleanText(c.id, KEY_MAX), type: typeOf(c.type), label: cleanOrNull(c.description), running: c.running })),
    internsMore: v.children.length - shown.length,
  };
}

function countsOf(r: WorkflowRun): { running: number; finished: number } {
  return { running: r.agents.filter((a) => a.running).length, finished: r.agentsFinished };
}

/**
 * The session's runs for its panel: the live ones by start, then the others, the latest to end first (a run that never
 * ended counts from its start); at most RUNS_SHOWN. A run keeps its own status.
 */
function runsOf(v: SessionView): RunSummary[] {
  const ended = (r: WorkflowRun) => r.endedAt ?? r.startedAt;
  const live = v.runs.filter(liveRun).sort(byStart);
  const rest = v.runs.filter((r) => !liveRun(r)).sort((a, b) => ended(b) - ended(a) || b.startedAt - a.startedAt || byCodeUnit(a.id, b.id));
  return [...live, ...rest].slice(0, RUNS_SHOWN).map((r) => ({
    runId: cleanText(r.id, KEY_MAX),
    name: cleanOrNull(r.name, RUN_NAME_MAX),
    status: r.status,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    counts: countsOf(r),
  }));
}

/**
 * The whiteboard: phases before the current one are done, and those after it upcoming. With no current phase, or one
 * that is not in the list, every phase is upcoming. A run whose phases are unknown shows its current phase alone.
 */
function phasesOf(r: WorkflowRun): MeetingRoom['phases'] {
  const at = r.currentPhase === null ? -1 : r.phases.indexOf(r.currentPhase);
  const phases: { title: string; state: PhaseState }[] =
    r.phases.length === 0 && r.currentPhase !== null
      ? [{ title: r.currentPhase, state: 'current' }]
      : r.phases.map((title, i) => ({ title, state: at === -1 || i > at ? 'upcoming' : i === at ? 'current' : 'done' }));
  return phases.map((p) => ({ title: cleanText(p.title, PHASE_MAX), state: p.state })).filter((p) => p.title !== '');
}

/** Running agents first, in start order, then finished ones, the latest to finish first; at most MEETING_AGENTS_MAX. */
function meetingAgentsOf(r: WorkflowRun): MeetingAgent[] {
  const running = r.agents.filter((a) => a.running).sort((a, b) => a.startedAt - b.startedAt || byCodeUnit(a.id, b.id));
  const finished = r.agents.filter((a) => !a.running).sort((a, b) => b.updatedAt - a.updatedAt || b.startedAt - a.startedAt || byCodeUnit(a.id, b.id));
  return [...running, ...finished].slice(0, MEETING_AGENTS_MAX).map((a) => ({
    agentId: cleanText(a.id, KEY_MAX),
    label: cleanOrNull(a.label),
    phase: cleanOrNull(a.phase, PHASE_MAX),
    type: typeOf(a.type),
    running: a.running,
  }));
}

/** The tool still running, else the last action. A session that needs you has not run its open tool yet: it waits for you. */
function activityOf(v: SessionView): DeskActivity | null {
  const open = v.effectiveState === 'working' || v.effectiveState === 'no_signal' ? v.openTool : null;
  const running = open && cleanOrNull(open.label);
  if (open && running) return { label: running, since: open.startedAt, running: true };
  const last = cleanOrNull(v.lastAction);
  return last ? { label: last, since: v.lastActionAt ?? v.stateSince, running: false } : null;
}

/** The colours of a session's robots: the body from its repository, the tie from its feature. */
function lookOf(root: string, feature: string | null): MeetingRoom['look'] {
  return { body: slotOf(root, REPO_SLOTS), tie: feature === null ? null : slotOf(feature, FEATURE_SLOTS) };
}

function robotOf(state: ShownState, root: string, feature: string | null): Robot | null {
  const look = ROBOT[state];
  if (!look) return null;
  return { pose: look.pose, badge: look.badge, ...lookOf(root, feature) };
}

/** One island per checkout, ordered by repo, branch and key: stable while sessions come and go. */
function islandsOf(floor: Floor, label: (v: SessionView) => string): IslandGroup[] {
  const byKey = new Map<string, SessionView[]>();
  for (const v of floor.sessions) {
    const key = islandKeyOf(v);
    const list = byKey.get(key);
    if (list) list.push(v);
    else byKey.set(key, [v]);
  }
  const groups = [...byKey].map(([key, views]): IslandGroup => {
    views.sort((a, b) => a.startedAt - b.startedAt || byCodeUnit(a.id, b.id));
    // The newest session says what the checkout is now: a branch switched since an older session started shows.
    const newest = views[views.length - 1]!;
    const ws = newest.workspace;
    return { key, repo: cleanText(label(newest)), root: repoRootOf(newest), branch: cleanOrNull(ws.branch), worktree: ws.worktree, path: cleanText(ws.root ?? ws.cwd), views };
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

function deskOf(v: SessionView, rect: Desk['rect'], root: string, away: boolean): Desk {
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
    agentsRunning: v.children.filter((c) => c.running).length + v.runs.reduce((n, r) => n + countsOf(r).running, 0),
    summary: deskSummaryOf(v),
    ...internsOf(v),
    away,
    runs: runsOf(v),
    location: v.location,
    pane: cleanOrNull(v.tmuxPane),
    focusable: focusableOf(v),
    robot: robotOf(state, root, v.feature),
  };
}

/** A live run of a session on the floor, ready to become a room. */
interface RoomRun {
  run: WorkflowRun;
  host: SessionView;
  /** The host's island's repository root: the colour key of its robots. */
  root: string;
}

/** The rooms of the floor's first live runs. An in_meeting host sits at the head of its first room; its other rooms keep a placard. */
function roomsOf(runs: RoomRun[], rects: { rect: GridRect }[]): MeetingRoom[] {
  const seated = new Set<string>();
  return runs.map(({ run, host, root }, i): MeetingRoom => {
    const head = host.effectiveState === 'in_meeting' && !seated.has(host.id);
    if (head) seated.add(host.id);
    return {
      runId: cleanText(run.id, KEY_MAX),
      hostSessionId: idOf(host),
      name: cleanOrNull(run.name, RUN_NAME_MAX),
      summary: cleanOrNull(run.summary),
      phases: phasesOf(run),
      counts: countsOf(run),
      agents: meetingAgentsOf(run),
      look: lookOf(root, host.feature),
      host: head ? robotOf('in_meeting', root, host.feature) : null,
      rect: rects[i]!.rect,
    };
  });
}

/**
 * One floor: its islands, and one room per live run of its sessions, by run start, then run id, then host id. The first
 * ROOMS_MAX runs get rooms, and the floor counts the rest. A host in_meeting with a room on the floor is away from its desk.
 */
function detailOf(floor: Floor, number: number, groups: IslandGroup[]): FloorDetail {
  const live = groups
    .flatMap((g) => g.views.flatMap((v) => v.runs.filter(liveRun).map((run): RoomRun => ({ run, host: v, root: g.root }))))
    .sort((a, b) => byStart(a.run, b.run) || byCodeUnit(a.host.id, b.host.id));
  const roomed = live.slice(0, ROOMS_MAX);
  const layout = layoutFloor(groups.map((g) => ({ key: g.key, deskIds: g.views.map((v) => v.id) })), roomed.map((r) => cleanText(r.run.id, KEY_MAX)));
  const rooms = roomsOf(roomed, layout.rooms);
  const away = new Set(roomed.filter((r) => r.host.effectiveState === 'in_meeting').map((r) => r.host.id));
  const { windows: _windows, ...summary } = summaryOf(floor, number, groups);
  const islands = groups.map((g, i): Island => {
    const placed = layout.islands[i]!;
    return {
      key: g.key,
      repo: g.repo,
      branch: g.branch,
      worktree: g.worktree,
      path: g.path,
      color: slotOf(g.root, REPO_SLOTS),
      rect: placed.rect,
      desks: g.views.map((v, k) => deskOf(v, placed.desks[k]!.rect, g.root, away.has(v.id))),
    };
  });
  return { version: SCENE_VERSION, ...summary, size: layout.size, core: layout.core, islands, rooms, roomsMore: live.length - roomed.length };
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
    summary: deskSummaryOf(v),
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
  const label = repoLabels(views);
  return {
    version: SCENE_VERSION,
    floors: floors.map((f, i) => summaryOf(f, floors.length - i, islandsOf(f, label))),
    attention: { needsYou: attentionOf(views, 'needs_you'), done: attentionOf(views, 'done') },
  };
}

/** One floor in detail: its islands and desks laid out on the grid. Null when no live session is on it. */
export function buildFloorDetail(views: readonly SessionView[], key: string, firstSeen?: ReadonlyMap<string, number>): FloorDetail | null {
  const floors = buildFloors(views, firstSeen);
  const i = floors.findIndex((f) => f.key === key);
  const floor = floors[i];
  return floor ? detailOf(floor, floors.length - i, islandsOf(floor, repoLabels(views))) : null;
}
