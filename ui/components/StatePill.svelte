<script lang="ts">
  import type { ShownState } from '../../src/scene/types';
  import { STATES } from '../lib/words';

  let { state }: { state: ShownState } = $props();
</script>

<span class="pill sw-{state}">{STATES[state].label}</span>
