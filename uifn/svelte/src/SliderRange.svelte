<script lang="ts">
  import { getContext } from 'svelte';

  interface Props {
    class?: string;
  }

  let { class: className, ...rest }: Props = $props();
  const context = getContext<any>('slider');

  // Assuming range from 0 to first value for single slider, or between values for range.
  // Standard primitive slider usually supports multiple thumbs.
  // If multiple values, range usually fills between min and 1st, or 1st and 2nd?
  // Radix UI default is from start (min) to value if single.
  // Let's implement single value range for simplicity or basic range between 0 and value[0].
  
  let percentage = $derived(((context.value[0] ?? 0) - context.min) / (context.max - context.min) * 100);
</script>

<span
  data-orientation={context.orientation}
  data-disabled={context.disabled ? '' : undefined}
  style="position: absolute; background-color: black; border-radius: 9999px; height: 100%; {context.orientation === 'horizontal' ? `width: ${percentage}%;` : `height: ${percentage}%; bottom: 0;`}"
  class={className}
  {...rest}
></span>
