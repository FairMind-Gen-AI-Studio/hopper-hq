/**
 * Text hygiene and wording shared by the server, the CLI and the browser. Browser-safe: imports types, and palette.ts for its hash.
 * Titles, prompts, tool labels, wait reasons, names, branches and paths come from transcripts and session files:
 * they are untrusted, and every one is cleaned before it is shown.
 */
import type { SessionState } from '../core/types.js';
import { fnv1a32 } from './palette.js';

/** A surrogate pair, or a lone surrogate: half a character, on which encodeURIComponent throws. */
const SURROGATES = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g;
/** Whitespace, and the next-line control (U+0085), which JavaScript does not count as whitespace but which breaks a line. */
const SPACE = /[\s\u0085]+/g;
/** C0 and C1 control characters, except tab and line feed (whitespace, collapsed with the rest). */
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
/**
 * Format characters. Bidirectional ones can make text read differently from what it is; others are invisible: zero-width
 * spaces, word joiners, soft hyphens, the language tag. The zero-width non-joiner and joiner stay: emoji and some scripts
 * need them. The tag characters U+E0020 to U+E007F stay only in a well-formed subdivision flag, such as Scotland's: U+1F3F4,
 * two tag letters (the region), one to four tag letters or digits (the subdivision), then the cancel tag U+E007F (group 1,
 * kept whole). Anywhere else, and in a longer or other run, they would hide ASCII text, and go.
 */
const FORMAT = /(\u{1F3F4}[\u{E0061}-\u{E007A}]{2}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{1,4}\u{E007F})|(?![\u200C\u200D])\p{Cf}/gu;

/** Cap for keys and ids: 256 code points are at most 512 UTF-16 code units, the longest key GET /api/floor accepts. */
export const KEY_MAX = 256;

/**
 * One line of plain text from untrusted input: control and format characters removed, a lone surrogate replaced by
 * U+FFFD, whitespace collapsed to single spaces, trimmed, and cut to `max` code points with '…' (never inside a surrogate pair).
 * Numbers and booleans are stringified; anything else that is not a string becomes ''.
 */
export function cleanText(input: unknown, max = 200): string {
  const raw =
    typeof input === 'string' ? input : typeof input === 'number' || typeof input === 'boolean' || typeof input === 'bigint' ? String(input) : '';
  // Lone surrogates first, so the rest sees whole characters; then whitespace, so a carriage return or a form feed
  // separates words instead of joining them.
  const text = raw.replace(SURROGATES, (s) => (s.length === 2 ? s : '\uFFFD')).replace(SPACE, ' ').replace(CONTROL, '').replace(FORMAT, (match, flag) => (flag ? match : '')).replace(/ {2,}/g, ' ').trim();
  if (text.length <= max) return text;
  const points = Array.from(text);
  if (points.length <= max) return text;
  return max < 1 ? '' : points.slice(0, max - 1).join('') + '…';
}

/** The second seed of a capped key's hash: two 32-bit FNV-1a hashes from different seeds give 16 hex digits. */
const KEY_SEED = 0x9e3779b9;

/**
 * A floor or island key: cleaned (see cleanText) and at most KEY_MAX code points. A longer key keeps its first
 * KEY_MAX - 17 code points, then '~' and 16 hex digits hashed from the whole cleaned key, so two long keys that start
 * alike stay apart. It is never cut inside a surrogate pair.
 */
export function capKey(input: unknown): string {
  const key = cleanText(input, Infinity);
  const points = Array.from(key);
  if (points.length <= KEY_MAX) return key;
  const hash = [fnv1a32(key), fnv1a32(key, KEY_SEED)].map((h) => h.toString(16).padStart(8, '0')).join('');
  return `${points.slice(0, KEY_MAX - 17).join('')}~${hash}`;
}

/**
 * A session id the building can carry: 1 to KEY_MAX letters, digits, dots, underscores or dashes, and not '.' or '..'.
 * Ids come from hook payloads and session files. Claude Code's are UUIDs, and other agents' (ULIDs, nanoids) fit too.
 * Such an id is unchanged by cleanText, so the scene names a session by its real id; it goes into a file name and a URL
 * path as it is, where only a dot segment could change what it points at ('/api/sessions/../seen' is '/api/seen').
 */
export function isSessionId(id: unknown): id is string {
  return typeof id === 'string' && id.length <= KEY_MAX && /^[A-Za-z0-9._-]+$/.test(id) && id !== '.' && id !== '..';
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

/** `server` reduced to bare lowercase letters/digits, so 'Google_Calendar', 'google-calendar' and 'GoogleCalendar'
 * all land on one `BRAND_NAME` entry — the same leniency `ui/facade/geometry.ts`'s own `glyphKeyOf` already
 * established for its eight traced glyphs, reapplied here since both are "a server name, matched loosely" lookups. */
function normalizeServer(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Known MCP servers' own brand spelling ("friendly server names" follow-up: the rooftop tag, the antenna tooltip,
 * the DOM chip and the side panel's "Running" line all showed a server token verbatim — 'Google_Calendar',
 * 'claude_ai_Notion' before `tool-label.ts`'s own prefix strip, underscores and all — which nobody reading the
 * floor could place). Keyed by `normalizeServer`, so every real spelling `tool-label.ts`'s `resolveServer` can hand
 * back for the same server (the plugin-qualified form, the claude.ai connector form, or the plain one) resolves to
 * one entry. Lives here, not in tool-label.ts itself: both the server (building the DOM chip's own label) and the
 * browser (the façade's antenna tag/tooltip, ui/lib/words.ts) need it, and only this module is shared with both.
 */
const BRAND_NAME: ReadonlyMap<string, string> = new Map(
  Object.entries({
    clickup: 'ClickUp',
    slack: 'Slack',
    notion: 'Notion',
    gmail: 'Gmail',
    googlecalendar: 'Google Calendar',
    googledrive: 'Google Drive',
    googlesheets: 'Google Sheets',
    microsoft365: 'Microsoft 365',
    mongodb: 'MongoDB',
    playwright: 'Playwright',
    fireflies: 'Fireflies',
    chrome: 'Chrome',
    fairmind: 'FairMind',
    memory: 'Memory',
  }),
);

/** One word, Title Cased: 'web' -> 'Web'. The fallback for a server outside `BRAND_NAME` — it makes no attempt at
 * a real acronym or brand casing it does not already know (that is what the table above is for). */
function titleWord(w: string): string {
  return w ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w;
}

/**
 * A server token's own readable display name: `BRAND_NAME`'s own spelling for a known one, else its underscores
 * turned to spaces and each word Title Cased ('my_internal_server' -> 'My Internal Server'). Never the identity a
 * caller looks anything else up by — `ActiveLine.server`/`McpCall.server` (and `ui/facade/geometry.ts`'s own
 * `glyphKeyOf`/`scene/palette.ts`'s own `slotOf`) all keep the raw, canonical token this function only ever
 * formats for a person to read, never overwrites.
 */
export function friendlyServer(server: string): string {
  const known = BRAND_NAME.get(normalizeServer(server));
  if (known) return known;
  const words = server.replace(/_/g, ' ').split(/\s+/).filter(Boolean);
  return words.length ? words.map(titleWord).join(' ') : server;
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
