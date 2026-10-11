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
}

export interface ChildAgent {
  id: string;
  type: string;
  description: string | null;
  running: boolean;
  lastAction: string | null;
  updatedAt: number;
}

export interface OpenTool {
  id: string | null;
  label: string;
  startedAt: number;
}

export interface Session {
  id: string;
  agentKind: 'claude-code';
  location: 'local' | 'cloud';
  pid: number | null;
  name: string | null;
  tmuxPane: string | null;
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
        transcriptPath?: string | null;
        startedAt?: number;
      }
    | { type: 'session.started' }
    | { type: 'session.status'; status: 'busy' | 'idle' | 'waiting'; waitingFor: string | null }
    | { type: 'branch'; branch: string | null }
    | { type: 'title'; title: string }
    | { type: 'prompt'; text: string | null }
    | { type: 'tool.started'; toolId: string | null; tool: string; label: string; agentId: string | null }
    | { type: 'tool.finished'; toolId: string | null; ok: boolean; agentId: string | null }
    | { type: 'waiting'; reason: WaitReason; agentId: string | null }
    | { type: 'turn.finished'; backgroundTasks: number }
    | { type: 'agent.started'; agentId: string; agentType: string; description: string | null }
    | { type: 'agent.finished'; agentId: string }
    | { type: 'session.ended'; reason: string }
  );

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event before the collector assigns `seq`. Adapters produce these. */
export type RawEvent = DistributiveOmit<CollectorEvent, 'seq'>;

export type EventOf<T extends CollectorEvent['type']> = Extract<CollectorEvent, { type: T }>;
