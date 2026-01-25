<script lang="ts">
  import { getContext } from 'svelte';

  interface Props {
    value: string;
    children?: import('svelte').Snippet;
    class?: string;
  }

  let { value, children, class: className, ...rest }: Props = $props();

  const context = getContext<any>('tabs');

  let isSelected = $derived(context.value === value);
  let triggerId = `${context.baseId}-trigger-${value}`;
  let contentId = `${context.baseId}-content-${value}`;
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
