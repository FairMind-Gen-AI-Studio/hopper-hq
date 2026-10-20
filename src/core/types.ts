/** Lifecycle states of a session. Time-based ones (idle, dormant, no_signal) are also derived at read time, see core/view.ts. */
export type SessionState =
  | 'working'
  | 'needs_you'
  | 'done'
  | 'in_meeting'
  | 'no_signal'
  | 'idle'
  | 'dormant'
  | 'ended';

export type WaitKind = 'permission' | 'question' | 'plan' | 'input';

export interface WaitReason {
  kind: WaitKind;
  /** Short text, e.g. "Bash" or "Which database?" */
  text: string;
  /** Optional detail, e.g. the command awaiting permission. */
  detail?: string;
}

/**
 * An MCP tool call, classified at ingest (`classifyMcp`, tool-label.ts) from its `mcp__<server>__<tool>` name only —
 * never its arguments (hq-mcp-switchboard/proposal.md §3: tool inputs are never read, carried or shown). `server` is
 * the canonical token after the plugin_/claude_ai_ lexical split, with every Fairmind spelling ('Fairmind',
 * 'fairmind-dev', a plugin-qualified one) collapsed to one identity, `'fairmind'`. `family` is one of
 * Studio/General/Brain/Insights/Code for a Fairmind call whose tool name carries that prefix, else null. `write` is
 * the verb's read/write classification (list_/get_/search/… read; record_/set_status/…  write), defaulting to read.
 * `tool` (Phase 4, hq-mcp-switchboard proposal.md §4 Façade follow-up — a viewer could not tell what a lit antenna
 * meant) is the verb segment alone, exactly as spelled in the tool name ('search', 'Studio_get_task'): the DOM
 * chip (labels.ts's `callText`, from `toolLabel`'s own 'server: tool' label) already showed this same text before
 * this field existed on `McpCall` itself — `classifyMcp` now keeps its own copy so the façade's antenna tooltip
 * (build.ts's `activeLinesOf`) can read it too, under the same privacy rule: a tool *name*, never its arguments.
 */
export interface McpCall {
  server: string;
  family: string | null;
  write: boolean;
  fairmind: boolean;
  tool: string;
}

/**
 * An MCP call tracked by its own toolId, concurrently with however many others the same entity has open at once
 * (`Session`/`ChildAgent`/`RunAgent.calls`, keyed by toolId — "parallel MCP calls" follow-up to the switchboard's
 * own MVP: a session's `call`/`callAt` pair held only the single most-recently-started call, so a second,
 * parallel `tool.started` silently overwrote the first instead of registering alongside it — one Claude Code turn
 * calling six MCP servers in one message left the rooftop lighting at most one antenna). `reducer.ts`'s `withCall`
 * upserts an entry on every MCP `tool.started`; `withoutCall` deletes only the matching toolId on that call's own
 * `tool.finished` — a sibling call, still open or still within its own `MIN_HOLD_MS` hold, is untouched.
 * `build.ts` reads this map, not `call`/`callAt` alone, to tell how many of an entity's calls are concurrently
 * live: for the robot's own "×N" and the façade's per-distinct-server tally (`activeLinesOf`), which used to see
 * only the entity's single most-recent call.
 */
export interface OpenCall {
  call: McpCall;
  callAt: number;
}

export interface Workspace {
  cwd: string;
  /** Root of the main repository (not of a linked worktree). Null outside git. */
  repoRoot: string | null;
  /** Basename of repoRoot, or of cwd outside git. */
  repoName: string;
  /** True when cwd belongs to a linked worktree. */
  worktree: boolean;
  /** Current branch; 'HEAD' when detached; null when unknown. */
  branch: string | null;
  /**
   * Top level of the working tree: a linked worktree's own root, or the main checkout's root. Null outside git.
   * Absent in sessions saved before it existed: read `root ?? cwd`.
   */
  root?: string | null;
}

export interface ChildAgent {
  id: string;
  type: string;
  description: string | null;
  running: boolean;
  lastAction: string | null;
  updatedAt: number;
  /**
   * Set when it was running as the daemon restored it from the store, until an event reports on it: what the store kept is
   * the last word on it. It runs on until the restored subagents are settled, and once stopped that way, the filesystem
   * may start it again on a transcript written before its last update.
   */
  restored?: boolean;
  /** Its running tool is a smoke test. Absent/false once the tool it was set from closes. */
  smoking?: boolean;
  /**
   * Its last finished tool call reported `ok:false` (hq-mcp-switchboard proposal.md §3/§5 Phase 0: "retain e.ok").
   * Cleared to false the next time it starts a tool; absent/false reads as no error.
   */
  error?: boolean;
  /**
   * Its most recent MCP call, from `classifyMcp` (tool-label.ts), and when that call started. Lives at the top
   * level — not nested in a per-call transient object — for the same reason `error` does: the signal must survive
   * past the call's own `tool.finished`, so `src/scene/build.ts`'s `MIN_HOLD_MS` window can still read it for a
   * little while after a sub-second call already closed (hq-mcp-switchboard proposal.md §6 "Sub-second lifetime";
   * contract.md Seam 1 names a `calls` counter for this same purpose; reconciling Group A's nested/wiped
   * `call`/`calls` pair with Group B's actual `build.ts` consumer — which reads `call`/`callAt` directly off this
   * entity, never a count — keeps this field pair, the one both the renderer and the `Session` sibling field
   * actually read. Not actively cleared: once `now - callAt` exceeds `MIN_HOLD_MS` it simply reads as stale).
   */
  call?: McpCall;
  /** When `call` was set (the owning `tool.started`'s own timestamp). Absent whenever `call` is. */
  callAt?: number;
  /** Every one of its own MCP calls currently tracked, keyed by toolId (see `OpenCall`); `call`/`callAt` above
   * still carry the single most-recent one, read unconditionally by every pre-existing consumer. Absent until its
   * first MCP call. */
  calls?: Record<string, OpenCall>;
}

export interface OpenTool {
  id: string | null;
  label: string;
  startedAt: number;
  /** The open tool is a smoke test. */
  smoking?: boolean;
  /** The open tool's MCP descriptor; null once it finishes, or was never MCP. See `ChildAgent.call`. */
  call?: McpCall | null;
  /** Carried across every tool this session opens, MCP or not, so the count survives an unrelated tool in between two MCP calls. See `ChildAgent.calls`. */
  calls?: number;
}

export type RunStatus = 'running' | 'completed' | 'failed' | 'killed';

export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}

export interface AgentTelemetry {
  model: string | null;
  usage: TokenUsage | null;
  /** Reported USD cost, never inferred from a model alias. */
  costUSD: number | null;
  startedAt: number | null;
  endedAt: number | null;
  /** All complete transcript lines currently on disk have been read. */
  complete: boolean;
}

/** An agent a workflow run's script started. */
export interface RunAgent {
  telemetry?: AgentTelemetry;
  id: string;
  /** The journal's label or the spawn's description; null when unknown. */
  label: string | null;
  /** The phase the agent started in; null when unknown. */
  phase: string | null;
  /** Agent type from its meta file or the spawn ('workflow-subagent', 'Explore', ...); 'agent' when unknown. */
  type: string;
  running: boolean;
  startedAt: number;
  updatedAt: number;
  /** Its running tool is a smoke test. Absent/false once the tool it was set from closes. */
  smoking?: boolean;
  /** Its last finished tool call reported `ok:false`. Cleared to false the next time it starts a tool. */
  error?: boolean;
  /** Its most recent MCP call, and when it started: same contract as `ChildAgent.call`/`callAt` above. */
  call?: McpCall;
  callAt?: number;
  /** Every one of its own MCP calls currently tracked, keyed by toolId: same contract as `ChildAgent.calls` above. */
  calls?: Record<string, OpenCall>;
}

/** A workflow run a session started (design §5). */
export interface WorkflowRun {
  /** 'wf_…' */
  id: string;
  /** The script's meta.name; null until known. */
  name: string | null;
  /** The script's meta.description (the launch result's Summary line); null until known. */
  summary: string | null;
  /** Phase titles in order; empty when unknown. */
  phases: string[];
  /** Phase of the most recently started agent; null before the first. */
  currentPhase: string | null;
  status: RunStatus;
  /** True once a filesystem event confirmed the run. Until then only its running agents keep the session in a meeting. */
  onDisk: boolean;
  startedAt: number;
  endedAt: number | null;
  /** The latest agents (running ones are never dropped). */
  agents: RunAgent[];
  /** How many of the run's agents finished, including any dropped from `agents`. */
  agentsFinished: number;
  /**
   * Ids of the finished agents dropped from `agents`, the latest last, at most MAX_DROPPED_AGENTS: a start or an end read
   * again for one of them counts nothing twice. Absent while none was dropped.
   */
  droppedAgents?: string[];
}

/** The "where it stands" line (M3a design §3). */
export interface SessionSummary {
  text: string;
  /** When it was written. */
  at: number;
  /** Hash of the input it was written from: the same input is not summarized twice. */
  inputHash: string;
}

export type AgentKind = 'claude-code' | 'codex';

export interface Session {
  id: string;
  agentKind: AgentKind;
  location: 'local' | 'cloud';
  pid: number | null;
  name: string | null;
  tmuxPane: string | null;
  /** The tmux session the pane is in, as Claude Code wrote it; null when unknown. Pane ids are per tmux server: this tells two %N apart. */
  tmuxSession: string | null;
  transcriptPath: string | null;
  workspace: Workspace;
  state: SessionState;
  stateSince: number;
  waitReason: WaitReason | null;
  /** The subagent whose wait waitReason is; null when it is the session's own, or nobody's in particular. */
  waitAgentId: string | null;
  title: string | null;
  firstPrompt: string | null;
  lastPrompt: string | null;
  lastAction: string | null;
  lastActionAt: number | null;
  openTool: OpenTool | null;
  /**
   * The main agent's last finished tool call reported `ok:false` (hq-mcp-switchboard proposal.md §3/§5 Phase 0:
   * "retain e.ok on tool.finished"). Lives on the session rather than on `openTool` because `openTool` is cleared
   * the moment a call that closes it finishes, while this signal must outlive that clearing. Cleared to false the
   * next time the main agent starts a tool.
   */
  error?: boolean;
  /**
   * The main agent's most recent MCP call, and when it started: same `error`-not-`openTool` placement, and for the
   * same reason — `src/scene/build.ts`'s `MIN_HOLD_MS` window must still read it for a little while after the call
   * that set it already closed `openTool` (hq-mcp-switchboard proposal.md §6 "Sub-second lifetime"; contract.md
   * Seam 1). Not actively cleared; `build.ts` reads `now - callAt` against `MIN_HOLD_MS` to tell a live/held call
   * from a stale one.
   *
   * Group A's own landed Seam-1 branch (a sibling worktree at the time of writing, not this one) instead keeps
   * `call`/`calls` nested on `OpenTool`, wiped wholesale when the call that opened it closes — their own journal and
   * review name this as a known gap and suggest moving `calls` alone onto `Session`. That alone is not sufficient
   * for this seam: a reader can then detect that *a* call happened, but `call` itself (the server/family/fairmind
   * identity the lit headset must show) is already gone by the time anything reads it, for every one of the three
   * entities, not just the session — `call` is set to `null` unconditionally on `tool.finished` in their reducer,
   * same as `error` would be without its own session-level carry-out. Persisting `call` itself here, time-gated by
   * `callAt` instead of diffing a count, is what actually keeps the server identity available through the hold
   * window; an integrator reconciling the two branches needs both fields moved out, not only the counter.
   */
  call?: McpCall;
  callAt?: number;
  /** Every one of the main agent's own MCP calls currently tracked, keyed by toolId: same contract as
   * `ChildAgent.calls` above — a second, parallel `tool.started` registers alongside the first here instead of
   * overwriting `call`/`callAt`. */
  calls?: Record<string, OpenCall>;
  backgroundTasks: number;
  children: ChildAgent[];
  /** Workflow runs, the latest first-started last; at most 10, running ones never dropped. */
  runs: WorkflowRun[];
  /** The main agent's last tool labels, oldest first; at most 10. */
  recentActions: string[];
  /** The main agent's last reply text, cleaned, at most 2000 characters; null when unknown. */
  lastAnswer: string | null;
  lastAnswerAt: number | null;
  /** When the user last sent a prompt; null when unknown. */
  lastPromptAt: number | null;
  summary: SessionSummary | null;
  startedAt: number;
  /** ts of the last applied ordered event. */
  lastEventAt: number;
  /** seq of the last applied ordered event (tie-break for equal ts). */
  lastSeq: number;
  /** When the user marked the current 'done' as seen. */
  seenAt: number | null;
}

export type EventSourceKind = 'hook' | 'fs' | 'demo';

interface EventBase {
  agentKind?: AgentKind;
  sessionId: string;
  /** Wall-clock ms when the event happened (hook stamp, transcript timestamp, file time). */
  ts: number;
  /** Arrival order, assigned by the collector. */
  seq: number;
  source: EventSourceKind;
  /** Working directory, when known. Lets the collector create a session it has not seen yet. */
  cwd?: string;
}

export type CollectorEvent = EventBase &
  (
    | {
        type: 'session.seen';
        workspace: Workspace;
        pid?: number | null;
        name?: string | null;
        tmuxPane?: string | null;
        tmuxSession?: string | null;
        transcriptPath?: string | null;
        startedAt?: number;
      }
    | { type: 'session.started' }
    | { type: 'session.focus'; tmuxPane: string; tmuxSession: string | null }
    | { type: 'session.status'; status: 'busy' | 'idle' | 'waiting'; waitingFor: string | null }
    | { type: 'branch'; branch: string | null }
    | { type: 'title'; title: string }
    | { type: 'prompt'; text: string | null }
    | {
        type: 'tool.started';
        toolId: string | null;
        tool: string;
        label: string;
        agentId: string | null;
        smoke?: boolean;
        /**
         * Set by an adapter from the raw `tool` it already holds, exactly parallel to `smoke` (hq-mcp-switchboard
         * contract.md #event-field; proposal.md §3 item 3). Absent for a non-MCP tool.
         */
        mcp?: McpCall;
      }
    | { type: 'tool.finished'; toolId: string | null; ok: boolean; agentId: string | null }
    | { type: 'waiting'; reason: WaitReason; agentId: string | null }
    | { type: 'turn.finished'; backgroundTasks: number }
    | { type: 'agent.started'; agentId: string; agentType: string; description: string | null; runId?: string | null; phase?: string | null }
    | { type: 'workflow.started'; runId: string; name?: string | null; summary?: string | null; phases?: string[] }
    | { type: 'workflow.finished'; runId: string; status: 'completed' | 'failed' | 'killed'; startedAt?: number }
    | { type: 'answer'; text: string }
    | { type: 'agent.metrics'; runId: string; agentId: string; telemetry: AgentTelemetry }
    | { type: 'agent.finished'; agentId: string }
    | { type: 'session.ended'; reason: string }
  );

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event before the collector assigns `seq`. Adapters produce these. */
export type RawEvent = DistributiveOmit<CollectorEvent, 'seq'>;

export type EventOf<T extends CollectorEvent['type']> = Extract<CollectorEvent, { type: T }>;
