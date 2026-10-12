import { afterEach, describe, expect, it } from 'vitest';
import { OrthographicCamera } from 'three';
import { LabelLayer, projectToScreen, tagTitle, type LabelEvents } from '../../renderer/labels';
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
  const events: LabelEvents = { select: (id) => calls.push('select ' + id), activate: (id) => calls.push('activate ' + id) };
  return { root, calls, labels: new LabelLayer(root, events) };
}

const HOSTILE = '<img src=x onerror=alert(1)>';

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
