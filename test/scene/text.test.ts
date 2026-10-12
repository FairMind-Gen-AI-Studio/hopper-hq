import { describe, expect, it } from 'vitest';
import { cleanOrNull, cleanText, formatAgo, isSessionId, KEY_MAX, reasonText, STATE_LABEL, taskTitle } from '../../src/scene/text.js';

describe('cleanText', () => {
  it('removes terminal escapes, bells and NULs', () => {
    expect(cleanText('\u001b[31mred\u001b[0m\u0007 alert\u0000')).toBe('[31mred[0m alert');
  });

  it('removes C1 controls and bidi formatting characters', () => {
    expect(cleanText('a\u009bc')).toBe('ac');
    expect(cleanText('report\u202Etxt.exe \u2066x\u2069 \u200Fy\u061C\u200E')).toBe('reporttxt.exe x y');
  });

  it('removes invisible format characters, but keeps the joiners that emoji and scripts need', () => {
    expect(cleanText('ad\u200Bmin \u2060x\u00ADy \u{E0001}z')).toBe('admin xy z');
    expect(cleanText('\u{1F469}\u200D\u{1F4BB} \u0645\u200C\u0646')).toBe('\u{1F469}\u200D\u{1F4BB} \u0645\u200C\u0646');
  });

  it('keeps the tag characters that draw a subdivision flag', () => {
    const scotland = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}';
    expect(cleanText(`go ${scotland}!`)).toBe(`go ${scotland}!`);
    expect(cleanText(`${scotland}\u200B\u{E0001}`)).toBe(scotland);
  });

  it('replaces a lone surrogate with U+FFFD, so that the text is well formed and goes into a URL', () => {
    expect(cleanText('a\ud800b')).toBe('a\uFFFDb');
    expect(cleanText('\udc00x\ud83d')).toBe('\uFFFDx\uFFFD');
    expect(cleanText('\udc00\ud800')).toBe('\uFFFD\uFFFD');
    expect(cleanText('ok \u{1F600}')).toBe('ok \u{1F600}');
    expect(cleanText('\ud800'.repeat(5), 3)).toBe('\uFFFD\uFFFD\u2026');
    expect(() => encodeURIComponent(cleanText('/w/a\ud800pi'))).not.toThrow();
  });

  it('reads a next-line character as a line break, which separates words', () => {
    expect(cleanText('one\u0085two')).toBe('one two');
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

describe('isSessionId', () => {
  it('takes letters, digits, dots, underscores and dashes, up to KEY_MAX', () => {
    for (const id of ['7ef904e4-9872-4cca-924f-e7ddde08fc55', '01HZX3V8K4QW2N5M7P9R0S1T2U', 'V1StGXR8_Z5jdHi6B-myT', 'demo-oa-c3', 'S1', 'a.b', '...', 'x'.repeat(KEY_MAX)]) {
      expect([id, isSessionId(id)]).toEqual([id, true]);
    }
  });

  it('refuses dot segments, separators, escapes, spaces, controls and anything over KEY_MAX', () => {
    const bad = ['', '.', '..', '../x', 'a/b', 'a\\b', '%2e%2e', 'a%2Fb', 'a b', 'a\u0000', 'a\u202Eb', 'caf\u00e9', '\ud800', 'a?b', 'a#b', 'x'.repeat(KEY_MAX + 1), 42, null, undefined];
    for (const id of bad) expect([id, isSessionId(id)]).toEqual([id, false]);
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
