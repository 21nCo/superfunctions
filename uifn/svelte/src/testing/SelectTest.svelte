<script lang="ts">
  import Select from '../Select.svelte';
  import SelectTrigger from '../SelectTrigger.svelte';
  import SelectValue from '../SelectValue.svelte';
  import SelectContent from '../SelectContent.svelte';
  import SelectViewport from '../SelectViewport.svelte';
  import SelectItem from '../SelectItem.svelte';
  import SelectItemIndicator from '../SelectItemIndicator.svelte';

  let { defaultValue = '' } = $props();
</script>

<Select {defaultValue}>
  <SelectTrigger>
    <SelectValue placeholder="Select an item" />
  </SelectTrigger>
  <SelectContent>
    <SelectViewport>
      <SelectItem value="item1">
        Item 1
        <SelectItemIndicator />
      </SelectItem>
      <SelectItem value="item2">
        Item 2
        <SelectItemIndicator />
      </SelectItem>
    </SelectViewport>
  </SelectContent>
</Select>
