<script lang="ts">
  import { getRequiredContext } from './internal/context';

  interface SliderContext {
    value: number[];
    min: number;
    max: number;
    orientation: 'horizontal' | 'vertical';
    disabled: boolean;
  }

  interface Props {
    class?: string;
  }

  let { class: className, ...rest }: Props = $props();
  const context = getRequiredContext<SliderContext>(
    'slider',
    'SliderRange',
    'SliderRange must be used within a Slider'
  );

  let values = $derived([...context.value].sort((a, b) => a - b));
  let startPercentage = $derived(((values[0] ?? context.min) - context.min) / (context.max - context.min) * 100);
  let endPercentage = $derived(((values[values.length - 1] ?? context.min) - context.min) / (context.max - context.min) * 100);
  let sizePercentage = $derived(Math.max(0, endPercentage - startPercentage));
</script>

<span
  data-orientation={context.orientation}
  data-disabled={context.disabled ? '' : undefined}
  style="position: absolute; background-color: black; border-radius: 9999px; {context.orientation === 'horizontal' ? `left: ${startPercentage}%; width: ${sizePercentage}%; height: 100%;` : `bottom: ${startPercentage}%; height: ${sizePercentage}%; width: 100%;`}"
  class={className}
  {...rest}
></span>
