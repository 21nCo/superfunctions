<script lang="ts">
  import Tooltip from '../Tooltip.svelte';
  import TooltipTrigger from '../TooltipTrigger.svelte';
  import TooltipContent from '../TooltipContent.svelte';

  let { defaultOpen = false, delayDuration = 0 } = $props();
</script>

<Tooltip {defaultOpen} {delayDuration}>
  <TooltipTrigger>Hover me</TooltipTrigger>
  <TooltipContent>Tooltip Content</TooltipContent>
</Tooltip>
