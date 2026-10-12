<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { parseHash, toHash, type Route } from './lib/route';
  import { browserStoreDeps, createClientStore, type ClientStore } from './lib/store';
  import { applyTheme, browserStorage, loadTheme, nextTheme, resolvedTheme, saveTheme, systemPrefersDark, watchSystemTheme } from './lib/theme';
  import { createToasts } from './lib/toast';
  import Notice from './components/Notice.svelte';
  import Toast from './components/Toast.svelte';
  import TopBar, { type Crumb } from './components/TopBar.svelte';

  /**
   * The page. It owns the live store, the route (the URL hash), the theme and the toasts.
   * Every outside dependency is a prop with a browser default, so tests mount it with fakes.
   */
  interface Props {
    store?: ClientStore;
    storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
    prefersDark?: boolean;
  }
  const props: Props = $props();
  // The dependencies are fixed for the page's life: read once, on purpose.
  const deps = untrack(() => ({
    store: props.store ?? createClientStore(browserStoreDeps()),
    storage: props.storage === undefined ? browserStorage() : props.storage,
    prefersDark: props.prefersDark ?? systemPrefersDark(),
  }));
  const { store, storage } = deps;
  const toasts = createToasts();

  const initial = parseHash(location.hash);
  // Watch the floor before anything subscribes, so the stream opens once, on the right floor.
  store.watchFloor(initial.floor);
  let route: Route = $state(initial);
  let theme = $state(loadTheme(storage));
  let systemDark = $state(deps.prefersDark);

  $effect(() => store.watchFloor(route.floor));
  $effect(() => applyTheme(document.documentElement, theme));
  $effect(() => watchSystemTheme((dark) => (systemDark = dark)));
  onDestroy(() => {
    store.close();
    toasts.clear();
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
    route = next.floor === null ? { floor: null, desk: null } : next;
    const hash = toHash(route);
    if (location.hash !== hash) location.hash = hash;
  }

  function onHashChange(): void {
    const next = parseHash(location.hash);
    if (next.floor !== route.floor || next.desk !== route.desk) route = next;
  }

  /** Esc goes up one level: desk, floor, building. */
  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (route.desk !== null) navigate({ floor: route.floor, desk: null });
    else if (route.floor !== null) navigate({ floor: null, desk: null });
  }

  function toggleTheme(): void {
    theme = nextTheme(theme);
    saveTheme(storage, theme);
  }
</script>

<svelte:window onkeydown={onKeydown} onhashchange={onHashChange} />

<div class="app">
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
  <main class="main">
    <section class="stage" aria-label="Building"></section>
    <aside class="panel" aria-live="polite"></aside>
  </main>
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
