<script lang="ts">
  import type { Connection } from '../lib/store';

  /** What the page cannot show, and what to do about it. Nothing while the stream is live. */
  let { connection, hasScene }: { connection: Connection; hasScene: boolean } = $props();
</script>

{#if connection === 'signed_out'}
  <div class="notice bad" role="alert">
    <strong>You are signed out.</strong>
    <span>Run <code>scranton-hq ui</code> in a terminal: it opens a new sign-in link.</span>
  </div>
{:else if connection === 'retrying'}
  <div class="notice" role="status">
    <strong>Lost contact with the daemon.</strong>
    <span>Retrying… If it has stopped, start it again with <code>scranton-hq start</code>.</span>
  </div>
{:else if connection === 'connecting' && !hasScene}
  <div class="notice" role="status"><span>Connecting to the daemon…</span></div>
{/if}

<style>
  .notice {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 10px;
    padding: 8px 12px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--panel);
    font-size: 13px;
  }
  .bad { border-color: color-mix(in oklab, var(--s-needs) 55%, var(--line)); }
  .bad strong { color: var(--needs-ink); }
  code { background: var(--hover); border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; }
</style>
