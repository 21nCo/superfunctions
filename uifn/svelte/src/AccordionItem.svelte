<script lang="ts">
  import { getContext, setContext } from 'svelte';
  
  interface Props {
    value: string;
    disabled?: boolean;
    children?: import('svelte').Snippet;
    class?: string;
  }

  let { value, disabled = false, children, class: className, ...rest }: Props = $props();

  const accordion = getContext<any>('accordion');
  
  let open = $derived(
    accordion.type === 'single' 
      ? accordion.value === value 
      : (accordion.value as string[]).includes(value)
  );
  
  let itemDisabled = $derived(accordion.disabled || disabled);

  setContext('accordion-item', { 
    value, 
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
