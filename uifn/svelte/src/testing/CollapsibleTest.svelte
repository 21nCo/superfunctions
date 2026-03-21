<script lang="ts">
  import Collapsible from '../Collapsible.svelte';
  import CollapsibleTrigger from '../CollapsibleTrigger.svelte';
  import CollapsibleContent from '../CollapsibleContent.svelte';

  let { defaultOpen = false, disabled = false } = $props();
</script>

<Collapsible {defaultOpen} {disabled}>
  <CollapsibleTrigger>Toggle section</CollapsibleTrigger>
  <CollapsibleContent>Hidden details</CollapsibleContent>
</Collapsible>
