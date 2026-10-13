import type { Session, SessionState, SessionSummary } from '../core/types.js';
import { cleanText } from '../scene/text.js';
import type { ProviderName, SummaryConfig } from './config.js';
import { SUMMARY_MAX, summaryInput } from './input.js';
import type { SummaryProvider } from './providers.js';

export interface SummarySource {
  session(id: string): Session | null;
  onSessionChange(fn: (prev: Session | undefined, next: Session) => void): () => void;
  setSummary(id: string, summary: SessionSummary): boolean;
}
export interface SummaryTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
export interface SummarizerOptions {
  source: SummarySource;
  /** Read before each job; cheap (the daemon caches by mtime). */
  config: () => Promise<SummaryConfig>;
  /** The provider for a config; called before each job. */
  provider: (c: SummaryConfig) => SummaryProvider;
  now?: () => number;
  timers?: SummaryTimers;
  /** Turns that finished before this time are not summarized (default: construction time). */
  startedAt?: number;
  /** Wait after a turn ends before reading the session (default 8000). */
  settleMs?: number;
  /** At most one summary per session per interval (default 180000). */
  minIntervalMs?: number;
  log?: (line: string) => void;
}
export interface SummaryStatus {
  enabled: boolean;
  provider: ProviderName | 'demo';
  model: string | null;
  lastOkAt: number | null;
  lastError: { at: number; message: string } | null;
  pausedUntil: number | null;
  queued: number;
}

/** A main turn ended in one of these: the session stands somewhere worth a line. */
const TRIGGERS: ReadonlySet<SessionState> = new Set(['done', 'needs_you', 'in_meeting']);
/** By the time its job runs, a session in one of these has nothing settled to say. */
const SKIPPED: ReadonlySet<SessionState> = new Set(['working', 'no_signal', 'ended']);
const MINUTE = 60_000;
const BACKOFF_MAX_MS = 30 * MINUTE;
const PAUSE_AFTER_FAILURES = 3;
const PAUSE_MS = 15 * MINUTE;

const realTimers: SummaryTimers = {
  set: (run, ms) => setTimeout(run, ms).unref(),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

interface Pace {
  /** When the provider was last called for this session; null before the first call. */
  lastAttempt: number | null;
  /** Failures in a row. */
  failures: number;
  backoffUntil: number;
  /** The one pending timer, and when it is due. */
  timer: unknown;
  dueAt: number | null;
  /** The notes of a summary that failed, while the timer waits to try them again; null for a turn end's timer. */
  retry: string | null;
}

/** A provider and its model, as one key. */
const keyOf = (p: SummaryProvider): string => JSON.stringify([p.name, p.model]);

/**
 * Writes the "where it stands" line of sessions whose main turn ended: a while after the turn ends, one session at a time,
 * at most once per session per interval, and never twice from the same notes. A provider that fails or hangs only delays
 * summaries: the session waits longer each time, and three failures in a row pause every summary for a while. A failed
 * summary is tried again once its wait is over, while the session still stands where it did.
 */
export class Summarizer {
  private readonly now: () => number;
  private readonly timers: SummaryTimers;
  private readonly startedAt: number;
  private readonly settleMs: number;
  private readonly minIntervalMs: number;
  private readonly log: (line: string) => void;
  private readonly paces = new Map<string, Pace>();
  /** Ids due for a job, in the order they came due. */
  private readonly queue: string[] = [];
  private running: AbortController | null = null;
  private failures = 0;
  private pausedUntil: number | null = null;
  private pauseTimer: unknown = null;
  private lastOkAt: number | null = null;
  private lastError: { at: number; message: string } | null = null;
  /** The provider and model of the last failure: the backoffs and the pause are theirs. */
  private failedWith: string | null = null;
  /** Whether summaries were on when the config was last read; null before the first read. */
  private enabled: boolean | null = null;
  /** What waits for the config read under way, if one is. */
  private reading: (() => void)[] | null = null;
  private stopped = false;
  private readonly unsubscribe: () => void;

  constructor(private readonly o: SummarizerOptions) {
    this.now = o.now ?? Date.now;
    this.timers = o.timers ?? realTimers;
    this.startedAt = o.startedAt ?? this.now();
    this.settleMs = o.settleMs ?? 8000;
    this.minIntervalMs = o.minIntervalMs ?? 180_000;
    this.log = o.log ?? ((line) => process.stderr.write(line + '\n'));
    this.unsubscribe = o.source.onSessionChange((prev, next) => this.schedule(prev, next));
  }

  private pace(id: string): Pace {
    let p = this.paces.get(id);
    if (!p) this.paces.set(id, (p = { lastAttempt: null, failures: 0, backoffUntil: 0, timer: null, dueAt: null, retry: null }));
    return p;
  }

  /** The earliest time the provider may be called for a session: its interval since the last call, and its backoff. */
  private notBefore(p: Pace): number {
    return Math.max((p.lastAttempt ?? -Infinity) + this.minIntervalMs, p.backoffUntil);
  }

  /**
   * A main turn that ended since the start makes the session due once it settled, its interval passed and its backoff
   * ended. While summaries are off, a turn end only reads the config again: the turn is due as usual once they are on.
   * During a pause it reads the config too: another provider or model lifts the pause. A session that ended is forgotten.
   */
  private schedule(prev: Session | undefined, next: Session): void {
    if (this.stopped) return;
    if (next.state === 'ended') return this.forget(next.id);
    if (!TRIGGERS.has(next.state) || prev?.state === next.state || next.stateSince < this.startedAt) return;
    const p = this.pace(next.id);
    const due = Math.max(this.now() + this.settleMs, this.notBefore(p));
    const arm = () => {
      // A turn end takes the place of a retry: its job summarizes whatever the session says then.
      if (p.retry !== null) this.disarm(p);
      this.arm(next.id, p, due);
    };
    if (this.enabled === false) return this.refresh(arm);
    if (this.pausedUntil !== null && this.now() < this.pausedUntil) this.refresh();
    arm();
  }

  /** Sets the session's one timer for `due`, unless it has one due sooner. */
  private arm(id: string, p: Pace, due: number): void {
    if (this.stopped || (p.dueAt !== null && p.dueAt <= due)) return;
    this.disarm(p);
    p.dueAt = due;
    p.timer = this.timers.set(() => {
      p.timer = null;
      p.dueAt = null;
      if (!this.queue.includes(id)) this.queue.push(id);
      this.pump();
    }, Math.max(0, due - this.now()));
  }

  private disarm(p: Pace): void {
    if (p.timer !== null) this.timers.clear(p.timer);
    p.timer = null;
    p.dueAt = null;
    p.retry = null;
  }

  /** A session that ended keeps no timer, and nothing at all once no failure or recent call paces it any more. */
  private forget(id: string): void {
    const p = this.paces.get(id);
    if (!p) return;
    this.disarm(p);
    if (p.failures === 0 && (p.lastAttempt === null || this.now() - p.lastAttempt >= this.minIntervalMs)) this.paces.delete(id);
  }

  /** Reads the config again, one read at a time: `then` runs once summaries are on, and another provider lifts the pause. */
  private refresh(then?: () => void): void {
    if (this.reading) {
      if (then) this.reading.push(then);
      return;
    }
    const waiting = (this.reading = then ? [then] : []);
    void this.o.config().then(
      (c) => {
        this.reading = null;
        this.enabled = c.enabled;
        if (!c.enabled || this.stopped) return;
        this.use(this.o.provider(c));
        for (const fn of waiting) fn();
        this.pump();
      },
      () => {
        this.reading = null;
      },
    );
  }

  /** Jobs go to this provider: when it is another one, or another model, than the one that failed, its backoffs and its pause go. */
  private use(provider: SummaryProvider): void {
    if (this.failedWith === null || this.failedWith === keyOf(provider)) return;
    this.failedWith = null;
    this.failures = 0;
    this.pausedUntil = null;
    if (this.pauseTimer !== null) this.timers.clear(this.pauseTimer);
    this.pauseTimer = null;
    for (const p of this.paces.values()) {
      p.failures = 0;
      p.backoffUntil = 0;
    }
  }

  /** Starts the next job unless one runs, or summaries are paused: then it starts when the pause ends. */
  private pump(): void {
    if (this.stopped || this.running || this.queue.length === 0) return;
    const now = this.now();
    if (this.pausedUntil !== null && now < this.pausedUntil) {
      if (this.pauseTimer === null) {
        this.pauseTimer = this.timers.set(() => {
          this.pauseTimer = null;
          this.pump();
        }, this.pausedUntil - now);
      }
      return;
    }
    const id = this.queue.shift()!;
    const abort = new AbortController();
    this.running = abort;
    void this.job(id, abort.signal).finally(() => {
      this.running = null;
      this.pump();
    });
  }

  private async job(id: string, signal: AbortSignal): Promise<void> {
    const config = await this.o.config().catch(() => null);
    if (config) this.enabled = config.enabled;
    if (!config?.enabled || this.stopped) return;
    const provider = this.o.provider(config);
    this.use(provider);
    const s = this.o.source.session(id);
    // The line says where the session stood when its notes were read.
    const readAt = this.now();
    const p = this.paces.get(id);
    const retry = p?.retry ?? null;
    if (p) p.retry = null;
    if (!s || !p || SKIPPED.has(s.state) || (retry !== null && !TRIGGERS.has(s.state))) return;
    const input = summaryInput(s);
    if (!input || input.hash === s.summary?.inputHash || (retry !== null && input.hash !== retry)) return;
    // Its interval and its backoff hold up to the call: a session that came due sooner, behind other jobs, waits for them.
    if (readAt < this.notBefore(p)) {
      // A turn end due meanwhile goes on as such; otherwise a retry stays one.
      const due = p.timer !== null;
      this.arm(id, p, this.notBefore(p));
      if (retry !== null && !due) p.retry = retry;
      return;
    }
    p.lastAttempt = readAt;
    let text: string;
    try {
      const raw = await provider.summarize(input.text, signal);
      text = cleanText(raw.split(/\r?\n/).find((line) => line.trim() !== '') ?? '', SUMMARY_MAX);
      if (!text) throw new Error('the summary was empty');
    } catch (err) {
      if (!this.stopped) this.failed(id, p, err, input.hash, provider);
      return;
    }
    if (this.stopped) return;
    this.o.source.setSummary(id, { text, at: readAt, inputHash: input.hash });
    p.failures = 0;
    p.backoffUntil = 0;
    this.failures = 0;
    this.lastOkAt = this.now();
  }

  /** Counts a failure, and tries the same notes again once the session's wait is over, unless a turn end is due already. */
  private failed(id: string, p: Pace, err: unknown, hash: string, provider: SummaryProvider): void {
    const now = this.now();
    const message = cleanText(err instanceof Error ? err.message : err, 200) || 'unknown error';
    p.failures++;
    p.backoffUntil = now + Math.min(BACKOFF_MAX_MS, MINUTE * 2 ** (p.failures - 1));
    this.lastError = { at: now, message };
    this.failedWith = keyOf(provider);
    this.log(`scranton-hq summary failed: ${message}`);
    if (++this.failures >= PAUSE_AFTER_FAILURES) {
      this.pausedUntil = now + PAUSE_MS;
      this.failures = 0;
    }
    if (p.timer !== null) return;
    this.arm(id, p, this.notBefore(p));
    p.retry = hash;
  }

  /** The config merged with the counters. `queued` counts the sessions waiting for a job, settling, due or to try again. */
  async status(): Promise<SummaryStatus> {
    const config = await this.o.config();
    this.enabled = config.enabled;
    const provider = this.o.provider(config);
    const now = this.now();
    const waiting = new Set(this.queue);
    for (const [id, p] of this.paces) if (p.timer !== null) waiting.add(id);
    return {
      enabled: config.enabled,
      provider: provider.name,
      model: provider.model,
      lastOkAt: this.lastOkAt,
      lastError: this.lastError,
      pausedUntil: this.pausedUntil !== null && this.pausedUntil > now ? this.pausedUntil : null,
      queued: waiting.size,
    };
  }

  /** Stops for good: no new job, the running one is aborted, and nothing is written after this. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribe();
    for (const p of this.paces.values()) if (p.timer !== null) this.timers.clear(p.timer);
    if (this.pauseTimer !== null) this.timers.clear(this.pauseTimer);
    this.queue.length = 0;
    this.running?.abort();
  }
}
