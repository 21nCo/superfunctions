<script lang="ts">
  import HoverCard from '../HoverCard.svelte';
  import HoverCardTrigger from '../HoverCardTrigger.svelte';
  import HoverCardContent from '../HoverCardContent.svelte';

  let { open = undefined, openDelay = 5, closeDelay = 5 } = $props();
</script>

<HoverCard {open} {openDelay} {closeDelay}>
  <HoverCardTrigger href="/docs">Hover me</HoverCardTrigger>
  <HoverCardContent>Hover content</HoverCardContent>
</HoverCard>
