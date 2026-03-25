<script lang="ts">
  import { getRequiredContext } from './internal/context';

  interface Props {
    children?: import('svelte').Snippet;
    class?: string;
  }

  let { children, class: className, ...rest }: Props = $props();
  const context = getRequiredContext<any>(
    'dialog',
    'DialogDescription',
    'Dialog components must be used within Dialog'
  );
</script>

<p
  id={context.baseId + '-desc'}
  class={className}
  {...rest}
>
  {@render children?.()}
</p>
