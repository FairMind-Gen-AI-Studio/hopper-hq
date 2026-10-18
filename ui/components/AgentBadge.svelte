<script lang="ts">
  import type { AgentKind } from '../../src/core/types';
  import { AGENT_BADGES } from '../lib/agent-badge';
  let { kind }: { kind: AgentKind } = $props();
</script>

<span class="agent-badge agent-badge--{kind}" aria-hidden="true">
  <img src={AGENT_BADGES[kind].image} alt="" width="18" height="18" draggable="false" />
</span>
