<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { FloorDetail } from '../../src/scene/types';
  import type { RendererModule } from '../lib/renderer';
  import type { FloorView, Target } from '../renderer/index';

  /**
   * The open floor in 3D. The renderer loads on mount and draws on this component's own canvas: a view releases its
   * WebGL context when it is disposed, so each floor gets a fresh stage. The route owns the selection: a desk or a room
   * clicked in the view is marked and reported, and one the route picks elsewhere is marked and panned to.
   */
  interface Props {
    floor: FloorDetail;
    /** The desk or the room the route points at. */
    selected: Target | null;
    /** The theme in force. The stage reads the colours again when it changes. */
    theme: 'day' | 'night';
    load: () => Promise<RendererModule>;
    onSelect: (target: Target | null) => void;
    /** A double-click, or Enter on the selected desk or room: go to the pane of the desk, or of the room's host. */
    onActivate: (sessionId: string) => void;
  }
  let { floor, selected, theme, load, onSelect, onActivate }: Props = $props();

  let canvas: HTMLCanvasElement | undefined = $state();
  let labels: HTMLElement | undefined = $state();
  let view: FloorView | null = $state.raw(null);
  /** Why there is no view: the browser has no WebGL, or the renderer did not load or mount. */
  let failure: 'no-webgl' | 'load' | null = $state(null);
  let renderer: RendererModule | null = null;
  /** The theme whose colours the view has. */
  let painted = '';
  /** What the view marks; undefined until the first selection. */
  let marked: Target | null | undefined;
  let gone = false;

  /** The route gives a new target object for the desk or room it already points at: compare what they name. */
  function same(a: Target | null | undefined, b: Target | null | undefined): boolean {
    return a === b || (!!a && !!b && a.kind === b.kind && a.id === b.id);
  }

  function reducedMotion(): boolean {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  }

  /** The colours tokens.css gives <html> for the theme in force. */
  function colours(r: RendererModule) {
    const root = getComputedStyle(document.documentElement);
    return r.readThemeTokens((name) => root.getPropertyValue(name), reducedMotion());
  }

  /**
   * Without WebGL the panel's desk list is the way around the floor. Anything else is a fault worth seeing, most often a
   * renderer file the page can no longer fetch: the daemon was updated since the page loaded, and a reload fixes it.
   */
  function fail(err: unknown): void {
    if (gone) return;
    if (err instanceof Error && err.name === 'WebGLUnavailableError') {
      failure = 'no-webgl';
      return;
    }
    failure = 'load';
    console.error(err);
  }

  onMount(() => {
    load().then((r) => {
      if (gone || !canvas || !labels) return;
      try {
        const v = r.mountFloorView({ canvas, labels }, colours(r));
        // A desk or room clicked in the view is on screen: mark it without moving the camera, so that the second click
        // of a double-click lands on the same one.
        v.on('select', (target) => {
          marked = target;
          v.select(target);
          onSelect(target);
        });
        // A room is its host's: activating it goes to the host's pane.
        v.on('activate', (target) => {
          const id = target.kind === 'desk' ? target.id : floor.rooms.find((r) => r.runId === target.id)?.hostSessionId;
          if (id !== undefined) onActivate(id);
        });
        renderer = r;
        painted = theme;
        view = v;
      } catch (err) {
        fail(err);
      }
    }, fail);
  });

  onDestroy(() => {
    gone = true;
    view?.dispose();
  });

  // Separate on purpose: a floor update must not move the camera back to the selected desk.
  $effect(() => {
    if (view) view.setFloor(floor);
  });
  // A desk or room picked in the address, the panel or the attention bar may be off screen: pan to it.
  $effect(() => {
    if (!view || same(selected, marked)) return;
    marked = selected;
    view.select(selected, { pan: true });
  });
  $effect(() => {
    if (!view || !renderer || theme === painted) return;
    painted = theme;
    view.setTheme(colours(renderer));
  });

  /** Q and E turn the floor a quarter, R resets the view. Shortcuts with Ctrl, Cmd or Alt, and typing, pass through. */
  function onKeydown(e: KeyboardEvent): void {
    if (!view || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if ((e.target as Element | null)?.closest?.('input, textarea, select, [contenteditable]')) return;
    const key = e.key.toLowerCase();
    if (key === 'q') view.rotate(-1);
    else if (key === 'e') view.rotate(1);
    else if (key === 'r') view.resetView();
    else return;
    e.preventDefault();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="floor-stage">
  {#if failure === 'no-webgl'}
    <p class="no-webgl" role="status">This browser cannot draw the floor in 3D. Its desks are listed in the panel.</p>
  {:else if failure === 'load'}
    <div class="load-failed" role="alert">
      <p>The 3D view could not load; the daemon may have been updated. Reload the page.</p>
      <button type="button" class="btn" onclick={() => location.reload()}>Reload</button>
    </div>
  {:else}
    <canvas bind:this={canvas} aria-label="Floor {floor.number}, {floor.name}, in 3D"></canvas>
    <div bind:this={labels}></div>
    {#if !view}
      <p class="loading" role="status">Loading the 3D floor…</p>
    {/if}
    <div class="tools">
      <button type="button" class="tool" title="Turn left (Q)" aria-label="Turn left" disabled={!view} onclick={() => view?.rotate(-1)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.4-5.7" /><path d="M4 4v5h5" /></svg>
      </button>
      <button type="button" class="tool" title="Turn right (E)" aria-label="Turn right" disabled={!view} onclick={() => view?.rotate(1)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.4-5.7" /><path d="M20 4v5h-5" /></svg>
      </button>
      <button type="button" class="tool" title="Reset view (R)" aria-label="Reset view" disabled={!view} onclick={() => view?.resetView()}>Reset view</button>
    </div>
    {#if view}
      <p class="hint">Drag to turn and tilt · scroll to zoom · right-drag or arrows to pan · double-click a desk or a room for its pane</p>
    {/if}
  {/if}
</div>

<style>
  .floor-stage { position: absolute; inset: 0; overflow: hidden; }
  canvas { position: absolute; inset: 0; display: block; width: 100%; height: 100%; touch-action: none; }
  .tools { position: absolute; top: 10px; right: 10px; display: flex; gap: 6px; }
  .tool {
    display: inline-flex;
    align-items: center;
    height: 30px;
    padding: 0 10px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: color-mix(in oklab, var(--panel) 92%, transparent);
    font-size: 12.5px;
    font-weight: 500;
    cursor: pointer;
  }
  .tool:hover { background: var(--hover); }
  .tool:disabled { opacity: .5; cursor: default; }
  .tool svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .hint { position: absolute; right: 12px; bottom: 10px; margin: 0; font-size: 12px; color: var(--muted); pointer-events: none; }
  .loading { position: absolute; inset: 0; display: grid; place-items: center; margin: 0; color: var(--muted); pointer-events: none; }
  .no-webgl { position: absolute; inset: 0; display: grid; place-items: center; margin: 0; padding: 24px; text-align: center; color: var(--muted); }
  .load-failed { position: absolute; inset: 0; display: grid; place-content: center; justify-items: center; gap: 12px; padding: 24px; text-align: center; }
  .load-failed p { margin: 0; max-width: 46ch; }
  @media (max-width: 900px) {
    .hint { display: none; }
  }
</style>
