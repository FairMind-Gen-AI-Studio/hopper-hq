<script lang="ts">
  import type { RunStatus } from '../../src/core/types';
  import type { FloorDetail } from '../../src/scene/types';
  import { singleClick } from '../lib/click';
  import { findRun, runName } from '../lib/runs';
  import { PHASE, RUN_STATUS, runCounts, runSpan } from '../lib/words';

  /**
   * One workflow run on a floor. While it has a room: its phases, its agents and how many run. Once the room has closed,
   * what the host desk's runs still say of it. Go takes the host's tmux pane.
   */
  interface Props {
    floor: FloorDetail;
    runId: string;
    now: number;
    onBack: () => void;
    /** Opens the host desk. */
    onDesk: (sessionId: string) => void;
    /** Goes to the host's pane. */
    onGo: (sessionId: string) => void;
  }
  let { floor, runId, now, onBack, onDesk, onGo }: Props = $props();

  /** The pill's colour: a running run has the meeting colour, an outcome the colour of what it asks of the user. */
  const TONE: Record<RunStatus, string> = { running: 'sw-in_meeting', completed: 'sw-done', failed: 'sw-needs_you', killed: 'sw-idle' };

  const found = $derived(findRun(floor, runId));
  const status = $derived<RunStatus | null>(found?.room ? 'running' : (found?.run?.status ?? null));
  const counts = $derived(found?.room?.counts ?? found?.run?.counts ?? null);
  /** Why Go is off, when it is. */
  const cannotGo = $derived.by(() => {
    if (!found || found.desk.focusable) return null;
    if (found.desk.location === 'cloud') return 'Its host runs in the cloud: there is no tmux pane to go to.';
    return 'Its host does not run in a tmux pane, so there is nowhere to go.';
  });
</script>

<button type="button" class="linkbtn back" onclick={singleClick(onBack)}>← Floor {floor.number} · {floor.name}</button>
<div>
  <p class="eyebrow">Workflow run{found ? ` · ${found.island.repo}` : ''}</p>
  <div class="head-row">
    <h2 tabindex="-1" class="p-title mono">{found ? runName(found, runId) : runId}</h2>
    {#if status}<span class="pill {TONE[status]}">{RUN_STATUS[status]}</span>{/if}
  </div>
</div>
{#if !found}
  <p class="p-text">This run is no longer on this floor.</p>
{:else}
  {#if found.room?.summary}
    <p class="p-text">{found.room.summary}</p>
  {/if}
  {#if !found.room}
    <p class="p-note">{status === 'running' ? 'This run has no room on this floor.' : 'This run has finished, and its room has closed.'}</p>
  {/if}
  <dl class="facts">
    {#if found.run}
      <dt>Status</dt>
      <dd>{runSpan(found.run, now)}</dd>
    {/if}
    {#if counts}
      <dt>Agents</dt>
      <dd>{runCounts(counts)}</dd>
    {/if}
    <dt>Host</dt>
    <dd><button type="button" class="linkbtn host" onclick={singleClick(() => onDesk(found.desk.sessionId))}>{found.desk.name}</button></dd>
    <dt>Run id</dt>
    <dd><code>{runId}</code></dd>
  </dl>
  {#if found.room}
    {#if found.room.phases.length > 0}
      <section>
        <h3 class="p-h3">Phases</h3>
        <ol class="phases">
          {#each found.room.phases as phase, i (i)}
            <li class="ph-{phase.state}">
              <span class="mark" aria-hidden="true">{PHASE[phase.state].mark}</span>
              <span class="ph-title">{phase.title}</span>
              <span class="visually-hidden">, {PHASE[phase.state].word}</span>
            </li>
          {/each}
        </ol>
      </section>
    {/if}
    <section>
      <h3 class="p-h3">Agents</h3>
      {#if found.room.agents.length > 0}
        <ul class="agents">
          {#each found.room.agents as agent (agent.agentId)}
            <li>
              <span class="dot {agent.running ? 'sw-in_meeting' : 'sw-idle'}" aria-hidden="true"></span>
              <span class="a-name">{agent.label ?? agent.type ?? 'Agent'}</span>
              <span class="a-meta">{agent.phase ? `${agent.phase} · ` : ''}{agent.running ? 'running' : 'finished'}</span>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="p-note">No agent has started yet.</p>
      {/if}
    </section>
  {/if}
  <div class="actions">
    <button type="button" class="btn primary" disabled={!found.desk.focusable} onclick={singleClick(() => onGo(found.desk.sessionId))}>
      Go to pane{found.desk.pane ? ` ${found.desk.pane}` : ''}
    </button>
  </div>
  {#if cannotGo}<p class="p-note">{cannotGo}</p>{/if}
{/if}

<style>
  .back { align-self: flex-start; }
  .head-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .facts { margin: 0; display: grid; grid-template-columns: 112px minmax(0, 1fr); gap: 8px 12px; }
  dt { color: var(--muted); font-size: 12.5px; }
  dd { margin: 0; overflow-wrap: anywhere; }
  .host { padding: 0; }
  code { background: var(--hover); border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; }
  .phases, .agents { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  .phases li { display: flex; align-items: baseline; gap: 8px; overflow-wrap: anywhere; }
  .mark { width: 14px; flex: none; text-align: center; color: var(--muted); }
  .ph-done .mark { color: var(--done-ink); }
  .ph-current { font-weight: 600; }
  .ph-current .mark { color: var(--meeting-ink); }
  .ph-upcoming .ph-title { color: var(--muted); }
  .agents li { display: grid; grid-template-columns: 10px minmax(0, 1fr); align-items: center; gap: 2px 10px; }
  .a-name { overflow-wrap: anywhere; }
  .a-meta { grid-column: 2; color: var(--muted); font-size: 12.5px; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
</style>
