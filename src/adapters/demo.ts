import type { DistributiveOmit, RawEvent, Workspace } from '../core/types.js';

interface DemoSession {
  id: string;
  name: string;
  pane: string;
  workspace: Workspace;
  title: string;
  prompt: string;
  /** The status line the demo's summarizer writes for it. */
  summary: string;
}

const ws = (cwd: string, branch: string, repoRoot = cwd): Workspace => ({
  cwd,
  repoRoot,
  repoName: repoRoot.split('/').pop() ?? repoRoot,
  worktree: cwd !== repoRoot,
  branch,
});

export const DEMO_SESSIONS: DemoSession[] = [
  { id: 'demo-sw-a1', name: 'storefront-web-a1', pane: '%4', workspace: ws('/demo/storefront-web', 'feat/checkout-v2'), title: 'Build the address step of the new checkout', prompt: 'Build the address step', summary: 'Builds the address step of the new checkout while two helpers check the form' },
  { id: 'demo-sw-b2', name: 'storefront-web-b2', pane: '%5', workspace: ws('/demo/storefront-web', 'feat/checkout-v2'), title: 'Rewrite checkout copy and empty states', prompt: 'Rewrite the checkout copy', summary: 'Checkout copy and empty states are rewritten and ready for review' },
  { id: 'demo-oa-c3', name: 'orders-api-c3', pane: '%7', workspace: ws('/demo/orders-api/.worktrees/checkout-v2', 'feat/checkout-v2', '/demo/orders-api'), title: 'Add idempotency keys to POST /orders', prompt: 'Add idempotency keys', summary: 'Idempotency keys are in; waits for permission to rebuild dist' },
  { id: 'demo-ps-d4', name: 'payments-svc-d4', pane: '%9', workspace: ws('/demo/payments-svc', 'feat/checkout-v2'), title: 'Support split payments across two cards', prompt: 'Support split payments', summary: 'Split payments are in; checkout-verify plans, builds, reviews and ships them' },
  { id: 'demo-ss-e5', name: 'search-svc-e5', pane: '%11', workspace: ws('/demo/search-svc', 'feat/search-ranking'), title: 'Tune BM25 weights with click data', prompt: 'Tune the ranking weights', summary: 'Tunes the BM25 weights with click data while the test suite runs' },
  { id: 'demo-oa-g7', name: 'orders-api-g7', pane: '%2', workspace: ws('/demo/orders-api', 'main'), title: 'Investigate duplicate confirmation emails', prompt: 'Why do customers get two emails?', summary: 'Traced the duplicate emails to the retry queue; asks whether it should use Redis or Postgres' },
  { id: 'demo-oa-h8', name: 'orders-api-h8', pane: '%3', workspace: ws('/demo/orders-api', 'main'), title: 'Bump dependencies and fix type errors', prompt: 'Bump dependencies', summary: 'Dependencies are bumped and the type errors fixed' },
];

type Body = DistributiveOmit<RawEvent, 'sessionId' | 'ts' | 'source'>;
const at = (sessionId: string, ts: number, body: Body): RawEvent => ({ ...body, sessionId, ts, source: 'demo' }) as RawEvent;

export interface DemoStep {
  /** Offset in ms from the start of the loop. */
  at: number;
  events(ts: number): RawEvent[];
}

export const DEMO_LOOP_MS = 60_000;

/** The demo's workflow run, on the payments desk. */
export const DEMO_RUN = { name: 'checkout-verify', summary: 'Verify split payments end to end', phases: ['Plan', 'Build', 'Review', 'Ship'] };

/**
 * The run and agent ids of a loop. A finished run never starts again, so each loop runs a run of its own:
 * wf_demo-checkout first, then wf_demo-checkout-2, wf_demo-checkout-3, and so on, each with its own agents.
 */
export function demoRunIds(loop = 0): { runId: string; agent: (n: number) => string } {
  const suffix = loop === 0 ? '' : `-${loop + 1}`;
  return { runId: `wf_demo-checkout${suffix}`, agent: (n) => `demo-wf-${n}${suffix}` };
}

/**
 * One loop of the demo. The payments desk runs a workflow whose phases advance: one agent plans, two build, one
 * reviews, one ships, and the run completes before the loop ends. A new agent starts before the last one finishes, so
 * the run holds its desk in the meeting throughout. The address desk has two interns. Every session that ends a turn
 * replies first. Later loops send their prompts without text: the sessions start over, but nobody asks anything new, so
 * the summary lines written in the first loop stay current.
 */
export function demoScript(loop = 0): DemoStep[] {
  const { runId, agent } = demoRunIds(loop);
  const runAgent = (n: number, phase: string, description: string): Body => ({ type: 'agent.started', agentId: agent(n), agentType: 'workflow-subagent', description, runId, phase });
  const finish = (n: number): Body => ({ type: 'agent.finished', agentId: agent(n) });
  return [
    {
      at: 0,
      events: (b) => [
        // Oldest first, each seen when it started, as the filesystem adapter reports them: floors open in that order.
        ...DEMO_SESSIONS.map((s, i) => ({ s, i, startedAt: b - (i + 1) * 600_000 })).reverse().flatMap(({ s, i, startedAt }) => [
          at(s.id, startedAt, { type: 'session.seen', workspace: s.workspace, pid: null, name: s.name, tmuxPane: s.pane, startedAt }),
          at(s.id, b + i, { type: 'title', title: s.title }),
          at(s.id, b + i, { type: 'prompt', text: loop === 0 ? s.prompt : null }),
        ]),
        at('demo-sw-a1', b + 20, { type: 'tool.started', toolId: 'a1-t1', tool: 'Edit', label: 'Edit src/checkout/AddressStep.tsx', agentId: null }),
        at('demo-sw-a1', b + 21, { type: 'agent.started', agentId: 'demo-a1-explore', agentType: 'Explore', description: 'Find every caller of useCart()' }),
        at('demo-sw-a1', b + 21, { type: 'agent.started', agentId: 'demo-a1-review', agentType: 'general-purpose', description: 'Check the address form against the design' }),
        at('demo-sw-b2', b + 22, { type: 'answer', text: 'I rewrote the checkout copy and the three empty states. The strings are in src/copy/checkout.json.' }),
        at('demo-sw-b2', b + 22, { type: 'turn.finished', backgroundTasks: 0 }),
        at('demo-oa-c3', b + 23, { type: 'tool.started', toolId: 'c3-t1', tool: 'Bash', label: 'Bash: rm -rf dist && npm run build', agentId: null }),
        at('demo-oa-c3', b + 24, { type: 'waiting', reason: { kind: 'permission', text: 'Bash', detail: 'Bash: rm -rf dist && npm run build' }, agentId: null }),
        at('demo-ps-d4', b + 25, { type: 'workflow.started', runId, name: DEMO_RUN.name, summary: DEMO_RUN.summary, phases: [...DEMO_RUN.phases] }),
        at('demo-ps-d4', b + 25, runAgent(0, 'Plan', 'Map the split payment flow')),
        at('demo-ps-d4', b + 27, { type: 'answer', text: 'Split payments are in. I started checkout-verify to check them end to end.' }),
        at('demo-ps-d4', b + 27, { type: 'turn.finished', backgroundTasks: 0 }),
        at('demo-ss-e5', b + 28, { type: 'tool.started', toolId: 'e5-t1', tool: 'Bash', label: 'Bash: npm test', agentId: null }),
        at('demo-oa-g7', b + 29, { type: 'waiting', reason: { kind: 'question', text: 'Should the retry queue use Redis or Postgres?' }, agentId: null }),
        at('demo-oa-h8', b + 30, { type: 'tool.started', toolId: 'h8-t1', tool: 'Bash', label: 'Bash: npm run typecheck', agentId: null }),
      ],
    },
    { at: 6_000, events: (b) => [at('demo-sw-a1', b, { type: 'agent.finished', agentId: 'demo-a1-explore' })] },
    {
      at: 8_000,
      events: (b) => [
        at('demo-ps-d4', b, runAgent(1, 'Build', 'Implement the split ledger entries')),
        at('demo-ps-d4', b, runAgent(2, 'Build', 'Implement the refund path')),
        at('demo-ps-d4', b, finish(0)),
      ],
    },
    { at: 10_000, events: (b) => [at('demo-oa-c3', b, { type: 'tool.finished', toolId: 'c3-t1', ok: true, agentId: null })] },
    { at: 16_000, events: (b) => [at('demo-ps-d4', b, finish(1))] },
    {
      at: 22_000,
      events: (b) => [
        at('demo-oa-h8', b, { type: 'answer', text: 'Dependencies are bumped and the four type errors are fixed. npm run typecheck passes.' }),
        at('demo-oa-h8', b, { type: 'turn.finished', backgroundTasks: 0 }),
      ],
    },
    { at: 28_000, events: (b) => [at('demo-ps-d4', b, runAgent(3, 'Review', 'Review the ledger and refund changes')), at('demo-ps-d4', b, finish(2))] },
    { at: 30_000, events: (b) => [at('demo-sw-a1', b, { type: 'agent.finished', agentId: 'demo-a1-review' })] },
    { at: 34_000, events: (b) => [at('demo-sw-a1', b, { type: 'waiting', reason: { kind: 'question', text: 'Keep the old address form behind a flag?' }, agentId: null })] },
    { at: 40_000, events: (b) => [at('demo-ps-d4', b, runAgent(4, 'Ship', 'Run the checkout suite on staging')), at('demo-ps-d4', b, finish(3))] },
    { at: 42_000, events: (b) => [at('demo-oa-g7', b, { type: 'prompt', text: loop === 0 ? 'Use Postgres.' : null })] },
    {
      at: 50_000,
      events: (b) => [
        at('demo-oa-c3', b, { type: 'answer', text: 'POST /orders now takes an Idempotency-Key header and replays the first response.' }),
        at('demo-oa-c3', b, { type: 'turn.finished', backgroundTasks: 0 }),
      ],
    },
    { at: 52_000, events: (b) => [at('demo-ps-d4', b, finish(4)), at('demo-ps-d4', b, { type: 'workflow.finished', runId, status: 'completed' })] },
  ];
}

/** The line the demo's summarizer writes from a session's notes: the demo session's own, found by its title. */
export function demoSummaryLine(input: string): string {
  const title = /^Title: (.*)$/m.exec(input)?.[1];
  return DEMO_SESSIONS.find((s) => s.title === title)?.summary ?? 'Working through the demo script';
}

export function startDemo(ingest: (e: RawEvent) => void, opts: { loopMs?: number; now?: () => number } = {}): { stop(): void } {
  const loopMs = opts.loopMs ?? DEMO_LOOP_MS;
  const now = opts.now ?? Date.now;
  let timers: NodeJS.Timeout[] = [];
  let stopped = false;
  let loops = 0;
  const loop = () => {
    if (stopped) return;
    timers = [];
    const base = now();
    for (const step of demoScript(loops++)) {
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
