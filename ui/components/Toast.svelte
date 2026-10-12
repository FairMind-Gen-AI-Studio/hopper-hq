<script lang="ts">
  import type { Toasts } from '../lib/toast';

  let { toasts }: { toasts: Toasts } = $props();
</script>

<div class="toasts" role="status" aria-live="polite">
  {#each $toasts as toast (toast.id)}
    <div class="toast" class:error={toast.tone === 'error'}>
      <span>{toast.text}</span>
      <button type="button" class="close" aria-label="Dismiss" onclick={() => toasts.dismiss(toast.id)}>×</button>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    left: 50%;
    bottom: calc(18px + env(safe-area-inset-bottom, 0px));
    transform: translateX(-50%);
    display: grid;
    gap: 8px;
    justify-items: center;
    width: max-content;
    max-width: calc(100% - 32px);
    pointer-events: none;
  }
  .toast {
    display: flex;
    align-items: center;
    gap: 10px;
    background: var(--fg);
    color: var(--panel);
    padding: 8px 8px 8px 14px;
    border-radius: 8px;
    font-size: 13px;
    box-shadow: 0 6px 24px var(--shadow);
    pointer-events: auto;
    overflow-wrap: anywhere;
  }
  .toast.error { background: var(--needs-ink); color: var(--badge-fg); }
  .close { background: none; border: 0; padding: 0 6px; cursor: pointer; font-size: 16px; line-height: 1; opacity: .7; }
  .close:hover { opacity: 1; }
</style>
