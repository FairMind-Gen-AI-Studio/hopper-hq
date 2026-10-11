import type { DistributiveOmit, RawEvent, Workspace } from '../core/types.js';

interface DemoSession {
  id: string;
  name: string;
  pane: string;
  workspace: Workspace;
  title: string;
  prompt: string;
}

const ws = (cwd: string, branch: string, repoRoot = cwd): Workspace => ({
  cwd,
  repoRoot,
  repoName: repoRoot.split('/').pop() ?? repoRoot,
  worktree: cwd !== repoRoot,
  branch,
});

export const DEMO_SESSIONS: DemoSession[] = [
  { id: 'demo-sw-a1', name: 'storefront-web-a1', pane: '%4', workspace: ws('/demo/storefront-web', 'feat/checkout-v2'), title: 'Build the address step of the new checkout', prompt: 'Build the address step' },
  { id: 'demo-sw-b2', name: 'storefront-web-b2', pane: '%5', workspace: ws('/demo/storefront-web', 'feat/checkout-v2'), title: 'Rewrite checkout copy and empty states', prompt: 'Rewrite the checkout copy' },
  { id: 'demo-oa-c3', name: 'orders-api-c3', pane: '%7', workspace: ws('/demo/orders-api/.worktrees/checkout-v2', 'feat/checkout-v2', '/demo/orders-api'), title: 'Add idempotency keys to POST /orders', prompt: 'Add idempotency keys' },
  { id: 'demo-ps-d4', name: 'payments-svc-d4', pane: '%9', workspace: ws('/demo/payments-svc', 'feat/checkout-v2'), title: 'Support split payments across two cards', prompt: 'Support split payments' },
  { id: 'demo-ss-e5', name: 'search-svc-e5', pane: '%11', workspace: ws('/demo/search-svc', 'feat/search-ranking'), title: 'Tune BM25 weights with click data', prompt: 'Tune the ranking weights' },
  { id: 'demo-oa-g7', name: 'orders-api-g7', pane: '%2', workspace: ws('/demo/orders-api', 'main'), title: 'Investigate duplicate confirmation emails', prompt: 'Why do customers get two emails?' },
  { id: 'demo-oa-h8', name: 'orders-api-h8', pane: '%3', workspace: ws('/demo/orders-api', 'main'), title: 'Bump dependencies and fix type errors', prompt: 'Bump dependencies' },
];

type Body = DistributiveOmit<RawEvent, 'sessionId' | 'ts' | 'source'>;
const at = (sessionId: string, ts: number, body: Body): RawEvent => ({ ...body, sessionId, ts, source: 'demo' }) as RawEvent;

export interface DemoStep {
  /** Offset in ms from the start of the loop. */
  at: number;
  events(ts: number): RawEvent[];
}

export const DEMO_LOOP_MS = 60_000;

export function demoScript(): DemoStep[] {
  return [
    {
      at: 0,
      events: (b) => [
        // Oldest first, each seen when it started, as the filesystem adapter reports them: floors open in that order.
        ...DEMO_SESSIONS.map((s, i) => ({ s, i, startedAt: b - (i + 1) * 600_000 })).reverse().flatMap(({ s, i, startedAt }) => [
          at(s.id, startedAt, { type: 'session.seen', workspace: s.workspace, pid: null, name: s.name, tmuxPane: s.pane, startedAt }),
          at(s.id, b + i, { type: 'title', title: s.title }),
          at(s.id, b + i, { type: 'prompt', text: s.prompt }),
        ]),
        at('demo-sw-a1', b + 20, { type: 'tool.started', toolId: 'a1-t1', tool: 'Edit', label: 'Edit src/checkout/AddressStep.tsx', agentId: null }),
        at('demo-sw-a1', b + 21, { type: 'agent.started', agentId: 'demo-a1-explore', agentType: 'Explore', description: 'Find every caller of useCart()' }),
        at('demo-sw-b2', b + 22, { type: 'turn.finished', backgroundTasks: 0 }),
        at('demo-oa-c3', b + 23, { type: 'tool.started', toolId: 'c3-t1', tool: 'Bash', label: 'Bash: rm -rf dist && npm run build', agentId: null }),
        at('demo-oa-c3', b + 24, { type: 'waiting', reason: { kind: 'permission', text: 'Bash', detail: 'Bash: rm -rf dist && npm run build' }, agentId: null }),
        at('demo-ps-d4', b + 25, { type: 'agent.started', agentId: 'demo-wf-1', agentType: 'general-purpose', description: 'Implement the split ledger entries' }),
        at('demo-ps-d4', b + 26, { type: 'agent.started', agentId: 'demo-wf-2', agentType: 'general-purpose', description: 'Implement the refund path' }),
        at('demo-ps-d4', b + 27, { type: 'turn.finished', backgroundTasks: 2 }),
        at('demo-ss-e5', b + 28, { type: 'tool.started', toolId: 'e5-t1', tool: 'Bash', label: 'Bash: npm test', agentId: null }),
        at('demo-oa-g7', b + 29, { type: 'waiting', reason: { kind: 'question', text: 'Should the retry queue use Redis or Postgres?' }, agentId: null }),
        at('demo-oa-h8', b + 30, { type: 'tool.started', toolId: 'h8-t1', tool: 'Bash', label: 'Bash: npm run typecheck', agentId: null }),
      ],
    },
    { at: 6_000, events: (b) => [at('demo-sw-a1', b, { type: 'agent.finished', agentId: 'demo-a1-explore' })] },
    { at: 10_000, events: (b) => [at('demo-oa-c3', b, { type: 'tool.finished', toolId: 'c3-t1', ok: true, agentId: null })] },
    { at: 16_000, events: (b) => [at('demo-ps-d4', b, { type: 'agent.finished', agentId: 'demo-wf-1' })] },
    { at: 22_000, events: (b) => [at('demo-oa-h8', b, { type: 'turn.finished', backgroundTasks: 0 })] },
    { at: 28_000, events: (b) => [at('demo-ps-d4', b, { type: 'agent.finished', agentId: 'demo-wf-2' })] },
    { at: 34_000, events: (b) => [at('demo-sw-a1', b, { type: 'waiting', reason: { kind: 'question', text: 'Keep the old address form behind a flag?' }, agentId: null })] },
    { at: 42_000, events: (b) => [at('demo-oa-g7', b, { type: 'prompt', text: 'Use Postgres.' })] },
    { at: 50_000, events: (b) => [at('demo-oa-c3', b, { type: 'turn.finished', backgroundTasks: 0 })] },
  ];
}

export function startDemo(ingest: (e: RawEvent) => void, opts: { loopMs?: number; now?: () => number } = {}): { stop(): void } {
  const loopMs = opts.loopMs ?? DEMO_LOOP_MS;
  const now = opts.now ?? Date.now;
  let timers: NodeJS.Timeout[] = [];
  let stopped = false;
  const loop = () => {
    if (stopped) return;
    timers = [];
    const base = now();
    for (const step of demoScript()) {
      timers.push(setTimeout(() => {
        if (!stopped) for (const e of step.events(base + step.at)) ingest(e);
      }, step.at));
    }
    timers.push(setTimeout(loop, loopMs));
  };
  loop();
  return {
    stop: () => {
      stopped = true;
      for (const t of timers) clearTimeout(t);
      timers = [];
    },
  };
}
