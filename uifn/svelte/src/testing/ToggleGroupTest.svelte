<script lang="ts">
  import ToggleGroup from '../ToggleGroup.svelte';
  import ToggleGroupItem from '../ToggleGroupItem.svelte';

  let { type = 'single', defaultValue = 'left' } = $props();
</script>

<ToggleGroup {type} {defaultValue}>
  <ToggleGroupItem value="left">Left</ToggleGroupItem>
  <ToggleGroupItem value="right">Right</ToggleGroupItem>
</ToggleGroup>
