<script lang="ts">
  import { portal as portalAction } from './internal/portal';
  import { getRequiredContext } from './internal/context';

  interface Props {
    container?: HTMLElement | string;
    children?: import('svelte').Snippet;
  }

  let { container = 'body', children }: Props = $props();
  const context = getRequiredContext<any>(
    'dialog',
    'DialogPortal',
    'Dialog components must be used within Dialog'
  );
</script>

{#if context.open}
  <div use:portalAction={container}>
    {@render children?.()}
  </div>
{/if}
