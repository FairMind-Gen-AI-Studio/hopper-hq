import type { DistributiveOmit, RawEvent, Workspace } from '../core/types.js';
import { SHOWCASE_SESSIONS, showcaseScript } from './showcase.js';

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

/**
 * Sessions that drop in on the checkout floor for part of each loop, in the order they arrive (demoScript). None of them
 * needs you or finishes a turn, so the attention bar lists only DEMO_SESSIONS.
 */
export const DEMO_DROP_INS: DemoSession[] = [
  { id: 'demo-sw-i9', name: 'storefront-web-i9', pane: '%13', workspace: ws('/demo/storefront-web', 'feat/checkout-v2'), title: 'Add a gift note to the cart', prompt: 'Add a gift note', summary: 'Adds a gift note to the cart and shows it on the order summary' },
  { id: 'demo-oa-j10', name: 'orders-api-j10', pane: '%14', workspace: ws('/demo/orders-api/.worktrees/checkout-v2', 'feat/checkout-v2', '/demo/orders-api'), title: 'Explain the order states', prompt: 'Which states can an order be in?', summary: 'Walks through the states an order and its refunds can be in' },
  { id: 'demo-ps-k11', name: 'payments-svc-k11', pane: '%15', workspace: ws('/demo/payments-svc', 'feat/checkout-v2'), title: 'Log each leg of a split payment', prompt: 'Log split payment legs', summary: 'Logs one line per leg of a split payment, with its card and amount' },
  { id: 'demo-sw-l12', name: 'storefront-web-l12', pane: '%16', workspace: ws('/demo/storefront-web', 'feat/checkout-v2'), title: 'Show the delivery estimate at checkout', prompt: 'Show a delivery estimate', summary: 'Shows the delivery estimate on the review step of the checkout' },
  { id: 'demo-ps-m13', name: 'payments-svc-m13', pane: '%17', workspace: ws('/demo/payments-svc', 'feat/checkout-v2'), title: 'Retry a declined card once', prompt: 'Retry declined cards once', summary: 'Retries a declined card once before asking for another one' },
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

/** The demo's second workflow run, on the orders desk of the checkout floor. */
export const DEMO_REPLAY = { name: 'orders-replay', summary: 'Replay a day of orders against the idempotency keys', phases: ['Sample', 'Replay', 'Compare'] };

/**
 * The run and agent ids of a loop's checkout run (DEMO_RUN) or replay run (DEMO_REPLAY). A finished run never starts
 * again, so each loop runs runs of its own: wf_demo-checkout first, then wf_demo-checkout-2, wf_demo-checkout-3, and so
 * on, each with its own agents, and likewise wf_demo-replay, wf_demo-replay-2 and on.
 */
export function demoRunIds(loop = 0, run: 'checkout' | 'replay' = 'checkout'): { runId: string; agent: (n: number) => string } {
  const suffix = loop === 0 ? '' : `-${loop + 1}`;
  const agents = run === 'checkout' ? 'demo-wf' : 'demo-rp';
  return { runId: `wf_demo-${run}${suffix}`, agent: (n) => `${agents}-${n}${suffix}` };
}

/**
 * One loop of the demo, its steps in time order, all within DEMO_LOOP_MS.
 *
 * The payments desk runs a workflow whose phases advance: one agent plans, two build, one reviews, one ships, and the
 * run completes before the loop ends. A new agent starts before the last one finishes, so the run holds its desk in the
 * meeting throughout. Before it completes, the orders desk on the same floor starts a replay run, which the next loop
 * completes once its own checkout run has begun: a meeting room is always open. The address desk has two interns.
 * Every session that ends a turn replies first.
 *
 * The drop-ins (DEMO_DROP_INS) come to the checkout floor one by one and end one by one: while they are all there, the
 * floor holds nine sessions, one more than a block has desks, so in the first loop it grows a block. One of them is
 * cleared, as by /clear, and waits idle in the lounge until its next prompt.
 *
 * Later loops send their prompts without text: the sessions start over, but nobody asks anything new, so the summary
 * lines written in the first loop stay current. A drop-in that ended comes back the same way, as a resumed session.
 */
export function demoScript(loop = 0): DemoStep[] {
  const checkout = demoRunIds(loop);
  const { runId } = checkout;
  const replay = demoRunIds(loop, 'replay');
  const runAgent = (n: number, phase: string, description: string, run = checkout): Body => ({ type: 'agent.started', agentId: run.agent(n), agentType: 'workflow-subagent', description, runId: run.runId, phase });
  const finish = (n: number, run = checkout): Body => ({ type: 'agent.finished', agentId: run.agent(n) });
  const [gift, states, legs, estimate, retry] = DEMO_DROP_INS as [DemoSession, DemoSession, DemoSession, DemoSession, DemoSession];
  /** A drop-in comes to work: seen as it starts (the earliest start is kept), asked, and at its first tool. */
  const arrive = (s: DemoSession, b: number, tool: string, label: string): RawEvent[] => [
    at(s.id, b, { type: 'session.seen', workspace: s.workspace, pid: null, name: s.name, tmuxPane: s.pane, startedAt: b }),
    at(s.id, b, { type: 'title', title: s.title }),
    at(s.id, b, { type: 'prompt', text: loop === 0 ? s.prompt : null }),
    at(s.id, b, { type: 'tool.started', toolId: `${s.id}-t1`, tool, label, agentId: null }),
  ];
  const end = (s: DemoSession, b: number): RawEvent => at(s.id, b, { type: 'session.ended', reason: 'prompt_input_exit' });
  /** In later loops, the replay run the loop before started: its last phase, then its end. */
  const before = loop === 0 ? null : demoRunIds(loop - 1, 'replay');
  const compare: DemoStep[] = before
    ? [
      {
        at: 3_000,
        events: (b) => [
          at('demo-oa-c3', b, runAgent(3, 'Compare', 'Compare the replies with the first ones', before)),
          at('demo-oa-c3', b, finish(1, before)),
          at('demo-oa-c3', b, finish(2, before)),
        ],
      },
    ]
    : [];
  const completed: DemoStep[] = before
    ? [{ at: 7_000, events: (b) => [at('demo-oa-c3', b, finish(3, before)), at('demo-oa-c3', b, { type: 'workflow.finished', runId: before.runId, status: 'completed' })] }]
    : [];
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
    ...compare,
    { at: 5_000, events: (b) => arrive(gift, b, 'Edit', 'Edit src/cart/GiftNote.tsx') },
    { at: 6_000, events: (b) => [at('demo-sw-a1', b, { type: 'agent.finished', agentId: 'demo-a1-explore' })] },
    ...completed,
    {
      at: 8_000,
      events: (b) => [
        at('demo-ps-d4', b, runAgent(1, 'Build', 'Implement the split ledger entries')),
        at('demo-ps-d4', b, runAgent(2, 'Build', 'Implement the refund path')),
        at('demo-ps-d4', b, finish(0)),
      ],
    },
    { at: 10_000, events: (b) => [at('demo-oa-c3', b, { type: 'tool.finished', toolId: 'c3-t1', ok: true, agentId: null })] },
    { at: 13_000, events: (b) => arrive(states, b, 'Read', 'Read src/orders/states.ts') },
    { at: 16_000, events: (b) => [at('demo-ps-d4', b, finish(1))] },
    // Stopped and cleared, as by Esc and /clear: it waits for a prompt, idle, in the lounge.
    { at: 20_000, events: (b) => [at(states.id, b, { type: 'session.started' })] },
    { at: 21_000, events: (b) => arrive(legs, b, 'Edit', 'Edit src/ledger/split.ts') },
    {
      at: 22_000,
      events: (b) => [
        at('demo-oa-h8', b, { type: 'answer', text: 'Dependencies are bumped and the four type errors are fixed. npm run typecheck passes.' }),
        at('demo-oa-h8', b, { type: 'turn.finished', backgroundTasks: 0 }),
      ],
    },
    { at: 28_000, events: (b) => [at('demo-ps-d4', b, runAgent(3, 'Review', 'Review the ledger and refund changes')), at('demo-ps-d4', b, finish(2))] },
    { at: 29_000, events: (b) => arrive(estimate, b, 'Edit', 'Edit src/checkout/ReviewStep.tsx') },
    { at: 30_000, events: (b) => [at('demo-sw-a1', b, { type: 'agent.finished', agentId: 'demo-a1-review' })] },
    { at: 34_000, events: (b) => [at('demo-sw-a1', b, { type: 'waiting', reason: { kind: 'question', text: 'Keep the old address form behind a flag?' }, agentId: null })] },
    { at: 36_000, events: (b) => [at(states.id, b, { type: 'prompt', text: loop === 0 ? 'Which states can a refund be in?' : null })] },
    // The ninth session on the floor: one more than a block has desks.
    { at: 37_000, events: (b) => arrive(retry, b, 'Bash', 'Bash: npm test -- retry') },
    { at: 40_000, events: (b) => [at('demo-ps-d4', b, runAgent(4, 'Ship', 'Run the checkout suite on staging')), at('demo-ps-d4', b, finish(3))] },
    { at: 42_000, events: (b) => [at('demo-oa-g7', b, { type: 'prompt', text: loop === 0 ? 'Use Postgres.' : null })] },
    { at: 43_000, events: (b) => [end(gift, b)] },
    {
      at: 44_000,
      events: (b) => [
        at('demo-oa-c3', b, { type: 'workflow.started', runId: replay.runId, name: DEMO_REPLAY.name, summary: DEMO_REPLAY.summary, phases: [...DEMO_REPLAY.phases] }),
        at('demo-oa-c3', b, runAgent(0, 'Sample', 'Pick a day of orders to replay', replay)),
      ],
    },
    { at: 46_000, events: (b) => [end(states, b)] },
    {
      at: 48_000,
      events: (b) => [
        at('demo-oa-c3', b, runAgent(1, 'Replay', 'Replay the morning orders', replay)),
        at('demo-oa-c3', b, runAgent(2, 'Replay', 'Replay the evening orders', replay)),
        at('demo-oa-c3', b, finish(0, replay)),
      ],
    },
    {
      at: 50_000,
      events: (b) => [
        at('demo-oa-c3', b, { type: 'answer', text: 'POST /orders now takes an Idempotency-Key header and replays the first response. I started orders-replay to try it on a day of orders.' }),
        at('demo-oa-c3', b, { type: 'turn.finished', backgroundTasks: 0 }),
      ],
    },
    { at: 52_000, events: (b) => [at('demo-ps-d4', b, finish(4)), at('demo-ps-d4', b, { type: 'workflow.finished', runId, status: 'completed' })] },
    { at: 54_000, events: (b) => [end(legs, b)] },
    { at: 56_000, events: (b) => [end(estimate, b)] },
    { at: 58_000, events: (b) => [end(retry, b)] },
  ];
}

/** The line the demo's summarizer writes from a session's notes: the demo session's own, found by its title. */
export function demoSummaryLine(input: string): string {
  const title = /^Title: (.*)$/m.exec(input)?.[1];
  return [...DEMO_SESSIONS, ...DEMO_DROP_INS, ...Object.values(SHOWCASE_SESSIONS)].find((s) => s.title === title)?.summary ?? 'Working through the demo script';
}

/** With `showcase`, the demo plays the showcase script once (showcase.ts) instead of looping its own. */
export function startDemo(ingest: (e: RawEvent) => void, opts: { loopMs?: number; now?: () => number; showcase?: boolean } = {}): { stop(): void } {
  const loopMs = opts.loopMs ?? DEMO_LOOP_MS;
  const now = opts.now ?? Date.now;
  let timers: NodeJS.Timeout[] = [];
  let stopped = false;
  let loops = 0;
  const loop = () => {
    if (stopped) return;
    timers = [];
    const base = now();
    for (const step of opts.showcase ? showcaseScript() : demoScript(loops++)) {
      timers.push(setTimeout(() => {
        if (!stopped) for (const e of step.events(base + step.at)) ingest(e);
      }, step.at));
    }
    if (!opts.showcase) timers.push(setTimeout(loop, loopMs));
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
