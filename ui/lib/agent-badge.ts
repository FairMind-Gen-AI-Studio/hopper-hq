import type { AgentKind } from '../../src/core/types';
import codex from '../assets/agents/codex.svg';
import claudeCode from '../assets/agents/claude-code.svg';
import '../styles/agent-badge.css';

export const AGENT_BADGES: Record<AgentKind, { name: string; image: string }> = {
  'claude-code': { name: 'Claude Code', image: claudeCode },
  codex: { name: 'Codex', image: codex },
};

/** A local, fixed-size identity mark. Status stays in the label's separate dot. */
export function agentBadge(kind: AgentKind): HTMLSpanElement {
  const badge = document.createElement('span');
  badge.className = `agent-badge agent-badge--${kind}`;
  badge.setAttribute('role', 'img');
  badge.setAttribute('aria-label', AGENT_BADGES[kind].name);
  const image = document.createElement('img');
  image.src = AGENT_BADGES[kind].image;
  image.alt = '';
  image.width = 18;
  image.height = 18;
  image.draggable = false;
  badge.append(image);
  return badge;
}
