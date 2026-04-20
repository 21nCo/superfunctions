<script lang="ts">
  import { getRequiredContext } from './internal/context';

  interface Props {
    children?: import('svelte').Snippet;
    [key: string]: any;
  }

  let { children, ...rest }: Props = $props();
  const ctx = getRequiredContext<any>(
    'alert-dialog',
    'AlertDialogTitle',
    'AlertDialog components must be used within AlertDialog'
  );
</script>

<h2 id={`${ctx.baseId}-title`} {...rest}>
  {@render children?.()}
</h2>
