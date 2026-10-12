/**
 * The floor view behind mountFloorView: camera, orbit controls, pointer and key input, labels and on-demand
 * rendering around a FloorScene. It takes the renderer and the browser services it uses as arguments, so tests
 * drive it with stand-ins; mountFloorView passes the real WebGLRenderer.
 *
 * Rendering is on demand: a frame is drawn after a camera move, a floor or theme change, a selection, a resize,
 * and while the controls settle or a tween runs. Nothing is drawn while the page is hidden.
 */
import { OrthographicCamera, PCFShadowMap, type Camera, type Object3D, type ShadowMapType } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { MIN_SIZE } from '../../src/scene/layout';
import type { FloorDetail } from '../../src/scene/types';
import { MAX_ZOOM, MIN_ZOOM, PAN_MS, RESET_MS, ROTATE_MS, Tween, clampZoom, deskPose, homePose, stepAzimuth, type CameraPose } from './camera';
import { FloorScene } from './floor-scene';
import type { FloorView } from './index';
import { LabelLayer } from './labels';
import { pickSession, toNdc } from './pick';
import type { ThemeTokens } from './theme';
import { POLAR, azimuthOf, cameraOffset, frustumFor, type Point } from './world';

/** What the view needs of a three.js WebGLRenderer. */
export interface RendererLike {
  shadowMap: { enabled: boolean; type: ShadowMapType };
  setPixelRatio(ratio: number): void;
  setSize(width: number, height: number, updateStyle?: boolean): void;
  setClearColor(color: number, alpha?: number): void;
  render(scene: Object3D, camera: Camera): void;
  dispose(): void;
  /** Frees the WebGL context at once instead of waiting for garbage collection. */
  forceContextLoss?(): void;
}

/** The browser services the view uses. */
export interface ViewEnv {
  requestFrame(draw: (now: number) => void): number;
  cancelFrame(id: number): void;
  /** Same clock as the frame timestamps, in milliseconds. */
  now(): number;
  hidden(): boolean;
  pixelRatio(): number;
  /** Calls `changed` when the element's size changes; returns a function that stops watching. */
  observeResize(el: Element, changed: () => void): () => void;
  /** Runs `run` once, `ms` milliseconds from now; returns a function that cancels it. */
  later(ms: number, run: () => void): () => void;
}

export function browserEnv(): ViewEnv {
  return {
    requestFrame: (draw) => requestAnimationFrame(draw),
    cancelFrame: (id) => cancelAnimationFrame(id),
    now: () => performance.now(),
    hidden: () => document.visibilityState === 'hidden',
    pixelRatio: () => window.devicePixelRatio || 1,
    observeResize(el, changed) {
      if (typeof ResizeObserver === 'undefined') return () => {};
      const observer = new ResizeObserver(() => changed());
      observer.observe(el);
      return () => observer.disconnect();
    },
    later(ms, run) {
      const id = setTimeout(run, ms);
      return () => clearTimeout(id);
    },
  };
}

/** A press and release closer than this many pixels is a click; farther is a drag of the camera. */
export const DRAG_PX = 6;
/**
 * How long after a click a second one may still come. A pan to the desk the click selected waits this long, so the
 * desk is still under the pointer for the second click of a double-click.
 */
export const DOUBLE_CLICK_MS = 400;

type Listener = (sessionId: string | null) => void;

export function createFloorView(
  host: { canvas: HTMLCanvasElement; labels: HTMLElement },
  theme: ThemeTokens,
  renderer: RendererLike,
  env: ViewEnv = browserEnv(),
): FloorView {
  const { canvas } = host;
  const world = new FloorScene(theme);
  const camera = new OrthographicCamera(-10, 10, 10, -10, 0.1, 300);
  const controls = new OrbitControls(camera, canvas);
  controls.minPolarAngle = POLAR;
  controls.maxPolarAngle = POLAR;
  controls.minZoom = MIN_ZOOM;
  controls.maxZoom = MAX_ZOOM;
  controls.rotateSpeed = 0.6;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = true;
  controls.enableDamping = !theme.reducedMotion;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  renderer.setClearColor(0x000000, 0);

  const listeners = { select: new Set<Listener>(), activate: new Set<Listener>() };
  const emit = (event: 'select' | 'activate', sessionId: string | null) => {
    for (const fn of [...listeners[event]]) fn(sessionId);
  };
  const labels = new LabelLayer(host.labels, {
    select: (id, clicks) => {
      // A drag of the camera that started on the tag may end in a click on it: that click selects nothing.
      if (!(relayed && clicks > 0)) clickSelect(() => id, clicks);
    },
    activate: (id) => doubleClick(() => id),
  });

  let size = { ...MIN_SIZE };
  // A canvas's default size, until the first measure.
  let width = 300;
  let height = 150;
  let hasFloor = false;
  let selected: string | null = null;
  /** A desk the UI asked to pan to before it was on the floor; the pan happens when it arrives. */
  let panPending: string | null = null;
  let tween: Tween | null = null;
  let reduced = theme.reducedMotion;
  let frame = 0;
  let disposed = false;
  let down: { x: number; y: number } | null = null;
  /** What the last click selected, and when: the second click of a double-click and the double-click keep to it. */
  let clicked: { id: string | null; at: number } | null = null;
  /** Cancels a pan that waits for the end of a double-click. */
  let panLater: (() => void) | null = null;
  /** A press of the main button on a tag: a click if it ends there, a drag of the camera once it moves away. */
  let press: PointerEvent | null = null;
  /** The last press on a tag went on to the canvas as a drag. */
  let relayed = false;

  function pose(): CameraPose {
    const t = controls.target;
    return { target: { x: t.x, z: t.z }, azimuth: azimuthOf({ x: camera.position.x - t.x, z: camera.position.z - t.z }), zoom: camera.zoom };
  }

  function applyPose(p: CameraPose): void {
    const o = cameraOffset(p.azimuth);
    controls.target.set(p.target.x, 0, p.target.z);
    camera.position.set(p.target.x + o.x, o.y, p.target.z + o.z);
    camera.zoom = clampZoom(p.zoom);
    camera.lookAt(controls.target);
    camera.updateProjectionMatrix();
  }

  /**
   * Keeps the point the camera turns about on the ground. A pan moves the camera in the screen's plane, so the floor
   * follows the pointer, and a pan up or down the screen lifts that point off the ground: sliding it and the camera
   * back along the line of sight changes nothing an orthographic camera shows. Turns, drag turns and pose() then
   * all work about the ground point at the centre of the view.
   */
  function ground(): void {
    const t = controls.target;
    const p = camera.position;
    if (t.y === 0) return;
    const k = t.y / (p.y - t.y);
    const shift = { x: (t.x - p.x) * k, y: -t.y, z: (t.z - p.z) * k };
    t.add(shift);
    p.add(shift);
  }

  function onControls(): void {
    ground();
    request();
  }

  function moveTo(to: CameraPose, ms: number): void {
    tween = new Tween(pose(), to, env.now(), reduced ? 0 : ms);
    request();
  }

  function panTo(spot: Point): void {
    moveTo(deskPose(pose(), spot, size), PAN_MS);
  }

  function stopPanLater(): void {
    panLater?.();
    panLater = null;
  }

  function fit(): void {
    const f = frustumFor(size, width / height);
    camera.left = f.left;
    camera.right = f.right;
    camera.top = f.top;
    camera.bottom = f.bottom;
    camera.updateProjectionMatrix();
  }

  function request(): void {
    if (!frame && !disposed && !env.hidden()) frame = env.requestFrame(draw);
  }

  function draw(now: number): void {
    frame = 0;
    let again = false;
    if (tween) {
      applyPose(tween.at(now));
      if (tween.done(now)) tween = null;
      else again = true;
    }
    if (controls.update()) again = true;
    world.setAzimuth(pose().azimuth);
    renderer.render(world.scene, camera);
    labels.setScale((height * camera.zoom) / (camera.top - camera.bottom));
    labels.position(camera, width, height);
    if (again) request();
  }

  /** Takes the canvas's CSS size; a canvas without a layout box (hidden) keeps the last one. */
  function resize(): void {
    if (canvas.clientWidth > 0 && canvas.clientHeight > 0) {
      width = canvas.clientWidth;
      height = canvas.clientHeight;
    }
    renderer.setPixelRatio(Math.min(env.pixelRatio(), 2));
    renderer.setSize(width, height, false);
    fit();
    request();
  }

  function pickAt(clientX: number, clientY: number): string | null {
    const ndc = toNdc(clientX, clientY, canvas.getBoundingClientRect());
    if (!ndc) return null;
    world.scene.updateMatrixWorld();
    return pickSession(camera, ndc, world.pickables());
  }

  /**
   * A click that selects what `pick` names. The second click of a double-click selects what the first one did,
   * without looking again: the camera, and the desks with it, may have moved in between.
   */
  function clickSelect(pick: () => string | null, clicks: number): void {
    const id = clicks > 1 && clicked ? clicked.id : pick();
    // A click from the keyboard has no count, and starts no double-click.
    clicked = clicks > 0 ? { id, at: env.now() } : null;
    emit('select', id);
  }

  /** A double-click activates the desk its first click picked; one that follows no click, what `pick` names. */
  function doubleClick(pick: () => string | null): void {
    stopPanLater();
    const id = clicked && env.now() - clicked.at <= DOUBLE_CLICK_MS ? clicked.id : pick();
    clicked = null;
    if (id) emit('activate', id);
  }

  // Only the main button selects: the others pan the camera. A press takes the camera from any move under way.
  const onPointerDown = (e: PointerEvent) => {
    down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
    tween = null;
    stopPanLater();
  };
  // A browser clicks after a drag too, when it starts and ends on the canvas.
  const onClick = (e: MouseEvent) => {
    const start = down;
    down = null;
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) <= DRAG_PX) clickSelect(() => pickAt(e.clientX, e.clientY), e.detail);
    else clicked = null;
  };
  const onDoubleClick = (e: MouseEvent) => doubleClick(() => pickAt(e.clientX, e.clientY));

  /** Hands a press on a tag to the canvas, where the controls take it as the start of a drag. */
  function relay(e: PointerEvent): void {
    relayed = true;
    clicked = null;
    canvas.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        pointerId: e.pointerId,
        pointerType: e.pointerType,
        isPrimary: e.isPrimary,
        button: e.button,
        buttons: e.buttons,
        clientX: e.clientX,
        clientY: e.clientY,
        screenX: e.screenX,
        screenY: e.screenY,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
      }),
    );
  }

  // The tags lie over the canvas. The wheel, and drags that start on a tag, go on to the canvas, so the camera zooms,
  // turns and pans there too; only a click of the main button stays with the tag. Other buttons only ever drag.
  const onTagPointerDown = (e: PointerEvent) => {
    relayed = false;
    if (e.button === 0) press = e;
    else relay(e);
  };
  const onPointerMove = (e: PointerEvent) => {
    const start = press;
    if (!start || e.pointerId !== start.pointerId || Math.hypot(e.clientX - start.clientX, e.clientY - start.clientY) <= DRAG_PX) return;
    press = null;
    relay(start);
  };
  const onPointerEnd = (e: PointerEvent) => {
    if (press && e.pointerId === press.pointerId) press = null;
  };
  const onTagWheel = (e: WheelEvent) => {
    e.preventDefault();
    canvas.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        deltaZ: e.deltaZ,
        deltaMode: e.deltaMode,
        clientX: e.clientX,
        clientY: e.clientY,
        screenX: e.screenX,
        screenY: e.screenY,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
      }),
    );
  };
  const onTagMenu = (e: Event) => e.preventDefault();
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && selected !== null && world.desks.has(selected)) {
      e.preventDefault();
      emit('activate', selected);
    }
  };
  const onVisibility = () => {
    if (!env.hidden()) request();
    else if (frame) {
      env.cancelFrame(frame);
      frame = 0;
    }
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('click', onClick);
  canvas.addEventListener('dblclick', onDoubleClick);
  canvas.addEventListener('keydown', onKeyDown);
  if (!canvas.hasAttribute('tabindex')) canvas.tabIndex = 0;
  host.labels.addEventListener('pointerdown', onTagPointerDown);
  host.labels.addEventListener('wheel', onTagWheel, { passive: false });
  host.labels.addEventListener('contextmenu', onTagMenu);
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerEnd);
  document.addEventListener('pointercancel', onPointerEnd);
  document.addEventListener('visibilitychange', onVisibility);
  controls.addEventListener('change', onControls);
  const stopResize = env.observeResize(canvas, resize);
  applyPose(homePose(size));
  resize();

  function on(event: 'select', fn: (sessionId: string | null) => void): () => void;
  function on(event: 'activate', fn: (sessionId: string) => void): () => void;
  function on(event: 'select' | 'activate', fn: (sessionId: never) => void): () => void {
    const set = listeners[event];
    const listener = fn as Listener;
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  return {
    setFloor(floor: FloorDetail) {
      if (disposed) return;
      if (world.apply(floor)) {
        size = { ...floor.size };
        fit();
      }
      if (!hasFloor) {
        hasFloor = true;
        applyPose(homePose(size));
      }
      labels.sync(floor);
      world.setSelected(selected);
      labels.setSelected(selected);
      const spot = panPending === null ? null : world.focusPoint(panPending);
      if (spot) {
        panPending = null;
        panTo(spot);
      } else request();
    },
    setTheme(next: ThemeTokens) {
      if (disposed) return;
      reduced = next.reducedMotion;
      controls.enableDamping = !reduced;
      world.setTheme(next);
      request();
    },
    select(sessionId: string | null, opts?: { pan?: boolean }) {
      if (disposed) return;
      selected = sessionId;
      world.setSelected(sessionId);
      labels.setSelected(sessionId);
      stopPanLater();
      const pan = sessionId !== null && opts?.pan === true;
      const spot = pan ? world.focusPoint(sessionId) : null;
      panPending = pan && !spot ? sessionId : null;
      // A pan to the desk the view's own click just selected waits until a second click can no longer come.
      const wait = spot && clicked && clicked.id === sessionId ? clicked.at + DOUBLE_CLICK_MS - env.now() : 0;
      if (spot && wait > 0) {
        panLater = env.later(wait, () => {
          panLater = null;
          panTo(spot);
        });
        request();
      } else if (spot) panTo(spot);
      else request();
    },
    rotate(step: -1 | 1) {
      if (disposed) return;
      // A turn asked for during another goes on from where that one is heading.
      const p = tween ? tween.to : pose();
      moveTo({ ...p, azimuth: stepAzimuth(p.azimuth, step) }, ROTATE_MS);
    },
    resetView() {
      if (disposed) return;
      moveTo(homePose(size, pose().azimuth), RESET_MS);
    },
    on,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (frame) env.cancelFrame(frame);
      frame = 0;
      stopPanLater();
      stopResize();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('dblclick', onDoubleClick);
      canvas.removeEventListener('keydown', onKeyDown);
      host.labels.removeEventListener('pointerdown', onTagPointerDown);
      host.labels.removeEventListener('wheel', onTagWheel);
      host.labels.removeEventListener('contextmenu', onTagMenu);
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerEnd);
      document.removeEventListener('pointercancel', onPointerEnd);
      document.removeEventListener('visibilitychange', onVisibility);
      controls.removeEventListener('change', onControls);
      controls.dispose();
      listeners.select.clear();
      listeners.activate.clear();
      labels.dispose();
      world.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
    },
  };
}
