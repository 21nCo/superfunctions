<script lang="ts">
  import { onMount } from 'svelte';
  import { getRequiredContext } from './internal/context';

  interface PopoverContext {
    open: boolean;
    contentId: string;
    setOpen: (value: boolean) => void;
    setTriggerElement: (el: HTMLElement) => void;
  }

  interface Props {
    children?: import('svelte').Snippet;
    class?: string;
    onClick?: (e: MouseEvent) => void;
  }

  let { children, class: className, onClick, ...rest }: Props = $props();
  const context = getRequiredContext<PopoverContext>(
    'popover',
    'PopoverTrigger',
    'Popover components must be used within a Popover'
  );
  let ref = $state<HTMLElement>();

  onMount(() => {
    if (ref) context.setTriggerElement(ref);
  });

  function handleClick(e: MouseEvent) {
    context.setOpen(!context.open);
    onClick?.(e);
  }
</script>

<button
  bind:this={ref}
  type="button"
  aria-haspopup="dialog"
  aria-expanded={context.open}
  aria-controls={context.open ? context.contentId : undefined}
  data-state={context.open ? 'open' : 'closed'}
  onclick={handleClick}
  class={className}
  {...rest}
>
  {@render children?.()}
</button>
