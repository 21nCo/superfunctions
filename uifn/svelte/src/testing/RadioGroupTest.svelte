<script lang="ts">
  import RadioGroup from '../RadioGroup.svelte';
  import RadioGroupItem from '../RadioGroupItem.svelte';
  import RadioGroupIndicator from '../RadioGroupIndicator.svelte';

  let { defaultValue = '1' } = $props();
</script>

<RadioGroup {defaultValue}>
  <RadioGroupItem value="1">Item 1 <RadioGroupIndicator /></RadioGroupItem>
  <RadioGroupItem value="2">Item 2 <RadioGroupIndicator /></RadioGroupItem>
</RadioGroup>
