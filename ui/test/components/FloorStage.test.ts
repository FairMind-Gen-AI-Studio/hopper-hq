import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import FloorStage from '../../components/FloorStage.svelte';
import type { FloorDetail } from '../../../src/scene/types';
import { WebGLUnavailableError, type Target } from '../../renderer/index';
import { CHECKOUT, makeFloor } from '../helpers/fixtures';
import { fakeRenderer, type FakeRenderer } from '../helpers/fake-renderer';
import { cleanup, click, render, text } from '../helpers/render';
import { RUN, checkoutWithRoom } from '../helpers/rooms';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Lets the loader answer, then updates the DOM. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
}

function stage(renderer: FakeRenderer = fakeRenderer(), selected: Target | null = null, floor: FloorDetail = makeFloor(CHECKOUT)!) {
  const onSelect = vi.fn();
  const onActivate = vi.fn();
  const target = render(FloorStage, { floor, selected, theme: 'day', load: renderer.load, onSelect, onActivate });
  const tool = (label: string) => target.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  return { target, renderer, onSelect, onActivate, tool };
}

function key(k: string, init: KeyboardEventInit = {}, on: EventTarget = window): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  on.dispatchEvent(e);
  flushSync();
  return e;
}

describe('FloorStage', () => {
  it('loads the renderer, mounts it on its canvas and label layer, then shows the floor and the desk in the address', async () => {
    const { target, renderer, tool } = stage(undefined, { kind: 'desk', id: 'sw-b2' });
    expect(renderer.views).toHaveLength(0);
    expect(tool('Turn left').disabled).toBe(true);
    await settle();
    expect(renderer.views).toHaveLength(1);
    const view = renderer.views[0]!;
    expect(view.host.canvas).toBe(target.querySelector('.floor-stage canvas'));
    expect(view.host.labels.parentElement).toBe(target.querySelector('.floor-stage'));
    expect(view.calls).toEqual([`floor ${CHECKOUT} 4`, 'select desk sw-b2 pan']);
    expect(view.mountedTheme).toBe('system');
    expect(tool('Turn left').disabled).toBe(false);
    expect(target.querySelector('.no-webgl')).toBeNull();
  });

  it('says the floor is loading until the view is up, and only then how to move around it', async () => {
    const { target } = stage();
    const loading = target.querySelector('.loading');
    expect(text(loading)).toBe('Loading the 3D floor…');
    expect(loading?.getAttribute('role')).toBe('status');
    expect(target.querySelector('.hint')).toBeNull();
    await settle();
    expect(target.querySelector('.loading')).toBeNull();
    expect(text(target.querySelector('.hint'))).toBe('Drag to turn and tilt · scroll to zoom · right-drag to pan · arrows to walk · double-click a desk or a room for its pane');
  });

  it('reads the theme colours from the page', async () => {
    document.documentElement.style.setProperty('--scene-floor', '#123456');
    try {
      const { renderer } = stage();
      await settle();
      expect(renderer.views[0]!.theme.colors['scene-floor']).toBe('#123456');
    } finally {
      document.documentElement.style.removeProperty('--scene-floor');
    }
  });

  it('marks a desk clicked in 3D at once, without moving the camera, and reports clicks and activations', async () => {
    const { renderer, onSelect, onActivate } = stage();
    await settle();
    const view = renderer.views[0]!;
    view.emit('select', { kind: 'desk', id: 'sw-a1' });
    view.emit('select', null);
    view.emit('activate', { kind: 'desk', id: 'sw-a1' });
    expect(onSelect.mock.calls).toEqual([[{ kind: 'desk', id: 'sw-a1' }], [null]]);
    expect(onActivate.mock.calls).toEqual([['sw-a1']]);
    expect(view.calls).toEqual([`floor ${CHECKOUT} 4`, 'select - pan', 'select desk sw-a1', 'select -']);
  });

  it('shows the room in the address, marks and reports a room picked in 3D, and goes to its host when it is activated', async () => {
    const { renderer, onSelect, onActivate } = stage(undefined, { kind: 'room', id: RUN }, checkoutWithRoom());
    await settle();
    const view = renderer.views[0]!;
    view.emit('select', { kind: 'desk', id: 'sw-a1' });
    view.emit('select', { kind: 'room', id: RUN });
    view.emit('activate', { kind: 'room', id: RUN });
    view.emit('activate', { kind: 'room', id: 'wf_gone' });
    expect(onSelect.mock.calls).toEqual([[{ kind: 'desk', id: 'sw-a1' }], [{ kind: 'room', id: RUN }]]);
    expect(onActivate.mock.calls).toEqual([['ps-d4']]);
    expect(view.calls).toEqual([`floor ${CHECKOUT} 4`, `select room ${RUN} pan`, 'select desk sw-a1', `select room ${RUN}`]);
  });

  it('turns and resets the camera from its buttons and from Q, E and R', async () => {
    const { renderer, tool } = stage();
    await settle();
    const view = renderer.views[0]!;
    view.calls.length = 0;
    click(tool('Turn left'));
    click(tool('Turn right'));
    click(tool('Reset view'));
    expect(view.calls).toEqual(['rotate -1', 'rotate 1', 'reset']);
    view.calls.length = 0;
    expect(key('q').defaultPrevented).toBe(true);
    key('E');
    key('r');
    expect(view.calls).toEqual(['rotate -1', 'rotate 1', 'reset']);
  });

  it('leaves other keys, shortcuts and typing alone', async () => {
    const { renderer } = stage();
    await settle();
    const view = renderer.views[0]!;
    view.calls.length = 0;
    expect(key('r', { metaKey: true }).defaultPrevented).toBe(false);
    key('r', { ctrlKey: true });
    key('e', { altKey: true });
    key('Enter');
    key('Escape');
    const handled = new KeyboardEvent('keydown', { key: 'q', cancelable: true });
    handled.preventDefault();
    window.dispatchEvent(handled);
    const input = document.body.appendChild(document.createElement('input'));
    key('q', {}, input);
    input.remove();
    expect(view.calls).toEqual([]);
  });

  it('keeps the desk list in reach when the browser has no WebGL', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { target, renderer } = stage(fakeRenderer({ fail: new WebGLUnavailableError() }));
    await settle();
    expect(renderer.views).toHaveLength(0);
    expect(text(target.querySelector('.no-webgl'))).toBe('This browser cannot draw the floor in 3D. Its desks are listed in the panel.');
    expect(target.querySelector('canvas')).toBeNull();
    expect(target.querySelector('.tools')).toBeNull();
    expect(key('q').defaultPrevented).toBe(false);
    expect(logged).not.toHaveBeenCalled();
  });

  it('offers a reload, and logs why, when the renderer does not load: the daemon may have been updated', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reload = vi.spyOn(location, 'reload').mockImplementation(() => {});
    const failure = new TypeError('Failed to fetch dynamically imported module');
    const onSelect = vi.fn();
    const target = render(FloorStage, {
      floor: makeFloor(CHECKOUT)!,
      selected: null,
      theme: 'day',
      load: () => Promise.reject(failure),
      onSelect,
      onActivate: vi.fn(),
    });
    await settle();
    const notice = target.querySelector('.load-failed');
    expect(notice?.getAttribute('role')).toBe('alert');
    expect(text(notice?.querySelector('p'))).toBe('The 3D view could not load; the daemon may have been updated. Reload the page.');
    expect(target.querySelector('.no-webgl')).toBeNull();
    expect(logged).toHaveBeenCalledWith(failure);
    click(notice?.querySelector('button'));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('offers a reload too when the renderer loads but fails to mount for a reason other than WebGL', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('three.js could not start');
    const { target } = stage(fakeRenderer({ fail: failure }));
    await settle();
    expect(text(target.querySelector('.load-failed p'))).toBe('The 3D view could not load; the daemon may have been updated. Reload the page.');
    expect(target.querySelector('.no-webgl')).toBeNull();
    expect(logged).toHaveBeenCalledWith(failure);
  });

  it('frees the view when it goes away, and mounts nothing once gone', async () => {
    const { renderer } = stage();
    await settle();
    cleanup();
    expect(renderer.views[0]!.calls.at(-1)).toBe('dispose');
    key('q');
    expect(renderer.views[0]!.calls.filter((c) => c.startsWith('rotate'))).toEqual([]);

    const late = fakeRenderer();
    stage(late);
    cleanup();
    await settle();
    expect(late.views).toHaveLength(0);
  });
});
