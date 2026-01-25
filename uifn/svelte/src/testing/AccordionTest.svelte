<script lang="ts">
  import Accordion from '../Accordion.svelte';
  import AccordionItem from '../AccordionItem.svelte';
  import AccordionTrigger from '../AccordionTrigger.svelte';
  import AccordionContent from '../AccordionContent.svelte';

  let { type = 'single', defaultValue = undefined } = $props();
</script>

<Accordion {type} {defaultValue}>
  <AccordionItem value="item-1">
    <AccordionTrigger>Trigger 1</AccordionTrigger>
    <AccordionContent>Content 1</AccordionContent>
  </AccordionItem>
  <AccordionItem value="item-2">
    <AccordionTrigger>Trigger 2</AccordionTrigger>
    <AccordionContent>Content 2</AccordionContent>
  </AccordionItem>
</Accordion>
