import type { AttentionSummary, Snapshot } from './collector.js';
import type { SessionState } from './core/types.js';
import { cleanText, formatAgo, reasonText, STATE_LABEL } from './scene/text.js';

export { formatAgo };

function pad(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length);
}

const pane = (p: string | null): string => (p ? `  [${cleanText(p)}]` : '');

export function formatTmux(a: Pick<AttentionSummary, 'needsYou' | 'done'>): string {
  const parts: string[] = [];
  if (a.needsYou > 0) parts.push(`#[fg=colour203,bold]◉${a.needsYou}#[default]`);
  if (a.done > 0) parts.push(`#[fg=colour114]✓${a.done}#[default]`);
  return parts.join(' ');
}

export function formatAttentionText(a: AttentionSummary, now: number): string {
  if (a.items.length === 0) return 'Nobody is waiting for you.';
  return a.items
    .map((i) => {
      const mark = i.state === 'needs_you' ? '◉' : '✓';
      const what = i.state === 'needs_you' ? reasonText(i.reason) : (i.title ?? 'Finished');
      return `${mark} ${pad(cleanText(i.name ?? i.id.slice(0, 8)), 28)} ${pad(formatAgo(now - i.since), 5)} ${cleanText(what, 70)}${pane(i.tmuxPane)}`;
    })
    .join('\n');
}

const MARK: Record<SessionState, string> = {
  needs_you: '◉', done: '✓', working: '●', in_meeting: '◎', no_signal: '…', idle: '○', dormant: '·', ended: '×',
};

export function formatBuilding(s: Snapshot): string {
  if (s.floors.length === 0) return 'No sessions yet.';
  const out: string[] = [];
  for (const f of s.floors) {
    out.push(`${cleanText(f.name)}  (${f.kind === 'feature' ? `feature · ${f.repos.map((r) => cleanText(r)).join(', ')}` : 'department'})`);
    for (const v of f.sessions) {
      const detail = v.effectiveState === 'needs_you' ? reasonText(v.waitReason) : (v.title ?? v.lastPrompt ?? v.firstPrompt ?? '');
      const repo = cleanText(v.workspace.repoName) + (v.workspace.worktree ? '*' : '');
      out.push(`  ${MARK[v.effectiveState]} ${pad(STATE_LABEL[v.effectiveState], 10)} ${pad(repo, 22)} ${pad(formatAgo(s.generatedAt - v.effectiveSince), 5)} ${cleanText(detail, 60)}${pane(v.tmuxPane)}`);
    }
  }
  return out.join('\n');
}
