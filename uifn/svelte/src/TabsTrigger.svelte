<script lang="ts">
  import { getContext } from 'svelte';

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

  const context = getContext<any>('tabs');

  let isSelected = $derived(context.value === value);
  let triggerId = `${context.baseId}-trigger-${value}`;
  let contentId = `${context.baseId}-content-${value}`;

  function handleClick(e: MouseEvent) {
    if (!disabled) {
      context.setValue(value);
    }
    onClick?.(e);
  }

  function handleFocus(e: FocusEvent) {
    if (!disabled && context.activationMode === 'automatic') {
      context.setValue(value);
    }
    onFocus?.(e);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (disabled) return;
    // Basic navigation support (Roving Focus is better but requires list context or DOM traversal)
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      context.setValue(value);
    }
    onKeyDown?.(e);
  }
</script>

<button
  type="button"
  role="tab"
  aria-selected={isSelected}
  aria-controls={contentId}
  id={triggerId}
  data-state={isSelected ? 'active' : 'inactive'}
  data-disabled={disabled ? '' : undefined}
  disabled={disabled}
  tabindex={isSelected ? 0 : -1}
  onclick={handleClick}
  onfocus={handleFocus}
  onkeydown={handleKeyDown}
  class={className}
  {...rest}
>
  {@render children?.()}
</button>
