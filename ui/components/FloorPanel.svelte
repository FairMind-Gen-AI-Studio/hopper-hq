<script lang="ts">
  import type { Checkout, FloorDetail, FloorSummary, MeetingRoom, Occupant } from '../../src/scene/types';
  import { occupantsOf } from '../lib/occupants';
  import { STATES, plural, runCounts, sessionsOf, summaryAge } from '../lib/words';

  /**
   * One floor as a list: a group per checkout (repo, branch, path) and a row per session, at a desk or waiting for one,
   * then a row per meeting room. It is also what a browser without WebGL uses to get around a floor.
   */
  interface Props {
    /** From the building scene: number and name while the detail loads. */
    summary: FloorSummary | undefined;
    /** undefined while loading, null when the floor is gone. */
    floor: FloorDetail | null | undefined;
    /** The desk the route points at. The page shows a desk on the floor in its own panel, so here it can only have left. */
    selected: string | null;
    /** For the ages of the summary lines. */
    now: number;
    onDesk: (sessionId: string) => void;
    onBack: () => void;
    onRun: (runId: string) => void;
  }
  let { summary, floor, selected, now, onDesk, onBack, onRun }: Props = $props();

  /** A checkout's sessions: at their desks in pod and desk order, then those waiting for a desk. */
  interface Group {
    checkout: Checkout;
    /** The repo colour slot of its robots; null while none of them is on the floor. */
    color: number | null;
    rows: { occupant: Occupant; seated: boolean }[];
  }

  const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

  const head = $derived(floor ?? summary);
  const occupants = $derived(floor ? occupantsOf(floor) : []);
  const sessions = $derived(floor ? occupants.length : summary ? sessionsOf(summary) : 0);
  /** The route names a desk that is not on the floor any more. */
  const missing = $derived(selected !== null && !!floor && !occupants.some((o) => o.sessionId === selected));
  /** The floor's sessions by checkout path, ordered by repo, branch, then path. */
  const groups = $derived.by((): Group[] => {
    if (!floor) return [];
    const waiting = new Set(floor.unseated);
    const byPath = new Map<string, Group>();
    for (const occupant of occupants) {
      const row = { occupant, seated: !waiting.has(occupant) };
      const group = byPath.get(occupant.checkout.path);
      if (group) group.rows.push(row);
      else byPath.set(occupant.checkout.path, { checkout: occupant.checkout, color: null, rows: [row] });
    }
    const list = [...byPath.values()];
    for (const g of list) g.color = g.rows.find((r) => r.occupant.robot)?.occupant.robot?.body ?? null;
    return list.sort((a, b) => order(a.checkout.repo, b.checkout.repo) || order(a.checkout.branch ?? '', b.checkout.branch ?? '') || order(a.checkout.path, b.checkout.path));
  });

  function phaseOf(room: MeetingRoom): string {
    const current = room.phases.find((p) => p.state === 'current');
    return current ? `Phase: ${current.title}` : 'No phase yet';
  }
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
  {#each groups as group, i (i)}
    <section class="checkout">
      <div class="checkout-head">
        {#if group.color !== null}<span class="swatch repo-{group.color}" aria-hidden="true"></span>{/if}
        <span class="repo">{group.checkout.repo}</span>
        <span class="br">{group.checkout.branch ?? 'no branch'}{group.checkout.worktree ? ' · worktree' : ''}</span>
      </div>
      <p class="path">{group.checkout.path}</p>
      <ul class="rows">
        {#each group.rows as { occupant, seated } (occupant.sessionId)}
          <li>
            <button type="button" class="row-btn sw-{occupant.state}" onclick={() => onDesk(occupant.sessionId)}>
              <span class="dot" aria-hidden="true"></span>
              <span class="r-name">{occupant.name}</span>
              <span class="r-state">{STATES[occupant.state].label}{seated ? '' : ' · no desk'}</span>
              <span class="r-task">{occupant.title ?? 'No task yet'}</span>
              {#if occupant.summary}
                <span class="r-sum" class:stale={occupant.summary.stale}>{occupant.summary.text} · {summaryAge(occupant.summary, now)}</span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/each}
  {#if floor.rooms.length > 0 || floor.roomsMore > 0}
    <section class="meetings">
      <h3 class="p-h3">Meeting rooms</h3>
      <ul class="rows">
        {#each floor.rooms as room (`${room.hostSessionId}/${room.runId}`)}
          <li>
            <button type="button" class="row-btn sw-in_meeting" onclick={() => onRun(room.runId)}>
              <span class="dot" aria-hidden="true"></span>
              <span class="r-name">{room.name ?? room.runId}</span>
              <span class="r-state">{runCounts(room.counts)}</span>
              <span class="r-task">{phaseOf(room)}</span>
            </button>
          </li>
        {/each}
      </ul>
      {#if floor.roomsMore > 0}
        <p class="p-note">+{plural(floor.roomsMore, 'run', 'runs')} without a room</p>
      {/if}
    </section>
  {/if}
{/if}

<style>
  .back { align-self: flex-start; }
  .gone { color: var(--needs-ink); }
  .checkout-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin: 4px 0 2px; }
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
  .r-name { font-family: var(--font-mono); font-size: 12.5px; font-weight: 500; overflow-wrap: anywhere; }
  .r-task { grid-column: 2; color: var(--muted); font-size: 12.5px; overflow-wrap: anywhere; }
  .r-state { grid-row: span 2; font-size: 12px; color: var(--muted); white-space: nowrap; }
  .r-sum { grid-column: 2 / -1; font-size: 12.5px; overflow-wrap: anywhere; }
  .r-sum.stale { color: var(--muted); }
  .meetings .rows { margin-top: 4px; }
</style>
