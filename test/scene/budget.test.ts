import { describe, expect, it } from 'vitest';
import { newSession } from '../../src/core/reducer.js';
import type { ChildAgent, RunAgent, SessionState, WorkflowRun } from '../../src/core/types.js';
import { toView, type SessionView } from '../../src/core/view.js';
import { buildFloorDetail } from '../../src/scene/build.js';
import { BLOCKS_MAX, BLOCK_DESKS, INTERNS_MAX, LOUNGE_SEATS, MEETING_AGENTS_MAX, ROOMS_MAX, RUNS_SHOWN, SEATS_MAX } from '../../src/scene/layout.js';

/**
 * What the fullest floor costs on the wire (design §7.1): its JSON as measured, 79,895 bytes of UTF-8, with a tenth to
 * spare, rounded down.
 */
const JSON_BUDGET = 87_884;

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NOW = 30 * DAY;
const REPOS = ['storefront-web', 'orders-api', 'payments-svc', 'search-svc'];
/** Finished interns beyond the running ones, and finished agents beyond the running ones of a room's run. */
const INTERNS_DONE = 2;
const AGENTS_DONE = MEETING_AGENTS_MAX - SEATS_MAX;

const sessionId = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;

const intern = (n: number, k: number, running: boolean): ChildAgent => ({
  id: `a${String(n).padStart(4, '0')}${k}000000000000`,
  type: 'Explore',
  description: `Look through the checkout code for case ${k}`,
  running,
  lastAction: 'Read src/checkout/cart.ts',
  updatedAt: NOW - (k + 1) * MIN,
});

const agent = (run: string, k: number, running: boolean): RunAgent => ({
  id: `${run}-agent-${k}`,
  label: `Verify the split payment path ${k}`,
  phase: running ? 'Build' : 'Plan',
  type: 'workflow-subagent',
  running,
  startedAt: NOW - 20 * MIN + k,
  updatedAt: NOW - MIN,
});

/** A run of the checkout script: a live one with SEATS_MAX agents running and the rest of a room's agents finished, or one that completed. */
function run(id: string, startedAt: number, live: boolean): WorkflowRun {
  return {
    id,
    name: 'checkout-verify',
    summary: 'Verify split payments end to end, from the cart to the receipt',
    phases: ['Plan', 'Build', 'Review', 'Ship'],
    currentPhase: 'Build',
    status: live ? 'running' : 'completed',
    onDisk: true,
    startedAt,
    endedAt: live ? null : startedAt + 10 * MIN,
    agents: live ? [...Array.from({ length: SEATS_MAX }, (_, k) => agent(id, k, true)), ...Array.from({ length: AGENTS_DONE }, (_, k) => agent(id, SEATS_MAX + k, false))] : [],
    agentsFinished: live ? AGENTS_DONE : 6,
  };
}

/**
 * The sessions of the fullest floor, one feature's: one for every desk of BLOCKS_MAX blocks, in four repositories' worktrees.
 * The first ROOMS_MAX are in meetings, each hosting a live run; the next LOUNGE_SEATS are idle; the others work, need
 * you or are done. Each has a title, a status line, a last action, INTERNS_MAX interns running and more finished, and
 * RUNS_SHOWN runs.
 */
function fullestViews(): SessionView[] {
  return Array.from({ length: BLOCKS_MAX * BLOCK_DESKS }, (_, n) => {
    const repo = REPOS[n % REPOS.length]!;
    const root = `/home/dev/src/${repo}`;
    const tree = `${root}/.worktrees/checkout-v2`;
    const host = n < ROOMS_MAX;
    const state: SessionState = host ? 'in_meeting' : n < ROOMS_MAX + LOUNGE_SEATS ? 'idle' : (['working', 'needs_you', 'done', 'working'] as const)[n % 4]!;
    return toView(
      {
        ...newSession(sessionId(n), NOW - DAY + n, { cwd: tree, repoRoot: root, repoName: repo, worktree: true, branch: 'feat/checkout-v2', root: tree }),
        tmuxPane: `%${n + 1}`,
        state,
        stateSince: NOW - 5 * MIN,
        lastEventAt: NOW - MIN,
        title: `Split the checkout payment step for order batch ${n}`,
        lastAction: 'Edit src/checkout/payment-step.ts',
        lastActionAt: NOW - MIN,
        openTool: state === 'working' ? { id: 'toolu_01', label: 'Bash: npm test -- checkout', startedAt: NOW - MIN } : null,
        waitReason: state === 'needs_you' ? { kind: 'permission', text: 'Bash', detail: 'Bash: rm -rf dist && npm run build' } : null,
        summary: {
          text: 'Moved the payment step behind the new split API; the cart tests pass, the receipt tests still fail on rounding',
          at: NOW - 2 * MIN,
          inputHash: '0123456789abcdef',
        },
        children: [...Array.from({ length: INTERNS_MAX }, (_, k) => intern(n, k, true)), ...Array.from({ length: INTERNS_DONE }, (_, k) => intern(n, INTERNS_MAX + k, false))],
        runs: Array.from({ length: RUNS_SHOWN }, (_, k) => run(`wf_0000aaaa-${String(n).padStart(3, '0')}${k}`, NOW - (k + 2) * 30 * MIN, host && k === 0)),
      },
      NOW,
    );
  });
}

describe('the fullest floor on the wire', () => {
  const floor = buildFloorDetail(fullestViews(), 'feature:checkout-v2')!;

  it('seats a session at every desk of every block, fills the lounge and opens every room, with every list at its longest', () => {
    const occupants = floor.pods.flatMap((p) => p.desks.map((d) => d.occupant));
    expect([floor.pods.length, occupants.length, occupants.every((o) => o !== null), floor.unseated.length]).toEqual([2 * BLOCKS_MAX, BLOCKS_MAX * BLOCK_DESKS, true, 0]);
    const seated = occupants.filter((o) => o !== null);
    expect(seated.filter((o) => o.at.kind === 'lounge')).toHaveLength(LOUNGE_SEATS);
    expect(seated.filter((o) => o.at.kind === 'room')).toHaveLength(ROOMS_MAX);
    expect(floor.rooms.map((r) => [r.slot, r.counts.running, r.agents.length])).toEqual(Array.from({ length: ROOMS_MAX }, (_, slot) => [slot, SEATS_MAX, MEETING_AGENTS_MAX]));
    expect(seated.every((o) => o.interns.length === INTERNS_MAX && o.internsMore === INTERNS_DONE && o.runs.length === RUNS_SHOWN && o.summary !== null)).toBe(true);
  });

  it('sends it in at most JSON_BUDGET bytes of UTF-8', () => {
    expect(new TextEncoder().encode(JSON.stringify(floor)).length).toBeLessThanOrEqual(JSON_BUDGET);
  });
});
