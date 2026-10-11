/**
 * Text hygiene and wording shared by the server, the CLI and the browser. Browser-safe: imports types only.
 * Titles, prompts, tool labels, wait reasons, names, branches and paths come from transcripts and session files:
 * they are untrusted, and every one is cleaned before it is shown.
 */
import type { SessionState } from '../core/types.js';

/** C0 and C1 control characters, except tab and line feed (whitespace, collapsed with the rest). */
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
/** Bidirectional formatting characters: they can make text read differently from what it is. */
const BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** Cap for keys and ids: 256 code points are at most 512 UTF-16 code units, the longest key GET /api/floor accepts. */
export const KEY_MAX = 256;

/**
 * One line of plain text from untrusted input: control and bidi characters removed, whitespace collapsed to single
 * spaces, trimmed, and cut to `max` code points with '…' (never inside a surrogate pair).
 * Numbers and booleans are stringified; anything else that is not a string becomes ''.
 */
export function cleanText(input: unknown, max = 200): string {
  const raw =
    typeof input === 'string' ? input : typeof input === 'number' || typeof input === 'boolean' || typeof input === 'bigint' ? String(input) : '';
  // Whitespace first, so a carriage return or a form feed separates words instead of joining them.
  const text = raw.replace(/\s+/g, ' ').replace(CONTROL, '').replace(BIDI, '').replace(/ {2,}/g, ' ').trim();
  if (text.length <= max) return text;
  const points = Array.from(text);
  if (points.length <= max) return text;
  return max < 1 ? '' : points.slice(0, max - 1).join('') + '…';
}

/** cleanText, or null when nothing is left. */
export function cleanOrNull(input: unknown, max = 200): string | null {
  return cleanText(input, max) || null;
}

/** What a session is about: its title, else its latest prompt, else its first one. Cleaned; null when there is none. */
export function taskTitle(s: { title: string | null; lastPrompt: string | null; firstPrompt: string | null }): string | null {
  return cleanOrNull(s.title) ?? cleanOrNull(s.lastPrompt) ?? cleanOrNull(s.firstPrompt);
}

/** A duration in its largest sensible unit: 42s, 12m, 5h, 3d. */
export function formatAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** A wait reason on one line, with its detail in brackets; 'Needs you' when the reason is unknown. */
export function reasonText(r: { text: string; detail?: string | null } | null): string {
  if (!r) return 'Needs you';
  return r.detail ? `${r.text} (${r.detail})` : r.text;
}

/** Every state in words. */
export const STATE_LABEL: Record<SessionState, string> = {
  working: 'working',
  needs_you: 'needs you',
  done: 'done',
  in_meeting: 'in meeting',
  no_signal: 'no signal',
  idle: 'idle',
  dormant: 'dormant',
  ended: 'ended',
};
