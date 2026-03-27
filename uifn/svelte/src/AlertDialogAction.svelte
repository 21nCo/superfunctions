<script lang="ts">
  import { getRequiredContext } from './internal/context';

  interface Props {
    children?: import('svelte').Snippet;
    [key: string]: any;
  }

  let { children, ...rest }: Props = $props();
  const ctx = getRequiredContext<any>(
    'alert-dialog',
    'AlertDialogAction',
    'AlertDialog components must be used within AlertDialog'
  );

  function handleClick(e: MouseEvent) {
    if (rest.onclick) rest.onclick(e);
    if (!e.defaultPrevented) {
      ctx.setOpen(false);
    }
  }
</script>

<button type="button" {...rest} onclick={handleClick}>
  {@render children?.()}
</button>
