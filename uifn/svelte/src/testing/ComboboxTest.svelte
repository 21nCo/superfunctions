<script lang="ts">
  import Combobox from '../Combobox.svelte';
  import ComboboxInput from '../ComboboxInput.svelte';
  import ComboboxTrigger from '../ComboboxTrigger.svelte';
  import ComboboxContent from '../ComboboxContent.svelte';
  import ComboboxItem from '../ComboboxItem.svelte';
  import ComboboxItemIndicator from '../ComboboxItemIndicator.svelte';

  let { defaultValue = '' } = $props();
</script>

<Combobox {defaultValue}>
  <div style="display: flex;">
    <ComboboxInput />
    <ComboboxTrigger>▼</ComboboxTrigger>
  </div>
  <ComboboxContent>
    <ComboboxItem value="apple">Apple <ComboboxItemIndicator /></ComboboxItem>
    <ComboboxItem value="banana">Banana <ComboboxItemIndicator /></ComboboxItem>
  </ComboboxContent>
</Combobox>
