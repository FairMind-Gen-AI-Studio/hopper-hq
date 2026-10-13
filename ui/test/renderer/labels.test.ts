import { afterEach, describe, expect, it } from 'vitest';
import { OrthographicCamera } from 'three';
import type { Target } from '../../renderer/index';
import { COMPACT_PX, LabelLayer, projectToScreen, roomTitle, tagTitle, type LabelEvents } from '../../renderer/labels';
import css from '../../renderer/labels.css?raw';
import { LABEL_Y, boardAnchor, headSpot, labelAnchor, loungeSpots, roomTagAnchor } from '../../renderer/world';
import { checkoutFloor, checkoutIslands, checkoutRooms, isoCamera, makeFloor, roomFloor, seatOf, seatsOf } from './fixtures';

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
  it('shows a tag per session at a desk with its state, name, note, agents and remote mark, and a placard per pod that has one', () => {
    const { root, labels } = layer();
    const islands = checkoutIslands();
    islands[2]!.desks[0]!.cloud = true;
    labels.sync(makeFloor(islands));
    expect(root.classList.contains('fv-labels')).toBe(true);
    expect(root.querySelectorAll('.fv-tag')).toHaveLength(7);
    expect(root.querySelectorAll('.fv-sign')).toHaveLength(3);
    const needs = labels.tag('oa-c3')!;
    expect(needs.tagName).toBe('BUTTON');
    expect(needs.dataset.session).toBe('oa-c3');
    expect([...needs.classList]).toEqual(['fv-tag', 'fv-st-needs_you', 'fv-badge-needs']);
    expect([...needs.children].map((c) => [c.className, c.textContent])).toEqual([
      ['fv-dot', ''],
      ['fv-name', 'oa-c3'],
      ['fv-note', 'needs you'],
    ]);
    const meeting = labels.tag('ps-d4')!;
    expect([...meeting.children].map((c) => c.textContent)).toEqual(['', 'ps-d4', '+2', 'remote']);
    expect(meeting.title).toBe('ps-d4 · in meeting · 2 agents running · remote');
    expect([...labels.tag('ps-f7')!.classList]).toEqual(['fv-tag', 'fv-st-dormant']);
    const sign = labels.sign('p1')!;
    expect(sign.firstChild!.textContent).toBe('orders-api');
    expect(sign.querySelector('small')!.textContent).toBe('feat/checkout-v2 · worktree');
    expect(labels.sign('p2')!.textContent).toBe('payments-svcfeat/checkout-v2');
    expect(labels.sign('p3')).toBeUndefined();
    // Occupants that share only their repository: the placard names it alone.
    const shared = makeFloor(islands);
    shared.pods[1]!.placard = { repo: 'orders-api', branch: null, worktree: false, path: null };
    labels.sync(shared);
    expect([labels.sign('p1')!.textContent, labels.sign('p1')!.querySelector('small')]).toEqual(['orders-api', null]);
  });

  it('writes names, repos and branches as text, never as markup', () => {
    const { root, labels } = layer();
    const islands = checkoutIslands();
    islands[0]!.repo = HOSTILE;
    islands[0]!.branch = HOSTILE;
    islands[0]!.desks[0]!.name = HOSTILE;
    labels.sync(makeFloor(islands));
    expect(root.querySelector('img')).toBeNull();
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
    const islands = checkoutIslands();
    islands[0]!.desks = [{ id: 'sw-a1', state: 'needs_you' }, { id: 'sw-b2', state: 'done' }, { id: 'sw-x9', state: 'working' }];
    islands.pop();
    labels.sync(makeFloor(islands));
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
    const islands = checkoutIslands();
    islands[0]!.desks.push({ id: 'sw-x9', state: 'working' });
    labels.sync(makeFloor(islands));
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
    expect(ids.filter((id) => labels.tag(id)!.tabIndex === -1)).toHaveLength(6);
    labels.setSelected(deskTarget('oa-c3'));
    expect(stops()).toEqual(['oa-c3']);
    labels.tag('ps-d4')!.focus();
    expect(stops()).toEqual(['ps-d4']);
    // A floor update marks the same selection again: the tab stop stays where the focus left it.
    labels.sync(checkoutFloor());
    labels.setSelected(deskTarget('oa-c3'));
    expect(stops()).toEqual(['ps-d4']);
    // When its desk leaves, the stop goes to the selected desk's tag, or with none selected to the first.
    const islands = checkoutIslands();
    islands[2]!.desks.shift();
    labels.sync(makeFloor(islands));
    expect(stops()).toEqual(['oa-c3']);
    labels.setSelected(null);
    expect(stops()).toEqual(['oa-c3']);
    islands[1]!.desks.shift();
    labels.sync(makeFloor(islands));
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
    expect(focused()).toBe('ps-f7');
    expect(labels.tag('ps-f7')!.tabIndex).toBe(0);
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
      const shown = desks.filter((d) => labels.tag(d.sessionId)!.style.visibility === '').map((d) => d.sessionId);
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
    const islands = checkoutIslands();
    islands[0]!.desks[2] = { ...islands[0]!.desks[2]!, lounge: 2 };
    const floor = makeFloor(islands, undefined, checkoutRooms());
    labels.sync(floor);
    const camera = isoCamera(floor.size);
    labels.position(camera, 800, 500);
    for (const [id, spot] of [['sw-c3', loungeSpots(floor.lounge.rect)[2]!], ['ps-d4', headSpot(floor.roomSlots[0]!)]] as const) {
      const p = projectToScreen({ x: spot.x, y: LABEL_Y.seated, z: spot.z }, camera, 800, 500);
      expect(labels.tag(id)!.style.transform, id).toBe(`translate(${p.x}px, ${p.y}px) translate(-50%, -100%)`);
    }
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

  it('styles compact tags so that hidden text still names them, and lets drags on a tag reach the camera', () => {
    expect(rule('.fv-tag')).toContain('touch-action: none;');
    expect(rule('.fv-tag')).toContain('user-select: none;');
    const hidden = rule(
      '.fv-compact .fv-tag:not(:hover):not(:focus-visible):not(.fv-sel) > :not(.fv-dot):not(.fv-name),\n' +
        '.fv-compact .fv-tag:not(:hover):not(:focus-visible):not(.fv-sel):not(.fv-st-needs_you):not(.fv-room) > .fv-name',
    );
    expect(hidden).toContain('clip-path: inset(50%);');
    expect(hidden).not.toContain('display');
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
    expect(root.querySelector('img')).toBeNull();
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
    labels.tag('ps-f7')!.focus();
    press('ArrowRight');
    expect(focused().dataset.run).toBe(FIRST);
    expect(labels.roomTag(FIRST)!.tabIndex).toBe(0);
    expect(labels.tag('ps-f7')!.tabIndex).toBe(-1);
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
      '.fv-compact .fv-tag:not(:hover):not(:focus-visible):not(.fv-sel) > :not(.fv-dot):not(.fv-name),\n' +
        '.fv-compact .fv-tag:not(:hover):not(:focus-visible):not(.fv-sel):not(.fv-st-needs_you):not(.fv-room) > .fv-name',
    );
    expect(name).toContain('clip-path: inset(50%);');
    expect(rule('.fv-compact .fv-board')).toContain('display: none;');
    expect(rule('.fv-board')).toContain('pointer-events: none;');
    expect(rule('.fv-sr')).toContain('clip-path: inset(50%);');
  });
});
