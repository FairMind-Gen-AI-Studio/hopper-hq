import { createHash } from 'node:crypto';
import { ANSWER_MAX } from '../core/reducer.js';
import type { Session } from '../core/types.js';
import { cleanText, reasonText, STATE_LABEL } from '../scene/text.js';

export const INPUT_MAX = 4000;
export const SUMMARY_MAX = 120;
export const INSTRUCTION =
  'You write one status line for a developer who runs many coding-agent sessions at once. From the session notes, say where the session stands now: what is done, what is in progress, or what it is waiting for. One line, at most 100 characters, present tense, no preamble, no quotes, no markdown.';

/** Caps, in code points, of the one-line fields. With them, the notes without a reply and actions always fit in INPUT_MAX. */
const TITLE_MAX = 200;
const REQUEST_MAX = 2000;
const ACTION_MAX = 200;
const REASON_MAX = 200;

const points = (text: string): number => Array.from(text).length;

/**
 * The notes a summary is written from, and their hash: the title, the last request, the state, the recent actions and the
 * last reply, each cleaned to one line. Missing values are written '-'. Text over INPUT_MAX code points loses the end of
 * the reply first, then the oldest actions. Null when the session has no title, prompt or reply to go on.
 */
export function summaryInput(
  s: Pick<Session, 'title' | 'firstPrompt' | 'lastPrompt' | 'recentActions' | 'lastAnswer' | 'state' | 'waitReason'>,
): { text: string; hash: string } | null {
  const title = cleanText(s.title, TITLE_MAX);
  const request = cleanText(s.lastPrompt, REQUEST_MAX) || cleanText(s.firstPrompt, REQUEST_MAX);
  const answer = cleanText(s.lastAnswer, ANSWER_MAX);
  if (!title && !request && !answer) return null;
  const state = `${STATE_LABEL[s.state]}${s.waitReason ? `, waiting: ${cleanText(reasonText(s.waitReason), REASON_MAX) || '-'}` : ''}`;
  const head = (actions: string[]): string =>
    [`Title: ${title || '-'}`, `Last request: ${request || '-'}`, `State: ${state}`, 'Recent actions:', ...(actions.length ? actions.map((a) => `- ${a}`) : ['-']), 'Last reply:'].join('\n');
  let actions = s.recentActions.map((a) => cleanText(a, ACTION_MAX)).filter((a) => a !== '');
  let text = `${head(actions)}\n${answer || '-'}`;
  if (points(text) > INPUT_MAX) {
    // The reply's end goes first; when even one character of it does not fit, the oldest actions go too.
    while (actions.length > 0 && points(head(actions)) + 2 > INPUT_MAX) actions = actions.slice(1);
    const room = INPUT_MAX - points(head(actions)) - 1;
    text = `${head(actions)}\n${cleanText(answer, room) || '-'}`;
  }
  return { text, hash: createHash('sha256').update(text).digest('hex').slice(0, 16) };
}
