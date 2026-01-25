<script lang="ts">
  import { getContext } from 'svelte';

  interface Props {
    index?: number;
    class?: string;
  }

  let { index = 0, class: className, ...rest }: Props = $props();
  const context = getContext<any>('slider');

  let value = $derived(context.value[index] ?? context.min);
  let percent = $derived((value - context.min) / (context.max - context.min) * 100);

  function handleKeyDown(e: KeyboardEvent) {
    if (context.disabled) return;
    let nextValue = value;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      nextValue = Math.min(context.max, value + context.step);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      nextValue = Math.max(context.min, value - context.step);
    } else if (e.key === 'Home') {
      nextValue = context.min;
    } else if (e.key === 'End') {
      nextValue = context.max;
    } else {
        return;
    }
    e.preventDefault();
    context.updateThumb(index, nextValue);
  }
</script>

<span
  role="slider"
  aria-valuemin={context.min}
  aria-valuemax={context.max}
  aria-valuenow={value}
  aria-orientation={context.orientation}
  data-orientation={context.orientation}
  data-disabled={context.disabled ? '' : undefined}
  tabindex={context.disabled ? undefined : 0}
  onkeydown={handleKeyDown}
  style="display: block; width: 20px; height: 20px; border-radius: 10px; background-color: white; box-shadow: 0 2px 10px black; position: absolute; transform: translate(-50%, -50%); {context.orientation === 'horizontal' ? `left: ${percent}%; top: 50%;` : `bottom: ${percent}%; left: 50%;`}"
  class={className}
  {...rest}
></span>
