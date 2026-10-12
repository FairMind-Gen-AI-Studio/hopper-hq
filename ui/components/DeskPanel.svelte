<script lang="ts">
  import { formatAgo } from '../../src/scene/text';
  import type { Desk, FloorDetail, Island } from '../../src/scene/types';
  import { plural, raisedBy, waitText } from '../lib/words';
  import StatePill from './StatePill.svelte';

  /** One session: what it does, what it waits for, where it runs; and the two things to do from here. */
  interface Props {
    desk: Desk;
    island: Island;
    floor: Pick<FloorDetail, 'number' | 'name'>;
    now: number;
    onBack: () => void;
    onGo: (sessionId: string) => void;
    onSeen: (sessionId: string) => void;
  }
  let { desk, island, floor, now, onBack, onGo, onSeen }: Props = $props();

  const where = $derived(desk.location === 'cloud' ? 'remote' : desk.pane ? `tmux pane ${desk.pane}` : 'not in tmux');
  const by = $derived(raisedBy(desk.reason));
  /** Why Go is off, when it is. */
  const cannotGo = $derived.by(() => {
    if (desk.focusable) return null;
    if (desk.location === 'cloud') return 'It runs in the cloud: there is no tmux pane to go to.';
    return 'It does not run in a tmux pane, so there is nowhere to go.';
  });
</script>

<button type="button" class="linkbtn back" onclick={onBack}>← Floor {floor.number} · {floor.name}</button>
<div>
  <p class="eyebrow">{island.repo} · {where}</p>
  <div class="head-row">
    <h2 class="p-title mono">{desk.name}</h2>
    <StatePill state={desk.state} />
    {#if desk.location === 'cloud'}<span class="tag">remote</span>{/if}
  </div>
</div>
<p class="p-text">{desk.title ?? 'No task yet.'}</p>
<dl class="facts">
  {#if desk.state === 'needs_you'}
    <dt>Waiting for</dt>
    <dd class="warn">{waitText(desk.reason)}{by ? ` · ${by}` : ''}</dd>
  {/if}
  <dt>Since</dt>
  <dd>{formatAgo(now - desk.since)} ago</dd>
  {#if desk.activity?.running}
    <dt>Running</dt>
    <dd><code>{desk.activity.label}</code> for {formatAgo(now - desk.activity.since)}{desk.state === 'no_signal' ? ', no new output' : ''}</dd>
  {:else if desk.activity}
    <dt>Last action</dt>
    <dd>{desk.activity.label} <span class="p-note">· {formatAgo(now - desk.activity.since)} ago</span></dd>
  {/if}
  {#if desk.agentsRunning > 0}
    <dt>Subagents</dt>
    <dd>{plural(desk.agentsRunning, 'running', 'running')}</dd>
  {/if}
  <dt>Repo</dt>
  <dd>{island.repo}</dd>
  <dt>Branch</dt>
  <dd><code>{island.branch ?? 'none'}</code>{island.worktree ? ' · worktree' : ''}</dd>
  <dt>Folder</dt>
  <dd><code>{island.path}</code></dd>
  <dt>Pane</dt>
  <dd>{desk.pane ?? 'none'}</dd>
</dl>
<div class="actions">
  <button type="button" class="btn primary" disabled={!desk.focusable} onclick={() => onGo(desk.sessionId)}>
    Go to pane{desk.pane ? ` ${desk.pane}` : ''}
  </button>
  {#if desk.state === 'done'}
    <button type="button" class="btn" onclick={() => onSeen(desk.sessionId)}>Mark as seen</button>
  {/if}
</div>
{#if cannotGo}<p class="p-note">{cannotGo}</p>{/if}

<style>
  .back { align-self: flex-start; }
  .head-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .facts { margin: 0; display: grid; grid-template-columns: 112px minmax(0, 1fr); gap: 8px 12px; }
  dt { color: var(--muted); font-size: 12.5px; }
  dd { margin: 0; overflow-wrap: anywhere; }
  .warn { color: var(--needs-ink); font-weight: 500; }
  code { background: var(--hover); border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
</style>
