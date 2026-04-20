<script lang="ts">
  import { getRequiredContext } from './internal/context';

  interface Props {
    children?: import('svelte').Snippet;
    [key: string]: any;
  }

  let { children, ...rest }: Props = $props();
  const ctx = getRequiredContext<any>(
    'alert-dialog',
    'AlertDialogDescription',
    'AlertDialog components must be used within AlertDialog'
  );
</script>

<p id={`${ctx.baseId}-description`} {...rest}>
  {@render children?.()}
</p>
