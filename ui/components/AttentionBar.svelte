<script lang="ts">
  import { formatAgo } from '../../src/scene/text';
  import type { AttentionEntry, BuildingScene } from '../../src/scene/types';
  import { raisedBy, waitText } from '../lib/words';

  /**
   * The attention queue, visible at every level: who needs you (longest wait first) and what is done, to review
   * (oldest first), in the order the scene gives. A chip opens its desk; Go switches tmux to its pane.
   */
  interface Props {
    attention: BuildingScene['attention'];
    now: number;
    onOpen: (entry: AttentionEntry) => void;
    onGo: (entry: AttentionEntry) => void;
  }
  let { attention, now, onOpen, onGo }: Props = $props();

  function what(entry: AttentionEntry): string {
    if (entry.state === 'done') return entry.title ?? 'Finished its turn';
    const by = raisedBy(entry.reason);
    return by ? `${waitText(entry.reason)} · ${by}` : waitText(entry.reason);
  }

  const groups = $derived([
    { label: 'Needs you', tone: 'needs', entries: attention.needsYou, empty: 'Nobody is waiting for you.' },
    { label: 'Done, to review', tone: 'done', entries: attention.done, empty: 'Nothing to review.' },
  ]);
</script>

<section class="attention" aria-label="Sessions that need your attention">
  {#each groups as group (group.tone)}
    <div class="group {group.tone}">
      <h2 class="label">{group.label}</h2>
      {#if group.entries.length > 0}
        <ul class="chips">
          {#each group.entries as entry (entry.sessionId)}
            <li class="chip">
              <button type="button" class="open" title={what(entry)} onclick={() => onOpen(entry)}>
                <span class="dot" aria-hidden="true"></span>
                <span class="who">{entry.name}</span>
                <span class="what">{what(entry)}</span>
                <span class="time">{formatAgo(now - entry.since)}</span>
              </button>
              {#if entry.focusable}
                <button type="button" class="go" aria-label="Go to the tmux pane of {entry.name}" onclick={() => onGo(entry)}>Go</button>
              {/if}
            </li>
          {/each}
        </ul>
      {:else}
        <p class="empty">{group.empty}</p>
      {/if}
    </div>
  {/each}
</section>

<style>
  .attention { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 22px; min-width: 0; }
  .group { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
  .label { margin: 0; font-size: 11px; font-weight: 600; letter-spacing: .09em; text-transform: uppercase; color: var(--muted); }
  .empty { margin: 0; color: var(--muted); font-size: 13px; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; min-width: 0; margin: 0; padding: 0; list-style: none; }
  .chip {
    display: inline-flex;
    align-items: stretch;
    max-width: 100%;
    min-width: 0;
    border: 1px solid var(--line);
    background: var(--panel);
    border-radius: 6px;
    font-size: 13px;
  }
  .needs .chip { border-color: color-mix(in oklab, var(--s-needs) 50%, var(--line)); }
  .open {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding: 5px 10px 5px 9px;
    border: 0;
    border-radius: 6px;
    background: none;
    cursor: pointer;
    text-align: left;
  }
  .open:hover { background: var(--hover); }
  .dot { width: 9px; height: 9px; }
  .needs .dot { background: var(--s-needs); box-shadow: 0 0 0 3px color-mix(in oklab, var(--s-needs) 22%, transparent); }
  .done .dot { background: var(--s-done); }
  .who { font-weight: 600; white-space: nowrap; font-family: var(--font-mono); font-size: 12.5px; }
  .what { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 36ch; min-width: 0; }
  .time { font-family: var(--font-mono); font-size: 12px; color: var(--muted); }
  .needs .time { color: var(--needs-ink); font-weight: 600; }
  .go {
    border: 0;
    border-left: 1px solid var(--line);
    border-radius: 0 6px 6px 0;
    padding: 0 10px;
    background: none;
    cursor: pointer;
    font-weight: 600;
    font-size: 12px;
    color: var(--accent);
  }
  .go:hover { background: var(--hover); }
</style>
