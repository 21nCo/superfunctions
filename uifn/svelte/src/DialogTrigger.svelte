<script lang="ts">
  import { onMount } from 'svelte';
  import { getRequiredContext } from './internal/context';

  interface DialogContext {
    open: boolean;
    baseId: string;
    setOpen: (value: boolean) => void;
    setTriggerElement: (element: HTMLElement) => void;
  }

  interface Props {
    children?: import('svelte').Snippet;
    class?: string;
    onClick?: (e: MouseEvent) => void;
  }

  let { children, class: className, onClick, ...rest }: Props = $props();

  const context = getRequiredContext<DialogContext>(
    'dialog',
    'DialogTrigger',
    'Dialog components must be used within Dialog'
  );
  let ref = $state<HTMLButtonElement>();

  onMount(() => {
    if (ref) {
      context.setTriggerElement(ref);
    }
  });

  function handleClick(e: MouseEvent) {
    context.setOpen(true);
    onClick?.(e);
  }
</script>

<button
  bind:this={ref}
  type="button"
  aria-haspopup="dialog"
  aria-expanded={context.open}
  aria-controls={context.open ? `${context.baseId}-content` : undefined}
  data-state={context.open ? 'open' : 'closed'}
  onclick={handleClick}
  class={className}
  {...rest}
>
  {@render children?.()}
</button>
