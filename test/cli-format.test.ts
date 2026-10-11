import { describe, expect, it } from 'vitest';
import { formatAgo, formatAttentionText, formatBuilding, formatTmux } from '../src/cli-format.js';
import type { AttentionSummary, Snapshot } from '../src/collector.js';
import { newSession } from '../src/core/reducer.js';
import { toView } from '../src/core/view.js';
import { WS } from './helpers/events.js';

const NOW = 10 * 60 * 60 * 1000;

describe('formatAgo', () => {
  it('uses the largest sensible unit', () => {
    expect([0, 59_000, 60_000, 3_600_000, 47 * 3_600_000, 48 * 3_600_000].map(formatAgo)).toEqual(['0s', '59s', '1m', '1h', '47h', '2d']);
  });
});

describe('formatTmux', () => {
  it('shows only non-zero counters', () => {
    expect(formatTmux({ needsYou: 2, done: 3 })).toBe('#[fg=colour203,bold]◉2#[default] #[fg=colour114]✓3#[default]');
    expect(formatTmux({ needsYou: 0, done: 1 })).toBe('#[fg=colour114]✓1#[default]');
    expect(formatTmux({ needsYou: 0, done: 0 })).toBe('');
  });
});

describe('formatAttentionText', () => {
  it('lists waiting sessions with reason, age and pane', () => {
    const a: AttentionSummary = {
      generatedAt: NOW, needsYou: 1, done: 1,
      items: [
        { id: 'S1', name: 'orders-api-c3', repo: 'orders-api', feature: 'checkout-v2', state: 'needs_you', since: NOW - 12 * 60_000, reason: { kind: 'permission', text: 'Bash', detail: 'Bash: rm -rf dist' }, title: null, tmuxPane: '%7' },
        { id: 'S2', name: 'storefront-web-b2', repo: 'storefront-web', feature: 'checkout-v2', state: 'done', since: NOW - 3 * 3_600_000, reason: null, title: 'Rewrite checkout copy', tmuxPane: null },
      ],
    };
    const lines = formatAttentionText(a, NOW).split('\n');
    expect(lines[0]).toMatch(/^◉ orders-api-c3\s+12m\s+Bash \(Bash: rm -rf dist\)\s+\[%7\]$/);
    expect(lines[1]).toMatch(/^✓ storefront-web-b2\s+3h\s+Rewrite checkout copy$/);
    expect(formatAttentionText({ generatedAt: NOW, needsYou: 0, done: 0, items: [] }, NOW)).toBe('Nobody is waiting for you.');
  });
});

describe('formatBuilding', () => {
  it('prints one block per floor', () => {
    const waiting = toView({ ...newSession('S1', NOW - 60_000, { ...WS, worktree: true }), state: 'needs_you', stateSince: NOW - 60_000, waitReason: { kind: 'question', text: 'Redis or Postgres?' }, tmuxPane: '%2' }, NOW);
    const working = toView({ ...newSession('S2', NOW - 120_000, { ...WS, repoName: 'storefront-web' }), state: 'working', stateSince: NOW - 5000, lastEventAt: NOW - 5000, title: 'Build the address step' }, NOW);
    const snap: Snapshot = {
      generatedAt: NOW,
      floors: [{ key: 'feature:checkout-v2', kind: 'feature', name: 'checkout-v2', repos: ['orders-api', 'storefront-web'], sessions: [waiting, working], counts: {}, openedAt: 0, dormant: false }],
      attention: { needsYou: [waiting], done: [] },
    };
    const lines = formatBuilding(snap).split('\n');
    expect(lines[0]).toBe('checkout-v2  (feature · orders-api, storefront-web)');
    expect(lines[1]).toMatch(/^ {2}◉ needs you\s+orders-api\*\s+1m\s+Redis or Postgres\?\s+\[%2\]$/);
    expect(lines[2]).toMatch(/^ {2}● working\s+storefront-web\s+5s\s+Build the address step$/);
    expect(formatBuilding({ generatedAt: NOW, floors: [], attention: { needsYou: [], done: [] } })).toBe('No sessions yet.');
  });
});
