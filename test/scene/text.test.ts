import { describe, expect, it } from 'vitest';
import { cleanOrNull, cleanText, formatAgo, KEY_MAX, reasonText, STATE_LABEL, taskTitle } from '../../src/scene/text.js';

describe('cleanText', () => {
  it('removes terminal escapes, bells and NULs', () => {
    expect(cleanText('\u001b[31mred\u001b[0m\u0007 alert\u0000')).toBe('[31mred[0m alert');
  });

  it('removes C1 controls and bidi formatting characters', () => {
    expect(cleanText('a\u0085b\u009bc')).toBe('abc');
    expect(cleanText('report\u202Etxt.exe \u2066x\u2069 \u200Fy\u061C\u200E')).toBe('reporttxt.exe x y');
  });

  it('collapses whitespace, line breaks included, and trims', () => {
    expect(cleanText('  one\r\ntwo\tthree\fafter \u001b  four  ')).toBe('one two three after four');
    expect(cleanText('a\rb')).toBe('a b');
  });

  it('cuts at max code points with an ellipsis, never inside a surrogate pair', () => {
    expect(cleanText('abcdef', 4)).toBe('abc…');
    expect(cleanText('abcd', 4)).toBe('abcd');
    expect(cleanText('x'.repeat(300))).toHaveLength(200);
    expect(cleanText('\u{1F600}\u{1F600}\u{1F600}\u{1F600}', 3)).toBe('\u{1F600}\u{1F600}…');
    expect(cleanText('\u{1F600}\u{1F600}\u{1F600}', 3)).toBe('\u{1F600}\u{1F600}\u{1F600}');
    expect(cleanText('abc', 0)).toBe('');
  });

  it('stringifies numbers and booleans and turns anything else into an empty string', () => {
    expect(cleanText(42)).toBe('42');
    expect(cleanText(true)).toBe('true');
    expect(cleanText(null)).toBe('');
    expect(cleanText(undefined)).toBe('');
    expect(cleanText({ toString: () => 'x' })).toBe('');
  });

  it('keeps a key cut at KEY_MAX within 512 UTF-16 code units', () => {
    expect(cleanText('\u{1F600}'.repeat(400), KEY_MAX).length).toBeLessThanOrEqual(512);
  });
});

describe('cleanOrNull', () => {
  it('returns null when nothing is left', () => {
    expect(cleanOrNull(' \u001b\u0007 ')).toBeNull();
    expect(cleanOrNull(null)).toBeNull();
    expect(cleanOrNull(' ok ')).toBe('ok');
    expect(cleanOrNull('abcdef', 4)).toBe('abc…');
  });
});

describe('taskTitle', () => {
  it('prefers the title, then the latest prompt, then the first, skipping empty ones', () => {
    expect(taskTitle({ title: 'Fix\u0007 checkout', lastPrompt: 'b', firstPrompt: 'a' })).toBe('Fix checkout');
    expect(taskTitle({ title: ' \u001b ', lastPrompt: 'latest', firstPrompt: 'first' })).toBe('latest');
    expect(taskTitle({ title: null, lastPrompt: null, firstPrompt: 'first' })).toBe('first');
    expect(taskTitle({ title: null, lastPrompt: null, firstPrompt: null })).toBeNull();
  });
});

describe('formatAgo', () => {
  it('uses the largest sensible unit', () => {
    expect([0, 59_000, 60_000, 3_600_000, 47 * 3_600_000, 48 * 3_600_000].map(formatAgo)).toEqual(['0s', '59s', '1m', '1h', '47h', '2d']);
  });
});

describe('reasonText', () => {
  it('shows the detail in brackets, and a default without a reason', () => {
    expect(reasonText({ text: 'Bash', detail: 'Bash: rm -rf dist' })).toBe('Bash (Bash: rm -rf dist)');
    expect(reasonText({ text: 'Plan approval', detail: null })).toBe('Plan approval');
    expect(reasonText({ text: 'Which database?' })).toBe('Which database?');
    expect(reasonText(null)).toBe('Needs you');
  });
});

describe('STATE_LABEL', () => {
  it('names every state in words', () => {
    expect(STATE_LABEL).toEqual({
      working: 'working',
      needs_you: 'needs you',
      done: 'done',
      in_meeting: 'in meeting',
      no_signal: 'no signal',
      idle: 'idle',
      dormant: 'dormant',
      ended: 'ended',
    });
  });
});
