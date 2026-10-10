import type { CollectorEvent, Workspace } from '../../src/core/types.js';

export const WS: Workspace = {
  cwd: '/home/dev/shop/orders-api',
  repoRoot: '/home/dev/shop/orders-api',
  repoName: 'orders-api',
  worktree: false,
  branch: 'feat/checkout-v2',
};

let seq = 0;
/** Builds an event with defaults; seq auto-increments unless given. */
export function ev<T extends CollectorEvent['type']>(
  type: T,
  ts: number,
  fields: Partial<Extract<CollectorEvent, { type: T }>> = {},
): Extract<CollectorEvent, { type: T }> {
  return { type, ts, seq: seq++, sessionId: 'S1', source: 'hook', ...fields } as Extract<CollectorEvent, { type: T }>;
}

export const seen = (ts = 1000) => ev('session.seen', ts, { workspace: WS, pid: 42, name: 'orders-api-a1', tmuxPane: '%7', startedAt: ts });
