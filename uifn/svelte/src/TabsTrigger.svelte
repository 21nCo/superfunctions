<script lang="ts">
  import { onMount } from 'svelte';
  import { getRequiredContext } from './internal/context';

  interface Props {
    value: string;
    disabled?: boolean;
    children?: import('svelte').Snippet;
    class?: string;
    onClick?: (e: MouseEvent) => void;
    onFocus?: (e: FocusEvent) => void;
    onKeyDown?: (e: KeyboardEvent) => void;
  }

  let { value, disabled = false, children, class: className, onClick, onFocus, onKeyDown, ...rest }: Props = $props();
  const getValue = () => value;

  const context = getRequiredContext<any>(
    'tabs',
    'TabsTrigger',
    'Tabs components must be used within Tabs'
  );
  let el: HTMLButtonElement;

  let isSelected = $derived(context.value === getValue());
  let isFocused = $derived((context.focusedItem ?? context.value) === getValue());
  let triggerId = $derived(`${context.baseId}-trigger-${getValue()}`);
  let contentId = $derived(`${context.baseId}-content-${getValue()}`);

  onMount(() => {
    context.registerTrigger(getValue(), el, disabled);
    return () => {
      context.unregisterTrigger(getValue());
    };
  });

  function handleClick(e: MouseEvent) {
    if (!disabled) {
      context.setValue(getValue());
      context.focusItem(getValue());
    }
    onClick?.(e);
  }

  function handleFocus(e: FocusEvent) {
    if (!disabled) {
      context.focusItem(getValue());
      if (context.activationMode === 'automatic') {
        context.setValue(getValue());
      }
    }
    onFocus?.(e);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (disabled) return;
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      context.handleTriggerKeyDown(e.key, getValue());
      onKeyDown?.(e);
      return;
    }

    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      context.setValue(getValue());
    }
    onKeyDown?.(e);
  }
</script>

<button
  bind:this={el}
  type="button"
  role="tab"
  aria-selected={isSelected}
  aria-controls={contentId}
  id={triggerId}
  data-state={isSelected ? 'active' : 'inactive'}
  data-disabled={disabled ? '' : undefined}
  disabled={disabled}
  tabindex={isFocused ? 0 : -1}
  onclick={handleClick}
  onfocus={handleFocus}
  onkeydown={handleKeyDown}
  class={className}
  {...rest}
>
  {@render children?.()}
</button>
