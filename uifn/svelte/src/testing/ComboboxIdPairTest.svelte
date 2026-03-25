<script lang="ts">
  import Combobox from '../Combobox.svelte';
  import ComboboxInput from '../ComboboxInput.svelte';
  import ComboboxTrigger from '../ComboboxTrigger.svelte';
  import ComboboxContent from '../ComboboxContent.svelte';
  import ComboboxItem from '../ComboboxItem.svelte';
</script>

<Combobox>
  <div>
    <ComboboxInput aria-label="Combobox Alpha" />
    <ComboboxTrigger aria-label="Open Combobox Alpha">Open</ComboboxTrigger>
  </div>
  <ComboboxContent>
    <ComboboxItem value="alpha">Alpha</ComboboxItem>
    <ComboboxItem value="amber">Amber</ComboboxItem>
  </ComboboxContent>
</Combobox>

<Combobox>
  <div>
    <ComboboxInput aria-label="Combobox Beta" />
    <ComboboxTrigger aria-label="Open Combobox Beta">Open</ComboboxTrigger>
  </div>
  <ComboboxContent>
    <ComboboxItem value="beta">Beta</ComboboxItem>
    <ComboboxItem value="bronze">Bronze</ComboboxItem>
  </ComboboxContent>
</Combobox>
