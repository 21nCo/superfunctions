<script lang="ts">
  import { getRequiredContext } from './internal/context';

  interface Props {
    loop?: boolean;
    children?: import('svelte').Snippet;
    class?: string;
  }

  let { loop = true, children, class: className, ...rest }: Props = $props();

  const context = getRequiredContext<any>(
    'tabs',
    'TabsList',
    'Tabs components must be used within Tabs'
  );
</script>

<div
  role="tablist"
  aria-orientation={context.orientation}
  class={className}
  {...rest}
>
  {@render children?.()}
</div>
