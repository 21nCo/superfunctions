<script lang="ts">
  import { getRequiredContext } from './internal/context';

  interface Props {
    children?: import('svelte').Snippet;
    class?: string;
    onClick?: (e: MouseEvent) => void;
  }

  let { children, class: className, onClick, ...rest }: Props = $props();
  const context = getRequiredContext<any>(
    'dialog',
    'DialogClose',
    'Dialog components must be used within Dialog'
  );

  function handleClick(e: MouseEvent) {
    context.setOpen(false);
    onClick?.(e);
  }
</script>

<button
  type="button"
  onclick={handleClick}
  class={className}
  {...rest}
>
  {@render children?.()}
</button>
