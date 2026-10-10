import { describe, expect, it } from 'vitest';
import { parseTranscriptLine, promptText } from '../../src/adapters/claude-code/transcript.js';

const S = 'S1';
const T = '2026-10-10T10:00:00.000Z';
const TS = Date.parse(T);
const line = (o: object) => JSON.stringify(o);

describe('promptText', () => {
  it('keeps typed text and drops command and system wrappers', () => {
    expect(promptText('  Add keys  ')).toBe('Add keys');
    expect(promptText([{ type: 'text', text: 'hello' }, { type: 'image' }])).toBe('hello');
    expect(promptText('<command-name>/clear</command-name>')).toBeNull();
    expect(promptText('<task-notification>done</task-notification>')).toBeNull();
    expect(promptText('<system-reminder>x</system-reminder>')).toBeNull();
    expect(promptText('')).toBeNull();
    expect(promptText(42)).toBeNull();
    expect(promptText('x'.repeat(300))).toHaveLength(200);
  });
});

describe('parseTranscriptLine', () => {
  it('reads the AI title', () => {
    expect(parseTranscriptLine(line({ type: 'ai-title', aiTitle: 'Fix checkout', sessionId: S }), S).events)
      .toEqual([{ sessionId: S, ts: 0, source: 'fs', type: 'title', title: 'Fix checkout' }]);
  });

  it('reads a typed prompt with its timestamp, branch and cwd', () => {
    const r = parseTranscriptLine(line({ type: 'user', timestamp: T, cwd: '/w/shop', gitBranch: 'feat/x', sessionId: S, message: { role: 'user', content: 'Add idempotency keys' } }), S);
    expect(r).toEqual({
      ts: TS,
      branch: 'feat/x',
      cwd: '/w/shop',
      events: [{ sessionId: S, ts: TS, source: 'fs', type: 'prompt', text: 'Add idempotency keys' }],
    });
  });

  it('skips meta and command messages', () => {
    expect(parseTranscriptLine(line({ type: 'user', timestamp: T, isMeta: true, message: { content: 'hidden' } }), S).events).toEqual([]);
    expect(parseTranscriptLine(line({ type: 'user', timestamp: T, message: { content: '<command-name>/clear</command-name>' } }), S).events).toEqual([]);
  });

  it('turns tool results into tool.finished and never into prompts', () => {
    const r = parseTranscriptLine(line({ type: 'user', timestamp: T, message: { content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
      { type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'boom' },
    ] } }), S);
    expect(r.events).toEqual([
      { sessionId: S, ts: TS, source: 'fs', type: 'tool.finished', toolId: 't1', ok: true, agentId: null },
      { sessionId: S, ts: TS, source: 'fs', type: 'tool.finished', toolId: 't2', ok: false, agentId: null },
    ]);
  });

  it('turns assistant tool uses into tool.started or waiting', () => {
    const r = parseTranscriptLine(line({ type: 'assistant', timestamp: T, cwd: '/w/shop', message: { content: [
      { type: 'thinking', thinking: '...' },
      { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/w/shop/src/a.ts' } },
      { type: 'tool_use', id: 't2', name: 'AskUserQuestion', input: { questions: [{ question: 'Redis or Postgres?' }] } },
    ] } }), S);
    expect(r.events).toEqual([
      { sessionId: S, ts: TS, source: 'fs', type: 'tool.started', toolId: 't1', tool: 'Edit', label: 'Edit src/a.ts', agentId: null },
      { sessionId: S, ts: TS, source: 'fs', type: 'waiting', reason: { kind: 'question', text: 'Redis or Postgres?' } },
    ]);
  });

  it('uses the cwd hint when the line has none', () => {
    const r = parseTranscriptLine(line({ type: 'assistant', timestamp: T, message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/w/shop/README.md' } }] } }), S, '/w/shop');
    expect(r.events[0]).toMatchObject({ label: 'Read README.md' });
  });

  it('ignores sidechain entries, bad JSON and unknown entry types', () => {
    expect(parseTranscriptLine(line({ type: 'user', isSidechain: true, timestamp: T, message: { content: 'x' } }), S).events).toEqual([]);
    expect(parseTranscriptLine('{not json', S)).toEqual({ events: [] });
    expect(parseTranscriptLine('null', S)).toEqual({ events: [] });
    expect(parseTranscriptLine(line({ type: 'file-history-snapshot', snapshot: {} }), S).events).toEqual([]);
  });
});
