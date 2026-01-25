<script lang="ts">
  import Popover from '../Popover.svelte';
  import PopoverTrigger from '../PopoverTrigger.svelte';
  import PopoverContent from '../PopoverContent.svelte';

  let { defaultOpen = false } = $props();
</script>

<Popover {defaultOpen}>
  <PopoverTrigger>Open Popover</PopoverTrigger>
  <PopoverContent>Popover Content</PopoverContent>
</Popover>
