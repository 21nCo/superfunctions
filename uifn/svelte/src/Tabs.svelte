<script lang="ts">
  import { setContext } from 'svelte';

  interface Props {
    value?: string;
    defaultValue?: string;
    onValueChange?: (value: string) => void;
    orientation?: 'horizontal' | 'vertical';
    activationMode?: 'automatic' | 'manual';
    children?: import('svelte').Snippet;
    class?: string;
  }

  let {
    value: valueProp,
    defaultValue,
    onValueChange,
    orientation = 'horizontal',
    activationMode = 'automatic',
    children,
    class: className,
    ...rest
  }: Props = $props();

  let _value = $state(defaultValue ?? '');
  let value = $derived(valueProp !== undefined ? valueProp : _value);

  function setValue(val: string) {
    if (valueProp === undefined) {
      _value = val;
    }
    onValueChange?.(val);
  }

  // Simple ID generation
  const baseId = `tabs-${Math.random().toString(36).substr(2, 9)}`;

  setContext('tabs', {
    get value() { return value; },
    setValue,
    orientation,
    activationMode,
    baseId
  });
</script>

<div
  data-orientation={orientation}
  class={className}
  {...rest}
>
  {@render children?.()}
</div>
