<script lang="ts">
  import { createProgress } from '@uifn/core/primitives/progress';
  import { setContext } from 'svelte';

  interface Props {
    value?: number | null;
    max?: number;
    children?: import('svelte').Snippet;
    class?: string;
  }

  let { value: valueProp, max = 100, children, class: className, ...rest }: Props = $props();
  const initialValue = (() => valueProp)();
  const initialMax = (() => max)();

  const machine = createProgress({ value: initialValue, max: initialMax });
  let state = $state(machine.state);

  $effect(() => {
    return machine.subscribe((newState) => {
      state = newState;
    });
  });

  $effect(() => {
    machine.setValue(valueProp !== undefined ? valueProp : null);
  });

  setContext('progress', {
    get value() { return state.value; },
    get max() { return state.max; }
  });
</script>

<div
  role="progressbar"
  aria-valuemax={max}
  aria-valuemin={0}
  aria-valuenow={state.value ?? undefined}
  aria-valuetext={state.value === null ? 'Indeterminate' : `${Math.round((state.value / max) * 100)}%`}
  data-state={state.value === null ? 'indeterminate' : 'loading'} 
  data-value={state.value}
  data-max={max}
  class={className}
  {...rest}
>
  {@render children?.()}
</div>
