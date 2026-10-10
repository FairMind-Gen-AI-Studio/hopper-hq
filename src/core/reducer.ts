import type { ChildAgent, CollectorEvent, EventOf, Session, SessionState, Workspace } from './types.js';

const MAX_CHILDREN = 50;

export function newSession(id: string, ts: number, workspace: Workspace): Session {
  return {
    id,
    agentKind: 'claude-code',
    location: 'local',
    pid: null,
    name: null,
    tmuxPane: null,
    transcriptPath: null,
    workspace,
    state: 'idle',
    stateSince: ts,
    waitReason: null,
    title: null,
    firstPrompt: null,
    lastPrompt: null,
    lastAction: null,
    lastActionAt: null,
    openTool: null,
    backgroundTasks: 0,
    children: [],
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
    };
    children = [...s.children, child];
  } else {
    children = s.children.map((c, k) => (k === i ? { ...c, ...patch } : c));
  }
  if (children.length > MAX_CHILDREN) {
    const drop = children.findIndex((c) => !c.running);
    if (drop !== -1) children = children.filter((_, k) => k !== drop);
  }
  return { ...s, children };
}

/** After a child finishes during a meeting: count it off; with nothing left running, the meeting is done. */
function settleMeeting(s: Session, ts: number): Session {
  if (s.state !== 'in_meeting') return s;
  const backgroundTasks = Math.max(0, s.backgroundTasks - 1);
  if (backgroundTasks > 0 || s.children.some((c) => c.running)) return { ...s, backgroundTasks };
  return { ...setState(s, 'done', ts), backgroundTasks: 0, seenAt: null };
}

function applyStatus(s: Session, e: EventOf<'session.status'>): Session {
  switch (e.status) {
    case 'busy':
      if (s.state === 'working' || s.state === 'no_signal') return s;
      return { ...setState(s, 'working', e.ts), waitReason: null, seenAt: null };
    case 'waiting':
      if (s.state === 'needs_you') return s;
      return { ...setState(s, 'needs_you', e.ts), waitReason: { kind: 'input', text: e.waitingFor ?? 'Waiting for you' } };
    case 'idle': {
      if (!['working', 'no_signal', 'needs_you', 'in_meeting'].includes(s.state)) return s;
      const meeting = s.children.some((c) => c.running);
      return { ...setState(s, meeting ? 'in_meeting' : 'done', e.ts), waitReason: null, openTool: null, seenAt: null };
    }
  }
}

export function applyEvent(prev: Session | undefined, e: CollectorEvent): Session | undefined {
  if (!prev) {
    if (e.type !== 'session.seen') return undefined;
    prev = newSession(e.sessionId, e.ts, e.workspace);
  }
  let s = prev;

  // Order-free facts: applied whatever the event's age.
  switch (e.type) {
    case 'session.seen':
      return {
        ...s,
        workspace: { ...e.workspace, branch: e.workspace.branch ?? s.workspace.branch },
        pid: e.pid ?? s.pid,
        name: e.name ?? s.name,
        tmuxPane: e.tmuxPane ?? s.tmuxPane,
        transcriptPath: e.transcriptPath ?? s.transcriptPath,
        startedAt: Math.min(s.startedAt, e.startedAt ?? s.startedAt),
      };
    case 'title':
      return { ...s, title: e.title };
    case 'branch':
      return e.branch ? { ...s, workspace: { ...s.workspace, branch: e.branch } } : s;
    case 'agent.started':
      return withChild(s, e.agentId, { type: e.agentType, description: e.description, running: true, updatedAt: e.ts });
    case 'agent.finished':
      return settleMeeting(withChild(s, e.agentId, { running: false, updatedAt: e.ts }), e.ts);
    case 'tool.started':
      if (e.agentId) return withChild(s, e.agentId, { lastAction: e.label, running: true, updatedAt: e.ts });
      break;
    case 'tool.finished':
      if (e.agentId) return withChild(s, e.agentId, { updatedAt: e.ts });
      break;
  }

  if (!isNewer(s, e)) {
    if (e.type === 'prompt' && e.text && !s.firstPrompt) return { ...s, firstPrompt: e.text };
    return s;
  }
  s = { ...s, lastEventAt: e.ts, lastSeq: e.seq };

  switch (e.type) {
    case 'session.started':
      return { ...setState(s, 'idle', e.ts), waitReason: null, openTool: null };
    case 'prompt':
      return {
        ...setState(s, 'working', e.ts),
        waitReason: null,
        seenAt: null,
        lastPrompt: e.text ?? s.lastPrompt,
        firstPrompt: s.firstPrompt ?? e.text,
      };
    case 'tool.started':
      return {
        ...setState(s, 'working', e.ts),
        waitReason: null,
        openTool: { id: e.toolId, label: e.label, startedAt: e.ts },
        lastAction: e.label,
        lastActionAt: e.ts,
      };
    case 'tool.finished': {
      const closes = s.openTool && (e.toolId === null || s.openTool.id === e.toolId);
      return { ...setState(s, s.state === 'ended' ? 'ended' : 'working', e.ts), waitReason: null, openTool: closes ? null : s.openTool };
    }
    case 'waiting': {
      const keep = s.state === 'needs_you' && s.waitReason?.kind === e.reason.kind && s.waitReason.detail && !e.reason.detail;
      return { ...setState(s, 'needs_you', e.ts), waitReason: keep ? s.waitReason : e.reason };
    }
    case 'turn.finished': {
      const meeting = e.backgroundTasks > 0 || s.children.some((c) => c.running);
      return {
        ...setState(s, meeting ? 'in_meeting' : 'done', e.ts),
        backgroundTasks: e.backgroundTasks,
        waitReason: null,
        openTool: null,
        seenAt: null,
      };
    }
    case 'session.status':
      return applyStatus(s, e);
    case 'session.ended':
      return { ...setState(s, 'ended', e.ts), waitReason: null, openTool: null };
  }
  return s;
}

/** The user has looked at a finished session. Only 'done' sessions change; a 'done' stamped ahead of this clock counts as seen from its own time. */
export function markSeen(s: Session, now: number): Session {
  return s.state === 'done' ? { ...s, seenAt: Math.max(now, s.stateSince) } : s;
}
