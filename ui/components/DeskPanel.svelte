<script lang="ts">
  import { formatAgo } from '../../src/scene/text';
  import type { FloorDetail, Occupant } from '../../src/scene/types';
  import { singleClick } from '../lib/click';
  import { plural, raisedBy, runSpan, summaryAge, waitText } from '../lib/words';
  import AgentBadge from './AgentBadge.svelte';
  import StatePill from './StatePill.svelte';

  /**
   * One session: what it does, where it stands, what it waits for, where it runs; the two things to do from here; and
   * its interns and workflow runs. A session without a desk says so, in words: the floor has no robot of it to show.
   */
  interface Props {
    /** The session: at a desk on the floor, or waiting for one. */
    desk: Occupant;
    floor: Pick<FloorDetail, 'number' | 'name' | 'rooms' | 'unseated'>;
    now: number;
    onBack: () => void;
    onGo: (sessionId: string) => void;
    onSeen: (sessionId: string) => void;
    /** Opens a run that has a room on the floor. */
    onRun: (runId: string) => void;
  }
  let { desk, floor, now, onBack, onGo, onSeen, onRun }: Props = $props();

  const where = $derived(desk.location === 'cloud' ? 'remote' : desk.pane ? `tmux pane ${desk.pane}` : 'not in tmux');
  const by = $derived(raisedBy(desk.reason));
  /** Why Go is off, when it is. */
  const cannotGo = $derived.by(() => {
    if (desk.focusable) return null;
    if (desk.location === 'cloud') return 'It runs in the cloud: there is no tmux pane to go to.';
    return 'It does not run in a tmux pane, so there is nowhere to go.';
  });
  /** The runs with a room on the floor: their rows open them. */
  const roomed = $derived(new Set(floor.rooms.map((r) => r.runId)));
  /** It is among the floor's sessions without a desk: waiting for one, or dormant with its desk given to another. */
  const deskless = $derived(floor.unseated.some((o) => o.sessionId === desk.sessionId));
</script>

<button type="button" class="linkbtn back" onclick={singleClick(onBack)}>← Floor {floor.number} · {floor.name}</button>
<div>
  <p class="eyebrow">{desk.checkout.repo} · {where}</p>
  <div class="head-row">
    <h2 tabindex="-1" class="p-title mono">{desk.name}</h2>
    <StatePill state={desk.state} />
    {#if desk.location === 'cloud'}<span class="tag">remote</span>{/if}
  </div>
</div>
<p class="p-text">{desk.title ?? 'No task yet.'}</p>
{#if deskless}
  <p class="p-note no-desk">No desk: {desk.state === 'dormant' ? 'dormant' : 'waiting for a free desk'}</p>
{/if}
{#if desk.summary}
  <section class="summary" class:stale={desk.summary.stale}>
    <h3 class="p-h3">Where it stands</h3>
    <p class="s-text">{desk.summary.text}</p>
    <p class="p-note s-age">{summaryAge(desk.summary, now)}</p>
  </section>
{/if}
<dl class="facts">
  {#if desk.state === 'needs_you'}
    <dt>Waiting for</dt>
    <dd class="warn">{waitText(desk.reason)}{by ? ` · ${by}` : ''}</dd>
  {/if}
  <dt>Since</dt>
  <dd>{formatAgo(now - desk.since)} ago</dd>
  {#if desk.activity?.running}
    <dt>Running</dt>
    <!-- The call's own dropped-call mark (hq-mcp-switchboard proposal.md §2), the non-visual echo of the floor's own red flash, and its "×N" ("parallel MCP calls" follow-up, OnCallView.count): desk.call only exists while the activity is the call itself, running. -->
    <dd><code>{desk.activity.label}{desk.call?.count && desk.call.count > 1 ? ` ×${desk.call.count}` : ''}{desk.call?.error ? ' ✗' : ''}</code> for {formatAgo(now - desk.activity.since)}{desk.state === 'no_signal' ? ', no new output' : ''}</dd>
  {:else if desk.activity}
    <dt>Last action</dt>
    <dd>{desk.activity.label} <span class="p-note">· {formatAgo(now - desk.activity.since)} ago</span></dd>
  {/if}
  {#if desk.agentsRunning > 0}
    <dt>Subagents</dt>
    <dd>{plural(desk.agentsRunning, 'running', 'running')}</dd>
  {/if}
  <dt>Agent</dt>
  <dd class="agent-name"><AgentBadge kind={desk.agentKind} />{desk.agentKind === 'codex' ? 'Codex' : 'Claude Code'}</dd>
  <dt>Repo</dt>
  <dd>{desk.checkout.repo}</dd>
  <dt>Branch</dt>
  <dd><code>{desk.checkout.branch ?? 'none'}</code>{desk.checkout.worktree ? ' · worktree' : ''}</dd>
  <dt>Folder</dt>
  <dd><code>{desk.checkout.path}</code></dd>
  <dt>Pane</dt>
  <dd>{desk.pane ?? 'none'}</dd>
</dl>
<div class="actions">
  <button type="button" class="btn primary" disabled={!desk.focusable} onclick={singleClick(() => onGo(desk.sessionId))}>
    Go to pane{desk.pane ? ` ${desk.pane}` : ''}
  </button>
  {#if desk.state === 'done'}
    <button type="button" class="btn" onclick={singleClick(() => onSeen(desk.sessionId))}>Mark as seen</button>
  {/if}
</div>
{#if cannotGo}<p class="p-note">{cannotGo}</p>{/if}
{#if desk.interns.length > 0}
  <section>
    <h3 class="p-h3">Interns</h3>
    <ul class="list">
      {#each desk.interns as intern, i (i)}
        <li>
          <span class="dot {intern.running ? 'sw-working' : 'sw-idle'}" aria-hidden="true"></span>
          <span class="l-name">{intern.type ?? 'Subagent'}</span>
          <span class="l-state">{intern.running ? 'running' : 'finished'}</span>
          {#if intern.label}<span class="l-sub">{intern.label}</span>{/if}
        </li>
      {/each}
      {#if desk.internsMore > 0}<li class="more">+{desk.internsMore} more</li>{/if}
    </ul>
  </section>
{/if}
{#if desk.runs.length > 0}
  <section>
    <h3 class="p-h3">Workflow runs</h3>
    <ul class="list">
      {#each desk.runs as run (run.runId)}
        <li>
          <span class="dot {run.status === 'running' ? 'sw-in_meeting' : 'sw-idle'}" aria-hidden="true"></span>
          {#if roomed.has(run.runId)}
            <button type="button" class="linkbtn l-name" onclick={singleClick(() => onRun(run.runId))}>{run.name ?? run.runId}</button>
          {:else}
            <span class="l-name">{run.name ?? run.runId}</span>
          {/if}
          <span class="l-state">{runSpan(run, now)}</span>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .agent-name { display: flex; align-items: center; gap: 8px; }
  .back { align-self: flex-start; }
  .head-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .facts { margin: 0; display: grid; grid-template-columns: 112px minmax(0, 1fr); gap: 8px 12px; }
  dt { color: var(--muted); font-size: 12.5px; }
  dd { margin: 0; overflow-wrap: anywhere; }
  .warn { color: var(--needs-ink); font-weight: 500; }
  code { background: var(--hover); border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .s-text { margin: 0; max-width: 62ch; overflow-wrap: anywhere; }
  .s-age { margin-top: 2px; }
  .stale .s-text { color: var(--muted); }
  .list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  .list li { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; align-items: center; gap: 2px 10px; }
  .l-name { overflow-wrap: anywhere; justify-self: start; text-align: left; }
  button.l-name { padding: 0; }
  .l-state { color: var(--muted); font-size: 12.5px; white-space: nowrap; }
  .l-sub { grid-column: 2 / -1; color: var(--muted); font-size: 12.5px; overflow-wrap: anywhere; }
  .more { color: var(--muted); font-size: 12.5px; }
  .list li.more { display: block; padding-left: 20px; }
</style>
