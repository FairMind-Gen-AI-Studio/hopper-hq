import { afterEach, describe, expect, it } from 'vitest';
import { Vector3, type Camera, type Object3D, type OrthographicCamera } from 'three';
import { PAN_MS, QUARTER, ROTATE_MS, turnBetween } from '../../renderer/camera';
import type { FloorView } from '../../renderer/index';
import { dayTheme } from '../../renderer/theme';
import { DOUBLE_CLICK_MS, DRAG_PX, createFloorView, type RendererLike, type ViewEnv } from '../../renderer/view';
import { HOME_AZIMUTH, azimuthOf, cameraOffset, deskAnchor, floorCenter } from '../../renderer/world';
import { checkoutFloor, desksOf } from './fixtures';

const W = 800;
const H = 500;

/** A renderer that records what it is asked to do. */
class FakeRenderer implements RendererLike {
  shadowMap = { enabled: false, type: 0 as RendererLike['shadowMap']['type'], autoUpdate: true, needsUpdate: false };
  renders = 0;
  /** Frames that drew the shadow map too, as three decides it. */
  shadowDraws = 0;
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
    if (this.shadowMap.enabled && (this.shadowMap.autoUpdate || this.shadowMap.needsUpdate)) this.shadowDraws++;
    this.shadowMap.needsUpdate = false;
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

/** Frames and timers run only when the test lets time pass, at the time it says. */
class FakeEnv implements ViewEnv {
  queue = new Map<number, (now: number) => void>();
  timers = new Map<number, { at: number; run: () => void }>();
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
  later(ms: number, run: () => void): () => void {
    const id = this.next++;
    this.timers.set(id, { at: this.time + ms, run });
    return () => {
      this.timers.delete(id);
    };
  }
  /** Lets `ms` pass without drawing, running the timers that come due. */
  wait(ms: number): void {
    this.time += ms;
    this.fire();
  }
  /** Runs the frames asked for so far, once, `advance` ms later. */
  step(advance = 16): void {
    this.time += advance;
    this.fire();
    const due = [...this.queue.values()];
    this.queue.clear();
    for (const draw of due) draw(this.time);
  }
  /** Runs the frames that are due, and the ones they ask for, up to `limit` rounds; returns how many ran. */
  flush(advance = 16, limit = 200): number {
    let ran = 0;
    while (this.queue.size && ran < limit) {
      this.time += advance;
      this.fire();
      const due = [...this.queue.values()];
      this.queue.clear();
      for (const draw of due) draw(this.time);
      ran += due.length;
    }
    return ran;
  }
  private fire(): void {
    for (const [id, timer] of [...this.timers]) {
      if (timer.at > this.time) continue;
      this.timers.delete(id);
      timer.run();
    }
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

/** What a browser sends for a click: the press, the release and, for the main button, the click with its count. */
function click(canvas: HTMLCanvasElement, at: { x: number; y: number }, moved = 0, button = 0, detail = 1): void {
  canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: at.x, clientY: at.y, button, pointerId: 1, bubbles: true }));
  canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: at.x + moved, clientY: at.y, button, pointerId: 1, bubbles: true }));
  if (button === 0) canvas.dispatchEvent(new MouseEvent('click', { clientX: at.x + moved, clientY: at.y, detail, bubbles: true }));
}

/** A double-click whose two clicks are `gap` ms apart, with frames drawn in between. */
function doubleClick(env: FakeEnv, target: HTMLElement, at: { x: number; y: number }, gap: number): void {
  const press = (detail: number) => {
    target.dispatchEvent(new PointerEvent('pointerdown', { clientX: at.x, clientY: at.y, button: 0, pointerId: 1, bubbles: true }));
    target.dispatchEvent(new PointerEvent('pointerup', { clientX: at.x, clientY: at.y, button: 0, pointerId: 1, bubbles: true }));
    target.dispatchEvent(new MouseEvent('click', { clientX: at.x, clientY: at.y, detail, bubbles: true }));
  };
  press(1);
  for (let t = 0; t < gap; t += 16) env.step(16);
  press(2);
  target.dispatchEvent(new MouseEvent('dblclick', { clientX: at.x, clientY: at.y, detail: 2, bubbles: true }));
}

/** A drag across the canvas with a mouse button: the main one turns the camera, the right one pans it. */
function drag(canvas: HTMLCanvasElement, dx: number, dy: number, button: number): void {
  const at = (x: number, y: number) => ({ clientX: x, clientY: y, button, pointerId: 7, pointerType: 'mouse', bubbles: true });
  canvas.dispatchEvent(new PointerEvent('pointerdown', at(W / 2, H / 2)));
  document.dispatchEvent(new PointerEvent('pointermove', at(W / 2 + dx, H / 2 + dy)));
  document.dispatchEvent(new PointerEvent('pointerup', at(W / 2 + dx, H / 2 + dy)));
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

  it('activates the desk the first click of a double-click picked, while the UI pans to each desk it selects', () => {
    for (const reduced of [false, true]) {
      for (const gap of [150, 250, 350]) {
        for (const id of desksOf(checkoutFloor()).map((d) => d.sessionId)) {
          const { renderer, env, view, canvas, events } = setup(dayTheme(reduced));
          view.setFloor(checkoutFloor());
          env.flush();
          view.on('select', (picked) => view.select(picked, { pan: true }));
          doubleClick(env, canvas, deskPoint(renderer, id), gap);
          expect([reduced, gap, events]).toEqual([reduced, gap, [`select ${id}`, `select ${id}`, `activate ${id}`]]);
          // The double-click took the desk's pane: the camera stays where it was.
          env.wait(DOUBLE_CLICK_MS);
          env.flush();
          expect([reduced, gap, id, cameraPose(renderer).zoom]).toEqual([reduced, gap, id, 1]);
        }
      }
    }
  });

  it('pans to a desk its own click selected once a second click can no longer come', () => {
    const { renderer, env, view, canvas, events } = setup();
    view.setFloor(checkoutFloor());
    env.flush();
    view.on('select', (picked) => view.select(picked, { pan: true }));
    click(canvas, deskPoint(renderer, 'oa-c3'));
    env.flush();
    expect(cameraPose(renderer).zoom).toBe(1);
    expect(renderer.scene!.getObjectByName('selection')!.visible).toBe(true);
    env.wait(DOUBLE_CLICK_MS);
    env.flush();
    expect(cameraPose(renderer).zoom).toBe(1.25);
    expect(events).toEqual(['select oa-c3']);
    // A press before then drops the pan: the camera is the user's.
    click(canvas, deskPoint(renderer, 'sw-a1'));
    click(canvas, { x: 4, y: 4 }, DRAG_PX + 1);
    env.wait(DOUBLE_CLICK_MS);
    env.flush();
    expect(cameraPose(renderer).zoom).toBe(1.25);
    expect(env.timers.size).toBe(0);
  });

  it('selects again what the first click picked when the floor moved under a double-click', () => {
    const { renderer, env, view, canvas, events } = setup(dayTheme(true));
    view.setFloor(checkoutFloor());
    env.flush();
    const at = deskPoint(renderer, 'oa-c3');
    click(canvas, at);
    view.rotate(1);
    env.flush();
    click(canvas, at, 0, 0, 2);
    canvas.dispatchEvent(new MouseEvent('dblclick', { clientX: at.x, clientY: at.y, detail: 2, bubbles: true }));
    click(canvas, at);
    expect(events).toEqual(['select oa-c3', 'select oa-c3', 'activate oa-c3', 'select null']);
  });

  it('keeps the desk a double-click on a tag started with, and waits with its pan too', () => {
    const { renderer, env, view, labels, events } = setup();
    view.setFloor(checkoutFloor());
    env.flush();
    view.on('select', (picked) => view.select(picked, { pan: true }));
    const tag = (id: string) => labels.querySelector(`[data-session="${id}"]`) as HTMLElement;
    tag('sw-a1').dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true }));
    env.flush();
    expect(cameraPose(renderer).zoom).toBe(1);
    // The second click lands on another tag, as if the first one had moved away.
    tag('sw-b2').dispatchEvent(new MouseEvent('click', { detail: 2, bubbles: true }));
    tag('sw-b2').dispatchEvent(new MouseEvent('dblclick', { detail: 2, bubbles: true }));
    env.wait(DOUBLE_CLICK_MS);
    env.flush();
    expect(events).toEqual(['select sw-a1', 'select sw-a1', 'activate sw-a1']);
    expect(cameraPose(renderer).zoom).toBe(1);
    // A click from the keyboard starts no double-click: its pan does not wait.
    tag('ps-d4').click();
    env.flush();
    expect(cameraPose(renderer).zoom).toBe(1.25);
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

  it('zooms with the wheel over a tag, as over the canvas', () => {
    const { renderer, env, view, labels } = setup();
    view.setFloor(checkoutFloor());
    env.flush();
    const wheel = new WheelEvent('wheel', { deltaY: -200, bubbles: true, cancelable: true });
    labels.querySelector('[data-session="oa-c3"] .fv-name')!.dispatchEvent(wheel);
    env.flush();
    expect(wheel.defaultPrevented).toBe(true);
    expect(cameraPose(renderer).zoom).toBeGreaterThan(1.1);
  });

  it('turns the camera on a drag that starts on a tag, and still selects on a click there', () => {
    const { renderer, env, view, labels, events } = setup(dayTheme(true));
    view.setFloor(checkoutFloor());
    env.flush();
    const tag = labels.querySelector('[data-session="sw-b2"]') as HTMLElement;
    const at = (x: number, button = 0) => ({ clientX: x, clientY: 200, button, pointerId: 9, pointerType: 'mouse', bubbles: true });
    tag.dispatchEvent(new PointerEvent('pointerdown', at(300)));
    document.dispatchEvent(new PointerEvent('pointermove', at(300 + DRAG_PX)));
    env.flush();
    expect(cameraPose(renderer).azimuth).toBeCloseTo(HOME_AZIMUTH, 6);
    document.dispatchEvent(new PointerEvent('pointermove', at(380)));
    document.dispatchEvent(new PointerEvent('pointermove', at(400)));
    document.dispatchEvent(new PointerEvent('pointerup', at(400)));
    // A browser that ends the drag with a click on the tag: it selects nothing.
    tag.dispatchEvent(new MouseEvent('click', { clientX: 400, clientY: 200, detail: 1, bubbles: true }));
    env.flush();
    expect(cameraPose(renderer).azimuth).not.toBeCloseTo(HOME_AZIMUTH, 2);
    tag.dispatchEvent(new PointerEvent('pointerdown', at(300)));
    document.dispatchEvent(new PointerEvent('pointerup', at(300)));
    tag.dispatchEvent(new MouseEvent('click', { clientX: 300, clientY: 200, detail: 1, bubbles: true }));
    expect(events).toEqual(['select sw-b2']);
  });

  it('pans on a right-button drag that starts on a tag, with no menu', () => {
    const { renderer, env, view, labels } = setup(dayTheme(true));
    view.setFloor(checkoutFloor());
    env.flush();
    const before = cameraPose(renderer);
    const tag = labels.querySelector('[data-session="ps-d4"]') as HTMLElement;
    const at = (x: number) => ({ clientX: x, clientY: 200, button: 2, pointerId: 9, pointerType: 'mouse', bubbles: true });
    tag.dispatchEvent(new PointerEvent('pointerdown', at(300)));
    document.dispatchEvent(new PointerEvent('pointermove', at(400)));
    document.dispatchEvent(new PointerEvent('pointerup', at(400)));
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    tag.dispatchEvent(menu);
    env.flush();
    expect(menu.defaultPrevented).toBe(true);
    expect(cameraPose(renderer).target.x).not.toBeCloseTo(before.target.x, 2);
    expect(cameraPose(renderer).azimuth).toBeCloseTo(HOME_AZIMUTH, 6);
  });

  it('shows only the dots of the tags while the floor is small on screen', () => {
    const { env, view, canvas, labels } = setup();
    view.setFloor(checkoutFloor());
    env.flush();
    expect(labels.classList.contains('fv-compact')).toBe(true);
    for (let i = 0; i < 6; i++) canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -1000, bubbles: true, cancelable: true }));
    env.flush();
    expect(labels.classList.contains('fv-compact')).toBe(false);
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

  it('turns the way it was asked through a quick chain of turns, also past half a turn', () => {
    const { renderer, env, view } = setup();
    view.setFloor(checkoutFloor());
    env.flush();
    let last = cameraPose(renderer).azimuth;
    let turned = 0;
    const frames = (n: number) => {
      for (let i = 0; i < n && env.queue.size; i++) {
        env.step(16);
        const now = cameraPose(renderer).azimuth;
        expect(turnBetween(last, now)).toBeGreaterThanOrEqual(-1e-9);
        turned += turnBetween(last, now);
        last = now;
      }
    };
    view.rotate(1);
    frames(5);
    view.rotate(1);
    view.rotate(1);
    frames(200);
    expect(turned).toBeCloseTo(3 * QUARTER, 6);
    view.rotate(-1);
    view.rotate(-1);
    env.flush();
    expect(cameraPose(renderer).azimuth).toBeCloseTo(HOME_AZIMUTH + QUARTER, 6);
  });

  it('jumps instead of easing when motion is reduced', () => {
    const { renderer, env, view } = setup(dayTheme(true));
    view.setFloor(checkoutFloor());
    env.flush();
    view.rotate(1);
    env.step(1);
    expect(cameraPose(renderer).azimuth).toBeCloseTo(HOME_AZIMUTH + Math.PI / 2, 6);
  });

  it('keeps the ground point it looks at when it turns after a pan up or down the screen', () => {
    const { renderer, env, view, canvas } = setup(dayTheme(true));
    view.setFloor(checkoutFloor());
    env.flush();
    drag(canvas, 0, 150, 2);
    env.flush();
    const panned = cameraPose(renderer);
    expect(panned.target.z).toBeLessThan(floorCenter(checkoutFloor().size).z - 1);
    view.rotate(1);
    env.flush();
    view.rotate(-1);
    env.flush();
    const turned = cameraPose(renderer);
    expect(turned.target.x).toBeCloseTo(panned.target.x, 6);
    expect(turned.target.z).toBeCloseTo(panned.target.z, 6);
    expect(turned.azimuth).toBeCloseTo(HOME_AZIMUTH, 6);
    expect(renderer.camera!.position.y).toBeCloseTo(cameraOffset(HOME_AZIMUTH).y, 6);
  });

  it('turns about the ground point at the centre of the view when dragged, also after a pan up or down', () => {
    const { renderer, env, view, canvas } = setup(dayTheme(true));
    view.setFloor(checkoutFloor());
    env.flush();
    drag(canvas, 0, -120, 2);
    env.flush();
    const panned = cameraPose(renderer);
    drag(canvas, 100, 0, 0);
    env.flush();
    const turned = cameraPose(renderer);
    expect(turned.azimuth).not.toBeCloseTo(panned.azimuth, 2);
    expect(turned.target.x).toBeCloseTo(panned.target.x, 6);
    expect(turned.target.z).toBeCloseTo(panned.target.z, 6);
  });

  it('draws the shadows again only when they can change: a floor, a theme, a wall that comes or goes', () => {
    const { renderer, env, view, canvas } = setup(dayTheme(true));
    env.flush();
    expect(renderer.shadowMap.autoUpdate).toBe(false);
    view.setFloor(checkoutFloor());
    env.flush();
    expect(renderer.shadowDraws).toBe(1);
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true, cancelable: true }));
    drag(canvas, 80, 40, 2);
    view.select('oa-c3', { pan: true });
    env.flush();
    expect(renderer.renders).toBeGreaterThan(3);
    expect(renderer.shadowDraws).toBe(1);
    view.setTheme(dayTheme(true));
    env.flush();
    expect(renderer.shadowDraws).toBe(2);
    view.rotate(1);
    env.flush();
    expect(renderer.shadowDraws).toBe(3);
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

  it('draws nothing while its WebGL context is lost, and the floor and its shadows again once it is back', () => {
    const { renderer, env, view, canvas } = setup();
    view.setFloor(checkoutFloor());
    env.flush();
    view.select('oa-c3');
    expect(env.queue.size).toBe(1);
    canvas.dispatchEvent(new Event('webglcontextlost'));
    expect(env.queue.size).toBe(0);
    view.select('sw-a1');
    expect(env.queue.size).toBe(0);
    const shadows = renderer.shadowDraws;
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(env.queue.size).toBe(1);
    env.flush();
    expect(renderer.shadowDraws).toBe(shadows + 1);
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
    env.flush();
    view.on('select', (picked) => view.select(picked, { pan: true }));
    click(canvas, deskPoint(renderer, 'oa-c3'));
    events.length = 0;
    view.dispose();
    view.dispose();
    expect(renderer.disposed).toBe(1);
    expect(renderer.contextLost).toBe(1);
    expect(env.queue.size).toBe(0);
    expect(env.timers.size).toBe(0);
    expect(env.watching).toBe(false);
    expect(labels.children).toHaveLength(0);
    click(canvas, { x: 400, y: 250 });
    view.select('oa-c3');
    expect(env.queue.size).toBe(0);
    expect(events).toEqual([]);
  });
});
