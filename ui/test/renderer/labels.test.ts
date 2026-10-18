import { AGENT_BADGES } from '../../lib/agent-badge';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrthographicCamera } from 'three';
import type { ShownState } from '../../../src/scene/types';
import type { Target } from '../../renderer/index';
import { AGENT_TAG, COMPACT_PX, DOT_PX, LabelLayer, RANK, declutter, projectToScreen, roomTitle, tagRank, tagTitle, type LabelBox, type LabelEvents } from '../../renderer/labels';
import css from '../../renderer/labels.css?raw';
import { LABEL_Y, boardAnchor, headSpot, labelAnchor, loungeSpots, roomTagAnchor } from '../../renderer/world';
import { checkoutFloor, checkoutSpecs, checkoutRooms, isoCamera, makeFloor, roomFloor, seatOf, seatsOf, type CheckoutSpec } from './fixtures';

/** A camera looking straight down at a 10 m square around the origin. */
function topDown(): OrthographicCamera {
  const camera = new OrthographicCamera(-5, 5, 5, -5, 0.1, 100);
  camera.position.set(0, 10, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return camera;
}

const deskTarget = (id: string): Target => ({ kind: 'desk', id });
const roomTarget = (id: string): Target => ({ kind: 'room', id });
/** A target as the calls list writes it: a desk by its id, a room as 'room <run id>'. */
const said = (t: Target) => (t.kind === 'desk' ? t.id : `room ${t.id}`);

function layer() {
  const root = document.body.appendChild(document.createElement('div'));
  const calls: string[] = [];
  const events: LabelEvents = {
    select: (target) => calls.push('select ' + said(target)),
    activate: (target) => calls.push('activate ' + said(target)),
    lostFocus: () => calls.push('lostFocus'),
  };
  return { root, calls, labels: new LabelLayer(root, events) };
}

const HOSTILE = '<img src=x onerror=alert(1)>';

/** The declarations of the rule for exactly this selector in labels.css. */
function rule(selector: string): string {
  const at = css.indexOf(`\n${selector} {\n`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf('}', at));
}

afterEach(() => document.body.replaceChildren());

describe('projection', () => {
  it('maps world points to canvas pixels, y down', () => {
    const camera = topDown();
    expect(projectToScreen({ x: 0, y: 0, z: 0 }, camera, 800, 400)).toEqual({ x: 400, y: 200, visible: true });
    expect(projectToScreen({ x: -5, y: 0, z: -5 }, camera, 800, 400)).toEqual({ x: 0, y: 0, visible: true });
    expect(projectToScreen({ x: 2.5, y: 1, z: 2.5 }, camera, 800, 400)).toEqual({ x: 600, y: 300, visible: true });
  });

  it('culls points off the view, behind the camera or past the far plane', () => {
    const camera = topDown();
    expect(projectToScreen({ x: 5.4, y: 0, z: 0 }, camera, 800, 400).visible).toBe(true);
    expect(projectToScreen({ x: 6, y: 0, z: 0 }, camera, 800, 400).visible).toBe(false);
    expect(projectToScreen({ x: 0, y: 0, z: -7 }, camera, 800, 400).visible).toBe(false);
    expect(projectToScreen({ x: 0, y: 20, z: 0 }, camera, 800, 400).visible).toBe(false);
    expect(projectToScreen({ x: 0, y: -200, z: 0 }, camera, 800, 400).visible).toBe(false);
  });
});

describe('the label layer', () => {
  it('shows a tag per session at a desk but a dormant one, with its state, name, note, agents and remote mark, and a placard per pod that has one', () => {
    const { root, labels } = layer();
    const checkouts = checkoutSpecs();
    checkouts[2]!.desks[0]!.cloud = true;
    labels.sync(makeFloor(checkouts));
    expect(root.classList.contains('fv-labels')).toBe(true);
    expect(root.querySelectorAll('.fv-tag')).toHaveLength(6);
    expect(root.querySelectorAll('.fv-sign')).toHaveLength(3);
    const needs = labels.tag('oa-c3')!;
    expect(needs.tagName).toBe('BUTTON');
    expect(needs.dataset.session).toBe('oa-c3');
    expect([...needs.classList]).toEqual(['fv-tag', 'fv-desk', 'fv-st-needs_you', 'fv-badge-needs']);
    expect([...needs.children].map((c) => [c.className, c.textContent])).toEqual([
      ['agent-badge agent-badge--claude-code', ''],
      ['fv-dot', ''],
      ['fv-name', 'oa-c3'],
      ['fv-note', 'needs you'],
    ]);
    const meeting = labels.tag('ps-d4')!;
    expect([...meeting.children].map((c) => c.textContent)).toEqual(['', '', 'ps-d4', '+2', 'remote']);
    expect(meeting.title).toBe('ps-d4 · in meeting · 2 agents running · remote');
    expect(labels.tag('ps-f7')).toBeUndefined();
    const sign = labels.sign('p1')!;
    expect(sign.firstChild!.textContent).toBe('orders-api');
    expect(sign.querySelector('small')!.textContent).toBe('feat/checkout-v2 · worktree');
    expect(labels.sign('p2')!.textContent).toBe('payments-svcfeat/checkout-v2');
    expect(labels.sign('p3')).toBeUndefined();
    // Occupants that share only their repository: the placard names it alone.
    const shared = makeFloor(checkouts);
    shared.pods[1]!.placard = { repo: 'orders-api', branch: null, worktree: false, path: null };
    labels.sync(shared);
    expect([labels.sign('p1')!.textContent, labels.sign('p1')!.querySelector('small')]).toEqual(['orders-api', null]);
  });

  it('keeps agent identity separate from state and updates a badge when the agent changes', () => {
    const { labels } = layer();
    const floor = checkoutFloor();
    const codex = seatOf(floor, 'sw-a1').occupant;
    codex.agentKind = 'codex';
    labels.sync(floor);
    const tag = labels.tag('sw-a1')!;
    expect(tag.querySelector('.agent-badge')?.getAttribute('aria-label')).toBe('Codex');
    expect(tag.querySelector('.agent-badge img')?.getAttribute('src')).toBe(AGENT_BADGES.codex.image);
    expect(tag.querySelector('.fv-dot')).not.toBeNull();
    codex.agentKind = 'claude-code';
    labels.sync(floor);
    expect(labels.tag('sw-a1')).toBe(tag);
    expect(tag.querySelector('.agent-badge')?.getAttribute('aria-label')).toBe('Claude Code');
    expect(tag.querySelector('.agent-badge img')?.getAttribute('src')).toBe(AGENT_BADGES['claude-code'].image);
    labels.setScale(COMPACT_PX - 1);
    expect(tag.querySelector('.agent-badge')).not.toBeNull();
  });

  it('writes names, repos and branches as text, never as markup', () => {
    const { root, labels } = layer();
    const checkouts = checkoutSpecs();
    checkouts[0]!.repo = HOSTILE;
    checkouts[0]!.branch = HOSTILE;
    checkouts[0]!.desks[0]!.name = HOSTILE;
    labels.sync(makeFloor(checkouts));
    expect([...root.querySelectorAll('img')].filter(img => !img.closest('.agent-badge'))).toHaveLength(0);
    expect(labels.tag('sw-a1')!.querySelector('.fv-name')!.textContent).toBe(HOSTILE);
    expect(labels.sign('p0')!.firstChild!.textContent).toBe(HOSTILE);
    expect(labels.tag('sw-a1')!.title.startsWith(HOSTILE)).toBe(true);
  });

  it('updates tags in place, adds new ones and removes the gone', () => {
    const { root, labels } = layer();
    labels.sync(checkoutFloor());
    const tag = labels.tag('sw-a1')!;
    const name = tag.querySelector('.fv-name');
    labels.sync(checkoutFloor());
    expect(tag.querySelector('.fv-name')).toBe(name);
    const checkouts = checkoutSpecs();
    checkouts[0]!.desks = [{ id: 'sw-a1', state: 'needs_you' }, { id: 'sw-b2', state: 'done' }, { id: 'sw-x9', state: 'working' }];
    checkouts.pop();
    labels.sync(makeFloor(checkouts));
    expect(labels.tag('sw-a1')).toBe(tag);
    expect(tag.classList.contains('fv-st-needs_you')).toBe(true);
    expect(labels.tag('sw-c3')).toBeUndefined();
    expect(labels.tag('sw-x9')).toBeDefined();
    expect(labels.sign('p2')).toBeUndefined();
    expect(root.querySelectorAll('.fv-tag')).toHaveLength(5);
    expect(root.querySelectorAll('.fv-sign')).toHaveLength(2);
  });

  it('selects on click and activates on double-click', () => {
    const { calls, labels } = layer();
    labels.sync(checkoutFloor());
    labels.tag('oa-c3')!.click();
    labels.tag('sw-b2')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(calls).toEqual(['select oa-c3', 'activate sw-b2']);
  });

  it('tells which click of a series selected', () => {
    const root = document.body.appendChild(document.createElement('div'));
    const counts: number[] = [];
    const labels = new LabelLayer(root, { select: (_id, clicks) => counts.push(clicks), activate: () => {}, lostFocus: () => {} });
    labels.sync(checkoutFloor());
    const tag = labels.tag('oa-c3')!;
    tag.dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true }));
    tag.dispatchEvent(new MouseEvent('click', { detail: 2, bubbles: true }));
    tag.click();
    expect(counts).toEqual([1, 2, 0]);
  });

  it('activates on Enter only once the desk is selected', () => {
    const { calls, labels } = layer();
    labels.sync(checkoutFloor());
    const enter = () => new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    const first = enter();
    labels.tag('oa-c3')!.dispatchEvent(first);
    expect(calls).toEqual([]);
    expect(first.defaultPrevented).toBe(false);
    labels.setSelected(deskTarget('oa-c3'));
    const second = enter();
    labels.tag('oa-c3')!.dispatchEvent(second);
    expect(calls).toEqual(['activate oa-c3']);
    expect(second.defaultPrevented).toBe(true);
  });

  it('marks the selected tag, also when it is created after the selection', () => {
    const { root, labels } = layer();
    labels.sync(checkoutFloor());
    labels.setSelected(deskTarget('sw-b2'));
    labels.setSelected(deskTarget('oa-c3'));
    expect([...root.querySelectorAll('.fv-sel')].map((e) => (e as HTMLElement).dataset.session)).toEqual(['oa-c3']);
    expect(labels.tag('oa-c3')!.getAttribute('aria-current')).toBe('true');
    expect(labels.tag('sw-b2')!.hasAttribute('aria-current')).toBe(false);
    labels.setSelected(deskTarget('sw-x9'));
    const checkouts = checkoutSpecs();
    checkouts[0]!.desks.push({ id: 'sw-x9', state: 'working' });
    labels.sync(makeFloor(checkouts));
    expect(labels.tag('sw-x9')!.classList.contains('fv-sel')).toBe(true);
    labels.setSelected(null);
    expect(root.querySelectorAll('.fv-sel')).toHaveLength(0);
  });

  it('puts one tag in the tab order: the one selected or focused last, else the first', () => {
    const { labels } = layer();
    const ids = seatsOf(checkoutFloor()).map((s) => s.occupant.sessionId);
    const stops = () => ids.filter((id) => labels.tag(id)?.tabIndex === 0);
    labels.sync(checkoutFloor());
    expect(stops()).toEqual(['sw-a1']);
    expect(ids.filter((id) => labels.tag(id)?.tabIndex === -1)).toHaveLength(5);
    labels.setSelected(deskTarget('oa-c3'));
    expect(stops()).toEqual(['oa-c3']);
    labels.tag('ps-d4')!.focus();
    expect(stops()).toEqual(['ps-d4']);
    // A floor update marks the same selection again: the tab stop stays where the focus left it.
    labels.sync(checkoutFloor());
    labels.setSelected(deskTarget('oa-c3'));
    expect(stops()).toEqual(['ps-d4']);
    // When its desk leaves, the stop goes to the selected desk's tag, or with none selected to the first.
    const checkouts = checkoutSpecs();
    checkouts[2]!.desks.shift();
    labels.sync(makeFloor(checkouts));
    expect(stops()).toEqual(['oa-c3']);
    labels.setSelected(null);
    expect(stops()).toEqual(['oa-c3']);
    checkouts[1]!.desks.shift();
    labels.sync(makeFloor(checkouts));
    expect(stops()).toEqual(['sw-a1']);
  });

  it('moves the focus between the tags on the view with the arrow keys, Home and End, in floor order', () => {
    const { labels } = layer();
    const floor = checkoutFloor();
    labels.sync(floor);
    const camera = isoCamera(floor.size);
    labels.position(camera, 800, 500);
    const press = (key: string) => {
      const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      (document.activeElement as HTMLElement).dispatchEvent(e);
      return e.defaultPrevented;
    };
    const focused = () => (document.activeElement as HTMLElement).dataset.session;
    labels.tag('oa-c3')!.focus();
    expect(press('ArrowRight')).toBe(true);
    expect(focused()).toBe('oa-d5');
    press('ArrowUp');
    press('ArrowLeft');
    expect(focused()).toBe('sw-c3');
    press('End');
    press('ArrowDown');
    expect(focused()).toBe('ps-d4');
    expect(labels.tag('ps-d4')!.tabIndex).toBe(0);
    press('Home');
    expect(focused()).toBe('sw-a1');
    expect(press('x')).toBe(false);
    // Closer in, the first pod's three tags are off the view: the keys pass them by.
    camera.zoom = 3;
    camera.updateProjectionMatrix();
    labels.position(camera, 800, 500);
    labels.tag('oa-d5')!.focus();
    press('Home');
    expect(focused()).toBe('oa-c3');
    press('ArrowLeft');
    expect(focused()).toBe('oa-c3');
  });

  describe('the tab stop', () => {
    const stops = (labels: LabelLayer) => seatsOf(checkoutFloor()).map((s) => s.occupant.sessionId).filter((id) => labels.tag(id)?.tabIndex === 0);
    const zoomed = (labels: LabelLayer, zoom: number) => {
      const floor = checkoutFloor();
      const camera = isoCamera(floor.size);
      camera.zoom = zoom;
      camera.updateProjectionMatrix();
      labels.position(camera, 800, 500);
      return camera;
    };
    /** Turns the camera away so that no tag is on the view. */
    const away = (labels: LabelLayer) => {
      const camera = zoomed(labels, 1);
      camera.position.x += 1000;
      camera.updateMatrixWorld();
      labels.position(camera, 800, 500);
      return camera;
    };

    it('moves to the nearest tag on the view when its tag leaves the view', () => {
      const { labels, calls } = layer();
      labels.sync(checkoutFloor());
      zoomed(labels, 1);
      expect(stops(labels)).toEqual(['sw-a1']);
      // Closer in, the first pod's three tags are off the view: the stop passes on to the next one in floor order.
      zoomed(labels, 3);
      expect(stops(labels)).toEqual(['oa-c3']);
      zoomed(labels, 4);
      expect(stops(labels)).toEqual(['oa-d5']);
      expect(calls).toEqual([]);
    });

    it('gives the stop to the earlier of two tags on the view that are equally near it in floor order', () => {
      const { labels } = layer();
      const floor = checkoutFloor();
      const seats = seatsOf(floor);
      const desks = seats.map((s) => s.occupant);
      // The third desk stands at the far end of the floor, away from its neighbours in floor order.
      seats[2]!.desk.rect = seats[seats.length - 1]!.desk.rect;
      labels.sync(floor);
      labels.setSelected(deskTarget(desks[2]!.sessionId));
      // A top-down camera over the second and the fourth desk, which are one step either side of it in floor order.
      const a = labelAnchor(floor, seats[1]!.desk, seats[1]!.occupant);
      const b = labelAnchor(floor, seats[3]!.desk, seats[3]!.occupant);
      const camera = new OrthographicCamera(-4.6, 4.6, 4.6, -4.6, 0.1, 100);
      camera.position.set((a.x + b.x) / 2, 10, a.z);
      camera.up.set(0, 0, -1);
      camera.lookAt((a.x + b.x) / 2, 0, a.z);
      camera.updateMatrixWorld();
      labels.position(camera, 800, 500);
      const shown = desks.filter((d) => labels.tag(d.sessionId)?.style.visibility === '').map((d) => d.sessionId);
      expect(shown).toContain(desks[1]!.sessionId);
      expect(shown).toContain(desks[3]!.sessionId);
      expect(shown).not.toContain(desks[2]!.sessionId);
      expect(stops(labels)).toEqual([desks[1]!.sessionId]);
    });

    it('leaves the stop alone while its tag stays on the view', () => {
      const { labels } = layer();
      labels.sync(checkoutFloor());
      labels.tag('ps-d4')!.focus();
      zoomed(labels, 3);
      expect(stops(labels)).toEqual(['ps-d4']);
      expect(document.activeElement).toBe(labels.tag('ps-d4'));
    });

    it('takes the focus along when the focused tag leaves the view', () => {
      const { labels, calls } = layer();
      labels.sync(checkoutFloor());
      zoomed(labels, 1);
      labels.tag('sw-b2')!.focus();
      expect(stops(labels)).toEqual(['sw-b2']);
      zoomed(labels, 3);
      expect(stops(labels)).toEqual(['oa-c3']);
      expect(document.activeElement).toBe(labels.tag('oa-c3'));
      expect(calls).toEqual([]);
    });

    it('hands the focus back when the focused tag leaves and no tag is left on the view', () => {
      const { labels, calls } = layer();
      labels.sync(checkoutFloor());
      zoomed(labels, 1);
      labels.tag('sw-b2')!.focus();
      away(labels);
      expect(calls).toEqual(['lostFocus']);
      expect(stops(labels)).toEqual(['sw-b2']);
    });

    it('stays put when no tag is left on the view and none had the focus', () => {
      const { labels, calls } = layer();
      labels.sync(checkoutFloor());
      zoomed(labels, 1);
      labels.setSelected(deskTarget('ps-d4'));
      away(labels);
      expect(calls).toEqual([]);
      expect(stops(labels)).toEqual(['ps-d4']);
    });
  });

  it('keeps labels hidden until placed, then hangs each from its anchor', () => {
    const { labels } = layer();
    const floor = checkoutFloor();
    labels.sync(floor);
    const tag = labels.tag('oa-c3')!;
    expect(tag.style.visibility).toBe('hidden');
    const camera = isoCamera(floor.size);
    labels.position(camera, 800, 500);
    const { desk, occupant } = seatOf(floor, 'oa-c3');
    const p = projectToScreen(labelAnchor(floor, desk, occupant), camera, 800, 500);
    expect(tag.style.visibility).toBe('');
    expect(tag.style.transform).toBe(`translate(${p.x}px, ${p.y}px) translate(-50%, -100%)`);
    camera.position.x += 1000;
    camera.updateMatrixWorld();
    labels.position(camera, 800, 500);
    expect(tag.style.visibility).toBe('hidden');
  });

  it('hangs a session\'s tag over its robot wherever it is: on its lounge seat, at the head of its room', () => {
    const { labels } = layer();
    const checkouts = checkoutSpecs();
    checkouts[0]!.desks[2] = { ...checkouts[0]!.desks[2]!, lounge: 2 };
    const floor = makeFloor(checkouts, undefined, checkoutRooms());
    labels.sync(floor);
    const camera = isoCamera(floor.size);
    labels.position(camera, 800, 500);
    for (const [id, spot] of [['sw-c3', loungeSpots(floor.lounge.rect)[2]!], ['ps-d4', headSpot(floor.roomSlots[0]!)]] as const) {
      const p = projectToScreen({ x: spot.x, y: LABEL_Y.seated, z: spot.z }, camera, 800, 500);
      expect(labels.tag(id)!.style.transform, id).toBe(`translate(${p.x}px, ${p.y}px) translate(-50%, -100%)`);
    }
  });

  it("moves a session's tag to the point it is given, there at the next placing, until the floor puts it back", () => {
    const { labels } = layer();
    const floor = checkoutFloor();
    labels.sync(floor);
    const camera = isoCamera(floor.size);
    const at = (id: string) => labels.tag(id)!.style.transform;
    const shown = (p: { x: number; y: number; z: number }) => {
      const s = projectToScreen(p, camera, 800, 500);
      return `translate(${s.x}px, ${s.y}px) translate(-50%, -100%)`;
    };
    labels.position(camera, 800, 500);
    const { desk, occupant } = seatOf(floor, 'oa-c3');
    const home = at('oa-c3');
    const other = at('sw-a1');
    const walking = { x: 9, y: LABEL_Y.standing, z: 5 };
    labels.moveTag('oa-c3', walking);
    labels.moveTag('nobody', walking);
    expect(at('oa-c3')).toBe(home);
    labels.position(camera, 800, 500);
    expect([at('oa-c3'), at('sw-a1')]).toEqual([shown(walking), other]);
    labels.sync(floor);
    labels.position(camera, 800, 500);
    expect(at('oa-c3')).toBe(shown(labelAnchor(floor, desk, occupant)));
  });

  it('shows only the dots while a metre takes few pixels on screen, and keeps the names as text', () => {
    const { root, labels } = layer();
    labels.sync(checkoutFloor());
    expect(root.classList.contains('fv-compact')).toBe(false);
    labels.setScale(COMPACT_PX - 1);
    expect(root.classList.contains('fv-compact')).toBe(true);
    expect(labels.tag('sw-a1')!.querySelector('.fv-name')!.textContent).toBe('sw-a1');
    labels.setScale(COMPACT_PX);
    expect(root.classList.contains('fv-compact')).toBe(false);
    labels.setScale(10);
    labels.dispose();
    expect(root.classList.contains('fv-compact')).toBe(false);
  });

  it('keeps the dot of a desk that needs you from pulsing while motion is off, until it is on again or the layer goes', () => {
    const { root, labels } = layer();
    labels.sync(checkoutFloor());
    expect(labels.tag('oa-c3')!.classList.contains('fv-badge-needs')).toBe(true);
    expect(rule('.fv-badge-needs .fv-dot')).toContain('animation: fv-pulse 1.2s ease-in-out infinite;');
    expect(rule('.fv-still .fv-badge-needs .fv-dot')).toContain('animation: none;');
    expect(root.classList.contains('fv-still')).toBe(false);
    labels.setMotion(false);
    expect(root.classList.contains('fv-still')).toBe(true);
    labels.setMotion(true);
    expect(root.classList.contains('fv-still')).toBe(false);
    labels.setMotion(false);
    labels.dispose();
    expect(root.classList.contains('fv-still')).toBe(false);
  });

  it('styles compact tags so that hidden text still names them, keeps the names of desks that need you or are done, and lets drags on a tag reach the camera', () => {
    expect(rule('.fv-tag')).toContain('touch-action: none;');
    expect(rule('.fv-tag')).toContain('user-select: none;');
    const hidden = rule(
      '.fv-compact .fv-tag:not(:hover):not(:focus-visible):not(.fv-sel) > :not(.fv-dot):not(.fv-name):not(.agent-badge),\n' +
        '.fv-compact .fv-tag:not(:hover):not(:focus-visible):not(.fv-sel):not(.fv-st-needs_you):not(.fv-st-done):not(.fv-room) > .fv-name',
    );
    expect(hidden).toContain('clip-path: inset(50%);');
    expect(hidden).not.toContain('display');
    expect(rule('.fv-compact .fv-tag:not(:hover):not(:focus-visible):not(.fv-sel):not(.fv-st-needs_you):not(.fv-st-done):not(.fv-room)')).toContain('padding: 3px;');
    expect(rule('.fv-tag:hover,\n.fv-tag:focus-visible,\n.fv-tag.fv-sel')).toContain('z-index: 1;');
  });

  it('cuts a long name short with an ellipsis, and keeps it whole in the tooltip', () => {
    expect(rule('.fv-name')).toContain('max-width: 18ch;');
    expect(rule('.fv-name')).toContain('overflow: hidden;');
    expect(rule('.fv-name')).toContain('text-overflow: ellipsis;');
    const long = 'n'.repeat(200);
    expect(tagTitle({ ...seatsOf(checkoutFloor())[0]!.occupant, name: long }).startsWith(long + ' · ')).toBe(true);
  });

  it('removes its labels on dispose', () => {
    const { root, labels } = layer();
    labels.sync(checkoutFloor());
    labels.dispose();
    expect(root.children).toHaveLength(0);
    expect(root.classList.contains('fv-labels')).toBe(false);
  });

  it('describes a session for its tooltip', () => {
    expect(tagTitle(seatsOf(checkoutFloor())[0]!.occupant)).toBe('sw-a1 · working · 1 agent running');
  });
});

describe('room labels', () => {
  const FIRST = 'wf_0000aaaa-001';
  const SECOND = 'wf_0000aaaa-002';
  const parts = (el: Element) => [...el.children].map((c) => [c.className, c.textContent]);

  it('shows a tag per room: its name, its current phase and its counts, as a button that names the run', () => {
    const { root, labels } = layer();
    labels.sync(roomFloor());
    expect(root.querySelectorAll('.fv-room')).toHaveLength(2);
    const tag = labels.roomTag(FIRST)!;
    expect(tag.tagName).toBe('BUTTON');
    expect(tag.dataset.run).toBe(FIRST);
    expect([...tag.classList]).toEqual(['fv-tag', 'fv-room']);
    expect(parts(tag)).toEqual([
      ['fv-dot', ''],
      ['fv-name', 'checkout-verify'],
      ['fv-phase', 'Build'],
      ['fv-counts', '3 running · 2 done'],
    ]);
    expect(tag.title).toBe('checkout-verify · Build · 3 running · 2 done · Verify split payments end to end');
    // The second run has no phases and no summary yet.
    expect(parts(labels.roomTag(SECOND)!)).toEqual([
      ['fv-dot', ''],
      ['fv-name', 'docs-sweep'],
      ['fv-counts', '10 running · 0 done'],
    ]);
    expect(labels.roomTag(SECOND)!.title).toBe('docs-sweep · 10 running · 0 done');
  });

  it('names a room without a name by its run id', () => {
    const { labels } = layer();
    const rooms = checkoutRooms();
    rooms[1] = { ...rooms[1]!, name: null };
    labels.sync(roomFloor(rooms));
    expect(labels.roomTag(SECOND)!.querySelector('.fv-name')!.textContent).toBe(SECOND);
    expect(roomTitle(roomFloor(rooms).rooms[1]!)).toBe(`${SECOND} · 10 running · 0 done`);
  });

  it('lists the phases on the whiteboard, each with its mark and, for screen readers, its word, and then the counts', () => {
    const { labels } = layer();
    labels.sync(roomFloor());
    const board = labels.board(FIRST)!;
    expect(board.tagName).toBe('DIV');
    expect(board.className).toBe('fv-board');
    expect(board.dataset.run).toBe(FIRST);
    const items = [...board.querySelectorAll('ol > li')];
    expect(items.map((li) => [li.className, li.textContent])).toEqual([
      ['fv-ph-done', '\u2713Plan (done)'],
      ['fv-ph-current', '\u25CFBuild (current)'],
      ['fv-ph-upcoming', '\u25CBReview (upcoming)'],
      ['fv-ph-upcoming', '\u25CBShip (upcoming)'],
    ]);
    const mark = items[0]!.querySelector('.fv-mark')!;
    expect(mark.getAttribute('aria-hidden')).toBe('true');
    expect(items[0]!.querySelector('.fv-sr')!.textContent).toBe(' (done)');
    expect(board.querySelector('p')!.textContent).toBe('3 running · 2 done');
    // A run whose phases are unknown shows its counts only.
    const other = labels.board(SECOND)!;
    expect(other.querySelector('ol')).toBeNull();
    expect(other.textContent).toBe('10 running · 0 done');
  });

  it('writes run names, summaries and phases as text, never as markup', () => {
    const { root, labels } = layer();
    const floor = roomFloor();
    floor.rooms[0] = { ...floor.rooms[0]!, name: HOSTILE, summary: HOSTILE, phases: [{ title: HOSTILE, state: 'current' }] };
    labels.sync(floor);
    expect([...root.querySelectorAll('img')].filter(img => !img.closest('.agent-badge'))).toHaveLength(0);
    const tag = labels.roomTag(FIRST)!;
    expect(tag.querySelector('.fv-name')!.textContent).toBe(HOSTILE);
    expect(tag.querySelector('.fv-phase')!.textContent).toBe(HOSTILE);
    expect(tag.title).toBe(`${HOSTILE} · ${HOSTILE} · 3 running · 2 done · ${HOSTILE}`);
    expect(labels.board(FIRST)!.querySelector('li')!.textContent).toBe(`\u25CF${HOSTILE} (current)`);
  });

  it('updates a room in place and removes the labels of a room that closes', () => {
    const { root, labels } = layer();
    labels.sync(roomFloor());
    const tag = labels.roomTag(FIRST)!;
    const board = labels.board(FIRST)!;
    const rooms = checkoutRooms();
    rooms[0] = { ...rooms[0]!, running: 1, finished: 4 };
    labels.sync(roomFloor(rooms));
    expect(labels.roomTag(FIRST)).toBe(tag);
    expect(labels.board(FIRST)).toBe(board);
    expect(tag.querySelector('.fv-counts')!.textContent).toBe('1 running · 4 done');
    labels.sync(roomFloor(rooms.slice(1)));
    expect(labels.roomTag(FIRST)).toBeUndefined();
    expect(labels.board(FIRST)).toBeUndefined();
    expect(tag.isConnected || board.isConnected).toBe(false);
    labels.sync(checkoutFloor());
    expect(root.querySelectorAll('.fv-room, .fv-board')).toHaveLength(0);
  });

  it('selects a room on click and activates it on double-click, and on Enter once it is selected', () => {
    const { calls, labels } = layer();
    labels.sync(roomFloor());
    const tag = labels.roomTag(FIRST)!;
    tag.click();
    tag.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const enter = () => new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    tag.dispatchEvent(enter());
    labels.setSelected(roomTarget(FIRST));
    const e = enter();
    tag.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(calls).toEqual([`select room ${FIRST}`, `activate room ${FIRST}`, `activate room ${FIRST}`]);
  });

  it("marks the tag of the selected run's first room, the one the floor outlines, and no desk", () => {
    const { root, labels } = layer();
    const rooms = checkoutRooms();
    rooms.push({ ...rooms[0]!, host: 'oa-c3', seated: false });
    labels.sync(roomFloor(rooms));
    labels.setSelected(deskTarget('oa-c3'));
    labels.setSelected(roomTarget(FIRST));
    const marked = [...root.querySelectorAll('.fv-sel')] as HTMLElement[];
    expect(marked).toEqual([root.querySelectorAll(`.fv-room[data-run="${FIRST}"]`)[0]]);
    expect(marked[0]!.getAttribute('aria-current')).toBe('true');
    // A floor update marks it alike.
    labels.sync(roomFloor(rooms));
    expect(root.querySelectorAll('.fv-sel')).toHaveLength(1);
    expect(labels.tag('oa-c3')!.hasAttribute('aria-current')).toBe(false);
    labels.setSelected(roomTarget('wf_gone'));
    expect(root.querySelectorAll('.fv-sel')).toHaveLength(0);
  });

  it('puts the room tags in the tab order after the desk tags', () => {
    const { labels } = layer();
    const floor = roomFloor();
    labels.sync(floor);
    labels.position(isoCamera(floor.size), 1600, 1000);
    const focused = () => document.activeElement as HTMLElement;
    const press = (key: string) => focused().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    labels.tag('ps-d4')!.focus();
    press('ArrowRight');
    expect(focused().dataset.run).toBe(FIRST);
    expect(labels.roomTag(FIRST)!.tabIndex).toBe(0);
    expect(labels.tag('ps-d4')!.tabIndex).toBe(-1);
    press('End');
    expect(focused().dataset.run).toBe(SECOND);
    press('Home');
    expect(focused().dataset.session).toBe('sw-a1');
    // A room selected from the view takes the tab stop.
    labels.setSelected(roomTarget(SECOND));
    expect(labels.roomTag(SECOND)!.tabIndex).toBe(0);
  });

  it('hangs each room tag over its door and each board from the top of its whiteboard', () => {
    const { labels } = layer();
    const floor = roomFloor();
    labels.sync(floor);
    const camera = isoCamera(floor.size);
    labels.position(camera, 1600, 1000);
    const room = floor.rooms[0]!;
    const tag = projectToScreen(roomTagAnchor(room.rect), camera, 1600, 1000);
    const board = projectToScreen(boardAnchor(room.rect), camera, 1600, 1000);
    expect(labels.roomTag(FIRST)!.style.transform).toBe(`translate(${tag.x}px, ${tag.y}px) translate(-50%, -100%)`);
    expect(labels.board(FIRST)!.style.transform).toBe(`translate(${board.x}px, ${board.y}px) translate(-50%, -100%)`);
    expect(labels.board(FIRST)!.style.visibility).toBe('');
  });

  it('keeps only the run names at low zoom: room tags keep their name, and the boards go, letting clicks through', () => {
    const name = rule(
      '.fv-compact .fv-tag:not(:hover):not(:focus-visible):not(.fv-sel) > :not(.fv-dot):not(.fv-name):not(.agent-badge),\n' +
        '.fv-compact .fv-tag:not(:hover):not(:focus-visible):not(.fv-sel):not(.fv-st-needs_you):not(.fv-st-done):not(.fv-room) > .fv-name',
    );
    expect(name).toContain('clip-path: inset(50%);');
    expect(rule('.fv-compact .fv-board')).toContain('display: none;');
    expect(rule('.fv-board')).toContain('pointer-events: none;');
    expect(rule('.fv-sr')).toContain('clip-path: inset(50%);');
  });
});

describe('which tags show', () => {
  afterEach(() => vi.restoreAllMocks());

  /** Every label element takes this many CSS pixels on the page, as happy-dom lays nothing out. */
  function sized(w: number, h: number) {
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(w);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(h);
    return width;
  }

  /** The tags and placards shown, in page order: a desk's tag by its session, a room's as 'room <run id>', a placard by its repository. */
  function shown(root: HTMLElement): string[] {
    return [...root.querySelectorAll<HTMLElement>('.fv-tag, .fv-sign')]
      .filter((el) => el.style.visibility === '')
      .map((el) => el.dataset.session ?? (el.dataset.run ? `room ${el.dataset.run}` : `placard ${el.firstChild!.textContent}`));
  }

  /** The checkout floor with these sessions in other states. */
  function floorWith(states: Record<string, ShownState>, rooms = checkoutRooms()) {
    const checkouts: CheckoutSpec[] = checkoutSpecs();
    for (const c of checkouts) for (const d of c.desks) d.state = states[d.id] ?? d.state;
    return makeFloor(checkouts, undefined, rooms);
  }

  const FIRST = 'wf_0000aaaa-001';

  it('ranks the selected tag first, then a desk that needs you, one that is done, a room, a working desk, the other states, and placards last', () => {
    const desk = (state: ShownState) => ({ kind: 'desk' as const, state });
    expect([
      tagRank(desk('working'), true),
      tagRank(desk('needs_you'), false),
      tagRank(desk('done'), false),
      tagRank({ kind: 'room' }, false),
      tagRank(desk('working'), false),
      tagRank(desk('in_meeting'), false),
      tagRank(desk('no_signal'), false),
      tagRank(desk('idle'), false),
      tagRank({ kind: 'placard' }, false),
    ]).toEqual([RANK.selected, RANK.needs_you, RANK.done, RANK.room, RANK.working, RANK.other, RANK.other, RANK.other, RANK.placard]);
    expect(Object.values(RANK)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('hides the lower ranked of two overlapping boxes, and of two that rank alike the later', () => {
    const box = (x: number, rank: number): LabelBox => ({ x, y: 0, w: 60, h: 20, rank });
    expect(declutter([box(0, RANK.working), box(30, RANK.needs_you)])).toEqual([false, true]);
    expect(declutter([box(0, RANK.working), box(30, RANK.working)])).toEqual([true, false]);
    expect(declutter([box(30, RANK.placard), box(0, RANK.other)])).toEqual([false, true]);
    expect(declutter([])).toEqual([]);
  });

  it('lets a box that hides hide nothing: of three in a row, each overlapping the next, the first and the third show', () => {
    const row = [0, 50, 100].map((x): LabelBox => ({ x, y: 0, w: 60, h: 20, rank: RANK.working }));
    expect(declutter(row)).toEqual([true, false, true]);
    // The middle one ranking first hides both of its neighbours.
    expect(declutter([row[0]!, { ...row[1]!, rank: RANK.done }, row[2]!])).toEqual([false, true, false]);
  });

  it('shows boxes that only touch, and empty ones', () => {
    expect(declutter([{ x: 0, y: 0, w: 60, h: 20, rank: RANK.working }, { x: 60, y: 0, w: 60, h: 20, rank: RANK.working }, { x: 0, y: 20, w: 60, h: 20, rank: RANK.working }])).toEqual([true, true, true]);
    expect(declutter([{ x: 0, y: 0, w: 60, h: 20, rank: RANK.working }, { x: 10, y: 5, w: 0, h: 0, rank: RANK.working }, { x: 10, y: 5, w: 30, h: 0, rank: RANK.working }])).toEqual([true, true, true]);
  });

  it('gives no tag to a free desk, takes a session\'s tag away while it is dormant and gives it back when it wakes', () => {
    const { root, labels } = layer();
    labels.sync(checkoutFloor());
    expect(seatsOf(checkoutFloor()).filter((s) => labels.tag(s.occupant.sessionId)).map((s) => s.occupant.sessionId)).toEqual(['sw-a1', 'sw-b2', 'sw-c3', 'oa-c3', 'oa-d5', 'ps-d4']);
    // Each pod has free desks: 3, 2 and 2 of their 4 are taken.
    expect(root.querySelectorAll('.fv-tag')).toHaveLength(6);
    const tag = labels.tag('sw-a1')!;
    labels.sync(floorWith({ 'sw-a1': 'dormant' }, []));
    expect(labels.tag('sw-a1')).toBeUndefined();
    expect(tag.isConnected).toBe(false);
    labels.sync(floorWith({ 'ps-f7': 'working' }, []));
    expect([labels.tag('sw-a1')?.dataset.session, labels.tag('ps-f7')?.dataset.session]).toEqual(['sw-a1', 'ps-f7']);
    // No style is left for a dormant session's tag.
    expect(css).not.toContain('.fv-st-dormant');
  });

  it('shows every tag from far, the placards not, and all of them closer in', () => {
    const { root, labels } = layer();
    const floor = roomFloor();
    const camera = isoCamera(floor.size);
    labels.sync(floor);
    labels.position(camera, 1600, 1000);
    const all = shown(root);
    expect(all).toHaveLength(6 + 2 + 3);
    labels.setScale(COMPACT_PX - 1);
    labels.position(camera, 1600, 1000);
    // Each desk's tag as its dot, or its dot and its name (labels.css), and each room's tag.
    expect(shown(root)).toEqual(['sw-a1', 'sw-b2', 'sw-c3', 'oa-c3', 'oa-d5', 'ps-d4', `room ${FIRST}`, 'room wf_0000aaaa-002']);
    // The boards go too, by their style (labels.css), but stay in place.
    expect(labels.board(FIRST)!.style.visibility).toBe('');
    labels.setScale(COMPACT_PX);
    labels.position(camera, 1600, 1000);
    expect(shown(root)).toEqual(all);
  });

  it('shows, of tags and placards that all overlap, only the one that ranks first, the earliest in floor order of those that rank alike', () => {
    sized(5000, 5000);
    const { root, labels } = layer();
    const camera = isoCamera(roomFloor().size);
    const show = (floor = roomFloor()) => {
      labels.sync(floor);
      labels.position(camera, 1600, 1000);
      return shown(root);
    };
    expect(show()).toEqual(['oa-c3']);
    labels.setSelected(deskTarget('oa-d5'));
    expect(show()).toEqual(['oa-d5']);
    labels.setSelected(null);
    expect(show(floorWith({ 'oa-c3': 'working' }))).toEqual(['sw-b2']);
    expect(show(floorWith({ 'oa-c3': 'working', 'sw-b2': 'working' }))).toEqual([`room ${FIRST}`]);
    expect(show(floorWith({ 'oa-c3': 'working', 'sw-b2': 'working' }, []))).toEqual(['sw-a1']);
    expect(show(floorWith({ 'sw-a1': 'idle', 'oa-c3': 'no_signal', 'sw-b2': 'in_meeting' }, []))).toEqual(['sw-a1']);
    const asleep = Object.fromEntries(seatsOf(checkoutFloor()).map((s): [string, ShownState] => [s.occupant.sessionId, 'dormant']));
    expect(show(floorWith(asleep, []))).toEqual(['placard storefront-web']);
    // The rooms' boards take no part: each shows over its whiteboard.
    show();
    expect([labels.board(FIRST)!.style.visibility, labels.board('wf_0000aaaa-002')!.style.visibility]).toEqual(['', '']);
  });

  /** A camera looking down at the floor's north-west corner, where nothing stands: tags moved there are alone on the view. */
  function corner(): OrthographicCamera {
    const camera = new OrthographicCamera(-5, 5, 5, -5, 0.1, 100);
    camera.position.set(-20, 10, -20);
    camera.up.set(0, 0, -1);
    camera.lookAt(-20, 0, -20);
    camera.updateMatrixWorld();
    return camera;
  }

  it('hides a tag under one that ranks higher where they overlap, shows the selected one over any, and both once they part', () => {
    sized(80, 20);
    const { root, labels } = layer();
    labels.sync(checkoutFloor());
    const camera = corner();
    // 80 px to the metre across: sw-a1 (working) and oa-c3 (needs you) at one point; sw-b2 (done) a metre east, touching.
    labels.moveTag('sw-a1', { x: -20, y: 1, z: -20 });
    labels.moveTag('oa-c3', { x: -20, y: 1, z: -20 });
    labels.moveTag('sw-b2', { x: -19, y: 1, z: -20 });
    labels.position(camera, 800, 400);
    expect(shown(root)).toEqual(['sw-b2', 'oa-c3']);
    labels.setSelected(deskTarget('sw-a1'));
    labels.position(camera, 800, 400);
    expect(shown(root)).toEqual(['sw-a1', 'sw-b2']);
    labels.setSelected(null);
    // Hidden, it still follows its anchor on the view: it shows in its place as soon as it is kept again.
    const hidden = labels.tag('sw-a1')!;
    labels.moveTag('sw-a1', { x: -20.5, y: 1, z: -20 });
    labels.position(camera, 800, 400);
    expect([hidden.style.visibility, hidden.style.transform]).toEqual(['hidden', 'translate(360px, 200px) translate(-50%, -100%)']);
    labels.moveTag('sw-a1', { x: -21, y: 1, z: -20 });
    labels.position(camera, 800, 400);
    expect(shown(root)).toEqual(['sw-a1', 'sw-b2', 'oa-c3']);
    expect(hidden.style.transform).toBe('translate(320px, 200px) translate(-50%, -100%)');
  });

  it('hides the lower ranked of two overlapping tags from far too, on the boxes the tags have there', () => {
    // A tag takes 80 px close up, and a dot's 14 px from far.
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.closest('.fv-compact') ? 14 : 80;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(20);
    const { root, labels } = layer();
    labels.sync(checkoutFloor());
    const camera = corner();
    // sw-a1 (working) and oa-c3 (needs you) at one point; sw-b2 (done) half a metre east, 40 px.
    labels.moveTag('sw-a1', { x: -20, y: 1, z: -20 });
    labels.moveTag('oa-c3', { x: -20, y: 1, z: -20 });
    labels.moveTag('sw-b2', { x: -19.5, y: 1, z: -20 });
    labels.position(camera, 800, 400);
    expect(shown(root)).toEqual(['oa-c3']);
    labels.setScale(COMPACT_PX - 1);
    labels.position(camera, 800, 400);
    expect(shown(root)).toEqual(['sw-b2', 'oa-c3']);
  });

  it('works out which tags show again only when a label moved, came or went, or the selection or the zoom changed', () => {
    const width = sized(80, 20);
    const { root, labels } = layer();
    labels.sync(checkoutFloor());
    const camera = corner();
    labels.moveTag('sw-a1', { x: -20, y: 1, z: -20 });
    labels.moveTag('oa-c3', { x: -20, y: 1, z: -20 });
    labels.position(camera, 800, 400);
    expect(shown(root)).toEqual(['oa-c3']);
    width.mockClear();
    labels.position(camera, 800, 400);
    expect(width).not.toHaveBeenCalled();
    // Narrower now, the two would no longer overlap; but nothing moved, so the tag stays hidden.
    width.mockReturnValue(1);
    labels.position(camera, 800, 400);
    expect(shown(root)).toEqual(['oa-c3']);
    labels.moveTag('sw-a1', { x: -19.99, y: 1, z: -20 });
    labels.position(camera, 800, 400);
    expect(width).toHaveBeenCalled();
    expect(shown(root)).toEqual(['sw-a1', 'oa-c3']);
    // Tags take other sizes from far: they are worked out again as the zoom crosses COMPACT_PX, either way.
    for (const scale of [COMPACT_PX - 1, COMPACT_PX]) {
      width.mockClear();
      labels.setScale(scale);
      labels.position(camera, 800, 400);
      expect(width).toHaveBeenCalled();
      expect(shown(root)).toEqual(['sw-a1', 'oa-c3']);
    }
    // Wider again, with nothing moved: a new selection has it worked out again.
    width.mockReturnValue(80);
    labels.setSelected(deskTarget('sw-a1'));
    labels.position(camera, 800, 400);
    expect(shown(root)).toEqual(['sw-a1']);
    // So does a floor update, which hangs the tags over their desks again, away from this corner.
    labels.sync(checkoutFloor());
    labels.position(camera, 800, 400);
    expect(shown(root)).toEqual([]);
  });

  it('shows nowhere the tag of a robot out of sight, the selected one too, hiding nothing under it, until it hangs from a point again', () => {
    sized(80, 20);
    const { root, labels } = layer();
    labels.sync(checkoutFloor());
    const camera = corner();
    labels.setSelected(deskTarget('sw-a1'));
    labels.moveTag('sw-a1', { x: -20, y: 1, z: -20 });
    labels.moveTag('oa-c3', { x: -20, y: 1, z: -20 });
    labels.position(camera, 800, 400);
    expect(shown(root)).toEqual(['sw-a1']);
    // sw-a1's robot waits unseen inside the elevator: its tag goes, out of the tab order, and oa-c3 shows.
    labels.moveTag('sw-a1', null);
    labels.position(camera, 800, 400);
    expect(shown(root)).toEqual(['oa-c3']);
    expect([labels.tag('sw-a1')!.style.visibility, labels.tag('sw-a1')!.tabIndex]).toEqual(['hidden', -1]);
    labels.moveTag('sw-a1', { x: -20, y: 1, z: -20 });
    labels.position(camera, 800, 400);
    expect(shown(root)).toEqual(['sw-a1']);
  });

  /** Each tag's size as drawn: named tags `named` px wide, the others and a named tag drawn as its dot DOT_PX; a grown tag `grown` wide. */
  function drawn(sizes: { named: number; grown: number; isGrown: (el: HTMLElement) => boolean }) {
    const isNamed = (el: HTMLElement) => el.matches('.fv-st-needs_you, .fv-st-done, .fv-room, .fv-sel') && !el.classList.contains('fv-dot-only');
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return sizes.isGrown(this) ? sizes.grown : isNamed(this) ? sizes.named : this.classList.contains('fv-desk') ? AGENT_TAG.w : DOT_PX;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('fv-desk') ? AGENT_TAG.h : isNamed(this) || sizes.isGrown(this) ? 20 : DOT_PX;
    });
  }
  /** Moves the in-meeting ps-d4 somewhere else in the corner and places the labels: a frame in which a label moved. */
  let nudge = 0;
  function frameWithAMove(labels: LabelLayer, camera: OrthographicCamera) {
    labels.moveTag('ps-d4', { x: -23 + (nudge++ % 2) * 0.1, y: 1, z: -22 });
    labels.position(camera, 800, 400);
  }

  it('keeps a focused tag shown and its focus where it is while other labels move, even where it would be culled, and lets it hide no one', () => {
    drawn({ named: 80, grown: 160, isGrown: (el) => el === document.activeElement });
    const { root, labels } = layer();
    labels.sync(floorWith({ 'sw-a1': 'needs_you', 'sw-b2': 'needs_you', 'sw-c3': 'needs_you' }, []));
    labels.setScale(COMPACT_PX - 1);
    const camera = corner();
    // Three tags that need you, a metre (80 px) apart, as wide as that: they touch, and all show.
    for (const [id, x] of [['sw-a1', -21], ['sw-b2', -20], ['sw-c3', -19]] as const) labels.moveTag(id, { x, y: 1, z: -20 });
    frameWithAMove(labels, camera);
    expect(shown(root)).toEqual(['sw-a1', 'sw-b2', 'sw-c3', 'ps-d4']);
    // Focused, the last grows to 160 px over the middle one, which ranks alike and comes first.
    const last = labels.tag('sw-c3')!;
    last.focus();
    for (let k = 0; k < 3; k++) {
      frameWithAMove(labels, camera);
      expect(document.activeElement, `frame ${k}`).toBe(last);
      expect(shown(root), `frame ${k}`).toEqual(['sw-a1', 'sw-b2', 'sw-c3', 'ps-d4']);
    }
    // The selected tag shows too, under the focused one.
    labels.setSelected(deskTarget('sw-b2'));
    frameWithAMove(labels, camera);
    expect([document.activeElement === last, shown(root)]).toEqual([true, ['sw-a1', 'sw-b2', 'sw-c3', 'ps-d4']]);
  });

  it('keeps the tag that the arrow keys give the focus to shown, where the tag losing the focus would hide it', () => {
    drawn({ named: 80, grown: 80, isGrown: () => false });
    // As in a browser, the tag losing the focus is told first, and a hidden element takes no focus.
    const focus = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement) {
      const had = document.activeElement;
      if (had instanceof HTMLElement && had !== this) had.blur();
      if (this.style.visibility !== 'hidden') focus.call(this);
    });
    const { root, labels } = layer();
    labels.sync(floorWith({ 'sw-a1': 'needs_you', 'sw-b2': 'needs_you' }, []));
    const camera = corner();
    // Half a metre (40 px) apart and 80 px wide: at rest, sw-b2 hides under sw-a1, which ranks alike and comes first.
    labels.moveTag('sw-a1', { x: -20, y: 1, z: -20 });
    labels.moveTag('sw-b2', { x: -19.5, y: 1, z: -20 });
    frameWithAMove(labels, camera);
    expect(shown(root)).toEqual(['sw-a1', 'ps-d4']);
    // Focused, sw-a1 hides no one: sw-b2 shows. The right arrow gives sw-b2 the focus, and both still show.
    labels.tag('sw-a1')!.focus();
    expect(shown(root)).toEqual(['sw-a1', 'sw-b2', 'ps-d4']);
    labels.tag('sw-a1')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    expect([(document.activeElement as HTMLElement).dataset.session, shown(root)]).toEqual(['sw-b2', ['sw-a1', 'sw-b2', 'ps-d4']]);
  });

  it('keeps a hovered tag shown while other labels move, hiding no one, and works out again as the pointer leaves it', () => {
    const hovered = new Set<HTMLElement>();
    drawn({ named: 80, grown: 160, isGrown: (el) => hovered.has(el) });
    const { root, labels } = layer();
    labels.sync(floorWith({ 'sw-a1': 'needs_you', 'sw-b2': 'needs_you' }, []));
    const camera = corner();
    labels.moveTag('sw-a1', { x: -21, y: 1, z: -20 });
    labels.moveTag('sw-b2', { x: -20, y: 1, z: -20 });
    frameWithAMove(labels, camera);
    expect(shown(root)).toEqual(['sw-a1', 'sw-b2', 'ps-d4']);
    const tag = labels.tag('sw-b2')!;
    hovered.add(tag);
    tag.dispatchEvent(new Event('pointerenter'));
    // Grown over sw-a1, which ranks alike and comes first, it still shows, frame after frame, and so does sw-a1.
    for (let k = 0; k < 3; k++) {
      frameWithAMove(labels, camera);
      expect(shown(root), `frame ${k}`).toEqual(['sw-a1', 'sw-b2', 'ps-d4']);
    }
    // Hovered, it moves half a metre closer: at rest it would be culled, but it shows until the pointer leaves it.
    labels.moveTag('sw-b2', { x: -20.5, y: 1, z: -20 });
    labels.position(camera, 800, 400);
    expect(shown(root)).toEqual(['sw-a1', 'sw-b2', 'ps-d4']);
    hovered.delete(tag);
    tag.dispatchEvent(new Event('pointerleave'));
    expect(shown(root)).toEqual(['sw-a1', 'ps-d4']);
  });

  it('shows, from far, a named tag that another covers as its dot where the dot is clear, and culls dots only under labels that show, the same frame after frame', () => {
    drawn({ named: 80, grown: 80, isGrown: () => false });
    const { root, labels } = layer();
    labels.sync(floorWith({ 'sw-a1': 'needs_you' }, []));
    labels.setScale(COMPACT_PX - 1);
    const camera = corner();
    // Their full names overlap, but compact identity badges at 65 px east and west are clear.
    // sw-c3 lies under the first name; oa-d5 at 115 px is clear of the compact badge.
    const at = (px: number) => ({ x: -20 + px / 80, y: 1, z: -20 });
    labels.moveTag('sw-a1', at(0));
    labels.moveTag('oa-c3', at(65));
    labels.moveTag('sw-b2', at(-65));
    labels.moveTag('sw-c3', at(10));
    labels.moveTag('oa-d5', at(115));
    for (let k = 0; k < 3; k++) {
      frameWithAMove(labels, camera);
      expect(shown(root), `frame ${k}`).toEqual(['sw-a1', 'sw-b2', 'oa-c3', 'oa-d5', 'ps-d4']);
      expect(['sw-a1', 'sw-b2', 'oa-c3'].map((id) => labels.tag(id)!.classList.contains('fv-dot-only')), `frame ${k}`).toEqual([false, true, true]);
    }
    // Closer in, nothing falls back to its dot: the tag that ranks lower hides.
    labels.setScale(COMPACT_PX);
    frameWithAMove(labels, camera);
    expect(root.querySelectorAll('.fv-dot-only')).toHaveLength(0);
    expect(shown(root)).not.toContain('oa-c3');
    // As drawn from far, a tag shown as its dot is a dot alone: dot, padding and border make DOT_PX.
    const dotOnly = css.slice(css.indexOf('\n.fv-compact .fv-tag.fv-dot-only:not(:hover):not(:focus-visible) {'));
    expect(dotOnly).toMatch(/^\n\.fv-compact \.fv-tag\.fv-dot-only:not\(:hover\):not\(:focus-visible\) \{\n {2}gap: 0;\n {2}padding: 3px;\n\}/);
    expect(css).toContain('\n.fv-compact .fv-tag.fv-dot-only:not(:hover):not(:focus-visible) > :not(.fv-dot):not(.agent-badge) {\n  position: absolute;');
    expect([rule('.fv-dot'), rule('.fv-tag')]).toEqual([expect.stringContaining('width: 7px;'), expect.stringContaining('border: 1px solid')]);
    expect(DOT_PX).toBe(7 + 2 * 3 + 2 * 1);
    expect(AGENT_TAG).toEqual({ w: 24 + 5 + 7 + 2 * 3 + 2, h: 24 + 2 * 3 + 2 });
  });

  it('takes a hidden tag out of the tab order and the arrow keys, as one off the view', () => {
    sized(80, 20);
    const { labels } = layer();
    labels.sync(checkoutFloor());
    const camera = corner();
    labels.moveTag('sw-a1', { x: -20, y: 1, z: -20 });
    labels.moveTag('sw-b2', { x: -20, y: 1, z: -20 });
    labels.moveTag('oa-c3', { x: -18, y: 1, z: -20 });
    labels.position(camera, 800, 400);
    // sw-a1, first in floor order, held the tab stop: hidden under sw-b2 (done), it hands it on to sw-b2.
    expect([labels.tag('sw-a1')!.style.visibility, labels.tag('sw-a1')!.tabIndex, labels.tag('sw-b2')!.tabIndex]).toEqual(['hidden', -1, 0]);
    labels.tag('oa-c3')!.focus();
    const press = (key: string) => (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    // Home passes the hidden sw-a1 by.
    press('Home');
    expect((document.activeElement as HTMLElement).dataset.session).toBe('sw-b2');
    // Focused, sw-b2 hides no one: sw-a1 shows under it. The next tag after it is oa-c3.
    expect(labels.tag('sw-a1')!.style.visibility).toBe('');
    press('ArrowRight');
    expect((document.activeElement as HTMLElement).dataset.session).toBe('oa-c3');
  });
});
