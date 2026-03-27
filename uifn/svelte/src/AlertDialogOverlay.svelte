<script lang="ts">
  import { getRequiredContext } from './internal/context';

  interface Props {
    children?: import('svelte').Snippet;
    [key: string]: any;
  }

  let { children, ...rest }: Props = $props();
  const ctx = getRequiredContext<any>(
    'alert-dialog',
    'AlertDialogOverlay',
    'AlertDialog components must be used within AlertDialog'
  );
</script>

<div
  data-state={ctx.open ? 'open' : 'closed'}
  aria-hidden="true"
  style="position: fixed; inset: 0; z-index: 50; background-color: rgba(0,0,0,0.5);"
  {...rest}
>
  {@render children?.()}
</div>
