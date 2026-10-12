import { afterEach, describe, expect, it } from 'vitest';
import { Vector3, type Camera, type Object3D, type OrthographicCamera } from 'three';
import { PAN_MS, ROTATE_MS } from '../../renderer/camera';
import type { FloorView } from '../../renderer/index';
import { dayTheme } from '../../renderer/theme';
import { DRAG_PX, createFloorView, type RendererLike, type ViewEnv } from '../../renderer/view';
import { HOME_AZIMUTH, azimuthOf, deskAnchor, floorCenter } from '../../renderer/world';
import { checkoutFloor, desksOf } from './fixtures';

const W = 800;
const H = 500;

/** A renderer that records what it is asked to do. */
class FakeRenderer implements RendererLike {
  shadowMap = { enabled: false, type: 0 as RendererLike['shadowMap']['type'] };
  renders = 0;
  sizes: Array<[number, number]> = [];
  disposed = 0;
  contextLost = 0;
  scene: Object3D | null = null;
  camera: Camera | null = null;
  setPixelRatio(): void {}
  setSize(w: number, h: number): void {
    this.sizes.push([w, h]);
  }
  setClearColor(): void {}
  render(scene: Object3D, camera: Camera): void {
    this.renders++;
    this.scene = scene;
    this.camera = camera;
  }
  dispose(): void {
    this.disposed++;
  }
  forceContextLoss(): void {
    this.contextLost++;
  }
}

/** Frames run only when the test flushes them, at the time it says. */
class FakeEnv implements ViewEnv {
  queue = new Map<number, (now: number) => void>();
  next = 1;
  time = 1000;
  isHidden = false;
  resized: (() => void) | null = null;
  watching = true;
  requestFrame(draw: (now: number) => void): number {
    this.queue.set(this.next, draw);
    return this.next++;
  }
  cancelFrame(id: number): void {
    this.queue.delete(id);
  }
  now(): number {
    return this.time;
  }
  hidden(): boolean {
    return this.isHidden;
  }
  pixelRatio(): number {
    return 1;
  }
  observeResize(_el: Element, changed: () => void): () => void {
    this.resized = changed;
    return () => {
      this.watching = false;
    };
  }
  /** Runs the frames asked for so far, once, `advance` ms later. */
  step(advance = 16): void {
    this.time += advance;
    const due = [...this.queue.values()];
    this.queue.clear();
    for (const draw of due) draw(this.time);
  }
  /** Runs the frames that are due, and the ones they ask for, up to `limit` rounds; returns how many ran. */
  flush(advance = 16, limit = 200): number {
    let ran = 0;
    while (this.queue.size && ran < limit) {
      this.time += advance;
      const due = [...this.queue.values()];
      this.queue.clear();
      for (const draw of due) draw(this.time);
      ran += due.length;
    }
    return ran;
  }
}

/** happy-dom lays nothing out: the canvas's CSS size is whatever the test sets here. */
const box = { width: W, height: H };

function setup(theme = dayTheme()) {
  box.width = W;
  box.height = H;
  const stage = document.body.appendChild(document.createElement('div'));
  const canvas = stage.appendChild(document.createElement('canvas'));
  Object.defineProperty(canvas, 'clientWidth', { get: () => box.width });
  Object.defineProperty(canvas, 'clientHeight', { get: () => box.height });
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: W, height: H, right: W, bottom: H, x: 0, y: 0, toJSON: () => ({}) });
  const labels = stage.appendChild(document.createElement('div'));
  const renderer = new FakeRenderer();
  const env = new FakeEnv();
  const view = createFloorView({ canvas, labels }, theme, renderer, env);
  const events: string[] = [];
  view.on('select', (id) => events.push(`select ${id}`));
  view.on('activate', (id) => events.push(`activate ${id}`));
  views.push(view);
  return { canvas, labels, renderer, env, view, events };
}

const views: FloorView[] = [];
afterEach(() => {
  for (const v of views.splice(0)) v.dispose();
  document.body.replaceChildren();
});

/** Where on the canvas a world point shows, through the camera the view last rendered with. */
function screenOf(renderer: FakeRenderer, x: number, y: number, z: number): { x: number; y: number } {
  const p = new Vector3(x, y, z).project(renderer.camera!);
  return { x: ((p.x + 1) / 2) * W, y: ((1 - p.y) / 2) * H };
}

function click(canvas: HTMLCanvasElement, at: { x: number; y: number }, moved = 0, button = 0): void {
  canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: at.x, clientY: at.y, button, pointerId: 1, bubbles: true }));
  canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: at.x + moved, clientY: at.y, button, pointerId: 1, bubbles: true }));
}

function deskPoint(renderer: FakeRenderer, id: string): { x: number; y: number } {
  const desk = desksOf(checkoutFloor()).find((d) => d.sessionId === id)!;
  const a = deskAnchor(desk.rect);
  return screenOf(renderer, a.x, 0.74, a.z);
}

function cameraPose(renderer: FakeRenderer) {
  const camera = renderer.camera as OrthographicCamera;
  const dir = new Vector3();
  camera.getWorldDirection(dir);
  // The ground point the camera looks at, from its position along its direction to y = 0.
  const t = camera.position.y / -dir.y;
  const target = { x: camera.position.x + dir.x * t, z: camera.position.z + dir.z * t };
  return { target, azimuth: azimuthOf({ x: camera.position.x - target.x, z: camera.position.z - target.z }), zoom: camera.zoom };
}

describe('the floor view', () => {
  it('draws on demand and stops when nothing changes', () => {
    const { renderer, env, view } = setup();
    expect(env.flush()).toBeGreaterThan(0);
    const drawn = renderer.renders;
    expect(env.queue.size).toBe(0);
    expect(env.flush()).toBe(0);
    expect(renderer.renders).toBe(drawn);
    view.setFloor(checkoutFloor());
    expect(env.queue.size).toBe(1);
    env.flush();
    expect(renderer.renders).toBeGreaterThan(drawn);
    expect(env.queue.size).toBe(0);
    expect(renderer.shadowMap.enabled).toBe(true);
  });

  it('opens a floor from home, framing its centre, with its desks and labels', () => {
    const { renderer, env, view, labels } = setup();
    const floor = checkoutFloor();
    view.setFloor(floor);
    env.flush();
    const pose = cameraPose(renderer);
    const c = floorCenter(floor.size);
    expect(pose.target.x).toBeCloseTo(c.x, 6);
    expect(pose.target.z).toBeCloseTo(c.z, 6);
    expect(pose.azimuth).toBeCloseTo(HOME_AZIMUTH, 6);
    expect(pose.zoom).toBe(1);
    expect(labels.querySelectorAll('.fv-tag')).toHaveLength(7);
    expect(renderer.scene!.getObjectByName('desk oa-c3')).toBeDefined();
    expect(renderer.sizes.at(-1)).toEqual([W, H]);
  });

  it('selects the desk under a click, or nothing on empty floor, and ignores drags and other buttons', () => {
    const { renderer, env, view, canvas, events } = setup();
    view.setFloor(checkoutFloor());
    env.flush();
    click(canvas, deskPoint(renderer, 'oa-c3'));
    click(canvas, { x: 4, y: 4 });
    click(canvas, deskPoint(renderer, 'sw-b2'), DRAG_PX + 1);
    click(canvas, deskPoint(renderer, 'sw-b2'), 0, 2);
    click(canvas, deskPoint(renderer, 'sw-b2'), DRAG_PX);
    expect(events).toEqual(['select oa-c3', 'select null', 'select sw-b2']);
  });

  it('activates the desk under a double-click', () => {
    const { renderer, env, view, canvas, events } = setup();
    view.setFloor(checkoutFloor());
    env.flush();
    const at = deskPoint(renderer, 'ps-d4');
    canvas.dispatchEvent(new MouseEvent('dblclick', { clientX: at.x, clientY: at.y, bubbles: true }));
    canvas.dispatchEvent(new MouseEvent('dblclick', { clientX: 4, clientY: 4, bubbles: true }));
    expect(events).toEqual(['activate ps-d4']);
  });

  it('activates the selected desk on Enter, and is silent when the UI selects', () => {
    const { env, view, canvas, events } = setup();
    view.setFloor(checkoutFloor());
    env.flush();
    const enter = () => new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    canvas.dispatchEvent(enter());
    view.select('oa-c3');
    const e = enter();
    canvas.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    view.select('gone');
    canvas.dispatchEvent(enter());
    expect(events).toEqual(['activate oa-c3']);
    expect(canvas.tabIndex).toBe(0);
  });

  it('passes label clicks on as selections', () => {
    const { env, view, labels, events } = setup();
    view.setFloor(checkoutFloor());
    env.flush();
    (labels.querySelector('[data-session="sw-a1"]') as HTMLElement).click();
    expect(events).toEqual(['select sw-a1']);
  });

  it('stops calling a listener once it unsubscribes', () => {
    const { renderer, env, view, canvas } = setup();
    view.setFloor(checkoutFloor());
    env.flush();
    const seen: Array<string | null> = [];
    const off = view.on('select', (id) => seen.push(id));
    click(canvas, deskPoint(renderer, 'oa-c3'));
    off();
    click(canvas, deskPoint(renderer, 'oa-c3'));
    expect(seen).toEqual(['oa-c3']);
  });

  it('rings the selected desk and pans to it when asked, keeping the selection across floor updates', () => {
    const { renderer, env, view } = setup();
    view.setFloor(checkoutFloor());
    env.flush();
    view.select('oa-c3', { pan: true });
    const ring = renderer.scene!.getObjectByName('selection')!;
    expect(ring.visible).toBe(true);
    env.flush(PAN_MS / 4);
    const pose = cameraPose(renderer);
    expect(pose.zoom).toBe(1.25);
    expect(pose.target.x).not.toBeCloseTo(floorCenter(checkoutFloor().size).x, 1);
    view.setFloor(checkoutFloor());
    env.flush();
    expect(ring.visible).toBe(true);
    view.select(null);
    env.flush();
    expect(ring.visible).toBe(false);
  });

  it('pans to a desk asked for before the floor arrived, once it arrives', () => {
    const { renderer, env, view } = setup();
    env.flush();
    view.select('oa-c3', { pan: true });
    env.flush();
    view.setFloor(checkoutFloor());
    env.flush(PAN_MS / 4);
    expect(cameraPose(renderer).zoom).toBe(1.25);
    expect(renderer.scene!.getObjectByName('selection')!.visible).toBe(true);
  });

  it('turns a quarter at a time, cuts away the walls that now face the camera, and resets home', () => {
    const { renderer, env, view } = setup();
    view.setFloor(checkoutFloor());
    env.flush();
    view.rotate(1);
    env.flush(ROTATE_MS / 4);
    expect(cameraPose(renderer).azimuth).toBeCloseTo(HOME_AZIMUTH + Math.PI / 2, 6);
    const wall = (side: string) => renderer.scene!.getObjectByName(`wall-${side}`)!.visible;
    expect([wall('north'), wall('east'), wall('south'), wall('west')]).toEqual([false, false, true, true]);
    view.rotate(-1);
    view.rotate(-1);
    env.flush(ROTATE_MS / 4);
    expect(cameraPose(renderer).azimuth).toBeCloseTo(HOME_AZIMUTH - Math.PI / 2, 6);
    view.resetView();
    env.flush(ROTATE_MS / 4);
    expect(cameraPose(renderer).azimuth).toBeCloseTo(HOME_AZIMUTH, 6);
  });

  it('jumps instead of easing when motion is reduced', () => {
    const { renderer, env, view } = setup(dayTheme(true));
    view.setFloor(checkoutFloor());
    env.flush();
    view.rotate(1);
    env.step(1);
    expect(cameraPose(renderer).azimuth).toBeCloseTo(HOME_AZIMUTH + Math.PI / 2, 6);
  });

  it('draws nothing while the page is hidden, and draws once when it shows again', () => {
    const { env, view } = setup();
    env.flush();
    env.isHidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    view.setFloor(checkoutFloor());
    expect(env.queue.size).toBe(0);
    env.isHidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(env.queue.size).toBe(1);
  });

  it('resizes the drawing buffer when the canvas changes size, and keeps it while the canvas is hidden', () => {
    const { renderer, env } = setup();
    env.flush();
    box.width = 400;
    box.height = 300;
    env.resized!();
    expect(renderer.sizes.at(-1)).toEqual([400, 300]);
    expect(env.queue.size).toBe(1);
    box.width = 0;
    box.height = 0;
    env.resized!();
    expect(renderer.sizes.at(-1)).toEqual([400, 300]);
  });

  it('lets go of everything on dispose, once', () => {
    const { canvas, labels, renderer, env, view, events } = setup();
    view.setFloor(checkoutFloor());
    view.dispose();
    view.dispose();
    expect(renderer.disposed).toBe(1);
    expect(renderer.contextLost).toBe(1);
    expect(env.queue.size).toBe(0);
    expect(env.watching).toBe(false);
    expect(labels.children).toHaveLength(0);
    click(canvas, { x: 400, y: 250 });
    view.select('oa-c3');
    expect(env.queue.size).toBe(0);
    expect(events).toEqual([]);
  });
});
