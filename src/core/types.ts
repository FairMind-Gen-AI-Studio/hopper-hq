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
}

export interface OpenTool {
  id: string | null;
  label: string;
  startedAt: number;
  /** The open tool is a smoke test. */
  smoking?: boolean;
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
    | { type: 'tool.started'; toolId: string | null; tool: string; label: string; agentId: string | null; smoke?: boolean }
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
