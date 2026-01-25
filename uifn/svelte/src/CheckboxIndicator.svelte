<script lang="ts">
  import { getContext } from 'svelte';

  interface Props {
    forceMount?: boolean;
    children?: import('svelte').Snippet;
    class?: string;
  }

  let { forceMount = false, children, class: className, ...rest }: Props = $props();

  const checkbox = getContext<any>('checkbox');
</script>

{#if forceMount || checkbox.checked}
  <span
    data-state={checkbox.checked === 'indeterminate' ? 'indeterminate' : (checkbox.checked ? 'checked' : 'unchecked')}
    data-disabled={checkbox.disabled ? '' : undefined}
    class={className}
    {...rest}
  >
    {@render children?.()}
  </span>
{/if}
