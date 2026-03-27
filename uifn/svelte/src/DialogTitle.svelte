<script lang="ts">
  import { getRequiredContext } from './internal/context';

  interface Props {
    children?: import('svelte').Snippet;
    class?: string;
  }

  let { children, class: className, ...rest }: Props = $props();
  const context = getRequiredContext<any>(
    'dialog',
    'DialogTitle',
    'Dialog components must be used within Dialog'
  );
</script>

<h2
  id={context.baseId + '-title'}
  class={className}
  {...rest}
>
  {@render children?.()}
</h2>
