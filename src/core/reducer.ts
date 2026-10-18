import { truncate } from './tool-label.js';
import type { ChildAgent, CollectorEvent, EventOf, RunAgent, Session, SessionState, WorkflowRun, Workspace } from './types.js';

const MAX_CHILDREN = 50;
/** Workflow runs kept per session; running ones are never dropped. */
export const MAX_RUNS = 10;
/** Agents kept per run; running ones are never dropped. */
export const MAX_RUN_AGENTS = 64;
/** Ids of dropped finished agents a run remembers. */
export const MAX_DROPPED_AGENTS = 256;
/** A workflow run id: 'wf_' and a short id of letters, digits, '_' and '-'. Anything else names no run. */
export const RUN_ID = /^wf_[A-Za-z0-9_-]{1,64}$/;
/** An agent id: 1 to 128 letters, digits, '_' and '-'. Anything else names no agent: a file name and a key are made from it. */
export const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** The main agent's last tool labels kept per session. */
export const MAX_RECENT_ACTIONS = 10;
/** The longest last answer kept, in code points. */
export const ANSWER_MAX = 2000;

export function newSession(id: string, ts: number, workspace: Workspace): Session {
  return {
    id,
    agentKind: 'claude-code',
    location: 'local',
    pid: null,
    name: null,
    tmuxPane: null,
    tmuxSession: null,
    transcriptPath: null,
    workspace,
    state: 'idle',
    stateSince: ts,
    waitReason: null,
    waitAgentId: null,
    title: null,
    firstPrompt: null,
    lastPrompt: null,
    lastAction: null,
    lastActionAt: null,
    openTool: null,
    backgroundTasks: 0,
    children: [],
    runs: [],
    recentActions: [],
    lastAnswer: null,
    lastAnswerAt: null,
    lastPromptAt: null,
    summary: null,
    startedAt: ts,
    lastEventAt: 0,
    lastSeq: -1,
    seenAt: null,
  };
}

function isNewer(s: Session, e: CollectorEvent): boolean {
  return e.ts > s.lastEventAt || (e.ts === s.lastEventAt && e.seq > s.lastSeq);
}

function setState(s: Session, state: SessionState, ts: number): Session {
  return s.state === state ? s : { ...s, state, stateSince: ts };
}

function withChild(s: Session, id: string, patch: Partial<ChildAgent> & { updatedAt: number }): Session {
  const i = s.children.findIndex((c) => c.id === id);
  let children: ChildAgent[];
  if (i === -1) {
    const child: ChildAgent = {
      id,
      type: patch.type ?? 'agent',
      description: patch.description ?? null,
      running: patch.running ?? true,
      lastAction: patch.lastAction ?? null,
      updatedAt: patch.updatedAt,
      ...(patch.smoking ? { smoking: true } : {}),
    };
    children = [...s.children, child];
  } else {
    children = s.children.map((c, k) => {
      if (k !== i) return c;
      // An event's word on a subagent is newer than what it was restored with.
      const { restored: _restored, ...known } = c;
      return { ...known, ...patch };
    });
  }
  if (children.length > MAX_CHILDREN) {
    const drop = children.findIndex((c) => !c.running);
    if (drop !== -1) children = children.filter((_, k) => k !== drop);
  }
  return { ...s, children };
}

/**
 * A workflow run that still goes on: running, and either confirmed on disk or with an agent still running. A run seen
 * only through the hooks has no end there, so it lives while its agents run (rule R7). Rooms, desks and meetings all
 * go by this.
 */
export function liveRun(r: WorkflowRun): boolean {
  return r.status === 'running' && (r.onDisk || r.agents.some((a) => a.running));
}

/** Work that holds a finished turn in a meeting: a running subagent, or a live workflow run. */
function liveWork(s: Session): boolean {
  return s.children.some((c) => c.running) || s.runs.some(liveRun);
}

/** A run known only by its id. */
function placeholderRun(id: string, ts: number): WorkflowRun {
  return { id, name: null, summary: null, phases: [], currentPhase: null, status: 'running', onDisk: false, startedAt: ts, endedAt: null, agents: [], agentsFinished: 0 };
}

/** The index of the item that started first among those `droppable` accepts; -1 when there is none. */
function oldest<T extends { startedAt: number }>(items: T[], droppable: (item: T) => boolean): number {
  let at = -1;
  items.forEach((item, i) => {
    if (droppable(item) && (at === -1 || item.startedAt < items[at]!.startedAt)) at = i;
  });
  return at;
}

/**
 * Changes the run with this id, a placeholder starting at `ts` when there is none. Runs stay in start order, at most
 * MAX_RUNS: the oldest one that no longer goes on leaves first, finished or seen only through the hooks with nothing left
 * running.
 */
function withRun(s: Session, id: string, ts: number, change: (r: WorkflowRun) => WorkflowRun): Session {
  const i = s.runs.findIndex((r) => r.id === id);
  let runs = i === -1 ? [...s.runs, change(placeholderRun(id, ts))] : s.runs.map((r, k) => (k === i ? change(r) : r));
  if (runs.length > MAX_RUNS) {
    const drop = oldest(runs, (r) => !liveRun(r));
    if (drop !== -1) runs = runs.filter((_, k) => k !== drop);
  }
  return { ...s, runs: runs.sort((a, b) => a.startedAt - b.startedAt) };
}

/** The run one of whose agents has this id. */
function runOfAgent(s: Session, agentId: string): WorkflowRun | undefined {
  return s.runs.find((r) => r.agents.some((a) => a.id === agentId));
}

/** Whether a run dropped this agent, which had finished. */
function droppedAgent(s: Session, agentId: string): boolean {
  return s.runs.some((r) => r.droppedAgents?.includes(agentId));
}

/** Changes one agent of a run. */
function withRunAgent(r: WorkflowRun, agentId: string, change: (a: RunAgent) => RunAgent): WorkflowRun {
  return { ...r, agents: r.agents.map((a) => (a.id === agentId ? change(a) : a)) };
}

/** Every running agent of the run stops, and counts as finished. */
function stopAgents(r: WorkflowRun, ts: number): WorkflowRun {
  const running = r.agents.filter((a) => a.running).length;
  if (running === 0) return r;
  return { ...r, agents: r.agents.map((a) => (a.running ? { ...a, running: false, updatedAt: Math.max(a.updatedAt, ts) } : a)), agentsFinished: r.agentsFinished + running };
}

/** A finished turn goes back to a meeting while this run goes on. */
function meetWhileRunning(s: Session, runId: string, ts: number): Session {
  return s.state === 'done' && s.runs.some((r) => r.id === runId && r.status === 'running') ? setState(s, 'in_meeting', ts) : s;
}

/**
 * An agent of a workflow run starts. It leaves the children: its tool events can come before its start. A new agent runs
 * while its run does; one already known only learns what it lacked, and never starts running again.
 */
function startRunAgent(s: Session, e: EventOf<'agent.started'>, runId: string): Session {
  const phase = e.phase ?? null;
  const next = withRun({ ...s, children: s.children.filter((c) => c.id !== e.agentId) }, runId, e.ts, (r) => {
    const known = r.agents.some((a) => a.id === e.agentId);
    const latest = phase !== null && r.agents.every((a) => a.id === e.agentId || a.startedAt <= e.ts);
    const agents = known
      ? r.agents.map((a) => (a.id !== e.agentId ? a : {
        ...a,
        label: a.label ?? e.description ?? null,
        phase: a.phase ?? phase,
        type: a.type === 'agent' && e.agentType ? e.agentType : a.type,
        updatedAt: Math.max(a.updatedAt, e.ts),
      }))
      : [...r.agents, { id: e.agentId, label: e.description ?? null, phase, type: e.agentType || 'agent', running: r.status === 'running', startedAt: e.ts, updatedAt: e.ts }];
    const drop = agents.length > MAX_RUN_AGENTS ? oldest(agents, (a) => !a.running) : -1;
    const dropped = drop === -1 ? [] : agents.splice(drop, 1).map((a) => a.id);
    return {
      ...r,
      agents,
      ...(dropped.length ? { droppedAgents: [...(r.droppedAgents ?? []), ...dropped].slice(-MAX_DROPPED_AGENTS) } : {}),
      currentPhase: latest ? phase : r.currentPhase,
      onDisk: r.onDisk || e.source === 'fs',
    };
  });
  return meetWhileRunning(next, runId, e.ts);
}

/**
 * A subagent's step or end after the wait it raised ends that wait, as an ordered event: back to the session's open tool
 * (the Agent call it runs in), else to the meeting. Another subagent's event, or an older one, leaves the wait.
 */
function endAgentWait(s: Session, e: CollectorEvent, agentId: string): Session {
  if (s.state !== 'needs_you' || s.waitAgentId !== agentId || !isNewer(s, e)) return s;
  return { ...setState(s, s.openTool ? 'working' : 'in_meeting', e.ts), waitReason: null, waitAgentId: null, lastEventAt: e.ts, lastSeq: e.seq };
}

/** After a child finishes during a meeting: count it off; with nothing left running, the meeting is done. */
function settleMeeting(s: Session, ts: number): Session {
  if (s.state !== 'in_meeting') return s;
  const backgroundTasks = Math.max(0, s.backgroundTasks - 1);
  if (backgroundTasks > 0 || liveWork(s)) return { ...s, backgroundTasks };
  return { ...setState(s, 'done', ts), backgroundTasks: 0, seenAt: null };
}

function applyStatus(s: Session, e: EventOf<'session.status'>): Session {
  switch (e.status) {
    case 'busy':
      if (s.state === 'working' || s.state === 'no_signal') return s;
      return { ...setState(s, 'working', e.ts), waitReason: null, waitAgentId: null, seenAt: null };
    case 'waiting':
      if (s.state === 'needs_you') return s;
      return { ...setState(s, 'needs_you', e.ts), waitReason: { kind: 'input', text: e.waitingFor ?? 'Waiting for you' }, waitAgentId: null };
    case 'idle': {
      if (!['working', 'no_signal', 'needs_you', 'in_meeting'].includes(s.state)) return s;
      return { ...setState(s, liveWork(s) ? 'in_meeting' : 'done', e.ts), waitReason: null, waitAgentId: null, openTool: null, seenAt: null };
    }
  }
}

export function applyEvent(prev: Session | undefined, e: CollectorEvent): Session | undefined {
  if (!prev) {
    if (e.type !== 'session.seen') return undefined;
    prev = { ...newSession(e.sessionId, e.ts, e.workspace), agentKind: e.agentKind ?? 'claude-code' };
  }
  let s = prev;

  // Order-free facts: applied whatever the event's age.
  switch (e.type) {
    case 'session.focus':
      return { ...s, tmuxPane: e.tmuxPane, tmuxSession: e.tmuxSession };
    case 'session.seen':
      return {
        ...s,
        agentKind: e.agentKind ?? s.agentKind,
        workspace: { ...e.workspace, branch: e.workspace.branch ?? s.workspace.branch },
        pid: e.pid ?? s.pid,
        name: e.name ?? s.name,
        // A pane and its tmux session come from one tmux field: take them together.
        ...(e.tmuxPane != null ? { tmuxPane: e.tmuxPane, tmuxSession: e.tmuxSession ?? null } : {}),
        transcriptPath: e.transcriptPath ?? s.transcriptPath,
        startedAt: Math.min(s.startedAt, e.startedAt ?? s.startedAt),
      };
    case 'title':
      return { ...s, title: e.title };
    case 'branch':
      return e.branch ? { ...s, workspace: { ...s.workspace, branch: e.branch } } : s;
    case 'agent.started': {
      // An agent a run dropped has finished: its start, read again, starts nothing.
      if (droppedAgent(s, e.agentId)) return s;
      // A run id that is not one makes a plain subagent. An agent a run already has stays the run's, whoever reports it.
      const runId = e.runId && RUN_ID.test(e.runId) ? e.runId : runOfAgent(s, e.agentId)?.id;
      if (runId) return startRunAgent(s, e, runId);
      // A subagent a hook ended does not start again on the filesystem's word of a transcript written before that end. One
      // a restart stopped was not ended: the filesystem may start it on a transcript as old as what the store kept of it.
      const known = s.children.find((c) => c.id === e.agentId);
      if (e.source === 'fs' && known && !known.running && !known.restored && known.updatedAt >= e.ts) return s;
      return withChild(s, e.agentId, { type: e.agentType, description: e.description, running: true, updatedAt: e.ts });
    }
    case 'agent.finished':
      // A finish inferred from a transcript gone quiet (fs) proves nothing about a wait, as the subagent is quiet while it waits: only a hook's ends it.
      {
        // Children first; then a run's agent. An agent a run dropped was counted when it finished. An id nobody knows makes
        // no subagent: it is the engine's own loop, or an agent whose start was missed, and there is nothing to show of it.
        const child = s.children.find((c) => c.id === e.agentId);
        const run = child ? undefined : runOfAgent(s, e.agentId);
        if (!child && !run && droppedAgent(s, e.agentId)) return s;
        const finished = run
          ? withRun(s, run.id, e.ts, (r) => {
            const stopped = r.agents.some((a) => a.id === e.agentId && a.running)
              ? { ...withRunAgent(r, e.agentId, (a) => ({ ...a, running: false, updatedAt: Math.max(a.updatedAt, e.ts), ...(a.smoking ? { smoking: false } : {}) })), agentsFinished: r.agentsFinished + 1 }
              : r;
            return { ...stopped, onDisk: r.onDisk || e.source === 'fs' };
          })
          : child
            ? withChild(s, e.agentId, { running: false, updatedAt: e.ts, ...(child.smoking ? { smoking: false } : {}) })
            : s;
        return settleMeeting(e.source === 'fs' ? finished : endAgentWait(finished, e, e.agentId), e.ts);
      }
    case 'tool.started':
    case 'tool.finished': {
      if (!e.agentId) break;
      const run = runOfAgent(s, e.agentId);
      const smoke = e.type === 'tool.started' && e.smoke === true;
      // A run's agent acting: no child is made for it.
      if (run) {
        return endAgentWait(withRun(s, run.id, e.ts, (r) => withRunAgent(r, e.agentId!, (a) => ({
          ...a,
          updatedAt: Math.max(a.updatedAt, e.ts),
          ...(smoke ? { smoking: true } : e.type === 'tool.finished' && a.smoking ? { smoking: false } : {}),
        }))), e, e.agentId);
      }
      const prior = s.children.find((c) => c.id === e.agentId);
      const patch = e.type === 'tool.started'
        ? { lastAction: e.label, running: true, updatedAt: e.ts, ...(smoke ? { smoking: true } : {}) }
        : { updatedAt: e.ts, ...(prior?.smoking ? { smoking: false } : {}) };
      return endAgentWait(withChild(s, e.agentId, patch), e, e.agentId);
    }
    case 'workflow.started': {
      if (!RUN_ID.test(e.runId)) return s;
      const fields = Boolean(e.name || e.summary || e.phases?.length);
      // What the filesystem reads of a run fills a run the session holds. Only a bare start, or the demo's, makes one: a
      // run the session let go of is not brought back by its end file.
      if (fields && e.source === 'fs' && !s.runs.some((r) => r.id === e.runId)) return s;
      const next = withRun(s, e.runId, e.ts, (r) => {
        // A finished run goes on again only on the filesystem's bare word that it started after its end: resumed under its id.
        const resumed = !fields && e.source === 'fs' && r.status !== 'running' && r.endedAt !== null && e.ts > r.endedAt;
        return {
          ...r,
          name: r.name ?? (e.name || null),
          summary: r.summary ?? (e.summary || null),
          phases: r.phases.length === 0 && e.phases?.length ? [...e.phases] : r.phases,
          startedAt: Math.min(r.startedAt, e.ts),
          onDisk: r.onDisk || e.source === 'fs',
          ...(resumed ? { status: 'running' as const, endedAt: null } : {}),
        };
      });
      return meetWhileRunning(next, e.runId, e.ts);
    }
    case 'workflow.finished': {
      if (!RUN_ID.test(e.runId)) return s;
      const held = s.runs.find((r) => r.id === e.runId);
      // A run that has finished keeps its end: the same end read again changes nothing, and a later word on how it ended
      // changes only that. It held no meeting.
      if (held && held.status !== 'running') {
        const onDisk = held.onDisk || e.source === 'fs';
        return held.status === e.status && held.onDisk === onDisk ? s : withRun(s, e.runId, e.ts, (r) => ({ ...r, status: e.status, onDisk }));
      }
      const ended = withRun(s, e.runId, Math.min(e.startedAt ?? e.ts, e.ts), (r) => ({ ...stopAgents(r, e.ts), status: e.status, endedAt: e.ts, onDisk: r.onDisk || e.source === 'fs' }));
      // An end the filesystem read after the meeting began, stamped as its file says, ends the meeting no earlier than it began.
      return settleMeeting(ended, Math.max(e.ts, s.stateSince));
    }
    case 'answer': {
      // The mod and the transcript both report replies: the latest one wins.
      const text = truncate(e.text, ANSWER_MAX);
      if (!text || (s.lastAnswerAt !== null && e.ts < s.lastAnswerAt)) return s;
      return { ...s, lastAnswer: text, lastAnswerAt: e.ts };
    }
  }

  // When the user last asked something counts whatever the order prompts arrive in.
  if (e.type === 'prompt' && e.text) s = { ...s, lastPromptAt: Math.max(s.lastPromptAt ?? 0, e.ts) };

  if (!isNewer(s, e)) {
    if (e.type === 'prompt' && e.text && !s.firstPrompt) return { ...s, firstPrompt: e.text };
    return s;
  }
  s = { ...s, lastEventAt: e.ts, lastSeq: e.seq };

  switch (e.type) {
    case 'session.started':
      return { ...setState(s, 'idle', e.ts), waitReason: null, waitAgentId: null, openTool: null };
    case 'prompt':
      return {
        ...setState(s, 'working', e.ts),
        waitReason: null,
        waitAgentId: null,
        seenAt: null,
        lastPrompt: e.text ?? s.lastPrompt,
        firstPrompt: s.firstPrompt ?? e.text,
      };
    case 'tool.started':
      return {
        ...setState(s, 'working', e.ts),
        waitReason: null,
        waitAgentId: null,
        openTool: { id: e.toolId, label: e.label, startedAt: e.ts, smoking: e.smoke === true },
        lastAction: e.label,
        lastActionAt: e.ts,
        recentActions: s.recentActions.at(-1) === e.label ? s.recentActions : [...s.recentActions, e.label].slice(-MAX_RECENT_ACTIONS),
      };
    case 'tool.finished': {
      const closes = s.openTool && (e.toolId === null || s.openTool.id === e.toolId);
      return { ...setState(s, s.state === 'ended' ? 'ended' : 'working', e.ts), waitReason: null, waitAgentId: null, openTool: closes ? null : s.openTool };
    }
    case 'waiting': {
      const pending = s.state === 'needs_you';
      const keep = pending && s.waitReason?.kind === e.reason.kind && s.waitReason.detail && !e.reason.detail;
      // One wait is tracked: a wait raised over someone else's is nobody's in particular, so no single subagent's step ends it.
      const waitAgentId = keep ? s.waitAgentId : pending && s.waitAgentId !== e.agentId ? null : e.agentId;
      return { ...setState(s, 'needs_you', e.ts), waitReason: keep ? s.waitReason : e.reason, waitAgentId };
    }
    case 'turn.finished': {
      const meeting = e.backgroundTasks > 0 || liveWork(s);
      return {
        ...setState(s, meeting ? 'in_meeting' : 'done', e.ts),
        backgroundTasks: e.backgroundTasks,
        waitReason: null,
        waitAgentId: null,
        openTool: null,
        seenAt: null,
      };
    }
    case 'session.status':
      return applyStatus(s, e);
    case 'session.ended':
      // Its process is gone: so is everything it ran. A run still going was killed with it.
      return {
        ...setState(s, 'ended', e.ts),
        waitReason: null,
        waitAgentId: null,
        openTool: null,
        children: s.children.map((c) => (c.running ? { ...c, running: false } : c)),
        runs: s.runs.map((r) => (r.status === 'running' ? { ...stopAgents(r, e.ts), status: 'killed', endedAt: e.ts } : stopAgents(r, e.ts))),
      };
  }
  return s;
}

/**
 * A session as the store kept it, ready for this version: what a row saved by an older version lacks takes its default.
 * Its subagents that ran are marked restored and run on, holding a meeting as before, until they are settled
 * (settleRestored): the filesystem's first scan and the next hook event report on the live ones first. The agents of a
 * run seen only through the mod stop, and count as finished. A run the filesystem confirmed keeps its agents as stored:
 * its journal and its end file, read again, correct them. Runs keep their status. A meeting that nothing holds any more
 * ended while the daemon was away: the session is done, as of when its meeting began, so it is no news.
 */
export function normalizeSession(raw: Session): Session {
  const s: Session = {
    ...raw,
    children: (raw.children ?? []).map((c) => (c.running ? { ...c, restored: true } : c)),
    runs: (raw.runs ?? []).map((r) => (r.onDisk ? r : stopAgents(r, -Infinity))),
    recentActions: raw.recentActions ?? [],
    lastAnswer: raw.lastAnswer ?? null,
    lastAnswerAt: raw.lastAnswerAt ?? null,
    lastPromptAt: raw.lastPromptAt ?? null,
    summary: raw.summary ?? null,
  };
  return s.state === 'in_meeting' && !liveWork(s) ? { ...s, state: 'done' } : s;
}

/**
 * Stops the restored subagents that nothing has reported on since the restart: no sign says they still run. A meeting
 * only they held ended while the daemon was away: the session is done, as of when its meeting began, so it is no news.
 * The same session when there is nothing to stop.
 */
export function settleRestored(s: Session): Session {
  if (!s.children.some((c) => c.running && c.restored)) return s;
  const settled = { ...s, children: s.children.map((c) => (c.running && c.restored ? { ...c, running: false } : c)) };
  return settled.state === 'in_meeting' && !liveWork(settled) ? { ...settled, state: 'done' } : settled;
}

/** The user has looked at a finished session. Only 'done' sessions change; a 'done' stamped ahead of this clock counts as seen from its own time. */
export function markSeen(s: Session, now: number): Session {
  return s.state === 'done' ? { ...s, seenAt: Math.max(now, s.stateSince) } : s;
}
