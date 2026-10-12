<script lang="ts">
  import type { FloorSummary } from '../../src/scene/types';
  import { STATES, STATE_ORDER, floorMeta, needYou, plural } from '../lib/words';

  /** The floor directory, top to bottom as on the façade, and what the colours mean. */
  interface Props {
    floors: FloorSummary[];
    onFloor: (key: string) => void;
  }
  let { floors, onFloor }: Props = $props();

  const sessions = $derived(floors.reduce((n, f) => n + f.windows.length, 0));
</script>

<div>
  <p class="eyebrow">Directory</p>
  <h2 tabindex="-1" class="p-title">The building</h2>
  <p class="p-sub">{plural(floors.length, 'floor', 'floors')} · {plural(sessions, 'session', 'sessions')}</p>
</div>
<p class="p-text">
  Each floor is a feature, even when its sessions work in different repos. Sessions without a feature sit in their repo's
  department. Each window is a session's desk, in the colour of its state: the legend below names them all. Sessions
  waiting for you are also listed at the top.
</p>
{#if floors.length > 0}
  <ol class="directory">
    {#each floors as f (f.key)}
      <li>
        <button type="button" class="dir-btn" onclick={() => onFloor(f.key)}>
          <span class="fl-num">{f.number}</span>
          <span class="fl-name">{f.name}</span>
          <span class="fl-counts">
            {#if f.counts.needs_you}<span class="cnt-needs"><span aria-hidden="true">◉</span>{f.counts.needs_you}<span class="visually-hidden">{` ${needYou(f.counts.needs_you)}`}</span></span>{/if}
            {#if f.counts.done}<span class="cnt-done"><span aria-hidden="true">✓</span>{f.counts.done}<span class="visually-hidden">{' done'}</span></span>{/if}
            {#if f.shutters}<span class="cnt-shut">shut</span>{/if}
          </span>
          <span class="fl-meta">{floorMeta(f)[0]!.text}{f.kind === 'feature' ? ` · ${f.repos.join(', ')}` : ''}</span>
        </button>
      </li>
    {/each}
  </ol>
{:else}
  <p class="p-note">No sessions yet. Start Claude Code in a terminal, inside tmux to jump to it from here, and it moves in.</p>
{/if}
<section>
  <h3 class="p-h3">Legend</h3>
  <ul class="legend">
    {#each STATE_ORDER as state (state)}
      <li class="sw-{state}">
        <span class="sw" aria-hidden="true"></span>
        <span class="ln">{STATES[state].label}</span>
        <span class="ld">{STATES[state].description}</span>
      </li>
    {/each}
  </ul>
</section>

<style>
  .directory, .legend { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
  .dir-btn {
    width: 100%;
    display: grid;
    grid-template-columns: 30px minmax(0, 1fr) auto;
    align-items: center;
    gap: 2px 12px;
    padding: 8px 10px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: none;
    cursor: pointer;
    text-align: left;
  }
  .dir-btn:hover { background: var(--hover); border-color: var(--line); }
  .fl-num {
    grid-row: span 2;
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border: 1.5px solid var(--fg);
    border-radius: 50%;
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 600;
  }
  .fl-name { font-family: var(--font-display); font-stretch: 75%; font-weight: 700; font-size: 16px; letter-spacing: .06em; text-transform: uppercase; overflow-wrap: anywhere; }
  .fl-meta { color: var(--muted); font-size: 12.5px; grid-column: 2; overflow-wrap: anywhere; }
  .fl-counts { grid-row: span 2; display: flex; gap: 6px; font-family: var(--font-mono); font-size: 12px; font-variant-numeric: tabular-nums; }
  .cnt-needs { color: var(--needs-ink); font-weight: 600; }
  .cnt-done { color: var(--done-ink); font-weight: 600; }
  .cnt-shut { color: var(--muted); }
  .legend { gap: 7px; }
  .legend li { display: grid; grid-template-columns: 14px minmax(0, 1fr); gap: 2px 10px; align-items: start; }
  .sw { width: 12px; height: 12px; border-radius: 3px; background: var(--sw); margin-top: 3px; }
  .ln { font-weight: 600; font-size: 13px; }
  .ld { grid-column: 2; color: var(--muted); font-size: 12.5px; }
</style>
