/**
 * The scene model the server sends to the browser. JSON-serializable: no functions, no Dates, no undefined.
 * Every string is cleaned by the server (control and bidi characters removed, length capped).
 * Grid: integer cells; x grows east, y grows south. The renderer maps cells to world units.
 */
import type { AgentTelemetry, AgentKind, RunStatus, SessionState, WaitKind } from '../core/types.js';

/**
 * SCENE_VERSION 12 (merge of the MCP switchboard, room-board and Codex/workflow lines, each of which had bumped
 * the counter on its own branch past the shared ancestor at version 6 — this is the one value past every one of
 * them, per the merge's own rule that a schema bump always exceeds every side's): `MeetingRoom` gains `topic`,
 * its board's heading (feat/room-screens); `Occupant` gains `agentKind` and `RunSummary` gains `agents` /
 * `MeetingAgent` gains `telemetry` (the Codex adapter and workflow-usage-metrics work already on main) landed
 * under the same version 7 as the MCP switchboard's own Phase 1 below, two independent bumps off the same base
 * that happened to pick the same number; version 12 is also the first number that was never claimed by any of
 * them.
 *
 * SCENE_VERSION 11 ("parallel MCP calls" follow-up — one Claude Code turn calling several MCP servers in one
 * message used to light at most one antenna, since every entity's `call`/`callAt` held only its single
 * most-recently-started call): `OnCallView` gains `count`, how many of the entity's own MCP calls are
 * concurrently live right now, for the robot's own "×N" next to its most-recent call (the chip, the side panel's
 * "Running" line) — `activeLinesOf` itself needed no new field, since `ActiveLine.count` already tallied live
 * calls building-wide; it now tallies every one of an entity's concurrent calls, not just its single most-recent.
 *
 * SCENE_VERSION 10 (hq-mcp-switchboard proposal.md §4 Façade, Phase 4 — user feedback 2026-10-19, "ora sono
 * antenne ma non si capisce a cosa servono", "now they're antennas but it's not clear what they're for"):
 * `ActiveLine` gains `tool` and `caller`, the first-tallied call's own tool verb (`McpCall.tool`, tool-label.ts)
 * and the name of whoever is calling it — a session's own name, or a subagent's type/label, exactly the names
 * already shown elsewhere in the UI (desk tags, intern/meeting-agent lists) — so the façade's own antenna tooltip
 * can read "server, tool, caller" without reaching back into the raw session tree itself. SCENE_VERSION 9
 * (`ActiveLine` gains `family`) landed in Phase 3; SCENE_VERSION 8 (`ActiveLine` gains `server`) landed in Phase 2;
 * SCENE_VERSION 7 (Occupant/Intern/MeetingAgent gain `call`, BuildingScene gains `activeLines`) landed in Phase 1.
 */
export const SCENE_VERSION = 12;

/** What a waiting sub-agent is shown doing at leisure: a gin tonic, table football (paired), or a coffee break outside the leisure window. */
export type SceneLeisure = 'gintonic' | 'biliardino' | 'coffee';

/**
 * A robot's on-call headset, projected from the entity's `McpCall` + the building-level line slot it was assigned
 * (hq-mcp-switchboard proposal.md §3 "Scene-model changes"; contract.md #scene-call). `slot` is a palette index,
 * `0..LINE_SLOTS-1` (src/scene/palette.ts), already resolved server-side so the renderer never hashes a server name
 * itself — mirroring how a robot carries its repo/feature slot rather than their names. `error` is the ~0.5 s
 * "dropped call" flash (proposal.md §2 "Error / dropped call"). Null while no call is live (or still in its
 * minimum-hold window at build time — build.ts's `callOf`, MIN_HOLD_MS).
 */
export interface OnCallView {
  slot: number;
  family: string | null;
  write: boolean;
  fairmind: boolean;
  error: boolean;
  /**
   * How many of this entity's own MCP calls are concurrently live right now ("parallel MCP calls" follow-up):
   * absent or 1 for a single call, the pre-existing case every caller already handles unchanged. Past 1, the
   * entity's single headset/chip still shows its most-recent call alone (`call`/`callAt`, core/types.ts) — a robot
   * has one headset, not several — with this count as the "×N" that says more are live at once.
   */
  count?: number;
}

/**
 * One distinct MCP server with a live call somewhere in the building, for the façade rooftop switchboard
 * (proposal.md §2 "Many parallel calls" / §4 Façade; contract.md #scene-activelines). `count` backs the busiest
 * line's `+N` badge; `fairmind` lights the mast, never an antenna stub (proposal.md §2 "FairMind never renders
 * as a generic grey bead" — the façade's own form of that rule; Facade.svelte excludes a `fairmind: true` line
 * from the stub/sign lookup for exactly this reason). `server` is the canonical name `classifyMcp` resolved the
 * line's call to (same string `McpCall.server` carries, kept alongside the hashed `slot` rather than in place of
 * it — `slot` still picks the stub's fixed position and line colour, `server` is what Phase 2's façade sign
 * reads to choose a known-server glyph or fall back to colour + first letter, proposal.md §5 Phase 2 / §7 Q4).
 * Collisions are the same accepted limitation as the colour slot's own (proposal.md §6): two different server
 * names can still hash to the same `slot`, and only one's `server` (whichever tallied first) is carried — the
 * DOM chip remains the one authoritative identity.
 *
 * `family` (SCENE_VERSION 9, proposal.md §5 Phase 3) is the Fairmind line's own family, by the same
 * first-tallied-wins rule as `server` above — null for every non-Fairmind line (a family is a Fairmind-only
 * concept, `classifyMcp`) and also null for a Fairmind line whose first-tallied call carried none (e.g.
 * `bulk_update_status`), which is exactly the "sensible default form" case the mast's own sign falls back to.
 *
 * `tool` and `caller` (SCENE_VERSION 10, Phase 4 — the façade antenna tooltip, requirement 3) are the same
 * first-tallied call's own tool verb (`McpCall.tool`) and the name of whoever placed it: a session's own name
 * (`nameOf`) or a subagent's type/label, the same names its own desk tag or intern/meeting-agent list already
 * shows elsewhere in the UI — never anything from the call's own arguments (`tool` carries only what
 * `classifyMcp` read from the tool's name, same privacy rule `server`/`family` already keep).
 */
export interface ActiveLine {
  slot: number;
  fairmind: boolean;
  count: number;
  server: string;
  family: string | null;
  tool: string;
  caller: string;
}

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
  /** Distinct MCP servers with a live call anywhere in the building, for the façade rooftop switchboard (build.ts's activeLinesOf). */
  activeLines: ActiveLine[];
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
  /** Its open tool is a live or min-hold MCP call: it wears the headset (build.ts's callOf). Null otherwise. */
  call: OnCallView | null;
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
  /** Its open tool is a live or min-hold MCP call: it wears the headset (build.ts's callOf). Null otherwise. */
  call: OnCallView | null;
}

/** A running workflow run, or the crew of a session's running subagents: a room in the meeting wing of its host's floor. */
export interface MeetingRoom {
  /** 'crew': the host's plain subagents, one room per host, whose runId is not a workflow run's. */
  kind: 'workflow' | 'crew';
  runId: string;
  hostSessionId: string;
  name: string | null;
  /**
   * Its board's heading: the host's title for a crew's room, else the run's name; while that is missing (for a crew,
   * its name is only ever its fixed 'Subagents', never a real topic), the current phase's title; a generic
   * 'Subagents' failing all of that. Unlike `name`, never null and never the run id.
   */
  topic: string;
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
  /** Its own open tool is a live or min-hold MCP call: it wears the headset (build.ts's callOf). Null otherwise. */
  call: OnCallView | null;
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
