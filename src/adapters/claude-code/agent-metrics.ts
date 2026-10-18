import { readFile, stat } from 'node:fs/promises';
import type { AgentTelemetry, TokenUsage } from '../../core/types.js';
import { cleanOrNull } from '../../scene/text.js';
import { readNewLines, type TailState } from './jsonl.js';

const FIELDS = {
  inputTokens: 'input_tokens', outputTokens: 'output_tokens',
  cacheReadTokens: 'cache_read_input_tokens', cacheWriteTokens: 'cache_creation_input_tokens',
} as const;
const numberOf = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};

/** Incremental usage per API message: streaming content blocks share one message id. */
export class AgentMetrics {
  private tail: TailState;
  private messages = new Map<string, TokenUsage>();
  private model: string | null;
  private start: number | null = null;
  private last: number | null = null;
  private cost: number | null = null;
  private overflow = false;
  private sent = '';
  private pendingRead = true;

  get pending(): boolean { return this.pendingRead; }

  constructor(path: string, model: string | null) {
    this.tail = { path, offset: 0, skipping: false };
    this.model = model;
  }

  async read(running: boolean): Promise<AgentTelemetry | null> {
    if (this.model === null) {
      try {
        const path = this.tail.path.replace(/\.jsonl$/, '.meta.json');
        const meta = await stat(path);
        if (meta.isFile() && meta.size <= 64 * 1024) {
          const model = record(JSON.parse(await readFile(path, 'utf8'))).model;
          this.model = typeof model === 'string' ? cleanOrNull(model, 120) : null;
        }
      } catch {
        // Metadata can arrive after the journal's start line.
      }
    }
    const size = await stat(this.tail.path).then((s) => s.size).catch(() => null);
    if (size !== null && size < this.tail.offset) {
      this.tail.offset = 0;
      this.tail.skipping = false;
      this.messages.clear();
      this.start = this.last = this.cost = null;
      this.overflow = false;
    }
    const previousOffset = this.tail.offset;
    const { lines, state } = await readNewLines(this.tail, 256 * 1024);
    this.tail = state;
    this.pendingRead = size !== null && state.offset < size && state.offset > previousOffset;
    if (state.skipping) this.overflow = true;
    for (const line of lines) {
      let d: Record<string, unknown>;
      try { d = record(JSON.parse(line)); } catch { continue; }
      const stamp = typeof d.timestamp === 'string' ? Date.parse(d.timestamp) : NaN;
      if (Number.isFinite(stamp)) {
        this.start = Math.min(this.start ?? stamp, stamp);
        this.last = Math.max(this.last ?? stamp, stamp);
      }
      if (d.type === 'result') this.cost = numberOf(d.total_cost_usd) ?? this.cost;
      if (d.type !== 'assistant') continue;
      const msg = record(d.message);
      if (typeof msg.model === 'string' && msg.model !== '<synthetic>') this.model = cleanOrNull(msg.model, 120) ?? this.model;
      const usage = record(msg.usage);
      if (typeof msg.id !== 'string' || msg.id.length > 256 || !Object.keys(usage).length) continue;
      if (!this.messages.has(msg.id) && this.messages.size >= 8192) { this.overflow = true; continue; }
      const previous = this.messages.get(msg.id);
      const next = {} as TokenUsage;
      for (const key of Object.keys(FIELDS) as (keyof TokenUsage)[]) {
        const raw = numberOf(usage[FIELDS[key]]);
        const value = raw !== null && Number.isSafeInteger(raw) ? raw : null;
        next[key] = value === null ? previous?.[key] ?? null : Math.max(previous?.[key] ?? 0, value);
      }
      this.messages.set(msg.id, next);
    }
    if (!this.model && !this.messages.size && this.start === null && this.cost === null) return null;
    const usage = this.messages.size ? { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null } as TokenUsage : null;
    if (usage) for (const key of Object.keys(FIELDS) as (keyof TokenUsage)[]) {
      const values = [...this.messages.values()].map((u) => u[key]);
      // Missing fields cannot be mistaken for zero in an otherwise measured total.
      usage[key] = values.some((n) => n === null) ? null : values.reduce<number>((n, v) => n + (v ?? 0), 0);
    }
    const telemetry: AgentTelemetry = {
      model: this.model, usage, costUSD: this.cost, startedAt: this.start,
      endedAt: running ? null : this.last,
      complete: size !== null && state.offset >= size && !state.skipping && !this.overflow,
    };
    const signature = JSON.stringify(telemetry);
    if (signature === this.sent) return null;
    this.sent = signature;
    return telemetry;
  }
}
