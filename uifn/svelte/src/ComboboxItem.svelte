<script lang="ts">
  import { onMount } from 'svelte';
  import { setContext } from 'svelte';
  import { getRequiredContext } from './internal/context';

  interface ComboboxContext {
    value: string;
    highlightedItem: string | null;
    filteredItems: string[];
    registerItem: (item: { value: string; label?: string; disabled?: boolean }) => void;
    unregisterItem: (value: string) => void;
    registerItemElement: (value: string, element: HTMLElement) => void;
    unregisterItemElement: (value: string) => void;
    getItemId: (value: string) => string | undefined;
    setValue: (value: string) => void;
    setHighlightedItem: (value: string | null) => void;
  }

  interface Props {
    value: string;
    disabled?: boolean;
    children?: import('svelte').Snippet;
    [key: string]: any;
  }

  let { value, disabled = false, children, ...rest }: Props = $props();
  const getValue = () => value;
  const ctx = getRequiredContext<ComboboxContext>(
    'combobox',
    'ComboboxItem',
    'Combobox components must be used within a Combobox'
  );
  let el: HTMLDivElement;

  let isSelected = $derived(ctx.value === getValue());
  let isHighlighted = $derived(ctx.highlightedItem === getValue());
  let isVisible = $derived(ctx.filteredItems.includes(getValue()));

  onMount(() => {
    ctx.registerItem({
      value: getValue(),
      label: el?.textContent?.trim() || getValue(),
      disabled
    });
    return () => {
      ctx.unregisterItemElement(getValue());
    };
  });

  $effect(() => {
    if (el) {
      ctx.registerItemElement(getValue(), el);
    }
  });

  function handleClick(e: MouseEvent) {
    if (disabled) return;
    if (rest.onclick) rest.onclick(e);
    if (!e.defaultPrevented) {
      ctx.setValue(getValue());
    }
  }

  setContext('combobox-item', {
      get isSelected() { return isSelected; }
  });
</script>

{#if isVisible}
  <div
    bind:this={el}
    role="option"
    id={ctx.getItemId(getValue())}
    aria-selected={isSelected}
    aria-disabled={disabled}
    data-state={isSelected ? 'checked' : 'unchecked'}
    data-highlighted={isHighlighted ? '' : undefined}
    data-disabled={disabled ? '' : undefined}
    style:cursor={disabled ? 'not-allowed' : 'pointer'}
    style:padding="5px 10px"
    {...rest}
    onclick={handleClick}
    onmouseenter={() => ctx.setHighlightedItem(getValue())}
  >
    {@render children?.()}
  </div>
{/if}
