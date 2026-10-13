/**
 * The floor view behind mountFloorView: camera, orbit controls, pointer and key input, labels and on-demand
 * rendering around a FloorScene. It takes the renderer and the browser services it uses as arguments, so tests
 * drive it with stand-ins; mountFloorView passes the real WebGLRenderer.
 *
 * Rendering is on demand: a frame is drawn after a camera move, a floor or theme change, a selection, a resize,
 * and while the controls settle, a tween runs or an arrow key is held. Nothing is drawn while the page is hidden. The shadow map is drawn
 * only when the shadows can change: a new floor, a new theme, or a wall that comes or goes as the camera turns.
 * Nothing is drawn either while the WebGL context is lost; once the browser restores it, the floor is drawn again.
 */
import { OrthographicCamera, PCFShadowMap, type Camera, type Object3D, type ShadowMapType } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { MIN_SIZE } from '../../src/scene/layout';
import type { FloorDetail } from '../../src/scene/types';
import {
  MAX_POLAR,
  MAX_ZOOM,
  MIN_POLAR,
  MIN_ZOOM,
  PAN_MS,
  RESET_MS,
  ROTATE_MS,
  Tween,
  clampZoom,
  deskPose,
  homePose,
  keyPose,
  stepAzimuth,
  type CameraPose,
  type KeyMove,
} from './camera';
import { FloorScene } from './floor-scene';
import type { FloorView, Target } from './index';
import { LabelLayer } from './labels';
import { pickTarget, toNdc } from './pick';
import type { ThemeTokens } from './theme';
import { azimuthOf, cameraOffset, frustumFor, polarOf, sameTarget, type Point } from './world';

/** What the view needs of a three.js WebGLRenderer. */
export interface RendererLike {
  /** The view draws the shadow map only when the shadows can change: needsUpdate, with autoUpdate off. */
  shadowMap: { enabled: boolean; type: ShadowMapType; autoUpdate: boolean; needsUpdate: boolean };
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
  /** Calls `changed` when the pixel ratio changes (another screen, a page zoom); returns a function that stops watching. */
  watchPixelRatio(changed: () => void): () => void;
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
    watchPixelRatio(changed) {
      if (typeof matchMedia === 'undefined') return () => {};
      let query: MediaQueryList | null = null;
      const onChange = () => {
        watch();
        changed();
      };
      // A query matches one ratio only: after each change, it watches for the next.
      const watch = () => {
        query?.removeEventListener('change', onChange);
        query = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
        query.addEventListener('change', onChange);
      };
      watch();
      return () => query?.removeEventListener('change', onChange);
    },
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
 * How long after a click a second one may still come. A pan to the desk or room the click selected waits this long,
 * so it is still under the pointer for the second click of a double-click.
 */
export const DOUBLE_CLICK_MS = 400;
/** The longest step a held arrow takes in one frame, in milliseconds: a late frame does not jump the camera. */
export const KEY_STEP_MS = 50;
/** What each arrow adds to the move while it is held. */
const ARROWS: Readonly<Record<string, KeyMove>> = {
  ArrowUp: { forward: 1, right: 0 },
  ArrowDown: { forward: -1, right: 0 },
  ArrowLeft: { forward: 0, right: -1 },
  ArrowRight: { forward: 0, right: 1 },
};

type Listener = (target: Target | null) => void;

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
  controls.minPolarAngle = MIN_POLAR;
  controls.maxPolarAngle = MAX_POLAR;
  controls.minZoom = MIN_ZOOM;
  controls.maxZoom = MAX_ZOOM;
  controls.rotateSpeed = 0.6;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = true;
  controls.enableDamping = !theme.reducedMotion;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.setClearColor(0x000000, 0);

  const listeners = { select: new Set<Listener>(), activate: new Set<Listener>() };
  const emit = (event: 'select' | 'activate', target: Target | null) => {
    for (const fn of [...listeners[event]]) fn(target);
  };
  const labels = new LabelLayer(host.labels, {
    select: (target, clicks) => {
      // A drag of the camera that started on the tag may end in a click on it: that click selects nothing.
      if (!(relayed && clicks > 0)) clickSelect(() => target, clicks);
    },
    activate: (target) => doubleClick(() => target),
    lostFocus: () => canvas.focus(),
  });

  let size = { ...MIN_SIZE };
  // A canvas's default size, until the first measure.
  let width = 300;
  let height = 150;
  let hasFloor = false;
  let selected: Target | null = null;
  /** A desk or room the UI asked to pan to before it was on the floor; the pan happens when it arrives. */
  let panPending: Target | null = null;
  let tween: Tween | null = null;
  let reduced = theme.reducedMotion;
  let frame = 0;
  let disposed = false;
  let lost = false;
  let down: { x: number; y: number } | null = null;
  /** What the last click selected, and when: the second click of a double-click and the double-click keep to it. */
  let clicked: { target: Target | null; at: number } | null = null;
  /** Cancels a pan that waits for the end of a double-click. */
  let panLater: (() => void) | null = null;
  /** A press of the main button on a tag: a click if it ends there, a drag of the camera once it moves away. */
  let press: PointerEvent | null = null;
  /** The last press on a tag went on to the canvas as a drag. */
  let relayed = false;
  /** The arrows held on the canvas, whether Shift is down with them, and when they last moved the camera. */
  const held = new Set<string>();
  let shifted = false;
  let keyAt = 0;

  function pose(): CameraPose {
    const t = controls.target;
    const offset = { x: camera.position.x - t.x, y: camera.position.y - t.y, z: camera.position.z - t.z };
    return { target: { x: t.x, z: t.z }, azimuth: azimuthOf(offset), polar: polarOf(offset), zoom: camera.zoom };
  }

  function applyPose(p: CameraPose): void {
    const o = cameraOffset(p.azimuth, p.polar);
    controls.target.set(p.target.x, 0, p.target.z);
    camera.position.set(p.target.x + o.x, o.y, p.target.z + o.z);
    camera.zoom = clampZoom(p.zoom);
    camera.lookAt(controls.target);
    camera.updateProjectionMatrix();
  }

  /**
   * Keeps the point the camera turns about on the ground, and over the floor. A pan moves the camera in the screen's
   * plane, so the floor follows the pointer, and a pan up or down the screen lifts that point off the ground: sliding
   * it and the camera back along the line of sight changes nothing an orthographic camera shows. Turns, drag turns
   * and pose() then all work about the ground point at the centre of the view. A pan stops at the floor's edge.
   */
  function keepOnFloor(): void {
    const t = controls.target;
    const p = camera.position;
    const k = t.y === 0 ? 0 : t.y / (p.y - t.y);
    const x = Math.min(size.w, Math.max(0, t.x + (t.x - p.x) * k));
    const z = Math.min(size.h, Math.max(0, t.z + (t.z - p.z) * k));
    if (x === t.x && t.y === 0 && z === t.z) return;
    const shift = { x: x - t.x, y: -t.y, z: z - t.z };
    t.add(shift);
    p.add(shift);
  }

  /** Whether the camera is where a floor opens: its centre, from the home side, at the home tilt and zoom 1. */
  function atHome(): boolean {
    const p = pose();
    const home = homePose(size, p.azimuth);
    return (
      Math.abs(p.zoom - home.zoom) < 1e-6 &&
      Math.abs(p.azimuth - home.azimuth) < 1e-6 &&
      Math.abs(p.polar - home.polar) < 1e-6 &&
      Math.hypot(p.target.x - home.target.x, p.target.z - home.target.z) < 1e-6
    );
  }

  function onControls(): void {
    keepOnFloor();
    request();
  }

  /**
   * Starts a camera move. What is left of a drag's glide stops first, where the camera is, so none of it carries
   * into the move.
   */
  function start(next: Tween): void {
    const held = pose();
    controls.enableDamping = false;
    controls.update();
    controls.enableDamping = !reduced;
    applyPose(held);
    tween = next;
    request();
  }

  function moveTo(to: CameraPose, ms: number): void {
    start(new Tween(pose(), to, env.now(), reduced ? 0 : ms));
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

  function heldMove(): KeyMove {
    const move = { forward: 0, right: 0 };
    for (const k of held) {
      move.forward += ARROWS[k]!.forward;
      move.right += ARROWS[k]!.right;
    }
    return move;
  }

  function request(): void {
    if (!frame && !disposed && !lost && !env.hidden()) frame = env.requestFrame(draw);
  }

  function cancelFrame(): void {
    if (frame) env.cancelFrame(frame);
    frame = 0;
  }

  function draw(now: number): void {
    frame = 0;
    let again = false;
    if (tween) {
      applyPose(tween.at(now));
      if (tween.done(now)) tween = null;
      else again = true;
    }
    if (held.size) {
      // A turn asked for while an arrow is held runs first; the arrow takes over again once it ends.
      if (!tween) applyPose(keyPose(pose(), heldMove(), shifted, Math.min(now - keyAt, KEY_STEP_MS) / 1000, (camera.top - camera.bottom) / camera.zoom));
      keyAt = now;
      again = true;
    }
    if (controls.update()) again = true;
    // The controls do not report the last, smallest steps of a glide, but those still move the camera.
    keepOnFloor();
    if (world.setAzimuth(pose().azimuth)) renderer.shadowMap.needsUpdate = true;
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

  function pickAt(clientX: number, clientY: number): Target | null {
    const ndc = toNdc(clientX, clientY, canvas.getBoundingClientRect());
    if (!ndc) return null;
    world.scene.updateMatrixWorld();
    return pickTarget(camera, ndc, world.pickables());
  }

  /**
   * A click that selects what `pick` names. The second click of a double-click selects what the first one did,
   * without looking again: the camera, and the desks with it, may have moved in between.
   */
  function clickSelect(pick: () => Target | null, clicks: number): void {
    const target = clicks > 1 && clicked ? clicked.target : pick();
    // A click from the keyboard has no count, and starts no double-click.
    clicked = clicks > 0 ? { target, at: env.now() } : null;
    emit('select', target);
  }

  /** A double-click activates the desk or room its first click picked; one that follows no click, what `pick` names. */
  function doubleClick(pick: () => Target | null): void {
    stopPanLater();
    const target = clicked && env.now() - clicked.at <= DOUBLE_CLICK_MS ? clicked.target : pick();
    clicked = null;
    if (target) emit('activate', target);
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
  /**
   * Enter activates the selected desk or room. Arrows held walk and steer across the floor, and with Shift tilt the view
   * and step aside (camera.keyPose); like a press, they take the camera from any move under way. Arrows with Ctrl, Cmd
   * or Alt are the browser's.
   */
  const onKeyDown = (e: KeyboardEvent) => {
    shifted = e.shiftKey;
    if (e.key === 'Enter' && selected !== null && world.focusPoint(selected) !== null) {
      e.preventDefault();
      emit('activate', selected);
      return;
    }
    // macOS sends no keyup for a key let go while Cmd is down: a shortcut stops the arrows.
    if (e.ctrlKey || e.metaKey || e.altKey) {
      held.clear();
      return;
    }
    if (!(e.key in ARROWS)) return;
    e.preventDefault();
    if (!held.size) keyAt = env.now();
    held.add(e.key);
    tween = null;
    stopPanLater();
    request();
  };
  const onKeyUp = (e: KeyboardEvent) => {
    shifted = e.shiftKey;
    held.delete(e.key);
  };
  const stopKeys = () => held.clear();
  const onVisibility = () => {
    if (!env.hidden()) request();
    else {
      stopKeys();
      cancelFrame();
    }
  };
  // A lost context draws nothing. three restores its own state with the context, and starts an empty shadow map.
  const onContextLost = () => {
    lost = true;
    cancelFrame();
  };
  const onContextRestored = () => {
    lost = false;
    renderer.shadowMap.needsUpdate = true;
    request();
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('click', onClick);
  canvas.addEventListener('dblclick', onDoubleClick);
  canvas.addEventListener('keydown', onKeyDown);
  canvas.addEventListener('keyup', onKeyUp);
  canvas.addEventListener('blur', stopKeys);
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);
  if (!canvas.hasAttribute('tabindex')) canvas.tabIndex = 0;
  host.labels.addEventListener('pointerdown', onTagPointerDown);
  host.labels.addEventListener('wheel', onTagWheel, { passive: false });
  host.labels.addEventListener('contextmenu', onTagMenu);
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerEnd);
  document.addEventListener('pointercancel', onPointerEnd);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('blur', stopKeys);
  controls.addEventListener('change', onControls);
  const stopResize = env.observeResize(canvas, resize);
  const stopRatio = env.watchPixelRatio(resize);
  applyPose(homePose(size));
  resize();

  function on(event: 'select', fn: (target: Target | null) => void): () => void;
  function on(event: 'activate', fn: (target: Target) => void): () => void;
  function on(event: 'select' | 'activate', fn: (target: never) => void): () => void {
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
        // A camera at home frames the floor again as it grows. One the user moved stays where it looks, showing as much
        // of the floor as it did, within the zoom limits.
        const home = atHome();
        const shown = (camera.top - camera.bottom) / camera.zoom;
        size = { ...floor.size };
        fit();
        if (home) applyPose(homePose(size));
        else applyPose({ ...pose(), zoom: (camera.top - camera.bottom) / shown });
      }
      if (!hasFloor) {
        hasFloor = true;
        applyPose(homePose(size));
      }
      labels.sync(floor);
      world.setSelected(selected);
      labels.setSelected(selected);
      renderer.shadowMap.needsUpdate = true;
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
      renderer.shadowMap.needsUpdate = true;
      request();
    },
    select(target: Target | null, opts?: { pan?: boolean }) {
      if (disposed) return;
      selected = target;
      world.setSelected(target);
      labels.setSelected(target);
      stopPanLater();
      const pan = target !== null && opts?.pan === true;
      const spot = pan ? world.focusPoint(target) : null;
      panPending = pan && !spot ? target : null;
      // A pan to what the view's own click just selected waits until a second click can no longer come.
      const wait = spot && clicked && sameTarget(clicked.target, target) ? clicked.at + DOUBLE_CLICK_MS - env.now() : 0;
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
      if (!tween) {
        const p = pose();
        moveTo({ ...p, azimuth: stepAzimuth(p.azimuth, step) }, ROTATE_MS);
        return;
      }
      // A turn asked for during another goes on from where that one is heading, the same way round: both keep that
      // move's angles, and the new move turns by their plain difference, which may pass half a turn.
      const from = tween.at(env.now());
      const to = { ...tween.to, azimuth: stepAzimuth(tween.to.azimuth, step) };
      start(new Tween(from, to, env.now(), reduced ? 0 : ROTATE_MS, to.azimuth - from.azimuth));
    },
    resetView() {
      if (disposed) return;
      moveTo(homePose(size, pose().azimuth), RESET_MS);
    },
    on,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelFrame();
      stopPanLater();
      stopResize();
      stopRatio();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('dblclick', onDoubleClick);
      canvas.removeEventListener('keydown', onKeyDown);
      canvas.removeEventListener('keyup', onKeyUp);
      canvas.removeEventListener('blur', stopKeys);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      host.labels.removeEventListener('pointerdown', onTagPointerDown);
      host.labels.removeEventListener('wheel', onTagWheel);
      host.labels.removeEventListener('contextmenu', onTagMenu);
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerEnd);
      document.removeEventListener('pointercancel', onPointerEnd);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', stopKeys);
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
