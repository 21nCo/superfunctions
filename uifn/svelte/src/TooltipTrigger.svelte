<script lang="ts">
  import { getContext, onMount } from 'svelte';

  interface Props {
    children?: import('svelte').Snippet;
    class?: string;
    onMouseEnter?: (e: MouseEvent) => void;
    onMouseLeave?: (e: MouseEvent) => void;
    onFocus?: (e: FocusEvent) => void;
    onBlur?: (e: FocusEvent) => void;
  }

  let { children, class: className, onMouseEnter, onMouseLeave, onFocus, onBlur, ...rest }: Props = $props();
  const context = getContext<any>('tooltip');
  let ref = $state<HTMLElement>();

  onMount(() => {
    if (ref) context.setTriggerElement(ref);
  });

  function handleMouseEnter(e: MouseEvent) {
    context.handleOpen();
    onMouseEnter?.(e);
  }

  function handleMouseLeave(e: MouseEvent) {
    context.handleClose();
    onMouseLeave?.(e);
  }

  function handleFocus(e: FocusEvent) {
    context.handleOpen();
    onFocus?.(e);
  }

  function handleBlur(e: FocusEvent) {
    context.handleClose();
    onBlur?.(e);
  }
</script>

<button
  bind:this={ref}
  type="button"
  data-state={context.open ? 'delayed-open' : 'closed'}
  onmouseenter={handleMouseEnter}
  onmouseleave={handleMouseLeave}
  onfocus={handleFocus}
  onblur={handleBlur}
  class={className}
  {...rest}
>
  {@render children?.()}
</button>
