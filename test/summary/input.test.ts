import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { Session } from '../../src/core/types.js';
import { INPUT_MAX, INSTRUCTION, SUMMARY_MAX, summaryInput } from '../../src/summary/input.js';

type Notes = Parameters<typeof summaryInput>[0];

const NOTES: Notes = {
  title: 'Fix the flaky checkout test',
  firstPrompt: 'Look at the checkout test',
  lastPrompt: 'Make the checkout test pass on CI',
  recentActions: ['Read src/checkout.ts', 'Edit src/checkout.ts', 'Bash: npm test'],
  lastAnswer: 'The test waited on a timer.\nI replaced it with a fake clock.',
  state: 'needs_you',
  waitReason: { kind: 'permission', text: 'Bash', detail: 'Bash: npm test' },
};
const notes = (patch: Partial<Session>): Notes => ({ ...NOTES, ...patch });
const points = (text: string) => Array.from(text).length;

describe('summaryInput', () => {
  it('writes the notes line by line, and names them by the start of their sha256', () => {
    const input = summaryInput(NOTES)!;
    expect(input.text).toBe(
      [
        'Title: Fix the flaky checkout test',
        'Last request: Make the checkout test pass on CI',
        'State: needs you, waiting: Bash (Bash: npm test)',
        'Recent actions:',
        '- Read src/checkout.ts',
        '- Edit src/checkout.ts',
        '- Bash: npm test',
        'Last reply:',
        'The test waited on a timer. I replaced it with a fake clock.',
      ].join('\n'),
    );
    expect(input.hash).toBe(createHash('sha256').update(input.text).digest('hex').slice(0, 16));
    expect(input.hash).toBe('788e965426c6e8c9');
    expect(summaryInput({ ...NOTES })).toEqual(input);
    expect(summaryInput(notes({ state: 'done', waitReason: null }))!.hash).not.toBe(input.hash);
  });

  it('writes a dash for what is missing, and falls back to the first prompt', () => {
    expect(summaryInput(notes({ title: null, lastPrompt: '  ', recentActions: [], lastAnswer: null, state: 'done', waitReason: null }))!.text).toBe(
      ['Title: -', 'Last request: Look at the checkout test', 'State: done', 'Recent actions:', '-', 'Last reply:', '-'].join('\n'),
    );
  });

  it('cleans every field to one line', () => {
    const text = summaryInput(notes({ title: 'Fix\n  the\ttest', lastPrompt: 'Line one\nLine two', recentActions: ['Bash: a\nb', '   '], state: 'done', waitReason: null }))!.text;
    expect(text.split('\n').slice(0, 5)).toEqual(['Title: Fix the test', 'Last request: Line one Line two', 'State: done', 'Recent actions:', '- Bash: a b']);
  });

  it('is null when there is no title, prompt or reply to go on', () => {
    expect(summaryInput(notes({ title: null, firstPrompt: null, lastPrompt: null, lastAnswer: null }))).toBeNull();
    expect(summaryInput(notes({ title: ' ', firstPrompt: '', lastPrompt: null, lastAnswer: '\n' }))).toBeNull();
    expect(summaryInput(notes({ title: null, firstPrompt: null, lastPrompt: null }))).not.toBeNull();
  });

  it('cuts the end of the reply first, to exactly INPUT_MAX code points', () => {
    const long = notes({ title: 'T'.repeat(300), lastPrompt: 'P'.repeat(3000), lastAnswer: 'Done. ' + '\u{1F600}'.repeat(1990) });
    const text = summaryInput(long)!.text;
    expect(points(text)).toBe(INPUT_MAX);
    expect(text).toContain('- Read src/checkout.ts\n- Edit src/checkout.ts\n- Bash: npm test\nLast reply:\nDone. \u{1F600}');
    expect(text.endsWith('\u{1F600}\u2026')).toBe(true);
    expect(points(summaryInput({ ...long, lastAnswer: 'Done.' })!.text)).toBeLessThan(INPUT_MAX);
  });

  it('then drops the oldest actions, keeping as much of the reply as still fits', () => {
    const recentActions = Array.from({ length: 10 }, (_, i) => `Bash: step ${i} ${'x'.repeat(190)}`);
    const input = summaryInput(notes({ title: 'T'.repeat(300), lastPrompt: 'P'.repeat(3000), recentActions, lastAnswer: 'A'.repeat(2000) }))!;
    const lines = input.text.split('\n');
    expect(points(input.text)).toBe(INPUT_MAX);
    expect(lines[0]).toBe(`Title: ${'T'.repeat(199)}\u2026`);
    expect(lines[1]).toBe(`Last request: ${'P'.repeat(1999)}\u2026`);
    expect(lines.filter((l) => l.startsWith('- ')).map((l) => l.slice(2, 14))).toEqual(['Bash: step 2', 'Bash: step 3', 'Bash: step 4', 'Bash: step 5', 'Bash: step 6', 'Bash: step 7', 'Bash: step 8', 'Bash: step 9']);
    expect(lines.at(-2)).toBe('Last reply:');
    expect(lines.at(-1)).toMatch(/^A+\u2026$/);
  });

  it('carries the fixed instruction and caps', () => {
    expect([INPUT_MAX, SUMMARY_MAX]).toEqual([4000, 120]);
    expect(INSTRUCTION).toBe(
      'You write one status line for a developer who runs many coding-agent sessions at once. From the session notes, say where the session stands now: what is done, what is in progress, or what it is waiting for. One line, at most 100 characters, present tense, no preamble, no quotes, no markdown.',
    );
  });
});
