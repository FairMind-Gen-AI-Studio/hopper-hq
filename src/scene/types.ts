/**
 * The scene model the server sends to the browser. JSON-serializable: no functions, no Dates, no undefined.
 * Every string is cleaned by the server (control and bidi characters removed, length capped).
 * Grid: integer cells; x grows east, y grows south. The renderer maps cells to world units.
 */
import type { RunStatus, SessionState, WaitKind } from '../core/types.js';

export const SCENE_VERSION = 2;

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
  sessionId: string;
  state: ShownState;
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
  /** One per desk, in the same order as the floor's desks (islands in order, desks in order). */
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

export type Pose = 'typing' | 'waving' | 'holding' | 'still' | 'resting';
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

/** A plain subagent, hovering next to its parent desk. */
export interface Intern {
  agentId: string;
  /** Agent type, e.g. 'Explore'; null when unknown. */
  type: string | null;
  label: string | null;
  running: boolean;
}

/** One run of a session, for its desk panel. */
export interface RunSummary {
  runId: string;
  name: string | null;
  status: RunStatus;
  startedAt: number;
  endedAt: number | null;
  counts: { running: number; finished: number };
}

export type PhaseState = 'done' | 'current' | 'upcoming';

export interface MeetingAgent {
  agentId: string;
  label: string | null;
  phase: string | null;
  type: string | null;
  running: boolean;
}

/** A running workflow run: a room in the meeting wing of its host's floor. */
export interface MeetingRoom {
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
  /** The host's robot at the head of the table while the host is in_meeting; else null (the head seat holds a placard). */
  host: Robot | null;
  rect: GridRect;
}

export interface Desk {
  sessionId: string;
  /** 2x2 cells. The monitor sits on the north edge, the chair on the south edge. */
  rect: GridRect;
  name: string;
  title: string | null;
  state: ShownState;
  since: number;
  reason: SceneReason | null;
  activity: DeskActivity | null;
  /** Running subagents and workflow agents. */
  agentsRunning: number;
  summary: DeskSummary | null;
  /** Running interns first (by start), then the latest finished; at most INTERNS_MAX. */
  interns: Intern[];
  /** Interns not in `interns`. */
  internsMore: number;
  /** The robot sits at the head of a meeting room on this floor (its desk chair is empty). */
  away: boolean;
  /** Running runs first (by start), then finished ones, latest ended first; at most RUNS_SHOWN. */
  runs: RunSummary[];
  location: 'local' | 'cloud';
  /** tmux pane id (%N) for display; focus goes through POST /api/focus by sessionId. */
  pane: string | null;
  focusable: boolean;
  /** Null when dormant: gone home, desk dark. */
  robot: Robot | null;
}

export interface Island {
  /** Worktree root (or cwd outside git): one island per checkout. */
  key: string;
  repo: string;
  branch: string | null;
  worktree: boolean;
  /** Path shown on the placard (the worktree root, or cwd). */
  path: string;
  /** Repo colour slot (rug and robot bodies). */
  color: number;
  rect: GridRect;
  desks: Desk[];
}

export interface FloorDetail extends Omit<FloorSummary, 'windows'> {
  version: typeof SCENE_VERSION;
  /** Floor footprint in cells (walls run along its edges). */
  size: { w: number; h: number };
  /** Elevator and plants corner (decor; never overlaps islands). */
  core: GridRect;
  islands: Island[];
  rooms: MeetingRoom[];
  /** Running runs on this floor without a room. */
  roomsMore: number;
}
