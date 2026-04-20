<script lang="ts">
  import Select from '../Select.svelte';
  import SelectTrigger from '../SelectTrigger.svelte';
  import SelectValue from '../SelectValue.svelte';
  import SelectContent from '../SelectContent.svelte';
  import SelectViewport from '../SelectViewport.svelte';
  import SelectItem from '../SelectItem.svelte';
</script>

<Select>
  <SelectTrigger aria-label="Select Alpha">
    <SelectValue placeholder="Select Alpha" />
  </SelectTrigger>
  <SelectContent>
    <SelectViewport>
      <SelectItem value="alpha-1">Alpha 1</SelectItem>
      <SelectItem value="alpha-2">Alpha 2</SelectItem>
    </SelectViewport>
  </SelectContent>
</Select>

<Select>
  <SelectTrigger aria-label="Select Beta">
    <SelectValue placeholder="Select Beta" />
  </SelectTrigger>
  <SelectContent>
    <SelectViewport>
      <SelectItem value="beta-1">Beta 1</SelectItem>
      <SelectItem value="beta-2">Beta 2</SelectItem>
    </SelectViewport>
  </SelectContent>
</Select>
