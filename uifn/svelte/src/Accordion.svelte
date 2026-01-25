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

  // Reactive state wrapper for the core machine
  function createReactiveAccordion(options: AccordionProps) {
    const machine = createAccordion(options);
    let state = $state(machine.state);

    $effect(() => {
      // Sync prop changes to machine if needed? 
      // The machine is created once. Controlled props require sync.
      // For MVP, we assume uncontrolled or simple init.
      // Real impl would watch props.
      
      return machine.subscribe((newState) => {
        state = newState;
      });
    });

    return {
      get value() { return state.value; },
      get type() { return type; }, // Use closure or state?
      get collapsible() { return collapsible; },
      get disabled() { return disabled; },
      toggleItem: machine.actions.toggleItem,
      setValue: machine.actions.setValue
    };
  }

  const accordion = createReactiveAccordion({ type, value: valueProp, defaultValue, collapsible, disabled, onValueChange });

  setContext('accordion', accordion);
</script>

<div class={className} data-orientation="vertical" {...rest}>
  {@render children?.()}
</div>
