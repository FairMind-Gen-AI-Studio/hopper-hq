import type { AgentTelemetry } from '../../src/core/types';

export const tokenNumber = (value: number | null | undefined): string => value == null ? 'Unavailable' : value.toLocaleString('en-US');
export const costText = (value: number | null | undefined): string => value == null ? 'Unavailable' : `$${value.toFixed(value > 0 && value < 0.01 ? 4 : 2)}`;

export function usageSummary(agents: { telemetry?: AgentTelemetry }[], expected: number) {
  let tokens = 0;
  let measured = 0;
  let cost = 0;
  let costs = 0;
  let partial = agents.length < expected;
  for (const agent of agents) {
    const telemetry = agent.telemetry;
    if (telemetry?.usage && Object.values(telemetry.usage).some((n) => n !== null)) {
      measured++;
      const values = Object.values(telemetry.usage);
      tokens += values.reduce<number>((sum, n) => sum + (n ?? 0), 0);
      partial ||= !telemetry.complete || values.some((n) => n === null);
    } else partial = true;
    if (telemetry?.costUSD != null) { cost += telemetry.costUSD; costs++; }
  }
  return { tokens: measured ? tokens : null, measured, expected, partial,
    cost: costs ? cost : null, costPartial: costs < expected || partial };
}

export function agentElapsed(telemetry: AgentTelemetry | undefined, running: boolean, now: number): string {
  if (telemetry?.startedAt == null || (!running && telemetry.endedAt == null)) return 'Duration unavailable';
  const seconds = Math.max(0, Math.floor(((running ? now : telemetry.endedAt!) - telemetry.startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}
