<script lang="ts">
  import type { FloorDetail, FloorSummary } from '../../src/scene/types';
  import { STATES, plural } from '../lib/words';

  /**
   * One floor as a list: an island per checkout (its placard: repo, branch, path) and a row per desk. It is also
   * what a browser without WebGL uses to get around a floor.
   */
  interface Props {
    /** From the building scene: number and name while the detail loads. */
    summary: FloorSummary | undefined;
    /** undefined while loading, null when the floor is gone. */
    floor: FloorDetail | null | undefined;
    /** The desk the route points at. */
    selected: string | null;
    onDesk: (sessionId: string) => void;
    onBack: () => void;
  }
  let { summary, floor, selected, onDesk, onBack }: Props = $props();

  const head = $derived(floor ?? summary);
  const sessions = $derived(floor ? floor.islands.reduce((n, i) => n + i.desks.length, 0) : (summary?.windows.length ?? 0));
  /** The route names a desk that is not on the floor any more. */
  const missing = $derived(selected !== null && !!floor && !floor.islands.some((i) => i.desks.some((d) => d.sessionId === selected)));
</script>

<div>
  {#if head}
    <p class="eyebrow">Floor {head.number} · {head.kind === 'department' ? 'Department' : 'Feature'}</p>
    <h2 tabindex="-1" class="p-title">{head.name}</h2>
    <p class="p-sub">
      {head.kind === 'department' ? 'Sessions with no feature branch' : `${plural(head.repos.length, 'repo', 'repos')} on this feature`} · {plural(sessions, 'session', 'sessions')}
    </p>
  {:else}
    <p class="eyebrow">Floor</p>
    <h2 tabindex="-1" class="p-title">Not in the building</h2>
  {/if}
</div>

{#if floor === undefined}
  <p class="p-note">Loading the floor…</p>
{:else if floor === null}
  <p class="p-text">This floor is empty now: its sessions have ended or moved to another floor.</p>
  <button type="button" class="linkbtn back" onclick={onBack}>← Back to the building</button>
{:else}
  {#if missing}
    <p class="p-note gone">That session has left this floor.</p>
  {/if}
  {#if floor.shutters}
    <p class="p-text">Shutters down: everyone on this floor has been idle for days.</p>
  {/if}
  {#each floor.islands as island (island.key)}
    <section class="island">
      <div class="island-head">
        <span class="swatch repo-{island.color}" aria-hidden="true"></span>
        <span class="repo">{island.repo}</span>
        <span class="br">{island.branch ?? 'no branch'}{island.worktree ? ' · worktree' : ''}</span>
      </div>
      <p class="path">{island.path}</p>
      <ul class="rows">
        {#each island.desks as desk (desk.sessionId)}
          <li>
            <button
              type="button"
              class="row-btn sw-{desk.state}"
              class:sel={desk.sessionId === selected}
              aria-current={desk.sessionId === selected ? 'true' : undefined}
              onclick={() => onDesk(desk.sessionId)}
            >
              <span class="dot" aria-hidden="true"></span>
              <span class="r-name">{desk.name}</span>
              <span class="r-state">{STATES[desk.state].label}</span>
              <span class="r-task">{desk.title ?? 'No task yet'}</span>
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/each}
{/if}

<style>
  .back { align-self: flex-start; }
  .gone { color: var(--needs-ink); }
  .island-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin: 4px 0 2px; }
  .swatch { width: 12px; height: 12px; border-radius: 50%; background: var(--rc); align-self: center; }
  .repo { font-weight: 600; }
  .br { font-family: var(--font-mono); font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
  .path { margin: 0 0 4px; font-family: var(--font-mono); font-size: 11.5px; color: var(--muted); overflow-wrap: anywhere; }
  .rows { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
  .row-btn {
    width: 100%;
    display: grid;
    grid-template-columns: 10px minmax(0, 1fr) auto;
    align-items: center;
    gap: 2px 12px;
    padding: 8px 10px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: none;
    cursor: pointer;
    text-align: left;
  }
  .row-btn:hover { background: var(--hover); border-color: var(--line); }
  .row-btn.sel { border-color: var(--accent); }
  .r-name { font-family: var(--font-mono); font-size: 12.5px; font-weight: 500; }
  .r-task { grid-column: 2; color: var(--muted); font-size: 12.5px; overflow-wrap: anywhere; }
  .r-state { grid-row: span 2; font-size: 12px; color: var(--muted); white-space: nowrap; }
</style>
