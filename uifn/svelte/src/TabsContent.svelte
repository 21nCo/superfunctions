<script lang="ts">
  import { getRequiredContext } from './internal/context';

  interface Props {
    value: string;
    children?: import('svelte').Snippet;
    class?: string;
  }

  let { value, children, class: className, ...rest }: Props = $props();
  const getValue = () => value;

  const context = getRequiredContext<any>(
    'tabs',
    'TabsContent',
    'Tabs components must be used within Tabs'
  );

  let isSelected = $derived(context.value === getValue());
  let triggerId = $derived(`${context.baseId}-trigger-${getValue()}`);
  let contentId = $derived(`${context.baseId}-content-${getValue()}`);
</script>

{#if isSelected}
  <div
    role="tabpanel"
    id={contentId}
    aria-labelledby={triggerId}
    data-state="active"
    data-orientation={context.orientation}
    tabindex="0"
    class={className}
    {...rest}
  >
    {@render children?.()}
  </div>
{/if}
