<script lang="ts">
  import { getContext } from 'svelte';

  interface Props {
    [key: string]: any;
  }
  let { ...rest }: Props = $props();

  const ctx = getContext<any>('toolbar');
  // Separator orientation is opposite to toolbar orientation (usually)
  // If toolbar is horizontal, separator is vertical.
  let orientation = $derived(ctx?.orientation === 'horizontal' ? 'vertical' : 'horizontal');
</script>

<div
  role="separator"
  aria-orientation={orientation}
  style:background-color="#eee"
  style:width={orientation === 'vertical' ? '1px' : '100%'}
  style:height={orientation === 'vertical' ? '100%' : '1px'}
  style:margin="0 5px"
  {...rest}
></div>
