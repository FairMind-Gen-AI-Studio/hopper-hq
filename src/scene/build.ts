/**
 * Session views -> the scene model the browser draws (types.ts). Server-only: it builds on core/view.ts.
 * Pure and deterministic: the same views in any order give the same scene, down to its JSON text. Every string is cleaned.
 */
import type { WorkflowRun } from '../core/types.js';
import { assignLeisure, waitingSubagents } from '../core/leisure.js';
import { liveRun } from '../core/reducer.js';
import { buildFloors, byCodeUnit, floorKeyOf, islandKeyOf, repoLabels, repoRootOf, type Floor, type SessionView } from '../core/view.js';
import { INTERNS_MAX, layoutPlan, LOUNGE_SEATS, MEETING_AGENTS_MAX, POD_DESKS, RUNS_SHOWN, UNSEATED_MAX } from './layout.js';
import { FEATURE_SLOTS, REPO_SLOTS, slotOf } from './palette.js';
import { CREW_PREFIX, roomRunsOf, seatFloor, type RoomRun, type Seating } from './seating.js';
import { capKey, cleanOrNull, cleanText, KEY_MAX, taskTitle } from './text.js';
import {
  SCENE_VERSION,
  type AttentionEntry,
  type Badge,
  type BuildingScene,
  type Checkout,
  type DeskActivity,
  type DeskSummary,
  type FacadeWindow,
  type FloorDetail,
  type FloorSummary,
  type GridRect,
  type Intern,
  type MeetingAgent,
  type MeetingRoom,
  type Occupant,
  type PhaseState,
  type Place,
  type Pod,
  type PodDesk,
  type Pose,
  type Robot,
  type RunSummary,
  type SceneLeisure,
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

const idOf = (v: SessionView): string => cleanText(v.id, KEY_MAX);

/** An agent's type as the scene shows it: null when the reducer did not learn it. */
const typeOf = (type: string): string | null => (type === UNNAMED_AGENT ? null : cleanOrNull(type));

/** The items whose capped ids come first: two ids that clean to one name one agent, the first. */
function firstOfEach<T>(items: T[], id: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = capKey(id(item));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Start order, then id: how running runs and rooms line up. */
const byStart = (a: WorkflowRun, b: WorkflowRun): number => a.startedAt - b.startedAt || byCodeUnit(a.id, b.id);

/** Start order, then id: how sessions line up. */
const bySessionStart = (a: SessionView, b: SessionView): number => a.startedAt - b.startedAt || byCodeUnit(a.id, b.id);

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
    agent: agentId ? { id: capKey(agentId), type: agent ? typeOf(agent.type) : null } : null,
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
 * finished ones, the latest to finish first; one per id once cleaned; at most INTERNS_MAX, and how many more there are.
 */
function internsOf(v: SessionView, inRoom: boolean, leisureOpen: boolean): { interns: Intern[]; internsMore: number } {
  const finished = v.children
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => !c.running)
    .sort((a, b) => b.c.updatedAt - a.c.updatedAt || b.i - a.i)
    .map(({ c }) => c);
  const all = firstOfEach([...v.children.filter((c) => c.running), ...finished], (c) => c.id);
  const shown = all.slice(0, INTERNS_MAX);
  const leisure = leisureMapOf(v.children, leisureOpen);
  return {
    interns: shown.map((c) => ({
      agentId: capKey(c.id),
      type: typeOf(c.type),
      label: cleanOrNull(c.description),
      running: c.running,
      inRoom: inRoom && c.running,
      smoking: c.running && c.smoking === true,
      leisure: leisure.get(c.id) ?? null,
    })),
    internsMore: all.length - shown.length,
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
    runId: capKey(r.id),
    name: cleanOrNull(r.name, RUN_NAME_MAX),
    status: r.status,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    counts: countsOf(r),
  }));
}

/**
 * The whiteboard: phases before the current one are done, and those after it upcoming; a title the list repeats is
 * current where it comes last. With no current phase, or one that is not in the list, every phase is upcoming. A run
 * whose phases are unknown shows its current phase alone.
 */
function phasesOf(r: WorkflowRun): MeetingRoom['phases'] {
  const at = r.currentPhase === null ? -1 : r.phases.lastIndexOf(r.currentPhase);
  const phases: { title: string; state: PhaseState }[] =
    r.phases.length === 0 && r.currentPhase !== null
      ? [{ title: r.currentPhase, state: 'current' }]
      : r.phases.map((title, i) => ({ title, state: at === -1 || i > at ? 'upcoming' : i === at ? 'current' : 'done' }));
  return phases.map((p) => ({ title: cleanText(p.title, PHASE_MAX), state: p.state })).filter((p) => p.title !== '');
}

/** Running agents first, in start order, then finished ones, the latest to finish first; one per id once cleaned; at most MEETING_AGENTS_MAX. */
function meetingAgentsOf(r: WorkflowRun, leisureOpen: boolean): MeetingAgent[] {
  const running = r.agents.filter((a) => a.running).sort((a, b) => a.startedAt - b.startedAt || byCodeUnit(a.id, b.id));
  const finished = r.agents.filter((a) => !a.running).sort((a, b) => b.updatedAt - a.updatedAt || b.startedAt - a.startedAt || byCodeUnit(a.id, b.id));
  const leisure = leisureMapOf(r.agents, leisureOpen);
  return firstOfEach([...running, ...finished], (a) => a.id).slice(0, MEETING_AGENTS_MAX).map((a) => ({
    agentId: capKey(a.id),
    label: cleanOrNull(a.label),
    phase: cleanOrNull(a.phase, PHASE_MAX),
    type: typeOf(a.type),
    running: a.running,
    smoking: a.running && a.smoking === true,
    leisure: leisure.get(a.id) ?? null,
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

/** A session smokes only while its own tool is actually open (working or no_signal) and that tool is a smoke test. */
function smokingOf(v: SessionView): boolean {
  const open = v.effectiveState === 'working' || v.effectiveState === 'no_signal' ? v.openTool : null;
  return open?.smoking === true;
}

/** The leisure of every waiting sub-agent among `agents`: coffee outside the window, else paired biliardino or a lone gintonic. */
function leisureMapOf(agents: readonly { id: string; running: boolean }[], leisureOpen: boolean): Map<string, SceneLeisure> {
  return assignLeisure(waitingSubagents(agents), leisureOpen);
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

/**
 * A floor as the façade and the directory show it: one window per desk of its plan, in desk index order, carrying the
 * state of whoever sits there (dark for a free desk), and the count of its sessions by state, those without a desk too.
 * A session listed at two desks sits at its first only, as on the floor.
 */
function summaryOf(floor: Floor, number: number, seating: Seating): FloorSummary {
  const on = new Map(floor.sessions.map((v) => [v.id, v]));
  const lit = new Set<string>();
  const windows = seating.desks.map((id): FacadeWindow => {
    const v = id === null || lit.has(id) ? undefined : on.get(id);
    if (!v) return { sessionId: null, state: null };
    lit.add(v.id);
    return { sessionId: idOf(v), state: v.effectiveState as ShownState };
  });
  const counts: Partial<Record<ShownState, number>> = {};
  for (const state of SHOWN_STATES) {
    const n = floor.sessions.filter((v) => v.effectiveState === state).length;
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

/**
 * The checkout a session works in: its repository's label, branch, worktree flag and root (cwd outside git), the root as
 * a key (capKey), so that two checkouts have two paths however long their roots, as they have two pods.
 */
function checkoutOf(v: SessionView, label: (v: SessionView) => string): Checkout {
  const ws = v.workspace;
  return { repo: cleanText(label(v)), branch: cleanOrNull(ws.branch), worktree: ws.worktree, path: capKey(ws.root ?? ws.cwd) };
}

/** A session on the floor, its robot at `at`, in its own repository's and feature's colours. */
function occupantOf(v: SessionView, label: (v: SessionView) => string, at: Place, crewSeated = false, leisureOpen = false): Occupant {
  const state = v.effectiveState as ShownState;
  return {
    sessionId: idOf(v),
    name: nameOf(v),
    title: taskTitle(v),
    state,
    since: v.effectiveSince,
    reason: reasonOf(v),
    activity: activityOf(v),
    smoking: smokingOf(v),
    agentsRunning: v.children.filter((c) => c.running).length + v.runs.reduce((n, r) => n + countsOf(r).running, 0),
    summary: deskSummaryOf(v),
    ...internsOf(v, crewSeated, leisureOpen),
    runs: runsOf(v),
    location: v.location,
    pane: cleanOrNull(v.tmuxPane),
    focusable: focusableOf(v),
    robot: robotOf(state, repoRootOf(v), v.feature),
    at,
    checkout: checkoutOf(v, label),
  };
}

/**
 * A pod's rug colour and placard, from the sessions at its desks: the checkout of the newest while they all share one;
 * the repository alone while they share only that; neither otherwise, or when the pod is empty.
 */
function podLook(views: SessionView[], label: (v: SessionView) => string): Pick<Pod, 'color' | 'placard'> {
  const newest = [...views].sort(bySessionStart).at(-1);
  if (!newest) return { color: null, placard: null };
  const root = repoRootOf(newest);
  const color = slotOf(root, REPO_SLOTS);
  if (views.every((v) => islandKeyOf(v) === islandKeyOf(newest))) return { color, placard: checkoutOf(newest, label) };
  if (views.every((v) => repoRootOf(v) === root)) return { color, placard: { repo: cleanText(label(newest)), branch: null, worktree: false, path: null } };
  return { color: null, placard: null };
}

/** The room of a live run in its slot. */
function roomOf({ run, host, crew }: RoomRun, slot: number, rect: GridRect, leisureOpen: boolean): MeetingRoom {
  return {
    kind: crew ? 'crew' : 'workflow',
    runId: capKey(run.id),
    hostSessionId: idOf(host),
    name: cleanOrNull(run.name, RUN_NAME_MAX),
    summary: cleanOrNull(run.summary),
    phases: phasesOf(run),
    counts: countsOf(run),
    agents: meetingAgentsOf(run, leisureOpen),
    look: lookOf(repoRootOf(host), host.feature),
    rect,
    slot,
  };
}

/**
 * One floor on its plan, filled from its seating: every desk of every pod with its occupant, the lounge, every room slot,
 * a room for each live run that holds a slot (in slot order), and the sessions without a desk, the first UNSEATED_MAX
 * of them in start order, counting the rest. Each occupant's `at` is,
 * first match: gone when it has no desk or is dormant; the head of its first room that holds a slot while it is
 * working, has no signal or is in_meeting (a room is a workflow run's, or the crew of its running subagents); its lounge
 * seat; its desk. The crew's subagents show as interns over the desk only while the crew has no room. The floor counts
 * the live runs and crews without a room, every host's: a run two hosts name counts twice.
 */
function detailOf(floor: Floor, number: number, label: (v: SessionView) => string, seating: Seating, leisureOpen: boolean): FloorDetail {
  const plan = layoutPlan(seating);
  const on = new Map(floor.sessions.map((v) => [v.id, v]));
  const runs = roomRunsOf(floor);
  const slotOfKey = (key: string): number => {
    const slot = seating.rooms.indexOf(key);
    return slot < plan.rooms.length ? slot : -1;
  };
  const placeOf = (v: SessionView): Place => {
    if (v.effectiveState === 'dormant') return { kind: 'gone' };
    if (v.effectiveState === 'in_meeting' || v.effectiveState === 'working' || v.effectiveState === 'no_signal') {
      const slot = runs.filter((r) => r.host.id === v.id).map((r) => slotOfKey(r.key)).find((s) => s !== -1);
      if (slot !== undefined) return { kind: 'room', slot };
    }
    const seat = seating.lounge.indexOf(v.id);
    return seat === -1 ? { kind: 'desk' } : { kind: 'lounge', seat };
  };

  const seated = new Map<string, Occupant>();
  const sitting = plan.pods.map((p, i) =>
    p.desks.map((_, n) => {
      const v = on.get(seating.desks[i * POD_DESKS + n] ?? '');
      if (!v || seated.has(v.id)) return null;
      seated.set(v.id, occupantOf(v, label, placeOf(v), slotOfKey(capKey(CREW_PREFIX + v.id)) !== -1, leisureOpen));
      return v;
    }),
  );
  const pods = plan.pods.map((p, i): Pod => {
    const views = sitting[i]!.filter((v): v is SessionView => v !== null);
    return {
      id: p.id,
      rect: p.rect,
      ...podLook(views, label),
      desks: p.desks.map((d, n): PodDesk => {
        const v = sitting[i]![n];
        return { ...d, occupant: v ? seated.get(v.id)! : null };
      }),
    };
  });
  const waiting = floor.sessions.filter((v) => !seated.has(v.id)).sort(bySessionStart);
  const unseated = waiting.slice(0, UNSEATED_MAX).map((v) => occupantOf(v, label, { kind: 'gone' }, false, leisureOpen));
  const rooms = runs
    .map((r) => ({ r, slot: slotOfKey(r.key) }))
    .filter(({ slot }) => slot !== -1)
    .sort((a, b) => a.slot - b.slot)
    .map(({ r, slot }) => roomOf(r, slot, plan.rooms[slot]!, leisureOpen));
  const liveRuns = floor.sessions.reduce((n, v) => n + v.runs.filter(liveRun).length + (v.children.some((c) => c.running) ? 1 : 0), 0);

  const { windows: _windows, ...summary } = summaryOf(floor, number, seating);
  return {
    version: SCENE_VERSION,
    ...summary,
    size: plan.size,
    core: plan.core,
    pods,
    lounge: { rect: plan.lounge, seats: LOUNGE_SEATS },
    roomSlots: plan.rooms,
    breakArea: plan.breakArea,
    rooms,
    roomsMore: liveRuns - rooms.length,
    unseated,
    unseatedMore: waiting.length - unseated.length,
  };
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

/**
 * The building every client sees: floors top to bottom, each from its seating in `seating` (a floor with none there is
 * seated from scratch), and the attention queue.
 */
export function buildScene(views: readonly SessionView[], firstSeen?: ReadonlyMap<string, number>, seating?: ReadonlyMap<string, Seating>): BuildingScene {
  const floors = buildFloors(views, firstSeen);
  return {
    version: SCENE_VERSION,
    floors: floors.map((f, i) => summaryOf(f, floors.length - i, seating?.get(f.key) ?? seatFloor(null, f))),
    attention: { needsYou: attentionOf(views, 'needs_you'), done: attentionOf(views, 'done') },
  };
}

/**
 * One floor in detail: its plan, filled from its seating in `seating` (a floor with none there is seated from scratch).
 * Null when no live session is on it. `leisureOpen` gates whether a waiting sub-agent (intern or meeting agent) is shown
 * at the bar/biliardino (true) or on a coffee break (false, the default): the caller reads `now` (see collector.ts,
 * via `inLeisureWindow`) and passes the result in, keeping this function itself clock-free and deterministic.
 */
export function buildFloorDetail(
  views: readonly SessionView[],
  key: string,
  firstSeen?: ReadonlyMap<string, number>,
  seating?: ReadonlyMap<string, Seating>,
  leisureOpen = false,
): FloorDetail | null {
  const floors = buildFloors(views, firstSeen);
  const i = floors.findIndex((f) => f.key === key);
  const floor = floors[i];
  if (!floor) return null;
  return detailOf(floor, floors.length - i, repoLabels(views), seating?.get(key) ?? seatFloor(null, floor), leisureOpen);
}
