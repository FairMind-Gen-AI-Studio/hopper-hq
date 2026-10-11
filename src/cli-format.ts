import type { AttentionSummary, Snapshot } from './collector.js';
import { truncate } from './core/tool-label.js';
import type { SessionState, WaitReason } from './core/types.js';

export function formatAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length);
}

function reasonText(r: WaitReason | null): string {
  if (!r) return 'Needs you';
  return r.detail ? `${r.text} (${r.detail})` : r.text;
}

const pane = (p: string | null): string => (p ? `  [${p}]` : '');

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
      return `${mark} ${pad(i.name ?? i.id.slice(0, 8), 28)} ${pad(formatAgo(now - i.since), 5)} ${truncate(what, 70)}${pane(i.tmuxPane)}`;
    })
    .join('\n');
}

const MARK: Record<SessionState, string> = {
  needs_you: '◉', done: '✓', working: '●', in_meeting: '◎', no_signal: '…', idle: '○', dormant: '·', ended: '×',
};
const LABEL: Record<SessionState, string> = {
  needs_you: 'needs you', done: 'done', working: 'working', in_meeting: 'in meeting', no_signal: 'no signal', idle: 'idle', dormant: 'dormant', ended: 'ended',
};

export function formatBuilding(s: Snapshot): string {
  if (s.floors.length === 0) return 'No sessions yet.';
  const out: string[] = [];
  for (const f of s.floors) {
    out.push(`${f.name}  (${f.kind === 'feature' ? `feature · ${f.repos.join(', ')}` : 'department'})`);
    for (const v of f.sessions) {
      const detail = v.effectiveState === 'needs_you' ? reasonText(v.waitReason) : (v.title ?? v.lastPrompt ?? v.firstPrompt ?? '');
      const repo = v.workspace.repoName + (v.workspace.worktree ? '*' : '');
      out.push(`  ${MARK[v.effectiveState]} ${pad(LABEL[v.effectiveState], 10)} ${pad(repo, 22)} ${pad(formatAgo(s.generatedAt - v.effectiveSince), 5)} ${truncate(detail, 60)}${pane(v.tmuxPane)}`);
    }
  }
  return out.join('\n');
}
