import { classifyMcp, toolLabel } from '../core/tool-label.js';
import type { AgentKind, DistributiveOmit, RawEvent, Workspace } from '../core/types.js';
import { SHOWCASE_SESSIONS, showcaseScript } from './showcase.js';

interface DemoSession {
  id: string;
  agentKind?: AgentKind;
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
  { id: 'demo-sw-a1', agentKind: 'codex', name: 'storefront-web-a1', pane: '%4', workspace: ws('/demo/storefront-web', 'feat/checkout-v2'), title: 'Build the address step of the new checkout', prompt: 'Build the address step', summary: 'Builds the address step of the new checkout while two helpers check the form' },
  { id: 'demo-sw-b2', name: 'storefront-web-b2', pane: '%5', workspace: ws('/demo/storefront-web', 'feat/checkout-v2'), title: 'Rewrite checkout copy and empty states', prompt: 'Rewrite the checkout copy', summary: 'Checkout copy and empty states are rewritten and ready for review' },
  { id: 'demo-oa-c3', agentKind: 'codex', name: 'orders-api-c3', pane: '%7', workspace: ws('/demo/orders-api/.worktrees/checkout-v2', 'feat/checkout-v2', '/demo/orders-api'), title: 'Add idempotency keys to POST /orders', prompt: 'Add idempotency keys', summary: 'Idempotency keys are in; waits for permission to rebuild dist' },
  { id: 'demo-ps-d4', name: 'payments-svc-d4', pane: '%9', workspace: ws('/demo/payments-svc', 'feat/checkout-v2'), title: 'Support split payments across two cards', prompt: 'Support split payments', summary: 'Split payments are in; checkout-verify plans, builds, reviews and ships them' },
  { id: 'demo-ss-e5', name: 'search-svc-e5', pane: '%11', workspace: ws('/demo/search-svc', 'feat/search-ranking'), title: 'Tune BM25 weights with click data', prompt: 'Tune the ranking weights', summary: 'Tunes the BM25 weights with click data while the test suite runs' },
  { id: 'demo-oa-g7', name: 'orders-api-g7', pane: '%2', workspace: ws('/demo/orders-api', 'main'), title: 'Investigate duplicate confirmation emails', prompt: 'Why do customers get two emails?', summary: 'Traced the duplicate emails to the retry queue; asks whether it should use Redis or Postgres' },
  { id: 'demo-oa-h8', agentKind: 'codex', name: 'orders-api-h8', pane: '%3', workspace: ws('/demo/orders-api', 'main'), title: 'Bump dependencies and fix type errors', prompt: 'Bump dependencies', summary: 'Dependencies are bumped and the type errors fixed' },
];

/**
 * Sessions that drop in on the checkout floor for part of each loop, in the order they arrive (demoScript). None of them
 * needs you or finishes a turn, so the attention bar lists only DEMO_SESSIONS.
 */
export const DEMO_DROP_INS: DemoSession[] = [
  { id: 'demo-sw-i9', name: 'storefront-web-i9', pane: '%13', workspace: ws('/demo/storefront-web', 'feat/checkout-v2'), title: 'Add a gift note to the cart', prompt: 'Add a gift note', summary: 'Adds a gift note to the cart and shows it on the order summary' },
  { id: 'demo-oa-j10', name: 'orders-api-j10', pane: '%14', workspace: ws('/demo/orders-api/.worktrees/checkout-v2', 'feat/checkout-v2', '/demo/orders-api'), title: 'Explain the order states', prompt: 'Which states can an order be in?', summary: 'Walks through the states an order and its refunds can be in' },
  { id: 'demo-ps-k11', agentKind: 'codex', name: 'payments-svc-k11', pane: '%15', workspace: ws('/demo/payments-svc', 'feat/checkout-v2'), title: 'Log each leg of a split payment', prompt: 'Log split payment legs', summary: 'Logs one line per leg of a split payment, with its card and amount' },
  { id: 'demo-sw-l12', agentKind: 'codex', name: 'storefront-web-l12', pane: '%16', workspace: ws('/demo/storefront-web', 'feat/checkout-v2'), title: 'Show the delivery estimate at checkout', prompt: 'Show a delivery estimate', summary: 'Shows the delivery estimate on the review step of the checkout' },
  { id: 'demo-ps-m13', name: 'payments-svc-m13', pane: '%17', workspace: ws('/demo/payments-svc', 'feat/checkout-v2'), title: 'Retry a declined card once', prompt: 'Retry declined cards once', summary: 'Retries a declined card once before asking for another one' },
];

type Body = DistributiveOmit<RawEvent, 'sessionId' | 'ts' | 'source'>;
const at = (sessionId: string, ts: number, body: Body): RawEvent => ({ ...body, sessionId, ts, source: 'demo' }) as RawEvent;

/**
 * A started MCP call's `tool`/`label`/`mcp`, classified exactly as the real hooks adapter does on `PreToolUse`
 * (hooks.ts: `classifyMcp(toolName)` + `toolLabel(toolName, input, cwd)`) — so the demo's switchboard beats (the
 * floor headset, the façade line, the DOM chip) render from the same data a live MCP call would produce, not a
 * hand-built shortcut (hq-mcp-switchboard proposal.md).
 */
function mcpStart(toolId: string, tool: string, agentId: string | null): Body {
  const mcp = classifyMcp(tool);
  if (!mcp) throw new Error(`demo.ts: not an MCP tool name: ${tool}`);
  return { type: 'tool.started', toolId, tool, label: toolLabel(tool, {}), agentId, mcp };
}

export interface DemoStep {
  /** Offset in ms from the start of the loop. */
  at: number;
  events(ts: number): RawEvent[];
}

export const DEMO_LOOP_MS = 60_000;

/**
 * The hour (viewer-local, 0-23) `startDemo` forces the leisure window (config.ts) open to, so
 * the office aperitivo/biliardino always shows in `hopper-hq demo` whatever time of day it runs.
 * Well inside the default 17:00 -> 02:00 window, away from both edges. Only `daemon.ts`'s demo
 * path reads this (gated behind `opts.demo`, next to its other demo-only overrides); a real
 * daemon still reads the viewer's actual local hour.
 */
export const DEMO_LEISURE_HOUR = 18;

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
 * The checkout-verify run's five agents are typed to plugin roles instead of the plain `workflow-subagent`, so the
 * meeting room shows five distinct personas at once (hq-agent-personas TP3): Plan's agent reads as the tech lead
 * (Hartman), the two Build agents as the developer (nerd) and the security engineer (secret service), Review's agent
 * as the reviewer (English judge), and Ship's as QA (Sherlock). Each carries the `fairmind-coding:` namespace, so
 * they also wear the Fairmind badge. The replay run on the orders desk keeps the plain `workflow-subagent` type (no
 * persona), on purpose: the two runs side by side show a typed cast next to the untyped default.
 *
 * The drop-ins (DEMO_DROP_INS) come to the checkout floor one by one and end one by one: while they are all there, the
 * floor holds nine sessions, one more than a block has desks, so in the first loop it grows a block. One of them is
 * cleared, as by /clear, and waits idle in the lounge until its next prompt.
 *
 * Later loops send their prompts without text: the sessions start over, but nobody asks anything new, so the summary
 * lines written in the first loop stay current. A drop-in that ended comes back the same way, as a resumed session.
 *
 * Two beats double as the whimsical features' demo (`startDemo` forces the leisure window open with
 * `DEMO_LEISURE_HOUR`, since it is otherwise wall-clock-gated): between 6s and 30s the address desk's two interns hold
 * a lone gin tonic (one finishes while the other keeps running), and between 16s and 28s the payments desk's workflow
 * run holds a biliardino pair (two of its agents finish in the Build phase while a third keeps running) — no separate
 * cohort was added for this; it falls out of the existing interns and run. The search desk's `Bash: npm run test:smoke`
 * from 28s to 45s holds a cigar (Feature B).
 *
 * Twelve beats exercise the MCP switchboard (hq-mcp-switchboard proposal.md), none of them disturbing a session or
 * run agent already scripted above — each lands on a desk/agent that is otherwise idle at that moment, so it never
 * overwrites a tracked state (an open permission wait, a smoke test, a meeting's room slot). The address desk
 * (demo-sw-a1) places a Slack post at 4-4.5s while its own Explore intern (demo-a1-explore) places a Playwright
 * call at 4.2-4.7s — a session's headset and an intern's headset lit on the same desk at once — both before the
 * desk's own `waiting` at 34s; at 9-9.5s the dependency desk (demo-oa-h8) calls Google Sheets and the
 * checkout-verify run's Build-phase agent (demo-wf-1) calls ClickUp at the same two instants — two distinct
 * servers live across the building at once, the one honest read of parallelism the rooftop switchboard exists for;
 * at 18-18.5s the checkout-verify run's own Build-phase Security Engineer (checkout.agent(2), running 8-28s)
 * calls FairMind's `rag_search_docs` (read, the General family, "document / archive beam") — a sub-agent again,
 * like the three FairMind beats below it, never the session itself (a checkout desk hosts a meeting room for its
 * whole run; a tool.started on the session itself would read as the desk's own state, not the room's). The
 * address desk's review intern (demo-a1-review) places a call that is dropped (ok:false) at 24-24.5s, then a
 * FairMind `Brain_record_decision` (write, by the Review-phase run agent, checkout.agent(3)) at 32-32.5s,
 * immediately followed by that same agent's FairMind `Code_search_symbol` (read) at 33-33.5s — the Brain and
 * Code VIP forms visible, in turn, on the same room agent's headset (Phase 3, proposal.md §5, user-decisions.md
 * Q2 "Brain-core orb first"); at 48.5-48.7s the Ship-phase QA Engineer (checkout.agent(4), running 40-52s) calls
 * FairMind's `bulk_update_status` (write, no family at all — the "sensible default form"). The orders-investigate
 * desk (demo-oa-g7) is `needs_you` (its own `waiting`, b+29 within the opening batch) for nearly the whole loop,
 * cleared only by its own prompt at 42s — a Notion search (read) at 47-47.5s, six parallel calls (clickup, Notion,
 * Google Calendar, Gmail, Google Drive, Slack — "parallel MCP calls" follow-up, from a real report) all open at
 * once at 49-50.7s, a FairMind `Studio_get_task` (read, by the session itself, not a sub-agent) at 51-51.5s, and a
 * FairMind `Insights_record_loop_stats` (write, always-outgoing) at 53-53.5s all land after that, the only part of
 * the loop a tool.started on g7's own session would not immediately clear its needs_you wait.
 */
export function demoScript(loop = 0): DemoStep[] {
  const checkout = demoRunIds(loop);
  const { runId } = checkout;
  const replay = demoRunIds(loop, 'replay');
  const runAgent = (n: number, phase: string, description: string, run = checkout, agentType = 'workflow-subagent'): Body => ({ type: 'agent.started', agentId: run.agent(n), agentType, description, runId: run.runId, phase });
  const finish = (n: number, run = checkout): Body => ({ type: 'agent.finished', agentId: run.agent(n) });
  const [gift, states, legs, estimate, retry] = DEMO_DROP_INS as [DemoSession, DemoSession, DemoSession, DemoSession, DemoSession];
  /** A drop-in comes to work: seen as it starts (the earliest start is kept), asked, and at its first tool. */
  const arrive = (s: DemoSession, b: number, tool: string, label: string): RawEvent[] => [
    at(s.id, b, { type: 'session.seen', agentKind: s.agentKind ?? 'claude-code', workspace: s.workspace, pid: null, name: s.name, tmuxPane: s.pane, startedAt: b }),
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
          at(s.id, startedAt, { type: 'session.seen', agentKind: s.agentKind ?? 'claude-code', workspace: s.workspace, pid: null, name: s.name, tmuxPane: s.pane, startedAt }),
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
        at('demo-ps-d4', b + 25, runAgent(0, 'Plan', 'Map the split payment flow', checkout, 'fairmind-coding:Technical Lead / Architect')),
        at('demo-ps-d4', b + 27, { type: 'answer', text: 'Split payments are in. I started checkout-verify to check them end to end.' }),
        at('demo-ps-d4', b + 27, { type: 'turn.finished', backgroundTasks: 0 }),
        // A smoke test: the mega sigaro (Feature B) shows on this desk from here until the tool.finished at 45s.
        at('demo-ss-e5', b + 28, { type: 'tool.started', toolId: 'e5-t1', tool: 'Bash', label: 'Bash: npm run test:smoke', agentId: null, smoke: true }),
        at('demo-oa-g7', b + 29, { type: 'waiting', reason: { kind: 'question', text: 'Should the retry queue use Redis or Postgres?' }, agentId: null }),
        at('demo-oa-h8', b + 30, { type: 'tool.started', toolId: 'h8-t1', tool: 'Bash', label: 'Bash: npm run typecheck', agentId: null }),
      ],
    },
    ...compare,
    // MCP switchboard: a Slack post, well before this desk's own `waiting` at 34s.
    { at: 4_000, events: (b) => [at('demo-sw-a1', b, mcpStart('a1-mcp1', 'mcp__Slack__chat_postMessage', null))] },
    // MCP switchboard: a Playwright call on the address desk's own Explore intern, overlapping the session's own
    // Slack call above — a session's headset and an intern's headset both lit on the same desk at once.
    { at: 4_200, events: (b) => [at('demo-sw-a1', b, mcpStart('a1e-mcp1', 'mcp__Playwright__browser_snapshot', 'demo-a1-explore'))] },
    { at: 4_500, events: (b) => [at('demo-sw-a1', b, { type: 'tool.finished', toolId: 'a1-mcp1', ok: true, agentId: null })] },
    { at: 4_700, events: (b) => [at('demo-sw-a1', b, { type: 'tool.finished', toolId: 'a1e-mcp1', ok: true, agentId: 'demo-a1-explore' })] },
    { at: 5_000, events: (b) => arrive(gift, b, 'Edit', 'Edit src/cart/GiftNote.tsx') },
    { at: 6_000, events: (b) => [at('demo-sw-a1', b, { type: 'agent.finished', agentId: 'demo-a1-explore' })] },
    ...completed,
    {
      at: 8_000,
      events: (b) => [
        at('demo-ps-d4', b, runAgent(1, 'Build', 'Implement the split ledger entries', checkout, 'fairmind-coding:Software Engineer')),
        at('demo-ps-d4', b, runAgent(2, 'Build', 'Implement the refund path', checkout, 'fairmind-coding:Security Engineer')),
        at('demo-ps-d4', b, finish(0)),
      ],
    },
    // MCP switchboard: parallel calls to two distinct servers — the dependency desk calls Google Sheets while the
    // Build-phase agent (running 8s-16s) calls ClickUp, both live at once.
    {
      at: 9_000,
      events: (b) => [
        at('demo-oa-h8', b, mcpStart('h8-mcp1', 'mcp__GoogleSheets__read_values', null)),
        at('demo-ps-d4', b, mcpStart('wf1-mcp1', 'mcp__ClickUp__get_task', checkout.agent(1))),
      ],
    },
    {
      at: 9_500,
      events: (b) => [
        at('demo-oa-h8', b, { type: 'tool.finished', toolId: 'h8-mcp1', ok: true, agentId: null }),
        at('demo-ps-d4', b, { type: 'tool.finished', toolId: 'wf1-mcp1', ok: true, agentId: checkout.agent(1) }),
      ],
    },
    { at: 10_000, events: (b) => [at('demo-oa-c3', b, { type: 'tool.finished', toolId: 'c3-t1', ok: true, agentId: null })] },
    { at: 13_000, events: (b) => arrive(states, b, 'Read', 'Read src/orders/states.ts') },
    { at: 16_000, events: (b) => [at('demo-ps-d4', b, finish(1))] },
    // MCP switchboard (Phase 3): FairMind rag_search_docs (read, the General family), by the checkout-verify run's
    // own Build-phase Security Engineer (checkout.agent(2), running 8-28s) — on a sub-agent, never the session
    // itself, so it never touches the payments desk's own state (the same reason the Brain/Code beats below land
    // on a sub-agent too). The "document / archive beam" motif.
    { at: 18_000, events: (b) => [at('demo-ps-d4', b, mcpStart('wf2-mcp1', 'mcp__Fairmind__rag_search_docs', checkout.agent(2)))] },
    { at: 18_500, events: (b) => [at('demo-ps-d4', b, { type: 'tool.finished', toolId: 'wf2-mcp1', ok: true, agentId: checkout.agent(2) })] },
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
    // MCP switchboard: a dropped call (error), on the address desk's review intern.
    { at: 24_000, events: (b) => [at('demo-sw-a1', b, mcpStart('a1r-mcp1', 'mcp__Notion__create_page', 'demo-a1-review'))] },
    { at: 24_500, events: (b) => [at('demo-sw-a1', b, { type: 'tool.finished', toolId: 'a1r-mcp1', ok: false, agentId: 'demo-a1-review' })] },
    { at: 28_000, events: (b) => [at('demo-ps-d4', b, runAgent(3, 'Review', 'Review the ledger and refund changes', checkout, 'fairmind-coding:Code Reviewer')), at('demo-ps-d4', b, finish(2))] },
    { at: 29_000, events: (b) => arrive(estimate, b, 'Edit', 'Edit src/checkout/ReviewStep.tsx') },
    { at: 30_000, events: (b) => [at('demo-sw-a1', b, { type: 'agent.finished', agentId: 'demo-a1-review' })] },
    // MCP switchboard: FairMind Brain_record_decision (write), by a sub-agent — the Review-phase run agent reporting home.
    { at: 32_000, events: (b) => [at('demo-ps-d4', b, mcpStart('wf3-mcp1', 'mcp__Fairmind__Brain_record_decision', checkout.agent(3)))] },
    { at: 32_500, events: (b) => [at('demo-ps-d4', b, { type: 'tool.finished', toolId: 'wf3-mcp1', ok: true, agentId: checkout.agent(3) })] },
    // MCP switchboard (Phase 3): FairMind Code_search_symbol (read), by the same Review-phase run agent the Brain
    // write above just landed on (checkout.agent(3), still running until 40s) — the Brain and Code VIP forms
    // visible, in turn, on the same room agent's headset.
    { at: 33_000, events: (b) => [at('demo-ps-d4', b, mcpStart('wf3b-mcp1', 'mcp__Fairmind__Code_search_symbol', checkout.agent(3)))] },
    { at: 33_500, events: (b) => [at('demo-ps-d4', b, { type: 'tool.finished', toolId: 'wf3b-mcp1', ok: true, agentId: checkout.agent(3) })] },
    { at: 34_000, events: (b) => [at('demo-sw-a1', b, { type: 'waiting', reason: { kind: 'question', text: 'Keep the old address form behind a flag?' }, agentId: null })] },
    { at: 36_000, events: (b) => [at(states.id, b, { type: 'prompt', text: loop === 0 ? 'Which states can a refund be in?' : null })] },
    // The ninth session on the floor: one more than a block has desks.
    { at: 37_000, events: (b) => arrive(retry, b, 'Bash', 'Bash: npm test -- retry') },
    { at: 40_000, events: (b) => [at('demo-ps-d4', b, runAgent(4, 'Ship', 'Run the checkout suite on staging', checkout, 'fairmind-coding:QA Engineer')), at('demo-ps-d4', b, finish(3))] },
    { at: 42_000, events: (b) => [at('demo-oa-g7', b, { type: 'prompt', text: loop === 0 ? 'Use Postgres.' : null })] },
    { at: 43_000, events: (b) => [end(gift, b)] },
    {
      at: 44_000,
      events: (b) => [
        at('demo-oa-c3', b, { type: 'workflow.started', runId: replay.runId, name: DEMO_REPLAY.name, summary: DEMO_REPLAY.summary, phases: [...DEMO_REPLAY.phases] }),
        at('demo-oa-c3', b, runAgent(0, 'Sample', 'Pick a day of orders to replay', replay)),
      ],
    },
    // The smoke test started at 28s finishes: the cigar clears.
    { at: 45_000, events: (b) => [at('demo-ss-e5', b, { type: 'tool.finished', toolId: 'e5-t1', ok: true, agentId: null })] },
    { at: 46_000, events: (b) => [end(states, b)] },
    // MCP switchboard: a Notion search (read), on the dependency desk's own session — safely after its own
    // `waiting` cleared by the prompt at 42s (not before: g7 is needs_you for nearly the whole loop until then).
    { at: 47_000, events: (b) => [at('demo-oa-g7', b, mcpStart('g7-mcp1', 'mcp__Notion__search', null))] },
    { at: 47_500, events: (b) => [at('demo-oa-g7', b, { type: 'tool.finished', toolId: 'g7-mcp1', ok: true, agentId: null })] },
    {
      at: 48_000,
      events: (b) => [
        at('demo-oa-c3', b, runAgent(1, 'Replay', 'Replay the morning orders', replay)),
        at('demo-oa-c3', b, runAgent(2, 'Replay', 'Replay the evening orders', replay)),
        at('demo-oa-c3', b, finish(0, replay)),
      ],
    },
    // MCP switchboard (Phase 3): FairMind bulk_update_status (write, no family at all), by the checkout-verify
    // run's own Ship-phase QA Engineer (checkout.agent(4), running 40-52s) — the "sensible default form" a
    // family:null FairMind call still gets, on a sub-agent again, never the session itself.
    { at: 48_500, events: (b) => [at('demo-ps-d4', b, mcpStart('wf4-mcp1', 'mcp__Fairmind__bulk_update_status', checkout.agent(4)))] },
    { at: 48_700, events: (b) => [at('demo-ps-d4', b, { type: 'tool.finished', toolId: 'wf4-mcp1', ok: true, agentId: checkout.agent(4) })] },
    // MCP switchboard ("parallel MCP calls" follow-up, from a real report: one Claude Code turn calling six MCP
    // servers at once used to light at most one antenna, since a session's call/callAt held only its single
    // most-recent): the dependency desk's own session (demo-oa-g7, the same safe window as the Notion search
    // above) places all six in one beat, none finishing before the others for 1.7s — long enough to clear the
    // SSE broadcaster's own 250ms change-coalescing window (src/server/events.ts) with room to spare, so a client
    // watching live actually renders the "all six open" frame rather than one coalesced past it — the floor's
    // headset shows the latest with a "×6". The rooftop lights six distinct antennas from this one desk at once
    // (servers whose names hash into the same slot probe to the next free one, build.ts's activeLinesOf), raw
    // server spellings (claude_ai_/plugin_<x>_ prefixes, underscores) and all, so the
    // friendly-name follow-up renders end to end.
    {
      at: 49_000,
      events: (b) => [
        at('demo-oa-g7', b, mcpStart('g7-par1', 'mcp__clickup__clickup_get_workspace_members', null)),
        at('demo-oa-g7', b, mcpStart('g7-par2', 'mcp__claude_ai_Notion__notion-get-self', null)),
        at('demo-oa-g7', b, mcpStart('g7-par3', 'mcp__claude_ai_Google_Calendar__list_calendars', null)),
        at('demo-oa-g7', b, mcpStart('g7-par4', 'mcp__claude_ai_Gmail__list_messages', null)),
        at('demo-oa-g7', b, mcpStart('g7-par5', 'mcp__claude_ai_Google_Drive__search_files', null)),
        at('demo-oa-g7', b, mcpStart('g7-par6', 'mcp__plugin_slack_slack__slack_search_channels', null)),
      ],
    },
    {
      at: 50_000,
      events: (b) => [
        at('demo-oa-c3', b, { type: 'answer', text: 'POST /orders now takes an Idempotency-Key header and replays the first response. I started orders-replay to try it on a day of orders.' }),
        at('demo-oa-c3', b, { type: 'turn.finished', backgroundTasks: 0 }),
      ],
    },
    {
      at: 50_700,
      events: (b) => (['g7-par1', 'g7-par2', 'g7-par3', 'g7-par4', 'g7-par5', 'g7-par6'] as const).map((toolId) =>
        at('demo-oa-g7', b, { type: 'tool.finished', toolId, ok: true, agentId: null })),
    },
    // MCP switchboard: FairMind Studio_get_task (read), by the dependency desk's own session — the teal earpiece,
    // not a sub-agent's. Same safe window as the Notion search above (g7 is working from 42s to the loop's end).
    { at: 51_000, events: (b) => [at('demo-oa-g7', b, mcpStart('g7-mcp2', 'mcp__Fairmind__Studio_get_task', null))] },
    { at: 51_500, events: (b) => [at('demo-oa-g7', b, { type: 'tool.finished', toolId: 'g7-mcp2', ok: true, agentId: null })] },
    { at: 52_000, events: (b) => [at('demo-ps-d4', b, finish(4)), at('demo-ps-d4', b, { type: 'workflow.finished', runId, status: 'completed' })] },
    // MCP switchboard (Phase 3): FairMind Insights_record_loop_stats (write, always-outgoing), on the
    // dependency-investigate desk's own session — the same safe window as the Notion/Studio calls above
    // (g7 is working from 42s to the loop's end), reporting the loop's own stats home as it winds down.
    { at: 53_000, events: (b) => [at('demo-oa-g7', b, mcpStart('g7-mcp3', 'mcp__Fairmind__Insights_record_loop_stats', null))] },
    { at: 53_500, events: (b) => [at('demo-oa-g7', b, { type: 'tool.finished', toolId: 'g7-mcp3', ok: true, agentId: null })] },
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
