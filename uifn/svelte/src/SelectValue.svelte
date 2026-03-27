<script lang="ts">
  import { getRequiredContext } from './internal/context';

  interface Props {
    placeholder?: string;
    [key: string]: any;
  }

  let { placeholder, ...rest }: Props = $props();
  const ctx = getRequiredContext<any>(
    'select',
    'SelectValue',
    'Select components must be used within a Select'
  );
</script>

<span style:pointer-events="none" {...rest}>
  {#if ctx.value === '' && placeholder}
    {placeholder}
  {:else}
    {ctx.value}
  {/if}
</span>
