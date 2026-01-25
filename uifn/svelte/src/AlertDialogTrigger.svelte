<script lang="ts">
  import { getContext } from 'svelte';
  
  interface Props {
    children?: import('svelte').Snippet;
    [key: string]: any;
  }

  let { children, ...rest }: Props = $props();

  const ctx = getContext<any>('alert-dialog');

  function handleClick(e: MouseEvent) {
    if (rest.onclick) rest.onclick(e);
    if (!e.defaultPrevented) {
      ctx.setOpen(true);
    }
  }
</script>

<button
  type="button"
  aria-haspopup="dialog"
  aria-expanded={ctx.open}
  aria-controls={ctx.open ? `${ctx.baseId}-content` : undefined}
  data-state={ctx.open ? 'open' : 'closed'}
  {...rest}
  onclick={handleClick}
>
  {@render children?.()}
</button>
