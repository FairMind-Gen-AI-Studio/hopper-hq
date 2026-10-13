import { describe, expect, it } from 'vitest';
import { parseTranscriptLine, promptText } from '../../src/adapters/claude-code/transcript.js';
import { launchText, resultEntry } from '../helpers/workflows.js';

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

  it('drops a title or a prompt with no text left once cleaned', () => {
    expect(parseTranscriptLine(line({ type: 'ai-title', aiTitle: '\u0007\u202E', sessionId: S }), S).events).toEqual([]);
    expect(parseTranscriptLine(line({ type: 'ai-title', aiTitle: 'Fix\u0007 checkout', sessionId: S }), S).events)
      .toEqual([{ sessionId: S, ts: 0, source: 'fs', type: 'title', title: 'Fix checkout' }]);
    expect(promptText('\u0007\u001b')).toBeNull();
    expect(parseTranscriptLine(line({ type: 'user', timestamp: T, sessionId: S, message: { role: 'user', content: '\u0007' } }), S).events).toEqual([]);
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
      { sessionId: S, ts: TS, source: 'fs', type: 'waiting', reason: { kind: 'question', text: 'Redis or Postgres?' }, agentId: null },
    ]);
  });

  it('uses the cwd hint when the line has none', () => {
    const r = parseTranscriptLine(line({ type: 'assistant', timestamp: T, message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/w/shop/README.md' } }] } }), S, '/w/shop');
    expect(r.events[0]).toMatchObject({ label: 'Read README.md' });
  });

  it("turns an assistant entry's last text into its answer, cleaned and cut, before its tool uses", () => {
    const r = parseTranscriptLine(line({ type: 'assistant', timestamp: T, message: { content: [
      { type: 'text', text: 'Looking at the tests first.' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } },
      { type: 'text', text: 'All green:\n42 tests\u0007 pass.' },
    ] } }), S);
    expect(r.events).toEqual([
      { sessionId: S, ts: TS, source: 'fs', type: 'answer', text: 'All green: 42 tests pass.' },
      { sessionId: S, ts: TS, source: 'fs', type: 'tool.started', toolId: 't1', tool: 'Bash', label: 'Bash: npm test', agentId: null },
    ]);
    const long = parseTranscriptLine(line({ type: 'assistant', timestamp: T, message: { content: [{ type: 'text', text: 'x'.repeat(2500) }] } }), S);
    expect((long.events[0] as { text: string }).text).toHaveLength(2000);
    for (const content of [[{ type: 'thinking', thinking: 'hmm' }], [{ type: 'text', text: ' \u0007 ' }], [{ type: 'text', text: 42 }], 'plain string']) {
      expect(parseTranscriptLine(line({ type: 'assistant', timestamp: T, message: { content } }), S).events).toEqual([]);
    }
    expect(parseTranscriptLine(line({ type: 'assistant', isSidechain: true, timestamp: T, message: { content: [{ type: 'text', text: 'from a subagent' }] } }), S).events).toEqual([]);
  });

  it('reads a Workflow launch from its result, as a string or as text blocks, with the time of its line, and makes no event of it', () => {
    const scriptPath = '/home/dev/.claude/projects/-home-dev-shop/11111111-1111-4111-8111-111111111111/workflows/scripts/checkout-verify-wf_0000aaaa-001.js';
    const text = launchText({ runId: 'wf_0000aaaa-001', summary: 'Verify split\u0007 payments end to end', scriptPath });
    const at = Date.parse('2026-10-10T10:00:30.000Z');
    const launch = { runId: 'wf_0000aaaa-001', summary: 'Verify split payments end to end', scriptPath, at };
    const r = parseTranscriptLine(line(resultEntry(text)), S);
    expect(r.events).toEqual([{ sessionId: S, ts: at, source: 'fs', type: 'tool.finished', toolId: 'toolu_06ABCDEFGHIJKLMNOPQRSTUV', ok: true, agentId: null }]);
    expect(r.launches).toEqual([launch]);
    const [head, ...rest] = text.split('\nRun ID: ');
    expect(parseTranscriptLine(line(resultEntry([{ type: 'text', text: head }, { type: 'image' }, { type: 'text', text: `Run ID: ${rest.join('')}` }])), S).launches).toEqual([launch]);
    // A line that does not say when it was written gives a launch of no known time.
    expect(parseTranscriptLine(line({ ...resultEntry(text), timestamp: 'never' }), S).launches).toEqual([{ ...launch, at: null }]);
  });

  it('skips a launch without a valid run id, a result that only mentions one, and lines without Summary or Script file', () => {
    const parsed = (content: unknown) => parseTranscriptLine(line(resultEntry(content)), S);
    expect(parsed(launchText({ runId: 'wf_a/b', summary: 'x' })).launches).toBeUndefined();
    expect(parsed(`The tool said:\n${launchText({ runId: 'wf_0000aaaa-002', summary: 'x' })}`).launches).toBeUndefined();
    expect(parsed('ok')).not.toHaveProperty('launches');
    const at = Date.parse('2026-10-10T10:00:30.000Z');
    expect(parsed(launchText({ runId: 'wf_0000aaaa-003' })).launches).toEqual([{ runId: 'wf_0000aaaa-003', summary: null, scriptPath: null, at }]);
    expect(parsed(launchText({ runId: 'wf_0000aaaa-004', summary: ' \u0007 ' })).launches).toEqual([{ runId: 'wf_0000aaaa-004', summary: null, scriptPath: null, at }]);
  });

  it('ignores sidechain entries, bad JSON and unknown entry types', () => {
    expect(parseTranscriptLine(line({ type: 'user', isSidechain: true, timestamp: T, message: { content: 'x' } }), S).events).toEqual([]);
    expect(parseTranscriptLine('{not json', S)).toEqual({ events: [] });
    expect(parseTranscriptLine('null', S)).toEqual({ events: [] });
    expect(parseTranscriptLine(line({ type: 'file-history-snapshot', snapshot: {} }), S).events).toEqual([]);
  });
});
