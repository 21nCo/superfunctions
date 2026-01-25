<script lang="ts">
  import { getContext } from 'svelte';

  interface Props {
    placeholder?: string;
    [key: string]: any;
  }

  let { placeholder, ...rest }: Props = $props();
  const ctx = getContext<any>('select');
</script>

<span style:pointer-events="none" {...rest}>
  {#if ctx.value === '' && placeholder}
    {placeholder}
  {:else}
    {ctx.value}
  {/if}
</span>
