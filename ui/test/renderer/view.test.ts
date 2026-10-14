import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vector3, type Camera, type Object3D, type OrthographicCamera } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { DESK_PULL, DESK_ZOOM, MAX_POLAR, MAX_ZOOM, MIN_POLAR, PAN_MS, QUARTER, ROTATE_MS, turnBetween } from '../../renderer/camera';
import type { FloorView, Target, ViewOptions } from '../../renderer/index';
import { projectToScreen } from '../../renderer/labels';
import { AMBIENT_MS, DOOR_HOLD_MS, DOOR_MS, WALK_SPEED, startTrip, tripAt, tripEnd } from '../../renderer/motion';
import { poseOf } from '../../renderer/robot';
import { dayTheme } from '../../renderer/theme';
import { AMBIENT_EARLY_MS, DOUBLE_CLICK_MS, DRAG_PX, createFloorView, type RendererLike, type ViewEnv } from '../../renderer/view';
import { findPath, walkGrid } from '../../renderer/walk';
import { HOME_AZIMUTH, LABEL_Y, POLAR, azimuthOf, cameraOffset, deskAnchor, elevatorSpot, floorCenter, labelAnchor, loungeSpots, seatSpot, standSpot, tableCenter } from '../../renderer/world';
import { FloorScene } from '../../renderer/floor-scene';
import { checkoutFloor, checkoutSpecs, checkoutRooms, makeFloor, roomFloor, seatOf, seatsOf } from './fixtures';

const W = 800;
const H = 500;

/** A renderer that records what it is asked to do. */
class FakeRenderer implements RendererLike {
  shadowMap = { enabled: false, type: 0 as RendererLike['shadowMap']['type'], autoUpdate: true, needsUpdate: false };
  renders = 0;
  /** Frames that drew the shadow map too, as three decides it. */
  shadowDraws = 0;
  sizes: Array<[number, number]> = [];
  ratios: number[] = [];
  disposed = 0;
  contextLost = 0;
  scene: Object3D | null = null;
  camera: Camera | null = null;
  setPixelRatio(ratio: number): void {
    this.ratios.push(ratio);
  }
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
  ratio = 1;
  ratioChanged: (() => void) | null = null;
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
    return this.ratio;
  }
  watchPixelRatio(changed: () => void): () => void {
    this.ratioChanged = changed;
    return () => {
      this.ratioChanged = null;
    };
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

const desk = (id: string): Target => ({ kind: 'desk', id });
const room = (id: string): Target => ({ kind: 'room', id });
/** The runs of the two rooms of roomFloor(). */
const FIRST = 'wf_0000aaaa-001';
const SECOND = 'wf_0000aaaa-002';
/** The checkout floor grown wider: a third run opens the second room column. */
const widerFloor = () => roomFloor([...checkoutRooms(), { runId: 'wf_0000aaaa-003', host: 'oa-c3', slot: 2 }]);
/** The checkout floor's sessions, all but the dormant one in a meeting at their desks: robots that run no loop at rest. */
function meetingSpecs() {
  const checkouts = checkoutSpecs();
  for (const c of checkouts) for (const d of c.desks) if (d.state !== 'dormant') d.state = 'in_meeting';
  return checkouts;
}
/** A target as the events list writes it: 'desk oa-c3', or 'null'. */
const said = (target: Target | null): string => (target ? `${target.kind} ${target.id}` : 'null');

/** happy-dom lays nothing out: the canvas's CSS size is whatever the test sets here. */
const box = { width: W, height: H };

function setup(theme = dayTheme(), opts?: ViewOptions) {
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
  const view = createFloorView({ canvas, labels }, theme, renderer, env, opts);
  const events: string[] = [];
  view.on('select', (target) => events.push(`select ${said(target)}`));
  view.on('activate', (target) => events.push(`activate ${said(target)}`));
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

/** A drag across the canvas with a mouse button: the main one turns and tilts the camera, the right one pans it. */
function drag(canvas: HTMLCanvasElement, dx: number, dy: number, button: number): void {
  const at = (x: number, y: number) => ({ clientX: x, clientY: y, button, pointerId: 7, pointerType: 'mouse', bubbles: true });
  canvas.dispatchEvent(new PointerEvent('pointerdown', at(W / 2, H / 2)));
  document.dispatchEvent(new PointerEvent('pointermove', at(W / 2 + dx, H / 2 + dy)));
  document.dispatchEvent(new PointerEvent('pointerup', at(W / 2 + dx, H / 2 + dy)));
}

/** A key pressed or let go on the canvas; returns false when the view took it (preventDefault). */
function key(canvas: HTMLCanvasElement, type: 'keydown' | 'keyup', name: string, mods: KeyboardEventInit = {}): boolean {
  return canvas.dispatchEvent(new KeyboardEvent(type, { key: name, bubbles: true, cancelable: true, ...mods }));
}

function deskPoint(renderer: FakeRenderer, id: string): { x: number; y: number } {
  const a = deskAnchor(seatOf(checkoutFloor(), id).desk);
  return screenOf(renderer, a.x, 0.74, a.z);
}

/** Where the table of the n-th room of roomFloor() shows on the canvas. */
function tablePoint(renderer: FakeRenderer, n: number): { x: number; y: number } {
  const t = tableCenter(roomFloor().rooms[n]!.rect);
  return screenOf(renderer, t.x, 0.78, t.z);
}

function cameraPose(renderer: FakeRenderer) {
  const camera = renderer.camera as OrthographicCamera;
  const dir = new Vector3();
  camera.getWorldDirection(dir);
  // The ground point the camera looks at, from its position along its direction to y = 0.
  const t = camera.position.y / -dir.y;
  const target = { x: camera.position.x + dir.x * t, z: camera.position.z + dir.z * t };
  // The tilt: the angle between the line of sight and straight down.
  const polar = Math.acos(-dir.y);
  return { target, azimuth: azimuthOf({ x: camera.position.x - target.x, z: camera.position.z - target.z }), polar, zoom: camera.zoom };
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

  it('takes its motion option and a snap with a floor, and tells its moving listeners nothing while nothing moves', () => {
    for (const opts of [undefined, { motion: true }, { motion: false }]) {
      const { renderer, env, view } = setup(dayTheme(), opts);
      const moving: boolean[] = [];
      const stop = view.on('moving', (m) => moving.push(m));
      view.setFloor(checkoutFloor());
      env.flush();
      view.setFloor(checkoutFloor(), { snap: true });
      env.flush();
      view.setFloor(checkoutFloor(), { snap: false });
      env.flush();
      expect(env.queue.size).toBe(0);
      expect(renderer.scene!.getObjectByName('robot oa-c3')).toBeDefined();
      expect(moving, JSON.stringify(opts)).toEqual([]);
      stop();
    }
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
    expect(renderer.scene!.getObjectByName(`desk ${seatOf(floor, 'oa-c3').desk.id}`)).toBeDefined();
    expect(renderer.scene!.getObjectByName('robot oa-c3')).toBeDefined();
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
    expect(events).toEqual(['select desk oa-c3', 'select null', 'select desk sw-b2']);
  });

  it('activates the desk under a double-click', () => {
    const { renderer, env, view, canvas, events } = setup();
    view.setFloor(checkoutFloor());
    env.flush();
    const at = deskPoint(renderer, 'ps-d4');
    canvas.dispatchEvent(new MouseEvent('dblclick', { clientX: at.x, clientY: at.y, bubbles: true }));
    canvas.dispatchEvent(new MouseEvent('dblclick', { clientX: 4, clientY: 4, bubbles: true }));
    expect(events).toEqual(['activate desk ps-d4']);
  });

  it('activates the desk the first click of a double-click picked, while the UI pans to each desk it selects', () => {
    for (const reduced of [false, true]) {
      for (const gap of [150, 250, 350]) {
        for (const id of seatsOf(checkoutFloor()).map((s) => s.occupant.sessionId)) {
          const { renderer, env, view, canvas, events } = setup(dayTheme(reduced));
          view.setFloor(checkoutFloor());
          env.flush();
          view.on('select', (picked) => view.select(picked, { pan: true }));
          doubleClick(env, canvas, deskPoint(renderer, id), gap);
          expect([reduced, gap, events]).toEqual([reduced, gap, [`select desk ${id}`, `select desk ${id}`, `activate desk ${id}`]]);
          // The double-click took the desk's pane: the camera stays where it was.
          env.wait(DOUBLE_CLICK_MS);
          env.flush();
          expect([reduced, gap, id, cameraPose(renderer).zoom]).toEqual([reduced, gap, id, 1]);
        }
      }
    }
  });

  it('pans to a desk its own click selected once a second click can no longer come', () => {
    // With motion: false no ambient frame is asked for, and the pan's is the only timer.
    const { renderer, env, view, canvas, events } = setup(dayTheme(), { motion: false });
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
    expect(events).toEqual(['select desk oa-c3']);
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
    expect(events).toEqual(['select desk oa-c3', 'select desk oa-c3', 'activate desk oa-c3', 'select null']);
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
    expect(events).toEqual(['select desk sw-a1', 'select desk sw-a1', 'activate desk sw-a1']);
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
    view.select(desk('oa-c3'));
    const e = enter();
    canvas.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    view.select(desk('gone'));
    canvas.dispatchEvent(enter());
    expect(events).toEqual(['activate desk oa-c3']);
    expect(canvas.tabIndex).toBe(0);
  });

  it('passes label clicks on as selections', () => {
    const { env, view, labels, events } = setup();
    view.setFloor(checkoutFloor());
    env.flush();
    (labels.querySelector('[data-session="sw-a1"]') as HTMLElement).click();
    expect(events).toEqual(['select desk sw-a1']);
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
    expect(events).toEqual(['select desk sw-b2']);
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

  it('hands the focus to the canvas when the focused tag leaves the view and no tag is left on it', () => {
    const { env, view, canvas, labels } = setup();
    canvas.tabIndex = -1;
    // Two desks at the far ends of a wide floor: zoomed in on its centre, neither is on the view.
    const floor = makeFloor([{ key: '/demo/repo', repo: 'repo', color: 1, tie: 4, desks: [{ id: 'd1', state: 'idle' }, { id: 'd2', state: 'idle' }] }]);
    const [first, second] = seatsOf(floor).map((s) => s.desk);
    first!.rect = { ...first!.rect, x: 0 };
    second!.rect = { ...second!.rect, x: 100 };
    floor.size = { w: 102, h: floor.size.h };
    view.setFloor(floor);
    env.flush();
    const tags = [...labels.querySelectorAll<HTMLElement>('[data-session]')];
    const tag = tags[0]!;
    tag.focus();
    expect(document.activeElement).toBe(tag);
    for (let i = 0; i < 12; i++) canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -1000, bubbles: true, cancelable: true }));
    env.flush();
    expect(tags.filter((t) => t.style.visibility === '')).toEqual([]);
    expect(document.activeElement).toBe(canvas);
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
    const seen: Array<Target | null> = [];
    const off = view.on('select', (target) => seen.push(target));
    click(canvas, deskPoint(renderer, 'oa-c3'));
    off();
    click(canvas, deskPoint(renderer, 'oa-c3'));
    expect(seen).toEqual([{ kind: 'desk', id: 'oa-c3' }]);
  });

  it('rings the selected desk and pans to it when asked, keeping the selection across floor updates', () => {
    const { renderer, env, view } = setup();
    view.setFloor(checkoutFloor());
    env.flush();
    view.select(desk('oa-c3'), { pan: true });
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

  it('marks no desk for a room target, and pans nowhere while the room is not on the floor', () => {
    const { renderer, env, view, canvas, events } = setup();
    view.setFloor(checkoutFloor());
    env.flush();
    view.select(desk('oa-c3'));
    env.flush();
    const ring = renderer.scene!.getObjectByName('selection')!;
    expect(ring.visible).toBe(true);
    view.select({ kind: 'room', id: 'wf_0000aaaa-001' }, { pan: true });
    env.flush();
    expect([ring.visible, cameraPose(renderer).zoom]).toEqual([false, 1]);
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(events).toEqual([]);
  });

  it('selects the room under a click, activates it on a double-click, and with Enter once it is selected', () => {
    const { renderer, env, view, canvas, events } = setup();
    view.setFloor(roomFloor());
    env.flush();
    const at = tablePoint(renderer, 0);
    click(canvas, at);
    canvas.dispatchEvent(new MouseEvent('dblclick', { clientX: at.x, clientY: at.y, detail: 2, bubbles: true }));
    click(canvas, tablePoint(renderer, 1));
    view.select(room(FIRST));
    const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    canvas.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(events).toEqual([`select room ${FIRST}`, `activate room ${FIRST}`, `select room ${SECOND}`, `activate room ${FIRST}`]);
  });

  it('selects a room from its tag, and shows a tag and a board for each room', () => {
    const { env, view, labels, events } = setup();
    view.setFloor(roomFloor());
    env.flush();
    expect([labels.querySelectorAll('.fv-room').length, labels.querySelectorAll('.fv-board').length]).toEqual([2, 2]);
    (labels.querySelector(`.fv-room[data-run="${SECOND}"]`) as HTMLElement).click();
    expect(events).toEqual([`select room ${SECOND}`]);
  });

  it('outlines and marks the room it selects, and pans to it as to a desk', () => {
    const { renderer, env, view, labels } = setup();
    const floor = roomFloor();
    view.setFloor(floor);
    env.flush();
    view.select(room(SECOND), { pan: true });
    env.flush();
    const outline = renderer.scene!.getObjectByName('room-selection')!;
    expect([outline.visible, renderer.scene!.getObjectByName('selection')!.visible]).toEqual([true, false]);
    expect(labels.querySelector(`.fv-room[data-run="${SECOND}"]`)!.classList.contains('fv-sel')).toBe(true);
    const t = tableCenter(floor.rooms[1]!.rect);
    const c = floorCenter(floor.size);
    const pose = cameraPose(renderer);
    expect(pose.zoom).toBe(DESK_ZOOM);
    expect(pose.target.x).toBeCloseTo(t.x + (c.x - t.x) * DESK_PULL, 6);
    expect(pose.target.z).toBeCloseTo(t.z + (c.z - t.z) * DESK_PULL, 6);
    view.select(null);
    expect(outline.visible).toBe(false);
  });

  it('pans to a room asked for before it opened, once it opens', () => {
    const { renderer, env, view } = setup();
    view.setFloor(checkoutFloor());
    env.flush();
    view.select(room(FIRST), { pan: true });
    env.flush();
    expect(cameraPose(renderer).zoom).toBe(1);
    const floor = roomFloor();
    view.setFloor(floor);
    env.flush();
    const t = tableCenter(floor.rooms[0]!.rect);
    const c = floorCenter(floor.size);
    expect(cameraPose(renderer).target.x).toBeCloseTo(t.x + (c.x - t.x) * DESK_PULL, 6);
    expect(renderer.scene!.getObjectByName('room-selection')!.visible).toBe(true);
  });

  it('frames the floor again from home as it grows, and keeps a camera the user moved where it looks, as large as it was', () => {
    const { renderer, env, view, canvas } = setup(dayTheme(true));
    const shown = () => {
      const c = renderer.camera as OrthographicCamera;
      return (c.top - c.bottom) / c.zoom;
    };
    const round = (values: number[]) => values.map((v) => Math.round(v * 1e6));
    const inView = (x: number, y: number, z: number) => {
      const p = new Vector3(x, y, z).project(renderer.camera!);
      return Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1;
    };
    view.setFloor(checkoutFloor());
    env.flush();
    // From home: rooms open in their slots and the camera stays; a third run widens the floor, and the camera frames all of it.
    view.setFloor(roomFloor());
    env.flush();
    expect(cameraPose(renderer).target.x).toBeCloseTo(floorCenter(checkoutFloor().size).x, 6);
    const rooms = widerFloor();
    view.setFloor(rooms);
    env.flush();
    const framed = cameraPose(renderer);
    expect(round([framed.target.x, framed.target.z, framed.zoom])).toEqual(round([floorCenter(rooms.size).x, floorCenter(rooms.size).z, 1]));
    expect(
      seatsOf(rooms).every(({ desk: d, occupant }) => {
        const a = labelAnchor(rooms, d, occupant);
        return inView(a.x, a.y, a.z);
      }),
    ).toBe(true);
    expect(rooms.rooms.every((r) => inView(tableCenter(r.rect).x, 0.78, tableCenter(r.rect).z))).toBe(true);
    view.setFloor(checkoutFloor());
    env.flush();
    expect(cameraPose(renderer).target.x).toBeCloseTo(floorCenter(checkoutFloor().size).x, 6);
    // Turned, the camera is no longer home: the floor widens under it, and it keeps its place, its turn and its scale.
    view.rotate(1);
    env.flush();
    const turned = cameraPose(renderer);
    const before = shown();
    view.setFloor(widerFloor());
    env.flush();
    const kept = cameraPose(renderer);
    expect(round([kept.target.x, kept.target.z, kept.azimuth, shown()])).toEqual(round([turned.target.x, turned.target.z, HOME_AZIMUTH + QUARTER, before]));
    // Panned to a desk, it stays on the desk when the floor narrows again.
    view.select(desk('oa-c3'), { pan: true });
    env.flush();
    const atDesk = cameraPose(renderer).target;
    const zoomed = shown();
    view.setFloor(checkoutFloor());
    env.flush();
    expect(round([cameraPose(renderer).target.x, cameraPose(renderer).target.z, shown()])).toEqual(round([atDesk.x, atDesk.z, zoomed]));
    // At the most zoomed in, a floor that grows shows a little more of itself.
    for (let i = 0; i < 20; i++) canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -500, bubbles: true, cancelable: true }));
    env.flush();
    expect(cameraPose(renderer).zoom).toBe(MAX_ZOOM);
    const most = shown();
    view.setFloor(widerFloor());
    env.flush();
    expect(cameraPose(renderer).zoom).toBe(MAX_ZOOM);
    expect(shown()).toBeGreaterThan(most);
  });

  it('pans to a desk asked for before the floor arrived, once it arrives', () => {
    const { renderer, env, view } = setup();
    env.flush();
    view.select(desk('oa-c3'), { pan: true });
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

  it('stops a pan at the edge of the floor, also while it glides', () => {
    const { renderer, env, view, canvas } = setup();
    const { w, h } = checkoutFloor().size;
    view.setFloor(checkoutFloor());
    env.flush();
    for (const [dx, dy] of [[3000, 0], [-3000, -3000], [0, 3000]] as const) {
      drag(canvas, dx, dy, 2);
      env.flush();
      const t = cameraPose(renderer).target;
      expect([dx, dy, t.x > -1e-6 && t.x < w + 1e-6 && t.z > -1e-6 && t.z < h + 1e-6]).toEqual([dx, dy, true]);
      expect(Math.min(t.x, t.z, w - t.x, h - t.z)).toBeCloseTo(0, 6);
    }
    // A floor that shrinks away from where the camera looks takes the camera back to its edge.
    const checkouts = checkoutSpecs();
    for (const n of [1, 2, 3, 4]) checkouts.push({ key: `/demo/more-${n}`, repo: 'more', color: 5, tie: 4, desks: [{ id: `m${n}`, state: 'working' }] });
    const grown = makeFloor(checkouts);
    view.setFloor(grown);
    view.select(desk('m4'), { pan: true });
    env.flush();
    expect(cameraPose(renderer).target.z).toBeGreaterThan(h);
    view.setFloor(checkoutFloor());
    env.flush();
    expect(cameraPose(renderer).target.z).toBeCloseTo(h, 6);
  });

  it('ends a turn or a reset exactly where it should, even right after a drag still gliding', () => {
    const { renderer, env, view, canvas } = setup();
    const floor = checkoutFloor();
    view.setFloor(floor);
    env.flush();
    drag(canvas, -100, 0, 0);
    env.step(16);
    env.step(16);
    view.rotate(1);
    env.flush();
    const turned = (cameraPose(renderer).azimuth - HOME_AZIMUTH) / QUARTER;
    expect(turned).toBeCloseTo(Math.round(turned), 6);
    drag(canvas, 120, 60, 2);
    env.step(16);
    view.resetView();
    env.flush();
    expect(cameraPose(renderer).target.x).toBeCloseTo(floorCenter(floor.size).x, 6);
    expect(cameraPose(renderer).target.z).toBeCloseTo(floorCenter(floor.size).z, 6);
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

  it('tilts on a drag up or down, about the ground point at the centre of the view, within its limits', () => {
    const { renderer, env, view, canvas } = setup(dayTheme(true));
    view.setFloor(checkoutFloor());
    env.flush();
    const home = cameraPose(renderer);
    expect(home.polar).toBeCloseTo(POLAR, 6);
    drag(canvas, 0, 60, 0);
    env.flush();
    const tilted = cameraPose(renderer);
    expect(tilted.polar).not.toBeCloseTo(POLAR, 2);
    expect(tilted.azimuth).toBeCloseTo(home.azimuth, 6);
    expect(tilted.target.x).toBeCloseTo(home.target.x, 6);
    expect(tilted.target.z).toBeCloseTo(home.target.z, 6);
    drag(canvas, 0, 3000, 0);
    env.flush();
    const one = cameraPose(renderer).polar;
    drag(canvas, 0, -6000, 0);
    env.flush();
    const other = cameraPose(renderer).polar;
    expect([Math.min(one, other), Math.max(one, other)].map((p) => Math.round(p * 1e6))).toEqual([MIN_POLAR, MAX_POLAR].map((p) => Math.round(p * 1e6)));
  });

  it('keeps the tilt through a floor update, a turn and a pan to a desk, and resets it home', () => {
    const { renderer, env, view, canvas } = setup();
    view.setFloor(checkoutFloor());
    env.flush();
    drag(canvas, 0, 60, 0);
    env.step(16);
    env.step(16);
    // A turn asked for while the tilt still glides keeps the tilt where the glide stopped.
    view.rotate(1);
    env.flush();
    const tilt = cameraPose(renderer).polar;
    expect(tilt).not.toBeCloseTo(POLAR, 2);
    expect(cameraPose(renderer).azimuth).toBeCloseTo(HOME_AZIMUTH + QUARTER, 6);
    view.rotate(-1);
    env.flush();
    // Tilted, the camera is no longer home: a floor that grows keeps the tilt.
    view.setFloor(widerFloor());
    env.flush();
    expect(cameraPose(renderer).polar).toBeCloseTo(tilt, 6);
    const before = cameraPose(renderer).target;
    view.select(desk('oa-c3'), { pan: true });
    env.flush();
    expect(Math.hypot(cameraPose(renderer).target.x - before.x, cameraPose(renderer).target.z - before.z)).toBeGreaterThan(1);
    expect(cameraPose(renderer).polar).toBeCloseTo(tilt, 6);
    view.resetView();
    env.flush();
    expect(cameraPose(renderer).polar).toBeCloseTo(POLAR, 6);
    expect(cameraPose(renderer).azimuth).toBeCloseTo(HOME_AZIMUTH, 6);
  });

  it('walks ahead while up is held on the floor, and draws on demand again once it is let go', () => {
    const { renderer, env, view, canvas } = setup(dayTheme(true));
    view.setFloor(checkoutFloor());
    env.flush();
    const before = cameraPose(renderer);
    expect(key(canvas, 'keydown', 'ArrowUp')).toBe(false);
    for (let i = 0; i < 10; i++) env.step(16);
    const ahead = cameraPose(renderer);
    // From home the camera looks north-west: ahead, both x and z fall.
    expect(ahead.target.x).toBeLessThan(before.target.x - 0.5);
    expect(ahead.target.z).toBeLessThan(before.target.z - 0.5);
    expect(ahead.target.x - before.target.x).toBeCloseTo(ahead.target.z - before.target.z, 6);
    expect([ahead.azimuth, ahead.polar, ahead.zoom].map((v) => v.toFixed(6))).toEqual([before.azimuth, before.polar, before.zoom].map((v) => v.toFixed(6)));
    // A held key repeats: it neither speeds the camera up nor stops it.
    expect(key(canvas, 'keydown', 'ArrowUp', { repeat: true })).toBe(false);
    key(canvas, 'keyup', 'ArrowUp');
    env.flush();
    expect(env.queue.size).toBe(0);
  });

  it('steers while left or right is held, and walks a curve with up and left together', () => {
    const { renderer, env, view, canvas } = setup(dayTheme(true));
    view.setFloor(checkoutFloor());
    env.flush();
    const home = cameraPose(renderer);
    key(canvas, 'keydown', 'ArrowRight');
    for (let i = 0; i < 10; i++) env.step(16);
    key(canvas, 'keyup', 'ArrowRight');
    env.flush();
    // Steering right turns the floor the way Q does, about the point the camera looks at.
    const right = cameraPose(renderer);
    expect(right.azimuth).toBeLessThan(HOME_AZIMUTH - 0.1);
    expect(right.target.x).toBeCloseTo(home.target.x, 6);
    expect(right.target.z).toBeCloseTo(home.target.z, 6);
    expect(env.queue.size).toBe(0);
    key(canvas, 'keydown', 'ArrowUp');
    key(canvas, 'keydown', 'ArrowLeft');
    for (let i = 0; i < 20; i++) env.step(16);
    key(canvas, 'keyup', 'ArrowLeft');
    key(canvas, 'keyup', 'ArrowUp');
    env.flush();
    const curved = cameraPose(renderer);
    expect(curved.azimuth).toBeGreaterThan(right.azimuth + 0.2);
    expect(Math.hypot(curved.target.x - right.target.x, curved.target.z - right.target.z)).toBeGreaterThan(0.5);
    expect(curved.polar).toBeCloseTo(POLAR, 6);
  });

  it('tilts while Shift and up or down are held, within the tilt limits, steps aside with Shift and left or right, and walks again once Shift is let go', () => {
    const { renderer, env, view, canvas } = setup(dayTheme(true));
    view.setFloor(checkoutFloor());
    env.flush();
    const home = cameraPose(renderer);
    key(canvas, 'keydown', 'Shift', { shiftKey: true });
    key(canvas, 'keydown', 'ArrowRight', { shiftKey: true });
    for (let i = 0; i < 10; i++) env.step(16);
    key(canvas, 'keyup', 'ArrowRight', { shiftKey: true });
    env.flush();
    // The right of the screen, from home: x grows and z falls; no turn.
    const aside = cameraPose(renderer);
    expect(aside.target.x).toBeGreaterThan(home.target.x + 0.5);
    expect(aside.target.z).toBeLessThan(home.target.z - 0.5);
    expect(aside.azimuth).toBeCloseTo(HOME_AZIMUTH, 6);
    key(canvas, 'keydown', 'ArrowUp', { shiftKey: true });
    for (let i = 0; i < 200; i++) env.step(16);
    const top = cameraPose(renderer);
    expect(top.polar).toBeCloseTo(MIN_POLAR, 6);
    expect(top.target.x).toBeCloseTo(aside.target.x, 6);
    key(canvas, 'keyup', 'Shift');
    for (let i = 0; i < 10; i++) env.step(16);
    const walked = cameraPose(renderer);
    expect(Math.hypot(walked.target.x - top.target.x, walked.target.z - top.target.z)).toBeGreaterThan(0.5);
    expect(walked.polar).toBeCloseTo(MIN_POLAR, 6);
    key(canvas, 'keyup', 'ArrowUp');
    key(canvas, 'keydown', 'ArrowDown', { shiftKey: true });
    for (let i = 0; i < 300; i++) env.step(16);
    key(canvas, 'keyup', 'ArrowDown', { shiftKey: true });
    env.flush();
    expect(cameraPose(renderer).polar).toBeCloseTo(MAX_POLAR, 6);
  });

  it('stops at the edge of the floor while an arrow is held', () => {
    const { renderer, env, view, canvas } = setup(dayTheme(true));
    const { w, h } = checkoutFloor().size;
    view.setFloor(checkoutFloor());
    env.flush();
    key(canvas, 'keydown', 'ArrowDown');
    for (let i = 0; i < 600; i++) env.step(16);
    key(canvas, 'keyup', 'ArrowDown');
    env.flush();
    const t = cameraPose(renderer).target;
    expect(t.x > -1e-6 && t.x < w + 1e-6 && t.z > -1e-6 && t.z < h + 1e-6).toBe(true);
    expect(Math.min(t.x, t.z, w - t.x, h - t.z)).toBeCloseTo(0, 6);
  });

  it('leaves arrows with Ctrl, Cmd or Alt to the browser, and stops when the floor or the window loses the focus or the page hides', () => {
    const { renderer, env, view, canvas } = setup(dayTheme(true));
    view.setFloor(checkoutFloor());
    env.flush();
    const home = cameraPose(renderer);
    for (const mods of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
      expect(key(canvas, 'keydown', 'ArrowLeft', mods)).toBe(true);
    }
    env.flush();
    expect(cameraPose(renderer)).toEqual(home);
    const halts = [
      () => canvas.dispatchEvent(new FocusEvent('blur')),
      () => window.dispatchEvent(new FocusEvent('blur')),
      // A key let go while Cmd is down sends no keyup on macOS: Cmd stops the move.
      () => key(canvas, 'keydown', 'Meta', { metaKey: true }),
    ];
    for (const halt of halts) {
      key(canvas, 'keydown', 'ArrowUp');
      env.step(16);
      env.step(16);
      halt();
      env.flush();
      const at = cameraPose(renderer);
      for (let i = 0; i < 5; i++) env.step(16);
      expect(cameraPose(renderer)).toEqual(at);
      expect(env.queue.size).toBe(0);
    }
  });

  it('takes the camera from a turn under way when an arrow is pressed', () => {
    const { renderer, env, view, canvas } = setup();
    view.setFloor(checkoutFloor());
    env.flush();
    view.rotate(1);
    for (let i = 0; i < 10; i++) env.step(16);
    key(canvas, 'keydown', 'ArrowUp');
    env.step(16);
    key(canvas, 'keyup', 'ArrowUp');
    env.flush();
    const turned = (cameraPose(renderer).azimuth - HOME_AZIMUTH) / QUARTER;
    expect(turned).toBeGreaterThan(0.01);
    expect(turned).toBeLessThan(0.99);
  });

  it('keeps the arrows for moving between tags while a tag has the focus', () => {
    const { renderer, env, view, labels } = setup(dayTheme(true));
    view.setFloor(checkoutFloor());
    env.flush();
    const home = cameraPose(renderer);
    const tag = labels.querySelector('[data-session="sw-b2"]') as HTMLElement;
    tag.focus();
    tag.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    expect(document.activeElement).not.toBe(tag);
    expect(document.activeElement?.closest('[data-session], [data-run]')).not.toBeNull();
    env.flush();
    expect(cameraPose(renderer)).toEqual(home);
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
    view.select(desk('oa-c3'), { pan: true });
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
    view.select(desk('oa-c3'));
    expect(env.queue.size).toBe(1);
    canvas.dispatchEvent(new Event('webglcontextlost'));
    expect(env.queue.size).toBe(0);
    view.select(desk('sw-a1'));
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

  it('draws at the pixel ratio of the screen, also after the window moves to another one', () => {
    const { renderer, env } = setup();
    env.flush();
    expect(renderer.ratios.at(-1)).toBe(1);
    env.ratio = 2;
    env.ratioChanged!();
    expect(renderer.ratios.at(-1)).toBe(2);
    expect(env.queue.size).toBe(1);
    env.ratio = 3;
    env.ratioChanged!();
    expect(renderer.ratios.at(-1)).toBe(2);
  });

  it('lets go of everything on dispose, once', () => {
    // Every listener added on the page, the canvas or the labels host, by the view or by what it uses, with the
    // listener function and the capture flag it was added with.
    type Added = { target: EventTarget; type: string; listener: unknown; capture: boolean };
    const added: Added[] = [];
    const capture = (options: unknown) => (typeof options === 'boolean' ? options : Boolean((options as AddEventListenerOptions | undefined)?.capture));
    // The prototype that owns addEventListener for the page's nodes (the DOM's own EventTarget).
    const ownerOf = (node: object): EventTarget => {
      let p: object | null = node;
      while (p && !Object.prototype.hasOwnProperty.call(p, 'addEventListener')) p = Object.getPrototypeOf(p);
      return p as EventTarget;
    };
    const dom = ownerOf(document.createElement('canvas'));
    const add = dom.addEventListener;
    const remove = dom.removeEventListener;
    const addSpy = vi.spyOn(dom, 'addEventListener').mockImplementation(function (this: EventTarget, type, listener, options) {
      if (listener) added.push({ target: this, type, listener, capture: capture(options) });
      return add.call(this, type, listener, options);
    });
    const removeSpy = vi.spyOn(dom, 'removeEventListener').mockImplementation(function (this: EventTarget, type, listener, options) {
      const at = added.findIndex((a) => a.target === this && a.type === type && a.listener === listener && a.capture === capture(options));
      if (at >= 0) added.splice(at, 1);
      return remove.call(this, type, listener, options);
    });
    const controlsDispose = vi.spyOn(OrbitControls.prototype, 'dispose');
    const worldDispose = vi.spyOn(FloorScene.prototype, 'dispose');
    try {
      const { canvas, labels, renderer, env, view, events } = setup();
      const mine = (a: Added) => a.target === document || a.target === canvas || a.target === labels;
      view.setFloor(checkoutFloor());
      env.flush();
      view.on('select', (picked) => view.select(picked, { pan: true }));
      click(canvas, deskPoint(renderer, 'oa-c3'));
      events.length = 0;
      expect(added.filter(mine).length).toBeGreaterThan(0);
      view.dispose();
      view.dispose();
      expect(added.filter(mine).map((a) => `${a.target === document ? 'document' : a.target === canvas ? 'canvas' : 'labels'} ${a.type}`)).toEqual([]);
      expect(controlsDispose).toHaveBeenCalledTimes(1);
      expect(worldDispose).toHaveBeenCalledTimes(1);
      expect(renderer.disposed).toBe(1);
      expect(renderer.contextLost).toBe(1);
      expect(env.queue.size).toBe(0);
      expect(env.timers.size).toBe(0);
      expect(env.watching).toBe(false);
      expect(env.ratioChanged).toBeNull();
      expect(labels.children).toHaveLength(0);
      click(canvas, { x: 400, y: 250 });
      view.select(desk('oa-c3'));
      expect(env.queue.size).toBe(0);
      expect(events).toEqual([]);
    } finally {
      addSpy.mockRestore();
      removeSpy.mockRestore();
      controlsDispose.mockRestore();
      worldDispose.mockRestore();
    }
  });
});

describe('robots walking in the floor view', () => {
  /** The checkout floor with sw-c3, idle, resting on lounge seat 2. */
  function loungeFloor() {
    const checkouts = checkoutSpecs();
    checkouts[0]!.desks[2] = { ...checkouts[0]!.desks[2]!, lounge: 2 };
    return makeFloor(checkouts);
  }
  const lounge = loungeFloor();
  const sofa = loungeSpots(lounge.lounge.rect)[2]!;
  const seat = seatSpot(seatOf(checkoutFloor(), 'sw-c3').desk);
  /** Where sw-c3's robot stands in the scene the view last drew. */
  const robot = (renderer: FakeRenderer) => {
    const p = renderer.scene!.getObjectByName('robot sw-c3')!.position;
    return [p.x, p.z];
  };

  /** A view that shows the checkout floor, then the lounge floor, where sw-c3 walks to the lounge: what is drawn a frame later. */
  function second(theme = dayTheme(), opts?: ViewOptions, snap?: boolean) {
    const { renderer, env, view } = setup(theme, opts);
    view.setFloor(checkoutFloor());
    env.flush();
    view.setFloor(lounge, snap === undefined ? undefined : { snap });
    env.step();
    return { renderer, env, view };
  }

  it('puts every robot in its place at once on the first floor', () => {
    const { renderer, env, view } = setup();
    view.setFloor(lounge);
    env.step();
    expect(robot(renderer)).toEqual([sofa.x, sofa.z]);
  });

  it('walks a robot to its new place on a later floor, drawing every frame until all are still', () => {
    const { renderer, env, view } = setup();
    view.setFloor(lounge);
    env.flush();
    expect(env.queue.size).toBe(0);
    const start = env.now();
    view.setFloor(checkoutFloor());
    const back = startTrip(sofa, findPath(walkGrid(lounge), sofa, seat), start, WALK_SPEED);
    env.step(500);
    expect(robot(renderer)).toEqual([tripAt(back, start + 500).x, tripAt(back, start + 500).z]);
    expect(env.queue.size).toBe(1);
    const drawn = renderer.renders;
    env.flush(16, 1000);
    expect(robot(renderer)).toEqual([seat.x, seat.z]);
    expect(env.queue.size).toBe(0);
    expect(renderer.renders - drawn).toBe(Math.ceil((tripEnd(back) - start - 500) / 16));
  });

  it('puts every robot in its place at once for a floor given with snap', () => {
    const { renderer, env } = second(dayTheme(), undefined, true);
    expect(robot(renderer)).toEqual([sofa.x, sofa.z]);
    expect(env.queue.size).toBe(0);
    // Without it, the same floor walks.
    const walks = second(dayTheme(), undefined, false);
    expect(robot(walks.renderer)).not.toEqual([sofa.x, sofa.z]);
  });

  it('puts every robot in its place at once with motion: false', () => {
    const { renderer, env } = second(dayTheme(), { motion: false });
    expect(robot(renderer)).toEqual([sofa.x, sofa.z]);
    expect(env.queue.size).toBe(0);
  });

  it('puts every robot in its place at once under reduced motion, and those on their way when motion turns reduced', () => {
    const { renderer, env } = second(dayTheme(true));
    expect(robot(renderer)).toEqual([sofa.x, sofa.z]);
    expect(env.queue.size).toBe(0);
    const walking = second();
    walking.env.step(300);
    expect(robot(walking.renderer)).not.toEqual([sofa.x, sofa.z]);
    walking.view.setTheme(dayTheme(true));
    walking.env.step();
    expect(robot(walking.renderer)).toEqual([sofa.x, sofa.z]);
    expect(walking.env.queue.size).toBe(0);
  });

  it('puts the robots of a floor given while the page is hidden in their places', () => {
    const { renderer, env, view } = setup();
    view.setFloor(checkoutFloor());
    env.flush();
    env.isHidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    view.setFloor(lounge);
    env.isHidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    env.step();
    expect(robot(renderer)).toEqual([sofa.x, sofa.z]);
    expect(env.queue.size).toBe(0);
  });

  it('puts the robots on their way in their places when the page shows again, and draws the shadows once more', () => {
    const { renderer, env } = second();
    env.step(300);
    const shadows = renderer.shadowDraws;
    env.isHidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    env.wait(400);
    env.isHidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    env.step();
    expect(robot(renderer)).toEqual([sofa.x, sofa.z]);
    expect([env.queue.size, renderer.shadowDraws]).toEqual([0, shadows + 1]);
  });

  it('draws nothing while the elevator doors are held open after a robot leaves, and wakes to draw them closing', () => {
    const { renderer, env, view } = setup();
    // Robots in meetings run no loop: nothing else draws while the doors are held open.
    const floor = makeFloor(meetingSpecs());
    view.setFloor(floor);
    env.flush();
    const leaves = meetingSpecs();
    leaves[1]!.desks.pop();
    const from = seatSpot(seatOf(floor, 'oa-d5').desk);
    const pass = tripEnd(startTrip(from, findPath(walkGrid(floor), from, elevatorSpot(floor.core)), env.now(), WALK_SPEED));
    view.setFloor(makeFloor(leaves));
    env.flush(16, 1000);
    // The frame that saw it gone into the elevator is the last one, and one more is asked for when the doors start to close.
    expect(env.now() - pass).toBeGreaterThanOrEqual(0);
    expect(env.now() - pass).toBeLessThan(16);
    expect([env.queue.size, env.timers.size]).toEqual([0, 1]);
    const drawn = renderer.renders;
    env.wait(pass + DOOR_HOLD_MS - env.now() - 20);
    expect([renderer.renders, env.queue.size]).toEqual([drawn, 0]);
    env.wait(40);
    expect(env.queue.size).toBe(1);
    // Every frame while they close, and none once they are shut.
    expect(env.flush(16, 1000)).toBe(Math.ceil((DOOR_MS - 20) / 16));
    expect([env.queue.size, env.timers.size]).toEqual([0, 0]);
  });

  it('draws the shadow map once as robots set off and once in each frame where some come to rest, whatever the frames between', () => {
    const { renderer, env, view } = setup();
    view.setFloor(checkoutFloor());
    env.flush();
    expect(renderer.shadowDraws).toBe(1);
    const grid = walkGrid(lounge);
    const walkEnd = (from: { x: number; z: number }, to: { x: number; z: number }) => tripEnd(startTrip(from, findPath(grid, from, to), 0, WALK_SPEED));
    /** Standing up from a desk's chair is one straight step. */
    const upEnd = (d: Parameters<typeof seatSpot>[0]) => tripEnd(startTrip(seatSpot(d), [standSpot(d)], 0, WALK_SPEED));
    /** The shadow maps drawn from a floor update until all is still again, after a jump back to the checkout floor. */
    const draws = (floor: ReturnType<typeof checkoutFloor>, from = checkoutFloor()) => {
      view.setFloor(from, { snap: true });
      env.flush();
      const before = renderer.shadowDraws;
      view.setFloor(floor);
      env.flush(16, 1000);
      expect(env.queue.size).toBe(0);
      return renderer.shadowDraws - before;
    };
    // One walk: as it sets off, and as it sits down.
    expect(draws(lounge)).toBe(2);
    // Two walks that end in different frames: as they set off, and as each comes to rest.
    const apart = checkoutSpecs();
    apart[0]!.desks[0]!.state = 'needs_you';
    apart[0]!.desks[2] = { ...apart[0]!.desks[2]!, lounge: 2 };
    const a1 = seatOf(checkoutFloor(), 'sw-a1').desk;
    expect(walkEnd(seat, sofa) - upEnd(a1)).toBeGreaterThan(32);
    expect(draws(makeFloor(apart))).toBe(3);
    // Two robots side by side in a row of desks that stand up in the same frame: as they set off, and as both stand.
    const seated = checkoutSpecs();
    seated[0]!.desks[1]!.state = 'working';
    const both = checkoutSpecs();
    both[0]!.desks[0]!.state = 'needs_you';
    both[0]!.desks[1]!.state = 'needs_you';
    const b2 = seatOf(checkoutFloor(), 'sw-b2').desk;
    expect([a1.chair, b2.chair, b2.rect.y]).toEqual([a1.chair, a1.chair, a1.rect.y]);
    expect(upEnd(a1)).toBeCloseTo(upEnd(b2), 6);
    expect(draws(makeFloor(both), makeFloor(seated))).toBe(2);
  });

  it('draws the shadow map once for a robot that leaves, once more for one that comes as it reaches its place, and no more for an intern', () => {
    const { renderer, env, view } = setup();
    view.setFloor(checkoutFloor());
    env.flush();
    const draws = (floor: ReturnType<typeof checkoutFloor>) => {
      const before = renderer.shadowDraws;
      view.setFloor(floor);
      env.flush(16, 1000);
      expect(env.queue.size).toBe(0);
      return renderer.shadowDraws - before;
    };
    const leaves = checkoutSpecs();
    leaves[1]!.desks.pop();
    expect(draws(makeFloor(leaves))).toBe(1);
    expect(draws(checkoutFloor())).toBe(2);
    const flies = checkoutSpecs();
    flies[0]!.desks[0] = { ...flies[0]!.desks[0]!, interns: [{ agentId: 'i1', type: 'Explore', label: null, running: true }] };
    expect(draws(makeFloor(flies))).toBe(1);
    expect(draws(checkoutFloor())).toBe(1);
  });

  it('tells its moving listeners true as robots set off and false once all is still, and nothing for the camera alone or a floor that jumps', () => {
    const { env, view } = setup();
    const said: boolean[] = [];
    view.on('moving', (m) => said.push(m));
    view.setFloor(checkoutFloor());
    env.flush();
    expect(said).toEqual([]);
    view.setFloor(lounge);
    expect(said).toEqual([true]);
    env.step(500);
    expect(said).toEqual([true]);
    env.flush(16, 1000);
    expect(said).toEqual([true, false]);
    view.rotate(1);
    env.flush();
    view.setFloor(checkoutFloor(), { snap: true });
    env.flush();
    expect(said).toEqual([true, false]);
    // Hidden half way, shown again: all is in its place, and still.
    view.setFloor(lounge);
    env.step(300);
    env.isHidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    env.isHidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(said).toEqual([true, false, true, false]);
    // A robot that leaves: it walks out, the doors stand open, then they close.
    said.length = 0;
    const leaves = checkoutSpecs();
    leaves[1]!.desks.pop();
    view.setFloor(makeFloor(leaves));
    env.flush(16, 1000);
    expect(said).toEqual([true, false]);
    env.wait(DOOR_HOLD_MS);
    env.flush(16, 1000);
    expect(said).toEqual([true, false, true, false]);
  });

  it("hangs a walking robot's tag over it frame by frame, rings it where it is, and lets a click pick it on its way", () => {
    const { renderer, env, view, canvas, labels, events } = setup();
    view.setFloor(checkoutFloor());
    env.flush();
    view.select(desk('sw-c3'));
    view.setFloor(lounge);
    env.step(1200);
    const robot = renderer.scene!.getObjectByName('robot sw-c3')!.position;
    const there = startTrip(seat, findPath(walkGrid(lounge), seat, sofa), env.now() - 1200, WALK_SPEED);
    expect([robot.x, robot.z]).toEqual([tripAt(there, env.now()).x, tripAt(there, env.now()).z]);
    const tag = labels.querySelector('[data-session="sw-c3"]') as HTMLElement;
    const p = projectToScreen({ x: robot.x, y: LABEL_Y.standing, z: robot.z }, renderer.camera!, W, H);
    expect(tag.style.transform).toBe(`translate(${p.x}px, ${p.y}px) translate(-50%, -100%)`);
    const ring = renderer.scene!.getObjectByName('selection')!;
    expect([ring.visible, ring.position.x, ring.position.z]).toEqual([true, robot.x, robot.z]);
    // A click on its head picks its session.
    click(canvas, screenOf(renderer, robot.x, 0.9, robot.z));
    expect(events).toEqual(['select desk sw-c3']);
    env.flush(16, 1000);
    const q = projectToScreen(labelAnchor(lounge, seatOf(lounge, 'sw-c3').desk, seatOf(lounge, 'sw-c3').occupant), renderer.camera!, W, H);
    expect(tag.style.transform).toBe(`translate(${q.x}px, ${q.y}px) translate(-50%, -100%)`);
    expect([ring.position.x, ring.position.z]).toEqual([sofa.x, sofa.z]);
  });
});

describe('ambient frames in the floor view', () => {
  /** The pivots poseRobot sets on a robot's limbs, in the scene the view last drew: the arms, the neck and the lean. */
  const limbs = (renderer: FakeRenderer, id: string) => {
    // robot.ts builds the legs, then the waist; on the waist, the left arm, the right arm, then the neck.
    const waist = renderer.scene!.getObjectByName(`robot ${id}`)!.children[2]!;
    const [armL, armR, neck] = waist.children;
    return [armL!.rotation.x, armL!.rotation.z, armR!.rotation.x, armR!.rotation.z, neck!.rotation.x, waist.rotation.x];
  };
  /** The same pivots of a robot in the pose of its look. */
  const pose = (look: Parameters<typeof poseOf>[0]) => {
    const spec = poseOf(look);
    return [spec.armL[0], spec.armL[1], spec.armR[0], spec.armR[1], spec.neck, spec.lean];
  };
  /** Every session's robot on the checkout floor, and the look it rests in. */
  const LOOKS = [
    ['sw-a1', { pose: 'typing', badge: 'typing' }],
    ['sw-b2', { pose: 'holding', badge: 'done' }],
    ['sw-c3', { pose: 'resting', badge: null }],
    ['oa-c3', { pose: 'waving', badge: 'needs' }],
    ['oa-d5', { pose: 'still', badge: 'clock' }],
    ['ps-d4', { pose: 'still', badge: 'meeting' }],
  ] as const;
  /** Lets `steps` display frames of 16 ms pass; returns when the view drew in them. */
  function run(env: FakeEnv, renderer: FakeRenderer, steps = 60): number[] {
    const drawn: number[] = [];
    for (let k = 0; k < steps; k++) {
      const before = renderer.renders;
      env.step(16);
      if (renderer.renders > before) drawn.push(env.now());
    }
    return drawn;
  }
  /** The time between each two frames drawn. */
  const gaps = (times: number[]) => times.slice(1).map((t, k) => t - times[k]!);

  it('draws a frame every AMBIENT_MS while robots run their loops at rest, 20 in 60 display frames, and the shadow map for none', () => {
    const { renderer, env, view } = setup();
    view.setFloor(checkoutFloor());
    env.flush();
    // Asked for AMBIENT_EARLY_MS sooner, the next frame lands on the display frame AMBIENT_MS on rather than the one after.
    expect(env.queue.size).toBe(0);
    expect([...env.timers.values()].map((t) => t.at - env.now())).toEqual([AMBIENT_MS - AMBIENT_EARLY_MS]);
    const shadows = renderer.shadowDraws;
    const typing = new Set<number>();
    const drawn: number[] = [];
    for (let k = 0; k < 60; k++) {
      const before = renderer.renders;
      env.step(16);
      if (renderer.renders === before) continue;
      drawn.push(env.now());
      typing.add(limbs(renderer, 'sw-a1')[0]!);
    }
    expect(drawn).toHaveLength(20);
    expect(new Set(gaps(drawn))).toEqual(new Set([48]));
    expect(renderer.shadowDraws).toBe(shadows);
    // Each frame finds the typing robot's arm somewhere else.
    expect(typing.size).toBe(20);
  });

  it('asks for the next ambient frame AMBIENT_MS after the last one began, however long drawing it took', () => {
    const { renderer, env, view } = setup();
    view.setFloor(checkoutFloor());
    env.flush();
    // Drawing now takes 20 ms.
    const render = renderer.render.bind(renderer);
    renderer.render = (scene, camera) => {
      env.time += 20;
      render(scene, camera);
    };
    view.select(desk('sw-a1'));
    env.step(16);
    const began = env.now() - 20;
    expect([...env.timers.values()].map((t) => t.at - began)).toEqual([AMBIENT_MS - AMBIENT_EARLY_MS]);
  });

  it('draws every display frame while a robot walks, and ambient frames again once all is still', () => {
    const { renderer, env, view } = setup();
    // sw-c3, idle, rests on lounge seat 2, then walks back to its desk.
    const checkouts = checkoutSpecs();
    checkouts[0]!.desks[2] = { ...checkouts[0]!.desks[2]!, lounge: 2 };
    const lounge = makeFloor(checkouts);
    view.setFloor(lounge);
    env.flush();
    const moving: boolean[] = [];
    view.on('moving', (m) => moving.push(m));
    const start = env.now();
    view.setFloor(checkoutFloor());
    const sofa = loungeSpots(lounge.lounge.rect)[2]!;
    const back = startTrip(sofa, findPath(walkGrid(lounge), sofa, seatSpot(seatOf(checkoutFloor(), 'sw-c3').desk)), start, WALK_SPEED);
    const walking = Math.floor((tripEnd(back) - start) / 16);
    expect(gaps(run(env, renderer, walking))).toEqual(new Array(walking - 1).fill(16));
    env.flush(16, 1000);
    expect([env.queue.size, env.timers.size, moving]).toEqual([0, 1, [true, false]]);
    expect(run(env, renderer)).toHaveLength(20);
    expect(moving).toEqual([true, false]);
  });

  it('wakes for the elevator doors as they start to close between two ambient frames, draws every frame while they close, then ambient frames again', () => {
    const { renderer, env, view } = setup();
    view.setFloor(checkoutFloor());
    env.flush();
    const leaves = checkoutSpecs();
    leaves[1]!.desks.pop();
    const from = seatSpot(seatOf(checkoutFloor(), 'oa-d5').desk);
    const pass = tripEnd(startTrip(from, findPath(walkGrid(checkoutFloor()), from, elevatorSpot(checkoutFloor().core)), env.now(), WALK_SPEED));
    const closing = pass + DOOR_HOLD_MS;
    const shut = closing + DOOR_MS;
    const moving: boolean[] = [];
    view.on('moving', (m) => moving.push(m));
    view.setFloor(makeFloor(leaves));
    env.flush(16, 1000);
    expect(moving).toEqual([true, false]);
    const shadows = renderer.shadowDraws;
    // While the doors are held open, ambient frames.
    const held = run(env, renderer, Math.floor((closing - env.now()) / 16));
    expect(new Set(gaps(held))).toEqual(new Set([48]));
    const last = held.at(-1)!;
    // The doors start to close before the next ambient frame would come: the view wakes for them instead.
    expect(closing - last).toBeLessThan(AMBIENT_MS - AMBIENT_EARLY_MS);
    expect([...env.timers.values()].map((t) => t.at)).toEqual([closing]);
    const after = run(env, renderer, Math.ceil((shut - env.now()) / 16) + 12);
    expect(after[0]! - closing).toBeGreaterThanOrEqual(0);
    expect(after[0]! - closing).toBeLessThan(16);
    const closed = after.findIndex((t) => t >= shut);
    expect(new Set(gaps(after.slice(0, closed + 1)))).toEqual(new Set([16]));
    expect(new Set(gaps(after.slice(closed)))).toEqual(new Set([48]));
    expect(moving).toEqual([true, false, true, false]);
    expect(renderer.shadowDraws).toBe(shadows);
  });

  it('draws no ambient frame and asks for none while the page is hidden or the context lost, and goes on once they are back', () => {
    const { renderer, env, view, canvas } = setup();
    view.setFloor(checkoutFloor());
    env.flush();
    env.isHidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(env.timers.size).toBe(0);
    expect(run(env, renderer)).toEqual([]);
    env.isHidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(run(env, renderer)).toHaveLength(20);
    canvas.dispatchEvent(new Event('webglcontextlost'));
    expect(env.timers.size).toBe(0);
    expect(run(env, renderer)).toEqual([]);
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(run(env, renderer)).toHaveLength(20);
  });

  it('draws no ambient frame under reduced motion or with motion: false, where every robot keeps the pose of its look', () => {
    for (const [theme, opts] of [[dayTheme(true), undefined], [dayTheme(), { motion: false }]] as const) {
      const { renderer, env, view } = setup(theme, opts);
      view.setFloor(checkoutFloor());
      env.flush();
      expect([env.queue.size, env.timers.size]).toEqual([0, 0]);
      expect(run(env, renderer)).toEqual([]);
      // A frame drawn for another reason, at any time, finds them in their poses.
      env.wait(1234);
      view.select(desk('sw-a1'));
      env.step(16);
      for (const [id, look] of LOOKS) expect(limbs(renderer, id), `${id} ${JSON.stringify(opts)}`).toEqual(pose(look));
      expect([env.queue.size, env.timers.size]).toEqual([0, 0]);
    }
  });

  it('puts every robot back in its pose and stops drawing when motion turns reduced, and runs the loops again when it no longer is', () => {
    const { renderer, env, view } = setup();
    view.setFloor(checkoutFloor());
    env.flush();
    run(env, renderer, 10);
    expect(limbs(renderer, 'sw-a1')).not.toEqual(pose(LOOKS[0][1]));
    view.setTheme(dayTheme(true));
    env.step(16);
    for (const [id, look] of LOOKS) expect(limbs(renderer, id), id).toEqual(pose(look));
    expect([env.queue.size, env.timers.size]).toEqual([0, 0]);
    expect(run(env, renderer)).toEqual([]);
    view.setTheme(dayTheme());
    expect(run(env, renderer)).toHaveLength(20);
    expect(limbs(renderer, 'sw-a1')).not.toEqual(pose(LOOKS[0][1]));
  });

  it('draws no ambient frame for a floor with no robot, or with only hosts in meetings, who run no loop', () => {
    const away = checkoutSpecs();
    for (const c of away) for (const d of c.desks) d.state = 'dormant';
    for (const floor of [makeFloor(away), makeFloor(meetingSpecs())]) {
      const { renderer, env, view } = setup();
      view.setFloor(floor);
      env.flush();
      expect([env.queue.size, env.timers.size]).toEqual([0, 0]);
      expect(run(env, renderer)).toEqual([]);
    }
  });
});
