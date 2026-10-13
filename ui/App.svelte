<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import type { AttentionEntry } from '../src/scene/types';
  import { SIGNED_OUT, focusSession, markSeen } from './lib/api';
  import { loadRenderer, type RendererModule } from './lib/renderer';
  import { parseHash, toHash, type Route } from './lib/route';
  import { browserStoreDeps, createClientStore, type ClientStore } from './lib/store';
  import { applyTheme, browserStorage, loadTheme, nextTheme, resolvedTheme, saveTheme, systemPrefersDark, watchSystemTheme } from './lib/theme';
  import { createToasts } from './lib/toast';
  import AttentionBar from './components/AttentionBar.svelte';
  import BuildingPanel from './components/BuildingPanel.svelte';
  import DeskPanel from './components/DeskPanel.svelte';
  import Facade from './components/Facade.svelte';
  import FloorPanel from './components/FloorPanel.svelte';
  import FloorStage from './components/FloorStage.svelte';
  import Notice from './components/Notice.svelte';
  import Toast from './components/Toast.svelte';
  import TopBar, { type Crumb } from './components/TopBar.svelte';

  /**
   * The page. It owns the live store, the route (the URL hash), the theme, the toasts and a one-second clock.
   * Every outside dependency is a prop with a browser default, so tests mount it with fakes.
   */
  interface Props {
    store?: ClientStore;
    storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
    prefersDark?: boolean;
    api?: { focusSession: typeof focusSession; markSeen: typeof markSeen };
    now?: () => number;
    /** Loads the 3D floor renderer, the first time a floor opens. */
    renderer?: () => Promise<RendererModule>;
  }
  const props: Props = $props();
  // The dependencies are fixed for the page's life: read once, on purpose.
  const deps = untrack(() => ({
    store: props.store ?? createClientStore(browserStoreDeps()),
    storage: props.storage === undefined ? browserStorage() : props.storage,
    prefersDark: props.prefersDark ?? systemPrefersDark(),
    api: props.api ?? { focusSession, markSeen },
    now: props.now ?? Date.now,
    renderer: props.renderer ?? loadRenderer,
  }));
  const { store, storage, api, now, renderer } = deps;
  const toasts = createToasts();

  const initial = parseHash(location.hash);
  // Watch the floor before anything subscribes, so the stream opens once, on the right floor.
  store.watchFloor(initial.floor);
  let route: Route = $state(initial);
  let theme = $state(loadTheme(storage));
  let systemDark = $state(deps.prefersDark);
  let clock = $state(now());
  let stage: HTMLElement | undefined = $state();
  let panel: HTMLElement | undefined = $state();
  /** The element that last had focus, and the attention chip it sat in, for when an update takes it away. */
  let lastFocus: { el: Element; group: Element | null; index: number } | null = null;

  $effect(() => store.watchFloor(route.floor));
  // Before the components' effects: the floor stage reads its colours from <html> once the theme is set there.
  $effect.pre(() => applyTheme(document.documentElement, theme));
  $effect(() => watchSystemTheme((dark) => (systemDark = dark)));
  $effect(() => {
    const timer = setInterval(() => (clock = now()), 1000);
    return () => clearInterval(timer);
  });
  onDestroy(() => {
    store.close();
    toasts.clear();
  });
  // After every live update, and every toast that goes.
  $effect(() => {
    void $store;
    void $toasts;
    untrack(keepFocus);
  });

  const scene = $derived($store.scene);
  /** The watched floor's detail, once it has arrived for the floor the route shows. */
  const floor = $derived($store.floorKey === route.floor ? $store.floor : undefined);
  const summary = $derived(route.floor === null ? undefined : scene?.floors.find((f) => f.key === route.floor));
  const desk = $derived.by(() => {
    if (!route.desk || !floor) return undefined;
    for (const island of floor.islands) {
      const found = island.desks.find((d) => d.sessionId === route.desk);
      if (found) return { desk: found, island };
    }
    return undefined;
  });

  const crumbs = $derived.by((): Crumb[] => {
    const list: Crumb[] = [{ label: 'Building', route: { floor: null, desk: null } }];
    if (route.floor === null) return list;
    list.push({ label: summary ? `${summary.number} · ${summary.name}` : 'Floor', route: { floor: route.floor, desk: null } });
    if (route.desk !== null) {
      const name = desk?.desk.name ?? [...(scene?.attention.needsYou ?? []), ...(scene?.attention.done ?? [])].find((e) => e.sessionId === route.desk)?.name;
      list.push({ label: name ?? 'Desk', route });
    }
    return list;
  });

  function navigate(next: Route): void {
    const to = next.floor === null ? { floor: null, desk: null } : next;
    const moved = to.floor !== route.floor || to.desk !== route.desk;
    route = to;
    const hash = toHash(route);
    if (location.hash !== hash) location.hash = hash;
    if (moved) void followMove();
  }

  function onHashChange(): void {
    const next = parseHash(location.hash);
    if (next.floor === route.floor && next.desk === route.desk) return;
    route = next;
    void followMove();
  }

  /** The open panel's heading. Each panel's h2 can take focus from script (tabindex -1). */
  function heading(): HTMLElement | null {
    return panel?.querySelector<HTMLElement>('h2') ?? null;
  }

  /**
   * After a move, focus goes to the new panel's heading: the keyboard carries on from there, and a screen reader says
   * where the page is. Focus in the stage stays: a desk picked in 3D keeps its canvas or tag, where Enter acts on it.
   */
  async function followMove(): Promise<void> {
    await tick();
    if (!stage?.contains(document.activeElement)) heading()?.focus();
  }

  function onFocusIn(e: FocusEvent): void {
    if (!(e.target instanceof Element)) return;
    const chip = e.target.closest('.attention li.chip');
    const index = chip?.parentElement ? [...chip.parentElement.children].indexOf(chip) : -1;
    lastFocus = { el: e.target, group: chip?.closest('.group') ?? null, index };
  }

  /**
   * The user left an element for the page (a click on empty space): it is no longer the one to recover. Focus that
   * moved on to another element, or an element that was removed, is not that. A window or tab switch blurs the element
   * but leaves it the document's active element, so it stays remembered.
   */
  function onFocusOut(e: FocusEvent): void {
    const target = e.target;
    queueMicrotask(() => {
      if (lastFocus?.el !== target || !lastFocus.el.isConnected) return;
      if (document.activeElement === null || document.activeElement === document.body) lastFocus = null;
    });
  }

  /**
   * An update took the focused element away, and focus fell to the page: it goes to the attention chip now in its
   * place, else to the panel's heading. Focus anywhere else, or on the page because someone put it there, stays.
   */
  function keepFocus(): void {
    const last = lastFocus;
    if (!last || last.el.isConnected) return;
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    const chips = last.group?.querySelectorAll<HTMLElement>('li.chip button.open') ?? [];
    (chips[Math.min(last.index, chips.length - 1)] ?? heading())?.focus();
  }

  /** Esc goes up one level: desk, floor, building. */
  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (route.desk !== null) navigate({ floor: route.floor, desk: null });
    else if (route.floor !== null) navigate({ floor: null, desk: null });
  }

  /** Leaving the page frees its connection at once. A page the browser brings back from its back-forward cache starts afresh. */
  function onPageHide(): void {
    store.close();
  }

  function onPageShow(e: PageTransitionEvent): void {
    if (e.persisted) location.reload();
  }

  function toggleTheme(): void {
    theme = nextTheme(theme);
    saveTheme(storage, theme);
  }

  /** Go and Mark as seen requests still out, by action and session: a second click meanwhile sends nothing. */
  const pending = new Set<string>();

  async function once(key: string, request: () => Promise<void>): Promise<void> {
    if (pending.has(key)) return;
    pending.add(key);
    try {
      await request();
    } finally {
      pending.delete(key);
    }
  }

  /** Switches tmux to the session's pane. The demo only says what it would do. */
  function focus(sessionId: string): Promise<void> {
    return once(`focus ${sessionId}`, async () => {
      const result = await api.focusSession(sessionId);
      if (result.ok) toasts.show(result.simulated ? `Demo: would switch tmux to ${result.pane}` : `Switched tmux to ${result.pane}`);
      else toasts.show(result.error, 'error');
    });
  }

  function seen(sessionId: string): Promise<void> {
    return once(`seen ${sessionId}`, async () => {
      let signedOut = false;
      if (await api.markSeen(sessionId, undefined, () => (signedOut = true))) toasts.show('Marked as seen.');
      else toasts.show(signedOut ? SIGNED_OUT : 'It is no longer waiting for review.', 'error');
    });
  }

  function openEntry(entry: AttentionEntry): void {
    navigate({ floor: entry.floorKey, desk: entry.sessionId });
  }
</script>

<svelte:window onkeydown={onKeydown} onhashchange={onHashChange} onpagehide={onPageHide} onpageshow={onPageShow} onfocusin={onFocusIn} onfocusout={onFocusOut} />

<div class="app">
  <!-- What the page cannot draw (two entries for one session, say) stops the drawing, not the page: it offers a reload. -->
  <svelte:boundary onerror={(error) => console.error(error)}>
    <TopBar
      {crumbs}
      needsYou={scene?.attention.needsYou.length ?? 0}
      done={scene?.attention.done.length ?? 0}
      {theme}
      resolved={resolvedTheme(theme, systemDark)}
      onNavigate={navigate}
      onTheme={toggleTheme}
    />
    <Notice connection={$store.connection} hasScene={scene !== null} />
    {#if scene}
      <AttentionBar attention={scene.attention} now={clock} onOpen={openEntry} onGo={(entry) => focus(entry.sessionId)} />
    {/if}
    <main class="main">
      <section class="stage" aria-label={route.floor === null ? 'Building' : 'Floor'} bind:this={stage}>
        {#if route.floor === null}
          {#if scene}
            <Facade
              floors={scene.floors}
              selected={null}
              onFloor={(key) => navigate({ floor: key, desk: null })}
              onDesk={(key, id) => navigate({ floor: key, desk: id })}
            />
            <p class="hint">{scene.floors.length > 0 ? 'Click a floor to go inside, or a window to open its desk.' : 'No sessions yet.'}</p>
          {/if}
        {:else if floor}
          <!-- One view per floor: a disposed view cannot draw on its canvas again. -->
          {#key route.floor}
            <FloorStage
              {floor}
              selected={route.desk}
              theme={resolvedTheme(theme, systemDark)}
              load={renderer}
              onSelect={(id) => navigate({ floor: route.floor, desk: id })}
              onActivate={focus}
            />
          {/key}
        {:else if floor === null}
          <p class="hint">This floor is empty now.</p>
        {/if}
      </section>
      <aside class="panel" aria-label="Details" bind:this={panel}>
        {#if route.floor === null}
          {#if scene}
            <BuildingPanel floors={scene.floors} onFloor={(key) => navigate({ floor: key, desk: null })} />
          {/if}
        {:else if desk && floor}
          <DeskPanel
            desk={desk.desk}
            island={desk.island}
            {floor}
            now={clock}
            onBack={() => navigate({ floor: route.floor, desk: null })}
            onGo={focus}
            onSeen={seen}
          />
        {:else}
          <FloorPanel
            {summary}
            {floor}
            selected={route.desk}
            onDesk={(id) => navigate({ floor: route.floor, desk: id })}
            onBack={() => navigate({ floor: null, desk: null })}
          />
        {/if}
      </aside>
    </main>
    {#snippet failed()}
      <div class="broken" role="alert">
        <strong>The page could not show what the daemon sent.</strong>
        <button type="button" class="btn" onclick={() => location.reload()}>Reload</button>
      </div>
    {/snippet}
  </svelte:boundary>
  <Toast {toasts} />
</div>

<style>
  .app { height: 100%; display: flex; flex-direction: column; gap: 10px; padding: 12px 16px 16px; }
  .main { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 12px; }
  .stage {
    position: relative;
    min-height: 0;
    min-width: 0;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: linear-gradient(180deg, var(--sky), var(--bg));
    overflow: auto;
  }
  .hint { position: absolute; left: 12px; bottom: 10px; margin: 0; font-size: 12px; color: var(--muted); pointer-events: none; }
  .broken {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    padding: 10px 12px;
    border: 1px solid color-mix(in oklab, var(--s-needs) 55%, var(--line));
    border-radius: 8px;
    background: var(--panel);
  }
  .broken strong { color: var(--needs-ink); }
  .panel {
    min-height: 0;
    min-width: 0;
    overflow: auto;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 16px 18px 18px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  @media (max-width: 900px) {
    .app { height: auto; }
    .main { grid-template-columns: minmax(0, 1fr); }
    .stage { height: 460px; }
    .panel { overflow: visible; }
  }
</style>
