<script lang="ts">
  import { setContext } from 'svelte';
  import { createAccordion } from '@uifn/core/primitives/accordion';
  import type { AccordionProps } from '@uifn/core/primitives/accordion';

  interface Props extends AccordionProps {
    children?: import('svelte').Snippet;
    class?: string;
  }

  let {
    type = 'single',
    value: valueProp,
    defaultValue,
    collapsible = false,
    disabled = false,
    onValueChange,
    children,
    class: className,
    ...rest
  }: Props = $props();

  const machine = createAccordion({
    type,
    value: valueProp,
    defaultValue,
    collapsible,
    disabled,
    onValueChange,
  });

  let state = $state(machine.state);

  $effect(() => {
    return machine.subscribe((nextState) => {
      state = nextState;
    });
  });

  function isSameAccordionValue(
    current: string | string[],
    next: string | string[]
  ): boolean {
    if (Array.isArray(current) || Array.isArray(next)) {
      if (!Array.isArray(current) || !Array.isArray(next)) return false;
      if (current.length !== next.length) return false;
      for (let i = 0; i < current.length; i += 1) {
        if (current[i] !== next[i]) return false;
      }
      return true;
    }
    return current === next;
  }

  // Keep machine state in sync when running in controlled mode.
  $effect(() => {
    if (valueProp !== undefined && !isSameAccordionValue(state.value, valueProp)) {
      machine.actions.syncValue(valueProp);
    }
  });

  setContext('accordion', {
    get value() {
      return valueProp !== undefined ? valueProp : state.value;
    },
    get type() {
      return type;
    },
    get collapsible() {
      return collapsible;
    },
    get disabled() {
      return disabled;
    },
    toggleItem: machine.actions.toggleItem,
    setValue: machine.actions.setValue,
  });
</script>

<div class={className} data-orientation="vertical" {...rest}>
  {@render children?.()}
</div>
