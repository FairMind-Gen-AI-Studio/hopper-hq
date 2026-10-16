import type { DistributiveOmit, RawEvent, Workspace } from '../core/types.js';
import type { DemoStep } from './demo.js';

interface ShowcaseSession {
  id: string;
  name: string;
  pane: string;
  workspace: Workspace;
  title: string;
  prompt: string;
  summary: string;
}

const ws = (cwd: string, branch: string, repoRoot = cwd): Workspace => ({
  cwd,
  repoRoot,
  repoName: repoRoot.split('/').pop() ?? repoRoot,
  worktree: cwd !== repoRoot,
  branch,
});

const BRANCH = 'feat/checkout-v2';
const WEB = ws('/demo/storefront-web', BRANCH);
const API = ws('/demo/orders-api', BRANCH);
const PAY = ws('/demo/payments-svc', BRANCH);

const session = (id: string, name: string, pane: number, workspace: Workspace, title: string, summary: string): ShowcaseSession => ({ id, name, pane: `%${pane}`, workspace, title, prompt: title, summary });

/** The twelve sessions of the showcase, all on one feature floor, in the order they are listed in the script's comments. */
export const SHOWCASE_SESSIONS = {
  web1: session('sc-web-1', 'storefront-web-1', 21, WEB, 'Ship the new checkout', 'Ships the new checkout; release-check verifies it in a meeting room'),
  web2: session('sc-web-2', 'storefront-web-2', 22, WEB, 'Find every caller of useCart()', 'Maps the callers of useCart() with two helpers'),
  web3: session('sc-web-3', 'storefront-web-3', 23, WEB, 'Polish the empty states', 'Polishes the empty states, then sweeps the pages for accessibility'),
  web4: session('sc-web-4', 'storefront-web-4', 24, WEB, 'Add a gift message to the cart', 'Adds a gift message to the cart'),
  api1: session('sc-api-1', 'orders-api-1', 25, API, 'Move orders to the new schema', 'Moves orders to the new schema; migration-replay replays a day of them'),
  api2: session('sc-api-2', 'orders-api-2', 26, API, 'Add idempotency keys to the orders endpoint', 'Idempotency keys are in; asks before it rebuilds dist'),
  api3: session('sc-api-3', 'orders-api-3', 27, API, 'Which states can an order be in?', 'Walks through the states an order can be in'),
  pay1: session('sc-pay-1', 'payments-svc-1', 28, PAY, 'Split a payment across two cards', 'Supports split payments; two helpers read the ledger and the refund path'),
  pay2: session('sc-pay-2', 'payments-svc-2', 29, PAY, 'Log every leg of a split payment', 'Logs one line per leg of a split payment'),
  pay3: session('sc-pay-3', 'payments-svc-3', 30, PAY, 'Retry a declined card a second time', 'Retries a declined card once before it asks for another'),
  pay4: session('sc-pay-4', 'payments-svc-4', 31, PAY, 'Show the delivery date at checkout', 'Shows the delivery estimate on the review step'),
  pay5: session('sc-pay-5', 'payments-svc-5', 32, PAY, 'Rotate the signing keys', 'Rotates the signing keys of the payments webhooks'),
};

/** How long the showcase waits before its first desk fills, so that the floor can be opened first. */
export const SHOWCASE_LEAD_MS = 20_000;

type Body = DistributiveOmit<RawEvent, 'sessionId' | 'ts' | 'source'>;
const at = (sessionId: string, ts: number, body: Body): RawEvent => ({ ...body, sessionId, ts, source: 'demo' }) as RawEvent;

const RELEASE = { runId: 'wf_showcase-release', name: 'release-check', summary: 'Verify the new checkout end to end', phases: ['Plan', 'Build', 'Review', 'Ship'] };
const MIGRATION = { runId: 'wf_showcase-migration', name: 'migration-replay', summary: 'Replay a day of orders on the new schema', phases: ['Sample', 'Replay', 'Compare'] };
const SWEEP = { runId: 'wf_showcase-a11y', name: 'a11y-sweep', summary: 'Check every page against the accessibility checklist', phases: ['Crawl', 'Audit', 'Report'] };

/**
 * One run of about ninety seconds, after SHOWCASE_LEAD_MS: four sessions at their desks, the others walking in from the
 * elevator until the floor grows a second block. Three workflow runs take their hosts into the meeting rooms, with their
 * agents at the table and a laptop before each; two sessions and their subagents meet in a room of their own; one
 * session waits for permission, one finishes a turn, two are cleared and rest in the lounge, and two leave at the end.
 * It does not repeat: restart the demo to see it again.
 *
 * Two beats double as the whimsical features' demo (the daemon forces the leisure window open with `DEMO_LEISURE_HOUR`
 * for the whole `--showcase` run, same as the plain demo): web2's two helpers hold a lone gin tonic between sec 34 and
 * 42 (one stops while the other keeps running), and web1's release-check run holds biliardino pairs from sec 39 on
 * (two or more of its agents finish together while a later phase's agents keep running) — no separate cohort was added
 * for this; it falls out of the existing helpers and run. The pay3 session's `Bash: npm run test:smoke -- retry` from
 * sec 18 to 45 holds a cigar (Feature B).
 *
 * release-check and a11y-sweep type their agents to plugin roles (hq-agent-personas TP3), so a single frame between
 * sec 15 and sec 39 shows release-check's tech lead (idle, Plan already done), developer and security engineer
 * (Build, running) next to web2's own explorer and generalist helpers: five distinct personas at once, six once
 * a11y-sweep's designer (Frontend Engineer) joins from sec 40. release-check's later Review/Ship agents add the
 * reviewer, the librarian (Technical Writer) and QA. migration-replay keeps the plain `workflow-subagent` type, so
 * it shows no persona, for contrast. Every typed agent carries the `fairmind-coding:` namespace, so each also wears
 * the Fairmind badge — exercising the classifier's prefix handling end to end.
 */
export function showcaseScript(): DemoStep[] {
  const s = SHOWCASE_SESSIONS;
  const step = (sec: number, events: (b: number) => RawEvent[]): DemoStep => ({ at: SHOWCASE_LEAD_MS + sec * 1000, events });
  const arrive = (who: ShowcaseSession, sec: number, tool: string, label: string, smoke = false): DemoStep =>
    step(sec, (b) => [
      at(who.id, b, { type: 'session.seen', workspace: who.workspace, pid: null, name: who.name, tmuxPane: who.pane, startedAt: b }),
      at(who.id, b, { type: 'title', title: who.title }),
      at(who.id, b, { type: 'prompt', text: who.prompt }),
      at(who.id, b, { type: 'tool.started', toolId: `${who.id}-t1`, tool, label, agentId: null, ...(smoke ? { smoke: true } : {}) }),
    ]);
  const agent = (_host: ShowcaseSession, run: { runId: string }, n: string, phase: string, description: string, agentType = 'workflow-subagent'): Body => ({ type: 'agent.started', agentId: `${run.runId}-${n}`, agentType, description, runId: run.runId, phase });
  const done = (run: { runId: string }, n: string): Body => ({ type: 'agent.finished', agentId: `${run.runId}-${n}` });
  const helper = (id: string, type: string, description: string): Body => ({ type: 'agent.started', agentId: id, agentType: type, description });
  const start = (run: typeof RELEASE): Body => ({ type: 'workflow.started', runId: run.runId, name: run.name, summary: run.summary, phases: [...run.phases] });
  const finishRun = (run: { runId: string }): Body => ({ type: 'workflow.finished', runId: run.runId, status: 'completed' });
  const stop = (id: string): Body => ({ type: 'agent.finished', agentId: id });
  const end = (): Body => ({ type: 'session.ended', reason: 'prompt_input_exit' });

  return [
    {
      at: 0,
      events: (b) =>
        [s.pay1, s.api1, s.web2, s.web1].flatMap((who, i) => {
          const startedAt = b - (i + 1) * 600_000;
          return [
            at(who.id, startedAt, { type: 'session.seen', workspace: who.workspace, pid: null, name: who.name, tmuxPane: who.pane, startedAt }),
            at(who.id, b + i, { type: 'title', title: who.title }),
            at(who.id, b + i, { type: 'prompt', text: who.prompt }),
            at(who.id, b + i, { type: 'tool.started', toolId: `${who.id}-t0`, tool: 'Edit', label: 'Edit src/checkout/index.ts', agentId: null }),
          ];
        }),
    },
    arrive(s.api2, 1, 'Bash', 'Bash: npm run build'),
    arrive(s.pay2, 4, 'Edit', 'Edit src/ledger/split.ts'),
    // release-check: web1 hands the checkout to a workflow and goes into the meeting room with its agents.
    step(7, (b) => [at(s.web1.id, b, start(RELEASE)), at(s.web1.id, b, agent(s.web1, RELEASE, '0', 'Plan', 'Map the checkout flow', 'fairmind-coding:Technical Lead / Architect'))]),
    arrive(s.web3, 9, 'Edit', 'Edit src/components/EmptyState.tsx'),
    // Two helpers: web2 and its subagents meet in a room of their own.
    step(11, (b) => [at(s.web2.id, b, helper('sc-web2-a', 'Explore', 'Find every caller of useCart()')), at(s.web2.id, b, helper('sc-web2-b', 'general-purpose', 'Check each caller against the new cart type'))]),
    arrive(s.api3, 13, 'Read', 'Read src/orders/states.ts'),
    step(15, (b) => [
      at(s.web1.id, b, agent(s.web1, RELEASE, '1', 'Build', 'Build the address step', 'fairmind-coding:Software Engineer')),
      at(s.web1.id, b, agent(s.web1, RELEASE, '2', 'Build', 'Build the payment step', 'fairmind-coding:Security Engineer')),
      at(s.web1.id, b, agent(s.web1, RELEASE, '3', 'Build', 'Build the review step', 'fairmind-coding:QA Engineer')),
      at(s.web1.id, b, done(RELEASE, '0')),
    ]),
    // orders-api-2 stops to ask before it rebuilds dist.
    step(16, (b) => [at(s.api2.id, b, { type: 'waiting', reason: { kind: 'permission', text: 'Bash', detail: 'Bash: rm -rf dist && npm run build' }, agentId: null })]),
    // A smoke test: the mega sigaro (Feature B) shows on this desk from here until it clears at sec 45.
    arrive(s.pay3, 18, 'Bash', 'Bash: npm run test:smoke -- retry', true),
    step(20, (b) => [at(s.api1.id, b, start(MIGRATION)), at(s.api1.id, b, agent(s.api1, MIGRATION, '0', 'Sample', 'Pick a day of orders to replay'))]),
    // The ninth session: a second block of desks opens.
    arrive(s.web4, 22, 'Edit', 'Edit src/cart/GiftNote.tsx'),
    arrive(s.pay4, 24, 'Edit', 'Edit src/checkout/ReviewStep.tsx'),
    step(25, (b) => [
      at(s.web3.id, b, { type: 'answer', text: 'The empty states are polished. I will sweep the pages for accessibility next.' }),
      at(s.web3.id, b, { type: 'turn.finished', backgroundTasks: 0 }),
    ]),
    step(27, (b) => [
      at(s.api1.id, b, agent(s.api1, MIGRATION, '1', 'Replay', 'Replay the morning orders')),
      at(s.api1.id, b, agent(s.api1, MIGRATION, '2', 'Replay', 'Replay the evening orders')),
      at(s.api1.id, b, agent(s.api1, MIGRATION, '3', 'Replay', 'Replay the refunds')),
      at(s.api1.id, b, done(MIGRATION, '0')),
    ]),
    arrive(s.pay5, 28, 'Bash', 'Bash: openssl genpkey -algorithm ed25519'),
    // Stopped and cleared, as by Esc and /clear: it rests in the lounge until its next prompt.
    step(30, (b) => [at(s.api3.id, b, { type: 'session.started' })]),
    step(31, (b) => [at(s.pay1.id, b, helper('sc-pay1-a', 'Explore', 'Read the ledger entries of a split payment')), at(s.pay1.id, b, helper('sc-pay1-b', 'Explore', 'Read the refund path'))]),
    step(34, (b) => [at(s.web2.id, b, stop('sc-web2-a'))]),
    step(36, (b) => [at(s.api2.id, b, { type: 'prompt', text: 'Yes, rebuild it.' }), at(s.pay4.id, b, { type: 'session.started' })]),
    step(39, (b) => [
      at(s.web1.id, b, agent(s.web1, RELEASE, '4', 'Review', 'Review the three steps against the design', 'fairmind-coding:Code Reviewer')),
      at(s.web1.id, b, agent(s.web1, RELEASE, '5', 'Review', 'Review the copy and the empty states', 'fairmind-coding:Technical Writer')),
      at(s.web1.id, b, done(RELEASE, '1')),
      at(s.web1.id, b, done(RELEASE, '2')),
      at(s.web1.id, b, done(RELEASE, '3')),
    ]),
    step(42, (b) => [at(s.web2.id, b, stop('sc-web2-b'))]),
    step(44, (b) => [
      at(s.api1.id, b, agent(s.api1, MIGRATION, '4', 'Compare', 'Compare the replies with the first ones')),
      at(s.api1.id, b, done(MIGRATION, '1')),
      at(s.api1.id, b, done(MIGRATION, '2')),
      at(s.api1.id, b, done(MIGRATION, '3')),
    ]),
    // The smoke test started at sec 18 finishes: the cigar clears.
    step(45, (b) => [at(s.pay3.id, b, { type: 'tool.finished', toolId: `${s.pay3.id}-t1`, ok: true, agentId: null })]),
    step(47, (b) => [at(s.pay1.id, b, stop('sc-pay1-a')), at(s.pay1.id, b, helper('sc-pay1-c', 'general-purpose', 'Write the refund tests'))]),
    step(50, (b) => [at(s.web3.id, b, { type: 'prompt', text: 'Yes, sweep the pages.' })]),
    step(51, (b) => [at(s.web1.id, b, agent(s.web1, RELEASE, '6', 'Ship', 'Run the checkout suite on staging', 'fairmind-coding:QA Engineer')), at(s.web1.id, b, done(RELEASE, '4')), at(s.web1.id, b, done(RELEASE, '5'))]),
    step(54, (b) => [at(s.pay1.id, b, stop('sc-pay1-b')), at(s.api1.id, b, done(MIGRATION, '4')), at(s.api1.id, b, finishRun(MIGRATION))]),
    step(56, (b) => [at(s.web3.id, b, start(SWEEP)), at(s.web3.id, b, agent(s.web3, SWEEP, '0', 'Crawl', 'List every page of the storefront', 'fairmind-coding:Frontend Engineer'))]),
    step(58, (b) => [at(s.web1.id, b, done(RELEASE, '6')), at(s.web1.id, b, finishRun(RELEASE))]),
    step(60, (b) => [
      at(s.web3.id, b, agent(s.web3, SWEEP, '1', 'Audit', 'Audit the product pages', 'fairmind-coding:Frontend Engineer')),
      at(s.web3.id, b, agent(s.web3, SWEEP, '2', 'Audit', 'Audit the cart and checkout', 'fairmind-coding:Frontend Engineer')),
      at(s.web3.id, b, agent(s.web3, SWEEP, '3', 'Audit', 'Audit the account pages', 'fairmind-coding:Frontend Engineer')),
      at(s.web3.id, b, done(SWEEP, '0')),
    ]),
    step(62, (b) => [
      at(s.web1.id, b, { type: 'answer', text: 'The new checkout is verified end to end and ready for review.' }),
      at(s.web1.id, b, { type: 'turn.finished', backgroundTasks: 0 }),
      at(s.api1.id, b, { type: 'answer', text: 'The new schema holds a full day of replayed orders.' }),
      at(s.api1.id, b, { type: 'turn.finished', backgroundTasks: 0 }),
    ]),
    step(64, (b) => [at(s.pay1.id, b, stop('sc-pay1-c'))]),
    step(68, (b) => [at(s.pay2.id, b, end()), at(s.web4.id, b, end())]),
    step(72, (b) => [
      at(s.web3.id, b, agent(s.web3, SWEEP, '4', 'Report', 'Write up the findings', 'fairmind-coding:Frontend Engineer')),
      at(s.web3.id, b, done(SWEEP, '1')),
      at(s.web3.id, b, done(SWEEP, '2')),
      at(s.web3.id, b, done(SWEEP, '3')),
    ]),
    step(80, (b) => [at(s.web3.id, b, done(SWEEP, '4')), at(s.web3.id, b, finishRun(SWEEP))]),
  ];
}
