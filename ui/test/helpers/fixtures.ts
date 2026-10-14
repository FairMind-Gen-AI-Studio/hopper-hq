/**
 * A small building shaped like the demo's, for UI tests: four floors, put together the way src/scene/build.ts does
 * (the plan from src/scene/layout.ts, colour slots from src/scene/palette.ts). Each checkout sits in pods of its own
 * (helpers/plan.ts). Each call returns fresh objects, so a test may change what it gets.
 */
import { LOUNGE_SEATS, type PlanLayout } from '../../../src/scene/layout';
import { FEATURE_SLOTS, REPO_SLOTS, slotOf } from '../../../src/scene/palette';
import {
  SCENE_VERSION,
  type AttentionEntry,
  type Badge,
  type BuildingScene,
  type Checkout,
  type DeskActivity,
  type FloorDetail,
  type FloorSummary,
  type Occupant,
  type Pod,
  type Pose,
  type SceneReason,
  type ShownState,
} from '../../../src/scene/types';
import { podsFor } from './plan';

export const NOW = Date.UTC(2026, 9, 11, 9, 30, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const CHECKOUT = 'feature:checkout-v2';
export const SEARCH = 'feature:search-ranking';
export const ORDERS = 'repo:/Users/dev/code/orders-api';
export const DOCS = 'feature:docs-refresh';

interface DeskSpec {
  id: string;
  name: string;
  state: ShownState;
  since: number;
  title: string | null;
  pane: string | null;
  reason?: SceneReason;
  activity?: DeskActivity;
  agents?: number;
  location?: 'local' | 'cloud';
}
interface CheckoutSpec {
  repo: string;
  branch: string | null;
  worktree: boolean;
  path: string;
  desks: DeskSpec[];
}
interface FloorSpec {
  key: string;
  kind: 'feature' | 'department';
  name: string;
  openedAt: number;
  checkouts: CheckoutSpec[];
}

/** Top to bottom: newest first-seen first. */
const FLOORS: FloorSpec[] = [
  {
    key: CHECKOUT,
    kind: 'feature',
    name: 'checkout-v2',
    openedAt: NOW - HOUR,
    checkouts: [
      {
        repo: 'orders-api',
        branch: 'feat/checkout-v2',
        worktree: true,
        path: '/Users/dev/code/orders-api/.worktrees/checkout-v2',
        desks: [
          {
            id: 'oa-c3',
            name: 'orders-api-c3',
            state: 'needs_you',
            since: NOW - 12 * MIN,
            title: 'Add idempotency keys to POST /orders',
            pane: '%7',
            reason: { kind: 'permission', text: 'Bash', detail: 'rm -rf dist && npm run build', agent: null },
            activity: { label: 'Edit src/routes/orders.ts', since: NOW - 12 * MIN, running: false },
          },
        ],
      },
      {
        repo: 'payments-svc',
        branch: 'feat/checkout-v2',
        worktree: false,
        path: '/Users/dev/code/payments-svc',
        desks: [
          {
            id: 'ps-d4',
            name: 'payments-svc-d4',
            state: 'in_meeting',
            since: NOW - 9 * MIN,
            title: 'Support split payments across two cards',
            pane: '%9',
            agents: 3,
            activity: { label: 'Workflow checkout-verify', since: NOW - 9 * MIN, running: false },
          },
        ],
      },
      {
        repo: 'storefront-web',
        branch: 'feat/checkout-v2',
        worktree: false,
        path: '/Users/dev/code/storefront-web',
        desks: [
          {
            id: 'sw-a1',
            name: 'storefront-web-a1',
            state: 'working',
            since: NOW - 40_000,
            title: 'Build the address step of the new checkout',
            pane: '%4',
            agents: 2,
            activity: { label: 'Edit src/checkout/AddressStep.tsx', since: NOW - 40_000, running: false },
          },
          {
            id: 'sw-b2',
            name: 'storefront-web-b2',
            state: 'done',
            since: NOW - 18 * MIN,
            title: 'Rewrite checkout copy and empty states',
            pane: '%5',
            activity: { label: 'Edit src/copy/checkout.json', since: NOW - 18 * MIN, running: false },
          },
        ],
      },
    ],
  },
  {
    key: SEARCH,
    kind: 'feature',
    name: 'search-ranking',
    openedAt: NOW - 3 * HOUR,
    checkouts: [
      {
        repo: 'search-svc',
        branch: 'feat/search-ranking',
        worktree: false,
        path: '/Users/dev/code/search-svc',
        desks: [
          {
            id: 'ss-e5',
            name: 'search-svc-e5',
            state: 'no_signal',
            since: NOW - 14 * MIN,
            title: 'Tune BM25 weights with last month of click data',
            pane: '%11',
            activity: { label: 'Bash: npm test', since: NOW - 14 * MIN, running: true },
          },
        ],
      },
      {
        repo: 'storefront-web',
        branch: 'feat/search-ranking',
        worktree: true,
        path: '/Users/dev/code/storefront-web/.worktrees/search-ranking',
        desks: [
          {
            id: 'sw-f6',
            name: 'storefront-web-f6',
            state: 'working',
            since: NOW - 5000,
            title: 'Explain why a result ranks where it does',
            pane: '%12',
            activity: { label: 'Read src/search/ResultCard.tsx', since: NOW - 5000, running: false },
          },
        ],
      },
    ],
  },
  {
    key: ORDERS,
    kind: 'department',
    name: 'orders-api',
    openedAt: NOW - 2 * DAY,
    checkouts: [
      {
        repo: 'orders-api',
        branch: 'main',
        worktree: false,
        path: '/Users/dev/code/orders-api',
        desks: [
          {
            id: 'oa-g7',
            name: 'orders-api-g7',
            state: 'needs_you',
            since: NOW - 4 * MIN,
            title: 'Investigate duplicate order confirmation emails',
            pane: '%2',
            reason: { kind: 'question', text: 'Should the retry queue use Redis or Postgres?', detail: null, agent: { id: 'agent-1', type: 'Explore' } },
            agents: 1,
          },
          { id: 'oa-h8', name: 'orders-api-h8', state: 'working', since: NOW - 12_000, title: 'Bump dependencies and fix the type errors', pane: '%3' },
          { id: 'oa-i9', name: 'orders-api-i9', state: 'done', since: NOW - 65 * MIN, title: 'Explain the order state machine', pane: '%6' },
          { id: 'oa-j0', name: 'orders-api-j0', state: 'idle', since: NOW - 3 * HOUR, title: 'Review the comments on PR #412', pane: '%8' },
          { id: 'oa-k1', name: 'orders-api-k1', state: 'working', since: NOW - 2 * MIN, title: 'Draft a migration plan for the orders table', pane: null, location: 'cloud' },
        ],
      },
    ],
  },
  {
    key: DOCS,
    kind: 'feature',
    name: 'docs-refresh',
    openedAt: NOW - 9 * DAY,
    checkouts: [
      {
        repo: 'docs-site',
        branch: 'feat/docs-refresh',
        worktree: false,
        path: '/Users/dev/code/docs-site',
        desks: [{ id: 'ds-m3', name: 'docs-site-m3', state: 'dormant', since: NOW - 5 * DAY, title: 'Restructure the API reference navigation', pane: '%14' }],
      },
      {
        repo: 'storefront-web',
        branch: 'feat/docs-refresh',
        worktree: true,
        path: '/Users/dev/code/storefront-web/.worktrees/docs-refresh',
        desks: [{ id: 'sw-n4', name: 'storefront-web-n4', state: 'dormant', since: NOW - 6 * DAY, title: 'Link product pages to the new docs', pane: '%15' }],
      },
    ],
  },
];

const ROBOT: Record<ShownState, { pose: Pose; badge: Badge | null } | null> = {
  working: { pose: 'typing', badge: 'typing' },
  needs_you: { pose: 'waving', badge: 'needs' },
  done: { pose: 'holding', badge: 'done' },
  in_meeting: { pose: 'still', badge: 'meeting' },
  no_signal: { pose: 'still', badge: 'clock' },
  idle: { pose: 'resting', badge: null },
  dormant: null,
};
const STATE_ORDER = Object.keys(ROBOT) as ShownState[];

const focusable = (d: DeskSpec) => (d.location ?? 'local') === 'local' && d.pane !== null && /^%\d+$/.test(d.pane);

function checkoutOf(c: CheckoutSpec): Checkout {
  return { repo: c.repo, branch: c.branch, worktree: c.worktree, path: c.path };
}

function occupantOf(f: FloorSpec, c: CheckoutSpec, d: DeskSpec): Occupant {
  const look = ROBOT[d.state];
  return {
    sessionId: d.id,
    name: d.name,
    title: d.title,
    state: d.state,
    since: d.since,
    reason: d.reason ?? null,
    activity: d.activity ?? null,
    agentsRunning: d.agents ?? 0,
    summary: null,
    interns: [],
    internsMore: 0,
    runs: [],
    location: d.location ?? 'local',
    pane: d.pane,
    focusable: focusable(d),
    robot: look && {
      pose: look.pose,
      badge: look.badge,
      body: slotOf(c.repo, REPO_SLOTS),
      tie: f.kind === 'feature' ? slotOf(f.key.slice('feature:'.length), FEATURE_SLOTS) : null,
    },
    at: d.state === 'dormant' ? { kind: 'gone' } : { kind: 'desk' },
    checkout: checkoutOf(c),
  };
}

/** The floor's plan, each checkout in pods of its own. */
function podsOf(f: FloorSpec): { plan: PlanLayout; pods: Pod[] } {
  return podsFor(f.checkouts.map((c) => ({ color: slotOf(c.repo, REPO_SLOTS), placard: checkoutOf(c), occupants: c.desks.map((d) => occupantOf(f, c, d)) })));
}

function summary(f: FloorSpec, number: number): FloorSummary {
  const desks = f.checkouts.flatMap((c) => c.desks);
  const counts: FloorSummary['counts'] = {};
  for (const state of STATE_ORDER) {
    const n = desks.filter((d) => d.state === state).length;
    if (n > 0) counts[state] = n;
  }
  return {
    key: f.key,
    number,
    kind: f.kind,
    name: f.name,
    repos: [...new Set(f.checkouts.map((c) => c.repo))].sort(),
    windows: podsOf(f).pods.flatMap((p) => p.desks.map((d) => (d.occupant ? { sessionId: d.occupant.sessionId, state: d.occupant.state } : { sessionId: null, state: null }))),
    counts,
    shutters: desks.every((d) => d.state === 'dormant'),
    openedAt: f.openedAt,
  };
}

function entry(f: FloorSpec, c: CheckoutSpec, d: DeskSpec, state: 'needs_you' | 'done'): AttentionEntry {
  return { sessionId: d.id, floorKey: f.key, name: d.name, repo: c.repo, state, since: d.since, reason: d.reason ?? null, title: d.title, focusable: focusable(d), summary: null };
}

export function makeScene(): BuildingScene {
  const all = FLOORS.flatMap((f) => f.checkouts.flatMap((c) => c.desks.map((d) => ({ f, c, d }))));
  const queue = (state: 'needs_you' | 'done') =>
    all
      .filter((x) => x.d.state === state)
      .sort((a, b) => a.d.since - b.d.since)
      .map((x) => entry(x.f, x.c, x.d, state));
  return {
    version: SCENE_VERSION,
    floors: FLOORS.map((f, i) => summary(f, FLOORS.length - i)),
    attention: { needsYou: queue('needs_you'), done: queue('done') },
  };
}

export function makeFloor(key: string): FloorDetail | null {
  const index = FLOORS.findIndex((f) => f.key === key);
  const f = FLOORS[index];
  if (!f) return null;
  const { plan, pods } = podsOf(f);
  const { windows: _windows, ...rest } = summary(f, FLOORS.length - index);
  return {
    version: SCENE_VERSION,
    ...rest,
    size: plan.size,
    core: plan.core,
    rooms: [],
    roomsMore: 0,
    pods,
    lounge: { rect: plan.lounge, seats: LOUNGE_SEATS },
    roomSlots: plan.rooms,
    unseated: [],
    unseatedMore: 0,
  };
}
