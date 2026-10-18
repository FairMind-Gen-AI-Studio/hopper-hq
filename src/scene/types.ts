/**
 * The scene model the server sends to the browser. JSON-serializable: no functions, no Dates, no undefined.
 * Every string is cleaned by the server (control and bidi characters removed, length capped).
 * Grid: integer cells; x grows east, y grows south. The renderer maps cells to world units.
 */
import type { AgentTelemetry, AgentKind, RunStatus, SessionState, WaitKind } from '../core/types.js';

export const SCENE_VERSION = 7;

/** What a waiting sub-agent is shown doing at leisure: a gin tonic, table football (paired), or a coffee break outside the leisure window. */
export type SceneLeisure = 'gintonic' | 'biliardino' | 'coffee';

/** States a desk can show. Ended sessions have left the building. */
export type ShownState = Exclude<SessionState, 'ended'>;

export interface SceneReason {
  kind: WaitKind;
  text: string;
  detail: string | null;
  /** The subagent that raised the wait; null when it is the main agent or unknown. */
  agent: { id: string; type: string | null } | null;
}

export interface FacadeWindow {
  /** Null: a free desk, a dark window. */
  sessionId: string | null;
  state: ShownState | null;
}

export interface FloorSummary {
  /** Stable id: 'feature:<key>' or 'repo:<repo root, or cwd outside git>'. */
  key: string;
  /** 1 = bottom floor (oldest first-seen). Floors are listed top to bottom. */
  number: number;
  kind: 'feature' | 'department';
  /** Feature key or repo label: the repo name, with the shortest parent path that tells it apart when another live repository shares the name ('api (work)', 'api (a/work)'). */
  name: string;
  /** Repo labels on the floor, sorted. */
  repos: string[];
  /** One per desk of the plan, in desk index order. A floor's sessions are counted by `counts`, which include unseated ones. */
  windows: FacadeWindow[];
  counts: Partial<Record<ShownState, number>>;
  /** Every desk is dormant: the shutters are down. */
  shutters: boolean;
  /** When this floor key was first seen (persisted). Floors are ordered by it, newest on top. */
  openedAt: number;
}

export interface AttentionEntry {
  sessionId: string;
  floorKey: string;
  /** Session name, or '<repo>-<first 4 chars of id>'. */
  name: string;
  repo: string;
  state: 'needs_you' | 'done';
  since: number;
  reason: SceneReason | null;
  /** Title, else latest prompt, else first prompt. */
  title: string | null;
  focusable: boolean;
  summary: DeskSummary | null;
}

export interface BuildingScene {
  version: typeof SCENE_VERSION;
  /** Top to bottom: newest first-seen first. */
  floors: FloorSummary[];
  /** needsYou: longest wait first. done: oldest first. */
  attention: { needsYou: AttentionEntry[]; done: AttentionEntry[] };
}

export interface GridRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * typing/waving/holding/still/resting come from a session's own state (build.ts's ROBOT map); gintonic/biliardino/coffee
 * are the renderer's own, for a sub-agent the floor sends to the break area at leisure (SceneLeisure) - never a
 * session's.
 */
export type Pose = 'typing' | 'waving' | 'holding' | 'still' | 'resting' | 'gintonic' | 'biliardino' | 'coffee';
export type Badge = 'typing' | 'needs' | 'done' | 'meeting' | 'clock';

export interface Robot {
  pose: Pose;
  badge: Badge | null;
  /** Repo colour slot, 0..REPO_SLOTS-1 (body). */
  body: number;
  /** Feature colour slot, 0..FEATURE_SLOTS-1 (tie); null on department floors. */
  tie: number | null;
}

export interface DeskActivity {
  label: string;
  since: number;
  /** True for a tool still running (no_signal shows "running <label> for 12 min"). */
  running: boolean;
}

export interface DeskSummary {
  text: string;
  /** When it was written (ms). */
  at: number;
  /** A prompt arrived after it: the line may be out of date. */
  stale: boolean;
}

/** A plain subagent, hovering next to its parent desk while its session's crew has no room. */
export interface Intern {
  agentId: string;
  /** Agent type, e.g. 'Explore'; null when unknown. */
  type: string | null;
  label: string | null;
  running: boolean;
  /** Running in its session's room, as part of its crew: it does not hover. */
  inRoom: boolean;
  /** Its open tool is a smoke test: it holds a cigar. Only a running intern smokes. */
  smoking: boolean;
  /** What it is doing while it waits for a running sibling; null while it is running, or has no running sibling. */
  leisure: SceneLeisure | null;
}

/** One run of a session, for its desk panel. */
export interface RunSummary {
  /** Retained agent details, available after its room closes too. */
  agents?: MeetingAgent[];
  runId: string;
  name: string | null;
  status: RunStatus;
  startedAt: number;
  endedAt: number | null;
  counts: { running: number; finished: number };
}

export type PhaseState = 'done' | 'current' | 'upcoming';

export interface MeetingAgent {
  telemetry?: AgentTelemetry;
  agentId: string;
  label: string | null;
  phase: string | null;
  type: string | null;
  running: boolean;
  /** Its open tool is a smoke test: it holds a cigar. Only a running agent smokes. */
  smoking: boolean;
  /** What it is doing while it waits for a running sibling; null while it is running, or has no running sibling. */
  leisure: SceneLeisure | null;
}

/** A running workflow run, or the crew of a session's running subagents: a room in the meeting wing of its host's floor. */
export interface MeetingRoom {
  /** 'crew': the host's plain subagents, one room per host, whose runId is not a workflow run's. */
  kind: 'workflow' | 'crew';
  runId: string;
  hostSessionId: string;
  name: string | null;
  summary: string | null;
  /** Phase titles with their state; empty when the run's phases are unknown. */
  phases: { title: string; state: PhaseState }[];
  counts: { running: number; finished: number };
  /** Running agents first, in start order, then finished ones, latest first; at most MEETING_AGENTS_MAX. The first min(SEATS_MAX, counts.running) sit at the table. */
  agents: MeetingAgent[];
  /** Body and tie colour slots of the run's robots: the host's repo and feature. */
  look: { body: number; tie: number | null };
  rect: GridRect;
  /** Its room slot: an index into FloorDetail.roomSlots. */
  slot: number;
}

/** Where a session's robot should be. The renderer walks it there. */
export type Place =
  | { kind: 'desk' }
  | { kind: 'lounge'; seat: number }
  | { kind: 'room'; slot: number }
  | { kind: 'gone' };

/** The checkout a session works in. */
export interface Checkout {
  /** The repository's label (see repoLabels). */
  repo: string;
  branch: string | null;
  worktree: boolean;
  /** The worktree root, or cwd outside git. */
  path: string;
}

/** A session on the floor: at a desk, or waiting for one (FloorDetail.unseated). */
export interface Occupant {
  agentKind: AgentKind;
  sessionId: string;
  name: string;
  title: string | null;
  state: ShownState;
  since: number;
  reason: SceneReason | null;
  activity: DeskActivity | null;
  /** Its own open tool is a smoke test: it holds a cigar. Only while it is actually open (working or no_signal). */
  smoking: boolean;
  /** Running subagents and workflow agents. */
  agentsRunning: number;
  summary: DeskSummary | null;
  /** Running interns first (by start), then the latest finished; at most INTERNS_MAX. */
  interns: Intern[];
  /** Interns not in `interns`. */
  internsMore: number;
  /** Running runs first (by start), then finished ones, latest ended first; at most RUNS_SHOWN. */
  runs: RunSummary[];
  location: 'local' | 'cloud';
  /** tmux pane id (%N) for display; focus goes through POST /api/focus by sessionId. */
  pane: string | null;
  focusable: boolean;
  /** Null when dormant: gone home. */
  robot: Robot | null;
  /** Where its robot should be: its desk, a lounge seat, the head of its room while it works with a run or a crew in it, or gone (dormant, or no desk). */
  at: Place;
  checkout: Checkout;
}

/** One of a pod's four desks. */
export interface PodDesk {
  /** 'p<pod>-<n>'; n 0..3: north row west to east, then south row west to east. */
  id: string;
  /** 2x2 cells. */
  rect: GridRect;
  /** The edge its chair is on. The monitor is on the opposite edge; a seated robot faces it. */
  chair: 'north' | 'south';
  /** Null: a free desk. */
  occupant: Occupant | null;
}

export interface PodPlacard {
  repo: string;
  /** Null when the occupants share only their repository, or the branch is unknown. */
  branch: string | null;
  worktree: boolean;
  /** Null when the occupants share only their repository. */
  path: string | null;
}

/** Four desks back to back on one rug. */
export interface Pod {
  /** 'p<index>', in plan order. */
  id: string;
  /** The rug: POD cells. */
  rect: GridRect;
  /** Repo colour slot while every occupant shares one repository; null when they do not, or the pod is empty. */
  color: number | null;
  /** The checkout while every occupant shares one; the repository alone while they share only that; null otherwise. */
  placard: PodPlacard | null;
  /** Always POD_DESKS. */
  desks: PodDesk[];
}

export interface Lounge {
  rect: GridRect;
  /** LOUNGE_SEATS. */
  seats: number;
}

export interface FloorDetail extends Omit<FloorSummary, 'windows'> {
  version: typeof SCENE_VERSION;
  /** Floor footprint in cells (walls run along its edges). */
  size: { w: number; h: number };
  /** Elevator and plants corner (decor; never overlaps pods). */
  core: GridRect;
  rooms: MeetingRoom[];
  /** Running runs on this floor without a room. */
  roomsMore: number;
  /** The plan's pods, in order. */
  pods: Pod[];
  lounge: Lounge;
  /** Every room of the plan, by slot, open or not. */
  roomSlots: GridRect[];
  /** The break area: a bar cart and a biliardino table, shared by every sub-agent on the floor at leisure. */
  breakArea: GridRect;
  /** Sessions on the floor without a desk, in start order, at most UNSEATED_MAX: dormant ones whose desk another session took, and those waiting at the cap. */
  unseated: Occupant[];
  /** Unseated sessions beyond `unseated` (at most UNSEATED_MAX are listed). */
  unseatedMore: number;
}
