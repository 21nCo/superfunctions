<script lang="ts">
  import { getContext } from 'svelte';

  interface Props {
    forceMount?: boolean;
    children?: import('svelte').Snippet;
    class?: string;
  }

  let { forceMount = false, children, class: className, ...rest }: Props = $props();

  const item = getContext<any>('radio-group-item');
</script>

{#if forceMount || item.checked}
  <span
    data-state={item.checked ? 'checked' : 'unchecked'}
    data-disabled={item.disabled ? '' : undefined}
    class={className}
    {...rest}
  >
    {@render children?.()}
  </span>
{/if}
