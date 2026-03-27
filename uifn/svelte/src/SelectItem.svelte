<script lang="ts">
  import { onMount } from 'svelte';
  import { setContext } from 'svelte';
  import { getRequiredContext } from './internal/context';

  interface SelectContext {
    value: string;
    highlightedItem: string | null;
    registerOption: (option: { value: string; label?: string; disabled?: boolean }) => void;
    unregisterOption: (value: string) => void;
    registerOptionElement: (value: string, element: HTMLElement) => void;
    unregisterOptionElement: (value: string) => void;
    getOptionId: (value: string) => string | undefined;
    setValue: (value: string) => void;
  }

  interface Props {
    value: string;
    disabled?: boolean;
    children?: import('svelte').Snippet;
    [key: string]: any;
  }

  let { value, disabled = false, children, ...rest }: Props = $props();
  const getValue = () => value;
  const ctx = getRequiredContext<SelectContext>(
    'select',
    'SelectItem',
    'Select components must be used within a Select'
  );
  let el: HTMLDivElement;

  let isSelected = $derived(ctx.value === getValue());
  let isHighlighted = $derived(ctx.highlightedItem === getValue());

  onMount(() => {
    ctx.registerOption({
      value: getValue(),
      label: el?.textContent?.trim() || getValue(),
      disabled
    });
    return () => {
      ctx.unregisterOptionElement(getValue());
    };
  });

  $effect(() => {
    if (el) {
      ctx.registerOptionElement(getValue(), el);
    }
  });

  function handleClick(e: MouseEvent) {
    if (disabled) return;
    if (rest.onclick) rest.onclick(e);
    if (!e.defaultPrevented) {
      ctx.setValue(getValue());
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
      if (disabled) return;
      if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          ctx.setValue(getValue());
      }
  }

  setContext('select-item', {
      get isSelected() { return isSelected; }
  });
</script>

<div
  bind:this={el}
  role="option"
  id={ctx.getOptionId(getValue())}
  aria-selected={isSelected}
  aria-disabled={disabled}
  data-value={getValue()}
  data-highlighted={isHighlighted ? '' : undefined}
  data-state={isSelected ? 'checked' : 'unchecked'}
  data-disabled={disabled ? '' : undefined}
  tabindex={disabled ? -1 : isHighlighted ? 0 : -1}
  style:cursor={disabled ? 'not-allowed' : 'pointer'}
  style:padding="5px 10px"
  style:outline="none"
  {...rest}
  onclick={handleClick}
  onkeydown={handleKeyDown}
>
  {@render children?.()}
</div>
