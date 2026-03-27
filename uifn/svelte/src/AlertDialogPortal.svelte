<script lang="ts">
  import { portal } from './internal/portal';
  import { getRequiredContext } from './internal/context';

  interface Props {
    children?: import('svelte').Snippet;
    container?: HTMLElement;
  }

  let { children, container }: Props = $props();
  const ctx = getRequiredContext<any>(
    'alert-dialog',
    'AlertDialogPortal',
    'AlertDialog components must be used within AlertDialog'
  );
</script>

{#if ctx.open}
  <div use:portal={container}>
    {@render children?.()}
  </div>
{/if}
