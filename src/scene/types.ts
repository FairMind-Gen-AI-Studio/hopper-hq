/**
 * The scene model the server sends to the browser. JSON-serializable: no functions, no Dates, no undefined.
 * Every string is cleaned by the server (control and bidi characters removed, length capped).
 * Grid: integer cells; x grows east, y grows south. The renderer maps cells to world units.
 */
import type { SessionState, WaitKind } from '../core/types.js';

export const SCENE_VERSION = 1;

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
  /** Feature key or repo name; a department name is suffixed ' (<parent dir>)' when two departments share it. */
  name: string;
  /** Repo names on the floor, sorted. */
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
  /** Running subagents and workflow agents (shown as a count until M3 brings interns). */
  agentsRunning: number;
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
}
