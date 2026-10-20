import { AGENT_BADGES } from '../../lib/agent-badge';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DeskPanel from '../../components/DeskPanel.svelte';
import type { FloorDetail, Occupant } from '../../../src/scene/types';
import { occupantsOf } from '../../lib/occupants';
import { CHECKOUT, DOCS, NOW, ORDERS, SEARCH, makeFloor } from '../helpers/fixtures';
import { cleanup, click, render, text } from '../helpers/render';
import { RUN, checkoutWithRoom } from '../helpers/rooms';

afterEach(cleanup);

function find(floor: FloorDetail, id: string): Occupant {
  const desk = occupantsOf(floor).find((o) => o.sessionId === id);
  if (!desk) throw new Error(`no desk ${id}`);
  return desk;
}

function panel(key: string, id: string, now = NOW, change: (d: Occupant) => void = () => {}, floor: FloorDetail = makeFloor(key)!) {
  const desk = find(floor, id);
  change(desk);
  const onBack = vi.fn();
  const onGo = vi.fn();
  const onSeen = vi.fn();
  const onRun = vi.fn();
  const target = render(DeskPanel, { desk, floor, now, onBack, onGo, onSeen, onRun });
  const facts = () => Object.fromEntries([...target.querySelectorAll('dt')].map((dt) => [text(dt), text(dt.nextElementSibling)]));
  const button = (label: string) => [...target.querySelectorAll('.actions button')].find((b) => text(b).startsWith(label)) as HTMLButtonElement | undefined;
  /** A list section by its heading: one line per row, its parts joined with ' | '. */
  const rows = (heading: string) => {
    const section = [...target.querySelectorAll('section')].find((s) => text(s.querySelector('h3')) === heading);
    return [...(section?.querySelectorAll('li') ?? [])].map((li) => [...li.querySelectorAll('.l-name, .l-state, .l-sub')].map(text).join(' | ') || text(li));
  };
  return { target, onBack, onGo, onSeen, onRun, facts, button, rows };
}

const MIN = 60_000;

describe('DeskPanel', () => {
  it('identifies a Codex desk', () => {
    const { facts, target } = panel(CHECKOUT, 'oa-c3', NOW, d => { d.agentKind = 'codex'; });
    expect(facts().Agent).toBe('Codex');
    expect(target.querySelector('dd .agent-badge img')?.getAttribute('src')).toBe(AGENT_BADGES.codex.image);
  });

  it('heads the panel with the session, its state, its repo and its pane', () => {
    const { target } = panel(CHECKOUT, 'oa-c3');
    expect(text(target.querySelector('.back'))).toBe('← Floor 4 · checkout-v2');
    expect(text(target.querySelector('.eyebrow'))).toBe('orders-api · tmux pane %7');
    expect(text(target.querySelector('h2'))).toBe('orders-api-c3');
    expect(text(target.querySelector('.pill'))).toBe('Needs you');
    expect(text(target.querySelector('.p-text'))).toBe('Add idempotency keys to POST /orders');
  });

  it('says in words when the session has no desk: it waits for a free one, or is dormant', () => {
    const floor = makeFloor(CHECKOUT)!;
    floor.unseated.push(
      { ...find(floor, 'sw-a1'), sessionId: 'sw-w9', name: 'storefront-web-w9', at: { kind: 'gone' } },
      { ...find(floor, 'sw-b2'), sessionId: 'sw-z8', name: 'storefront-web-z8', state: 'dormant', robot: null, at: { kind: 'gone' } },
    );
    const line = (id: string, on: FloorDetail = floor) => {
      const out = panel(CHECKOUT, id, NOW, () => {}, on).target.querySelector('.no-desk');
      cleanup();
      return out && text(out);
    };
    expect([line('sw-w9'), line('sw-z8'), line('sw-a1')]).toEqual(['No desk: waiting for a free desk', 'No desk: dormant', null]);
    // A dormant session keeps its desk while nobody needs it.
    expect(line('ds-m3', makeFloor(DOCS)!)).toBeNull();
  });

  it('says what it waits for and who raised it', () => {
    expect(panel(CHECKOUT, 'oa-c3').facts()['Waiting for']).toBe('Permission: Bash (rm -rf dist && npm run build)');
    cleanup();
    expect(panel(ORDERS, 'oa-g7').facts()['Waiting for']).toBe('Question: Should the retry queue use Redis or Postgres? · raised by Explore');
  });

  it('says how long a silent command has been running, by the clock', () => {
    expect(panel(SEARCH, 'ss-e5').facts()['Running']).toBe('Bash: npm test for 14m, no new output');
    cleanup();
    expect(panel(SEARCH, 'ss-e5', NOW + 60_000).facts()['Running']).toBe('Bash: npm test for 15m, no new output');
  });

  it('says how long a working session has run its command, and nothing about its output', () => {
    const { facts } = panel(CHECKOUT, 'sw-a1', NOW, (d) => {
      d.activity = { label: 'Bash: npm run build', since: NOW - 90_000, running: true };
    });
    expect(facts()['Running']).toBe('Bash: npm run build for 1m');
  });

  it('marks a dropped call on its running line, the non-visual echo of the floor\'s own red flash', () => {
    const { facts } = panel(CHECKOUT, 'sw-a1', NOW, (d) => {
      d.activity = { label: 'notion: search', since: NOW - 1_000, running: true };
      d.call = { slot: 0, family: null, write: false, fairmind: false, error: true };
    });
    expect(facts()['Running']).toBe('notion: search ✗ for 1s');
  });

  it('lists the facts: since, last action, subagents, repo, branch, folder and pane', () => {
    const { facts } = panel(CHECKOUT, 'sw-a1');
    expect(facts()).toEqual({
      Agent: 'Claude Code',
      Since: '40s ago',
      'Last action': 'Edit src/checkout/AddressStep.tsx · 40s ago',
      Subagents: '2 running',
      Repo: 'storefront-web',
      Branch: 'feat/checkout-v2',
      Folder: '/Users/dev/code/storefront-web',
      Pane: '%4',
    });
    cleanup();
    expect(panel(CHECKOUT, 'oa-c3').facts()['Branch']).toBe('feat/checkout-v2 · worktree');
  });

  it('goes to the pane, and marks a done session as seen', () => {
    const { button, onGo, onSeen } = panel(CHECKOUT, 'sw-b2');
    expect(button('Go to pane')!.disabled).toBe(false);
    expect(text(button('Go to pane'))).toBe('Go to pane %5');
    click(button('Go to pane'));
    expect(onGo).toHaveBeenCalledWith('sw-b2');
    click(button('Mark as seen'));
    expect(onSeen).toHaveBeenCalledWith('sw-b2');
  });

  it('ignores the second click of a double-click, aimed at the desk row this panel has just replaced', () => {
    const { target, button, onBack, onGo, onSeen } = panel(CHECKOUT, 'sw-b2');
    const press = (el: Element | null | undefined, detail: number) => el!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail }));
    for (const el of [target.querySelector('.back'), button('Go to pane'), button('Mark as seen')]) press(el, 2);
    expect(onBack).not.toHaveBeenCalled();
    expect(onGo).not.toHaveBeenCalled();
    expect(onSeen).not.toHaveBeenCalled();
    // A single click acts, and so does a key press, whose click has detail 0.
    press(button('Go to pane'), 1);
    press(button('Go to pane'), 0);
    expect(onGo).toHaveBeenCalledTimes(2);
  });

  it('offers Mark as seen only when the session is done', () => {
    expect(panel(CHECKOUT, 'sw-a1').button('Mark as seen')).toBeUndefined();
  });

  it('turns Go off for a remote session, and says why', () => {
    const { target, button, onGo, facts } = panel(ORDERS, 'oa-k1');
    expect(text(target.querySelector('.eyebrow'))).toBe('orders-api · remote');
    expect(text(target.querySelector('.tag'))).toBe('remote');
    expect(button('Go to pane')!.disabled).toBe(true);
    click(button('Go to pane'));
    expect(onGo).not.toHaveBeenCalled();
    expect(text(target.querySelector('.actions + .p-note'))).toBe('It runs in the cloud: there is no tmux pane to go to.');
    expect(facts()['Pane']).toBe('none');
  });

  it('turns Go off for a local session outside tmux', () => {
    const { target, button } = panel(CHECKOUT, 'sw-a1', NOW, (d) => {
      d.pane = null;
      d.focusable = false;
    });
    expect(text(target.querySelector('.eyebrow'))).toBe('storefront-web · not in tmux');
    expect(button('Go to pane')!.disabled).toBe(true);
    expect(text(target.querySelector('.actions + .p-note'))).toBe('It does not run in a tmux pane, so there is nowhere to go.');
  });

  it('goes back to the floor', () => {
    const { target, onBack } = panel(CHECKOUT, 'sw-a1');
    click(target.querySelector('.back'));
    expect(onBack).toHaveBeenCalled();
  });

  it('shows a hostile title and reason as text', () => {
    const { target } = panel(CHECKOUT, 'oa-c3', NOW, (d) => {
      d.title = '<img src=x onerror=alert(1)>';
      d.reason = { kind: 'permission', text: '<script>x</script>', detail: null, agent: null };
    });
    expect(text(target.querySelector('.p-text'))).toBe('<img src=x onerror=alert(1)>');
    expect(text(target.querySelector('.warn'))).toBe('Permission: <script>x</script>');
    expect(target.querySelector('script')).toBeNull();
    expect([...target.querySelectorAll('img')].filter(img => !img.closest('.agent-badge'))).toHaveLength(0);
  });

  it('says where the session stands, and how long ago that was written', () => {
    const summary = { text: 'Copy is rewritten and ready for review', at: NOW - 2 * MIN, stale: false };
    const { target } = panel(CHECKOUT, 'sw-b2', NOW, (d) => (d.summary = summary));
    const line = target.querySelector('section.summary')!;
    expect(text(line.querySelector('h3'))).toBe('Where it stands');
    expect(text(line.querySelector('.s-text'))).toBe('Copy is rewritten and ready for review');
    expect(text(line.querySelector('.s-age'))).toBe('2m ago');
    expect(line.classList.contains('stale')).toBe(false);
    cleanup();
    const later = panel(CHECKOUT, 'sw-b2', NOW + MIN, (d) => (d.summary = summary)).target;
    expect(text(later.querySelector('.s-age'))).toBe('3m ago');
  });

  it('dims a line older than the last prompt, and says so in words', () => {
    const { target } = panel(CHECKOUT, 'oa-c3', NOW, (d) => (d.summary = { text: 'Waits for permission to rebuild dist', at: NOW - 12 * MIN, stale: true }));
    const line = target.querySelector('section.summary')!;
    expect(line.classList.contains('stale')).toBe(true);
    expect(text(line.querySelector('.s-age'))).toBe('12m ago (older than the last prompt)');
  });

  it('shows no line, no interns and no runs where there are none', () => {
    const { target } = panel(CHECKOUT, 'sw-b2');
    expect(target.querySelectorAll('section')).toHaveLength(0);
    expect(target.querySelector('h3')).toBeNull();
  });

  it('lists its interns, running first, and how many more there are', () => {
    const { rows } = panel(CHECKOUT, 'sw-a1', NOW, (d) => {
      d.interns = [
        { agentId: 'a1', type: 'Explore', label: 'Find every caller of useCart()', running: true, inRoom: false, smoking: false, leisure: null, call: null },
        { agentId: 'a2', type: null, label: null, running: true, inRoom: false, smoking: false, leisure: null, call: null },
        { agentId: 'a3', type: 'general-purpose', label: 'Check the address form against the design', running: false, inRoom: false, smoking: false, leisure: null, call: null },
      ];
      d.internsMore = 2;
    });
    expect(rows('Interns')).toEqual([
      'Explore | running | Find every caller of useCart()',
      'Subagent | running',
      'general-purpose | finished | Check the address form against the design',
      '+2 more',
    ]);
  });

  it('lists two interns that share an id, each in its row', () => {
    const { rows } = panel(CHECKOUT, 'sw-a1', NOW, (d) => {
      d.interns = [
        { agentId: 'same', type: 'Explore', label: 'Find the callers', running: true, inRoom: false, smoking: false, leisure: null, call: null },
        { agentId: 'same', type: 'Plan', label: null, running: false, inRoom: false, smoking: false, leisure: null, call: null },
      ];
    });
    expect(rows('Interns')).toEqual(['Explore | running | Find the callers', 'Plan | finished']);
  });

  it('lists its runs with how long each ran, and opens one that has a room', () => {
    const { target, rows, onRun } = panel(CHECKOUT, 'ps-d4', NOW, () => {}, checkoutWithRoom());
    expect(rows('Workflow runs')).toEqual(['checkout-verify | Running for 9m', 'nightly-smoke | Completed in 8m']);
    const links = [...target.querySelectorAll('section button.l-name')];
    expect(links.map(text)).toEqual(['checkout-verify']);
    links[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
    expect(onRun).not.toHaveBeenCalled();
    click(links[0]);
    expect(onRun).toHaveBeenCalledWith(RUN);
  });

  it('names a run without a name by its id, and says how each finished', () => {
    const { rows } = panel(CHECKOUT, 'ps-d4', NOW, (d) => {
      d.runs = [
        { runId: 'wf_0000aaaa-002', name: null, status: 'failed', startedAt: NOW - 5 * MIN, endedAt: NOW - 2 * MIN, counts: { running: 0, finished: 3 } },
        { runId: 'wf_0000aaaa-003', name: 'release', status: 'killed', startedAt: NOW - 3 * 60 * MIN, endedAt: NOW - 60 * MIN, counts: { running: 0, finished: 1 } },
      ];
    });
    expect(rows('Workflow runs')).toEqual(['wf_0000aaaa-002 | Failed after 3m', 'release | Stopped after 2h']);
  });

  it('shows a hostile summary, intern and run name as text', () => {
    const { target } = panel(CHECKOUT, 'ps-d4', NOW, (d) => {
      d.summary = { text: '<img src=x onerror=alert(1)>', at: NOW, stale: false };
      d.interns = [{ agentId: 'x', type: '<b>t</b>', label: '<script>x</script>', running: true, inRoom: false, smoking: false, leisure: null, call: null }];
      d.runs = [{ runId: 'wf_x', name: '<i>run</i>', status: 'completed', startedAt: NOW - MIN, endedAt: NOW, counts: { running: 0, finished: 1 } }];
    });
    expect(text(target.querySelector('.s-text'))).toBe('<img src=x onerror=alert(1)>');
    expect([...target.querySelectorAll('.l-name, .l-sub')].map(text)).toEqual(['<b>t</b>', '<script>x</script>', '<i>run</i>']);
    expect(target.querySelector('script, b, i')).toBeNull();
    expect([...target.querySelectorAll('img')].filter(img => !img.closest('.agent-badge'))).toHaveLength(0);
  });
});
