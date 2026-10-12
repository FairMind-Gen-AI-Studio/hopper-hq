<script lang="ts" module>
  import type { Route } from '../lib/route';

  /** One step of the breadcrumbs. The last one is where the page is; the others go back up. */
  export interface Crumb {
    label: string;
    route: Route;
  }
</script>

<script lang="ts">
  import { THEME_LABEL, nextTheme, type ThemePreference } from '../lib/theme';

  interface Props {
    crumbs: Crumb[];
    /** The tmux counter: how many sessions need you, and how many are done. */
    needsYou: number;
    done: number;
    theme: ThemePreference;
    /** What system means right now. */
    resolved: 'day' | 'night';
    onNavigate: (route: Route) => void;
    onTheme: () => void;
  }
  let { crumbs, needsYou, done, theme, resolved, onNavigate, onTheme }: Props = $props();
  const label = $derived(theme === 'system' ? `System (${resolved})` : THEME_LABEL[theme]);
</script>

<header class="topbar">
  <h1 class="brand">Scranton HQ</h1>
  <nav class="crumbs" aria-label="Location">
    {#each crumbs as crumb, i (i)}
      {#if i > 0}<span class="sep" aria-hidden="true">/</span>{/if}
      {#if i < crumbs.length - 1}
        <button type="button" class="linkbtn" onclick={() => onNavigate(crumb.route)}>{crumb.label}</button>
      {:else}
        <span class="here" aria-current="page">{crumb.label}</span>
      {/if}
    {/each}
  </nav>
  <div class="top-right">
    <button type="button" class="btn theme" aria-label="Theme: {label}. Switch to {THEME_LABEL[nextTheme(theme)]}." onclick={onTheme}>
      Theme: {label}
    </button>
    <span class="tmux" title="What the tmux status line shows">
      <span class="k" aria-hidden="true">tmux</span>
      <span class="n" aria-hidden="true">◉{needsYou}</span>
      <span class="d" aria-hidden="true">✓{done}</span>
      <span class="visually-hidden">{needsYou} need you, {done} done</span>
    </span>
  </div>
</header>

<style>
  .topbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 18px; min-width: 0; }
  .brand {
    margin: 0;
    font-family: var(--font-display);
    font-stretch: 72%;
    font-weight: 800;
    font-size: 22px;
    letter-spacing: .14em;
    text-transform: uppercase;
    line-height: 1;
  }
  .crumbs { display: flex; align-items: center; gap: 6px; color: var(--muted); min-width: 0; font-size: 13px; }
  .sep { opacity: .6; }
  .here { color: var(--fg); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .top-right { margin-left: auto; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .theme { padding: 4px 10px; font-size: 12px; }
  .tmux {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 500;
    background: var(--tmux-bg);
    color: var(--tmux-fg);
    padding: 4px 10px;
    border-radius: 4px;
  }
  .k { opacity: .55; }
  .n { color: var(--tmux-needs); }
  .d { color: var(--tmux-done); }
</style>
