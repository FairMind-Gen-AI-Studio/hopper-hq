import { afterEach, describe, expect, it } from 'vitest';
import { OrthographicCamera } from 'three';
import { COMPACT_PX, LabelLayer, projectToScreen, tagTitle, type LabelEvents } from '../../renderer/labels';
import css from '../../renderer/labels.css?raw';
import { labelAnchor } from '../../renderer/world';
import { checkoutFloor, checkoutIslands, desksOf, isoCamera, makeFloor } from './fixtures';

/** A camera looking straight down at a 10 m square around the origin. */
function topDown(): OrthographicCamera {
  const camera = new OrthographicCamera(-5, 5, 5, -5, 0.1, 100);
  camera.position.set(0, 10, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return camera;
}

function layer() {
  const root = document.body.appendChild(document.createElement('div'));
  const calls: string[] = [];
  const events: LabelEvents = {
    select: (id) => calls.push('select ' + id),
    activate: (id) => calls.push('activate ' + id),
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
  it('shows a tag per desk with its state, name, note, agents and remote mark, and a placard per island', () => {
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
    const sign = labels.sign('/demo/orders-api/.worktrees/checkout-v2')!;
    expect(sign.firstChild!.textContent).toBe('orders-api');
    expect(sign.querySelector('small')!.textContent).toBe('feat/checkout-v2 · worktree');
    expect(labels.sign('/demo/payments-svc')!.textContent).toBe('payments-svcfeat/checkout-v2');
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
    expect(labels.sign('/demo/storefront-web')!.firstChild!.textContent).toBe(HOSTILE);
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
    expect(labels.sign('/demo/payments-svc')).toBeUndefined();
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
    labels.setSelected('oa-c3');
    const second = enter();
    labels.tag('oa-c3')!.dispatchEvent(second);
    expect(calls).toEqual(['activate oa-c3']);
    expect(second.defaultPrevented).toBe(true);
  });

  it('marks the selected tag, also when it is created after the selection', () => {
    const { root, labels } = layer();
    labels.sync(checkoutFloor());
    labels.setSelected('sw-b2');
    labels.setSelected('oa-c3');
    expect([...root.querySelectorAll('.fv-sel')].map((e) => (e as HTMLElement).dataset.session)).toEqual(['oa-c3']);
    expect(labels.tag('oa-c3')!.getAttribute('aria-current')).toBe('true');
    expect(labels.tag('sw-b2')!.hasAttribute('aria-current')).toBe(false);
    labels.setSelected('sw-x9');
    const islands = checkoutIslands();
    islands[0]!.desks.push({ id: 'sw-x9', state: 'working' });
    labels.sync(makeFloor(islands));
    expect(labels.tag('sw-x9')!.classList.contains('fv-sel')).toBe(true);
    labels.setSelected(null);
    expect(root.querySelectorAll('.fv-sel')).toHaveLength(0);
  });

  it('puts one tag in the tab order: the one selected or focused last, else the first', () => {
    const { labels } = layer();
    const ids = desksOf(checkoutFloor()).map((d) => d.sessionId);
    const stops = () => ids.filter((id) => labels.tag(id)?.tabIndex === 0);
    labels.sync(checkoutFloor());
    expect(stops()).toEqual(['sw-a1']);
    expect(ids.filter((id) => labels.tag(id)!.tabIndex === -1)).toHaveLength(6);
    labels.setSelected('oa-c3');
    expect(stops()).toEqual(['oa-c3']);
    labels.tag('ps-d4')!.focus();
    expect(stops()).toEqual(['ps-d4']);
    // A floor update marks the same selection again: the tab stop stays where the focus left it.
    labels.sync(checkoutFloor());
    labels.setSelected('oa-c3');
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
    // Closer in, the first two tags are off the view: the keys pass them by.
    camera.zoom = 3;
    camera.updateProjectionMatrix();
    labels.position(camera, 800, 500);
    labels.tag('oa-c3')!.focus();
    press('Home');
    expect(focused()).toBe('sw-c3');
    press('ArrowLeft');
    expect(focused()).toBe('sw-c3');
  });

  describe('the tab stop', () => {
    const stops = (labels: LabelLayer) => desksOf(checkoutFloor()).map((d) => d.sessionId).filter((id) => labels.tag(id)?.tabIndex === 0);
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
      // Closer in, the first two tags are off the view: the stop passes on to the next one in floor order.
      zoomed(labels, 3);
      expect(stops(labels)).toEqual(['sw-c3']);
      zoomed(labels, 6);
      expect(stops(labels)).toEqual(['oa-c3']);
      expect(calls).toEqual([]);
    });

    it('gives the stop to the earlier of two tags on the view that are equally near it in floor order', () => {
      const { labels } = layer();
      const floor = checkoutFloor();
      const desks = desksOf(floor);
      // The third desk stands at the far end of the floor, away from its neighbours in floor order.
      desks[2]!.rect = desks[desks.length - 1]!.rect;
      labels.sync(floor);
      labels.setSelected(desks[2]!.sessionId);
      // A top-down camera over the second and the fourth desk, which are one step either side of it in floor order.
      const a = labelAnchor(desks[1]!);
      const b = labelAnchor(desks[3]!);
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
      expect(stops(labels)).toEqual(['sw-c3']);
      expect(document.activeElement).toBe(labels.tag('sw-c3'));
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
      labels.setSelected('ps-d4');
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
    const desk = desksOf(floor).find((d) => d.sessionId === 'oa-c3')!;
    const p = projectToScreen(labelAnchor(desk), camera, 800, 500);
    expect(tag.style.visibility).toBe('');
    expect(tag.style.transform).toBe(`translate(${p.x}px, ${p.y}px) translate(-50%, -100%)`);
    camera.position.x += 1000;
    camera.updateMatrixWorld();
    labels.position(camera, 800, 500);
    expect(tag.style.visibility).toBe('hidden');
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
        '.fv-compact .fv-tag:not(:hover):not(:focus-visible):not(.fv-sel):not(.fv-st-needs_you) > .fv-name',
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
    expect(tagTitle({ ...desksOf(checkoutFloor())[0]!, name: long }).startsWith(long + ' · ')).toBe(true);
  });

  it('removes its labels on dispose', () => {
    const { root, labels } = layer();
    labels.sync(checkoutFloor());
    labels.dispose();
    expect(root.children).toHaveLength(0);
    expect(root.classList.contains('fv-labels')).toBe(false);
  });

  it('describes a desk for its tooltip', () => {
    const desk = desksOf(checkoutFloor())[0]!;
    expect(tagTitle(desk)).toBe('sw-a1 · working · 1 agent running');
  });
});
