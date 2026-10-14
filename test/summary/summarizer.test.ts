import { describe, expect, it } from 'vitest';
import { newSession } from '../../src/core/reducer.js';
import type { Session, SessionState, SessionSummary } from '../../src/core/types.js';
import type { SummaryConfig } from '../../src/summary/config.js';
import { summaryInput } from '../../src/summary/input.js';
import type { SummaryProvider } from '../../src/summary/providers.js';
import { Summarizer, type SummarizerOptions, type SummarySource, type SummaryTimers } from '../../src/summary/summarizer.js';
import { WS } from '../helpers/events.js';

const MIN = 60_000;
const T0 = 1_000_000;

/** Lets every job that can go on run to its end: jobs wait on promises only, never on timers of their own. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A clock with timers that run only when the test moves it. */
class Clock implements SummaryTimers {
  t = T0;
  private seq = 0;
  private readonly pending = new Map<number, { at: number; run: () => void }>();
  now = () => this.t;
  set(run: () => void, ms: number): unknown {
    this.pending.set(++this.seq, { at: this.t + ms, run });
    return this.seq;
  }
  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  get size(): number {
    return this.pending.size;
  }
  /** Moves to `to`, running each timer due on the way at its own time, and the jobs it starts. */
  async to(to: number): Promise<void> {
    for (;;) {
      const next = [...this.pending].filter(([, p]) => p.at <= to).sort(([a, p], [b, q]) => p.at - q.at || a - b)[0];
      if (!next) break;
      this.pending.delete(next[0]);
      this.t = next[1].at;
      next[1].run();
      await flush();
    }
    this.t = to;
    await flush();
  }
  by(ms: number): Promise<void> {
    return this.to(this.t + ms);
  }
  /** Moves to the earliest pending timer. */
  next(): Promise<void> {
    const at = Math.min(...[...this.pending.values()].map((p) => p.at));
    if (!Number.isFinite(at)) throw new Error('No timer is pending');
    return this.to(at);
  }
}

/** The collector, as far as the summarizer sees it. */
class Source implements SummarySource {
  readonly sessions = new Map<string, Session>();
  private readonly listeners = new Set<(prev: Session | undefined, next: Session) => void>();
  session(id: string): Session | null {
    return this.sessions.get(id) ?? null;
  }
  onSessionChange(fn: (prev: Session | undefined, next: Session) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  setSummary(id: string, summary: SessionSummary): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    this.put({ ...s, summary });
    return true;
  }
  put(next: Session): void {
    const prev = this.sessions.get(next.id);
    this.sessions.set(next.id, next);
    for (const fn of this.listeners) fn(prev, next);
  }
  get subscribed(): number {
    return this.listeners.size;
  }
}

/** A provider whose answers the test gives: a line, an error, or a promise it settles later. */
class Provider implements SummaryProvider {
  readonly name = 'claude-cli' as const;
  readonly model = 'haiku';
  readonly calls: { input: string; at: number; signal: AbortSignal }[] = [];
  answer: (input: string) => string | Error | Promise<string> = () => 'Tests pass; the PR is open.';
  constructor(private readonly clock: Clock) {}
  async summarize(input: string, signal: AbortSignal): Promise<string> {
    this.calls.push({ input, at: this.clock.t, signal });
    const a = this.answer(input);
    if (a instanceof Error) throw a;
    return a;
  }
}

function setup(o: Partial<SummarizerOptions> & { enabled?: boolean } = {}) {
  const clock = new Clock();
  const source = new Source();
  const provider = new Provider(clock);
  const log: string[] = [];
  let config: SummaryConfig = { enabled: o.enabled ?? true, provider: 'claude-cli', model: null };
  const configs: SummaryConfig[] = [];
  const summarizer = new Summarizer({
    source,
    config: async () => config,
    provider: (c) => (configs.push(c), provider),
    now: clock.now,
    timers: clock,
    log: (line) => log.push(line),
    ...o,
  });
  /** Puts the session in `state` now, with what it says so far. */
  const turn = (id: string, state: SessionState, patch: Partial<Session> = {}) => {
    const s = source.sessions.get(id) ?? { ...newSession(id, T0 - 10 * MIN, WS), title: `Task of ${id}`, lastPrompt: 'Go on' };
    source.put({ ...s, ...patch, state, stateSince: clock.t });
  };
  return { clock, source, provider, log, summarizer, configs, turn, setConfig: (c: Partial<SummaryConfig>) => (config = { ...config, ...c }) };
}

describe('Summarizer triggers', () => {
  it('summarizes a session whose main turn ended, once it settled, from what the session says then', async () => {
    const t = setup();
    t.turn('S1', 'working');
    t.turn('S1', 'done');
    await t.clock.by(7999);
    expect(t.provider.calls).toEqual([]);
    t.turn('S1', 'done', { lastAnswer: 'I fixed the form.' });
    await t.clock.by(1);
    const input = summaryInput(t.source.sessions.get('S1')!)!;
    expect(t.provider.calls.map((c) => [c.input, c.at])).toEqual([[input.text, T0 + 8000]]);
    expect(t.source.sessions.get('S1')!.summary).toEqual({ text: 'Tests pass; the PR is open.', at: T0 + 8000, inputHash: input.hash });
  });

  it('starts on done, needs_you and in_meeting, and on nothing else', async () => {
    const t = setup();
    const states: SessionState[] = ['done', 'needs_you', 'in_meeting', 'working', 'idle', 'no_signal', 'dormant', 'ended'];
    states.forEach((state, i) => t.turn(`S${i}`, state));
    await t.clock.by(8000);
    expect(t.provider.calls.map((c) => c.input.split('\n')[0])).toEqual(['Title: Task of S0', 'Title: Task of S1', 'Title: Task of S2']);
  });

  it('starts only when the state changes, and not for a turn that ended before it started', async () => {
    const t = setup({ startedAt: T0 });
    t.source.put({ ...newSession('S1', T0 - MIN, WS), title: 'Old', state: 'done', stateSince: T0 - 1 });
    t.source.put({ ...t.source.sessions.get('S1')!, lastPrompt: 'Again' });
    await t.clock.by(MIN);
    expect(t.provider.calls).toEqual([]);
    t.turn('S1', 'needs_you');
    t.turn('S1', 'needs_you', { lastAnswer: 'Waiting.' });
    await t.clock.by(MIN);
    expect(t.provider.calls).toHaveLength(1);
  });

  it('drops the job of a session that went back to work, ended or is gone by then', async () => {
    const t = setup();
    for (const id of ['S1', 'S2', 'S3']) t.turn(id, 'done');
    t.turn('S1', 'working');
    t.turn('S2', 'ended');
    t.source.sessions.delete('S3');
    await t.clock.by(8000);
    expect(t.provider.calls).toEqual([]);
    expect((await t.summarizer.status()).queued).toBe(0);
  });

  it('never summarizes the same notes twice', async () => {
    const t = setup({ minIntervalMs: 0 });
    t.turn('S1', 'done');
    await t.clock.by(8000);
    t.turn('S1', 'working');
    t.turn('S1', 'done');
    await t.clock.by(8000);
    expect(t.provider.calls).toHaveLength(1);
    t.turn('S1', 'working');
    t.turn('S1', 'done', { lastAnswer: 'Now the tests pass.' });
    await t.clock.by(8000);
    expect(t.provider.calls).toHaveLength(2);
  });

  it('does nothing while summaries are off, not even a timer, and summarizes the first turn end once they are on', async () => {
    const t = setup({ enabled: false });
    t.turn('S1', 'done');
    await t.clock.by(8000);
    expect(t.provider.calls).toEqual([]);
    t.turn('S2', 'done');
    await t.clock.by(0);
    expect(t.clock.size).toBe(0);
    t.setConfig({ enabled: true, model: 'sonnet' });
    t.turn('S1', 'working');
    t.turn('S1', 'done');
    // The turn end reads the config again; once it is on, the turn is due as usual.
    await t.clock.by(0);
    await t.clock.by(8000);
    expect(t.provider.calls.map((c) => [c.input.split('\n')[0], c.at])).toEqual([['Title: Task of S1', T0 + 16_000]]);
    expect(t.configs.at(-1)).toEqual({ enabled: true, provider: 'claude-cli', model: 'sonnet' });
  });

  it('dates a line as of the notes it was written from: a prompt sent while the provider writes it makes it out of date', async () => {
    const t = setup();
    let answer!: (line: string) => void;
    t.provider.answer = () => new Promise<string>((resolve) => (answer = resolve));
    t.turn('S1', 'done');
    await t.clock.by(8000);
    await t.clock.by(5000);
    t.source.put({ ...t.source.sessions.get('S1')!, lastPromptAt: t.clock.t });
    answer('Done: the login form is fixed.');
    await flush();
    const s = t.source.sessions.get('S1')!;
    expect([s.summary?.text, s.summary?.at, s.lastPromptAt]).toEqual(['Done: the login form is fixed.', T0 + 8000, T0 + 13_000]);
  });
});

describe('Summarizer pacing', () => {
  it('summarizes a session at most once per interval, counted from the last call', async () => {
    const t = setup();
    t.turn('S1', 'done');
    await t.clock.by(8000);
    t.turn('S1', 'working');
    t.turn('S1', 'done', { lastAnswer: 'More done.' });
    await t.clock.by(3 * MIN - 1);
    expect(t.provider.calls.map((c) => c.at)).toEqual([T0 + 8000]);
    await t.clock.by(1);
    expect(t.provider.calls.map((c) => c.at)).toEqual([T0 + 8000, T0 + 8000 + 3 * MIN]);
  });

  it('keeps one timer per session, at the earliest due time', async () => {
    const t = setup();
    t.turn('S1', 'done');
    await t.clock.by(5000);
    t.turn('S1', 'working');
    t.turn('S1', 'done', { lastAnswer: 'Later notes.' });
    expect(t.clock.size).toBe(1);
    await t.clock.by(3000);
    expect(t.provider.calls.map((c) => [c.at, c.input.endsWith('Later notes.')])).toEqual([[T0 + 8000, true]]);
    await t.clock.by(10 * MIN);
    expect(t.provider.calls).toHaveLength(1);
  });

  it('runs one job at a time, in the order sessions came due', async () => {
    const t = setup();
    const answers: ((line: string) => void)[] = [];
    t.provider.answer = () => new Promise<string>((resolve) => answers.push(resolve));
    t.turn('S1', 'done');
    await t.clock.by(1000);
    t.turn('S2', 'needs_you');
    t.turn('S3', 'in_meeting');
    await t.clock.by(MIN);
    expect(t.provider.calls.map((c) => c.input.split('\n')[0])).toEqual(['Title: Task of S1']);
    expect((await t.summarizer.status()).queued).toBe(2);
    answers[0]!('One.');
    await flush();
    expect(t.provider.calls.map((c) => c.input.split('\n')[0])).toEqual(['Title: Task of S1', 'Title: Task of S2']);
    answers[1]!('Two.');
    await flush();
    answers[2]!('Three.');
    await flush();
    expect(['S1', 'S2', 'S3'].map((id) => t.source.sessions.get(id)!.summary?.text)).toEqual(['One.', 'Two.', 'Three.']);
    expect((await t.summarizer.status()).queued).toBe(0);
  });

  it('calls the provider for a session at most once per interval, also when it came due behind another job', async () => {
    const t = setup();
    const answers: ((line: string) => void)[] = [];
    t.provider.answer = () => new Promise<string>((resolve) => answers.push(resolve));
    t.turn('S2', 'done');
    await t.clock.by(7000);
    t.turn('S1', 'done');
    // S1 comes due while S2 is being summarized, waits behind it, and meanwhile stops at a permission prompt.
    await t.clock.by(8000);
    t.turn('S1', 'needs_you', { waitReason: { kind: 'permission', text: 'Bash', detail: 'Bash: npm test' } });
    await t.clock.by(1000);
    answers[0]!('Two.');
    await flush();
    answers[1]!('One.');
    await flush();
    t.turn('S1', 'working');
    t.turn('S1', 'needs_you', { waitReason: { kind: 'permission', text: 'Bash', detail: 'Bash: git push' } });
    await t.clock.by(10 * MIN);
    expect(t.provider.calls.map((c) => [c.input.split('\n')[0], c.at - T0])).toEqual([['Title: Task of S2', 8000], ['Title: Task of S1', 16_000], ['Title: Task of S1', 16_000 + 3 * MIN]]);
  });

  it("waits out a session's backoff, also when it came due behind another job", async () => {
    const t = setup();
    let release!: (line: string) => void;
    t.provider.answer = (input) => (input.startsWith('Title: Task of S2') ? new Promise<string>((resolve) => (release = resolve)) : new Error('claude timed out'));
    t.turn('S2', 'done');
    await t.clock.by(7000);
    t.turn('S1', 'done');
    await t.clock.by(8000);
    t.turn('S1', 'needs_you', { waitReason: { kind: 'permission', text: 'Bash', detail: 'Bash: npm test' } });
    await t.clock.by(1000);
    release('Two.');
    await flush();
    await t.clock.to(T0 + 16_000 + 3 * MIN);
    expect(t.provider.calls.map((c) => c.at - T0)).toEqual([8000, 16_000, 16_000 + 3 * MIN]);
  });

  it('keeps one line of the answer, cleaned and capped, and counts an empty one as a failure', async () => {
    const t = setup();
    t.provider.answer = () => '\n  "Tests   pass."  \nSecond line\n';
    t.turn('S1', 'done');
    await t.clock.by(8000);
    expect(t.source.sessions.get('S1')!.summary!.text).toBe('"Tests pass."');
    t.provider.answer = () => 'x'.repeat(300);
    t.turn('S2', 'done');
    await t.clock.by(8000);
    expect(t.source.sessions.get('S2')!.summary!.text).toBe('x'.repeat(119) + '\u2026');
    t.provider.answer = () => ' \n ';
    t.turn('S3', 'done');
    await t.clock.by(8000);
    expect(t.source.sessions.get('S3')!.summary).toBeNull();
    expect(t.log).toEqual(['hopper-hq summary failed: the summary was empty']);
  });
});

describe('Summarizer failures', () => {
  it('waits longer after each failure of a session, up to 30 minutes, beside the pause after three in a row', async () => {
    const t = setup({ settleMs: 0, minIntervalMs: 0 });
    t.provider.answer = () => new Error('claude timed out');
    t.turn('S1', 'done');
    await t.clock.next();
    for (let i = 1; i < 7; i++) {
      t.turn('S1', 'working');
      t.turn('S1', 'done');
      while (t.provider.calls.length === i) await t.clock.next();
    }
    const at = t.provider.calls.map((c) => c.at);
    // 1, 2, then 4 minutes, which the pause after the third failure stretches to 15; then 8, 16, and 32 cut to 30.
    expect(at.slice(1).map((a, i) => (a - at[i]!) / MIN)).toEqual([1, 2, 15, 8, 16, 30]);
  });

  it('tries a failed summary again once its wait is over, while the session still stands at that turn end with the same notes', async () => {
    const t = setup();
    t.provider.answer = () => new Error('claude timed out');
    const ask = { waitReason: { kind: 'question' as const, text: 'Which database?' } };
    for (const id of ['S1', 'S2', 'S3', 'S4']) t.turn(id, 'needs_you', ask);
    await t.clock.by(8000);
    expect(t.provider.calls).toHaveLength(3);
    t.provider.answer = () => 'Waits for an answer: which database.';
    // S2 goes back to work, S3's notes change where it stands, and S4 ends: none of them is tried again.
    t.turn('S2', 'working');
    t.source.put({ ...t.source.sessions.get('S3')!, lastAnswer: 'Postgres or SQLite?' });
    t.turn('S4', 'ended');
    // The pause after three failures, then S1 is tried again; S4's first job never ran, and goes with it.
    await t.clock.to(T0 + 8000 + 15 * MIN);
    expect(t.provider.calls.map((c) => [c.input.split('\n')[0], c.at - T0])).toEqual([
      ['Title: Task of S1', 8000], ['Title: Task of S2', 8000], ['Title: Task of S3', 8000], ['Title: Task of S1', 8000 + 15 * MIN],
    ]);
    expect(t.source.sessions.get('S1')!.summary?.text).toBe('Waits for an answer: which database.');
    // A turn end while a retry waits is summarized as a turn end, from what the session says then.
    t.provider.answer = () => new Error('claude timed out');
    t.turn('S5', 'done');
    await t.clock.by(8000);
    t.provider.answer = () => 'Now done.';
    t.turn('S5', 'working');
    t.turn('S5', 'done', { lastAnswer: 'Finished after all.' });
    await t.clock.by(10 * MIN);
    expect(t.provider.calls.slice(4).map((c) => [c.input.endsWith('Finished after all.'), c.at - T0])).toEqual([[false, 16_000 + 15 * MIN], [true, 16_000 + 18 * MIN]]);
    expect(t.clock.size).toBe(0);
  });

  it('lifts the pause and the backoffs once the config names another provider or model', async () => {
    const used: string[] = [];
    const t = setup({
      provider: (c) => ({
        name: c.provider,
        model: c.model,
        summarize: async () => {
          used.push(`${c.provider} ${t.clock.t - T0}`);
          if (c.provider === 'claude-cli') throw new Error('claude was not found on PATH');
          return 'Done.';
        },
      }),
    });
    for (const id of ['S1', 'S2', 'S3']) t.turn(id, 'done');
    await t.clock.by(8000);
    expect((await t.summarizer.status()).pausedUntil).toBe(T0 + 8000 + 15 * MIN);
    t.setConfig({ provider: 'anthropic-api' });
    await t.clock.by(MIN);
    t.turn('S4', 'done');
    await t.clock.by(0);
    await t.clock.by(8000);
    expect(used).toEqual(['claude-cli 8000', 'claude-cli 8000', 'claude-cli 8000', `anthropic-api ${MIN + 16_000}`]);
    expect(t.source.sessions.get('S4')!.summary?.text).toBe('Done.');
    expect((await t.summarizer.status()).pausedUntil).toBeNull();
  });

  it('pauses every summary for 15 minutes after three failures in a row, then starts counting again', async () => {
    const t = setup();
    t.provider.answer = () => new Error('Anthropic API answered 529: Overloaded');
    for (const id of ['S1', 'S2', 'S3']) t.turn(id, 'done');
    await t.clock.by(8000);
    expect(t.provider.calls).toHaveLength(3);
    const failedAt = T0 + 8000;
    expect(await t.summarizer.status()).toEqual({
      enabled: true,
      provider: 'claude-cli',
      model: 'haiku',
      lastOkAt: null,
      lastError: { at: failedAt, message: 'Anthropic API answered 529: Overloaded' },
      pausedUntil: failedAt + 15 * MIN,
      // Each waits to be tried again.
      queued: 3,
    });
    t.provider.answer = () => 'Back.';
    t.turn('S4', 'done');
    await t.clock.to(failedAt + 15 * MIN - 1);
    expect(t.provider.calls).toHaveLength(3);
    expect((await t.summarizer.status()).queued).toBe(4);
    await t.clock.by(1);
    expect(t.provider.calls.map((c) => c.at).at(-1)).toBe(failedAt + 15 * MIN);
    expect(await t.summarizer.status()).toMatchObject({ lastOkAt: failedAt + 15 * MIN, pausedUntil: null, queued: 0 });
    expect(t.log).toEqual(Array(3).fill('hopper-hq summary failed: Anthropic API answered 529: Overloaded'));
  });

  it('starts counting failures in a row again after a success', async () => {
    const t = setup();
    const fails = new Set(['S1', 'S2', 'S4', 'S5']);
    t.provider.answer = (input) => (fails.has(input.split('\n')[0]!.slice('Title: Task of '.length)) ? new Error('claude timed out') : 'Fine.');
    for (const id of ['S1', 'S2', 'S3', 'S4', 'S5']) {
      t.turn(id, 'done');
      await t.clock.by(8000);
    }
    expect(t.provider.calls).toHaveLength(5);
    expect((await t.summarizer.status()).pausedUntil).toBeNull();
  });

  it('logs the cleaned message of a failure, never the notes', async () => {
    const t = setup();
    t.provider.answer = () => new Error('claude exited with code 1:\n  boom');
    t.turn('S1', 'done', { title: 'Secret plan' });
    await t.clock.by(8000);
    expect(t.log).toEqual(['hopper-hq summary failed: claude exited with code 1: boom']);
    expect((await t.summarizer.status()).lastError).toEqual({ at: T0 + 8000, message: 'claude exited with code 1: boom' });
  });
});

describe('Summarizer status and stop', () => {
  it('reports the config with the provider it resolves to, and the sessions waiting', async () => {
    const t = setup({ enabled: false });
    expect(await t.summarizer.status()).toEqual({ enabled: false, provider: 'claude-cli', model: 'haiku', lastOkAt: null, lastError: null, pausedUntil: null, queued: 0 });
    const on = setup();
    on.turn('S1', 'done');
    on.turn('S2', 'done');
    expect((await on.summarizer.status()).queued).toBe(2);
  });

  it('forgets a session that ended, but keeps pacing it while a recent call or a failure counts', async () => {
    const t = setup();
    const paces = (t.summarizer as unknown as { paces: Map<string, unknown> }).paces;
    t.turn('S1', 'done');
    await t.clock.by(8000);
    t.turn('S2', 'done');
    t.turn('S2', 'ended');
    t.turn('S1', 'ended');
    expect([t.clock.size, [...paces.keys()]]).toEqual([0, ['S1']]);
    // Back within its interval, it waits for the rest of it.
    t.turn('S1', 'done', { lastAnswer: 'Again.' });
    await t.clock.to(T0 + 8000 + 3 * MIN - 1);
    expect(t.provider.calls).toHaveLength(1);
    await t.clock.by(1);
    expect(t.provider.calls).toHaveLength(2);
    await t.clock.by(3 * MIN);
    t.turn('S1', 'ended');
    expect(paces.size).toBe(0);
  });

  it('stops for good: no timer, no job, the running call aborted and its answer dropped', async () => {
    const t = setup();
    let answer!: (line: string) => void;
    t.provider.answer = () => new Promise<string>((resolve) => (answer = resolve));
    t.turn('S1', 'done');
    await t.clock.by(8000);
    t.turn('S2', 'done');
    expect([t.provider.calls.length, t.clock.size, t.source.subscribed]).toEqual([1, 1, 1]);
    t.summarizer.stop();
    t.summarizer.stop();
    expect([t.provider.calls[0]!.signal.aborted, t.clock.size, t.source.subscribed]).toEqual([true, 0, 0]);
    answer('Too late.');
    await flush();
    t.turn('S3', 'done');
    await t.clock.by(10 * MIN);
    expect(t.provider.calls).toHaveLength(1);
    expect(t.source.sessions.get('S1')!.summary).toBeNull();
    expect(t.log).toEqual([]);
  });
});
