<script lang="ts">
  import { getRequiredContext } from './internal/context';

  interface ContextMenuContext {
    setOpen: (value: boolean) => void;
  }

  interface Props {
    disabled?: boolean;
    onSelect?: (e: Event) => void;
    onClick?: (e: MouseEvent) => void;
    children?: import('svelte').Snippet;
    class?: string;
  }

  let { disabled = false, onSelect, onClick, children, class: className, ...rest }: Props = $props();
  const context = getRequiredContext<ContextMenuContext>(
    'context-menu',
    'ContextMenuItem',
    'ContextMenuItem must be used within a ContextMenu'
  );

  function handleSelect(e: Event) {
    if (disabled) return;
    onSelect?.(e);
    if (!e.defaultPrevented) {
      context.setOpen(false);
    }
  }

  function handleClick(e: MouseEvent) {
    if (disabled) return;
    handleSelect(e);
    onClick?.(e);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (disabled) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleSelect(e);
    }
  }
</script>

<div
  role="menuitem"
  aria-disabled={disabled}
  tabindex={disabled ? -1 : 0}
  data-disabled={disabled ? '' : undefined}
  onclick={handleClick}
  onkeydown={handleKeyDown}
  class={className}
  style="padding: 5px 10px; cursor: {disabled ? 'not-allowed' : 'pointer'}; opacity: {disabled ? 0.5 : 1}; outline: none;"
  {...rest}
>
  {@render children?.()}
</div>
