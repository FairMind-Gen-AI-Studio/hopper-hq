import { afterEach, describe, expect, it, vi } from 'vitest';
import RunPanel from '../../components/RunPanel.svelte';
import type { FloorDetail, MeetingRoom, Occupant } from '../../../src/scene/types';
import { occupantsOf } from '../../lib/occupants';
import { NOW } from '../helpers/fixtures';
import { DONE_RUN, RUN, checkoutWithRoom } from '../helpers/rooms';
import { cleanup, click, render, text } from '../helpers/render';

afterEach(cleanup);

/** The checkout floor with its room, changed as the test needs. */
function floorWith(change: (room: MeetingRoom, host: Occupant, floor: FloorDetail) => void = () => {}): FloorDetail {
  const floor = checkoutWithRoom();
  const host = occupantsOf(floor).find((d) => d.sessionId === 'ps-d4')!;
  change(floor.rooms[0]!, host, floor);
  return floor;
}

function panel(runId: string, floor: FloorDetail = floorWith(), now = NOW) {
  const onBack = vi.fn();
  const onDesk = vi.fn();
  const onGo = vi.fn();
  const target = render(RunPanel, { floor, runId, now, onBack, onDesk, onGo });
  const facts = () => Object.fromEntries([...target.querySelectorAll('dt')].map((dt) => [text(dt), text(dt.nextElementSibling)]));
  const go = () => target.querySelector<HTMLButtonElement>('.actions button.primary');
  const headings = () => [...target.querySelectorAll('h3')].map(text);
  return { target, onBack, onDesk, onGo, facts, go, headings };
}

describe('RunPanel', () => {
  it('heads a run in its room with its name, its state, its repo and its summary', () => {
    const { target } = panel(RUN);
    expect(text(target.querySelector('.back'))).toBe('← Floor 4 · checkout-v2');
    expect(text(target.querySelector('.eyebrow'))).toBe('Workflow run · payments-svc');
    const h2 = target.querySelector('h2')!;
    expect(text(h2)).toBe('checkout-verify');
    expect(h2.getAttribute('tabindex')).toBe('-1');
    expect(text(target.querySelector('.pill'))).toBe('Running');
    expect(text(target.querySelector('.p-text'))).toBe('Verify split payments end to end');
  });

  it('lists the phases with a mark for the eye and a word for a screen reader', () => {
    const { target, headings } = panel(RUN);
    expect(headings()).toEqual(['Phases', 'Agents']);
    const items = [...target.querySelectorAll('.phases li')];
    expect(items.map((li) => text(li.querySelector('.ph-title')))).toEqual(['Plan', 'Build', 'Review', 'Ship']);
    expect(items.map((li) => text(li.querySelector('.mark')))).toEqual(['✓', '●', '○', '○']);
    expect(items.every((li) => li.querySelector('.mark')!.getAttribute('aria-hidden') === 'true')).toBe(true);
    expect(items.map((li) => text(li.querySelector('.visually-hidden')))).toEqual([', done', ', current', ', upcoming', ', upcoming']);
    expect(items.map((li) => li.className.split(' ').find((c) => c.startsWith('ph-')))).toEqual(['ph-done', 'ph-current', 'ph-upcoming', 'ph-upcoming']);
  });

  it('says how far it has got: how long, how many agents, its host and its id', () => {
    expect(panel(RUN).facts()).toEqual({ Status: 'Running for 9m', Agents: '2 running · 1 done', Host: 'payments-svc-d4', 'Run id': RUN });
  });

  it('lists its agents with their phase, the running ones first', () => {
    const { target } = panel(RUN);
    const rows = [...target.querySelectorAll('.agents li')];
    expect(rows.map((li) => `${text(li.querySelector('.a-name'))} | ${text(li.querySelector('.a-meta'))}`)).toEqual([
      'Implement the split ledger entries | Build · running',
      'Implement the refund path | Build · running',
      'Map the split payment flow | Plan · finished',
    ]);
    expect(rows.map((li) => li.querySelector('.dot')!.classList.contains('sw-in_meeting'))).toEqual([true, true, false]);
  });

  it('lists two agents that share an id, each in its row', () => {
    const floor = floorWith((room) => {
      room.agents = [
        { agentId: 'same', label: 'Plan the ledger', phase: 'Plan', type: 'workflow-subagent', running: true, smoking: false, leisure: null },
        { agentId: 'same', label: 'Check the ledger', phase: 'Build', type: 'workflow-subagent', running: true, smoking: false, leisure: null },
      ];
    });
    expect([...panel(RUN, floor).target.querySelectorAll('.agents li .a-name')].map(text)).toEqual(['Plan the ledger', 'Check the ledger']);
  });

  it('names an agent by its type, or plainly, when it has no label, and says when no agent has started', () => {
    const floor = floorWith((room) => {
      room.agents = [
        { agentId: 'a', label: null, phase: null, type: 'Explore', running: true, smoking: false, leisure: null },
        { agentId: 'b', label: null, phase: null, type: null, running: false, smoking: false, leisure: null },
      ];
    });
    const { target } = panel(RUN, floor);
    expect([...target.querySelectorAll('.agents li')].map((li) => `${text(li.querySelector('.a-name'))} | ${text(li.querySelector('.a-meta'))}`)).toEqual([
      'Explore | running',
      'Agent | finished',
    ]);
    cleanup();
    const empty = panel(RUN, floorWith((room) => (room.agents = []))).target;
    expect(empty.querySelector('.agents')).toBeNull();
    expect(text(empty.querySelector('.p-note'))).toBe('No agent has started yet.');
  });

  it('shows a run whose phases are not known with its name or id, its summary and the phase it is in', () => {
    const { target, headings } = panel(RUN, floorWith((room) => (room.phases = [{ title: 'Build', state: 'current' }])));
    expect([...target.querySelectorAll('.phases li')].map((li) => text(li.querySelector('.ph-title')))).toEqual(['Build']);
    expect(headings()).toEqual(['Phases', 'Agents']);
    cleanup();
    const bare = panel(
      RUN,
      floorWith((room, host) => {
        room.phases = [];
        room.name = null;
        room.summary = null;
        host.runs[0]!.name = null;
      }),
    );
    expect(text(bare.target.querySelector('h2'))).toBe(RUN);
    expect(bare.target.querySelector('.phases')).toBeNull();
    expect(bare.headings()).toEqual(['Agents']);
    expect(bare.target.querySelector('.p-text')).toBeNull();
    expect(bare.facts()['Agents']).toBe('2 running · 1 done');
  });

  it('opens the host desk, and goes to its pane', () => {
    const { target, onDesk, onGo, go } = panel(RUN);
    click(target.querySelector('dd button.host'));
    expect(onDesk).toHaveBeenCalledWith('ps-d4');
    expect(text(go())).toBe('Go to pane %9');
    expect(go()!.disabled).toBe(false);
    click(go());
    expect(onGo).toHaveBeenCalledWith('ps-d4');
  });

  it('ignores the second click of a double-click, aimed at what this panel has just replaced', () => {
    const { target, onBack, onDesk, onGo, go } = panel(RUN);
    const press = (el: Element | null | undefined, detail: number) => el!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail }));
    for (const el of [target.querySelector('.back'), target.querySelector('button.host'), go()]) press(el, 2);
    expect([onBack, onDesk, onGo].map((fn) => fn.mock.calls.length)).toEqual([0, 0, 0]);
    press(target.querySelector('.back'), 1);
    press(go(), 0);
    expect([onBack, onGo].map((fn) => fn.mock.calls.length)).toEqual([1, 1]);
  });

  it('turns Go off when the host has no tmux pane, and says why', () => {
    const local = panel(
      RUN,
      floorWith((_room, host) => {
        host.pane = null;
        host.focusable = false;
      }),
    );
    expect(text(local.go())).toBe('Go to pane');
    expect(local.go()!.disabled).toBe(true);
    click(local.go());
    expect(local.onGo).not.toHaveBeenCalled();
    expect(text(local.target.querySelector('.actions + .p-note'))).toBe('Its host does not run in a tmux pane, so there is nowhere to go.');
    cleanup();
    const remote = panel(
      RUN,
      floorWith((_room, host) => {
        host.location = 'cloud';
        host.focusable = false;
      }),
    );
    expect(text(remote.target.querySelector('.actions + .p-note'))).toBe('Its host runs in the cloud: there is no tmux pane to go to.');
  });

  it('shows a finished run from its host desk, and says it has finished', () => {
    const { target, facts, headings, go, onGo } = panel(DONE_RUN);
    expect(text(target.querySelector('h2'))).toBe('nightly-smoke');
    expect(text(target.querySelector('.pill'))).toBe('Completed');
    expect(text(target.querySelector('.p-note'))).toBe('This run has finished, and its room has closed.');
    expect(facts()).toEqual({ Status: 'Completed in 8m', Agents: '0 running · 4 done', Host: 'payments-svc-d4', 'Run id': DONE_RUN });
    expect(headings()).toEqual([]);
    click(go());
    expect(onGo).toHaveBeenCalledWith('ps-d4');
  });

  it('says so when a running run has no room on this floor', () => {
    const { target, facts } = panel(RUN, floorWith((_room, _host, floor) => (floor.rooms = [])));
    expect(text(target.querySelector('h2'))).toBe('checkout-verify');
    expect(text(target.querySelector('.pill'))).toBe('Running');
    expect(text(target.querySelector('.p-note'))).toBe('This run has no room on this floor.');
    expect(facts()['Status']).toBe('Running for 9m');
  });

  it('says when the run is no longer on this floor, and goes back to it', () => {
    const { target, onBack } = panel('wf_gone');
    expect(text(target.querySelector('h2'))).toBe('wf_gone');
    expect(target.querySelector('h2')!.getAttribute('tabindex')).toBe('-1');
    expect(text(target.querySelector('.p-text'))).toBe('This run is no longer on this floor.');
    expect(target.querySelector('.pill, dl, .actions')).toBeNull();
    click(target.querySelector('.back'));
    expect(onBack).toHaveBeenCalled();
  });

  it('shows hostile names, summaries, phases and labels as text', () => {
    const floor = floorWith((room) => {
      room.name = '<b>bold</b>';
      room.summary = '<img src=x onerror=alert(1)>';
      room.phases[0]!.title = '<script>alert(1)</script>';
      room.agents[0]!.label = '<i>agent</i>';
    });
    const { target } = panel(RUN, floor);
    expect(text(target.querySelector('h2'))).toBe('<b>bold</b>');
    expect(text(target.querySelector('.p-text'))).toBe('<img src=x onerror=alert(1)>');
    expect(text(target.querySelector('.ph-title'))).toBe('<script>alert(1)</script>');
    expect(text(target.querySelector('.a-name'))).toBe('<i>agent</i>');
    expect(target.querySelector('b, img, script, i')).toBeNull();
    cleanup();
    const unknown = panel('<img src=x onerror=alert(1)>').target;
    expect(text(unknown.querySelector('h2'))).toBe('<img src=x onerror=alert(1)>');
    expect(unknown.querySelector('img')).toBeNull();
  });
});
