<script lang="ts">
  import { setContext } from 'svelte';
  import { getRequiredContext } from './internal/context';
  
  interface Props {
    value: string;
    disabled?: boolean;
    children?: import('svelte').Snippet;
    class?: string;
  }

  let { value, disabled = false, children, class: className, ...rest }: Props = $props();
  const getValue = () => value;

  const accordion = getRequiredContext<any>(
    'accordion',
    'AccordionItem',
    'Accordion components must be used within Accordion'
  );
  
  let open = $derived(
    accordion.type === 'single' 
      ? accordion.value === getValue() 
      : (accordion.value as string[]).includes(getValue())
  );
  
  let itemDisabled = $derived(accordion.disabled || disabled);

  setContext('accordion-item', { 
    get value() { return getValue(); },
    get open() { return open }, 
    get disabled() { return itemDisabled } 
  });
</script>

<div 
  class={className}
  data-state={open ? 'open' : 'closed'}
  data-disabled={itemDisabled ? '' : undefined}
  {...rest}
>
  {@render children?.()}
</div>
