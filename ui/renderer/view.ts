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
import { POLAR, azimuthOf, cameraOffset, frustumFor } from './world';

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
  };
}

/** A press and release closer than this many pixels is a click; farther is a drag of the camera. */
export const DRAG_PX = 6;

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
    select: (id) => emit('select', id),
    activate: (id) => emit('activate', id),
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

  function moveTo(to: CameraPose, ms: number): void {
    tween = new Tween(pose(), to, env.now(), reduced ? 0 : ms);
    request();
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

  // Only the main button selects: the others pan the camera.
  const onPointerDown = (e: PointerEvent) => {
    down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
    tween = null;
  };
  const onPointerUp = (e: PointerEvent) => {
    const start = down;
    down = null;
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) <= DRAG_PX) emit('select', pickAt(e.clientX, e.clientY));
  };
  const onDoubleClick = (e: MouseEvent) => {
    const id = pickAt(e.clientX, e.clientY);
    if (id) emit('activate', id);
  };
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
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('dblclick', onDoubleClick);
  canvas.addEventListener('keydown', onKeyDown);
  if (!canvas.hasAttribute('tabindex')) canvas.tabIndex = 0;
  document.addEventListener('visibilitychange', onVisibility);
  controls.addEventListener('change', request);
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
        moveTo(deskPose(pose(), spot, size), PAN_MS);
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
      const pan = sessionId !== null && opts?.pan === true;
      const spot = pan ? world.focusPoint(sessionId) : null;
      panPending = pan && !spot ? sessionId : null;
      if (spot) moveTo(deskPose(pose(), spot, size), PAN_MS);
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
      stopResize();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('dblclick', onDoubleClick);
      canvas.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('visibilitychange', onVisibility);
      controls.removeEventListener('change', request);
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
