import { describe, expect, it } from 'vitest';
import { agentElapsed, costText, usageSummary } from '../../lib/usage';
import type { AgentTelemetry } from '../../../src/core/types';

const measured: AgentTelemetry = { model: 'sonnet', usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 }, costUSD: 0, startedAt: 0, endedAt: 60000, complete: true };

describe('workflow usage wording', () => {
  it('sums every token category and marks missing agents as partial', () => {
    expect(usageSummary([{ telemetry: measured }], 2)).toEqual({ tokens: 100, measured: 1, expected: 2, partial: true, cost: 0, costPartial: true });
    expect(usageSummary([{ telemetry: measured }, { telemetry: measured }], 2)).toMatchObject({ tokens: 200, partial: false, cost: 0, costPartial: false });
  });
  it('does not display a zero total when every token field is unavailable', () => {
    expect(usageSummary([{ telemetry: { ...measured, usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null } } }], 1)).toMatchObject({ tokens: null, measured: 0, partial: true });
  });
  it('distinguishes measured zeros and small costs from unavailable values', () => {
    expect(costText(null)).toBe('Unavailable');
    expect(costText(0)).toBe('$0.00');
    expect(costText(0.0012)).toBe('$0.0012');
    expect(agentElapsed(measured, false, 900000)).toBe('1m');
    expect(agentElapsed(measured, true, 120000)).toBe('2m');
    expect(agentElapsed(undefined, false, 120000)).toBe('Duration unavailable');
  });
});
