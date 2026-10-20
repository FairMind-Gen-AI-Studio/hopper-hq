/**
 * Session views -> the scene model the browser draws (types.ts). Server-only: it builds on core/view.ts.
 * Pure and deterministic: the same views in any order give the same scene, down to its JSON text. Every string is cleaned.
 */
import type { McpCall, OpenCall, WorkflowRun } from '../core/types.js';
import { assignLeisure, waitingSubagents } from '../core/leisure.js';
import { liveRun } from '../core/reducer.js';
import { buildFloors, byCodeUnit, floorKeyOf, islandKeyOf, repoLabels, repoRootOf, type Floor, type SessionView } from '../core/view.js';
import { INTERNS_MAX, layoutPlan, LOUNGE_SEATS, MEETING_AGENTS_MAX, POD_DESKS, RUNS_SHOWN, UNSEATED_MAX } from './layout.js';
import { FEATURE_SLOTS, LINE_SLOTS, REPO_SLOTS, slotOf } from './palette.js';
import { CREW_NAME, CREW_PREFIX, roomRunsOf, seatFloor, type RoomRun, type Seating } from './seating.js';
import { capKey, cleanOrNull, cleanText, KEY_MAX, taskTitle } from './text.js';
import {
  SCENE_VERSION,
  type ActiveLine,
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
  type OnCallView,
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
  const id = v.agentKind === 'codex' ? v.id.replace(/^codex-/, '') : v.id;
  return cleanOrNull(v.name) ?? cleanText(`${v.workspace.repoName}-${Array.from(cleanText(id)).slice(0, 4).join('')}`);
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
function internsOf(v: SessionView, inRoom: boolean, leisureOpen: boolean, now?: number): { interns: Intern[]; internsMore: number } {
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
      call: agentCallOf(c, now),
    })),
    internsMore: all.length - shown.length,
  };
}

function countsOf(r: WorkflowRun): { running: number; finished: number } {
  return { running: r.agents.filter((a) => a.running).length, finished: r.status === 'running' ? r.agentsFinished : Math.max(r.agentsFinished, r.agents.filter((a) => !a.running).length) };
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
    ...(r.agents.some((a) => a.telemetry) ? { agents: meetingAgentsOf(r, false, r.agents.length) } : {}),
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
function meetingAgentsOf(r: WorkflowRun, leisureOpen: boolean, limit = MEETING_AGENTS_MAX, now?: number): MeetingAgent[] {
  const running = r.agents.filter((a) => a.running).sort((a, b) => a.startedAt - b.startedAt || byCodeUnit(a.id, b.id));
  const finished = r.agents.filter((a) => !a.running).sort((a, b) => b.updatedAt - a.updatedAt || b.startedAt - a.startedAt || byCodeUnit(a.id, b.id));
  const leisure = leisureMapOf(r.agents, leisureOpen);
  return firstOfEach([...running, ...finished], (a) => a.id).slice(0, limit).map((a) => ({
    ...(a.telemetry ? { telemetry: { ...a.telemetry, model: cleanOrNull(a.telemetry.model, 120) } } : {}),
    agentId: capKey(a.id),
    label: cleanOrNull(a.label),
    phase: cleanOrNull(a.phase, PHASE_MAX),
    type: typeOf(a.type),
    running: a.running,
    smoking: a.running && a.smoking === true,
    leisure: leisure.get(a.id) ?? null,
    call: agentCallOf(a, now),
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

/**
 * Minimum time an on-call headset holds once lit, even once the call itself finishes: MCP calls are typically
 * sub-second, so a naive light-while-open bead would flash for one frame (hq-mcp-switchboard proposal.md §6 "Sub-
 * second lifetime"). Driven by the entity's `callAt` timestamp against `now` (core/types.ts's `call`/`callAt`
 * pair), not by `openTool` alone. Tunable; confirm once real MCP poll cadence vs call rate is measured (proposal.md
 * §7 Q3; default ~1.8 s).
 */
export const MIN_HOLD_MS = 1800;

/**
 * Every one of an entity's own MCP calls currently live, `now` against `MIN_HOLD_MS`: the live members of its
 * `calls` map (core/types.ts's `OpenCall`, keyed by toolId) — the same liveness rule `headsetOf` already applies
 * to the single most-recent call, applied here per call, for however many of them are concurrently tracked
 * ("parallel MCP calls" follow-up: a session's own `openTool` is one object, but `calls` is not — two parallel
 * `tool.started` events on the same entity now register as two entries here, instead of the second silently
 * overwriting the first) — when that map has at least one live entry, `call`/`callAt` play no further part: they
 * are themselves always one of the map's own entries by construction (reducer.ts sets both from the same event).
 * `call`/`callAt` are the fallback only when the map has none live: a call held past its own `tool.finished` (which
 * `withoutCall`, reducer.ts, already removed from the map) within its `MIN_HOLD_MS` tail, or an entity the map
 * never existed for at all (every pre-existing fixture/snapshot, and a session restored from a store saved before
 * `calls` did) — both read exactly as a single live call used to, before this map existed. `now` undefined (no
 * pre-existing caller gives build.ts a clock) reads as no live calls, same as before.
 */
function liveCalls(calls: Record<string, OpenCall> | undefined, now: number | undefined, call: McpCall | undefined, callAt: number | undefined): McpCall[] {
  if (now === undefined) return [];
  const fromMap = calls
    ? Object.values(calls)
        .filter((c) => now - c.callAt < MIN_HOLD_MS)
        .map((c) => c.call)
    : [];
  if (fromMap.length > 0) return fromMap;
  return call !== undefined && callAt !== undefined && now - callAt < MIN_HOLD_MS ? [call] : [];
}

/**
 * An on-call headset from an entity's most recent MCP call (`call`), when it started (`callAt`), its retained
 * `error` flag and how many of its calls are concurrently live (`count`, `liveCalls` above — "parallel MCP calls"
 * follow-up), shared by a session's own open tool, a plain subagent and a run's agent (hq-mcp-switchboard
 * proposal.md §3 "Scene-model changes"; contract.md #scene-call). Live from `callAt` for `MIN_HOLD_MS`: covers both
 * a call still open and the minimum-hold window after a sub-second one already closed (proposal.md §6). `now`
 * undefined means the caller gave build.ts no clock (every call site before this feature, and every existing
 * fixture/snapshot): reads as "no call live," unconditionally — the exact behaviour before this function had a
 * body, so no pre-existing caller needs updating. `slot` resolves the call's canonical server (tool-label.ts's
 * `classifyMcp`) to a stable palette index the renderer never has to hash itself (scene/palette.ts's `slotOf`).
 * `count` is omitted past a single call (`OnCallView`'s own doc comment).
 */
function headsetOf(call: McpCall | undefined, callAt: number | undefined, error: boolean, now: number | undefined, calls: Record<string, OpenCall> | undefined): OnCallView | null {
  if (!call || callAt === undefined || now === undefined || now - callAt >= MIN_HOLD_MS) return null;
  const count = liveCalls(calls, now, call, callAt).length;
  return { slot: slotOf(call.server, LINE_SLOTS), family: call.family, write: call.write, fairmind: call.fairmind, error, ...(count > 1 ? { count } : {}) };
}

/**
 * A session's on-call headset: `headsetOf` from its own `call`/`callAt`/`error`, live only while it is actually open
 * (`smokingOf`'s own gate, just above) — a `call`/`callAt` left over from before the session moved to needs_you or
 * done must not still light a headset, exactly as a leftover `smoking` flag must not still light a cigar (the
 * "stale" case in `smokingOf`'s own test).
 */
function callOf(v: SessionView, now?: number): OnCallView | null {
  const open = v.effectiveState === 'working' || v.effectiveState === 'no_signal';
  return open ? headsetOf(v.call, v.callAt, v.error === true, now, v.calls) : null;
}

/**
 * An intern's or a meeting agent's on-call headset: `headsetOf` from a `ChildAgent`/`RunAgent`'s own
 * `call`/`callAt`/`error`, live only while it is running — mirrors `smoking`'s own `c.running && …` gate (`internsOf`/
 * `meetingAgentsOf` below): a finished subagent's leftover `call` must not still light a headset.
 */
function agentCallOf(a: { running: boolean; call?: McpCall; callAt?: number; error?: boolean; calls?: Record<string, OpenCall> }, now?: number): OnCallView | null {
  return a.running ? headsetOf(a.call, a.callAt, a.error === true, now, a.calls) : null;
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
function occupantOf(v: SessionView, label: (v: SessionView) => string, at: Place, crewSeated = false, leisureOpen = false, now?: number): Occupant {
  const state = v.effectiveState as ShownState;
  return {
    sessionId: idOf(v),
    agentKind: v.agentKind,
    name: nameOf(v),
    title: taskTitle(v),
    state,
    since: v.effectiveSince,
    reason: reasonOf(v),
    activity: activityOf(v),
    smoking: smokingOf(v),
    call: callOf(v, now),
    agentsRunning: v.children.filter((c) => c.running).length + v.runs.reduce((n, r) => n + countsOf(r).running, 0),
    summary: deskSummaryOf(v),
    ...internsOf(v, crewSeated, leisureOpen, now),
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

/**
 * The room's topic for its board heading: the host's title for a crew's room; else the run's name, while that is
 * not just the crew's fixed placeholder name; else the current phase's title; a generic 'Subagents' failing all of
 * that (design: board heading = the topic, with this fallback chain).
 */
function topicOf(crew: boolean, host: SessionView, name: string | null, phases: MeetingRoom['phases']): string {
  const phase = phases.find((p) => p.state === 'current')?.title ?? null;
  return (crew ? taskTitle(host) : null) ?? (name !== null && name !== CREW_NAME ? name : null) ?? phase ?? CREW_NAME;
}

/** The room of a live run in its slot. */
function roomOf({ run, host, crew }: RoomRun, slot: number, rect: GridRect, leisureOpen: boolean, now?: number): MeetingRoom {
  const name = cleanOrNull(run.name, RUN_NAME_MAX);
  const phases = phasesOf(run);
  return {
    kind: crew ? 'crew' : 'workflow',
    runId: capKey(run.id),
    hostSessionId: idOf(host),
    name,
    topic: topicOf(crew, host, name, phases),
    summary: cleanOrNull(run.summary),
    phases,
    counts: countsOf(run),
    agents: meetingAgentsOf(run, leisureOpen, MEETING_AGENTS_MAX, now),
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
function detailOf(floor: Floor, number: number, label: (v: SessionView) => string, seating: Seating, leisureOpen: boolean, now?: number): FloorDetail {
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
      seated.set(v.id, occupantOf(v, label, placeOf(v), slotOfKey(capKey(CREW_PREFIX + v.id)) !== -1, leisureOpen, now));
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
  const unseated = waiting.slice(0, UNSEATED_MAX).map((v) => occupantOf(v, label, { kind: 'gone' }, false, leisureOpen, now));
  const rooms = runs
    .map((r) => ({ r, slot: slotOfKey(r.key) }))
    .filter(({ slot }) => slot !== -1)
    .sort((a, b) => a.slot - b.slot)
    .map(({ r, slot }) => roomOf(r, slot, plan.rooms[slot]!, leisureOpen, now));
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
 * The canonical server token `classifyMcp` (tool-label.ts) resolves every Fairmind spelling to. Used here, not a
 * slot number, to key the one combined Fairmind line: the mast is the building's single hotline, never a line among
 * the others (proposal.md §2 "FairMind tool families" — "FairMind never renders as a generic grey bead").
 */
const FAIRMIND_LINE_KEY = 'fairmind';

/**
 * Distinct MCP servers with a live call anywhere in the building, for the façade rooftop switchboard (proposal.md
 * §2 "Many parallel calls"/§4; contract.md #scene-activelines). Scans every session's own calls and its children's
 * and its workflow runs' agents' — the same places `callOf`/`agentCallOf` gate liveness on — rather than a second
 * accumulator kept in the reducer (contract.md Seam 1's own recommendation: computing it here "avoids a second
 * source of truth and keeps the reducer's existing 'no building-level state' invariant"). Every Fairmind call
 * collapses into one line regardless of which of the ~8 line slots its tool name would otherwise hash to. `now`
 * undefined reads as no call anywhere live, consistent with `callOf`/`agentCallOf`.
 *
 * "Parallel MCP calls" follow-up: tallies every one of an entity's own concurrently-live calls (`liveCalls`), not
 * only its single most-recent (`call`/`callAt`) — one Claude Code turn calling several MCP servers in one message
 * used to light at most one antenna per entity, since `callOf`/`agentCallOf` only ever read the latest. A session
 * with, say, three parallel calls to three distinct servers now tallies into all three of their slots.
 *
 * Each non-Fairmind slot also keeps the canonical `server` name of whichever live call tallied into it first
 * (proposal.md §5 Phase 2: the façade sign needs the real name, not just the hashed slot, to pick a known-server
 * glyph). `server` is read straight off the same raw `McpCall` `liveCalls` already filtered for liveness, never
 * re-derived, so it can't disagree with the slot/fairmind verdict `headsetOf` would make for the same call. The
 * Fairmind line keeps `family` by the same first-tallied rule (SCENE_VERSION 9, proposal.md §5 Phase 3): the
 * mast's own sign needs it to pick a VIP motif the way the glyph sign needs `server`.
 *
 * `tool` and `caller` (SCENE_VERSION 10, Phase 4: the façade antenna tooltip) follow the identical first-tallied
 * rule, read off the same raw `call` as `server`: `tool` is `McpCall.tool`; `caller` is the entity's own
 * already-shown name — a session's (`nameOf`), or a subagent's type/label, the same fallback chain its own
 * intern/meeting-agent list already uses (`DeskPanel.svelte`'s `intern.type ?? 'Subagent'`, `RunPanel.svelte`'s
 * `agent.label ?? agent.type ?? 'Agent'`) so the tooltip never invents a name the rest of the UI would not.
 */
function activeLinesOf(views: readonly SessionView[], now?: number): ActiveLine[] {
  const perServer = new Map<string, { count: number; tool: string; caller: string }>();
  let fairmind = 0;
  let fairmindFamily: string | null = null;
  let fairmindTool = '';
  let fairmindCaller = '';
  let fairmindFamilySeen = false;
  const tally = (raw: McpCall, caller: string) => {
    if (raw.fairmind) {
      fairmind += 1;
      if (!fairmindFamilySeen) {
        fairmindFamily = raw.family;
        fairmindTool = raw.tool;
        fairmindCaller = caller;
        fairmindFamilySeen = true;
      }
    } else {
      const prev = perServer.get(raw.server);
      perServer.set(raw.server, { count: (prev?.count ?? 0) + 1, tool: prev?.tool ?? raw.tool, caller: prev?.caller ?? caller });
    }
  };
  const tallyEntity = (open: boolean, call: McpCall | undefined, callAt: number | undefined, calls: Record<string, OpenCall> | undefined, caller: string) => {
    if (!open) return;
    for (const raw of liveCalls(calls, now, call, callAt)) tally(raw, caller);
  };
  for (const v of views) {
    tallyEntity(v.effectiveState === 'working' || v.effectiveState === 'no_signal', v.call, v.callAt, v.calls, nameOf(v));
    for (const c of v.children) tallyEntity(c.running, c.call, c.callAt, c.calls, typeOf(c.type) ?? 'Subagent');
    for (const r of v.runs) for (const a of r.agents) tallyEntity(a.running, a.call, a.callAt, a.calls, a.label ?? typeOf(a.type) ?? 'Agent');
  }
  // Each live server gets its own antenna: its hashed slot when free, else the next free one (servers in name order,
  // so the probe is deterministic). Only past LINE_SLOTS distinct servers do two share a stub, first-tallied wins.
  const perSlot = new Map<number, { count: number; server: string; tool: string; caller: string }>();
  for (const [server, entry] of [...perServer.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    const home = slotOf(server, LINE_SLOTS);
    let slot = home;
    for (let i = 0; i < LINE_SLOTS && perSlot.has(slot); i++) slot = (home + i + 1) % LINE_SLOTS;
    const prev = perSlot.get(slot);
    perSlot.set(slot, prev ? { ...prev, count: prev.count + entry.count } : { server, ...entry });
  }
  const lines = [...perSlot.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([slot, { count, server, tool, caller }]): ActiveLine => ({ slot, fairmind: false, count, server, family: null, tool, caller }));
  if (fairmind > 0) {
    lines.unshift({ slot: slotOf(FAIRMIND_LINE_KEY, LINE_SLOTS), fairmind: true, count: fairmind, server: FAIRMIND_LINE_KEY, family: fairmindFamily, tool: fairmindTool, caller: fairmindCaller });
  }
  return lines;
}

/**
 * The building every client sees: floors top to bottom, each from its seating in `seating` (a floor with none there is
 * seated from scratch), and the attention queue. `now` is optional and trails every existing parameter so no
 * pre-existing caller needs to change: omitted, `activeLines` reads as empty, exactly as before this parameter
 * existed (hq-mcp-switchboard contract.md #scene-activelines).
 */
export function buildScene(
  views: readonly SessionView[],
  firstSeen?: ReadonlyMap<string, number>,
  seating?: ReadonlyMap<string, Seating>,
  now?: number,
): BuildingScene {
  const floors = buildFloors(views, firstSeen);
  return {
    version: SCENE_VERSION,
    floors: floors.map((f, i) => summaryOf(f, floors.length - i, seating?.get(f.key) ?? seatFloor(null, f))),
    attention: { needsYou: attentionOf(views, 'needs_you'), done: attentionOf(views, 'done') },
    activeLines: activeLinesOf(views, now),
  };
}

/**
 * One floor in detail: its plan, filled from its seating in `seating` (a floor with none there is seated from scratch).
 * Null when no live session is on it. `leisureOpen` gates whether a waiting sub-agent (intern or meeting agent) is shown
 * at the bar/biliardino (true) or on a coffee break (false, the default): the caller reads `now` (see collector.ts,
 * via `inLeisureWindow`) and passes the result in, keeping this function itself clock-free and deterministic. `now`
 * is also, separately, every occupant's and meeting agent's on-call clock (`callOf`/`agentCallOf`): optional and
 * trailing, like `buildScene`'s, so it is a pure addition.
 */
export function buildFloorDetail(
  views: readonly SessionView[],
  key: string,
  firstSeen?: ReadonlyMap<string, number>,
  seating?: ReadonlyMap<string, Seating>,
  leisureOpen = false,
  now?: number,
): FloorDetail | null {
  const floors = buildFloors(views, firstSeen);
  const i = floors.findIndex((f) => f.key === key);
  const floor = floors[i];
  if (!floor) return null;
  return detailOf(floor, floors.length - i, repoLabels(views), seating?.get(key) ?? seatFloor(null, floor), leisureOpen, now);
}
